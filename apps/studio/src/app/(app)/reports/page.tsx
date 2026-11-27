import {
  getReport,
  listBooths,
  listOrgDevices,
  listRefundCandidates,
  listUnsyncedDevices,
} from '@pb/db';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  buttonVariants,
  EmptyState,
} from '@pb/ui';
import Link from 'next/link';
import { ChartIcon } from '@/components/icons';
import { BarChart } from '@/components/bar-chart';
import { RangeFilter } from '@/components/range-filter';
import { getEntitlements, hasFeature, recapDays } from '@/lib/entitlements';
import { formatDateTime, formatDay, formatShortDay, idr, METHOD_LABEL } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';
import { resolveRange, todayIn } from '@/lib/range';

type SP = { from?: string; to?: string; booth?: string; device?: string };

/** Sales recap. Every date and hour is in the booth's own timezone (PRD §12.1). */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { user, org } = await requireOrg();
  const ent = await getEntitlements(user, org.id);
  const today = todayIn(org.timezone);
  const range = resolveRange(sp, today, recapDays(ent));

  const data = await asUser(user, async (tx) => {
    const [boothList, deviceList] = await Promise.all([
      listBooths(tx, org.id),
      listOrgDevices(tx, org.id),
    ]);
    const boothId = boothList.some((b) => b.id === sp.booth) ? sp.booth! : null;
    const deviceId = deviceList.some((d) => d.id === sp.device) ? sp.device! : null;
    const [report, unsynced, refunds] = await Promise.all([
      getReport(tx, { orgId: org.id, from: range.from, to: range.to, boothId, deviceId }),
      listUnsyncedDevices(tx, org.id),
      listRefundCandidates(tx, org.id),
    ]);
    return { boothList, deviceList, boothId, deviceId, report, unsynced, refunds };
  });
  const { boothList, deviceList, boothId, deviceId, report, unsynced, refunds } = data;
  const t = report.totals;
  const canExport = hasFeature(ent, 'export');
  const query = new URLSearchParams({ from: range.from, to: range.to });
  if (boothId) query.set('booth', boothId);
  if (deviceId) query.set('device', deviceId);
  const refundsShown = refunds.filter((r) => !boothId || r.boothId === boothId);
  const dayStep = Math.max(1, Math.ceil(report.days.length / 10));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rekap penjualan"
        description={
          <span data-testid="report-range">
            {formatDay(range.from)} – {formatDay(range.to)} · tanggal dan jam mengikuti zona waktu
            tiap booth
          </span>
        }
        actions={
          <>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={`/transactions?${query}`}
            >
              Lihat daftar transaksi →
            </Link>
            {canExport ? (
              <>
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={`/api/export/transactions?${query}&format=csv`}
                  data-testid="export-csv"
                  title="Daftar transaksi pada rentang dan filter ini (waktu mengikuti zona booth)"
                >
                  Unduh CSV
                </a>
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={`/api/export/transactions?${query}&format=xlsx`}
                  data-testid="export-xlsx"
                  title="Daftar transaksi pada rentang dan filter ini (waktu mengikuti zona booth)"
                >
                  Unduh Excel
                </a>
              </>
            ) : (
              <span className="text-xs text-muted-foreground" data-testid="export-locked">
                Ekspor CSV/Excel di paket Pro dan Business.{' '}
                <Link href="/billing" className="underline">
                  Lihat paket
                </Link>
              </span>
            )}
          </>
        }
      />

      {range.clamped && (
        <Alert data-testid="recap-limit">
          Paket {ent?.planName} menampilkan rekap {recapDays(ent)} hari terakhir. Upgrade paket
          untuk riwayat lengkap.
        </Alert>
      )}
      {unsynced.length > 0 && (
        <Alert variant="destructive" data-testid="unsynced-warning">
          Data belum tersinkron dari{' '}
          {unsynced
            .map((d) => `${d.name} (${(d.outboxPending ?? 0) + (d.uploadsPending ?? 0)} item)`)
            .join(', ')}
          . Sesi yang dibuat saat offline akan masuk ke rekap setelah booth online lagi, jadi angka
          di bawah bisa lebih kecil dari kenyataan.
        </Alert>
      )}

      <RangeFilter
        basePath="/reports"
        testId="report-filter"
        from={range.from}
        to={range.to}
        today={today}
        booths={boothList.map((b) => ({ id: b.id, name: b.name }))}
        devices={deviceList.map((d) => ({ id: d.id, name: d.name, boothName: d.boothName }))}
        boothId={boothId}
        deviceId={deviceId}
      />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="report-cards">
        {[
          ['Pendapatan kotor', idr(t.gross), 'gross'],
          ['Pendapatan bersih', idr(t.net), 'net'],
          ['Jumlah sesi', String(t.sessions), 'sessions'],
          ['Rata-rata / sesi', idr(t.averageGross), 'average'],
          ['Cetak tambahan', String(t.extraPrints), 'extra-prints'],
          ['Lembar tercetak', String(t.printedSheets), 'printed'],
        ].map(([label, value, key]) => (
          <Card key={key}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-xl font-semibold" data-testid={`card-${key}`}>
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        Bersih = kotor − fee provider ({idr(t.fee)}). Sesi offline: {t.offlineSessions}.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per hari</CardTitle>
            <CardDescription>Pendapatan kotor per tanggal booth.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              testId="chart-days"
              showEvery={dayStep}
              data={report.days.map((d) => ({
                label: formatShortDay(d.day),
                value: d.gross,
                sub: `${d.sessions} sesi`,
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per jam</CardTitle>
            <CardDescription>Jumlah sesi menurut jam di booth (0–23).</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart
              testId="chart-hours"
              money={false}
              unit="sesi"
              showEvery={3}
              data={report.hours.map((h) => ({
                label: `${String(h.hour).padStart(2, '0')}.00`,
                value: h.sessions,
                sub: idr(h.gross),
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metode pembayaran</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="data-table w-full text-sm" data-testid="method-table">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Metode</th>
                  <th className="text-right">Sesi</th>
                  <th className="text-right">Kotor</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.methods.map((m) => (
                  <tr key={m.method} data-testid={`method-${m.method}`}>
                    <td className="py-1">{METHOD_LABEL[m.method]}</td>
                    <td className="text-right">{m.sessions}</td>
                    <td className="text-right">{idr(m.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Perbandingan booth</CardTitle>
          </CardHeader>
          <CardContent>
            {report.booths.length === 0 ? (
              <EmptyState size="compact" icon={<ChartIcon />} title="Belum ada penjualan." />
            ) : (
              <table className="data-table w-full text-sm" data-testid="booth-table">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Booth</th>
                    <th className="text-right">Sesi</th>
                    <th className="text-right">Kotor</th>
                    <th className="text-right">Bersih</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.booths.map((b) => (
                    <tr key={b.boothId}>
                      <td className="py-1">{b.name}</td>
                      <td className="text-right">{b.sessions}</td>
                      <td className="text-right">{idr(b.gross)}</td>
                      <td className="text-right">{idr(b.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Frame terlaris</CardTitle>
          </CardHeader>
          <CardContent>
            {report.frames.length === 0 ? (
              <EmptyState size="compact" icon={<ChartIcon />} title="Belum ada data." />
            ) : (
              <ol className="divide-y text-sm" data-testid="frame-list">
                {report.frames.map((f) => (
                  <li key={f.frameId} className="flex justify-between py-1">
                    <span>{f.name}</span>
                    <span className="text-muted-foreground">
                      {f.sessions} sesi · {idr(f.gross)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Filter populer</CardTitle>
          </CardHeader>
          <CardContent>
            {report.filters.length === 0 ? (
              <EmptyState size="compact" icon={<ChartIcon />} title="Belum ada data." />
            ) : (
              <ol className="divide-y text-sm" data-testid="filter-list">
                {report.filters.map((f) => (
                  <li key={f.filterId} className="flex justify-between py-1">
                    <span>{f.name}</span>
                    <span className="text-muted-foreground">{f.sessions} sesi</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="paid-late-card">
        <CardHeader>
          <CardTitle className="text-base">Perlu ditindaklanjuti (refund manual)</CardTitle>
          <CardDescription>
            QRIS yang lunas setelah kedaluwarsa/dibatalkan, atau sesi yang sudah dibayar lewat cara
            lain. Uang ada di akun Midtrans Anda; lakukan refund dari dashboard Midtrans.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {refundsShown.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada.</p>
          ) : (
            <ul className="divide-y rounded border text-sm" data-testid="paid-late-list">
              {refundsShown.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 p-2">
                  <span>
                    Sesi <b>{r.sessionCode}</b> · {idr(r.amount)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.paidAt ? formatDateTime(r.paidAt, org.timezone) : ''} · order {r.orderId}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
