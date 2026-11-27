import type { BoothConfig } from '@pb/schema';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  auditLogs,
  boothConfigs,
  booths,
  cashApprovals,
  deviceEvents,
  devices,
  payments,
  printJobs,
  sessionOutputs,
  sessions,
  uploadJobs,
  vouchers,
} from './schema';
import type { Db, Tx } from './types';

/**
 * Sales recap, device status and logs for Studio (F6). Functions take a Studio Tx (RLS limits
 * every row to the user's orgs) or an owner connection, and always filter by org explicitly.
 *
 * Time: `sessions.started_at` is UTC. Every "day" and "hour" here is the calendar date/hour in
 * the BOOTH's own timezone (booths.timezone), so a session at 23:30 WIB is on that WIB day even
 * though it is 16:30 UTC. Filter dates ("YYYY-MM-DD") are booth-local dates as well.
 */

type DbOrTx = Db | Tx;

const toRows = <T>(res: unknown): T[] =>
  (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];

const num = (v: unknown) => Number(v ?? 0);

/** Calendar date `YYYY-MM-DD` of an instant in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Adds days to a `YYYY-MM-DD` date (pure calendar arithmetic, no timezone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isDateString = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export type ReportFilter = {
  orgId: string;
  /** Booth-local dates, inclusive. */
  from: string;
  to: string;
  boothId?: string | null;
  deviceId?: string | null;
  /** Test hook: "now" for the today-is-live rule. */
  asOf?: Date;
};

export type MethodKey = 'qris' | 'voucher' | 'cash' | 'free';
export type DayRow = {
  day: string;
  sessions: number;
  gross: number;
  fee: number;
  net: number;
};

export type ReportResult = {
  filter: { from: string; to: string; boothId: string | null; deviceId: string | null };
  totals: {
    sessions: number;
    gross: number;
    fee: number;
    net: number;
    /** gross / sessions, rounded; 0 when there are no sessions. */
    averageGross: number;
    extraPrints: number;
    offlineSessions: number;
    printedSheets: number;
  };
  methods: { method: MethodKey; sessions: number; gross: number }[];
  /** One row per day in the range (days without sales are zero). */
  days: DayRow[];
  /** 24 rows, hour of day in the booth timezone, summed over the range. */
  hours: { hour: number; sessions: number; gross: number }[];
  booths: { boothId: string; name: string; sessions: number; gross: number; net: number }[];
  frames: { frameId: string; name: string; sessions: number; gross: number }[];
  filters: { filterId: string; name: string; sessions: number }[];
};

const DAY_COLS = sql`
  count(*)::int as sessions,
  coalesce(sum(s.gross_amount), 0)::bigint as gross,
  coalesce(sum(s.fee_amount), 0)::bigint as fee,
  coalesce(sum(s.net_amount), 0)::bigint as net,
  coalesce(sum(s.extra_prints), 0)::int as extra_prints,
  count(*) filter (where s.offline)::int as offline_sessions,
  count(*) filter (where s.payment_method = 'qris')::int as qris_sessions,
  coalesce(sum(s.gross_amount) filter (where s.payment_method = 'qris'), 0)::bigint as qris_gross,
  count(*) filter (where s.payment_method = 'voucher')::int as voucher_sessions,
  coalesce(sum(s.gross_amount) filter (where s.payment_method = 'voucher'), 0)::bigint as voucher_gross,
  count(*) filter (where s.payment_method = 'cash')::int as cash_sessions,
  coalesce(sum(s.gross_amount) filter (where s.payment_method = 'cash'), 0)::bigint as cash_gross,
  count(*) filter (where s.payment_method = 'free')::int as free_sessions`;

type DailyRow = {
  booth_id: string;
  day: string;
  sessions: number;
  gross: string;
  fee: string;
  net: string;
  extra_prints: number;
  offline_sessions: number;
  qris_sessions: number;
  qris_gross: string;
  voucher_sessions: number;
  voucher_gross: string;
  cash_sessions: number;
  cash_gross: string;
  free_sessions: number;
};

const boothScope = (f: ReportFilter) => (f.boothId ? sql`and b.id = ${f.boothId}` : sql``);
const deviceScope = (f: ReportFilter) =>
  f.deviceId ? sql`and s.device_id = ${f.deviceId}` : sql``;

/**
 * Per booth and day. Without a device filter, finished days come from the materialized view
 * `daily_booth_stats` (refreshed by the worker) and "today" (booth-local) is computed live, so
 * the numbers are current without refreshing on every page view. A device filter has no
 * materialized form and is always live.
 */
async function dailyRows(db: DbOrTx, f: ReportFilter): Promise<DailyRow[]> {
  const asOf = (f.asOf ?? new Date()).toISOString();
  const liveWhere = sql`
    s.org_id = ${f.orgId} and s.payment_method is not null
    and (s.started_at at time zone b.timezone)::date between ${f.from}::date and ${f.to}::date`;
  if (f.deviceId) {
    return toRows<DailyRow>(
      await db.execute(sql`
        select b.id as booth_id, ((s.started_at at time zone b.timezone)::date)::text as day, ${DAY_COLS}
        from sessions s join booths b on b.id = s.booth_id
        where ${liveWhere} ${boothScope(f)} ${deviceScope(f)}
        group by b.id, (s.started_at at time zone b.timezone)::date`),
    );
  }
  return toRows<DailyRow>(
    await db.execute(sql`
      select v.booth_id, v.day::text as day, v.sessions, v.gross, v.fee, v.net, v.extra_prints,
        v.offline_sessions, v.qris_sessions, v.qris_gross, v.voucher_sessions, v.voucher_gross,
        v.cash_sessions, v.cash_gross, v.free_sessions
      from daily_booth_stats_v v join booths b on b.id = v.booth_id
      where v.org_id = ${f.orgId} and v.day between ${f.from}::date and ${f.to}::date
        and v.day < (${asOf}::timestamptz at time zone b.timezone)::date ${boothScope(f)}
      union all
      select b.id as booth_id, ((s.started_at at time zone b.timezone)::date)::text as day, ${DAY_COLS}
      from sessions s join booths b on b.id = s.booth_id
      where ${liveWhere} ${boothScope(f)}
        and (s.started_at at time zone b.timezone)::date >= (${asOf}::timestamptz at time zone b.timezone)::date
      group by b.id, (s.started_at at time zone b.timezone)::date`),
  );
}

export async function getReport(db: DbOrTx, f: ReportFilter): Promise<ReportResult> {
  const daily = await dailyRows(db, f);

  const totals = {
    sessions: 0,
    gross: 0,
    fee: 0,
    net: 0,
    averageGross: 0,
    extraPrints: 0,
    offlineSessions: 0,
    printedSheets: 0,
  };
  const method: Record<MethodKey, { sessions: number; gross: number }> = {
    qris: { sessions: 0, gross: 0 },
    voucher: { sessions: 0, gross: 0 },
    cash: { sessions: 0, gross: 0 },
    free: { sessions: 0, gross: 0 },
  };
  const byDay = new Map<string, DayRow>();
  const byBooth = new Map<string, { sessions: number; gross: number; net: number }>();
  for (const r of daily) {
    totals.sessions += num(r.sessions);
    totals.gross += num(r.gross);
    totals.fee += num(r.fee);
    totals.net += num(r.net);
    totals.extraPrints += num(r.extra_prints);
    totals.offlineSessions += num(r.offline_sessions);
    method.qris.sessions += num(r.qris_sessions);
    method.qris.gross += num(r.qris_gross);
    method.voucher.sessions += num(r.voucher_sessions);
    method.voucher.gross += num(r.voucher_gross);
    method.cash.sessions += num(r.cash_sessions);
    method.cash.gross += num(r.cash_gross);
    method.free.sessions += num(r.free_sessions);
    const d = byDay.get(r.day) ?? { day: r.day, sessions: 0, gross: 0, fee: 0, net: 0 };
    d.sessions += num(r.sessions);
    d.gross += num(r.gross);
    d.fee += num(r.fee);
    d.net += num(r.net);
    byDay.set(r.day, d);
    const b = byBooth.get(r.booth_id) ?? { sessions: 0, gross: 0, net: 0 };
    b.sessions += num(r.sessions);
    b.gross += num(r.gross);
    b.net += num(r.net);
    byBooth.set(r.booth_id, b);
  }
  totals.averageGross = totals.sessions ? Math.round(totals.gross / totals.sessions) : 0;

  const days: DayRow[] = [];
  for (let d = f.from, n = 0; d <= f.to && n < 400; d = addDays(d, 1), n++) {
    days.push(byDay.get(d) ?? { day: d, sessions: 0, gross: 0, fee: 0, net: 0 });
  }

  const liveWhere = sql`s.org_id = ${f.orgId} and s.payment_method is not null
    and (s.started_at at time zone b.timezone)::date between ${f.from}::date and ${f.to}::date
    ${boothScope(f)} ${deviceScope(f)}`;

  const hourRows = toRows<{ hour: number; sessions: number; gross: string }>(
    await db.execute(sql`
      select extract(hour from s.started_at at time zone b.timezone)::int as hour,
        count(*)::int as sessions, coalesce(sum(s.gross_amount), 0)::bigint as gross
      from sessions s join booths b on b.id = s.booth_id
      where ${liveWhere} group by 1`),
  );
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const r = hourRows.find((x) => num(x.hour) === hour);
    return { hour, sessions: num(r?.sessions), gross: num(r?.gross) };
  });

  const frameRows = toRows<{ frame_id: string | null; sessions: number; gross: string }>(
    await db.execute(sql`
      select s.frame_id, count(*)::int as sessions, coalesce(sum(s.gross_amount), 0)::bigint as gross
      from sessions s join booths b on b.id = s.booth_id
      where ${liveWhere} and s.frame_id is not null group by s.frame_id
      order by count(*) desc, s.frame_id limit 10`),
  );
  const filterRows = toRows<{ filter_id: string | null; sessions: number }>(
    await db.execute(sql`
      select s.filter_id, count(*)::int as sessions
      from sessions s join booths b on b.id = s.booth_id
      where ${liveWhere} and s.filter_id is not null and s.filter_id <> ''
      group by s.filter_id order by count(*) desc, s.filter_id limit 10`),
  );

  // Sheets printed (print_jobs carry no booth: through the device), by booth-local day.
  const sheetRows = toRows<{ n: string }>(
    await db.execute(sql`
      select coalesce(sum(p.sheets), 0)::bigint as n
      from print_jobs p join devices d on d.id = p.device_id join booths b on b.id = d.booth_id
      where p.org_id = ${f.orgId} and p.status = 'done'
        and (p.occurred_at at time zone b.timezone)::date between ${f.from}::date and ${f.to}::date
        ${boothScope(f)} ${f.deviceId ? sql`and p.device_id = ${f.deviceId}` : sql``}`),
  );
  totals.printedSheets = num(sheetRows[0]?.n);

  const boothIds = [...byBooth.keys()];
  const names = await boothNames(db, f.orgId, boothIds);
  const nameOf = (boothId: string) => names.get(boothId);
  const frameNames = new Map<string, string>();
  const filterNames = new Map<string, string>();
  for (const cfg of await activeConfigs(db, f.orgId, f.boothId ? [f.boothId] : null)) {
    for (const fr of cfg.frames) frameNames.set(fr.id, fr.name);
    for (const fi of cfg.filters) filterNames.set(fi.id, fi.name);
  }

  return {
    filter: {
      from: f.from,
      to: f.to,
      boothId: f.boothId ?? null,
      deviceId: f.deviceId ?? null,
    },
    totals,
    methods: (Object.keys(method) as MethodKey[]).map((k) => ({ method: k, ...method[k] })),
    days,
    hours,
    booths: [...byBooth.entries()]
      .map(([boothId, v]) => ({ boothId, name: nameOf(boothId) ?? boothId, ...v }))
      .sort((a, b) => b.gross - a.gross),
    frames: frameRows.map((r) => ({
      frameId: r.frame_id!,
      name: frameNames.get(r.frame_id!) ?? r.frame_id!,
      sessions: num(r.sessions),
      gross: num(r.gross),
    })),
    filters: filterRows.map((r) => ({
      filterId: r.filter_id!,
      name: filterNames.get(r.filter_id!) ?? r.filter_id!,
      sessions: num(r.sessions),
    })),
  };
}

async function boothNames(db: DbOrTx, orgId: string, ids: string[]) {
  const rows = ids.length
    ? await db
        .select({ id: booths.id, name: booths.name })
        .from(booths)
        .where(and(eq(booths.orgId, orgId), inArray(booths.id, ids)))
    : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Active published config of each booth (names of frames/filters shown in the recap). */
async function activeConfigs(db: DbOrTx, orgId: string, boothIds: string[] | null) {
  const rows = await db
    .select({ config: boothConfigs.config })
    .from(booths)
    .innerJoin(boothConfigs, eq(boothConfigs.id, booths.activeConfigId))
    .where(and(eq(booths.orgId, orgId), boothIds ? inArray(booths.id, boothIds) : sql`true`));
  return rows.map((r) => r.config as BoothConfig);
}

/** Refresh of the materialized view (worker, every minute). `concurrently`: readers never block. */
export async function refreshDailyBoothStats(db: Db): Promise<void> {
  await db.execute(sql`refresh materialized view concurrently daily_booth_stats`);
}

// --- transactions ---------------------------------------------------------------------------------

export type TransactionRow = {
  id: string;
  code: string;
  boothId: string;
  boothName: string;
  /** IANA zone of the booth: every time shown for this row is in it. */
  timezone: string;
  deviceName: string | null;
  startedAt: Date;
  completedAt: Date | null;
  status: (typeof sessions.$inferSelect)['status'];
  paymentMethod: (typeof sessions.$inferSelect)['paymentMethod'];
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  extraPrints: number;
  /** F8: consent + survey answers. */
  responses: (typeof sessions.$inferSelect)['responses'];
  offline: boolean;
  syncedAt: Date | null;
  driveFolderUrl: string | null;
  jobs: {
    target: 'storage' | 'drive';
    status: (typeof uploadJobs.$inferSelect)['status'];
    errorCode: string | null;
    lastError: string | null;
    attempts: number;
    nextAttemptAt: Date | null;
  }[];
  print: { sheets: number; status: string } | null;
};

export async function listTransactions(
  db: DbOrTx,
  f: ReportFilter & { limit?: number; offset?: number },
): Promise<{ rows: TransactionRow[]; total: number }> {
  const limit = Math.min(200, f.limit ?? 50);
  const where = and(
    eq(sessions.orgId, f.orgId),
    f.boothId ? eq(sessions.boothId, f.boothId) : undefined,
    f.deviceId ? eq(sessions.deviceId, f.deviceId) : undefined,
    sql`(${sessions.startedAt} at time zone ${booths.timezone})::date between ${f.from}::date and ${f.to}::date`,
  );
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .innerJoin(booths, eq(booths.id, sessions.boothId))
    .where(where);
  const base = await db
    .select({
      s: sessions,
      boothName: booths.name,
      timezone: booths.timezone,
      deviceName: devices.name,
    })
    .from(sessions)
    .innerJoin(booths, eq(booths.id, sessions.boothId))
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(where)
    .orderBy(desc(sessions.startedAt))
    .limit(limit)
    .offset(f.offset ?? 0);
  const ids = base.map((r) => r.s.id);
  const jobs = ids.length
    ? await db.select().from(uploadJobs).where(inArray(uploadJobs.sessionId, ids))
    : [];
  const prints = ids.length
    ? await db
        .select()
        .from(printJobs)
        .where(inArray(printJobs.sessionId, ids))
        .orderBy(desc(printJobs.occurredAt))
    : [];
  return {
    total: Number(n),
    rows: base.map(({ s, boothName, timezone, deviceName }) => {
      const p = prints.filter((x) => x.sessionId === s.id);
      return {
        id: s.id,
        code: s.code,
        boothId: s.boothId,
        boothName,
        timezone,
        deviceName,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        status: s.status,
        paymentMethod: s.paymentMethod,
        grossAmount: s.grossAmount,
        feeAmount: s.feeAmount,
        netAmount: s.netAmount,
        extraPrints: s.extraPrints,
        responses: s.responses,
        offline: s.offline,
        syncedAt: s.syncedAt,
        driveFolderUrl: s.driveFolderUrl,
        jobs: jobs
          .filter((j) => j.sessionId === s.id)
          .map((j) => ({
            target: j.target,
            status: j.status,
            errorCode: j.errorCode,
            lastError: j.lastError,
            attempts: j.attempts,
            nextAttemptAt: j.nextAttemptAt,
          })),
        print: p.length
          ? { sheets: p.reduce((a, x) => a + x.sheets, 0), status: p[0]!.status }
          : null,
      };
    }),
  };
}

export type SessionDetail = {
  session: typeof sessions.$inferSelect;
  boothName: string;
  timezone: string;
  deviceName: string | null;
  outputs: {
    kind: string;
    name: string | null;
    status: string;
    bytes: number | null;
    hasStoredFile: boolean;
  }[];
  /** Key of the composite in object storage (thumbnail), if still stored. */
  compositePath: string | null;
  payments: (typeof payments.$inferSelect)[];
  voucher: { codeLast4: string; valueType: string; value: number } | null;
  cash: { amount: number; approvedAt: Date | null }[];
  printJobs: (typeof printJobs.$inferSelect)[];
  jobs: (typeof uploadJobs.$inferSelect)[];
};

export async function getSessionDetail(
  db: DbOrTx,
  orgId: string,
  sessionId: string,
): Promise<SessionDetail | null> {
  const [row] = await db
    .select({
      s: sessions,
      boothName: booths.name,
      timezone: booths.timezone,
      deviceName: devices.name,
    })
    .from(sessions)
    .innerJoin(booths, eq(booths.id, sessions.boothId))
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)));
  if (!row) return null;
  const outs = await db
    .select()
    .from(sessionOutputs)
    .where(eq(sessionOutputs.sessionId, sessionId));
  const [pay, cash, prints, jobs, vou] = await Promise.all([
    db
      .select()
      .from(payments)
      .where(eq(payments.sessionId, sessionId))
      .orderBy(desc(payments.createdAt)),
    db.select().from(cashApprovals).where(eq(cashApprovals.sessionId, sessionId)),
    db
      .select()
      .from(printJobs)
      .where(eq(printJobs.sessionId, sessionId))
      .orderBy(desc(printJobs.occurredAt)),
    db.select().from(uploadJobs).where(eq(uploadJobs.sessionId, sessionId)),
    db.select().from(vouchers).where(eq(vouchers.usedSessionId, sessionId)),
  ]);
  const composite = outs.find((o) => o.kind === 'composite' && o.storagePath);
  return {
    session: row.s,
    boothName: row.boothName,
    timezone: row.timezone,
    deviceName: row.deviceName,
    outputs: outs
      .map((o) => ({
        kind: o.kind,
        name: o.name,
        status: o.status,
        bytes: o.bytes,
        hasStoredFile: !!o.storagePath,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.name ?? '').localeCompare(b.name ?? '')),
    compositePath: composite?.storagePath ?? null,
    payments: pay,
    voucher: vou[0]
      ? { codeLast4: vou[0].codeLast4, valueType: vou[0].valueType, value: vou[0].value }
      : null,
    cash: cash.map((c) => ({ amount: c.amount, approvedAt: c.approvedAt })),
    printJobs: prints,
    jobs,
  };
}

/** Paid sessions whose files never reached us: "data belum tersinkron". */
export async function listUnsyncedDevices(db: DbOrTx, orgId: string) {
  return db
    .select({
      id: devices.id,
      name: devices.name,
      boothId: devices.boothId,
      outboxPending: devices.outboxPending,
      uploadsPending: devices.uploadsPending,
      lastHeartbeatAt: devices.lastHeartbeatAt,
    })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, orgId),
        isNull(devices.revokedAt),
        or(sql`${devices.outboxPending} > 0`, sql`${devices.uploadsPending} > 0`),
      ),
    );
}

// --- devices ---------------------------------------------------------------------------------------

/** Silent for longer than this: shown as offline (heartbeats come every 30 s). */
export const DEVICE_OFFLINE_MS = 5 * 60_000;
/** Between "online" and "offline": the device missed heartbeats. */
export const DEVICE_STALE_MS = 2 * 60_000;

export type Connectivity = 'online' | 'stale' | 'offline' | 'revoked' | 'never';

export function deviceConnectivity(
  d: { lastHeartbeatAt: Date | null; revokedAt: Date | null },
  now: Date = new Date(),
): Connectivity {
  if (d.revokedAt) return 'revoked';
  if (!d.lastHeartbeatAt) return 'never';
  const age = now.getTime() - d.lastHeartbeatAt.getTime();
  if (age > DEVICE_OFFLINE_MS) return 'offline';
  if (age > DEVICE_STALE_MS) return 'stale';
  return 'online';
}

export type DeviceRow = typeof devices.$inferSelect & {
  boothName: string | null;
  boothTimezone: string | null;
  activeConfigVersion: number | null;
  /** Sheets printed since the roll was loaded (all time when never reset). */
  sheetsSinceRoll: number;
  sheetsTotal: number;
  /** Sheets left on the roll, null when the owner has not entered the capacity. */
  sheetsRemaining: number | null;
};

export async function listOrgDevices(db: DbOrTx, orgId: string): Promise<DeviceRow[]> {
  const rows = await db
    .select({
      d: devices,
      boothName: booths.name,
      boothTimezone: booths.timezone,
      activeConfigVersion: boothConfigs.version,
    })
    .from(devices)
    .leftJoin(booths, eq(booths.id, devices.boothId))
    .leftJoin(boothConfigs, eq(boothConfigs.id, booths.activeConfigId))
    .where(eq(devices.orgId, orgId))
    .orderBy(desc(devices.createdAt));
  const sheets = toRows<{ device_id: string; total: string; since: string }>(
    await db.execute(sql`
      select p.device_id, coalesce(sum(p.sheets), 0)::bigint as total,
        coalesce(sum(p.sheets) filter (where d.paper_loaded_at is null or p.occurred_at >= d.paper_loaded_at), 0)::bigint as since
      from print_jobs p join devices d on d.id = p.device_id
      where p.org_id = ${orgId} and p.status = 'done' group by p.device_id`),
  );
  const by = new Map(sheets.map((s) => [s.device_id, s]));
  return rows.map(({ d, boothName, boothTimezone, activeConfigVersion }) => {
    const s = by.get(d.id);
    const since = num(s?.since);
    return {
      ...d,
      boothName,
      boothTimezone,
      activeConfigVersion,
      sheetsSinceRoll: since,
      sheetsTotal: num(s?.total),
      sheetsRemaining: d.paperCapacity ? Math.max(0, d.paperCapacity - since) : null,
    };
  });
}

export async function getDevice(db: DbOrTx, orgId: string, deviceId: string) {
  return (await listOrgDevices(db, orgId)).find((d) => d.id === deviceId) ?? null;
}

/** Owner: set the roll capacity and/or start a new roll (counter back to zero). */
export async function updatePaper(
  db: DbOrTx,
  input: {
    orgId: string;
    deviceId: string;
    capacity?: number | null;
    newRoll?: boolean;
    userId: string;
  },
) {
  const set: Partial<typeof devices.$inferInsert> = { updatedAt: new Date() };
  if (input.capacity !== undefined) {
    if (
      input.capacity !== null &&
      (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100000)
    )
      throw new Error('Kapasitas roll harus bilangan bulat 1–100000');
    set.paperCapacity = input.capacity;
  }
  if (input.newRoll) set.paperLoadedAt = new Date();
  const res = await db
    .update(devices)
    .set(set)
    .where(and(eq(devices.id, input.deviceId), eq(devices.orgId, input.orgId)))
    .returning({ id: devices.id });
  if (!res.length) throw new Error('Perangkat tidak ditemukan');
  await db.insert(auditLogs).values({
    orgId: input.orgId,
    actorId: input.userId,
    action: input.newRoll ? 'device.paper_new_roll' : 'device.paper_capacity',
    entity: 'device',
    entityId: input.deviceId,
    after: { capacity: input.capacity ?? null, newRoll: !!input.newRoll },
  });
}

export async function listDeviceEvents(
  db: DbOrTx,
  input: {
    orgId: string;
    deviceId?: string | null;
    level?: 'info' | 'warn' | 'error' | null;
    kind?: string | null;
    limit?: number;
  },
) {
  return db
    .select({ e: deviceEvents, deviceName: devices.name })
    .from(deviceEvents)
    .innerJoin(devices, eq(devices.id, deviceEvents.deviceId))
    .where(
      and(
        eq(deviceEvents.orgId, input.orgId),
        input.deviceId ? eq(deviceEvents.deviceId, input.deviceId) : undefined,
        input.level ? eq(deviceEvents.level, input.level) : undefined,
        input.kind ? eq(deviceEvents.kind, input.kind) : undefined,
      ),
    )
    .orderBy(desc(deviceEvents.occurredAt))
    .limit(Math.min(500, input.limit ?? 100));
}

export async function listEventKinds(db: DbOrTx, orgId: string, deviceId?: string | null) {
  const rows = toRows<{ kind: string }>(
    await db.execute(sql`
      select distinct kind from device_events
      where org_id = ${orgId} ${deviceId ? sql`and device_id = ${deviceId}` : sql``}
      order by kind`),
  );
  return rows.map((r) => r.kind);
}

/** Upload queue of the org: files not yet in Drive (waiting, retrying or failed). */
export async function listUploadQueue(db: DbOrTx, orgId: string, limit = 100) {
  return db
    .select({
      job: uploadJobs,
      code: sessions.code,
      sessionId: sessions.id,
      boothName: booths.name,
      startedAt: sessions.startedAt,
    })
    .from(uploadJobs)
    .innerJoin(sessions, eq(sessions.id, uploadJobs.sessionId))
    .innerJoin(booths, eq(booths.id, sessions.boothId))
    .where(
      and(
        eq(uploadJobs.orgId, orgId),
        inArray(uploadJobs.status, ['pending', 'running', 'failed']),
      ),
    )
    .orderBy(desc(uploadJobs.updatedAt))
    .limit(limit);
}

// --- audit log --------------------------------------------------------------------------------------

export async function listAuditLogs(
  db: DbOrTx,
  input: { orgId: string; since?: Date | null; action?: string | null; limit?: number },
) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.orgId, input.orgId),
        input.since ? gte(auditLogs.at, input.since) : undefined,
        input.action ? eq(auditLogs.action, input.action) : undefined,
      ),
    )
    .orderBy(desc(auditLogs.at))
    .limit(Math.min(1000, input.limit ?? 200));
}

export async function listAuditActions(db: DbOrTx, orgId: string) {
  const rows = toRows<{ action: string }>(
    await db.execute(
      sql`select distinct action from audit_logs where org_id = ${orgId} order by action`,
    ),
  );
  return rows.map((r) => r.action);
}

export type AuditEntityLabel = { label: string; href: string | null };

/**
 * Human labels for audit log objects ("Booth A · v3", session code, device name) instead of raw
 * ids. Key: `${entity}:${entityId}`. Unknown or deleted objects are simply missing from the map.
 * Scoped to the org (and RLS) like every other query.
 */
export async function describeAuditEntities(
  db: DbOrTx,
  orgId: string,
  refs: { entity: string; entityId: string | null }[],
): Promise<Map<string, AuditEntityLabel>> {
  const ids = (entity: string) => [
    ...new Set(refs.filter((r) => r.entity === entity && r.entityId).map((r) => r.entityId!)),
  ];
  const out = new Map<string, AuditEntityLabel>();
  const configIds = ids('booth_config');
  const boothIds = ids('booth');
  const sessionIds = ids('session');
  const deviceIds = ids('device');
  const [configRows, boothRows, sessionRows, deviceRows] = await Promise.all([
    configIds.length
      ? db
          .select({
            id: boothConfigs.id,
            version: boothConfigs.version,
            boothId: booths.id,
            name: booths.name,
          })
          .from(boothConfigs)
          .innerJoin(booths, eq(booths.id, boothConfigs.boothId))
          .where(and(eq(boothConfigs.orgId, orgId), inArray(boothConfigs.id, configIds)))
      : [],
    boothIds.length
      ? db
          .select({ id: booths.id, name: booths.name })
          .from(booths)
          .where(and(eq(booths.orgId, orgId), inArray(booths.id, boothIds)))
      : [],
    sessionIds.length
      ? db
          .select({ id: sessions.id, code: sessions.code })
          .from(sessions)
          .where(and(eq(sessions.orgId, orgId), inArray(sessions.id, sessionIds)))
      : [],
    deviceIds.length
      ? db
          .select({ id: devices.id, name: devices.name })
          .from(devices)
          .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)))
      : [],
  ]);
  for (const r of configRows)
    out.set(`booth_config:${r.id}`, {
      label: `${r.name} · v${r.version}`,
      href: `/booths/${r.boothId}`,
    });
  for (const r of boothRows) out.set(`booth:${r.id}`, { label: r.name, href: `/booths/${r.id}` });
  for (const r of sessionRows)
    out.set(`session:${r.id}`, { label: `Sesi ${r.code}`, href: `/transactions/${r.id}` });
  for (const r of deviceRows)
    out.set(`device:${r.id}`, { label: `Perangkat ${r.name}`, href: `/devices/${r.id}` });
  return out;
}
