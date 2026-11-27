import {
  deviceConnectivity,
  getOrgPlan,
  getReport,
  listBooths,
  listOrgDevices,
  listRefundCandidates,
  listTemplates,
  listUploadQueue,
} from '@pb/db';
import { upgradeBoothConfig, type BoothConfig } from '@pb/schema';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  EmptyState,
  Badge,
} from '@pb/ui';
import Link from 'next/link';
import { CameraIcon, ChevronRightIcon } from '@/components/icons';
import { OrgOverview, type OverviewData } from '@/components/org-overview';
import { idr, nowMs } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';
import { addDays, todayIn } from '@/lib/range';
import { timezoneLabel } from '@/lib/timezones';
import { CreateBoothForm } from './create-booth-form';

export default async function BoothsPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const { deleted } = await searchParams;
  const { user, org } = await requireOrg();
  const now = nowMs();
  const today = todayIn(org.timezone, new Date(now));
  const { booths, templates, plan, overview, perBooth } = await asUser(user, async (tx) => {
    const [booths, templates, plan, todayReport, weekReport, devices, queue, refunds] =
      await Promise.all([
        listBooths(tx, org.id),
        listTemplates(tx),
        getOrgPlan(tx, org.id),
        getReport(tx, { orgId: org.id, from: today, to: today, boothId: null, deviceId: null }),
        getReport(tx, {
          orgId: org.id,
          from: addDays(today, -6),
          to: today,
          boothId: null,
          deviceId: null,
        }),
        listOrgDevices(tx, org.id),
        listUploadQueue(tx, org.id),
        listRefundCandidates(tx, org.id),
      ]);
    const overview: OverviewData = {
      today: { sessions: todayReport.totals.sessions, gross: todayReport.totals.gross },
      week: { sessions: weekReport.totals.sessions, gross: weekReport.totals.gross },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        boothName: d.boothName,
        connectivity: deviceConnectivity(d, new Date(now)),
        lastHeartbeatAt: d.lastHeartbeatAt,
      })),
      uploads: {
        failed: queue.filter((q) => q.job.status === 'failed').length,
        waiting: queue.filter((q) => q.job.status !== 'failed').length,
      },
      refunds: refunds.length,
      now,
    };
    // Per-booth line on the list: today's sales and devices online.
    const perBooth = new Map<
      string,
      { gross: number; sessions: number; online: number; total: number }
    >();
    for (const b of booths) perBooth.set(b.id, { gross: 0, sessions: 0, online: 0, total: 0 });
    for (const r of todayReport.booths) {
      const p = perBooth.get(r.boothId);
      if (p) Object.assign(p, { gross: r.gross, sessions: r.sessions });
    }
    for (const d of overview.devices) {
      const p = perBooth.get(devices.find((x) => x.id === d.id)?.boothId ?? '');
      if (!p || d.connectivity === 'revoked') continue;
      p.total += 1;
      if (d.connectivity === 'online') p.online += 1;
    }
    return { booths, templates, plan, overview, perBooth };
  });
  const maxBooths = plan?.limits.maxBooths ?? null;
  const activeBooths = booths.filter((b) => b.status === 'active');
  const archivedBooths = booths.filter((b) => b.status !== 'active');
  // Archived booths do not count toward the plan limit.
  const atLimit = maxBooths !== null && activeBooths.length >= maxBooths;
  const canEdit = org.role !== 'operator';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Booth"
        description={<>Setiap booth punya desain, harga, dan perangkatnya sendiri.</>}
      />

      {deleted && (
        <Alert variant="success" data-testid="booth-deleted">
          Booth dihapus.
        </Alert>
      )}

      <OrgOverview data={overview} />

      {activeBooths.length === 0 ? (
        <EmptyState
          icon={<CameraIcon />}
          title={archivedBooths.length ? 'Tidak ada booth aktif.' : 'Belum ada booth.'}
          description={
            canEdit
              ? 'Buat booth pertama Anda dari template di bawah, lalu atur desainnya di editor.'
              : 'Owner atau manager organisasi dapat membuat booth.'
          }
        />
      ) : (
        <ul
          className="divide-y overflow-hidden rounded-lg border bg-background shadow-xs"
          data-testid="booth-list"
        >
          {activeBooths.map((b) => {
            const p = perBooth.get(b.id);
            return (
              <li key={b.id}>
                <Link
                  href={`/booths/${b.id}`}
                  className="group flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                      <CameraIcon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{b.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {timezoneLabel(b.timezone)}
                        {b.activeConfigId ? (
                          <Badge variant="success">Sudah dipublikasikan</Badge>
                        ) : (
                          <Badge>Draft (belum dipublikasikan)</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>
                      Hari ini: <b className="text-foreground">{idr(p?.gross ?? 0)}</b> ·{' '}
                      {p?.sessions ?? 0} sesi
                    </span>
                    <span className={p && p.online > 0 ? 'text-success' : ''}>
                      {p?.total ? `${p.online}/${p.total} perangkat online` : 'Belum ada perangkat'}
                    </span>
                    <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {archivedBooths.length > 0 && (
        <details
          className="rounded-lg border bg-background shadow-xs"
          data-testid="archived-booths"
        >
          <summary className="cursor-pointer p-4 text-sm text-muted-foreground">
            Booth diarsipkan ({archivedBooths.length})
          </summary>
          <ul className="divide-y border-t">
            {archivedBooths.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/booths/${b.id}`}
                  className="flex items-center justify-between p-4 text-sm hover:bg-muted/50"
                >
                  <span>{b.name}</span>
                  <span className="text-xs text-muted-foreground">Diarsipkan ›</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Booth baru</CardTitle>
            <CardDescription>
              Pilih template sebagai titik awal; semua bisa diubah di editor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {atLimit ? (
              <p className="text-sm text-warning" data-testid="booth-limit">
                Paket {plan?.name} dibatasi {maxBooths} booth. Upgrade paket untuk menambah booth.
              </p>
            ) : (
              <CreateBoothForm
                defaultTimezone="Asia/Jakarta"
                templates={templates.map((t) => {
                  // Templates seeded before a schema upgrade are drawn in the current shape.
                  const up = upgradeBoothConfig(t.config);
                  return { ...t, config: (up.success ? up.config : t.config) as BoothConfig };
                })}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
