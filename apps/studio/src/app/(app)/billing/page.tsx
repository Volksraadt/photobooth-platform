import { listBooths } from '@pb/db';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  EmptyState,
} from '@pb/ui';
import { ReceiptIcon } from '@/components/icons';
import { apiFetch } from '@/lib/api';
import { formatDateTime, idr, nowMs } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';

const DAY = 86_400_000;
import type { InvoiceView } from './actions';
import { PlanCheckout } from './checkout';

type PlanView = {
  code: 'starter' | 'pro' | 'business';
  name: string;
  priceMonthly: number | null;
  limits: {
    maxBooths: number | null;
    maxDevicesPerBooth: number | null;
    maxFrames: number | null;
    recapDays?: number | null;
  };
  features: Record<string, boolean>;
};
type BillingState = {
  billing: { mode: 'midtrans' | 'mock' | 'disabled'; env: string };
  entitlements: {
    planCode: string;
    planName: string;
    subscribedPlanCode: string;
    state: 'trial' | 'active' | 'grace' | 'downgraded';
    status: string;
    periodEnd: string | null;
    graceUntil: string | null;
  } | null;
  plans: PlanView[];
  invoices: InvoiceView[];
};

const RANK: Record<string, number> = { starter: 0, pro: 1, business: 2 };
const STATE_LABEL = {
  trial: 'Masa percobaan',
  active: 'Aktif',
  grace: 'Lewat jatuh tempo (masa tenggang)',
  downgraded: 'Diturunkan ke Starter',
} as const;
const INVOICE_STATUS: Record<string, string> = {
  pending: 'menunggu pembayaran',
  paid: 'lunas',
  expired: 'kedaluwarsa',
  failed: 'gagal',
  void: 'dibatalkan',
};
const lim = (n: number | null | undefined, unit: string) =>
  n == null ? `${unit} tanpa batas` : `${n} ${unit}`;
const FEATURES: [string, string][] = [
  ['video', 'Video 9:16 & live clip'],
  ['watermarkRemoval', 'Tanpa watermark platform'],
  ['export', 'Ekspor CSV/Excel'],
  ['dslr', 'Kamera DSLR'],
  ['customDomain', 'Domain QR sendiri'],
  ['auditLog', 'Log audit lengkap'],
];

/** Plans, current subscription and invoices. Payment goes to the PLATFORM's Midtrans account. */
export default async function BillingPage() {
  const { user, org } = await requireOrg();
  const boothCount = (await asUser(user, (tx) => listBooths(tx, org.id))).length;
  const canEdit = org.role !== 'operator';
  let state: BillingState | null = null;
  let error: string | null = null;
  try {
    const res = await apiFetch(`/studio/orgs/${org.id}/billing`);
    if (res.ok) state = (await res.json()) as BillingState;
    else error = `API menolak (HTTP ${res.status}).`;
  } catch {
    error = 'API tidak dapat dihubungi.';
  }
  const e = state?.entitlements ?? null;
  const starter = state?.plans.find((p) => p.code === 'starter') ?? null;
  const daysLeft = e?.periodEnd
    ? Math.max(0, Math.ceil((new Date(e.periodEnd).getTime() - nowMs()) / DAY))
    : null;
  const canBuy = !!state?.plans.some(
    (p) => p.code !== 'starter' && p.priceMonthly && state.billing.mode !== 'disabled',
  );
  const open = (code: string) =>
    state?.invoices.find((i) => i.status === 'pending' && i.planCode === code) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Langganan"
        description={
          <>
            Langganan dibayar ke akun Midtrans milik platform, terpisah dari pembayaran pembeli di
            booth Anda (yang masuk ke akun Midtrans Anda sendiri).
          </>
        }
      />
      {error && <Alert variant="destructive">{error}</Alert>}
      {state?.billing.mode === 'disabled' && (
        <Alert data-testid="billing-disabled">
          Pembayaran langganan online belum diaktifkan di server ini. Hubungi admin platform untuk
          mengganti paket.
        </Alert>
      )}
      {state?.billing.mode === 'mock' && (
        <Alert>Mode pengembangan: pembayaran langganan memakai provider tiruan.</Alert>
      )}

      {e && (
        <Card data-testid="current-plan">
          <CardHeader>
            <CardTitle className="text-base">
              Paket saat ini: <span data-testid="plan-name">{e.planName}</span>
            </CardTitle>
            <CardDescription data-testid="plan-state">
              {STATE_LABEL[e.state]}
              {e.periodEnd
                ? ` · berakhir ${formatDateTime(new Date(e.periodEnd), org.timezone)}`
                : ''}
              {e.state === 'grace' && e.graceUntil
                ? ` · booth tetap berjalan penuh sampai ${formatDateTime(new Date(e.graceUntil), org.timezone)}`
                : ''}
            </CardDescription>
          </CardHeader>
          {(e.state === 'trial' || e.state === 'active') && e.planCode !== 'starter' && (
            <CardContent className="space-y-2 text-sm" data-testid="plan-next">
              {daysLeft !== null && (
                <p>
                  <b>{daysLeft} hari lagi</b>
                  {e.state === 'trial' ? ' masa percobaan.' : ' sampai perpanjangan.'}
                </p>
              )}
              <p className="text-muted-foreground">
                Bila tidak {e.state === 'trial' ? 'berlangganan' : 'diperpanjang'}, ada masa
                tenggang singkat dengan fitur penuh, lalu paket turun ke Starter
                {starter
                  ? ` (${lim(starter.limits.maxBooths, 'booth')}, ${lim(starter.limits.maxDevicesPerBooth, 'perangkat / booth')}, tanpa video, dengan watermark)`
                  : ''}
                . Booth yang sudah ada tetap berjalan.
              </p>
              {starter?.limits.maxBooths != null && boothCount > starter.limits.maxBooths && (
                <p className="text-warning" data-testid="plan-over-starter">
                  Anda punya {boothCount} booth, sedangkan Starter hanya {starter.limits.maxBooths}.
                  Setelah turun paket, booth baru tidak bisa dibuat sampai jumlahnya sesuai batas.
                </p>
              )}
              {!canBuy && (
                <p className="text-muted-foreground">
                  Paket berbayar belum bisa dibeli online di server ini. Hubungi admin platform
                  untuk berlangganan.
                </p>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3" data-testid="plan-grid">
        {state?.plans.map((p) => {
          const current = e?.planCode === p.code && e.state !== 'grace';
          const lower =
            e &&
            p.code !== 'starter' &&
            (RANK[p.code] ?? 0) < (RANK[e.subscribedPlanCode] ?? 0) &&
            e.state !== 'downgraded' &&
            e.state !== 'trial';
          return (
            <Card
              key={p.code}
              data-testid={`plan-${p.code}`}
              className={current ? 'border-primary' : ''}
            >
              <CardHeader>
                <CardTitle className="text-base">
                  {p.name}{' '}
                  {current && <span className="text-xs font-normal text-primary">(aktif)</span>}
                </CardTitle>
                <CardDescription>
                  {p.code === 'starter'
                    ? 'Dasar (tanpa biaya)'
                    : p.priceMonthly
                      ? `${idr(p.priceMonthly)} / bulan`
                      : 'Harga belum ditetapkan'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <ul className="space-y-1">
                  <li>{lim(p.limits.maxBooths, 'booth')}</li>
                  <li>{lim(p.limits.maxDevicesPerBooth, 'perangkat / booth')}</li>
                  <li>{lim(p.limits.maxFrames, 'frame')}</li>
                  <li>Rekap {p.limits.recapDays ? `${p.limits.recapDays} hari` : 'lengkap'}</li>
                  {FEATURES.map(([k, label]) => (
                    <li
                      key={k}
                      className={p.features[k] ? '' : 'text-muted-foreground line-through'}
                    >
                      {label}
                    </li>
                  ))}
                </ul>
                {p.code !== 'starter' &&
                  canEdit &&
                  (lower ? (
                    <p className="text-xs text-muted-foreground">
                      Turun paket terjadi otomatis bila tidak diperpanjang.
                    </p>
                  ) : p.priceMonthly && state.billing.mode !== 'disabled' ? (
                    <PlanCheckout
                      planCode={p.code as 'pro' | 'business'}
                      label={
                        e?.subscribedPlanCode === p.code &&
                        e.state !== 'trial' &&
                        e.state !== 'downgraded'
                          ? 'Perpanjang 1 bulan'
                          : `Pilih ${p.name}`
                      }
                      openInvoice={open(p.code)}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {p.priceMonthly
                        ? 'Pembayaran online belum aktif.'
                        : 'Harga belum ditetapkan; belum bisa dibeli online.'}
                    </p>
                  ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Riwayat tagihan</CardTitle>
        </CardHeader>
        <CardContent>
          {!state || state.invoices.length === 0 ? (
            <EmptyState size="compact" icon={<ReceiptIcon />} title="Belum ada tagihan." />
          ) : (
            <table className="data-table w-full text-sm" data-testid="invoice-list">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Tanggal</th>
                  <th>Paket</th>
                  <th>Periode</th>
                  <th className="text-right">Jumlah</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.invoices.map((i) => (
                  <tr key={i.id} data-testid={`invoice-${i.id}`}>
                    <td className="py-1">
                      {formatDateTime(new Date(i.paidAt ?? i.dueAt ?? i.createdAt), org.timezone)}
                    </td>
                    <td>{i.planName}</td>
                    <td className="text-xs text-muted-foreground">
                      {i.periodStart ? formatDateTime(new Date(i.periodStart), org.timezone) : '—'}{' '}
                      → {i.periodEnd ? formatDateTime(new Date(i.periodEnd), org.timezone) : '—'}
                    </td>
                    <td className="text-right">{idr(i.amount)}</td>
                    <td>{INVOICE_STATUS[i.status] ?? i.status}</td>
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
