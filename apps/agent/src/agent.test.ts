import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp } from '@pb/api';
import type { AgentToCamera, CameraPairResponse } from '@pb/capture/protocol';
import { devUserTokenVerifier, signDevUserToken } from '@pb/crypto';
import {
  BoothConfigEvents,
  createBoothFromTemplate,
  createOrg,
  deviceEvents,
  devices,
  getBooth,
  printJobs,
  publishConfig,
  withUserContext,
  type Db,
} from '@pb/db';
import { createTestDb, createTestUser, seedPlans, seedTemplates } from '@pb/db/testing';
import { generateSessionCode, type BoothConfig } from '@pb/schema';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Agent } from './agent';
import { DEFAULT_ORIGINS, type AgentOptions } from './options';

const SECRET = 'test-secret-'.padEnd(48, 'x');
let db: Db;
let closeDb: () => Promise<void>;
let api: Server;
let apiBase: string;
let userToken: string;
let userId: string;
let boothId: string;
let dataDir: string;
let agent: Agent;
let local: string;
let lan: string;

function agentOptions(patch: Partial<AgentOptions> = {}): AgentOptions {
  return {
    dataDir,
    apiBase,
    shortLinkBase: 'https://pb.test',
    localPort: 0,
    lanPort: 0,
    lanHost: '127.0.0.1',
    advertiseHosts: ['127.0.0.1'],
    allowedOrigins: DEFAULT_ORIGINS,
    printMode: 'virtual',
    telemetry: false,
    configPollMs: 200,
    heartbeatMs: 60_000,
    outboxFlushMs: 60_000,
    ...patch,
  };
}

const json = async <T>(res: Response | Promise<Response>): Promise<T> =>
  (await res).json() as Promise<T>;
const until = async <T>(
  fn: () => T | Promise<T>,
  ok: (v: T) => boolean,
  ms = 10_000,
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end)
      throw new Error(`timeout; last value: ${JSON.stringify(v)?.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

let photo12mp: Buffer;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await seedPlans(db);
  await seedTemplates(db);
  userId = await createTestUser(db, 'owner@agent.test');
  const orgId = (await withUserContext(db, userId, (tx) => createOrg(tx, { name: 'Org Agent' })))
    .id;
  boothId = (
    await withUserContext(db, userId, (tx) =>
      createBoothFromTemplate(tx, { orgId, name: 'Booth Agent', timezone: 'Asia/Jakarta', userId }),
    )
  ).id;
  const app = createApp({
    db,
    verifyUserToken: devUserTokenVerifier(SECRET),
    configEvents: new BoothConfigEvents(),
  });
  userToken = await signDevUserToken(SECRET, { userId, email: 'owner@agent.test' });
  await new Promise<void>((resolve) => {
    api = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve()) as Server;
  });
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'pb-agent-'));
  agent = new Agent(agentOptions());
  await agent.start();
  local = `http://127.0.0.1:${agent.localPort}`;
  lan = `http://127.0.0.1:${agent.lanPort}`;
  photo12mp = await sharp({
    create: { width: 4032, height: 3024, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}, 120_000);

afterAll(async () => {
  await agent?.stop().catch(() => undefined);
  api?.close();
  await closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('local API hardening', () => {
  it('rejects foreign origins and rebinding hosts', async () => {
    expect(
      (await fetch(`${local}/status`, { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
    // fetch() cannot spoof Host; use a raw request (DNS rebinding sends the attacker's host name).
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${local}/status`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const ok = await fetch(`${local}/status`, { headers: { origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});

describe('config sync (moved from the kiosk)', () => {
  it('pairs through the API, then downloads and activates the published config', async () => {
    const pairing = await until(
      () => json<{ status: string; code?: string }>(fetch(`${local}/config/state`)),
      (s) => s.status === 'pairing',
    );
    const claim = await fetch(`${apiBase}/studio/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ code: pairing.code, boothId, name: 'Laptop agent' }),
    });
    expect(claim.status).toBe(201);
    await until(
      () => json<{ status: string }>(fetch(`${local}/config/state`)),
      (s) => s.status === 'waiting',
    );

    const draft = (await withUserContext(db, userId, (tx) => getBooth(tx, boothId)))!.draft!.config;
    await withUserContext(db, userId, (tx) =>
      publishConfig(tx, { boothId, config: draft, userId }),
    );
    const ready = await until(
      () =>
        json<{
          status: string;
          version?: number;
          config?: BoothConfig;
          assets?: Record<string, string>;
        }>(fetch(`${local}/config/state`)),
      (s) => s.status === 'ready',
    );
    expect(ready.version).toBe(1);
    expect(Object.keys(ready.assets!).length).toBe(ready.config!.assets.length);
    expect(existsSync(join(dataDir, 'device-token'))).toBe(true);
  });
});

/** Minimal tablet: pairs, says hello, answers capture with a 12 MP JPEG. */
class FakeTablet {
  ws: WebSocket | null = null;
  token = '';
  captures: string[] = [];
  /** When false, capture commands are remembered but not answered (simulate a drop). */
  respond = true;
  pendingUploads = new Map<string, Buffer>();

  async pair() {
    const { payload } = await json<{ payload: { code: string; port: number } }>(
      fetch(`${local}/camera/pairing`, { method: 'POST' }),
    );
    const res = await json<CameraPairResponse>(
      fetch(`${lan}/camera/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: payload.code, name: 'iPad uji', platform: 'ios' }),
      }),
    );
    this.token = res.token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${lan.replace('http', 'ws')}/camera/ws`);
      this.ws = ws;
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'hello',
            token: this.token,
            pendingRequestIds: [...this.pendingUploads.keys()],
            info: {
              cameraId: '',
              name: '',
              platform: 'ios',
              appVersion: 'test',
              facing: 'back',
              photoWidth: 4032,
              photoHeight: 3024,
            },
          }),
        ),
      );
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as AgentToCamera;
        if (msg.type === 'welcome') {
          resolve();
          // Upload what was taken while offline.
          for (const [id, bytes] of this.pendingUploads) void this.upload(id, bytes);
        }
        if (msg.type === 'capture') {
          this.captures.push(msg.requestId);
          if (this.respond) void this.upload(msg.requestId, photo12mp);
          else this.pendingUploads.set(msg.requestId, photo12mp);
        }
      });
      ws.on('error', reject);
    });
  }

  async upload(requestId: string, bytes: Buffer) {
    const res = await fetch(`${lan}/camera/shots?requestId=${requestId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'image/jpeg' },
      body: new Uint8Array(bytes),
    });
    if (res.ok) this.pendingUploads.delete(requestId);
    return res;
  }

  drop() {
    this.ws?.terminate();
  }
}

const tablet = new FakeTablet();
const session = {
  id: 'sess_agent_1',
  code: generateSessionCode(),
  startedAt: new Date().toISOString(),
};
const shotIds: Record<number, string> = {};

async function capture(slotIndex: number, takeNumber = 1) {
  return fetch(`${local}/sessions/${session.id}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...session, boothId, configVersion: 1, slotIndex, takeNumber }),
  });
}

describe('tablet camera', () => {
  it('pairs with a one-time code (reuse is rejected) and connects', async () => {
    await tablet.pair();
    const reuse = await fetch(`${lan}/camera/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'a'.repeat(32), name: 'x', platform: 'x' }),
    });
    expect(reuse.status).toBe(403);
    await tablet.connect();
    const cam = await json<{ state: { status: string } }>(fetch(`${local}/camera`));
    expect(cam.state.status).toBe('connected');
  });

  it('stores the full-resolution still from the tablet, then confirms', async () => {
    const res = await capture(1);
    expect(res.status).toBe(201);
    const shot = await json<{
      photoId: string;
      width: number;
      height: number;
      source: string;
      url: string;
    }>(res);
    expect([shot.width, shot.height, shot.source]).toEqual([4032, 3024, 'tablet']);
    shotIds[1] = shot.photoId;
    const file = await fetch(shot.url);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect((await file.arrayBuffer()).byteLength).toBe(photo12mp.byteLength);
  });

  it('rejects uploads without the camera token', async () => {
    const res = await fetch(`${lan}/camera/shots?requestId=x`, {
      method: 'POST',
      body: new Uint8Array(photo12mp),
    });
    expect(res.status).toBe(401);
  });

  it('Wi-Fi drop during capture: shows disconnected, then reconnects without losing the photo', async () => {
    tablet.respond = false;
    const pending = capture(2);
    await until(
      () => tablet.captures.length,
      (n) => n === 2,
    );
    // Tablet took the photo but the network went away before the upload.
    tablet.drop();
    const down = await until(
      () => json<{ state: { status: string } }>(fetch(`${local}/camera`)),
      (c) => c.state.status === 'disconnected',
    );
    expect(down.state.status).toBe('disconnected');
    tablet.respond = true;
    await new Promise((r) => setTimeout(r, 500));
    await tablet.connect();
    const res = await pending;
    expect(res.status).toBe(201);
    const shot = await json<{ photoId: string; width: number }>(res);
    expect(shot.width).toBe(4032);
    shotIds[2] = shot.photoId;
    await until(
      () => tablet.pendingUploads.size,
      (n) => n === 0,
    );
  });

  it('capture requested while the tablet is away is sent once it is back', async () => {
    tablet.drop();
    await until(
      () => json<{ state: { status: string } }>(fetch(`${local}/camera`)),
      (c) => c.state.status === 'disconnected',
    );
    const pending = capture(3);
    await new Promise((r) => setTimeout(r, 300));
    await tablet.connect();
    const shot = await json<{ photoId: string }>(await pending);
    shotIds[3] = shot.photoId;
    const again = await json<{ photoId: string }>(await capture(4));
    shotIds[4] = again.photoId;
  });

  it('a repeated upload of the same request is idempotent', async () => {
    const id = tablet.captures.at(-1)!;
    const res = await tablet.upload(id, photo12mp);
    expect(await res.json()).toMatchObject({ status: 'duplicate', photoId: shotIds[4] });
  });
});

describe('processing → print (virtual printer)', () => {
  it('composes the strip and sends the sheet to the printer well under 15 s', async () => {
    const state = await json<{ config: BoothConfig }>(fetch(`${local}/config/state`));
    const config = state.config;
    const frame = config.frames.find((f) => f.enabled)!;
    const t0 = Date.now();
    const res = await fetch(`${local}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config,
        session: {
          ...session,
          frameId: frame.id,
          filterId: config.filters.find((f) => f.isDefault)!.id,
          paymentMethod: 'free',
          amount: 0,
          extraPrints: 1,
          downloadUrl: `https://pb.test/s/${session.code}`,
          shots: frame.slots.map((s) => ({ slotIndex: s.index, photoId: shotIds[s.index]! })),
        },
      }),
    });
    const body = await json<{
      printJob: { status: string; sheets: number; printer: string } | null;
      printError: string | null;
      sheetUrl: string;
      compositeUrl: string;
      timings: { totalMs: number };
    }>(res);
    const elapsed = Date.now() - t0;
    console.log(`[agent] 4 tablet photos → strip + sheet + print in ${elapsed} ms`, body.timings);
    expect(res.status).toBe(200);
    expect(body.printError).toBeNull();
    expect(body.printJob).toMatchObject({
      status: 'done',
      sheets: config.pricing.includedPrints + 1,
    });
    expect(elapsed).toBeLessThan(15_000);
    const sheet = await sharp(
      Buffer.from(await (await fetch(body.sheetUrl)).arrayBuffer()),
    ).metadata();
    expect([sheet.width, sheet.height, sheet.density]).toEqual([1200, 1800, 300]);
    const strip = await sharp(
      Buffer.from(await (await fetch(body.compositeUrl)).arrayBuffer()),
    ).metadata();
    expect([strip.width, strip.height]).toEqual([600, 1800]);

    const sessions = await json<
      { code: string; status: string; files: { kind: string; selected: boolean }[] }[]
    >(fetch(`${local}/sessions`));
    const mine = sessions.find((s) => s.code === session.code)!;
    expect(mine.status).toBe('completed');
    expect(mine.files.filter((f) => f.kind === 'original' && f.selected)).toHaveLength(4);
  }, 30_000);

  it('test print from admin goes through the selected printer', async () => {
    const res = await fetch(`${local}/print/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await json<{ job: { status: string } }>(res);
    expect(body.job.status).toBe('done');
  });
});

describe('telemetry', () => {
  it('heartbeat reports printer status; the outbox delivers events + print jobs exactly once', async () => {
    await agent.telemetry.beat();
    await agent.telemetry.flush();
    expect(agent.store.outboxCount()).toBe(0);
    const [device] = await db.select().from(devices);
    expect(device!.printerStatus).toBe('ok');
    const events = await db
      .select()
      .from(deviceEvents)
      .where(eq(deviceEvents.deviceId, device!.id));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['camera_disconnected', 'camera_reconnected', 'paired']),
    );
    const jobs = await db.select().from(printJobs).where(eq(printJobs.deviceId, device!.id));
    expect(jobs.map((j) => j.sheets).sort()).toEqual([1, 2]);

    // Re-delivery of the same ids (lost response) stores nothing twice.
    const again = await fetch(`${apiBase}/device/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${(agent.config.api as unknown as { token: string }).token}`,
      },
      body: JSON.stringify({
        events: [
          {
            id: events[0]!.id,
            level: 'info',
            kind: 'x',
            message: null,
            data: null,
            occurredAt: new Date().toISOString(),
          },
        ],
        printJobs: [],
      }),
    });
    expect(await again.json()).toEqual({ accepted: [events[0]!.id] });
    expect(
      await db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, device!.id)),
    ).toHaveLength(events.length);
  });

  it('F9: queues a link delivery in the outbox and hands it to the API', async () => {
    const post = (to: string) =>
      fetch(`${local}/deliveries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: { ...session, boothId, configVersion: 1 },
          channel: 'whatsapp',
          to,
          requestedAt: new Date().toISOString(),
        }),
      });
    expect((await post('12')).status).toBe(400);
    const ok = await json<{ id: string; queued: boolean }>(post('0812 3456 7890'));
    expect(ok.queued).toBe(true);
    await until(
      () => agent.store.outboxCount(),
      (n) => n === 0,
    );
    // This API has no SECRET_MASTER_KEY: the request is acknowledged as a conflict, not retried.
    const [conflict] = await db.select().from(deviceEvents).where(eq(deviceEvents.id, ok.id));
    expect(conflict).toMatchObject({
      kind: 'sync_conflict',
      data: { code: 'delivery_unavailable' },
    });
  });

  it('queues while offline and keeps the last config for an offline restart', async () => {
    await agent.stop();
    agent = new Agent(agentOptions({ apiBase: 'http://127.0.0.1:9' }));
    await agent.start();
    local = `http://127.0.0.1:${agent.localPort}`;
    const state = await json<{ status: string; source: string; version: number }>(
      fetch(`${local}/config/state`),
    );
    expect(state).toMatchObject({ status: 'ready', source: 'cache', version: 1 });
    await agent.telemetry.beat();
    expect(agent.telemetry.isOnline).toBe(false);
    expect(agent.store.outboxCount()).toBeGreaterThan(0); // agent_started etc. wait for the API
  });
});
