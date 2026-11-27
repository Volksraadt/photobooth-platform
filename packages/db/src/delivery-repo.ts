import type { SecretBox } from '@pb/crypto';
import {
  maskRecipient,
  MAX_DELIVERIES_PER_SESSION,
  normalizeEmail,
  normalizeWhatsapp,
} from '@pb/schema';
import { asc, eq, sql } from 'drizzle-orm';
import {
  ensureDeviceSession,
  PaymentRepoError,
  type DeviceRef,
  type SessionRef,
} from './payment-repo';
import { deliveries } from './schema';
import type { Db } from './types';

/**
 * F9 "send my link" requests. The API queues them from the agent outbox, the worker sends them
 * with the platform's own WhatsApp/e-mail account. The recipient is personal data: encrypted at
 * rest (aad = delivery id) and wiped once the delivery is final; Studio only sees the hint.
 */

type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryChannelName = DeliveryRow['channel'];

/** After this many tries a delivery is failed for good (the link is still on the Result QR). */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A `sending` row older than this was left by a crashed worker and is taken again. */
export const DELIVERY_STALE_MS = 5 * 60_000;

export const deliveryAad = (id: string) => `delivery:${id}`;

export type QueueDeliveryInput = {
  /** Agent outbox id: a resent batch does not queue twice. */
  id: string;
  session: SessionRef;
  channel: DeliveryChannelName;
  /** As typed on the kiosk; normalised again here. */
  to: string;
  requestedAt: Date;
};

/**
 * Queues one delivery. Permanent problems (bad number, more than
 * {@link MAX_DELIVERIES_PER_SESSION} per session, no encryption key) throw a
 * {@link PaymentRepoError}: the outbox acknowledges them instead of retrying forever.
 */
export async function queueDelivery(
  db: Db,
  device: DeviceRef,
  box: SecretBox | null,
  input: QueueDeliveryInput,
): Promise<{ id: string; created: boolean }> {
  const to = input.channel === 'whatsapp' ? normalizeWhatsapp(input.to) : normalizeEmail(input.to);
  if (!to) throw new PaymentRepoError('invalid_recipient', 'Nomor/e-mail tidak valid');
  if (!box)
    throw new PaymentRepoError(
      'delivery_unavailable',
      'Pengiriman hasil belum aktif di server (SECRET_MASTER_KEY belum diatur)',
    );
  return db.transaction(async (tx) => {
    const session = await ensureDeviceSession(tx, device, input.session);
    const [existing] = await tx
      .select({ id: deliveries.id, sessionId: deliveries.sessionId })
      .from(deliveries)
      .where(eq(deliveries.id, input.id));
    if (existing) {
      if (existing.sessionId !== session.id)
        throw new PaymentRepoError('session_conflict', 'ID kiriman bentrok dengan sesi lain');
      return { id: existing.id, created: false };
    }
    // Serialise requests of one session so the limit holds under concurrent batches.
    await tx.execute(sql`select id from sessions where id = ${session.id} for update`);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(eq(deliveries.sessionId, session.id));
    if ((count?.n ?? 0) >= MAX_DELIVERIES_PER_SESSION)
      throw new PaymentRepoError(
        'delivery_limit',
        `Maksimal ${MAX_DELIVERIES_PER_SESSION} kiriman per sesi`,
      );
    await tx.insert(deliveries).values({
      id: input.id,
      orgId: session.orgId,
      sessionId: session.id,
      channel: input.channel,
      recipientEncrypted: box.encrypt(to, deliveryAad(input.id)),
      recipientHint: maskRecipient(input.channel, to),
      requestedAt: input.requestedAt,
    });
    return { id: input.id, created: true };
  });
}

/**
 * Atomically takes the next due delivery (queued and past its backoff, or `sending` but stale).
 * `FOR UPDATE SKIP LOCKED`: several workers never send the same message.
 */
export async function claimNextDelivery(
  db: Db,
  opts: { now?: Date } = {},
): Promise<DeliveryRow | null> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - DELIVERY_STALE_MS).toISOString();
  const res = await db.execute<{ id: string }>(sql`
    update deliveries set status = 'sending', attempts = attempts + 1, updated_at = ${nowIso}::timestamptz
    where id = (
      select id from deliveries
      where (status = 'queued' and (next_attempt_at is null or next_attempt_at <= ${nowIso}::timestamptz))
         or (status = 'sending' and updated_at < ${staleIso}::timestamptz)
      order by requested_at
      limit 1
      for update skip locked
    )
    returning id`);
  const list = Array.isArray(res) ? res : (res as unknown as { rows: { id: string }[] }).rows;
  const id = list[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  return row ?? null;
}

export async function markDeliverySent(db: DbOrTx, id: string, providerMessageId: string | null) {
  const at = new Date();
  await db
    .update(deliveries)
    .set({
      status: 'sent',
      providerMessageId,
      lastError: null,
      nextAttemptAt: null,
      sentAt: at,
      // Final: the address is no longer needed.
      recipientEncrypted: '',
      updatedAt: at,
    })
    .where(eq(deliveries.id, id));
}

/** `retryAt` = queued again with backoff; null = failed for good (recipient wiped). */
export async function failDelivery(
  db: DbOrTx,
  id: string,
  f: { message: string; retryAt: Date | null },
) {
  await db
    .update(deliveries)
    .set({
      status: f.retryAt ? 'queued' : 'failed',
      lastError: f.message.slice(0, 1000),
      nextAttemptAt: f.retryAt,
      ...(f.retryAt ? {} : { recipientEncrypted: '' }),
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, id));
}

export type SessionDelivery = Pick<
  DeliveryRow,
  | 'id'
  | 'channel'
  | 'recipientHint'
  | 'status'
  | 'attempts'
  | 'lastError'
  | 'requestedAt'
  | 'sentAt'
>;

/** Deliveries of a session for Studio (RLS applies with a user Tx). Never the recipient itself. */
export async function listSessionDeliveries(
  db: DbOrTx,
  sessionId: string,
): Promise<SessionDelivery[]> {
  return db
    .select({
      id: deliveries.id,
      channel: deliveries.channel,
      recipientHint: deliveries.recipientHint,
      status: deliveries.status,
      attempts: deliveries.attempts,
      lastError: deliveries.lastError,
      requestedAt: deliveries.requestedAt,
      sentAt: deliveries.sentAt,
    })
    .from(deliveries)
    .where(eq(deliveries.sessionId, sessionId))
    .orderBy(asc(deliveries.requestedAt));
}
