import { sha256Hex } from '@pb/crypto';
import { DeliveryChannelSchema, SessionResponsesSchema } from '@pb/schema';
import {
  activeConfigForDevice,
  createPairingCode,
  devices,
  PairingBusyError,
  pairingStatus,
  PaymentRepoError,
  queueDelivery,
  recordCashApproval,
  recordDeviceOutbox,
  recordHeartbeat,
  resolveEntitlements,
  redeemVoucher,
  syncDeviceSession,
  type Db,
  type DeviceRef,
} from '@pb/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { deviceAuth } from '../middleware/device-auth';
import { deviceOutputRoutes } from './output-routes';
import { countVoucherMiss, devicePaymentRoutes, voucherBlockedFor } from './payment-routes';
import type { AppEnv, ResolvedDeps } from '../types';

/**
 * The plan flags a booth device needs (nothing about money): what the Kiosk/agent may offer.
 * Booths are never switched off for billing: after the grace period the flags are Starter's.
 */
function deviceEntitlements(e: Awaited<ReturnType<typeof resolveEntitlements>>) {
  if (!e) return null;
  return {
    planCode: e.planCode,
    state: e.state,
    watermark: !e.features.watermarkRemoval,
    video: e.features.video,
    liveClip: e.features.liveClip,
    dslr: e.features.dslr,
    maxFrames: e.limits.maxFrames,
  };
}

const PairStartBody = z.object({
  /** sha256 hex of the token the kiosk generated (never the token itself). */
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().min(1).max(200),
});

const PairStatusBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  token: z.string().min(32).max(256),
});

const HeartbeatBody = z.object({
  configVersion: z.number().int().nonnegative().nullable().optional(),
  appVersion: z.string().max(100).nullable().optional(),
  platform: z.string().max(100).nullable().optional(),
  cameraStatus: z.enum(['ok', 'error', 'disconnected', 'unknown']).optional(),
  printerStatus: z.enum(['ok', 'warning', 'error', 'disconnected', 'unknown']).optional(),
  outboxPending: z.number().int().min(0).max(1_000_000).optional(),
  uploadsPending: z.number().int().min(0).max(1_000_000).optional(),
});

const OutboxId = z.string().regex(/^[a-z0-9]{8,64}$/);
const IsoTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

const OutboxSession = z.object({
  id: z.string().min(1).max(64),
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
  startedAt: IsoTime,
});

/**
 * Agent outbox batch, idempotent by outbox id. F3: device_events + print_jobs.
 * F4: voucherUses (offline redeems), cashApprovals, sessions (full record after processing).
 */
const OutboxBody = z.object({
  events: z
    .array(
      z.object({
        id: OutboxId,
        level: z.enum(['info', 'warn', 'error']),
        kind: z.string().min(1).max(64),
        message: z.string().max(2000).nullable(),
        data: z.unknown(),
        occurredAt: IsoTime,
      }),
    )
    .max(200),
  printJobs: z
    .array(
      z.object({
        id: OutboxId,
        sessionCode: z.string().max(16).nullable(),
        sheets: z.number().int().min(0).max(1000),
        status: z.enum(['queued', 'printing', 'done', 'failed']),
        occurredAt: IsoTime,
      }),
    )
    .max(200),
  voucherUses: z
    .array(
      z.object({
        id: OutboxId,
        codeHash: z.string().regex(/^[a-f0-9]{64}$/),
        session: OutboxSession,
        amount: z.number().int().nonnegative(),
        usedAt: IsoTime,
        offline: z.boolean(),
      }),
    )
    .max(200)
    .default([]),
  cashApprovals: z
    .array(
      z.object({
        id: OutboxId,
        session: OutboxSession,
        amount: z.number().int().nonnegative(),
        approvedAt: IsoTime,
        offline: z.boolean(),
      }),
    )
    .max(200)
    .default([]),
  sessions: z
    .array(
      z.object({
        id: OutboxId,
        session: OutboxSession.extend({
          completedAt: IsoTime.nullable(),
          status: z.enum(['completed', 'failed', 'capturing']),
          frameId: z.string().max(64).nullable(),
          filterId: z.string().max(64).nullable(),
          paymentMethod: z.enum(['qris', 'voucher', 'cash', 'free']).nullable(),
          amount: z.number().int().nonnegative(),
          extraPrints: z.number().int().min(0).max(100),
          /** F8; agents before F8 send none. */
          responses: SessionResponsesSchema.default([]),
          offline: z.boolean(),
        }),
      }),
    )
    .max(200)
    .default([]),
  /**
   * F9: "send my link to …". `to` is checked by the repo, not here: one bad entry must not get
   * the whole batch rejected (it is acknowledged as a sync_conflict instead).
   */
  deliveries: z
    .array(
      z.object({
        id: OutboxId,
        session: OutboxSession,
        channel: DeliveryChannelSchema,
        to: z.string().max(320),
        requestedAt: IsoTime,
      }),
    )
    .max(200)
    .default([]),
});

type Outbox = z.infer<typeof OutboxBody>;

/**
 * F4 outbox items, applied one by one. A permanent conflict (session id/code owned by another
 * booth, …) is recorded as a `sync_conflict` device event and acknowledged, so it is not retried
 * forever; unexpected errors are not acknowledged (the agent retries with backoff).
 */
async function applyMoneyOutbox(
  deps: ResolvedDeps,
  device: DeviceRef,
  body: Outbox,
): Promise<string[]> {
  const { db } = deps;
  const accepted: string[] = [];
  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      accepted.push(id);
    } catch (err) {
      if (!(err instanceof PaymentRepoError)) {
        console.error(`[api] outbox ${label} ${id} failed`, err);
        return;
      }
      await recordDeviceOutbox(db, device, {
        events: [
          {
            id,
            level: 'error',
            kind: 'sync_conflict',
            message: `${label}: ${err.message}`,
            data: { code: err.code },
            occurredAt: new Date(),
          },
        ],
        printJobs: [],
      });
      accepted.push(id);
    }
  };
  // Money first (it sets the payment method), then the session record.
  for (const v of body.voucherUses)
    await run(v.id, 'voucher', async () => {
      // Same wrong-code limit as online redeems: the outbox must not become a guessing channel.
      // A plain Error is not acknowledged, so real offline usages are retried later, never lost.
      if (voucherBlockedFor(deps, device.id) > 0)
        throw new Error('voucher attempts limited for this device; retry later');
      const r = await redeemVoucher(db, device, v);
      countVoucherMiss(deps, device.id, r.result);
      return r;
    });
  for (const a of body.cashApprovals)
    await run(a.id, 'cash', () => recordCashApproval(db, device, a));
  for (const s of body.sessions)
    await run(s.id, 'session', () => syncDeviceSession(db, device, s.session));
  // After the session record: a delivery can then never be the session's first contact.
  for (const d of body.deliveries)
    await run(d.id, 'delivery', async () => {
      const r = await queueDelivery(db, device, deps.secretBox, d);
      // The worker also polls; the wake only makes the message go out right away.
      if (r.created) void deps.jobs.wake(d.session.id).catch(() => undefined);
    });
  return accepted;
}

async function deviceStillActive(db: Db, deviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
  return !!row;
}

/** Unauthenticated pairing endpoints (a kiosk has no token yet). */
export function pairRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/start', async (c) => {
    const body = PairStartBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    try {
      const { code, expiresAt } = await createPairingCode(c.var.deps.db, body.data);
      return c.json({ code, expiresAt: expiresAt.toISOString() }, 201);
    } catch (err) {
      if (err instanceof PairingBusyError) {
        console.warn('[api] pairing code limit reached');
        c.header('Retry-After', '30');
        return c.json({ error: 'pairing_busy', message: err.message }, 503);
      }
      throw err;
    }
  });

  app.post('/status', async (c) => {
    const body = PairStatusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    const status = await pairingStatus(c.var.deps.db, body.data.code, sha256Hex(body.data.token));
    return c.json(status);
  });

  return app;
}

/** Device-token endpoints. Every query is scoped to c.var.device (its org and booth). */
export function deviceRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', deviceAuth);

  app.get('/me', (c) => {
    const d = c.var.device;
    return c.json({ id: d.id, name: d.name, orgId: d.orgId, boothId: d.boothId });
  });

  /** Active config; ETag = config id so polling is cheap (304). */
  app.get('/config', async (c) => {
    const active = await activeConfigForDevice(c.var.deps.db, c.var.device);
    if (!active) return c.body(null, 204);
    const etag = `"${active.id}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json({
      id: active.id,
      version: active.version,
      config: active.config,
      // Informational copy; the live value rides on every heartbeat response (the ETag stays the
      // config id so a plan change never makes the device reload an unchanged config).
      entitlements: deviceEntitlements(
        await resolveEntitlements(c.var.deps.db, c.var.device.orgId),
      ),
    });
  });

  /** Server-sent events: `config` whenever the booth publishes. Keep-alive every 20 s. */
  app.get('/stream', (c) => {
    const { device, deps } = c.var;
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      let pending = 0;
      const unsubscribe = device.boothId
        ? deps.configEvents.subscribe(device.boothId, () => {
            pending++;
            wake?.();
          })
        : () => {};
      const paymentQueue: { paymentId: string; status: string }[] = [];
      const unsubscribePayments = deps.deviceSignals.subscribe(device.id, (s) => {
        paymentQueue.push(s);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        unsubscribePayments();
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ boothId: device.boothId }) });
      while (!stream.aborted) {
        const signal = paymentQueue.shift();
        if (signal) {
          await stream.writeSSE({ event: 'payment', data: JSON.stringify(signal) });
          continue;
        }
        if (pending > 0) {
          pending = 0;
          await stream.writeSSE({
            event: 'config',
            data: JSON.stringify({ at: new Date().toISOString() }),
          });
          continue;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 20_000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
        if (pending === 0 && paymentQueue.length === 0 && !stream.aborted) {
          // Auth was checked when the stream opened; a device revoked since then is cut off
          // here, at most one keep-alive later (audit R1).
          if (!(await deviceStillActive(deps.db, device.id))) {
            await stream.writeSSE({ event: 'revoked', data: '{}' });
            break;
          }
          await stream.write(': keep-alive\n\n');
        }
      }
      unsubscribe();
      unsubscribePayments();
    });
  });

  app.post('/heartbeat', async (c) => {
    const body = HeartbeatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body' }, 400);
    await recordHeartbeat(c.var.deps.db, c.var.device, body.data);
    return c.json({
      ok: true,
      time: new Date().toISOString(),
      entitlements: deviceEntitlements(
        await resolveEntitlements(c.var.deps.db, c.var.device.orgId),
      ),
    });
  });

  app.post('/events', async (c) => {
    const body = OutboxBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body', issues: body.error.issues }, 400);
    const accepted = await recordDeviceOutbox(c.var.deps.db, c.var.device, body.data);
    accepted.push(...(await applyMoneyOutbox(c.var.deps, c.var.device, body.data)));
    return c.json({ accepted });
  });

  app.route('/', devicePaymentRoutes());
  app.route('/', deviceOutputRoutes());

  return app;
}
