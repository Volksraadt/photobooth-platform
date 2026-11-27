import { listBooths, listOrgDevices, listTransactions } from '@pb/db';
import { Alert, Card, CardContent, PageHeader, buttonVariants, EmptyState } from '@pb/ui';
import Link from 'next/link';
import { ReceiptIcon } from '@/components/icons';
import { RangeFilter } from '@/components/range-filter';
import { UploadCell } from '@/components/session-upload';
import { getEntitlements, recapDays } from '@/lib/entitlements';
import { formatDateTime, formatDay, idr, METHOD_LABEL } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';
import { resolveRange, todayIn } from '@/lib/range';

const PAGE = 50;
const STATUS: Record<string, string> = {
  started: 'dimulai',
  paid: 'lunas',
  capturing: 'berfoto',
  completed: 'selesai',
  abandoned: 'ditinggal',
  failed: 'gagal',
};

type SP = { from?: string; to?: string; booth?: string; device?: string; page?: string };

/** All transactions of the org with upload/print state; times in each booth's own zone. */
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { user, org } = await requireOrg();
  const ent = await getEntitlements(user, org.id);
  const today = todayIn(org.timezone);
  const range = resolveRange(sp, today, recapDays(ent));
  const page = Math.max(1, Math.floor(Number(sp.page ?? '1')) || 1);

  const data = await asUser(user, async (tx) => {
    const [boothList, deviceList] = await Promise.all([
      listBooths(tx, org.id),
      listOrgDevices(tx, org.id),
    ]);
    const boothId = boothList.some((b) => b.id === sp.booth) ? sp.booth! : null;
    const deviceId = deviceList.some((d) => d.id === sp.device) ? sp.device! : null;
    const list = await listTransactions(tx, {
      orgId: org.id,
      from: range.from,
      to: range.to,
      boothId,
      deviceId,
      limit: PAGE,
      offset: (page - 1) * PAGE,
    });
    return { boothList, deviceList, boothId, deviceId, list };
  });
  const { boothList, deviceList, boothId, deviceId, list } = data;
  const pages = Math.max(1, Math.ceil(list.total / PAGE));
  const link = (p: number) => {
    const q = new URLSearchParams({ from: range.from, to: range.to, page: String(p) });
    if (boothId) q.set('booth', boothId);
    if (deviceId) q.set('device', deviceId);
    return `/transactions?${q}`;
  };
  const rekapQuery = new URLSearchParams({ from: range.from, to: range.to });
  if (boothId) rekapQuery.set('booth', boothId);
  if (deviceId) rekapQuery.set('device', deviceId);
  const rekapLink = `/reports?${rekapQuery}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transaksi"
        description={
          <span>
            {formatDay(range.from)} – {formatDay(range.to)} · {list.total} sesi. Waktu mengikuti
            zona waktu booth. Sesi dari booth yang offline muncul setelah booth online lagi.
          </span>
        }
        actions={
          <>
            <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href={rekapLink}>
              Lihat rekap →
            </Link>
          </>
        }
      />
      {range.clamped && (
        <Alert>
          Paket {ent?.planName} menampilkan {recapDays(ent)} hari terakhir.
        </Alert>
      )}
      <RangeFilter
        basePath="/transactions"
        from={range.from}
        to={range.to}
        today={today}
        booths={boothList.map((b) => ({ id: b.id, name: b.name }))}
        devices={deviceList.map((d) => ({ id: d.id, name: d.name, boothName: d.boothName }))}
        boothId={boothId}
        deviceId={deviceId}
      />

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {list.rows.length === 0 ? (
            <EmptyState
              size="compact"
              icon={<ReceiptIcon />}
              title="Tidak ada sesi pada rentang ini."
            />
          ) : (
            <>
              {/* Narrow screens: one card per session instead of a 9-column table. */}
              <ul className="divide-y md:hidden" data-testid="transaction-cards">
                {list.rows.map((s) => (
                  <li key={s.id} data-testid={`txn-card-${s.code}`} className="py-3 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/transactions/${s.id}`}
                        className="font-mono font-medium underline"
                      >
                        {s.code}
                      </Link>
                      <span className="font-medium">{idr(s.grossAmount)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.boothName} · {formatDateTime(s.startedAt, s.timezone)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span>
                        {s.paymentMethod ? METHOD_LABEL[s.paymentMethod] : '—'}
                        {s.offline && ' (offline)'}
                      </span>
                      <span>{STATUS[s.status] ?? s.status}</span>
                      <span>
                        {s.print
                          ? `${s.print.sheets}× ${s.print.status === 'done' ? 'tercetak' : s.print.status}`
                          : 'tanpa cetak'}
                      </span>
                      <UploadCell
                        session={{
                          id: s.id,
                          code: s.code,
                          status: s.status,
                          filesCompleteAt: null,
                          driveFolderUrl: s.driveFolderUrl,
                        }}
                        jobs={s.jobs}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <table
                className="data-table w-full text-sm max-md:hidden"
                data-testid="transaction-list"
              >
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Kode</th>
                    <th>Booth</th>
                    <th>Mulai</th>
                    <th>Metode</th>
                    <th className="text-right">Kotor</th>
                    <th className="text-right">Bersih</th>
                    <th>Status</th>
                    <th>Cetak</th>
                    <th>File</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {list.rows.map((s) => (
                    <tr key={s.id} data-testid={`txn-${s.code}`} className="align-top">
                      <td className="py-1 font-mono">
                        <Link href={`/transactions/${s.id}`} className="underline">
                          {s.code}
                        </Link>
                      </td>
                      <td>{s.boothName}</td>
                      <td className="whitespace-nowrap">
                        {formatDateTime(s.startedAt, s.timezone)}
                      </td>
                      <td>
                        {s.paymentMethod ? METHOD_LABEL[s.paymentMethod] : '—'}
                        {s.offline && (
                          <span className="ml-1 rounded-full bg-warning-soft px-2 text-xs font-medium text-warning">
                            offline
                          </span>
                        )}
                      </td>
                      <td className="text-right">{idr(s.grossAmount)}</td>
                      <td className="text-right">{idr(s.netAmount)}</td>
                      <td>{STATUS[s.status] ?? s.status}</td>
                      <td className="whitespace-nowrap">
                        {s.print
                          ? `${s.print.sheets}× ${s.print.status === 'done' ? 'tercetak' : s.print.status}`
                          : '—'}
                      </td>
                      <td className="whitespace-nowrap">
                        <UploadCell
                          session={{
                            id: s.id,
                            code: s.code,
                            status: s.status,
                            filesCompleteAt: null,
                            driveFolderUrl: s.driveFolderUrl,
                          }}
                          jobs={s.jobs}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              {page > 1 ? <Link href={link(page - 1)}>← Sebelumnya</Link> : <span />}
              <span className="text-muted-foreground">
                Halaman {page} dari {pages}
              </span>
              {page < pages ? <Link href={link(page + 1)}>Berikutnya →</Link> : <span />}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
