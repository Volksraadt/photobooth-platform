import { getSessionDetail } from '@pb/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@pb/ui';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { UploadCell } from '@/components/session-upload';
import { formatDateTime, idr, METHOD_LABEL } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';

const OUTPUT_LABEL: Record<string, string> = {
  original: 'Foto asli',
  mirrored: 'Mirror',
  filtered: 'Berfilter',
  composite: 'Strip final',
  gif: 'GIF',
  video: 'Video',
  clip: 'Klip',
};
const PAYMENT_STATUS: Record<string, string> = {
  pending: 'menunggu',
  paid: 'lunas',
  expired: 'kedaluwarsa',
  canceled: 'dibatalkan',
  failed: 'gagal',
  paid_late: 'lunas terlambat (refund manual)',
};

/** One session: money, thumbnail of the printed strip, files, upload and print state. */
export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const { user, org } = await requireOrg();
  const d = await asUser(user, (tx) => getSessionDetail(tx, org.id, sessionId));
  if (!d) notFound();
  const s = d.session;
  const tz = d.timezone;
  const counts = d.outputs.reduce<Record<string, number>>((acc, o) => {
    acc[o.kind] = (acc[o.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href="/transactions">Transaksi</BackLink>}
        title={
          <>
            Sesi{' '}
            <span className="font-mono" data-testid="session-code">
              {s.code}
            </span>
          </>
        }
        description={
          <>
            {d.boothName} · {d.deviceName ?? 'perangkat tidak diketahui'} · mulai{' '}
            {formatDateTime(s.startedAt, tz)} ({tz})
            {s.completedAt ? ` · selesai ${formatDateTime(s.completedAt, tz)}` : ''}
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        {/* Narrow screens: payment and files first, the (tall) strip below them. */}
        <Card className="max-md:order-last">
          <CardContent className="pt-4">
            {d.compositePath ? (
              <img
                src={`/api/session-thumbnail/${s.id}`}
                alt={`Strip sesi ${s.code}`}
                className="mx-auto w-full max-w-[200px] rounded border md:max-w-none"
                loading="lazy"
                data-testid="session-thumbnail"
              />
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="no-thumbnail">
                Pratinjau tidak tersedia (belum terunggah atau sudah dihapus dari penyimpanan
                platform; file ada di Google Drive).
              </p>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pembayaran</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                Metode: <b>{s.paymentMethod ? METHOD_LABEL[s.paymentMethod] : 'belum dibayar'}</b>
                {s.offline && ' · dibayar saat offline'}
              </div>
              <div>
                Kotor {idr(s.grossAmount)} · fee {idr(s.feeAmount)} · bersih{' '}
                <b>{idr(s.netAmount)}</b>
                {s.extraPrints > 0 ? ` · cetak tambahan ${s.extraPrints}` : ''}
              </div>
              {d.voucher && (
                <div>
                  Voucher ····{d.voucher.codeLast4} (
                  {d.voucher.valueType === 'full' ? 'penuh' : idr(d.voucher.value)})
                </div>
              )}
              {d.cash.map((c, i) => (
                <div key={i}>
                  Tunai {idr(c.amount)} disetujui {formatDateTime(c.approvedAt, tz)}
                </div>
              ))}
              {d.payments.length > 0 && (
                <ul className="divide-y rounded border">
                  {d.payments.map((p) => (
                    <li key={p.id} className="flex justify-between gap-2 p-2 text-xs">
                      <span>
                        QRIS {idr(p.amount)} · {PAYMENT_STATUS[p.status] ?? p.status}
                      </span>
                      <span className="text-muted-foreground">order {p.orderId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">File dan unggahan</CardTitle>
              <CardDescription>
                Status pengiriman ke Google Drive owner dan isi tiap subfolder.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <UploadCell
                session={{
                  id: s.id,
                  code: s.code,
                  status: s.status,
                  filesCompleteAt: s.filesCompleteAt,
                  driveFolderUrl: s.driveFolderUrl,
                }}
                jobs={d.jobs}
              />
              {d.outputs.length > 0 && (
                <ul className="flex flex-wrap gap-2" data-testid="output-kinds">
                  {Object.entries(counts).map(([kind, n]) => (
                    <li key={kind} className="rounded border px-2 py-0.5 text-xs">
                      {OUTPUT_LABEL[kind] ?? kind}: {n}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cetak</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {d.printJobs.length === 0 ? (
                <p className="text-muted-foreground">Belum ada catatan cetak.</p>
              ) : (
                <ul className="divide-y rounded border" data-testid="print-list">
                  {d.printJobs.map((p) => (
                    <li key={p.id} className="flex justify-between p-2">
                      <span>
                        {p.sheets} lembar · {p.status === 'done' ? 'tercetak' : p.status}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(p.occurredAt, tz)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
