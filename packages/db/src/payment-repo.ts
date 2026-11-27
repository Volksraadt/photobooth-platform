import type { BoothConfig, SessionResponse } from '@pb/schema';
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  auditLogs,
  boothConfigs,
  booths,
  cashApprovals,
  deviceEvents,
  feeSettings,
  paymentCredentials,
  payments,
  sessions,
  vouchers,
} from './schema';
import type { Db } from './types';

/**
 * Payments, vouchers, cash and session sync for apps/api (owner connection, no RLS):
 * every query is scoped to an explicit org (and the device's booth for device calls).
 */

export type DeviceRef = { id: string; orgId: string; boothId: string | null };
export type PaymentRow = typeof payments.$inferSelect;
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export class PaymentRepoError extends Error {
  constructor(
    readonly code:
      | 'no_booth'
      | 'session_conflict'
      | 'already_paid'
      | 'amount_mismatch'
      | 'unknown_config'
      | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentRepoError';
  }
}

/** Seconds after expires_at during which a settlement still counts as on time. */
export const PAYMENT_GRACE_MS = 60_000;

// --- credentials ---------------------------------------------------------------------------

export type CredentialRow = typeof paymentCredentials.$inferSelect;

export async function getActiveCredential(
  db: DbOrTx,
  orgId: string,
  provider = 'midtrans' as const,
) {
  const [row] = await db
    .select()
    .from(paymentCredentials)
    .where(
      and(
        eq(paymentCredentials.orgId, orgId),
        eq(paymentCredentials.provider, provider),
        eq(paymentCredentials.isActive, true),
      ),
    );
  return row ?? null;
}

export async function getCredential(
  db: DbOrTx,
  orgId: string,
  env: 'sandbox' | 'production',
  provider = 'midtrans' as const,
) {
  const [row] = await db
    .select()
    .from(paymentCredentials)
    .where(
      and(
        eq(paymentCredentials.orgId, orgId),
        eq(paymentCredentials.provider, provider),
        eq(paymentCredentials.env, env),
      ),
    );
  return row ?? null;
}

export async function listCredentials(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(paymentCredentials)
    .where(eq(paymentCredentials.orgId, orgId))
    .orderBy(paymentCredentials.env);
}

/** Upserts the credential row for (org, midtrans, env). `encryptedSecret` null = keep the old one. */
export async function saveCredential(
  db: Db,
  input: {
    orgId: string;
    env: 'sandbox' | 'production';
    encryptedSecret: string | null;
    /** For the audit log only (which secrets changed); default: server key = !!encryptedSecret. */
    secretChanges?: { serverKey: boolean; signatureKey: boolean };
    clientKey: string | null;
    merchantId: string | null;
    active: boolean;
    userId: string;
  },
) {
  return db.transaction(async (tx) => {
    const existing = await getCredential(tx, input.orgId, input.env);
    if (!existing && !input.encryptedSecret) {
      throw new PaymentRepoError('not_found', 'Server key wajib diisi untuk kredensial baru.');
    }
    if (input.active) {
      await tx
        .update(paymentCredentials)
        .set({ isActive: false })
        .where(
          and(
            eq(paymentCredentials.orgId, input.orgId),
            eq(paymentCredentials.provider, 'midtrans'),
          ),
        );
    }
    const values = {
      clientKey: input.clientKey,
      merchantId: input.merchantId,
      isActive: input.active || (existing?.isActive ?? false),
      ...(input.encryptedSecret
        ? {
            encryptedSecret: input.encryptedSecret,
            status: 'untested' as const,
            lastTestMessage: null,
          }
        : {}),
    };
    if (existing) {
      await tx.update(paymentCredentials).set(values).where(eq(paymentCredentials.id, existing.id));
    } else {
      await tx.insert(paymentCredentials).values({
        orgId: input.orgId,
        provider: 'midtrans',
        env: input.env,
        encryptedSecret: input.encryptedSecret!,
        ...values,
      });
    }
    // Audit without the secret: only which fields changed.
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      actorId: input.userId,
      action: 'integration.midtrans.save',
      entity: 'payment_credentials',
      entityId: `midtrans:${input.env}`,
      before: existing ? { merchantId: existing.merchantId, isActive: existing.isActive } : null,
      after: {
        merchantId: input.merchantId,
        isActive: values.isActive,
        serverKeyChanged: input.secretChanges?.serverKey ?? !!input.encryptedSecret,
        signatureKeyChanged: input.secretChanges?.signatureKey ?? false,
      },
    });
    return (await getCredential(tx, input.orgId, input.env))!;
  });
}

export async function recordCredentialTest(
  db: Db,
  input: {
    orgId: string;
    env: 'sandbox' | 'production';
    ok: boolean;
    message: string;
    userId: string;
  },
) {
  await db
    .update(paymentCredentials)
    .set({
      status: input.ok ? 'ok' : 'failed',
      lastTestedAt: new Date(),
      lastTestMessage: input.message,
    })
    .where(
      and(
        eq(paymentCredentials.orgId, input.orgId),
        eq(paymentCredentials.provider, 'midtrans'),
        eq(paymentCredentials.env, input.env),
      ),
    );
  await db.insert(auditLogs).values({
    orgId: input.orgId,
    actorId: input.userId,
    action: 'integration.midtrans.test',
    entity: 'payment_credentials',
    entityId: `midtrans:${input.env}`,
    after: { ok: input.ok },
  });
}

// --- sessions --------------------------------------------------------------------------------

export type SessionRef = { id: string; code: string; startedAt: Date };

/**
 * Creates the session row on first contact (payment, voucher, cash or sync) with the id and code
 * the kiosk generated. Rejects a session id/code that belongs to another org or booth.
 */
export async function ensureDeviceSession(
  db: DbOrTx,
  device: DeviceRef,
  ref: SessionRef,
): Promise<typeof sessions.$inferSelect> {
  if (!device.boothId) throw new PaymentRepoError('no_booth', 'Perangkat belum terpasang ke booth');
  await db
    .insert(sessions)
    .values({
      id: ref.id,
      orgId: device.orgId,
      boothId: device.boothId,
      deviceId: device.id,
      code: ref.code,
      startedAt: ref.startedAt,
      status: 'started',
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, ref.id));
  if (
    !row ||
    row.orgId !== device.orgId ||
    row.boothId !== device.boothId ||
    row.code !== ref.code
  ) {
    throw new PaymentRepoError('session_conflict', 'ID atau kode sesi bentrok dengan sesi lain');
  }
  return row;
}

// --- fees ------------------------------------------------------------------------------------

export async function computeFee(
  db: DbOrTx,
  provider: 'midtrans' | 'xendit',
  method: 'qris' | 'voucher' | 'cash' | 'free',
  amount: number,
  at: Date,
): Promise<number> {
  const [fee] = await db
    .select()
    .from(feeSettings)
    .where(
      and(
        eq(feeSettings.provider, provider),
        eq(feeSettings.method, method),
        lte(feeSettings.effectiveFrom, at),
      ),
    )
    .orderBy(desc(feeSettings.effectiveFrom))
    .limit(1);
  if (!fee) return 0;
  return Math.round((amount * Number(fee.percent)) / 100) + fee.fixed;
}

// --- payments --------------------------------------------------------------------------------

/** Price the buyer is charged for `frameId` in the booth's published config `version`. */
export async function priceForConfig(
  db: DbOrTx,
  device: DeviceRef,
  version: number,
  frameId: string,
): Promise<number | null> {
  if (!device.boothId) return null;
  const [row] = await db
    .select({ config: boothConfigs.config })
    .from(boothConfigs)
    .where(
      and(
        eq(boothConfigs.boothId, device.boothId),
        eq(boothConfigs.orgId, device.orgId),
        eq(boothConfigs.version, version),
      ),
    );
  if (!row) return null;
  const config = row.config as BoothConfig;
  const frame = config.frames.find((f) => f.id === frameId && f.enabled);
  if (!frame) return null;
  return frame.price ?? config.pricing.basePrice;
}

export async function getDevicePayment(db: DbOrTx, device: DeviceRef, paymentId: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.orgId, device.orgId)));
  // A device sees only payments of its own booth.
  if (!row) return null;
  const [s] = await db
    .select({ boothId: sessions.boothId })
    .from(sessions)
    .where(eq(sessions.id, row.sessionId));
  return s?.boothId === device.boothId ? row : null;
}

export async function getPaymentByOrder(db: DbOrTx, orgId: string, orderId: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.orgId, orgId)));
  return row ?? null;
}

/**
 * Inserts a pending payment attempt with the kiosk-chosen id. Idempotent: an existing row with
 * the same id (same org) is returned with `created: false`.
 */
export async function insertPendingPayment(
  db: Db,
  device: DeviceRef,
  input: {
    paymentId: string;
    session: SessionRef;
    amount: number;
    env: 'sandbox' | 'production';
    provider: 'midtrans';
    expiresAt: Date;
  },
): Promise<{ payment: PaymentRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(payments).where(eq(payments.id, input.paymentId));
    if (existing) {
      if (existing.orgId !== device.orgId || existing.sessionId !== input.session.id) {
        throw new PaymentRepoError('session_conflict', 'ID pembayaran sudah dipakai');
      }
      return { payment: existing, created: false };
    }
    const session = await ensureDeviceSession(tx, device, input.session);
    // Lock the session: serialises "is it already paid?" against webhooks.
    await tx.execute(sql`select id from sessions where id = ${session.id} for update`);
    const [paid] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.sessionId, session.id), eq(payments.status, 'paid')));
    if (paid || session.paymentMethod !== null) {
      throw new PaymentRepoError('already_paid', 'Sesi ini sudah lunas');
    }
    const [row] = await tx
      .insert(payments)
      .values({
        id: input.paymentId,
        orgId: device.orgId,
        sessionId: session.id,
        provider: input.provider,
        orderId: input.paymentId,
        amount: input.amount,
        status: 'pending',
        env: input.env,
        deviceId: device.id,
        expiresAt: input.expiresAt,
      })
      .returning();
    return { payment: row!, created: true };
  });
}

export async function storeCharge(
  db: Db,
  paymentId: string,
  charge: { qrString: string; expiresAt: Date; providerRef: string | null; raw: unknown },
) {
  await db
    .update(payments)
    .set({
      qrString: charge.qrString,
      expiresAt: charge.expiresAt,
      providerRef: charge.providerRef,
      raw: { charge: charge.raw },
    })
    .where(eq(payments.id, paymentId));
}

export async function markPaymentFailed(db: Db, paymentId: string, message: string) {
  await db
    .update(payments)
    .set({ status: 'failed', raw: { error: message.slice(0, 500) } })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')));
}

export type StatusInput = {
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'failed' | null;
  grossAmount: number | null;
  providerRef: string | null;
  paidAt: Date | null;
  raw: unknown;
  /** webhook | poll | cancel | expiry */
  source: string;
};

/**
 * Applies a verified provider status to a payment. Idempotent and monotonic:
 * - `paid`/`paid_late` are final (a duplicate notification changes nothing);
 * - a settlement for an attempt that is no longer pending, past its expiry (+grace), or whose
 *   session is already paid by another attempt/method becomes `paid_late` (manual refund);
 * - expire/cancel/fail only move a `pending` attempt.
 * The session row is locked first, so concurrent notifications for two attempts cannot both win.
 */
export async function applyPaymentStatus(
  db: Db,
  orgId: string,
  paymentId: string,
  input: StatusInput,
): Promise<{ payment: PaymentRow; changed: boolean }> {
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select({ sessionId: payments.sessionId })
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.orgId, orgId)));
    if (!head) throw new PaymentRepoError('not_found', 'Pembayaran tidak ditemukan');
    await tx.execute(sql`select id from sessions where id = ${head.sessionId} for update`);
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId));
    const payment = p!;
    const now = new Date();
    const checked = { lastCheckedAt: now };

    if (payment.status === 'paid' || payment.status === 'paid_late' || input.status === null) {
      await tx.update(payments).set(checked).where(eq(payments.id, paymentId));
      return { payment, changed: false };
    }

    if (input.status === 'paid') {
      if (input.grossAmount !== null && input.grossAmount !== payment.amount) {
        throw new PaymentRepoError(
          'amount_mismatch',
          `Nominal notifikasi (${input.grossAmount}) berbeda dengan tagihan (${payment.amount})`,
        );
      }
      const [session] = await tx.select().from(sessions).where(eq(sessions.id, payment.sessionId));
      const [otherPaid] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.sessionId, payment.sessionId),
            eq(payments.status, 'paid'),
            ne(payments.id, payment.id),
          ),
        );
      const sessionPaidOtherwise =
        !!otherPaid || (!!session?.paymentMethod && session.paymentMethod !== 'qris');
      const expired =
        payment.expiresAt !== null &&
        now.getTime() > payment.expiresAt.getTime() + PAYMENT_GRACE_MS;
      const late = payment.status !== 'pending' || expired || sessionPaidOtherwise;
      const fee = await computeFee(
        tx,
        payment.provider,
        'qris',
        payment.amount,
        input.paidAt ?? now,
      );
      const [updated] = await tx
        .update(payments)
        .set({
          status: late ? 'paid_late' : 'paid',
          paidAt: input.paidAt ?? now,
          providerRef: input.providerRef ?? payment.providerRef,
          feeAmount: fee,
          raw: mergeRaw(payment.raw, input.source, input.raw),
          ...checked,
        })
        .where(eq(payments.id, paymentId))
        .returning();
      if (!late) {
        await tx
          .update(sessions)
          .set({
            status: session?.status === 'started' ? 'paid' : session!.status,
            paymentMethod: 'qris',
            grossAmount: payment.amount,
            feeAmount: fee,
            netAmount: payment.amount - fee,
          })
          .where(eq(sessions.id, payment.sessionId));
      }
      return { payment: updated!, changed: true };
    }

    if (payment.status === 'pending' && input.status !== 'pending') {
      const [updated] = await tx
        .update(payments)
        .set({
          status: input.status,
          raw: mergeRaw(payment.raw, input.source, input.raw),
          ...checked,
        })
        .where(eq(payments.id, paymentId))
        .returning();
      return { payment: updated!, changed: true };
    }
    await tx.update(payments).set(checked).where(eq(payments.id, paymentId));
    return { payment, changed: false };
  });
}

function mergeRaw(prev: unknown, source: string, raw: unknown) {
  const base = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
  return { ...base, [source]: raw };
}

/** Kiosk left the payment page: pending → canceled (before asking the provider). */
export async function markPaymentCanceled(db: Db, device: DeviceRef, paymentId: string) {
  const p = await getDevicePayment(db, device, paymentId);
  if (!p) return null;
  if (p.status === 'pending') {
    await db
      .update(payments)
      .set({ status: 'canceled' })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')));
  }
  return getDevicePayment(db, device, paymentId);
}

// --- vouchers --------------------------------------------------------------------------------

export type VoucherRedeemResult =
  | { result: 'ok'; voucherId: string; alreadyUsedBySession: boolean }
  | { result: 'invalid' | 'expired' | 'insufficient' }
  | { result: 'used'; usedSessionCode: string | null };

/**
 * Voucher hashes for offline validation on the device. Only when the owner allows offline
 * vouchers for the booth, and only vouchers that can still be redeemed (unused, not expired):
 * 8-digit codes make a copied list guessable, so it is kept as short as possible. Otherwise the
 * list is empty and the device clears what it had.
 */
export async function listBoothVouchersForDevice(
  db: Db,
  device: DeviceRef,
  now: Date = new Date(),
): Promise<{
  offlineAllowed: boolean;
  vouchers: {
    codeHash: string;
    valueType: 'full' | 'amount';
    value: number;
    expiresAt: Date | null;
    usedAt: Date | null;
  }[];
}> {
  if (!device.boothId) return { offlineAllowed: false, vouchers: [] };
  const [booth] = await db
    .select({ voucherOffline: booths.voucherOffline })
    .from(booths)
    .where(and(eq(booths.id, device.boothId), eq(booths.orgId, device.orgId)));
  if (!booth?.voucherOffline) return { offlineAllowed: false, vouchers: [] };
  const rows = await db
    .select({
      codeHash: vouchers.codeHash,
      valueType: vouchers.valueType,
      value: vouchers.value,
      expiresAt: vouchers.expiresAt,
      usedAt: vouchers.usedAt,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.orgId, device.orgId),
        eq(vouchers.boothId, device.boothId),
        isNull(vouchers.usedAt),
        or(isNull(vouchers.expiresAt), gt(vouchers.expiresAt, now)),
      ),
    );
  return { offlineAllowed: true, vouchers: rows };
}

/**
 * Marks a voucher used by a session (online redeem or offline usage sync). Idempotent for the
 * same session. A second session gets `used` and a `voucher_conflict` device event.
 */
export async function redeemVoucher(
  db: Db,
  device: DeviceRef,
  input: {
    codeHash: string;
    session: SessionRef;
    amount: number;
    usedAt: Date;
    offline: boolean;
  },
): Promise<VoucherRedeemResult> {
  if (!device.boothId) throw new PaymentRepoError('no_booth', 'Perangkat belum terpasang');
  const outcome = await db.transaction(async (tx): Promise<VoucherRedeemResult> => {
    const [v] = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.orgId, device.orgId),
          eq(vouchers.boothId, device.boothId!),
          eq(vouchers.codeHash, input.codeHash),
        ),
      )
      .for('update');
    if (!v) return { result: 'invalid' };
    if (v.usedAt) {
      if (v.usedSessionId === input.session.id) {
        return { result: 'ok', voucherId: v.id, alreadyUsedBySession: true };
      }
      const [s] = v.usedSessionId
        ? await tx
            .select({ code: sessions.code })
            .from(sessions)
            .where(eq(sessions.id, v.usedSessionId))
        : [];
      return { result: 'used', usedSessionCode: s?.code ?? null };
    }
    if (v.expiresAt && v.expiresAt.getTime() < input.usedAt.getTime()) return { result: 'expired' };
    if (v.valueType === 'amount' && v.value < input.amount) return { result: 'insufficient' };
    const session = await ensureDeviceSession(tx, device, input.session);
    await tx
      .update(vouchers)
      .set({
        usedAt: input.usedAt,
        usedSessionId: session.id,
        usedDeviceId: device.id,
        usedOffline: input.offline,
      })
      .where(eq(vouchers.id, v.id));
    await tx
      .update(sessions)
      .set({
        status: session.status === 'started' ? 'paid' : session.status,
        paymentMethod: 'voucher',
        grossAmount: input.amount,
        feeAmount: 0,
        netAmount: input.amount,
        offline: session.offline || input.offline,
      })
      .where(eq(sessions.id, session.id));
    return { result: 'ok', voucherId: v.id, alreadyUsedBySession: false };
  });
  if (outcome.result === 'used') {
    await db.insert(deviceEvents).values({
      orgId: device.orgId,
      deviceId: device.id,
      level: 'warn',
      kind: 'voucher_conflict',
      message: `Voucher sudah dipakai sesi ${outcome.usedSessionCode ?? '?'}; ditolak untuk sesi ${input.session.code}`,
      data: {
        sessionCode: input.session.code,
        usedSessionCode: outcome.usedSessionCode,
        offline: input.offline,
      },
      occurredAt: input.usedAt,
    });
  }
  return outcome;
}

// --- cash ------------------------------------------------------------------------------------

/** Operator approved a cash payment with the booth PIN. Idempotent by `id` (agent outbox id). */
export async function recordCashApproval(
  db: Db,
  device: DeviceRef,
  input: { id: string; session: SessionRef; amount: number; approvedAt: Date; offline: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const session = await ensureDeviceSession(tx, device, input.session);
    const inserted = await tx
      .insert(cashApprovals)
      .values({
        id: input.id,
        orgId: device.orgId,
        sessionId: session.id,
        amount: input.amount,
        deviceId: device.id,
        approvedAt: input.approvedAt,
        approvedByPinOf: null,
      })
      .onConflictDoNothing({ target: cashApprovals.id })
      .returning({ id: cashApprovals.id });
    if (!inserted[0]) return;
    await tx
      .update(sessions)
      .set({
        status: session.status === 'started' ? 'paid' : session.status,
        paymentMethod: 'cash',
        grossAmount: input.amount,
        feeAmount: 0,
        netAmount: input.amount,
        offline: session.offline || input.offline,
      })
      .where(eq(sessions.id, session.id));
    await tx.insert(auditLogs).values({
      orgId: device.orgId,
      actorId: null,
      action: 'cash.approve',
      entity: 'session',
      entityId: session.id,
      after: {
        sessionCode: session.code,
        amount: input.amount,
        deviceId: device.id,
        approvedAt: input.approvedAt.toISOString(),
        approvedWith: 'booth_admin_pin',
        offline: input.offline,
      },
    });
  });
}

// --- session sync ----------------------------------------------------------------------------

export type SessionSyncInput = SessionRef & {
  completedAt: Date | null;
  status: 'completed' | 'failed' | 'capturing';
  frameId: string | null;
  filterId: string | null;
  paymentMethod: 'qris' | 'voucher' | 'cash' | 'free' | null;
  amount: number;
  extraPrints: number;
  /** Consent + survey answers (F8). */
  responses?: SessionResponse[];
  offline: boolean;
};

/** Full session record from the agent (after processing). Upsert by the kiosk session id. */
export async function syncDeviceSession(db: Db, device: DeviceRef, input: SessionSyncInput) {
  await db.transaction(async (tx) => {
    const existing = await ensureDeviceSession(tx, device, input);
    // Money fields come from the payment records (qris/voucher/cash); free sessions are 0.
    // A session the server already has as paid keeps its money, whatever the record says
    // (a `free` record never zeroes a QRIS/voucher/cash payment; audit R3).
    const money = existing.paymentMethod
      ? {}
      : input.paymentMethod === 'free'
        ? { paymentMethod: 'free' as const, grossAmount: 0, feeAmount: 0, netAmount: 0 }
        : input.paymentMethod && input.paymentMethod !== 'qris'
          ? {
              paymentMethod: input.paymentMethod,
              grossAmount: input.amount,
              feeAmount: 0,
              netAmount: input.amount,
            }
          : {};
    await tx
      .update(sessions)
      .set({
        frameId: input.frameId,
        filterId: input.filterId,
        status: input.status === 'capturing' ? existing.status : input.status,
        extraPrints: input.extraPrints,
        // A resend without answers (older agent) never wipes answers already stored.
        ...(input.responses?.length ? { responses: input.responses } : {}),
        completedAt: input.completedAt,
        syncedAt: new Date(),
        offline: existing.offline || input.offline,
        ...money,
      })
      .where(eq(sessions.id, existing.id));
  });
}

// --- Studio (read through RLS with a Tx from withUserContext) ---------------------------------

/** A paid session that has not finished this long after payment needs the owner's attention. */
export const STUCK_PAID_SESSION_MS = 30 * 60_000;

/**
 * Payments the owner must follow up on (refund or contact the buyer):
 * - `late`: settled after expiry/cancel or for a session paid another way (`paid_late`);
 * - `incomplete`: paid on time, but the session never completed (e.g. the booth was offline when
 *   the buyer paid and gave up waiting; audit T2). Disappears once the session syncs as completed.
 */
export async function listRefundCandidates(db: DbOrTx, orgId: string, now = new Date()) {
  const stuckBefore = new Date(now.getTime() - STUCK_PAID_SESSION_MS);
  const rows = await db
    .select({
      id: payments.id,
      orderId: payments.orderId,
      amount: payments.amount,
      paidAt: payments.paidAt,
      providerRef: payments.providerRef,
      sessionCode: sessions.code,
      boothId: sessions.boothId,
      status: payments.status,
    })
    .from(payments)
    .innerJoin(sessions, eq(sessions.id, payments.sessionId))
    .where(
      and(
        eq(payments.orgId, orgId),
        or(
          eq(payments.status, 'paid_late'),
          and(
            eq(payments.status, 'paid'),
            lt(payments.paidAt, stuckBefore),
            ne(sessions.status, 'completed'),
          ),
        ),
      ),
    )
    .orderBy(desc(payments.paidAt));
  return rows.map(({ status, ...r }) => ({
    ...r,
    reason: status === 'paid_late' ? ('late' as const) : ('incomplete' as const),
  }));
}

export async function listBoothSessions(db: DbOrTx, boothId: string, limit = 50) {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.boothId, boothId))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}

export async function listBoothVouchers(db: DbOrTx, boothId: string, limit = 500) {
  return db
    .select({
      id: vouchers.id,
      codeLast4: vouchers.codeLast4,
      valueType: vouchers.valueType,
      value: vouchers.value,
      expiresAt: vouchers.expiresAt,
      usedAt: vouchers.usedAt,
      usedOffline: vouchers.usedOffline,
      batchId: vouchers.batchId,
      note: vouchers.note,
      createdAt: vouchers.createdAt,
      usedSessionCode: sessions.code,
      /** The code can be shown again (created since the 8-digit change; stored encrypted). */
      revealable: sql<boolean>`${vouchers.codeEncrypted} is not null`,
    })
    .from(vouchers)
    .leftJoin(sessions, eq(sessions.id, vouchers.usedSessionId))
    .where(eq(vouchers.boothId, boothId))
    .orderBy(desc(vouchers.createdAt))
    .limit(limit);
}

export async function insertVouchers(
  db: DbOrTx,
  input: {
    orgId: string;
    boothId: string;
    batchId: string;
    note: string | null;
    valueType: 'full' | 'amount';
    value: number;
    expiresAt: Date | null;
    /** `codeEncrypted`: SecretBox ciphertext of the code (API only), so it can be shown again. */
    codes: { codeHash: string; last4: string; codeEncrypted?: string | null }[];
    userId: string;
  },
) {
  await db.insert(vouchers).values(
    input.codes.map((c) => ({
      orgId: input.orgId,
      boothId: input.boothId,
      codeHash: c.codeHash,
      codeLast4: c.last4,
      codeEncrypted: c.codeEncrypted ?? null,
      valueType: input.valueType,
      value: input.valueType === 'full' ? 0 : input.value,
      expiresAt: input.expiresAt,
      batchId: input.batchId,
      note: input.note,
    })),
  );
  await db.insert(auditLogs).values({
    orgId: input.orgId,
    actorId: input.userId,
    action: 'voucher.create',
    entity: 'booth',
    entityId: input.boothId,
    after: {
      batchId: input.batchId,
      count: input.codes.length,
      valueType: input.valueType,
      value: input.value,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    },
  });
}

/**
 * Encrypted codes of a booth's vouchers for the owner (the API decrypts them). Runs with the
 * user's RLS context; `voucherIds` limits the result (null = every voucher of the booth).
 */
export async function listEncryptedVoucherCodes(
  db: DbOrTx,
  input: { boothId: string; voucherIds: string[] | null },
) {
  return db
    .select({
      id: vouchers.id,
      orgId: vouchers.orgId,
      boothId: vouchers.boothId,
      codeEncrypted: vouchers.codeEncrypted,
      codeLast4: vouchers.codeLast4,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.boothId, input.boothId),
        input.voucherIds ? inArray(vouchers.id, input.voucherIds) : undefined,
      ),
    );
}

/** Owner switch: may this booth accept vouchers while offline (device keeps the hash list)? */
export async function setBoothVoucherOffline(
  db: DbOrTx,
  input: { boothId: string; enabled: boolean; userId: string },
) {
  const [row] = await db
    .update(booths)
    .set({ voucherOffline: input.enabled, updatedAt: new Date() })
    .where(eq(booths.id, input.boothId))
    .returning({ id: booths.id, orgId: booths.orgId });
  if (!row) throw new PaymentRepoError('not_found', 'Booth tidak ditemukan');
  await db.insert(auditLogs).values({
    orgId: row.orgId,
    actorId: input.userId,
    action: 'booth.voucher_offline',
    entity: 'booth',
    entityId: row.id,
    after: { enabled: input.enabled },
  });
}
