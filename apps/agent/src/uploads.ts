import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sha256Hex, type DeviceApi } from './device-api';
import { DeviceApiError, isApiUnreachable } from './device-api';
import type { SessionFiles } from './sessions';
import type { AgentStore, LocalFileRow, LocalSessionRow } from './store';
import type { Telemetry } from './telemetry';

/** 10 s, 20 s, 40 s … capped at 10 min (like the outbox). */
export function uploadBackoffMs(attempts: number): number {
  return Math.min(10 * 60_000, 10_000 * 2 ** Math.max(0, attempts));
}

/** Name inside Drive: originals are `<CODE>-fotoN.<ext>`; the composite keeps the agent's name. */
function driveName(session: LocalSessionRow, f: LocalFileRow): string {
  const base = basename(f.path) || `${f.id}.jpg`;
  if (f.kind !== 'original') return base;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '.jpg';
  return `${session.code}-foto${f.slot_index ?? 1}${ext}`;
}

/**
 * A problem with this session's files on this machine (corrupt file, nothing selected). Retrying
 * later is kept (never delete), but it must not hold up the other sessions (audit R4).
 */
export class LocalUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalUploadError';
  }
}

export type UploadOptions = {
  /** Keep the local copy this many days after a confirmed upload (0 = delete at once). */
  retentionDays: number;
  /** Per-call pause between ticks while there is work. */
  intervalMs: number;
};

type Event = (
  kind: string,
  message: string,
  level?: 'info' | 'warn' | 'error',
  data?: unknown,
) => void;

/**
 * Session files → API → object storage (docs/phases/F5). Per completed session: upload the
 * selected originals and the composite, then `complete` with a manifest (the API creates the
 * processing job). Everything stays on disk until the API has confirmed every file; only then the
 * local copy is deleted (immediately, or after the retention window). Offline or failing sessions
 * are retried with exponential backoff and never lose a file.
 */
export class UploadQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly store: AgentStore,
    private readonly files: SessionFiles,
    private readonly api: DeviceApi,
    private readonly telemetry: Telemetry,
    private readonly options: UploadOptions,
    private readonly event: Event,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start() {
    this.timer = setInterval(() => void this.kick(), this.options.intervalMs);
    this.timer.unref?.();
    void this.kick();
  }

  /** Waits for the pass in progress, so the store can be closed safely afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** Run a pass now (or right after the one in progress). */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.tick();
        } while (this.again && !this.stopped);
      } catch (err) {
        // Never an unhandled rejection: the next pass retries.
        if (!this.stopped)
          this.event('upload_failed', `Antrian unggah error: ${String(err)}`, 'error');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Back online: skip the backoff and try everything now. */
  resetBackoff() {
    this.store.resetUploadBackoff();
    void this.kick();
  }

  private async tick(): Promise<void> {
    if (!this.api.hasToken || this.stopped) return;
    for (const session of this.store.sessionsToUpload(this.now().toISOString())) {
      if (this.stopped) return;
      const keepGoing = await this.uploadSession(session);
      if (!keepGoing) break;
    }
    await this.purge();
  }

  /** Returns false when the network is down (no point trying the next session now). */
  private async uploadSession(session: LocalSessionRow): Promise<boolean> {
    try {
      // The session record (outbox) must reach the API first, or the file endpoints answer 409.
      await this.telemetry.flush();
      const all = this.store.files(session.id);
      const originals = all.filter((f) => f.kind === 'original' && f.selected === 1);
      const composite = all.find((f) => f.kind === 'composite');
      if (originals.length === 0)
        throw new LocalUploadError('Tidak ada foto terpilih untuk diunggah');
      const toUpload: LocalFileRow[] = [...originals, ...(composite ? [composite] : [])];

      for (const f of toUpload) {
        if (f.upload_status === 'uploaded') continue;
        await this.api.uploadSessionFile(session.id, {
          id: f.id,
          kind: f.kind as 'original' | 'composite',
          name: driveName(session, f),
          sha256: f.sha256,
          slotIndex: f.slot_index,
          mimeType: f.mime_type,
          bytes: await this.readVerified(f),
        });
        this.store.setFileUploadStatus([f.id], 'uploaded');
      }

      await this.api.completeSession(session.id, {
        version: 1,
        configVersion: session.config_version,
        frameId: session.frame_id ?? '',
        filterId: session.filter_id ?? '',
        downloadUrl: session.download_url,
        shots: originals.map((f) => ({
          slotIndex: f.slot_index ?? 1,
          takeNumber: f.take_number ?? 1,
          fileId: f.id,
        })),
        files: toUpload.map((f) => ({
          id: f.id,
          kind: f.kind,
          name: driveName(session, f),
          sha256: f.sha256,
          bytes: f.bytes,
          mimeType: f.mime_type,
          slotIndex: f.slot_index,
        })),
      });

      // Confirmed by the API: only now may the local copy go.
      this.store.markSessionUploaded(session.id, this.now().toISOString());
      this.telemetry.report(null);
      this.event('session_uploaded', `Sesi ${session.code} terunggah`, 'info', {
        sessionId: session.id,
      });
      if (this.options.retentionDays <= 0) await this.deleteLocal(session);
      return true;
    } catch (err) {
      return this.onFailure(session, err);
    }
  }

  private async readVerified(f: LocalFileRow): Promise<Buffer> {
    const bytes = await readFile(f.path).catch((err: NodeJS.ErrnoException) => {
      throw new LocalUploadError(`File ${f.id} tidak dapat dibaca (${err.code ?? err.message})`);
    });
    if (sha256Hex(bytes) !== f.sha256)
      throw new LocalUploadError(`File ${f.id} di disk tidak cocok dengan hash (rusak)`);
    return bytes;
  }

  private onFailure(session: LocalSessionRow, err: unknown): boolean {
    if (this.stopped) return false; // shutting down: the store may already be closing
    if (err instanceof DeviceApiError && !isApiUnreachable(err)) {
      this.telemetry.report(err); // an API answer proves the API is reachable
      if (err.status === 401) return false; // revoked: ConfigSync handles re-pairing
      if (err.code === 'session_unknown') {
        // The outbox has not delivered the session record yet: try again shortly, not a failure.
        this.store.markUploadFailed(session.id, err.message, this.at(10_000));
        return true;
      }
      if (err.code === 'missing_files' && err.missing.length) {
        // The server lost or never got some files: upload them again on the next pass.
        this.store.setFileUploadStatus(err.missing, 'pending');
        this.store.markUploadFailed(session.id, err.message, this.at(2_000));
        return true;
      }
    } else if (err instanceof LocalUploadError) {
      // Says nothing about the network: back off this session only and go on with the others.
      const attempts = session.upload_attempts + 1;
      this.store.markUploadFailed(session.id, err.message, this.at(uploadBackoffMs(attempts)));
      this.event(
        'upload_blocked',
        `Sesi ${session.code} tidak bisa diunggah: ${err.message}`,
        'error',
        {
          sessionId: session.id,
          attempts,
        },
      );
      return true;
    } else {
      this.telemetry.report(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = session.upload_attempts + 1;
    this.store.markUploadFailed(session.id, message, this.at(uploadBackoffMs(attempts)));
    this.event('upload_failed', `Unggah sesi ${session.code} gagal: ${message}`, 'warn', {
      sessionId: session.id,
      attempts,
    });
    // Network down (or only a proxy/tunnel answered): the next session would fail the same way.
    return !isApiUnreachable(err);
  }

  private at(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }

  /** Retention window over: delete the local copy of sessions that were confirmed uploaded. */
  private async purge(): Promise<void> {
    const days = this.options.retentionDays;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    for (const s of this.store.sessionsToPurge(days <= 0 ? this.now().toISOString() : cutoff)) {
      await this.deleteLocal(s);
    }
  }

  /** Never called before `markSessionUploaded`. Removes every file of the session from disk. */
  private async deleteLocal(session: LocalSessionRow): Promise<void> {
    const current = this.store.session(session.id);
    if (!current || current.sync_status !== 'uploaded') return;
    const files = this.store.files(session.id);
    for (const f of files) await rm(f.path, { force: true }).catch(() => undefined);
    this.store.setFileUploadStatus(
      files.map((f) => f.id),
      'deleted',
    );
    // sessions/<day>/<CODE>/ holds only this session's files.
    await rm(join(this.files.root, session.started_at.slice(0, 10), session.code), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    this.store.markSessionPurged(session.id);
  }
}
