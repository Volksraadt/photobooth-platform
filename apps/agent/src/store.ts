import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createId } from '@paralleldrive/cuid2';

/**
 * Local SQLite (docs/schema.md C). Times are ISO 8601 UTC. Nothing is deleted from
 * local_sessions/local_files here: files are removed only after a confirmed upload (F5).
 */

const MIGRATIONS: string[] = [
  `
  create table meta (key text primary key, value text not null);
  create table config_cache (
    version integer primary key,
    config_id text,
    etag text,
    config text not null,
    -- assetId → path under dataDir/assets (JSON)
    asset_paths text not null,
    activated_at text not null
  );
  create table local_sessions (
    id text primary key,
    code text not null unique,
    booth_id text not null,
    config_version integer not null,
    frame_id text,
    filter_id text,
    payment_method text,
    amount integer not null default 0,
    extra_prints integer not null default 0,
    status text not null,
    download_url text,
    data text,
    started_at text not null,
    completed_at text,
    sync_status text not null default 'pending',
    created_at text not null,
    updated_at text not null
  );
  create table local_files (
    id text primary key,
    session_id text not null references local_sessions(id),
    kind text not null,
    slot_index integer,
    take_number integer,
    path text not null,
    mime_type text not null,
    width integer,
    height integer,
    bytes integer not null,
    sha256 text not null,
    source text,
    selected integer not null default 0,
    captured_at text,
    upload_status text not null default 'pending',
    created_at text not null
  );
  create index local_files_session on local_files(session_id);
  create table local_vouchers (
    code_hash text not null,
    booth_id text not null,
    used_at text,
    synced integer not null default 0,
    primary key (booth_id, code_hash)
  );
  create table outbox (
    id text primary key,
    kind text not null,
    payload text not null,
    created_at text not null,
    attempts integer not null default 0,
    next_attempt_at text not null,
    last_error text
  );
  create table camera_pairings (
    id text primary key,
    name text not null,
    platform text not null,
    token_hash text not null unique,
    created_at text not null,
    last_seen_at text,
    revoked_at text
  );
  create table print_jobs (
    id text primary key,
    session_id text,
    sheets integer not null,
    printer text not null,
    status text not null,
    file_path text not null,
    os_job_id text,
    error text,
    created_at text not null,
    updated_at text not null
  );
  `,
  // v2 (F4): voucher list for offline validation, cash approvals, offline flag per session.
  `
  drop table local_vouchers;
  create table local_vouchers (
    code_hash text not null,
    booth_id text not null,
    value_type text not null,
    value integer not null default 0,
    expires_at text,
    -- used according to the API (another device, or synced)
    remote_used_at text,
    -- used on this device
    used_at text,
    used_session_id text,
    synced integer not null default 0,
    primary key (booth_id, code_hash)
  );
  create table cash_approvals (
    id text primary key,
    session_id text not null,
    amount integer not null,
    approved_at text not null,
    offline integer not null default 0
  );
  alter table local_sessions add column offline integer not null default 0;
  alter table local_sessions add column payment_id text;
  `,
  // v3 (F5): upload queue state per session. sync_status: pending | uploaded | purged.
  `
  alter table local_sessions add column upload_attempts integer not null default 0;
  alter table local_sessions add column upload_next_at text;
  alter table local_sessions add column upload_error text;
  alter table local_sessions add column uploaded_at text;
  `,
];

export type LocalVoucherRow = {
  code_hash: string;
  booth_id: string;
  value_type: 'full' | 'amount';
  value: number;
  expires_at: string | null;
  remote_used_at: string | null;
  used_at: string | null;
  used_session_id: string | null;
  synced: number;
};

export type LocalSessionRow = {
  id: string;
  code: string;
  booth_id: string;
  config_version: number;
  frame_id: string | null;
  filter_id: string | null;
  payment_method: string | null;
  amount: number;
  extra_prints: number;
  /** `abandoned`: the buyer left before paying (no payment, nothing to upload). */
  status: 'capturing' | 'completed' | 'failed' | 'abandoned';
  download_url: string | null;
  data: string | null;
  started_at: string;
  completed_at: string | null;
  sync_status: string;
  offline: number;
  payment_id: string | null;
  upload_attempts: number;
  upload_next_at: string | null;
  upload_error: string | null;
  uploaded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LocalFileRow = {
  id: string;
  session_id: string;
  kind: 'original' | 'composite' | 'print';
  slot_index: number | null;
  take_number: number | null;
  path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  bytes: number;
  sha256: string;
  source: string | null;
  selected: number;
  captured_at: string | null;
  upload_status: string;
  created_at: string;
};

export type OutboxKind =
  'device_event' | 'print_job' | 'voucher_use' | 'cash_approval' | 'session' | 'payment_cancel';

export type OutboxRow = {
  id: string;
  kind: OutboxKind;
  payload: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
};

export type PrintJobRow = {
  id: string;
  session_id: string | null;
  sheets: number;
  printer: string;
  status: 'queued' | 'printing' | 'done' | 'failed';
  file_path: string;
  os_job_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type CameraPairingRow = {
  id: string;
  name: string;
  platform: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export type DeviceEventInput = {
  level: 'info' | 'warn' | 'error';
  kind: string;
  message?: string;
  data?: unknown;
};

const now = () => new Date().toISOString();

export class AgentStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'agent.sqlite'));
    this.db.exec(
      'pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;',
    );
    this.migrate();
  }

  private migrate() {
    const current = Number(
      (this.db.prepare('pragma user_version').get() as { user_version: number }).user_version,
    );
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('begin');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`pragma user_version = ${v + 1}`);
        this.db.exec('commit');
      } catch (err) {
        this.db.exec('rollback');
        throw err;
      }
    }
  }

  close() {
    this.closed = true;
    this.db.close();
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  // --- meta / settings ---

  getMeta(key: string): string | null {
    return this.get<{ value: string }>('select value from meta where key = ?', key)?.value ?? null;
  }

  setMeta(key: string, value: string | null) {
    if (value === null) this.run('delete from meta where key = ?', key);
    else
      this.run(
        'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
        key,
        value,
      );
  }

  // --- config cache ---

  saveConfig(entry: {
    version: number;
    configId: string | null;
    etag: string | null;
    config: unknown;
    assetPaths: Record<string, string>;
  }) {
    this.run(
      `insert into config_cache (version, config_id, etag, config, asset_paths, activated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(version) do update set config_id = excluded.config_id, etag = excluded.etag,
         config = excluded.config, asset_paths = excluded.asset_paths, activated_at = excluded.activated_at`,
      entry.version,
      entry.configId,
      entry.etag,
      JSON.stringify(entry.config),
      JSON.stringify(entry.assetPaths),
      now(),
    );
  }

  /** Most recently activated config (offline start). */
  latestConfig(): {
    version: number;
    etag: string | null;
    config: unknown;
    assetPaths: Record<string, string>;
  } | null {
    const row = this.get<{
      version: number;
      etag: string | null;
      config: string;
      asset_paths: string;
    }>(
      'select version, etag, config, asset_paths from config_cache order by activated_at desc, version desc limit 1',
    );
    return row
      ? {
          version: row.version,
          etag: row.etag,
          config: JSON.parse(row.config),
          assetPaths: JSON.parse(row.asset_paths) as Record<string, string>,
        }
      : null;
  }

  clearConfigs() {
    this.run('delete from config_cache');
  }

  // --- sessions & files ---

  ensureSession(s: {
    id: string;
    code: string;
    boothId: string;
    configVersion: number;
    startedAt: string;
  }): LocalSessionRow {
    this.run(
      `insert into local_sessions (id, code, booth_id, config_version, status, started_at, created_at, updated_at)
       values (?, ?, ?, ?, 'capturing', ?, ?, ?) on conflict(id) do nothing`,
      s.id,
      s.code,
      s.boothId,
      s.configVersion,
      s.startedAt,
      now(),
      now(),
    );
    return this.session(s.id)!;
  }

  session(id: string): LocalSessionRow | undefined {
    return this.get<LocalSessionRow>('select * from local_sessions where id = ?', id);
  }

  sessions(limit = 50): LocalSessionRow[] {
    return this.all<LocalSessionRow>(
      'select * from local_sessions order by started_at desc limit ?',
      limit,
    );
  }

  completeSession(
    id: string,
    patch: {
      frameId: string | null;
      filterId: string | null;
      paymentMethod: string | null;
      amount: number;
      extraPrints: number;
      downloadUrl: string | null;
      data: unknown;
      status: 'completed' | 'failed';
    },
  ) {
    this.run(
      `update local_sessions set frame_id = ?, filter_id = ?, payment_method = ?, amount = ?,
         extra_prints = ?, download_url = ?, data = ?, status = ?, completed_at = ?, updated_at = ?
       where id = ?`,
      patch.frameId,
      patch.filterId,
      patch.paymentMethod,
      patch.amount,
      patch.extraPrints,
      patch.downloadUrl,
      JSON.stringify(patch.data),
      patch.status,
      now(),
      now(),
      id,
    );
  }

  addFile(
    f: Omit<LocalFileRow, 'id' | 'created_at' | 'upload_status' | 'selected'> & { id?: string },
  ) {
    const id = f.id ?? createId();
    this.run(
      `insert into local_files (id, session_id, kind, slot_index, take_number, path, mime_type, width, height,
         bytes, sha256, source, captured_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      f.session_id,
      f.kind,
      f.slot_index,
      f.take_number,
      f.path,
      f.mime_type,
      f.width,
      f.height,
      f.bytes,
      f.sha256,
      f.source,
      f.captured_at,
      now(),
    );
    return this.file(id)!;
  }

  file(id: string): LocalFileRow | undefined {
    return this.get<LocalFileRow>('select * from local_files where id = ?', id);
  }

  files(sessionId: string): LocalFileRow[] {
    return this.all<LocalFileRow>(
      'select * from local_files where session_id = ? order by created_at, slot_index, take_number',
      sessionId,
    );
  }

  shotFile(sessionId: string, slotIndex: number, takeNumber: number): LocalFileRow | undefined {
    return this.get<LocalFileRow>(
      `select * from local_files where session_id = ? and kind = 'original' and slot_index = ? and take_number = ?`,
      sessionId,
      slotIndex,
      takeNumber,
    );
  }

  markSelected(sessionId: string, fileIds: string[]) {
    this.run(
      `update local_files set selected = 0 where session_id = ? and kind = 'original'`,
      sessionId,
    );
    const stmt = this.db.prepare(
      'update local_files set selected = 1 where id = ? and session_id = ?',
    );
    for (const id of fileIds) stmt.run(id, sessionId);
  }

  // --- upload queue (F5) ---

  /** Completed sessions whose files are not yet confirmed in storage and whose backoff passed. */
  sessionsToUpload(nowIso: string, limit = 5): LocalSessionRow[] {
    return this.all<LocalSessionRow>(
      `select * from local_sessions
       where status = 'completed' and sync_status = 'pending'
         and (upload_next_at is null or upload_next_at <= ?)
       order by completed_at limit ?`,
      nowIso,
      limit,
    );
  }

  setFileUploadStatus(ids: string[], status: 'pending' | 'uploaded' | 'deleted') {
    const stmt = this.db.prepare('update local_files set upload_status = ? where id = ?');
    for (const id of ids) stmt.run(status, id);
  }

  markUploadFailed(id: string, error: string, nextAtIso: string) {
    this.run(
      `update local_sessions set upload_attempts = upload_attempts + 1, upload_error = ?,
         upload_next_at = ?, updated_at = ? where id = ?`,
      error.slice(0, 500),
      nextAtIso,
      now(),
      id,
    );
  }

  /** `atIso`: the upload queue's clock, which also decides when retention is over. */
  markSessionUploaded(id: string, atIso: string = now()) {
    this.run(
      `update local_sessions set sync_status = 'uploaded', uploaded_at = ?, upload_error = null,
         upload_next_at = null, updated_at = ? where id = ?`,
      atIso,
      now(),
      id,
    );
  }

  /** Uploaded sessions whose local copy is older than the retention window. */
  sessionsToPurge(beforeIso: string, limit = 20): LocalSessionRow[] {
    return this.all<LocalSessionRow>(
      `select * from local_sessions where sync_status = 'uploaded' and uploaded_at <= ?
       order by uploaded_at limit ?`,
      beforeIso,
      limit,
    );
  }

  markSessionPurged(id: string) {
    this.run(
      `update local_sessions set sync_status = 'purged', updated_at = ? where id = ?`,
      now(),
      id,
    );
  }

  resetUploadBackoff() {
    this.run(`update local_sessions set upload_next_at = null where sync_status = 'pending'`);
  }

  uploadSummary(): { pending: number; failing: number; lastError: string | null } {
    const row = this.get<{ pending: number; failing: number | null; err: string | null }>(
      `select count(*) as pending,
         sum(case when upload_attempts > 0 then 1 else 0 end) as failing,
         max(upload_error) as err
       from local_sessions where status = 'completed' and sync_status = 'pending'`,
    );
    return {
      pending: row?.pending ?? 0,
      failing: row?.failing ?? 0,
      lastError: row?.err ?? null,
    };
  }

  // --- print jobs ---

  addPrintJob(j: { sessionId: string | null; sheets: number; printer: string; filePath: string }) {
    const id = createId();
    this.run(
      `insert into print_jobs (id, session_id, sheets, printer, status, file_path, created_at, updated_at)
       values (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id,
      j.sessionId,
      j.sheets,
      j.printer,
      j.filePath,
      now(),
      now(),
    );
    return this.printJob(id)!;
  }

  updatePrintJob(
    id: string,
    patch: { status: PrintJobRow['status']; osJobId?: string | null; error?: string | null },
  ) {
    this.run(
      'update print_jobs set status = ?, os_job_id = coalesce(?, os_job_id), error = ?, updated_at = ? where id = ?',
      patch.status,
      patch.osJobId ?? null,
      patch.error ?? null,
      now(),
      id,
    );
    return this.printJob(id)!;
  }

  printJob(id: string): PrintJobRow | undefined {
    return this.get<PrintJobRow>('select * from print_jobs where id = ?', id);
  }

  printJobs(limit = 20): PrintJobRow[] {
    return this.all<PrintJobRow>(
      'select * from print_jobs order by created_at desc limit ?',
      limit,
    );
  }

  /** Sheets successfully sent to a printer (paper/ribbon estimate). */
  printedSheets(): number {
    return (
      this.get<{ n: number | null }>(
        `select sum(sheets) as n from print_jobs where status = 'done'`,
      )?.n ?? 0
    );
  }

  // --- outbox ---

  enqueue(kind: OutboxRow['kind'], payload: unknown, id: string = createId()) {
    const ts = now();
    this.run(
      'insert into outbox (id, kind, payload, created_at, next_attempt_at) values (?, ?, ?, ?, ?) on conflict(id) do nothing',
      id,
      kind,
      JSON.stringify(payload),
      ts,
      ts,
    );
    return id;
  }

  /** Records a device_events row to send to the API (kept until the API confirms). */
  event(e: DeviceEventInput) {
    // Late callbacks (sockets closing during shutdown) after close(): nothing to record.
    if (this.closed) return null;
    return this.enqueue('device_event', {
      level: e.level,
      kind: e.kind,
      message: e.message ?? null,
      data: e.data ?? null,
      occurredAt: now(),
    });
  }

  dueOutbox(limit = 100): OutboxRow[] {
    return this.all<OutboxRow>(
      'select * from outbox where next_attempt_at <= ? order by created_at limit ?',
      now(),
      limit,
    );
  }

  resetOutboxBackoff() {
    this.run('update outbox set next_attempt_at = ? where next_attempt_at > ?', now(), now());
  }

  outboxCount(): number {
    return this.get<{ n: number }>('select count(*) as n from outbox')!.n;
  }

  ackOutbox(ids: string[]) {
    const stmt = this.db.prepare('delete from outbox where id = ?');
    for (const id of ids) stmt.run(id);
  }

  failOutbox(ids: string[], error: string) {
    const rows = ids
      .map((id) => this.get<OutboxRow>('select * from outbox where id = ?', id))
      .filter(Boolean) as OutboxRow[];
    for (const row of rows) {
      const attempts = row.attempts + 1;
      // 10 s, 20 s, 40 s … capped at 10 minutes.
      const delay = Math.min(600_000, 10_000 * 2 ** Math.min(attempts - 1, 6));
      this.run(
        'update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?',
        attempts,
        new Date(Date.now() + delay).toISOString(),
        error.slice(0, 500),
        row.id,
      );
    }
  }

  // --- payments (F4) ---

  /** Paid while offline (voucher validated locally / cash) or payment reference. */
  /**
   * The kiosk dropped a session before it was paid (buyer went back / idle on Payment).
   * Paid sessions are never touched: they may need a refund or a resume.
   */
  abandonSession(id: string): boolean {
    const res = this.run(
      `update local_sessions set status = 'abandoned', updated_at = ?
       where id = ? and status = 'capturing' and payment_method is null`,
      now(),
      id,
    );
    return Number(res.changes) > 0;
  }

  setSessionPayment(
    id: string,
    patch: { method: string; paymentId?: string | null; offline: boolean },
  ) {
    this.run(
      `update local_sessions set payment_method = ?, payment_id = coalesce(?, payment_id),
         offline = max(offline, ?), updated_at = ? where id = ?`,
      patch.method,
      patch.paymentId ?? null,
      patch.offline ? 1 : 0,
      now(),
      id,
    );
  }

  /**
   * Replaces the synced voucher list of a booth. Local usages that the API does not know yet
   * (synced = 0) are kept, also for vouchers missing from the new list.
   */
  replaceVouchers(
    boothId: string,
    list: {
      codeHash: string;
      valueType: 'full' | 'amount';
      value: number;
      expiresAt: string | null;
      usedAt: string | null;
    }[],
  ) {
    this.db.exec('begin');
    try {
      this.run(
        'delete from local_vouchers where booth_id = ? and (used_at is null or synced = 1)',
        boothId,
      );
      const stmt = this.db.prepare(
        `insert into local_vouchers (code_hash, booth_id, value_type, value, expires_at, remote_used_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(booth_id, code_hash) do update set value_type = excluded.value_type,
           value = excluded.value, expires_at = excluded.expires_at,
           remote_used_at = excluded.remote_used_at`,
      );
      for (const v of list) {
        stmt.run(v.codeHash, boothId, v.valueType, v.value, v.expiresAt, v.usedAt);
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  voucher(boothId: string, codeHash: string): LocalVoucherRow | undefined {
    return this.get<LocalVoucherRow>(
      'select * from local_vouchers where booth_id = ? and code_hash = ?',
      boothId,
      codeHash,
    );
  }

  voucherCount(boothId: string): number {
    return this.get<{ n: number }>(
      'select count(*) as n from local_vouchers where booth_id = ?',
      boothId,
    )!.n;
  }

  /** Marks a voucher used by this device. Returns false when it was already used. */
  useVoucher(
    boothId: string,
    codeHash: string,
    sessionId: string,
    usedAt: string,
    synced: boolean,
  ): boolean {
    const res = this.run(
      `update local_vouchers set used_at = ?, used_session_id = ?, synced = ?
       where booth_id = ? and code_hash = ? and (used_at is null or used_session_id = ?)`,
      usedAt,
      sessionId,
      synced ? 1 : 0,
      boothId,
      codeHash,
      sessionId,
    );
    return Number(res.changes) > 0;
  }

  markVoucherSynced(boothId: string, codeHash: string) {
    this.run(
      'update local_vouchers set synced = 1 where booth_id = ? and code_hash = ?',
      boothId,
      codeHash,
    );
  }

  addCashApproval(a: {
    id: string;
    sessionId: string;
    amount: number;
    approvedAt: string;
    offline: boolean;
  }) {
    this.run(
      'insert into cash_approvals (id, session_id, amount, approved_at, offline) values (?, ?, ?, ?, ?) on conflict(id) do nothing',
      a.id,
      a.sessionId,
      a.amount,
      a.approvedAt,
      a.offline ? 1 : 0,
    );
  }

  pendingOutboxByKind(): Record<string, number> {
    const rows = this.all<{ kind: string; n: number }>(
      'select kind, count(*) as n from outbox group by kind',
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  // --- camera pairings ---

  addCameraPairing(p: { name: string; platform: string; tokenHash: string }): CameraPairingRow {
    const id = createId();
    this.run(
      'insert into camera_pairings (id, name, platform, token_hash, created_at) values (?, ?, ?, ?, ?)',
      id,
      p.name,
      p.platform,
      p.tokenHash,
      now(),
    );
    return this.get<CameraPairingRow>('select * from camera_pairings where id = ?', id)!;
  }

  cameraByTokenHash(tokenHash: string): CameraPairingRow | undefined {
    return this.get<CameraPairingRow>(
      'select * from camera_pairings where token_hash = ? and revoked_at is null',
      tokenHash,
    );
  }

  cameraPairings(): CameraPairingRow[] {
    return this.all<CameraPairingRow>(
      'select * from camera_pairings where revoked_at is null order by created_at desc',
    );
  }

  touchCamera(id: string) {
    this.run('update camera_pairings set last_seen_at = ? where id = ?', now(), id);
  }

  revokeCamera(id: string) {
    this.run(
      'update camera_pairings set revoked_at = ? where id = ? and revoked_at is null',
      now(),
      id,
    );
  }
}
