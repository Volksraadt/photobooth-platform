import type { DeviceApi, HeartbeatBody, OutboxBatch } from './device-api';
import { DeviceApiError, isApiUnreachable } from './device-api';
import type { AgentStore, OutboxRow } from './store';

/**
 * Heartbeat (every 30 s) + outbox delivery. Online/offline is derived from the heartbeat;
 * transitions are recorded as device events. Events and print jobs wait in the SQLite outbox
 * until the API confirms them (idempotent by id), so nothing is lost while offline.
 */
export class Telemetry {
  private online: boolean | null = null;
  private offlineSince: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushing: Promise<void> | null = null;
  private readonly listeners = new Set<(online: boolean) => void>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** While offline, the connection is re-checked this often (F4: QRIS returns quickly). */
  offlineRetryMs = 5_000;

  constructor(
    private readonly store: AgentStore,
    private readonly api: DeviceApi,
    private readonly snapshot: () => HeartbeatBody,
  ) {}

  start(heartbeatMs: number, outboxMs: number) {
    void this.beat();
    this.timers.push(setInterval(() => void this.beat(), heartbeatMs));
    this.timers.push(setInterval(() => void this.flush(), outboxMs));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.retry) clearTimeout(this.retry);
  }

  /**
   * Result of any API call (payments, vouchers): a response = online; a network failure,
   * timeout or proxy/tunnel gateway error = offline. API errors still prove it is reachable.
   */
  report(err: unknown | null) {
    if (err === null || !isApiUnreachable(err)) {
      this.setOnline(true);
    } else {
      this.setOnline(false);
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.beat();
    }, this.offlineRetryMs);
    this.retry.unref?.();
  }

  get isOnline(): boolean | null {
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setOnline(next: boolean) {
    if (this.online === next) return;
    const prev = this.online;
    this.online = next;
    if (!next) {
      this.offlineSince = Date.now();
      if (prev !== null)
        this.store.event({
          level: 'warn',
          kind: 'went_offline',
          message: 'API tidak dapat dihubungi',
        });
    } else if (prev === false && this.offlineSince !== null) {
      // Back online: deliver everything queued while offline now, not after its backoff.
      this.store.resetOutboxBackoff();
      const sec = Math.round((Date.now() - this.offlineSince) / 1000);
      this.store.event({
        level: 'info',
        kind: 'back_online',
        message: `Kembali online setelah ${sec} dtk`,
        data: { offlineSeconds: sec },
      });
      this.offlineSince = null;
    }
    for (const l of [...this.listeners]) l(next);
  }

  async beat(): Promise<void> {
    if (!this.api.hasToken) return;
    try {
      const entitlements = await this.api.heartbeat(this.snapshot());
      // Plan flags for offline starts and the admin screen; never blocks the booth.
      if (entitlements) this.store.setMeta('entitlements', JSON.stringify(entitlements));
      this.setOnline(true);
      void this.flush();
    } catch (err) {
      // 401 = revoked: ConfigSync handles re-pairing; not an "offline" state.
      if (!(err instanceof DeviceApiError && err.status === 401)) {
        const unreachable = isApiUnreachable(err);
        this.setOnline(!unreachable);
        if (unreachable) this.scheduleRetry();
      }
    }
  }

  /** Sends due outbox items in batches of 100. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (!this.api.hasToken) return;
    for (;;) {
      const rows = this.store.dueOutbox(100);
      if (rows.length === 0) return;
      const batch: Required<OutboxBatch> = {
        events: [],
        printJobs: [],
        voucherUses: [],
        cashApprovals: [],
        sessions: [],
        deliveries: [],
      };
      const cancels: string[] = [];
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        switch (row.kind) {
          case 'device_event':
            batch.events.push({
              id: row.id,
              ...(payload as Omit<OutboxBatch['events'][number], 'id'>),
            });
            break;
          case 'print_job':
            batch.printJobs.push({
              id: row.id,
              ...(payload as Omit<OutboxBatch['printJobs'][number], 'id'>),
            });
            break;
          case 'voucher_use':
            batch.voucherUses.push({ id: row.id, ...payload });
            break;
          case 'cash_approval':
            batch.cashApprovals.push({ id: row.id, ...payload });
            break;
          case 'session':
            batch.sessions.push({ id: row.id, session: payload });
            break;
          case 'delivery':
            batch.deliveries.push({ id: row.id, ...payload });
            break;
          case 'payment_cancel':
            cancels.push(row.id);
            break;
        }
      }
      await this.flushCancels(rows.filter((r) => cancels.includes(r.id)));
      if (cancels.length === rows.length) {
        if (rows.length < 100) return;
        continue;
      }
      try {
        const accepted = await this.api.sendOutbox(batch);
        this.store.ackOutbox(accepted);
        this.onDelivered?.(rows.filter((r) => accepted.includes(r.id)));
        const rejected = rows
          .filter((r) => r.kind !== 'payment_cancel')
          .map((r) => r.id)
          .filter((id) => !accepted.includes(id));
        if (rejected.length) this.store.failOutbox(rejected, 'ditolak API');
        this.setOnline(true);
        if (rows.length < 100) return;
      } catch (err) {
        this.store.failOutbox(
          rows.filter((r) => r.kind !== 'payment_cancel').map((r) => r.id),
          err instanceof Error ? err.message : String(err),
        );
        if (isApiUnreachable(err)) {
          this.setOnline(false);
          this.scheduleRetry();
        }
        return;
      }
    }
  }

  /** Called with outbox rows the API confirmed (vouchers → mark synced locally). */
  onDelivered: ((rows: OutboxRow[]) => void) | null = null;

  /** Cancels that could not be sent while offline (payload: { paymentId }). */
  private async flushCancels(rows: OutboxRow[]) {
    for (const row of rows) {
      const { paymentId } = JSON.parse(row.payload) as { paymentId: string };
      try {
        await this.api.cancelPayment(paymentId);
        this.store.ackOutbox([row.id]);
      } catch (err) {
        if (err instanceof DeviceApiError && err.status === 404) this.store.ackOutbox([row.id]);
        else this.store.failOutbox([row.id], err instanceof Error ? err.message : String(err));
      }
    }
  }
}
