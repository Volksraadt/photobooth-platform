import {
  getBooth,
  listBoothSessions,
  listRefundCandidates,
  listUploadJobsForSessions,
} from '@pb/db';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  EmptyState,
} from '@pb/ui';
import Link from 'next/link';
import { ReceiptIcon } from '@/components/icons';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { formatInZone } from '@/lib/timezones';
import { asUser, requireOrg } from '@/lib/org';
import { UploadCell } from '@/components/session-upload';

const METHOD: Record<string, string> = {
  qris: 'QRIS',
  voucher: 'Voucher',
  cash: 'Tunai',
  free: 'Gratis',
};
const STATUS: Record<string, string> = {
  started: 'dimulai',
  paid: 'lunas',
  capturing: 'berfoto',
  completed: 'selesai',
  abandoned: 'ditinggal',
  failed: 'gagal',
};
const idr = (n: number) => `Rp${n.toLocaleString('id-ID')}`;

/** Transactions of one booth (F4 basics; full sales recap is F6). */
export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ boothId: string }>;
}) {
  const { boothId } = await params;
  const { user, org } = await requireOrg();
  const data = await asUser(user, async (tx) => {
    const row = await getBooth(tx, boothId);
    if (!row) return null;
    const [sessions, refunds] = await Promise.all([
      listBoothSessions(tx, boothId, 100),
      listRefundCandidates(tx, org.id),
    ]);
    const jobs = await listUploadJobsForSessions(
      tx,
      sessions.map((x) => x.id),
    );
    return {
      booth: row.booth,
      sessions,
      jobs,
      refunds: refunds.filter((r) => r.boothId === boothId),
    };
  });
  if (!data) notFound();
  const { booth, sessions, refunds, jobs } = data;
  const tz = booth.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href={`/booths/${boothId}`}>{booth.name}</BackLink>}
        title="Transaksi"
        description="100 sesi terakhir. Sesi dari booth yang sedang offline muncul setelah booth online lagi."
      />

      {refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kandidat refund</CardTitle>
            <CardDescription>
              QRIS lunas setelah kedaluwarsa/dibatalkan. Refund manual dari dashboard Midtrans.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded border text-sm" data-testid="booth-refunds">
              {refunds.map((r) => (
                <li key={r.id} className="flex justify-between p-2">
                  <span>
                    Sesi <b>{r.sessionCode}</b> · {idr(r.amount)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.paidAt ? formatInZone(r.paidAt, tz) : ''} · order {r.orderId}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          {sessions.length === 0 ? (
            <EmptyState size="compact" icon={<ReceiptIcon />} title="Belum ada sesi." />
          ) : (
            <table className="data-table w-full text-sm" data-testid="session-list">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Kode</th>
                  <th>Mulai</th>
                  <th>Metode</th>
                  <th className="text-right">Kotor</th>
                  <th className="text-right">Fee</th>
                  <th className="text-right">Bersih</th>
                  <th>Status</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sessions.map((s) => (
                  <tr key={s.id} data-testid={`session-${s.code}`}>
                    <td className="py-1 font-mono">
                      <Link
                        href={`/transactions/${s.id}`}
                        className="underline"
                        data-testid={`session-link-${s.code}`}
                      >
                        {s.code}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{formatInZone(s.startedAt, tz)}</td>
                    <td>
                      {s.paymentMethod ? METHOD[s.paymentMethod] : '—'}
                      {s.offline && (
                        <span className="ml-1 rounded-full bg-warning-soft px-2 text-xs font-medium text-warning">
                          offline
                        </span>
                      )}
                    </td>
                    <td className="text-right">{idr(s.grossAmount)}</td>
                    <td className="text-right">{idr(s.feeAmount)}</td>
                    <td className="text-right">{idr(s.netAmount)}</td>
                    <td>{STATUS[s.status] ?? s.status}</td>
                    <td className="whitespace-nowrap" data-testid={`upload-${s.code}`}>
                      <UploadCell session={s} jobs={jobs.filter((j) => j.sessionId === s.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
