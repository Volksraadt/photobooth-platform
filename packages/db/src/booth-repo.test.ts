import { sha256Hex } from '@pb/crypto';
import type { BoothConfig } from '@pb/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoothRemovalError } from './booth-repo';
import {
  archiveBooth,
  createBoothFromTemplate,
  deleteUnusedBooth,
  getConfigVersion,
  listConfigVersions,
  listTemplates,
  PlanLimitError,
  publishConfig,
  restoreBooth,
  saveDraft,
} from './booth-repo';
import {
  activeConfigForDevice,
  claimPairingCode,
  createPairingCode,
  PairingError,
  pairingStatus,
  recordHeartbeat,
} from './device-repo';
import { createOrg, getBooth } from './repo';
import { booths, boothDrafts, devices, plans, sessions, subscriptions } from './schema';
import { createTestDb, createTestUser, seedPlans, seedTemplates } from './testing';
import type { Db } from './types';
import { withUserContext } from './user-context';

let db: Db;
let close: () => Promise<void>;
let userId: string;
let orgId: string;
let otherUser: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPlans(db);
  await seedTemplates(db);
  userId = await createTestUser(db, 'owner@f2.test');
  otherUser = await createTestUser(db, 'other@f2.test');
  orgId = (await withUserContext(db, userId, (tx) => createOrg(tx, { name: 'Org F2' }))).id;
  await withUserContext(db, otherUser, (tx) => createOrg(tx, { name: 'Other' }));
}, 60_000);

afterAll(async () => {
  await close();
});

const asOwner = <T>(fn: Parameters<typeof withUserContext<T>>[2]) =>
  withUserContext(db, userId, fn);

describe('templates and booth creation', () => {
  it('lists built-in templates and creates a booth from one', async () => {
    const list = await asOwner((tx) => listTemplates(tx));
    expect(list.map((t) => t.key).sort()).toEqual(['klasik', 'neon', 'terang']);
    const neon = list.find((t) => t.key === 'neon')!;
    const { id } = await asOwner((tx) =>
      createBoothFromTemplate(tx, {
        orgId,
        name: 'Booth Neon',
        timezone: 'Asia/Jakarta',
        userId,
        templateId: neon.id,
      }),
    );
    const row = await asOwner((tx) => getBooth(tx, id));
    const config = row!.draft!.config;
    expect(config.boothId).toBe(id);
    expect(config.output.driveRootFolderName).toBe('Booth Neon');
    const camera = config.pages.capture.elements.find((e) => e.type === 'camera-view')!;
    expect(camera.x).toBe(560);
  });

  it('enforces maxBooths of the plan', async () => {
    const [starter] = await db.select().from(plans).where(eq(plans.code, 'starter'));
    await db
      .update(subscriptions)
      .set({ planId: starter!.id })
      .where(eq(subscriptions.orgId, orgId));
    await expect(
      asOwner((tx) =>
        createBoothFromTemplate(tx, { orgId, name: 'Kedua', timezone: 'Asia/Jakarta', userId }),
      ),
    ).rejects.toBeInstanceOf(PlanLimitError);
    const [pro] = await db.select().from(plans).where(eq(plans.code, 'pro'));
    await db.update(subscriptions).set({ planId: pro!.id }).where(eq(subscriptions.orgId, orgId));
  });
});

describe('draft, publish, versions, rollback', () => {
  let boothId: string;
  let draft: BoothConfig;

  beforeAll(async () => {
    boothId = (
      await asOwner((tx) =>
        createBoothFromTemplate(tx, { orgId, name: 'Booth P', timezone: 'Asia/Jakarta', userId }),
      )
    ).id;
    draft = (await asOwner((tx) => getBooth(tx, boothId)))!.draft!.config;
  });

  it('saves the draft (RLS: other orgs cannot)', async () => {
    const edited = structuredClone(draft);
    edited.pricing.basePrice = 40000;
    await asOwner((tx) => saveDraft(tx, { boothId, config: edited, userId }));
    const [row] = await db.select().from(boothDrafts).where(eq(boothDrafts.boothId, boothId));
    expect(row!.config.pricing.basePrice).toBe(40000);
    await expect(
      withUserContext(db, otherUser, (tx) =>
        saveDraft(tx, { boothId, config: draft, userId: otherUser }),
      ),
    ).rejects.toThrow();
  });

  it('publishes immutable increasing versions and prunes unused assets', async () => {
    const withExtra = structuredClone(draft);
    withExtra.assets.push({
      id: 'unused',
      kind: 'image',
      url: 'x',
      sha256: 'a'.repeat(64),
      bytes: 1,
    });
    const v1 = await asOwner((tx) => publishConfig(tx, { boothId, config: withExtra, userId }));
    const changed = structuredClone(draft);
    changed.pages.cover.background = { kind: 'color', color: '#123456' };
    const v2 = await asOwner((tx) => publishConfig(tx, { boothId, config: changed, userId }));
    expect([v1.version, v2.version]).toEqual([1, 2]);

    const stored = await asOwner((tx) => getConfigVersion(tx, boothId, 1));
    expect(stored!.config.configVersion).toBe(1);
    expect(stored!.config.assets.map((a) => a.id)).not.toContain('unused');

    const versions = await asOwner((tx) => listConfigVersions(tx, boothId));
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]!.activeConfigId).toBe(v2.id);
  });

  it('rollback publishes the old config as a new version', async () => {
    const old = await asOwner((tx) => getConfigVersion(tx, boothId, 1));
    const v3 = await asOwner((tx) =>
      publishConfig(tx, {
        boothId,
        config: old!.config,
        userId,
        action: 'rollback',
        fromVersion: 1,
      }),
    );
    expect(v3.version).toBe(3);
    const active = await asOwner((tx) => getConfigVersion(tx, boothId, 3));
    expect(active!.config.pages.cover.background).toEqual(old!.config.pages.cover.background);
  });

  it('enforces maxFrames at publish', async () => {
    const [starter] = await db.select().from(plans).where(eq(plans.code, 'starter'));
    await db
      .update(subscriptions)
      .set({ planId: starter!.id })
      .where(eq(subscriptions.orgId, orgId));
    const many = structuredClone(draft);
    for (let i = 0; i < 6; i++)
      many.frames.push({ ...structuredClone(draft.frames[0]!), id: `f${i}` });
    await expect(
      asOwner((tx) => publishConfig(tx, { boothId, config: many, userId })),
    ).rejects.toBeInstanceOf(PlanLimitError);
    const [pro] = await db.select().from(plans).where(eq(plans.code, 'pro'));
    await db.update(subscriptions).set({ planId: pro!.id }).where(eq(subscriptions.orgId, orgId));
  });

  it('pairs a device and serves it the active config', async () => {
    const token = 'k'.repeat(48);
    const tokenHash = sha256Hex(token);
    const { code } = await createPairingCode(db, { tokenHash, fingerprint: 'laptop-1' });
    expect(code).toMatch(/^\d{6}$/);
    expect(await pairingStatus(db, code, tokenHash)).toMatchObject({ status: 'pending' });
    expect(await pairingStatus(db, code, sha256Hex('other'))).toEqual({ status: 'unknown' });

    await expect(
      claimPairingCode(db, { code: '000000', boothId, orgId, name: 'X', userId }),
    ).rejects.toBeInstanceOf(PairingError);
    const { deviceId } = await claimPairingCode(db, {
      code,
      boothId,
      orgId,
      name: 'Laptop',
      userId,
    });
    expect(await pairingStatus(db, code, tokenHash)).toEqual({ status: 'claimed', boothId });
    // A code is single-use.
    await expect(
      claimPairingCode(db, { code, boothId, orgId, name: 'Again', userId }),
    ).rejects.toBeInstanceOf(PairingError);

    const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device!.tokenHash).toBe(tokenHash);
    const active = await activeConfigForDevice(db, { orgId, boothId });
    expect(active!.version).toBe(3);
    // Scoped by org: a device of another org never sees this booth.
    expect(await activeConfigForDevice(db, { orgId: 'other-org', boothId })).toBeNull();

    await recordHeartbeat(
      db,
      { id: deviceId, orgId },
      { configVersion: 3, appVersion: 'kiosk-dev' },
    );
    const [after] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(after!.lastConfigVersion).toBe(3);
    expect(after!.lastHeartbeatAt).not.toBeNull();
  });

  it('enforces maxDevicesPerBooth when claiming', async () => {
    const [starter] = await db.select().from(plans).where(eq(plans.code, 'starter'));
    await db
      .update(subscriptions)
      .set({ planId: starter!.id })
      .where(eq(subscriptions.orgId, orgId));
    const { code } = await createPairingCode(db, {
      tokenHash: sha256Hex('t2'.repeat(20)),
      fingerprint: 'laptop-2',
    });
    await expect(
      claimPairingCode(db, { code, boothId, orgId, name: 'Dua', userId }),
    ).rejects.toBeInstanceOf(PlanLimitError);
    const [pro] = await db.select().from(plans).where(eq(plans.code, 'pro'));
    await db.update(subscriptions).set({ planId: pro!.id }).where(eq(subscriptions.orgId, orgId));
  });
});

describe('archive, restore, delete', () => {
  it('archive frees a plan slot and revokes devices; delete only without sessions', async () => {
    const owner = await createTestUser(db, 'owner-archive@f2.test');
    const org = (await withUserContext(db, owner, (tx) => createOrg(tx, { name: 'Org Arsip' }))).id;
    const as = <T>(fn: Parameters<typeof withUserContext<T>>[2]) => withUserContext(db, owner, fn);
    const [starter] = await db.select().from(plans).where(eq(plans.code, 'starter'));
    await db.update(subscriptions).set({ planId: starter!.id }).where(eq(subscriptions.orgId, org));
    const make = (name: string) =>
      as((tx) =>
        createBoothFromTemplate(tx, { orgId: org, name, timezone: 'Asia/Jakarta', userId: owner }),
      );

    const a = (await make('A')).id;
    await expect(make('B')).rejects.toBeInstanceOf(PlanLimitError);
    await db.insert(devices).values({
      orgId: org,
      boothId: a,
      name: 'Laptop A',
      tokenHash: sha256Hex(`archive-${a}`),
    });

    expect(await as((tx) => archiveBooth(tx, { boothId: a, userId: owner }))).toEqual({
      revokedDevices: 1,
    });
    const [dev] = await db.select().from(devices).where(eq(devices.boothId, a));
    expect(dev!.revokedAt).not.toBeNull();
    const b = (await make('B')).id; // archived A no longer counts
    await expect(
      as((tx) => restoreBooth(tx, { boothId: a, userId: owner })),
    ).rejects.toBeInstanceOf(PlanLimitError);

    await as((tx) => deleteUnusedBooth(tx, { boothId: b, userId: owner }));
    expect(await db.select().from(booths).where(eq(booths.id, b))).toHaveLength(0);
    await as((tx) => restoreBooth(tx, { boothId: a, userId: owner }));
    const [restored] = await db.select().from(booths).where(eq(booths.id, a));
    expect(restored!.status).toBe('active');

    await db.insert(sessions).values({
      orgId: org,
      boothId: a,
      code: 'ARSPA234',
      startedAt: new Date(),
      status: 'completed',
    });
    await expect(
      as((tx) => deleteUnusedBooth(tx, { boothId: a, userId: owner })),
    ).rejects.toMatchObject({ code: 'has_sessions' } satisfies Partial<BoothRemovalError>);
  });
});
