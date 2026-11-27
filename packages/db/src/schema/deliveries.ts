import { index, integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamps, tz } from './_common';
import { orgs } from './orgs';
import { sessions } from './sessions';

export const deliveryChannel = pgEnum('delivery_channel', ['whatsapp', 'email']);
export const deliveryStatus = pgEnum('delivery_status', ['queued', 'sending', 'sent', 'failed']);

/**
 * F9: "send my download link to this WhatsApp number / e-mail", asked on the Result page.
 * Written by the API from the agent outbox (id = outbox id, so resends are idempotent), sent by
 * the worker. The recipient is personal data: stored encrypted (SecretBox, aad = row id) with a
 * masked copy for Studio.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    channel: deliveryChannel('channel').notNull(),
    recipientEncrypted: text('recipient_encrypted').notNull(),
    /** e.g. `+62812•••890`, `bu•••@gmail.com`. */
    recipientHint: text('recipient_hint').notNull(),
    status: deliveryStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: tz('next_attempt_at'),
    providerMessageId: text('provider_message_id'),
    requestedAt: tz('requested_at').notNull(),
    sentAt: tz('sent_at'),
    ...timestamps,
  },
  (t) => [
    index('deliveries_session_idx').on(t.sessionId),
    index('deliveries_status_idx').on(t.status, t.nextAttemptAt),
  ],
);
