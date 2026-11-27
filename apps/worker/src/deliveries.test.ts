import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { createSecretBox } from '@pb/crypto';
import {
  createBooth,
  createOrg,
  deliveries,
  devices,
  queueDelivery,
  withUserContext,
  type Db,
  type DeviceRef,
} from '@pb/db';
import { createTestDb, createTestUser, seedPlans } from '@pb/db/testing';
import { MessagingError, type MessageSender, type OutgoingMessage } from '@pb/messaging';
import { MemoryStorage } from '@pb/storage';
import { AccessTokenCache } from '@pb/drive';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainDeliveries } from './deliveries';
import type { WorkerDeps } from './types';

let db: Db;
let close: () => Promise<void>;
let device: DeviceRef;
const box = createSecretBox(randomBytes(32));
let nowMs = Date.parse('2026-11-27T05:00:00Z');

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPlans(db);
  const owner = await createTestUser(db, 'owner@worker-delivery.test');
  const orgId = (await withUserContext(db, owner, (tx) => createOrg(tx, { name: 'Org' }))).id;
  const boothId = (
    await withUserContext(db, owner, (tx) =>
      createBooth(tx, { orgId, name: 'Booth Mall', userId: owner }),
    )
  ).id;
  const id = createId();
  await db.insert(devices).values({ id, orgId, boothId, name: 'Laptop', tokenHash: createId() });
  device = { id, orgId, boothId };
}, 60_000);

afterAll(async () => close());

function deps(messaging: MessageSender | undefined): WorkerDeps {
  return {
    db,
    storage: new MemoryStorage(),
    secretBox: box,
    google: null,
    driveTokens: new AccessTokenCache(),
    ffmpegPath: 'ffmpeg',
    messaging,
    shortLinkBase: 'https://pb.test/',
    now: () => new Date(nowMs),
  };
}

async function queue(code: string, channel: 'whatsapp' | 'email', to: string) {
  const id = createId();
  await queueDelivery(db, device, box, {
    id,
    session: { id: createId(), code, startedAt: new Date(nowMs) },
    channel,
    to,
    requestedAt: new Date(nowMs),
  });
  return id;
}
const row = async (id: string) =>
  (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;

describe('F9 delivery sender', () => {
  it('sends the short link with the booth name, then wipes the recipient', async () => {
    const sent: OutgoingMessage[] = [];
    const id = await queue('WRKDLV22', 'whatsapp', '0812-3456-7890');
    const n = await drainDeliveries(
      deps({
        channels: ['whatsapp', 'email'],
        send: async (m) => {
          sent.push(m);
          return { providerMessageId: 'wamid.9' };
        },
      }),
    );
    expect(n).toBe(1);
    expect(sent).toEqual([
      {
        channel: 'whatsapp',
        to: '6281234567890',
        boothName: 'Booth Mall',
        link: 'https://pb.test/s/WRKDLV22',
      },
    ]);
    expect(await row(id)).toMatchObject({
      status: 'sent',
      providerMessageId: 'wamid.9',
      recipientEncrypted: '',
    });
  });

  it('retries a temporary failure with backoff, gives up on a permanent one', async () => {
    let calls = 0;
    const flaky: MessageSender = {
      channels: ['email'],
      send: async () => {
        calls++;
        throw new MessagingError(calls === 1 ? 'HTTP 503' : 'HTTP 400 alamat ditolak', calls > 1);
      },
    };
    const id = await queue('WRKDLV33', 'email', 'budi@example.com');
    await drainDeliveries(deps(flaky));
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1, lastError: 'HTTP 503' });

    // Not due yet; due after the 30 s backoff.
    expect(await drainDeliveries(deps(flaky))).toBe(0);
    nowMs += 31_000;
    await drainDeliveries(deps(flaky));
    expect(await row(id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      recipientEncrypted: '',
      lastError: 'HTTP 400 alamat ditolak',
    });
  });

  it('without a configured sender the delivery fails for good with a clear message', async () => {
    const id = await queue('WRKDLV44', 'email', 'sari@example.com');
    await drainDeliveries(deps(undefined));
    expect(await row(id)).toMatchObject({
      status: 'failed',
      lastError: 'Pengiriman hasil belum diaktifkan di platform',
    });
  });
});
