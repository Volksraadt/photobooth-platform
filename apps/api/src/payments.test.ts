import {
  createSecretBox,
  devUserTokenVerifier,
  hashVoucherCode,
  randomToken,
  sha256Hex,
  signDevUserToken,
} from '@pb/crypto';
import { createId } from '@paralleldrive/cuid2';
import {
  auditLogs,
  BoothConfigEvents,
  booths,
  cashApprovals,
  createBoothFromTemplate,
  createOrg,
  deliveries,
  deviceEvents,
  devices,
  getBooth,
  insertVouchers,
  payments,
  publishConfig,
  sessions,
  vouchers,
  withUserContext,
  type Db,
} from '@pb/db';
import { createTestDb, createTestUser, seedPlans, seedTemplates } from '@pb/db/testing';
import { generateSessionCode, type BoothConfig } from '@pb/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createPaymentGateway, DeviceSignals, type PaymentGateway } from './app';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const SERVER_KEY = 'SB-Mid-server-SuperSecretKey-9f8e7d';

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let gateway: PaymentGateway;
let signals: DeviceSignals;
let orgId: string;
let boothId: string;
let deviceId: string;
let userToken: string;
let config: BoothConfig;
const deviceToken = randomToken();
/** Every response body a device or Midtrans received in this file. */
const seen: string[] = [];
const logs: string[] = [];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPlans(db);
  await seedTemplates(db);
  const userId = await createTestUser(db, 'owner@pay.test');
  orgId = (await withUserContext(db, userId, (tx) => createOrg(tx, { name: 'Org Pay' }))).id;
  boothId = (
    await withUserContext(db, userId, (tx) =>
      createBoothFromTemplate(tx, { orgId, name: 'Booth Pay', timezone: 'Asia/Jakarta', userId }),
    )
  ).id;
  const draft = (await withUserContext(db, userId, (tx) => getBooth(tx, boothId)))!.draft!.config;
  await withUserContext(db, userId, (tx) => publishConfig(tx, { boothId, config: draft, userId }));
  config = { ...draft, configVersion: 1 };
  deviceId = createId();
  await db
    .insert(devices)
    .values({ id: deviceId, orgId, boothId, name: 'Laptop', tokenHash: sha256Hex(deviceToken) });

  const secretBox = createSecretBox(Buffer.alloc(32, 7));
  gateway = createPaymentGateway({ mode: 'mock', secretBox });
  signals = new DeviceSignals();
  app = createApp({
    db,
    verifyUserToken: devUserTokenVerifier(SECRET),
    configEvents: new BoothConfigEvents(),
    secretBox,
    payments: gateway,
    deviceSignals: signals,
    publicApiUrl: 'https://api.pb.test',
  });
  userToken = await signDevUserToken(SECRET, { userId, email: 'owner@pay.test' });
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(
        args
          .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a)))
          .join(' '),
      );
    });
  }
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

afterEach(() => {
  // The invariant checked after every test: the key never leaves the API.
  for (const text of [...seen, ...logs]) expect(text).not.toContain(SERVER_KEY);
});

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
) {
  const token = init.token === undefined ? deviceToken : init.token;
  const res = await app.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const price = () => config.frames[0]!.price ?? config.pricing.basePrice;
const newSession = () => ({
  id: createId(),
  code: generateSessionCode(),
  startedAt: new Date().toISOString(),
});
const createPayment = (session = newSession(), paymentId = createId()) =>
  call('/device/payments', {
    body: {
      paymentId,
      session,
      frameId: config.frames[0]!.id,
      configVersion: 1,
      amount: price(),
      expirySec: 300,
    },
  });

const mock = () => gateway.mockFor(orgId, 'sandbox')!;
const webhook = (body: unknown) => call(`/webhooks/midtrans/${orgId}`, { body, token: null });

describe('Midtrans credentials (Studio)', () => {
  it('saves the server key encrypted and never returns it', async () => {
    const res = await call(`/studio/orgs/${orgId}/integrations/midtrans`, {
      method: 'PUT',
      token: userToken,
      body: {
        env: 'sandbox',
        serverKey: SERVER_KEY,
        clientKey: 'SB-Mid-client-abc',
        merchantId: 'G123',
        active: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatchObject({
      env: 'sandbox',
      isActive: true,
      hasServerKey: true,
    });
    const [row] = await db.select().from((await import('@pb/db')).paymentCredentials);
    expect(row!.encryptedSecret).not.toContain(SERVER_KEY);
    expect(row!.encryptedSecret.startsWith('v1.')).toBe(true);

    const get = await call(`/studio/orgs/${orgId}/integrations/midtrans`, { token: userToken });
    expect(get.body.webhookUrl).toBe(`https://api.pb.test/webhooks/midtrans/${orgId}`);
    const test = await call(`/studio/orgs/${orgId}/integrations/midtrans/test`, {
      token: userToken,
      body: { env: 'sandbox' },
    });
    expect(test.body.ok).toBe(true);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId));
    expect(JSON.stringify(audits)).not.toContain(SERVER_KEY);
    expect(audits.map((a) => a.action)).toContain('integration.midtrans.save');
  });

  it('rejects other users and device tokens', async () => {
    expect((await call(`/studio/orgs/${orgId}/integrations/midtrans`)).status).toBe(401);
    const stranger = await signDevUserToken(SECRET, {
      userId: await createTestUser(db, 's@pay.test'),
      email: null,
    });
    expect(
      (await call(`/studio/orgs/${orgId}/integrations/midtrans`, { token: stranger })).status,
    ).toBe(404);
  });
});

describe('QRIS payment', () => {
  it('creates a QRIS idempotently by payment id', async () => {
    const session = newSession();
    const paymentId = createId();
    const first = await createPayment(session, paymentId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: paymentId, status: 'pending', amount: price() });
    expect(first.body.qrString).toEqual(expect.stringContaining('MOCKQRIS'));
    expect(Object.keys(first.body).sort()).toEqual([
      'amount',
      'expiresAt',
      'id',
      'paidAt',
      'qrString',
      'status',
    ]);
    const again = await createPayment(session, paymentId);
    expect(again.status).toBe(200);
    expect(again.body.qrString).toBe(first.body.qrString);
    expect(mock().orders.size).toBeGreaterThanOrEqual(1);
    expect(mock().orders.get(paymentId)?.notificationUrl).toBe(
      `https://api.pb.test/webhooks/midtrans/${orgId}`,
    );
  });

  it('rejects a wrong amount and unknown config', async () => {
    const res = await call('/device/payments', {
      body: {
        paymentId: createId(),
        session: newSession(),
        frameId: config.frames[0]!.id,
        configVersion: 1,
        amount: 1,
        expirySec: 300,
      },
    });
    expect(res.status).toBe(422);
    const res2 = await call('/device/payments', {
      body: {
        paymentId: createId(),
        session: newSession(),
        frameId: 'nope',
        configVersion: 1,
        amount: price(),
        expirySec: 300,
      },
    });
    expect(res2.status).toBe(422);
  });

  it('rejects a webhook with a wrong signature', async () => {
    const { body } = await createPayment();
    const n = mock().notification(String(body.id), 'settlement');
    const bad = await webhook({ ...n, signature_key: 'f'.repeat(128) });
    expect(bad.status).toBe(401);
    const forged = await webhook({ ...n, gross_amount: '1.00' }); // signature no longer matches
    expect(forged.status).toBe(401);
    const [p] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, String(body.id)));
    expect(p!.status).toBe('pending');
  });

  it('a correctly signed "settlement" that Midtrans does not confirm changes nothing (audit S1)', async () => {
    const { body } = await createPayment();
    // Signed with the real key, but the order is still pending at the provider (e.g. a replayed
    // notification whose unsigned transaction_status was edited).
    const n = mock().notification(String(body.id), 'settlement');
    const res = await webhook(n);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: true });
    const [p] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, String(body.id)));
    expect(p!.status).toBe('pending');
  });

  it('stores the provider payload without the notification signature', async () => {
    const { body } = await createPayment();
    await webhook(mock().simulatePaid(String(body.id)));
    const [p] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, String(body.id)));
    expect(p!.status).toBe('paid');
    expect(JSON.stringify(p!.raw)).not.toContain('signature_key');
  });

  it('a session already paid makes a new QRIS answer already_paid (audit T2)', async () => {
    const session = newSession();
    const { body } = await createPayment(session);
    await webhook(mock().simulatePaid(String(body.id)));
    const again = await createPayment(session);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'already_paid' });
  });

  it('a duplicate webhook does not create a second paid session; device gets one signal', async () => {
    const session = newSession();
    const { body } = await createPayment(session);
    const got: string[] = [];
    const off = signals.subscribe(deviceId, (s) => got.push(`${s.paymentId}:${s.status}`));
    const n = mock().simulatePaid(String(body.id));
    expect((await webhook(n)).status).toBe(200);
    expect((await webhook(n)).status).toBe(200);
    off();
    expect(got).toEqual([`${body.id}:paid`]);
    const paid = await db
      .select()
      .from(payments)
      .where(and(eq(payments.sessionId, session.id), eq(payments.status, 'paid')));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.feeAmount).toBe(Math.round(price() * 0.007));
    const [s] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(s).toMatchObject({
      status: 'paid',
      paymentMethod: 'qris',
      grossAmount: price(),
      netAmount: price() - paid[0]!.feeAmount!,
    });
    const view = await call(`/device/payments/${body.id}`);
    expect(view.body).toMatchObject({ status: 'paid', qrString: null });
    // A paid session cannot start another QRIS.
    expect((await createPayment(session)).status).toBe(409);
  });

  it('a settlement after cancel, or for a second attempt, is paid_late (refund candidate)', async () => {
    const session = newSession();
    const a = await createPayment(session);
    const cancel = await call(`/device/payments/${a.body.id}/cancel`, { body: {} });
    expect(cancel.body.status).toBe('canceled');
    const b = await createPayment(session);
    await webhook(mock().simulatePaid(String(b.body.id)));
    // The buyer also paid the first (cancelled) QR.
    mock().orders.get(String(a.body.id))!.status = 'pending';
    await webhook(mock().simulatePaid(String(a.body.id)));
    const rows = await db.select().from(payments).where(eq(payments.sessionId, session.id));
    expect(rows.find((r) => r.id === a.body.id)!.status).toBe('paid_late');
    expect(rows.find((r) => r.id === b.body.id)!.status).toBe('paid');
  });

  it('polling asks the provider when the webhook never comes', async () => {
    const { body } = await createPayment();
    mock().orders.get(String(body.id))!.status = 'paid';
    const res = await call(`/device/payments/${body.id}`);
    expect(res.body.status).toBe('paid');
  });

  it('a device of another org cannot see the payment', async () => {
    const { body } = await createPayment();
    const otherUser = await createTestUser(db, 'other@pay.test');
    const otherOrg = (
      await withUserContext(db, otherUser, (tx) => createOrg(tx, { name: 'Other' }))
    ).id;
    const otherToken = randomToken();
    await db.insert(devices).values({
      id: createId(),
      orgId: otherOrg,
      boothId: null,
      name: 'x',
      tokenHash: sha256Hex(otherToken),
    });
    expect((await call(`/device/payments/${body.id}`, { token: otherToken })).status).toBe(404);
    // and the webhook of another org does not touch it
    const n = mock().simulatePaid(String(body.id));
    expect(
      (await call(`/webhooks/midtrans/${otherOrg}`, { body: n, token: null })).status,
    ).not.toBe(200);
  });
});

describe('vouchers + cash + session sync', () => {
  const code = '12345678';
  beforeAll(async () => {
    await insertVouchers(db, {
      orgId,
      boothId,
      batchId: 'b1',
      note: null,
      valueType: 'full',
      value: 0,
      expiresAt: null,
      codes: [{ codeHash: hashVoucherCode(boothId, code), last4: '5678' }],
      userId: (await db.select().from(auditLogs).limit(1))[0]!.actorId!,
    });
  });

  it('sends no hashes unless the owner allows offline vouchers for the booth', async () => {
    const off = await call('/device/vouchers');
    expect(off.body).toEqual({ offlineAllowed: false, vouchers: [] });
    await db.update(booths).set({ voucherOffline: true }).where(eq(booths.id, boothId));
  });

  it('lists hashes for the device booth only', async () => {
    const res = await call('/device/vouchers');
    expect(res.body.offlineAllowed).toBe(true);
    const list = res.body.vouchers as { codeHash: string }[];
    expect(list.map((v) => v.codeHash)).toContain(hashVoucherCode(boothId, code));
    expect(JSON.stringify(res.body)).not.toContain(code);
  });

  it('redeems once; a second session is refused and logged as a conflict', async () => {
    const s1 = newSession();
    const body = (s: ReturnType<typeof newSession>, offline = false) => ({
      codeHash: hashVoucherCode(boothId, code),
      session: s,
      amount: price(),
      usedAt: new Date().toISOString(),
      offline,
    });
    expect((await call('/device/vouchers/redeem', { body: body(s1) })).body.result).toBe('ok');
    expect((await call('/device/vouchers/redeem', { body: body(s1) })).body.result).toBe('ok');
    const s2 = newSession();
    const second = await call('/device/vouchers/redeem', { body: body(s2, true) });
    expect(second.body).toMatchObject({ result: 'used', usedSessionCode: s1.code });
    const conflicts = await db
      .select()
      .from(deviceEvents)
      .where(eq(deviceEvents.kind, 'voucher_conflict'));
    expect(conflicts).toHaveLength(1);
    const [v] = await db.select().from(vouchers).where(eq(vouchers.boothId, boothId));
    expect(v!.usedSessionId).toBe(s1.id);
    const bogus = await call('/device/vouchers/redeem', {
      body: { ...body(newSession()), codeHash: 'a'.repeat(64) },
    });
    expect(bogus.body.result).toBe('invalid');
  });

  it('limits wrong codes per device (8-digit codes must not be guessable online)', async () => {
    const wrong = () =>
      call('/device/vouchers/redeem', {
        body: {
          codeHash: 'b'.repeat(64),
          session: newSession(),
          amount: price(),
          usedAt: new Date().toISOString(),
          offline: false,
        },
      });
    // One miss was counted by the previous test; the limit is 10 per 10 minutes.
    for (let i = 0; i < 9; i++) expect((await wrong()).body.result).toBe('invalid');
    const blocked = await wrong();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'too_many_attempts' });
    expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('applies offline cash approvals and session records from the outbox (idempotent)', async () => {
    const s = newSession();
    const batch = {
      events: [],
      printJobs: [],
      cashApprovals: [
        {
          id: createId(),
          session: s,
          amount: price(),
          approvedAt: new Date().toISOString(),
          offline: true,
        },
      ],
      sessions: [
        {
          id: createId(),
          session: {
            ...s,
            completedAt: new Date().toISOString(),
            status: 'completed',
            frameId: config.frames[0]!.id,
            filterId: config.filters[0]!.id,
            paymentMethod: 'cash',
            amount: price(),
            extraPrints: 0,
            offline: true,
          },
        },
      ],
    };
    const r1 = await call('/device/events', { body: batch });
    expect((r1.body.accepted as string[]).sort()).toEqual(
      [batch.cashApprovals[0]!.id, batch.sessions[0]!.id].sort(),
    );
    await call('/device/events', { body: batch });
    expect(
      await db.select().from(cashApprovals).where(eq(cashApprovals.sessionId, s.id)),
    ).toHaveLength(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'cash.approve'));
    expect(audits).toHaveLength(1);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id));
    expect(row).toMatchObject({
      status: 'completed',
      paymentMethod: 'cash',
      offline: true,
      grossAmount: price(),
    });
    expect(row!.syncedAt).not.toBeNull();
  });

  it('a session record saying "free" never zeroes a session paid by QRIS (audit R3)', async () => {
    const s = newSession();
    const { body } = await createPayment(s);
    await webhook(mock().simulatePaid(String(body.id)));
    await call('/device/events', {
      body: {
        events: [],
        printJobs: [],
        sessions: [
          {
            id: createId(),
            session: {
              ...s,
              completedAt: new Date().toISOString(),
              status: 'completed',
              frameId: config.frames[0]!.id,
              filterId: config.filters[0]!.id,
              paymentMethod: 'free',
              amount: 0,
              extraPrints: 0,
              offline: false,
            },
          },
        ],
      },
    });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id));
    expect(row).toMatchObject({ status: 'completed', paymentMethod: 'qris', grossAmount: price() });
  });
  it('stores consent + survey answers from the session record; a resend without them keeps them (F8)', async () => {
    const s = newSession();
    const record = (responses?: unknown[]) => ({
      events: [],
      printJobs: [],
      sessions: [
        {
          id: createId(),
          session: {
            ...s,
            completedAt: new Date().toISOString(),
            status: 'completed',
            frameId: config.frames[0]!.id,
            filterId: config.filters[0]!.id,
            paymentMethod: 'free',
            amount: 0,
            extraPrints: 0,
            offline: false,
            ...(responses ? { responses } : {}),
          },
        },
      ],
    });
    const answers = [
      {
        kind: 'consent',
        elementId: 'c1',
        page: 'cover',
        label: 'Saya setuju foto disimpan',
        answeredAt: new Date().toISOString(),
      },
      {
        kind: 'survey',
        elementId: 'q1',
        page: 'review',
        question: 'Tahu dari mana?',
        optionIds: ['ig'],
        optionLabels: ['Instagram'],
        answeredAt: new Date().toISOString(),
      },
    ];
    const r1 = await call('/device/events', { body: record(answers) });
    expect(r1.body.accepted).toHaveLength(1);
    await call('/device/events', { body: record() });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id));
    expect(row!.responses).toEqual(answers);

    // A malformed answer is refused by the request schema, not stored.
    const bad = await call('/device/events', {
      body: record([{ kind: 'survey', elementId: 'q1', page: 'payment-x' }]),
    });
    expect(bad.status).toBe(400);
  });
  it('queues a delivery from the outbox; a bad number is acknowledged, not retried (F9)', async () => {
    const s = newSession();
    const good = createId();
    const bad = createId();
    const r = await call('/device/events', {
      body: {
        events: [],
        printJobs: [],
        deliveries: [
          {
            id: good,
            session: s,
            channel: 'whatsapp',
            to: '081234567890',
            requestedAt: new Date().toISOString(),
          },
          {
            id: bad,
            session: s,
            channel: 'whatsapp',
            to: '12',
            requestedAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toEqual(expect.arrayContaining([good, bad]));
    const rows = await db.select().from(deliveries).where(eq(deliveries.sessionId, s.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: good, recipientHint: '+62812•••890', status: 'queued' });
    expect(rows[0]!.recipientEncrypted).not.toContain('62812');
  });
});

describe('vouchers (Studio)', () => {
  it('creates 8-digit codes, stores them hashed + encrypted, and shows them again to the owner', async () => {
    const created = await call(`/studio/orgs/${orgId}/booths/${boothId}/vouchers`, {
      token: userToken,
      body: { count: 2, valueType: 'full', value: 0, expiresAt: null, note: 'uji' },
    });
    expect(created.status).toBe(200);
    const codes = created.body.codes as { code: string; formatted: string }[];
    expect(codes).toHaveLength(2);
    for (const c of codes) {
      expect(c.code).toMatch(/^\d{8}$/);
      expect(c.formatted).toBe(`${c.code.slice(0, 4)}-${c.code.slice(4)}`);
    }
    const rows = await db
      .select()
      .from(vouchers)
      .where(eq(vouchers.batchId, created.body.batchId as string));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(r.codeEncrypted?.startsWith('v1.')).toBe(true);
      for (const c of codes) expect(r.codeEncrypted).not.toContain(c.code);
    }

    const shown = await call(
      `/studio/orgs/${orgId}/booths/${boothId}/vouchers/codes?ids=${rows.map((r) => r.id).join(',')}`,
      { token: userToken },
    );
    expect(shown.status).toBe(200);
    expect((shown.body.codes as { code: string }[]).map((c) => c.code).sort()).toEqual(
      codes.map((c) => c.code).sort(),
    );
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, 'voucher.reveal'));
    expect(audit.length).toBeGreaterThan(0);

    // A device token cannot read codes; Studio routes need a user token.
    expect((await call(`/studio/orgs/${orgId}/booths/${boothId}/vouchers/codes`)).status).toBe(401);
  });

  it('owner switches offline vouchers per booth (audited)', async () => {
    const off = await call(`/studio/orgs/${orgId}/booths/${boothId}/voucher-offline`, {
      method: 'PUT',
      token: userToken,
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect((await call('/device/vouchers')).body).toEqual({ offlineAllowed: false, vouchers: [] });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'booth.voucher_offline'));
    expect(audit.at(-1)?.after).toEqual({ enabled: false });
  });
});
