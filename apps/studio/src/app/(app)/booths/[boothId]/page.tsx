import { boothSessionCount, getBooth, getOrgPlan, listConfigVersions, listDevices } from '@pb/db';
import { migrateBoothConfig } from '@pb/schema';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  Badge,
  EmptyState,
} from '@pb/ui';
import Link from 'next/link';
import { MonitorIcon } from '@/components/icons';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { idr, METHOD_LABEL } from '@/lib/format';
import { isPlatformAdmin } from '@/lib/entitlements';
import { asUser, requireOrg } from '@/lib/org';
import { timezoneLabel } from '@/lib/timezones';
import { revokeDeviceAction } from './actions';
import { BoothLifecycle, PairDeviceForm, PaymentForm, RollbackButton } from './booth-forms';
import { PagePreviews } from './page-previews';
import { SaveTemplateForm } from './save-template-form';

const ONLINE_MS = 2 * 60 * 1000;
const nowMs = () => Date.now();

function formatTime(d: Date | null, timezone: string): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(d);
}

export default async function BoothPage({ params }: { params: Promise<{ boothId: string }> }) {
  const { boothId } = await params;
  const { user, org } = await requireOrg();
  // RLS returns null for booths outside the user's orgs.
  const data = await asUser(user, async (tx) => {
    const row = await getBooth(tx, boothId);
    if (!row) return null;
    const [versions, devices, plan, sessionCount] = await Promise.all([
      listConfigVersions(tx, boothId),
      listDevices(tx, boothId),
      getOrgPlan(tx, row.booth.orgId),
      boothSessionCount(tx, boothId),
    ]);
    return { row, versions, devices, plan, sessionCount, now: nowMs() };
  });
  if (!data) notFound();
  const { row, versions, devices, plan, sessionCount, now } = data;
  const archived = row.booth.status !== 'active';
  const canEdit = org.role !== 'operator';
  const tz = row.booth.timezone;

  const config = row.draft?.config;
  // Older drafts are upgraded to the current schemaVersion first (as the editor does).
  const validation = config ? migrateBoothConfig(config) : null;
  const active = versions.find((v) => v.id === row.booth.activeConfigId);
  const activeDevices = devices.filter((d) => !d.revokedAt);
  const maxDevices = plan?.limits.maxDevicesPerBooth ?? null;

  return (
    <div className="space-y-6">
      {archived && (
        <Alert data-testid="booth-archived">
          Booth ini <b>diarsipkan</b>: tidak berjalan dan tidak bisa dipasangi perangkat. Pulihkan
          di bagian bawah halaman bila ingin memakainya lagi.
        </Alert>
      )}
      <PageHeader
        eyebrow={<BackLink href="/booths">Semua booth</BackLink>}
        title={row.booth.name}
        titleProps={{ 'data-testid': 'booth-name' }}
        description={
          <span className="flex flex-wrap items-center gap-2" data-testid="booth-status">
            {timezoneLabel(tz)} ·{' '}
            {active ? (
              <Badge variant="success" dot>
                Versi aktif v{active.version}
              </Badge>
            ) : (
              <Badge>Belum dipublikasikan</Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/booths/${boothId}/vouchers`} data-testid="open-vouchers">
                Voucher
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/booths/${boothId}/transactions`} data-testid="open-transactions">
                Transaksi
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/booths/${boothId}/editor`} data-testid="open-editor">
                {canEdit ? 'Buka editor' : 'Lihat desain'}
              </Link>
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Draft desain</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!config ? (
            <Alert variant="destructive">Draft tidak ditemukan.</Alert>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Stat
                  label="Artboard"
                  value={`${config.artboard.width}×${config.artboard.height}`}
                />
                <Stat label="Halaman" value={Object.keys(config.pages).length} />
                <Stat label="Frame" value={config.frames.length} />
                <Stat label="Filter" value={config.filters.length} />
              </dl>
              <dl
                className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3"
                data-testid="booth-pricing"
              >
                <Stat
                  label="Harga dasar"
                  value={
                    config.flow.eventMode ? 'Gratis (mode event)' : idr(config.pricing.basePrice)
                  }
                />
                <Stat label="Lembar termasuk" value={config.pricing.includedPrints} />
                <Stat
                  label="Cetak tambahan"
                  value={
                    config.pricing.extraPrintPrice === null
                      ? 'Tidak dijual'
                      : `${idr(config.pricing.extraPrintPrice)}/lembar`
                  }
                />
              </dl>
              {canEdit && (
                <p className="text-xs text-muted-foreground">
                  Harga dan alur diatur di{' '}
                  <Link href={`/booths/${boothId}/editor?panel=settings`} className="underline">
                    Editor → Atur
                  </Link>
                  .
                </p>
              )}
              {validation?.success ? (
                <Alert variant="success" data-testid="draft-valid">
                  Draft valid. Tekan <b>Publish</b> di editor agar perubahan tampil di booth.
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <ul className="list-disc pl-4">
                    {validation?.issues.map((i) => (
                      <li key={`${i.path}-${i.code}`}>{i.message}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {config && (
        <Card data-testid="payment-card">
          <CardHeader>
            <CardTitle className="text-base">Pembayaran</CardTitle>
            <CardDescription>
              Pilih cara pembeli membayar, atau matikan pembayaran untuk acara tertentu. Perubahan
              langsung berlaku di booth.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <PaymentForm
                boothId={boothId}
                methods={config.flow.paymentMethods}
                eventMode={config.flow.eventMode}
              />
            ) : (
              <p className="text-sm">
                {config.flow.eventMode
                  ? 'Mode event: tanpa pembayaran'
                  : config.flow.paymentMethods.map((m) => METHOD_LABEL[m] ?? m).join(', ')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {validation?.success && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pratinjau halaman</CardTitle>
          </CardHeader>
          <CardContent>
            <PagePreviews
              config={validation.config}
              boothName={row.booth.name}
              editorHref={`/booths/${boothId}/editor`}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Perangkat</CardTitle>
          <CardDescription>
            Buka Kiosk di laptop booth; Kiosk yang belum terpasang menampilkan kode 6 digit.
            {maxDevices !== null &&
              ` Paket ${plan?.name}: maksimal ${maxDevices} perangkat per booth.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {archived ? null : canEdit &&
            (maxDevices === null || activeDevices.length < maxDevices) ? (
            <PairDeviceForm boothId={boothId} />
          ) : (
            canEdit && (
              <p className="text-sm text-warning" data-testid="device-limit">
                Batas perangkat paket {plan?.name} tercapai. Cabut perangkat lama atau upgrade
                paket.
              </p>
            )
          )}
          {devices.length === 0 ? (
            <EmptyState size="compact" icon={<MonitorIcon />} title="Belum ada perangkat." />
          ) : (
            <ul className="divide-y rounded border text-sm" data-testid="device-list">
              {devices.map((d) => {
                const online =
                  !d.revokedAt &&
                  d.lastHeartbeatAt &&
                  now - d.lastHeartbeatAt.getTime() < ONLINE_MS;
                return (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                    data-testid={`device-${d.id}`}
                  >
                    <div>
                      <div className="font-medium">
                        {d.name}{' '}
                        <span className={online ? 'text-success' : 'text-muted-foreground'}>
                          {d.revokedAt ? '· dicabut' : online ? '· online' : '· offline'}
                        </span>
                      </div>
                      <div
                        className="text-xs text-muted-foreground"
                        data-testid="device-config-version"
                      >
                        Versi desain: {d.lastConfigVersion ? `v${d.lastConfigVersion}` : '—'} ·
                        Kabar terakhir: {formatTime(d.lastHeartbeatAt, tz)}
                      </div>
                    </div>
                    {canEdit && !d.revokedAt && (
                      <form action={revokeDeviceAction}>
                        <input type="hidden" name="boothId" value={boothId} />
                        <input type="hidden" name="deviceId" value={d.id} />
                        <ConfirmSubmit
                          label="Cabut"
                          confirmLabel="Ya, cabut"
                          message={`Cabut "${d.name}"? Kiosk di perangkat ini langsung berhenti dan harus dipasang ulang dengan kode baru.`}
                        />
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Riwayat versi</CardTitle>
          <CardDescription>
            Setiap publish membuat versi baru yang tidak bisa diubah.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <EmptyState size="compact" title="Belum ada versi yang dipublikasikan." />
          ) : (
            <ul className="divide-y rounded border text-sm" data-testid="version-list">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-2 p-3"
                  data-testid={`version-${v.version}`}
                >
                  <div>
                    <span className="font-medium">v{v.version}</span>{' '}
                    {v.id === row.booth.activeConfigId && (
                      <span className="rounded-full bg-success-soft px-2 text-xs font-medium text-success">
                        aktif
                      </span>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {formatTime(v.publishedAt, tz)}
                    </div>
                  </div>
                  {canEdit && v.id !== row.booth.activeConfigId && (
                    <RollbackButton boothId={boothId} version={v.version} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isPlatformAdmin(user) && validation?.success && (
        <SaveTemplateForm boothId={boothId} boothName={row.booth.name} />
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Arsip dan hapus</CardTitle>
          </CardHeader>
          <CardContent>
            <BoothLifecycle
              boothId={boothId}
              boothName={row.booth.name}
              archived={archived}
              sessionCount={sessionCount}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}
