import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { secretBoxFromEnv, type SecretBox } from '@pb/crypto';
import { getDb, refreshDailyBoothStats, runBillingLifecycle, SESSION_QUEUE } from '@pb/db';
import { AccessTokenCache, GoogleOAuth, googleConfigFromEnv } from '@pb/drive';
import { messagingFromEnv } from '@pb/messaging';
import { storageFromEnv } from '@pb/storage';
import { Worker } from 'bullmq';
import { drainDeliveries } from './deliveries';
import { resolveFfmpeg } from './ffmpeg';
import { JobRunner } from './runner';
import type { WorkerDeps } from './types';

const rootEnv = resolve(import.meta.dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function optionalSecretBox(): SecretBox | null {
  try {
    return secretBoxFromEnv();
  } catch (err) {
    if (process.env.NODE_ENV === 'production') throw err;
    return null;
  }
}

const google = googleConfigFromEnv();
const secretBox = optionalSecretBox();
const storage = storageFromEnv();
const messaging = messagingFromEnv();
const workerDeps: WorkerDeps = {
  db: getDb(),
  storage,
  secretBox,
  google: google ? new GoogleOAuth(google) : null,
  driveTokens: new AccessTokenCache(),
  ffmpegPath: resolveFfmpeg(),
  messaging,
  shortLinkBase: process.env.PB_SHORT_LINK_BASE ?? process.env.PB_PUBLIC_API_URL ?? null,
  log: (m: string) => console.log(m),
};
const runner = new JobRunner(workerDeps, Number(process.env.PB_WORKER_CONCURRENCY ?? 2));

const redisUrl = process.env.REDIS_URL;
console.log(
  `[worker] storage: ${storage.kind}, drive: ${google ? 'configured' : 'NOT configured (GOOGLE_CLIENT_ID/SECRET)'}, queue: ${redisUrl ? 'bullmq + db polling' : 'db polling'}, messaging: ${messaging.channels.join('+') || 'NOT configured'}`,
);

// The job table is the queue of record: polling always runs (it also picks up retries whose
// backoff has passed, and jobs added while Redis was down). BullMQ only makes it immediate.
const pollMs = Number(process.env.PB_WORKER_POLL_MS ?? (redisUrl ? 30_000 : 3_000));
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    await runner.drain();
    await drainDeliveries(workerDeps);
  } catch (err) {
    console.error('[worker] poll failed', err);
  } finally {
    polling = false;
  }
}
const timer = setInterval(() => void poll(), pollMs);
void poll();

let bull: Worker | null = null;
if (redisUrl) {
  bull = new Worker(
    SESSION_QUEUE,
    async (job: { data: { sessionId?: string } }) => {
      await runner.drain(job.data.sessionId);
      // The API wakes the session's queue after a new delivery too (F9).
      await drainDeliveries(workerDeps);
    },
    { connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency: 4 },
  );
  bull.on('error', (err) => console.warn('[worker] redis error:', err.message));
}

const retentionDays = Number(process.env.PB_STORAGE_RETENTION_DAYS ?? 30);
const purge = setInterval(
  () =>
    void runner
      .purgeOldStorage(retentionDays)
      .then((n) => n && console.log(`[worker] purged storage of ${n} sessions`))
      .catch((err) => console.error('[worker] purge failed', err)),
  60 * 60_000,
);

// F6: daily sales view (refreshed every minute: "today" is read live, so lag only affects
// finished days) and the subscription lifecycle (past due → grace → downgrade, renewal invoices).
const db = getDb();
const refreshStats = () =>
  refreshDailyBoothStats(db).catch((err) => console.error('[worker] stats refresh failed', err));
const lifecycle = () =>
  runBillingLifecycle(db)
    .then((r) => {
      if (r.pastDue || r.downgraded || r.renewalInvoices)
        console.log(
          `[worker] billing: ${r.pastDue} past due, ${r.downgraded} downgraded, ${r.renewalInvoices} renewal invoices`,
        );
    })
    .catch((err) => console.error('[worker] billing lifecycle failed', err));
void refreshStats();
void lifecycle();
const statsTimer = setInterval(() => void refreshStats(), 60_000);
const lifecycleTimer = setInterval(() => void lifecycle(), 60 * 60_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.stop();
    clearInterval(timer);
    clearInterval(purge);
    clearInterval(statsTimer);
    clearInterval(lifecycleTimer);
    void bull?.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
