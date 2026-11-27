import { deviceConnectivity, listOrgDevices, listUploadQueue, type Connectivity } from '@pb/db';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  EmptyState,
  Badge,
  Button,
} from '@pb/ui';
import Link from 'next/link';
import { MonitorIcon } from '@/components/icons';
import { RetryUploadButton } from '@/app/(app)/booths/[boothId]/transactions/retry-button';
import { JOB_ERROR_TEXT } from '@/lib/upload-status';
import { agoText, formatDateTime, nowMs } from '@/lib/format';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { asUser, requireOrg } from '@/lib/org';
import { revokeDeviceFromListAction } from './actions';
import { PaperForm } from './paper-form';

const CONNECTIVITY: Record<
  Connectivity,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'neutral' }
> = {
  online: { label: 'online', variant: 'success' },
  stale: { label: 'tidak responsif', variant: 'warning' },
  offline: { label: 'offline', variant: 'destructive' },
  revoked: { label: 'dicabut', variant: 'neutral' },
  never: { label: 'belum pernah terhubung', variant: 'neutral' },
};
const COMPONENT: Record<string, string> = {
  ok: 'baik',
  warning: 'peringatan',
  error: 'error',
  disconnected: 'terputus',
  unknown: 'belum diketahui',
};

/** Device status (heartbeat), paper counter, upload queue. Offline = silent for more than 5 minutes. */
export default async function DevicesPage() {
  const { user, org } = await requireOrg();
  const canEdit = org.role !== 'operator';
  const { devices, queue, now } = await asUser(user, async (tx) => ({
    devices: await listOrgDevices(tx, org.id),
    queue: await listUploadQueue(tx, org.id),
    now: nowMs(),
  }));
  const date = new Date(now);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Perangkat"
        description={
          <>
            Perangkat dianggap <b>offline</b> bila tidak memberi kabar lebih dari 5 menit. Untuk
            memasang perangkat baru, buka{' '}
            <Link href="/booths" className="underline">
              halaman booth
            </Link>{' '}
            lalu masukkan kode 6 digit yang tampil di Kiosk.
          </>
        }
      />

      {devices.length === 0 ? (
        <EmptyState
          icon={<MonitorIcon />}
          title="Belum ada perangkat."
          description="Buka Kiosk di laptop booth, lalu masukkan kode 6 digit yang tampil di halaman booth."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/booths">Ke halaman booth</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4" data-testid="device-cards">
          {devices.map((d) => {
            const c = deviceConnectivity(d, date);
            const tz = d.boothTimezone ?? org.timezone;
            const behind =
              d.lastConfigVersion != null &&
              d.activeConfigVersion != null &&
              d.lastConfigVersion < d.activeConfigVersion;
            const pending = (d.outboxPending ?? 0) + (d.uploadsPending ?? 0);
            return (
              <Card key={d.id} data-testid={`device-card-${d.id}`}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {d.name}
                    <Badge
                      variant={CONNECTIVITY[c].variant}
                      dot
                      data-testid={`device-status-${d.id}`}
                      data-status={c}
                    >
                      {CONNECTIVITY[c].label}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {d.boothName ?? 'tanpa booth'} · terakhir memberi kabar{' '}
                    {d.lastHeartbeatAt
                      ? `${agoText(d.lastHeartbeatAt, now)} (${formatDateTime(d.lastHeartbeatAt, tz)})`
                      : 'belum pernah'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Versi aplikasi</dt>
                      <dd>{d.appVersion ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Versi desain di perangkat</dt>
                      <dd className={behind ? 'text-warning' : ''}>
                        {!d.lastConfigVersion
                          ? 'Belum menerima desain'
                          : behind
                            ? `v${d.lastConfigVersion} (terbaru v${d.activeConfigVersion}, belum diterima)`
                            : `v${d.lastConfigVersion} (terbaru)`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Kamera</dt>
                      <dd>{COMPONENT[d.cameraStatus]}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Printer</dt>
                      <dd>{COMPONENT[d.printerStatus]}</dd>
                    </div>
                  </dl>
                  {pending > 0 && (
                    <p className="text-warning" data-testid={`unsynced-${d.id}`}>
                      Belum tersinkron: {d.outboxPending ?? 0} catatan dan {d.uploadsPending ?? 0}{' '}
                      sesi menunggu unggah (data terakhir dilaporkan booth).
                    </p>
                  )}
                  <div data-testid={`paper-${d.id}`}>
                    Lembar tercetak: <b>{d.sheetsSinceRoll}</b> sejak roll dipasang ({d.sheetsTotal}{' '}
                    total).{' '}
                    {d.sheetsRemaining !== null ? (
                      <span
                        className={d.sheetsRemaining < 50 ? 'font-medium text-destructive' : ''}
                      >
                        Perkiraan sisa: <b>{d.sheetsRemaining}</b> lembar
                        {d.sheetsRemaining < 50 ? ' (segera ganti roll)' : ''}.
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        Isi kapasitas roll untuk melihat perkiraan sisa kertas.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    {canEdit && !d.revokedAt ? (
                      <PaperForm deviceId={d.id} capacity={d.paperCapacity} />
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/devices/${d.id}`}
                        className="rounded border px-3 py-1.5 text-sm hover:bg-muted"
                        data-testid={`device-log-${d.id}`}
                      >
                        Log kejadian
                      </Link>
                      {canEdit && !d.revokedAt && (
                        <form action={revokeDeviceFromListAction}>
                          <input type="hidden" name="deviceId" value={d.id} />
                          <ConfirmSubmit
                            label="Cabut perangkat"
                            confirmLabel="Ya, cabut"
                            message={`Cabut "${d.name}"? Kiosk di perangkat ini langsung berhenti dan harus dipasang ulang dengan kode baru.`}
                            testId={`revoke-${d.id}`}
                          />
                        </form>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Antrian upload</CardTitle>
          <CardDescription>
            Sesi yang filenya belum sampai di Google Drive: menunggu, diulang otomatis, atau gagal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="queue-empty">
              Tidak ada antrian. Semua sesi yang diterima sudah terkirim.
            </p>
          ) : (
            <ul className="divide-y rounded border text-sm" data-testid="upload-queue">
              {queue.map((q) => (
                <li key={q.job.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                  <div>
                    <Link href={`/transactions/${q.sessionId}`} className="font-mono underline">
                      {q.code}
                    </Link>{' '}
                    <span className="text-muted-foreground">
                      · {q.boothName} ·{' '}
                      {q.job.target === 'storage' ? 'memproses file' : 'unggah ke Drive'}
                    </span>
                    <div
                      className={
                        q.job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      }
                    >
                      {q.job.status === 'failed'
                        ? ((q.job.errorCode && JOB_ERROR_TEXT[q.job.errorCode]) ??
                          q.job.lastError ??
                          'Gagal')
                        : q.job.attempts > 0
                          ? `Mencoba ulang (${q.job.attempts}×): ${q.job.lastError ?? ''}`
                          : 'Menunggu'}
                    </div>
                  </div>
                  {q.job.status === 'failed' && (
                    <RetryUploadButton sessionId={q.sessionId} code={q.code} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
