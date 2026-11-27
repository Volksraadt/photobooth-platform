import { getDevice, listDeviceEvents, listEventKinds } from '@pb/db';
import { Button, Card, CardContent, PageHeader } from '@pb/ui';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { formatDateTime } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';

const LEVELS = { info: 'Info', warn: 'Peringatan', error: 'Error' } as const;
const LEVEL_CLS: Record<string, string> = {
  info: 'text-muted-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
};

/** Event log of one device, filterable by level and kind (camera, printer, payment, sync, …). */
export default async function DeviceLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ level?: string; kind?: string }>;
}) {
  const { deviceId } = await params;
  const sp = await searchParams;
  const { user, org } = await requireOrg();
  const level = sp.level && sp.level in LEVELS ? (sp.level as keyof typeof LEVELS) : null;
  const data = await asUser(user, async (tx) => {
    const device = await getDevice(tx, org.id, deviceId);
    if (!device) return null;
    const [events, kinds] = await Promise.all([
      listDeviceEvents(tx, { orgId: org.id, deviceId, level, kind: sp.kind || null, limit: 200 }),
      listEventKinds(tx, org.id, deviceId),
    ]);
    return { device, events, kinds };
  });
  if (!data) notFound();
  const tz = data.device.boothTimezone ?? org.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href="/devices">Perangkat</BackLink>}
        title={`Log: ${data.device.name}`}
        description={<>200 kejadian terbaru. Waktu mengikuti zona {tz}.</>}
      />
      <form
        className="flex flex-wrap items-end gap-3 rounded border bg-background p-3 text-sm"
        data-testid="event-filter"
      >
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Tingkat</span>
          <select
            name="level"
            defaultValue={level ?? ''}
            className="h-9 rounded-md border bg-background px-2"
          >
            <option value="">Semua</option>
            {Object.entries(LEVELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Jenis</span>
          <select
            name="kind"
            defaultValue={sp.kind ?? ''}
            className="h-9 rounded-md border bg-background px-2"
          >
            <option value="">Semua</option>
            {data.kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">Terapkan</Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {data.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada kejadian.</p>
          ) : (
            <table className="data-table w-full text-sm" data-testid="event-list">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Waktu</th>
                  <th>Tingkat</th>
                  <th>Jenis</th>
                  <th>Pesan</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.events.map(({ e }) => (
                  <tr key={e.id} className="align-top">
                    <td className="whitespace-nowrap py-1">{formatDateTime(e.occurredAt, tz)}</td>
                    <td className={LEVEL_CLS[e.level]}>{LEVELS[e.level]}</td>
                    <td className="font-mono text-xs">{e.kind}</td>
                    <td>{e.message}</td>
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
