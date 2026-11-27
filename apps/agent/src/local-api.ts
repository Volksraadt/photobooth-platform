import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import type { CameraPairingPayload } from '@pb/capture/protocol';
import { CAMERA_PROTOCOL_VERSION } from '@pb/capture/protocol';
import { DeliveryRequestSchema, NEUTRAL_FILTER_PARAMS, type BoothConfig } from '@pb/schema';
import { composeSheet, composeStrip } from '@pb/compositor';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import sharp from 'sharp';
import { z } from 'zod';
import { mimeFromUrl } from './assets';
import type { Agent } from './agent';
import { CaptureFailedError } from './camera-hub';
import { DeviceApiError } from './device-api';
import { MoneyError } from './money';
import { PrintError } from './print/printers';
import { ProcessError, ProcessRequestSchema } from './processing';
import { ImageRejectedError, writeDurable } from './sessions';
import { AGENT_VERSION } from './options';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Every LAN IPv4 of this machine (for the camera pairing QR). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  // Private ranges first (the tablet is on the booth Wi-Fi).
  const score = (ip: string) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(ip) ? 0 : 1);
  return out.sort((a, b) => score(a) - score(b));
}

const SessionRefQuery = z.object({
  code: z.string().regex(/^[A-Z2-9]{8}$/),
  boothId: z.string().min(1).max(64),
  configVersion: z.coerce.number().int().nonnegative(),
  startedAt: z.string().min(10),
  slotIndex: z.coerce.number().int().min(1).max(20),
  takeNumber: z.coerce.number().int().min(1).max(100),
});

const SessionInfoSchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().regex(/^[A-Z2-9]{8}$/),
  startedAt: z.string().min(10),
  boothId: z.string().min(1).max(64),
  configVersion: z.number().int().nonnegative(),
});
const PaymentBody = z.object({
  session: SessionInfoSchema,
  frameId: z.string().min(1).max(64),
  amount: z.number().int().positive(),
  expirySec: z.number().int().min(60).max(3600),
});
const VoucherBody = z.object({
  code: z.string().min(1).max(32),
  session: SessionInfoSchema,
  amount: z.number().int().nonnegative(),
});
const CashBody = z.object({
  pin: z.string().regex(/^\d{4,8}$/),
  session: SessionInfoSchema,
  amount: z.number().int().nonnegative(),
});

const fileUrl = (c: Context, id: string) => `${new URL(c.req.url).origin}/files/${id}`;

function shotResponse(
  c: Context,
  file: {
    id: string;
    width: number | null;
    height: number | null;
    mime_type: string;
    captured_at: string | null;
    source: string | null;
  },
) {
  return {
    photoId: file.id,
    url: fileUrl(c, file.id),
    width: file.width ?? 0,
    height: file.height ?? 0,
    mimeType: file.mime_type,
    capturedAt: file.captured_at,
    source: file.source,
  };
}

/**
 * Kiosk ↔ agent API, bound to 127.0.0.1. Browser callers must come from an allowed origin
 * (Tauri webview or the kiosk dev server); the Host header is checked against DNS rebinding.
 */
export function createLocalApi(agent: Agent) {
  const app = new Hono();
  const allowed = new Set(agent.options.allowedOrigins);

  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin)) return c.json({ error: 'forbidden_origin' }, 403);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, X-Pb-Captured-At');
      c.header('Access-Control-Allow-Private-Network', 'true');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ProcessError)
      return c.json({ error: 'process_failed', message: err.message, issues: err.issues }, 422);
    if (err instanceof ImageRejectedError)
      return c.json({ error: 'bad_image', message: err.message }, 415);
    if (err instanceof CaptureFailedError)
      return c.json({ error: err.code, message: err.message }, 503);
    if (err instanceof PrintError)
      return c.json({ error: 'print_failed', message: err.message }, 502);
    if (err instanceof MoneyError)
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    if (err instanceof DeviceApiError)
      return c.json({ error: err.code ?? 'api_error', message: err.message }, 502);
    console.error('[agent] local api error', err);
    return c.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : String(err) },
      500,
    );
  });

  app.get('/health', (c) =>
    c.json({ ok: true, agent: 'photobooth-agent', version: AGENT_VERSION }),
  );

  app.get('/status', (c) => c.json(agent.status()));

  // --- config (moved from the kiosk in F3) ---

  app.get('/config/state', (c) => {
    const s = agent.config.current;
    if (s.status !== 'ready') return c.json(s);
    const origin = new URL(c.req.url).origin;
    const assets: Record<string, string> = {};
    for (const a of s.config.assets) {
      assets[a.id] = a.url.startsWith('data:')
        ? a.url
        : `${origin}/assets/${a.sha256}?id=${encodeURIComponent(a.id)}`;
    }
    return c.json({
      status: 'ready',
      version: s.version,
      source: s.source,
      config: s.config,
      assets,
    });
  });

  /** Unpairs this device (new pairing code). Sessions on disk are kept. */
  app.post('/device/reset', async (c) => {
    await agent.config.reset();
    return c.json({ status: agent.config.current.status });
  });

  app.post('/config/refresh', async (c) => {
    await agent.config.refresh();
    return c.json({ status: agent.config.current.status });
  });

  app.get('/assets/:sha', async (c) => {
    const sha = c.req.param('sha');
    if (!/^[a-f0-9]{64}$/.test(sha)) return c.json({ error: 'not_found' }, 404);
    const s = agent.config.current;
    const ref = s.status === 'ready' ? s.config.assets.find((a) => a.sha256 === sha) : undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(agent.assets.pathFor(sha));
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': ref ? mimeFromUrl(ref.url) : 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  // --- shots & files ---

  app.post('/sessions/:id/shots', bodyLimit({ maxSize: 60 * 1024 * 1024 }), async (c) => {
    const q = SessionRefQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_query', issues: q.error.issues }, 400);
    const source = c.req.query('source') === 'mock' ? 'mock' : 'webcam';
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const file = await agent.files.saveShot({
      session: { id: c.req.param('id'), ...q.data },
      slotIndex: q.data.slotIndex,
      takeNumber: q.data.takeNumber,
      bytes,
      source,
      capturedAt: c.req.header('x-pb-captured-at') ?? undefined,
    });
    return c.json(shotResponse(c, file), 201);
  });

  app.post('/sessions/:id/capture', async (c) => {
    const q = SessionRefQuery.safeParse(await c.req.json().catch(() => null));
    if (!q.success) return c.json({ error: 'invalid_body', issues: q.error.issues }, 400);
    const file = await agent.camera.capture({
      session: { id: c.req.param('id'), ...q.data },
      slotIndex: q.data.slotIndex,
      takeNumber: q.data.takeNumber,
    });
    return c.json(shotResponse(c, file), 201);
  });

  app.get('/files/:id', async (c) => {
    const file = agent.store.file(c.req.param('id'));
    if (!file) return c.json({ error: 'not_found' }, 404);
    const bytes = await readFile(file.path).catch(() => null);
    if (!bytes) return c.json({ error: 'missing_on_disk' }, 410);
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': file.mime_type,
      'Cache-Control': 'private, max-age=86400, immutable',
    });
  });

  // --- processing & sessions ---

  app.post('/process', async (c) => {
    const body = ProcessRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const result = await agent.processor.process(body.data);
    return c.json({
      sessionId: result.sessionId,
      compositeUrl: fileUrl(c, result.composite.id),
      sheetUrl: fileUrl(c, result.sheet.id),
      printJob: result.printJob,
      printError: result.printError,
      timings: result.timings,
    });
  });

  /**
   * F9: queue "send the download link to this WhatsApp/e-mail". Waits in the outbox while
   * offline; the platform sends it (the booth holds no messaging credentials).
   */
  app.post('/deliveries', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const ref = z.object({ session: SessionInfoSchema }).safeParse(raw);
    const req = DeliveryRequestSchema.safeParse(raw);
    if (!ref.success || !req.success)
      return c.json({ error: 'invalid_body', issues: (ref.error ?? req.error)?.issues }, 400);
    const { session } = ref.data;
    const { channel, to, requestedAt } = req.data;
    agent.store.ensureSession(session);
    const id = agent.store.enqueue('delivery', {
      session: { id: session.id, code: session.code, startedAt: session.startedAt },
      channel,
      to,
      requestedAt,
    });
    void agent.telemetry.flush();
    return c.json({ id, queued: true as const });
  });

  /** The kiosk dropped an unpaid session (see store.abandonSession). */
  app.post('/sessions/:id/abandon', (c) =>
    c.json({ abandoned: agent.store.abandonSession(c.req.param('id')) }),
  );

  app.get('/sessions', (c) => {
    // "camera-test" holds admin test shots, not a buyer session.
    const sessions = agent.store
      .sessions(Number(c.req.query('limit') ?? 50))
      .filter((s) => s.id !== 'camera-test');
    return c.json(
      sessions.map((s) => ({
        ...s,
        data: undefined,
        files: agent.store.files(s.id).map((f) => ({
          id: f.id,
          kind: f.kind,
          slotIndex: f.slot_index,
          takeNumber: f.take_number,
          selected: !!f.selected,
          width: f.width,
          height: f.height,
          source: f.source,
          url: fileUrl(c, f.id),
          uploadStatus: f.upload_status,
        })),
      })),
    );
  });

  // --- printer ---

  app.get('/printers', async (c) =>
    c.json({
      printers: await agent.printer.list(),
      selected: agent.printer.selected(),
      status: agent.printer.status,
      printedSheets: agent.store.printedSheets(),
      recentJobs: agent.store.printJobs(10),
    }),
  );

  app.put('/printer', async (c) => {
    const body = z
      .object({ name: z.string().min(1).max(200).nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    agent.printer.select(body.data.name);
    return c.json({ selected: agent.printer.selected(), status: agent.printer.status });
  });

  app.post('/print/test', async (c) => {
    const s = agent.config.current;
    const posted = (await c.req.json().catch(() => null)) as { config?: unknown } | null;
    const config = (posted?.config ??
      (s.status === 'ready' ? s.config : null)) as BoothConfig | null;
    if (!config) return c.json({ error: 'no_config', message: 'Belum ada config booth.' }, 409);
    const file = await buildTestSheet(agent, config);
    const job = await agent.printer.print({
      file,
      sheets: 1,
      profile: config.printProfile,
      sessionId: null,
      sessionCode: null,
      title: 'tes-cetak',
    });
    return c.json({ job, file });
  });

  // --- tablet camera ---

  app.get('/camera', (c) =>
    c.json({
      state: agent.camera.state(),
      pairings: agent.store.cameraPairings().map(({ token_hash: _t, ...p }) => p),
      lan: {
        hosts: agent.options.advertiseHosts.length ? agent.options.advertiseHosts : lanAddresses(),
        port: agent.lanPort,
      },
    }),
  );

  app.post('/camera/pairing', (c) => {
    const { code, expiresAt } = agent.camera.createPairingCode();
    const payload: CameraPairingPayload = {
      t: 'pb-camera',
      v: CAMERA_PROTOCOL_VERSION,
      hosts: agent.options.advertiseHosts.length ? agent.options.advertiseHosts : lanAddresses(),
      port: agent.lanPort,
      code,
      agentId: agent.id,
    };
    return c.json({ payload, qr: JSON.stringify(payload), expiresAt });
  });

  app.delete('/camera/pairings/:id', (c) => {
    agent.camera.forget(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- payments (F4): QRIS via the API, vouchers + cash work offline ---

  app.post('/payments', async (c) => {
    const body = PaymentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const p = await agent.money.createPayment(body.data);
    return c.json(p, 201);
  });

  app.get('/payments/:id', async (c) => c.json(await agent.money.getPayment(c.req.param('id'))));

  app.post('/payments/:id/cancel', async (c) =>
    c.json(await agent.money.cancelPayment(c.req.param('id'))),
  );

  app.post('/vouchers/redeem', async (c) => {
    const body = VoucherBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    return c.json(await agent.money.redeemVoucher(body.data));
  });

  app.post('/vouchers/sync', async (c) => {
    await agent.money.syncVouchers();
    return c.json({ ok: true });
  });

  app.post('/cash-approvals', async (c) => {
    const body = CashBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    return c.json(await agent.money.approveCash(body.data), 201);
  });

  app.get('/network', (c) => c.json({ online: agent.telemetry.isOnline }));

  // --- settings ---

  app.get('/settings', (c) => c.json(agent.settings()));

  app.put('/settings', async (c) => {
    const body = z
      .object({ cameraSource: z.enum(['webcam', 'tablet']).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    if (body.data.cameraSource) agent.store.setMeta('camera.source', body.data.cameraSource);
    return c.json(agent.settings());
  });

  return app;
}

/** Test sheet: the first enabled frame with generated test-pattern photos. */
async function buildTestSheet(agent: Agent, config: BoothConfig): Promise<string> {
  const frame = config.frames.find((f) => f.enabled) ?? config.frames[0];
  if (!frame) throw new ProcessError('Config tidak punya frame');
  const colors = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const photos: Record<number, Buffer> = {};
  for (const slot of frame.slots) {
    const color = colors[(slot.index - 1) % colors.length]!;
    photos[slot.index] = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${color}"/>` +
          `<g stroke="#fff" stroke-width="6" fill="none"><rect x="20" y="20" width="1160" height="760"/><line x1="0" y1="0" x2="1200" y2="800"/><line x1="1200" y1="0" x2="0" y2="800"/><circle cx="600" cy="400" r="200"/></g>` +
          `<text x="600" y="430" font-family="sans-serif" font-size="120" font-weight="700" text-anchor="middle" fill="#fff">${slot.index}</text></svg>`,
      ),
    )
      .jpeg()
      .toBuffer();
  }
  const strip = await composeStrip({
    config,
    frame,
    photos,
    filter: config.filters.find((f) => f.isDefault)?.params ?? NEUTRAL_FILTER_PARAMS,
    mirror: false,
    downloadUrl: `${agent.options.shortLinkBase}/s/TESTPRNT`,
    now: new Date(),
    loadAsset: (id) => agent.assets.load(config, id),
  });
  const sheet = await composeSheet(strip, config.printProfile, 'jpeg');
  const dir = join(agent.options.dataDir, 'test-prints');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `test-${Date.now()}.jpg`);
  await writeDurable(file, sheet);
  return file;
}
