import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { createSecretBox } from '@pb/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimNextDelivery,
  deliveryAad,
  failDelivery,
  listSessionDeliveries,
  markDeliverySent,
  queueDelivery,
} from './delivery-repo';
import { PaymentRepoError, type DeviceRef } from './payment-repo';
import { createBooth, createOrg } from './repo';
import { deliveries, devices } from './schema';
import { createTestDb, createTestUser, seedPlans } from './testing';
import type { Db } from './types';
import { withUserContext } from './user-context';

let db: Db;
let close: () => Promise<void>;
let owner: string;
let stranger: string;
let device: DeviceRef;
const box = createSecretBox(randomBytes(32));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPlans(db);
  owner = await createTestUser(db, 'owner@delivery.test');
  stranger = await createTestUser(db, 'stranger@delivery.test');
  const orgId = (await withUserContext(db, owner, (tx) => createOrg(tx, { name: 'Org' }))).id;
  const boothId = (
    await withUserContext(db, owner, (tx) => createBooth(tx, { orgId, name: 'B', userId: owner }))
  ).id;
  await withUserContext(db, stranger, (tx) => createOrg(tx, { name: 'Other' }));
  const id = createId();
  await db.insert(devices).values({ id, orgId, boothId, name: 'Laptop', tokenHash: createId() });
  device = { id, orgId, boothId };
}, 60_000);

afterAll(async () => close());

const session = (code: string) => ({ id: createId(), code, startedAt: new Date() });

describe('F9 deliveries', () => {
  it('queues encrypted, idempotent by id, at most 3 per session', async () => {
    const s = session('DLVRYAA2');
    const first = createId();
    const req = (id: string, to = '0812 3456 7890') =>
      queueDelivery(db, device, box, {
        id,
        session: s,
        channel: 'whatsapp',
        to,
        requestedAt: new Date(),
      });
    expect(await req(first)).toEqual({ id: first, created: true });
    expect(await req(first)).toEqual({ id: first, created: false });
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, first));
    expect(row!.recipientHint).toBe('+62812•••890');
    expect(row!.recipientEncrypted).not.toContain('6281234567890');
    expect(box.decrypt(row!.recipientEncrypted, deliveryAad(first))).toBe('6281234567890');

    await req(createId());
    await req(createId());
    await expect(req(createId())).rejects.toMatchObject({ code: 'delivery_limit' });
    await expect(req(createId(), '12')).rejects.toBeInstanceOf(PaymentRepoError);
  });

  it('refuses when the server has no encryption key', async () => {
    await expect(
      queueDelivery(db, device, null, {
        id: createId(),
        session: session('DLVRYBB2'),
        channel: 'email',
        to: 'budi@example.com',
        requestedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'delivery_unavailable' });
  });

  it('worker claims once, retries, then wipes the recipient when final', async () => {
    await db.delete(deliveries);
    const s = session('DLVRYCC2');
    const id = createId();
    await queueDelivery(db, device, box, {
      id,
      session: s,
      channel: 'email',
      to: 'Budi@Example.com',
      requestedAt: new Date(),
    });
    const claimed = await claimNextDelivery(db);
    expect(claimed).toMatchObject({ id, status: 'sending', attempts: 1 });
    expect(await claimNextDelivery(db)).toBeNull();

    await failDelivery(db, id, { message: 'timeout', retryAt: new Date(Date.now() - 1000) });
    const again = await claimNextDelivery(db);
    expect(again).toMatchObject({ id, attempts: 2 });
    expect(box.decrypt(again!.recipientEncrypted, deliveryAad(id))).toBe('budi@example.com');

    await markDeliverySent(db, id, 'msg-1');
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id));
    expect(row).toMatchObject({
      status: 'sent',
      recipientEncrypted: '',
      providerMessageId: 'msg-1',
    });
  });

  it('Studio sees the hint of its own org only', async () => {
    const s = session('DLVRYDD2');
    await queueDelivery(db, device, box, {
      id: createId(),
      session: s,
      channel: 'email',
      to: 'sari@example.com',
      requestedAt: new Date(),
    });
    const mine = await withUserContext(db, owner, (tx) => listSessionDeliveries(tx, s.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ recipientHint: 'sa•••@example.com', status: 'queued' });
    expect(mine[0]).not.toHaveProperty('recipientEncrypted');
    expect(
      await withUserContext(db, stranger, (tx) => listSessionDeliveries(tx, s.id)),
    ).toHaveLength(0);
  });
});
