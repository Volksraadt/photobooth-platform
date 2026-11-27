import type { Connectivity } from '@pb/db';
import { Card, CardContent } from '@pb/ui';
import Link from 'next/link';
import { agoText, idr } from '@/lib/format';

export type OverviewData = {
  today: { sessions: number; gross: number };
  week: { sessions: number; gross: number };
  devices: {
    id: string;
    name: string;
    boothName: string | null;
    connectivity: Connectivity;
    lastHeartbeatAt: Date | null;
  }[];
  uploads: { failed: number; waiting: number };
  refunds: number;
  now: number;
};

const NEEDS_ATTENTION: Connectivity[] = ['offline', 'stale', 'never'];
const CONNECTIVITY_TEXT: Record<Connectivity, string> = {
  online: 'online',
  stale: 'tidak responsif',
  offline: 'offline',
  revoked: 'dicabut',
  never: 'belum pernah terhubung',
};

function Stat(props: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: 'warn';
}) {
  const body = (
    <CardContent className="space-y-1 pt-5 pb-5">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className={`text-2xl font-semibold ${props.tone === 'warn' ? 'text-amber-700' : ''}`}>
        {props.value}
      </p>
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </CardContent>
  );
  return (
    <Card className={props.href ? 'transition-colors hover:border-primary/40' : undefined}>
      {props.href ? (
        <Link href={props.href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

/** Today at a glance for the owner: sales, devices that need a look, deliveries, refunds. */
export function OrgOverview({ data }: { data: OverviewData }) {
  const active = data.devices.filter((d) => d.connectivity !== 'revoked');
  const online = active.filter((d) => d.connectivity === 'online').length;
  const attention = active.filter((d) => NEEDS_ATTENTION.includes(d.connectivity));
  const problems = attention.length + data.uploads.failed + data.refunds;

  return (
    <section className="space-y-3" data-testid="org-overview">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Pendapatan hari ini"
          value={idr(data.today.gross)}
          hint={`${data.today.sessions} sesi`}
          href="/reports"
        />
        <Stat
          label="7 hari terakhir"
          value={idr(data.week.gross)}
          hint={`${data.week.sessions} sesi`}
          href="/reports"
        />
        <Stat
          label="Perangkat online"
          value={active.length ? `${online} / ${active.length}` : '—'}
          hint={active.length ? undefined : 'Belum ada perangkat'}
          href="/devices"
          tone={attention.length ? 'warn' : undefined}
        />
        <Stat
          label="Upload file"
          value={data.uploads.failed ? `${data.uploads.failed} gagal` : 'Lancar'}
          hint={data.uploads.waiting ? `${data.uploads.waiting} menunggu` : undefined}
          href="/devices"
          tone={data.uploads.failed ? 'warn' : undefined}
        />
      </div>

      {problems > 0 && (
        <Card className="border-amber-200 bg-amber-50/60" data-testid="overview-attention">
          <CardContent className="space-y-1.5 pt-4 pb-4 text-sm">
            <p className="font-medium text-amber-900">Perlu dicek</p>
            <ul className="space-y-1 text-amber-900/90">
              {attention.map((d) => (
                <li key={d.id}>
                  <Link href="/devices" className="underline">
                    {d.name}
                  </Link>
                  {d.boothName ? ` (${d.boothName})` : ''} — {CONNECTIVITY_TEXT[d.connectivity]}
                  {d.lastHeartbeatAt ? `, terakhir ${agoText(d.lastHeartbeatAt, data.now)}` : ''}
                </li>
              ))}
              {data.uploads.failed > 0 && (
                <li>
                  {data.uploads.failed} upload file gagal —{' '}
                  <Link href="/devices" className="underline">
                    lihat antrian
                  </Link>
                </li>
              )}
              {data.refunds > 0 && (
                <li>
                  {data.refunds} pembayaran perlu ditindaklanjuti (refund manual) —{' '}
                  <Link href="/reports" className="underline">
                    lihat rekap
                  </Link>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
