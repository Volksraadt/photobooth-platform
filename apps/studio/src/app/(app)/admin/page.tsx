import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@pb/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { isPlatformAdmin } from '@/lib/entitlements';
import { formatDateTime, idr } from '@/lib/format';
import { runLifecycleAction, setPriceAction, setSubscriptionAction } from './actions';

type AdminOrg = {
  orgId: string;
  name: string;
  slug: string;
  planCode: string | null;
  subscribedPlanCode: string | null;
  status: string | null;
  state: string | null;
  periodEnd: string | null;
  graceUntil: string | null;
  booths: number;
  openInvoices: number;
};
type AdminPlan = { code: string; name: string; priceMonthly: number | null };

const STATE_LABEL: Record<string, string> = {
  trial: 'percobaan',
  active: 'aktif',
  grace: 'masa tenggang',
  downgraded: 'turun ke Starter',
};

/** Platform admin: every org, its plan and state, manual plan change, plan prices. */
export default async function AdminPage() {
  const user = await requireUser();
  if (!isPlatformAdmin(user)) notFound();
  const res = await apiFetch('/admin/orgs');
  if (!res.ok) notFound();
  const { orgs, plans } = (await res.json()) as { orgs: AdminOrg[]; plans: AdminPlan[] };
  const tz = 'Asia/Jakarta';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin platform"
        description={
          <span>
            Semua organisasi, paket, dan statusnya. Setiap perubahan tercatat di log audit
            organisasi terkait.
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/admin/frames" data-testid="admin-frames">
                Pustaka frame
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/templates" data-testid="admin-templates">
                Template booth
              </Link>
            </Button>
            <form action={runLifecycleAction}>
              <Button type="submit" variant="outline" data-testid="run-lifecycle">
                Jalankan siklus langganan sekarang
              </Button>
            </form>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Harga paket</CardTitle>
          <CardDescription>
            Harga per bulan dalam rupiah. Kosong = belum bisa dibeli (open-questions #2).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          {plans
            .filter((p) => p.code !== 'starter')
            .map((p) => (
              <form
                key={p.code}
                action={setPriceAction}
                className="flex items-end gap-2 text-sm"
                data-testid={`price-form-${p.code}`}
              >
                <input type="hidden" name="code" value={p.code} />
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    {p.name} (sekarang {p.priceMonthly ? idr(p.priceMonthly) : 'kosong'})
                  </span>
                  <input
                    name="priceMonthly"
                    type="number"
                    min={0}
                    defaultValue={p.priceMonthly ?? ''}
                    className="h-9 w-40 rounded-md border bg-background px-2"
                  />
                </label>
                <Button type="submit" size="sm" variant="outline">
                  Simpan
                </Button>
              </form>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <table className="data-table w-full text-sm" data-testid="admin-orgs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Organisasi</th>
                <th>Paket</th>
                <th>Status</th>
                <th>Berakhir</th>
                <th className="text-right">Booth</th>
                <th>Ubah paket</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {orgs.map((o) => (
                <tr key={o.orgId} className="align-top" data-testid={`admin-org-${o.slug}`}>
                  <td className="py-2">
                    <div className="font-medium">{o.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {o.orgId.slice(0, 10)}
                    </div>
                  </td>
                  <td>
                    {o.planCode}
                    {o.subscribedPlanCode && o.subscribedPlanCode !== o.planCode && (
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        (langganan {o.subscribedPlanCode})
                      </span>
                    )}
                  </td>
                  <td>
                    {STATE_LABEL[o.state ?? ''] ?? '—'}
                    {o.openInvoices > 0 && (
                      <span className="text-xs text-warning">
                        {' '}
                        · {o.openInvoices} tagihan terbuka
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    {o.periodEnd ? formatDateTime(new Date(o.periodEnd), tz) : '—'}
                  </td>
                  <td className="text-right">{o.booths}</td>
                  <td>
                    <form
                      action={setSubscriptionAction}
                      className="flex flex-wrap items-center gap-1"
                    >
                      <input type="hidden" name="orgId" value={o.orgId} />
                      <select
                        name="planCode"
                        defaultValue={o.subscribedPlanCode ?? 'starter'}
                        className="h-8 rounded-md border bg-background px-1"
                      >
                        {plans.map((p) => (
                          <option key={p.code} value={p.code}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <select
                        name="status"
                        defaultValue="active"
                        className="h-8 rounded-md border bg-background px-1"
                      >
                        <option value="active">aktif</option>
                        <option value="trialing">percobaan</option>
                        <option value="past_due">lewat jatuh tempo</option>
                        <option value="canceled">dibatalkan</option>
                      </select>
                      <input
                        name="periodDays"
                        type="number"
                        min={0}
                        defaultValue={30}
                        className="h-8 w-16 rounded-md border bg-background px-1"
                        aria-label="Lama (hari)"
                      />
                      <input
                        name="note"
                        placeholder="catatan"
                        className="h-8 w-28 rounded-md border bg-background px-1"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        data-testid={`admin-set-${o.slug}`}
                      >
                        Terapkan
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
