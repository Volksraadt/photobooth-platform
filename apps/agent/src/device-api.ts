import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

export function newDeviceToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Device token file in the agent data folder, readable by the current OS user only.
 * Only the agent holds it now (F2 kept it in the kiosk's localStorage).
 */
export class TokenFile {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'device-token');
  }
  read(): string | null {
    try {
      const t = readFileSync(this.path, 'utf8').trim();
      return t || null;
    } catch {
      return null;
    }
  }
  write(token: string | null) {
    if (!token) {
      if (existsSync(this.path)) rmSync(this.path);
      return;
    }
    writeFileSync(this.path, token, { mode: 0o600 });
    if (process.platform === 'win32') restrictWindowsAcl(this.path);
    else {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Windows ignores the 0600 mode (audit R7): drop inherited permissions and allow only the
 * current user and SYSTEM, so other accounts on the booth laptop cannot read the device token.
 * Best effort: if icacls fails, the per-user data folder's ACL still applies.
 */
export function restrictWindowsAcl(path: string): boolean {
  try {
    execFileSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`, '*S-1-5-18:F'],
      { stdio: 'ignore', windowsHide: true, timeout: 10_000 },
    );
    return true;
  } catch (err) {
    console.warn('[agent] could not restrict device-token ACL:', (err as Error).message);
    return false;
  }
}

export class DeviceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DeviceApiError';
  }
  /** File ids the API says are not stored (`missing_files`). */
  missing: string[] = [];
  /** 429: seconds until the API accepts the call again. */
  retryAfterSec: number | null = null;
}

/**
 * True when the API itself was not reached: a network failure / timeout, or a gateway error from
 * a proxy or tunnel in front of it (502/503/504, Cloudflare 520–530) that carries no API error
 * code. Our own API answers 5xx with a JSON `error` code (e.g. `provider_error`), which still
 * proves it is reachable.
 */
export function isApiUnreachable(err: unknown): boolean {
  if (!(err instanceof DeviceApiError)) return true;
  if (err.code !== undefined) return false;
  const s = err.status;
  return s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
}

async function apiError(res: Response): Promise<DeviceApiError> {
  const json = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    missing?: string[];
  } | null;
  const err = new DeviceApiError(
    res.status,
    json?.message ?? json?.error ?? `HTTP ${res.status}`,
    json?.error,
  );
  err.missing = json?.missing ?? [];
  return err;
}

/** Plan flags of the org (no money): what this booth may offer. Booths are never switched off. */
export type DeviceEntitlements = {
  planCode: string;
  state: 'trial' | 'active' | 'grace' | 'downgraded';
  watermark: boolean;
  video: boolean;
  liveClip: boolean;
  dslr: boolean;
  maxFrames: number | null;
};

export type HeartbeatBody = {
  configVersion: number | null;
  appVersion: string;
  platform: string;
  cameraStatus: 'ok' | 'error' | 'disconnected' | 'unknown';
  printerStatus: 'ok' | 'warning' | 'error' | 'disconnected' | 'unknown';
  /** Outbox items + sessions still waiting to be uploaded (unsynced data indicator). */
  outboxPending?: number;
  uploadsPending?: number;
};

export type OutboxBatch = {
  events: {
    id: string;
    level: string;
    kind: string;
    message: string | null;
    data: unknown;
    occurredAt: string;
  }[];
  printJobs: {
    id: string;
    sessionId: string | null;
    sessionCode: string | null;
    sheets: number;
    status: string;
    occurredAt: string;
  }[];
  voucherUses?: { id: string; [k: string]: unknown }[];
  cashApprovals?: { id: string; [k: string]: unknown }[];
  sessions?: { id: string; session: Record<string, unknown> }[];
  /** F9: "send my link" requests (the platform sends them; nothing secret on the booth). */
  deliveries?: { id: string; [k: string]: unknown }[];
};

export type SessionRefBody = { id: string; code: string; startedAt: string };

/** What the API sends back about a payment (no provider data, no credentials). */
export type DevicePayment = {
  id: string;
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'failed' | 'paid_late';
  amount: number;
  qrString: string | null;
  expiresAt: string | null;
  paidAt: string | null;
};

export type RemoteVoucher = {
  codeHash: string;
  valueType: 'full' | 'amount';
  value: number;
  expiresAt: string | null;
  usedAt: string | null;
};

export type RedeemResult =
  | { result: 'ok' }
  | { result: 'invalid' | 'expired' | 'insufficient' }
  | { result: 'used'; usedSessionCode: string | null };

export type StreamHandlers = {
  onConfig: () => void;
  onPayment?: (data: { paymentId: string; status: string }) => void;
};

/** Agent ↔ apps/api (`/pair/*`, `/device/*`). Node fetch, token as Bearer. */
export class DeviceApi {
  constructor(
    readonly base: string,
    private token: string | null,
  ) {}

  setToken(token: string | null) {
    this.token = token;
  }

  get hasToken() {
    return !!this.token;
  }

  private request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const signal =
      init.signal ??
      (init.timeoutMs === 0 ? undefined : AbortSignal.timeout(init.timeoutMs ?? 15_000));
    return fetch(`${this.base}${path}`, { ...init, headers, signal });
  }

  async startPairing(tokenHash: string): Promise<{ code: string; expiresAt: string }> {
    const res = await this.request('/pair/start', {
      method: 'POST',
      body: JSON.stringify({ tokenHash, fingerprint: `agent:${hostname()}`.slice(0, 200) }),
    });
    if (!res.ok) throw new DeviceApiError(res.status, 'Gagal meminta kode pairing');
    return (await res.json()) as { code: string; expiresAt: string };
  }

  async pairingStatus(code: string, token: string): Promise<{ status: string; boothId?: string }> {
    const res = await this.request('/pair/status', {
      method: 'POST',
      body: JSON.stringify({ code, token }),
    });
    if (!res.ok) throw new DeviceApiError(res.status, 'Gagal mengecek pairing');
    return (await res.json()) as { status: string; boothId?: string };
  }

  async me(): Promise<{ id: string; name: string; orgId: string; boothId: string | null }> {
    const res = await this.request('/device/me');
    if (res.status === 401) throw new DeviceApiError(401, 'Perangkat tidak dikenal atau dicabut');
    if (!res.ok) throw new DeviceApiError(res.status, 'Gagal memuat info perangkat');
    return (await res.json()) as {
      id: string;
      name: string;
      orgId: string;
      boothId: string | null;
    };
  }

  async config(
    etag: string | null,
  ): Promise<
    | { status: 'ok'; etag: string | null; id: string; version: number; config: unknown }
    | { status: 'none' }
    | { status: 'unchanged' }
  > {
    const res = await this.request('/device/config', {
      headers: etag ? { 'if-none-match': etag } : {},
    });
    if (res.status === 401) throw new DeviceApiError(401, 'Perangkat tidak dikenal atau dicabut');
    if (res.status === 204) return { status: 'none' };
    if (res.status === 304) return { status: 'unchanged' };
    if (!res.ok) throw new DeviceApiError(res.status, `Gagal memuat config (HTTP ${res.status})`);
    const body = (await res.json()) as { id: string; version: number; config: unknown };
    return { status: 'ok', etag: res.headers.get('etag'), ...body };
  }

  private async jsonCall<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const res = await this.request(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    const json = (await res.json().catch(() => null)) as
      (T & { message?: string; error?: string; retryAfterSec?: number }) | null;
    if (!res.ok) {
      const err = new DeviceApiError(
        res.status,
        json?.message ?? json?.error ?? `HTTP ${res.status}`,
        json?.error,
      );
      if (typeof json?.retryAfterSec === 'number') err.retryAfterSec = json.retryAfterSec;
      throw err;
    }
    return json as T;
  }

  createPayment(body: {
    paymentId: string;
    session: SessionRefBody;
    frameId: string;
    configVersion: number;
    amount: number;
    expirySec: number;
  }) {
    return this.jsonCall<DevicePayment>('POST', '/device/payments', body, 20_000);
  }

  getPayment(id: string) {
    return this.jsonCall<DevicePayment>(
      'GET',
      `/device/payments/${encodeURIComponent(id)}`,
      undefined,
      8_000,
    );
  }

  cancelPayment(id: string) {
    return this.jsonCall<DevicePayment>(
      'POST',
      `/device/payments/${encodeURIComponent(id)}/cancel`,
      {},
      10_000,
    );
  }

  /** Hash list for offline redeems; empty unless the owner allows offline vouchers. */
  async vouchers(): Promise<{ offlineAllowed: boolean; vouchers: RemoteVoucher[] }> {
    const r = await this.jsonCall<{ offlineAllowed?: boolean; vouchers: RemoteVoucher[] }>(
      'GET',
      '/device/vouchers',
    );
    return { offlineAllowed: r.offlineAllowed === true, vouchers: r.vouchers };
  }

  redeemVoucher(
    body: {
      codeHash: string;
      session: SessionRefBody;
      amount: number;
      usedAt: string;
      offline: boolean;
    },
    timeoutMs = 4_000,
  ) {
    return this.jsonCall<RedeemResult>('POST', '/device/vouchers/redeem', body, timeoutMs);
  }

  /** One session file to object storage (raw bytes; the API verifies the sha256 header). */
  async uploadSessionFile(
    sessionId: string,
    f: {
      id: string;
      kind: 'original' | 'composite';
      name: string;
      sha256: string;
      slotIndex: number | null;
      mimeType: string;
      bytes: Uint8Array;
    },
  ): Promise<void> {
    const res = await this.request(
      `/device/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(f.id)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': f.mimeType,
          'x-pb-kind': f.kind,
          'x-pb-name': f.name,
          'x-pb-sha256': f.sha256,
          ...(f.slotIndex ? { 'x-pb-slot': String(f.slotIndex) } : {}),
        },
        body: f.bytes,
        timeoutMs: 120_000,
      },
    );
    if (!res.ok) throw await apiError(res);
  }

  /** Tells the API every file is stored; it creates the processing job. */
  async completeSession(sessionId: string, manifest: unknown): Promise<void> {
    const res = await this.request(`/device/sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(manifest),
      timeoutMs: 30_000,
    });
    if (!res.ok) throw await apiError(res);
  }

  /** Returns the plan flags the API sends back (null from an older API). */
  async heartbeat(body: HeartbeatBody): Promise<DeviceEntitlements | null> {
    const res = await this.request('/device/heartbeat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new DeviceApiError(res.status, `Heartbeat ditolak (HTTP ${res.status})`);
    const json = (await res.json().catch(() => null)) as {
      entitlements?: DeviceEntitlements | null;
    } | null;
    return json?.entitlements ?? null;
  }

  /** Delivers outbox items; returns the ids the API stored (idempotent by id). */
  async sendOutbox(batch: OutboxBatch): Promise<string[]> {
    const res = await this.request('/device/events', {
      method: 'POST',
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new DeviceApiError(res.status, `Outbox ditolak (HTTP ${res.status})`);
    const body = (await res.json()) as { accepted: string[] };
    return body.accepted;
  }

  /** Server-sent events: calls `onConfig` on every `config` event. Resolves when the stream ends. */
  async stream(handlers: StreamHandlers | (() => void), signal: AbortSignal): Promise<void> {
    const h: StreamHandlers = typeof handlers === 'function' ? { onConfig: handlers } : handlers;
    const res = await this.request('/device/stream', {
      signal,
      timeoutMs: 0,
      headers: { accept: 'text/event-stream' },
    });
    if (res.status === 401) throw new DeviceApiError(401, 'Perangkat dicabut');
    if (!res.ok || !res.body) throw new DeviceApiError(res.status, 'Stream tidak tersedia');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^event: config$/m.test(block)) h.onConfig();
        else if (/^event: payment$/m.test(block) && h.onPayment) {
          const data = /^data: (.*)$/m.exec(block)?.[1];
          try {
            if (data) h.onPayment(JSON.parse(data) as { paymentId: string; status: string });
          } catch {
            // malformed event: polling covers it
          }
        }
      }
    }
  }
}
