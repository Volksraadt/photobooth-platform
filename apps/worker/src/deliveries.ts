import {
  claimNextDelivery,
  deliveryAad,
  failDelivery,
  getBoothInfo,
  getSession,
  markDeliverySent,
  MAX_DELIVERY_ATTEMPTS,
  type DeliveryRow,
} from '@pb/db';
import { MessagingError } from '@pb/messaging';
import type { WorkerDeps } from './types';

/** 30 s, 1 min, 2 min, 4 min: a booth link is worth sending only while the buyer still cares. */
export function deliveryBackoffMs(attempt: number): number {
  return 30_000 * 2 ** Math.max(0, attempt - 1);
}

/** The `/s/:code` link a message carries (never a Drive URL). */
export function shortLink(base: string, code: string): string {
  return `${base.replace(/\/$/, '')}/s/${code}`;
}

class Permanent extends Error {}

async function sendOne(deps: WorkerDeps, row: DeliveryRow): Promise<string | null> {
  const { db, secretBox, messaging } = deps;
  if (!messaging) throw new Permanent('Pengiriman hasil belum diaktifkan di platform');
  if (!secretBox) throw new Permanent('Kunci enkripsi server belum diatur');
  const base = deps.shortLinkBase;
  if (!base) throw new Permanent('Alamat tautan (PB_SHORT_LINK_BASE) belum diatur');
  if (!row.recipientEncrypted) throw new Permanent('Penerima sudah dihapus');
  const session = await getSession(db, row.sessionId);
  if (!session) throw new Permanent('Sesi tidak ditemukan');
  const booth = await getBoothInfo(db, session.boothId);
  const to = secretBox.decrypt(row.recipientEncrypted, deliveryAad(row.id));
  const r = await messaging.send({
    channel: row.channel,
    to,
    boothName: booth?.name ?? 'Photobooth',
    link: shortLink(base, session.code),
  });
  return r.providerMessageId;
}

/**
 * Sends every due delivery (F9). Failures the provider may recover from (timeouts, 429, 5xx) are
 * retried with backoff up to {@link MAX_DELIVERY_ATTEMPTS}; the rest fail for good and Studio
 * shows why. Returns how many were handled.
 */
export async function drainDeliveries(deps: WorkerDeps): Promise<number> {
  const now = () => deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  let n = 0;
  for (;;) {
    const row = await claimNextDelivery(deps.db, { now: now() });
    if (!row) return n;
    n++;
    try {
      const id = await sendOne(deps, row);
      await markDeliverySent(deps.db, row.id, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent =
        err instanceof Permanent || (err instanceof MessagingError && err.permanent);
      const retryAt =
        !permanent && row.attempts < MAX_DELIVERY_ATTEMPTS
          ? new Date(now().getTime() + deliveryBackoffMs(row.attempts))
          : null;
      log(
        `[worker] delivery ${row.id} (${row.channel}) failed (attempt ${row.attempts}${retryAt ? '' : ', giving up'}): ${message}`,
      );
      await failDelivery(deps.db, row.id, { message, retryAt });
    }
  }
}
