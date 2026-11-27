import type {
  AgentLink,
  AgentToKiosk,
  CameraPairingPayload,
  KioskToAgent,
  PrinterStatusSummary,
  TabletCameraState,
} from '@pb/capture';
import type { BoothConfig, SessionResponse } from '@pb/schema';

export type AgentConfigState =
  | { status: 'connecting' }
  | { status: 'pairing'; code: string; expiresAt: string }
  | { status: 'waiting' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      version: number;
      source: 'api' | 'cache';
      config: unknown;
      /** assetId → URL served by the agent (or the data: URL). */
      assets: Record<string, string>;
    };

export type AgentStatus = {
  agentId: string;
  version: string;
  paired: boolean;
  config: { status: string; version: number | null };
  online: boolean | null;
  camera: TabletCameraState;
  printer: PrinterStatusSummary;
  outboxPending: number;
  outboxByKind?: Record<string, number>;
  vouchers?: number;
  printedSheets: number;
  settings: { cameraSource: 'webcam' | 'tablet' };
  lanPort: number;
};

export type AgentShot = {
  photoId: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  capturedAt: string | null;
};

export type PrinterInfo = {
  name: string;
  isDefault: boolean;
  status: PrinterStatusSummary['status'];
  message: string | null;
  virtual: boolean;
};

export type PrintJob = {
  id: string;
  session_id: string | null;
  sheets: number;
  printer: string;
  status: 'queued' | 'printing' | 'done' | 'failed';
  error: string | null;
  created_at: string;
};

export type AgentSession = {
  id: string;
  code: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  files: {
    id: string;
    kind: string;
    slotIndex: number | null;
    takeNumber: number | null;
    selected: boolean;
    width: number | null;
    height: number | null;
    source: string | null;
    url: string;
  }[];
};

export type ProcessBody = {
  config: BoothConfig;
  session: {
    id: string;
    code: string;
    startedAt: string;
    frameId: string;
    filterId: string;
    paymentMethod: string | null;
    amount: number;
    extraPrints: number;
    responses: SessionResponse[];
    downloadUrl: string | null;
    shots: { slotIndex: number; photoId: string }[];
  };
  print?: boolean;
};

export type ProcessResponse = {
  sessionId: string;
  compositeUrl: string;
  sheetUrl: string;
  printJob: PrintJob | null;
  printError: string | null;
  timings: { composeMs: number; printMs: number; totalMs: number };
};

export type AgentSessionRef = {
  id: string;
  code: string;
  startedAt: string;
  boothId: string;
  configVersion: number;
};

export type AgentPayment = {
  id: string;
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'failed' | 'paid_late';
  amount: number;
  qrString: string | null;
  expiresAt: string | null;
  paidAt: string | null;
};

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Probes the agent's /health (used to decide between agent mode and the browser-only fallback). */
export async function probeAgent(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as { agent?: string };
    return res.ok && body.agent === 'photobooth-agent';
  } catch {
    return false;
  }
}

/**
 * Kiosk ↔ local agent (F3): HTTP for requests, one WebSocket for pushes (camera state, config
 * version, printer status, processing progress) and WebRTC signaling. Reconnects forever.
 */
export class AgentClient implements AgentLink {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: AgentToKiosk) => void>();
  private readonly openListeners = new Set<(open: boolean) => void>();
  private queue: KioskToAgent[] = [];
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Last message per type, replayed to late subscribers. */
  private last = new Map<AgentToKiosk['type'], AgentToKiosk>();

  constructor(readonly baseUrl: string) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private open() {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const pending = this.queue;
      this.queue = [];
      pending.forEach((m) => ws.send(JSON.stringify(m)));
      this.openListeners.forEach((l) => l(true));
    };
    ws.onmessage = (e) => {
      let msg: AgentToKiosk;
      try {
        msg = JSON.parse(String(e.data)) as AgentToKiosk;
      } catch {
        return;
      }
      if (msg.type !== 'signal' && msg.type !== 'processing') this.last.set(msg.type, msg);
      for (const l of [...this.listeners]) l(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.openListeners.forEach((l) => l(false));
      if (this.stopped) return;
      this.attempt++;
      this.timer = setTimeout(
        () => this.open(),
        Math.min(5000, 250 * 2 ** Math.min(this.attempt, 5)),
      );
    };
  }

  send(msg: KioskToAgent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== 'signal') this.queue.push(msg);
  }

  subscribe(listener: (msg: AgentToKiosk) => void): () => void {
    this.listeners.add(listener);
    for (const m of this.last.values()) listener(m);
    return () => this.listeners.delete(listener);
  }

  onOpenChange(listener: (open: boolean) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { cache: 'no-store', ...init });
    } catch (err) {
      throw new AgentError(0, `Agent lokal tidak dapat dihubungi (${String(err)})`);
    }
    const body = (await res.json().catch(() => null)) as
      (T & { message?: string; error?: string }) | null;
    if (!res.ok) {
      throw new AgentError(
        res.status,
        body?.message ?? body?.error ?? `Agent menolak permintaan (HTTP ${res.status})`,
        body?.error,
      );
    }
    return body as T;
  }

  private json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  status = () => this.request<AgentStatus>('/status');
  configState = () => this.request<AgentConfigState>('/config/state');
  refreshConfig = () => this.json<{ status: string }>('POST', '/config/refresh');
  /** Unpairs this device from its booth (shows a new pairing code). */
  resetDevice = () => this.json<{ status: string }>('POST', '/device/reset');
  settings = () => this.request<{ cameraSource: 'webcam' | 'tablet' }>('/settings');
  setCameraSource = (cameraSource: 'webcam' | 'tablet') =>
    this.json<{ cameraSource: 'webcam' | 'tablet' }>('PUT', '/settings', { cameraSource });

  /** Stores a still captured in the browser (webcam/mock). */
  uploadShot(input: {
    session: {
      id: string;
      code: string;
      boothId: string;
      configVersion: number;
      startedAt: string;
    };
    slotIndex: number;
    takeNumber: number;
    blob: Blob;
    source: 'webcam' | 'mock';
    capturedAt: string;
  }): Promise<AgentShot> {
    const q = new URLSearchParams({
      code: input.session.code,
      boothId: input.session.boothId,
      configVersion: String(input.session.configVersion),
      startedAt: input.session.startedAt,
      slotIndex: String(input.slotIndex),
      takeNumber: String(input.takeNumber),
      source: input.source,
    });
    return this.request<AgentShot>(`/sessions/${encodeURIComponent(input.session.id)}/shots?${q}`, {
      method: 'POST',
      headers: {
        'content-type': input.blob.type || 'image/jpeg',
        'x-pb-captured-at': input.capturedAt,
      },
      body: input.blob,
    });
  }

  process = (body: ProcessBody) => this.json<ProcessResponse>('POST', '/process', body);
  sessions = () => this.request<AgentSession[]>('/sessions?limit=30');
  printers = () =>
    this.request<{
      printers: PrinterInfo[];
      selected: string | null;
      status: PrinterStatusSummary;
      printedSheets: number;
      recentJobs: PrintJob[];
    }>('/printers');
  selectPrinter = (name: string | null) =>
    this.json<{ selected: string | null; status: PrinterStatusSummary }>('PUT', '/printer', {
      name,
    });
  testPrint = (config?: BoothConfig) =>
    this.json<{ job: PrintJob }>('POST', '/print/test', config ? { config } : {});
  camera = () =>
    this.request<{
      state: TabletCameraState;
      pairings: {
        id: string;
        name: string;
        platform: string;
        created_at: string;
        last_seen_at: string | null;
      }[];
      lan: { hosts: string[]; port: number };
    }>('/camera');
  createCameraPairing = () =>
    this.json<{ payload: CameraPairingPayload; qr: string; expiresAt: string }>(
      'POST',
      '/camera/pairing',
    );
  // --- payments (F4) ---

  createPayment = (body: {
    session: AgentSessionRef;
    frameId: string;
    amount: number;
    expirySec: number;
  }) => this.json<AgentPayment>('POST', '/payments', body);
  getPayment = (id: string) =>
    this.request<AgentPayment | { id: string; status: 'unknown' }>(
      `/payments/${encodeURIComponent(id)}`,
    );
  abandonSession = (id: string) =>
    this.json<{ abandoned: boolean }>('POST', `/sessions/${encodeURIComponent(id)}/abandon`, {});
  cancelPayment = (id: string) =>
    this.json<{ status: string }>('POST', `/payments/${encodeURIComponent(id)}/cancel`, {});
  redeemVoucher = (body: { code: string; session: AgentSessionRef; amount: number }) =>
    this.json<{
      result: 'ok' | 'invalid' | 'used' | 'expired' | 'insufficient' | 'needs_online' | 'locked';
      offline: boolean;
    }>('POST', '/vouchers/redeem', body);
  approveCash = (body: { pin: string; session: AgentSessionRef; amount: number }) =>
    this.json<{ id: string; offline: boolean }>('POST', '/cash-approvals', body);
  /** F9: queue "send the link to this WhatsApp/e-mail" (sent by the platform once online). */
  requestDelivery = (body: {
    session: AgentSessionRef;
    channel: 'whatsapp' | 'email';
    to: string;
    requestedAt: string;
  }) => this.json<{ id: string; queued: true }>('POST', '/deliveries', body);
  syncVouchers = () => this.json<{ ok: true }>('POST', '/vouchers/sync', {});
  network = () => this.request<{ online: boolean | null }>('/network');

  forgetCamera = (id: string) =>
    this.json<{ ok: true }>('DELETE', `/camera/pairings/${encodeURIComponent(id)}`);
}
