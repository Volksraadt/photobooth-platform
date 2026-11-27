import { z } from 'zod';
import { IdSchema } from './common';
import { PageTypeSchema } from './page';

/** ISO 8601 with offset (the kiosk writes UTC `…Z`). */
const IsoTime = z.iso.datetime({ offset: true });

/**
 * A buyer's consent / survey answer as it travels kiosk → agent → API → `sessions.responses`
 * (F8). Texts are copies of the design at answer time. Same shape as `FlowResponse` in @pb/flow.
 */
export const SessionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('consent'),
    elementId: IdSchema,
    page: PageTypeSchema,
    label: z.string().max(1000),
    answeredAt: IsoTime,
  }),
  z.object({
    kind: z.literal('survey'),
    elementId: IdSchema,
    page: PageTypeSchema,
    question: z.string().max(500),
    optionIds: z.array(IdSchema).max(12),
    optionLabels: z.array(z.string().max(200)).max(12),
    answeredAt: IsoTime,
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** Bounded list: at most one entry per element of the three pages that may hold them. */
export const SessionResponsesSchema = z.array(SessionResponseSchema).max(100);

/** Most delivery requests accepted per session (all channels): limits abuse of the sender. */
export const MAX_DELIVERIES_PER_SESSION = 3;

/**
 * Normalised WhatsApp number (digits, country code, no `+`), or null when it does not look like
 * one. A leading `0` is Indonesian (`0812…` → `62812…`); `8…` is taken as `62 8…`.
 */
export function normalizeWhatsapp(input: string): string | null {
  let d = input.replace(/[^\d]/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  if (!/^[1-9]\d{9,14}$/.test(d)) return null;
  if (d.startsWith('62') && !/^628\d{8,11}$/.test(d)) return null;
  return d;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Lower-cased e-mail address, or null when it does not look like one. */
export function normalizeEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Recipient as shown in Studio: enough to recognise it, not enough to reuse it. */
export function maskRecipient(channel: 'whatsapp' | 'email', to: string): string {
  if (channel === 'whatsapp') return `+${to.slice(0, 5)}•••${to.slice(-3)}`;
  const [user = '', domain = ''] = to.split('@');
  return `${user.slice(0, 2)}•••@${domain}`;
}

/**
 * A buyer asked for the download link at `to` (F9). Travels kiosk → agent outbox → API, which
 * re-normalises `to` and stores it encrypted; the worker sends the message.
 */
export const DeliveryRequestSchema = z
  .object({
    channel: z.enum(['whatsapp', 'email']),
    to: z.string().min(3).max(254),
    requestedAt: IsoTime,
  })
  .transform((d, ctx) => {
    const to = d.channel === 'whatsapp' ? normalizeWhatsapp(d.to) : normalizeEmail(d.to);
    if (!to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Nomor/e-mail tidak valid' });
      return z.NEVER;
    }
    return { ...d, to };
  });
export type DeliveryRequest = z.output<typeof DeliveryRequestSchema>;
