import type { SessionResponse } from '@pb/schema';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { id, timestamps, tz } from './_common';
import { booths, devices } from './booths';
import { orgMembers, orgs } from './orgs';

export const sessionStatus = pgEnum('session_status', [
  'started',
  'paid',
  'capturing',
  'completed',
  'abandoned',
  'failed',
]);
export const paymentMethod = pgEnum('payment_method', ['qris', 'voucher', 'cash', 'free']);
export const outputKind = pgEnum('output_kind', [
  'original',
  'mirrored',
  'filtered',
  'composite',
  'gif',
  'video',
  'clip',
]);
export const outputStatus = pgEnum('output_status', ['pending', 'stored', 'uploaded', 'failed']);
export const paymentProvider = pgEnum('payment_provider', ['midtrans', 'xendit']);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'paid',
  'expired',
  'canceled',
  'failed',
  'paid_late',
]);
export const voucherValueType = pgEnum('voucher_value_type', ['full', 'amount']);
export const providerEnv = pgEnum('provider_env', ['sandbox', 'production']);

const orgId = () =>
  text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    orgId: orgId(),
    boothId: text('booth_id')
      .notNull()
      .references(() => booths.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** 8 chars, alphabet without 0/O/1/I. Used by /s/:code. */
    code: text('code').notNull().unique(),
    frameId: text('frame_id'),
    filterId: text('filter_id'),
    status: sessionStatus('status').notNull().default('started'),
    paymentMethod: paymentMethod('payment_method'),
    grossAmount: integer('gross_amount').notNull().default(0),
    feeAmount: integer('fee_amount').notNull().default(0),
    netAmount: integer('net_amount').notNull().default(0),
    extraPrints: integer('extra_prints').notNull().default(0),
    /** F8: consent + survey answers (`SessionResponse[]` from @pb/schema). */
    responses: jsonb('responses').$type<SessionResponse[]>().notNull().default([]),
    startedAt: tz('started_at').notNull(),
    completedAt: tz('completed_at'),
    syncedAt: tz('synced_at'),
    offline: boolean('offline').notNull().default(false),
    driveFolderUrl: text('drive_folder_url'),
    /** Drive folder id of this session (kept so retries reuse it). */
    driveFolderId: text('drive_folder_id'),
    /**
     * F5: what the agent uploaded + what the worker needs (config version, selected shots,
     * filter/frame). Written by POST /device/sessions/:id/complete.
     */
    manifest: jsonb('manifest'),
    /** All files confirmed in object storage (the agent may now delete its local copy). */
    filesCompleteAt: tz('files_complete_at'),
    ...timestamps,
  },
  (t) => [
    index('sessions_org_idx').on(t.orgId),
    index('sessions_booth_started_idx').on(t.boothId, t.startedAt),
  ],
);

export const sessionShots = pgTable(
  'session_shots',
  {
    id: id(),
    orgId: orgId(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    slotIndex: integer('slot_index').notNull(),
    takeNumber: integer('take_number').notNull(),
    storagePath: text('storage_path'),
    width: integer('width'),
    height: integer('height'),
    selected: boolean('selected').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('session_shots_org_idx').on(t.orgId),
    uniqueIndex('session_shots_take_uq').on(t.sessionId, t.slotIndex, t.takeNumber),
  ],
);

export const sessionOutputs = pgTable(
  'session_outputs',
  {
    id: id(),
    orgId: orgId(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: outputKind('kind').notNull(),
    storagePath: text('storage_path'),
    driveFileId: text('drive_file_id'),
    status: outputStatus('status').notNull().default('pending'),
    /** File name inside the Drive subfolder. */
    name: text('name'),
    mimeType: text('mime_type'),
    bytes: integer('bytes'),
    sha256: text('sha256'),
    slotIndex: integer('slot_index'),
    /** The agent's local_files id (idempotency key of the upload). */
    sourceFileId: text('source_file_id'),
    ...timestamps,
  },
  (t) => [
    index('session_outputs_org_idx').on(t.orgId),
    index('session_outputs_session_idx').on(t.sessionId),
    uniqueIndex('session_outputs_source_uq')
      .on(t.sessionId, t.sourceFileId)
      .where(sql`${t.sourceFileId} is not null`),
    uniqueIndex('session_outputs_name_uq').on(t.sessionId, t.kind, t.name),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orgId: orgId(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    provider: paymentProvider('provider').notNull(),
    /** Internal idempotent id sent to the provider. */
    orderId: text('order_id').notNull().unique(),
    amount: integer('amount').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    qrString: text('qr_string'),
    expiresAt: tz('expires_at'),
    paidAt: tz('paid_at'),
    providerRef: text('provider_ref'),
    feeAmount: integer('fee_amount'),
    raw: jsonb('raw'),
    /** Credential env used for the charge (webhook verification uses the same key). */
    env: providerEnv('env'),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Last provider status query (rate limit for device polling). */
    lastCheckedAt: tz('last_checked_at'),
    ...timestamps,
  },
  (t) => [
    index('payments_org_idx').on(t.orgId),
    index('payments_org_status_idx').on(t.orgId, t.status),
    index('payments_session_idx').on(t.sessionId),
    // A session may have many attempts but only one may be paid.
    uniqueIndex('payments_one_paid_per_session_uq')
      .on(t.sessionId)
      .where(sql`${t.status} = 'paid'`),
  ],
);

export const vouchers = pgTable(
  'vouchers',
  {
    id: id(),
    orgId: orgId(),
    boothId: text('booth_id')
      .notNull()
      .references(() => booths.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    codeLast4: text('code_last4').notNull(),
    /** Full code encrypted by the API (SecretBox, AAD voucher:<boothId>) so the owner can see it again. */
    codeEncrypted: text('code_encrypted'),
    valueType: voucherValueType('value_type').notNull(),
    /** IDR; ignored when valueType = full. */
    value: integer('value').notNull().default(0),
    expiresAt: tz('expires_at'),
    usedAt: tz('used_at'),
    usedSessionId: text('used_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    usedDeviceId: text('used_device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Vouchers created together (Studio batch). */
    batchId: text('batch_id'),
    note: text('note'),
    /** Redeemed while the device was offline (validated locally, reconciled later). */
    usedOffline: boolean('used_offline').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('vouchers_org_idx').on(t.orgId),
    uniqueIndex('vouchers_booth_code_uq').on(t.boothId, t.codeHash),
  ],
);

export const cashApprovals = pgTable(
  'cash_approvals',
  {
    id: id(),
    orgId: orgId(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    approvedByPinOf: text('approved_by_pin_of').references(() => orgMembers.id, {
      onDelete: 'set null',
    }),
    amount: integer('amount').notNull(),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    approvedAt: tz('approved_at'),
    ...timestamps,
  },
  (t) => [index('cash_approvals_org_idx').on(t.orgId)],
);
