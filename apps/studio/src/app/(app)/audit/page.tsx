import { describeAuditEntities, listAuditActions, listAuditLogs } from '@pb/db';
import { Alert, Button, Card, CardContent, PageHeader, EmptyState } from '@pb/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ListIcon } from '@/components/icons';
import { getEntitlements, hasFeature } from '@/lib/entitlements';
import { formatDateTime, nowMs } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';

const DAY = 86_400_000;

/** Objects without their own page or name lookup. */
const ENTITY_LABEL: Record<string, string> = {
  drive_connections: 'Google Drive',
  payment_credentials: 'Kredensial Midtrans',
  subscription: 'Langganan',
  booth: 'Booth',
  booth_config: 'Desain booth',
  session: 'Sesi',
  device: 'Perangkat',
};

/** Human text for the actions we log (anything else shows its raw key). */
const ACTION_LABEL: Record<string, string> = {
  'booth.publish': 'Publish desain booth',
  'booth.rollback': 'Rollback desain booth',
  'booth.archive': 'Mengarsipkan booth',
  'booth.restore': 'Memulihkan booth',
  'booth.delete': 'Menghapus booth',
  'booth.voucher_offline': 'Mengubah voucher offline',
  'voucher.reveal': 'Melihat kode voucher',
  'device.pair': 'Memasangkan perangkat',
  'device.revoke': 'Mencabut perangkat',
  'device.paper_new_roll': 'Roll kertas baru',
  'device.paper_capacity': 'Mengubah kapasitas roll',
  'voucher.create': 'Membuat voucher',
  'cash.approve': 'Persetujuan pembayaran tunai',
  'integration.midtrans.save': 'Mengubah kredensial Midtrans',
  'integration.midtrans.test': 'Tes koneksi Midtrans',
  'integration.drive.connect': 'Menghubungkan Google Drive',
  'integration.drive.disconnect': 'Memutus Google Drive',
  'integration.drive.root_folder': 'Mengubah folder root Drive',
  'subscription.paid': 'Pembayaran langganan diterima',
  'subscription.past_due': 'Langganan lewat jatuh tempo',
  'subscription.downgraded': 'Paket diturunkan ke Starter',
  'subscription.admin_set': 'Paket diubah admin platform',
};

/**
 * Audit log (append-only, see docs/schema.md B.5). Owner/manager. Without the plan feature
 * `auditLog` the last 30 days are shown; with it the full history.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const sp = await searchParams;
  const { user, org } = await requireOrg();
  if (org.role === 'operator') redirect('/booths');
  const ent = await getEntitlements(user, org.id);
  const full = hasFeature(ent, 'auditLog');
  const { logs, actions, names } = await asUser(user, async (tx) => {
    const logs = await listAuditLogs(tx, {
      orgId: org.id,
      action: sp.action || null,
      since: full ? null : new Date(nowMs() - 30 * DAY),
      limit: full ? 500 : 200,
    });
    return {
      logs,
      actions: await listAuditActions(tx, org.id),
      names: await describeAuditEntities(tx, org.id, logs),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Log audit"
        description={
          <>
            Perubahan desain, kredensial, voucher, pembayaran tunai, perangkat, dan langganan.
            Catatan ini tidak bisa diubah atau dihapus.
          </>
        }
      />
      {!full && (
        <Alert data-testid="audit-limit">
          Paket {ent?.planName} menampilkan 30 hari terakhir. Riwayat lengkap tersedia di paket
          Business.
        </Alert>
      )}
      <form className="flex flex-wrap items-end gap-3 rounded border bg-background p-3 text-sm">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Jenis kejadian</span>
          <select
            name="action"
            defaultValue={sp.action ?? ''}
            className="h-9 rounded-md border bg-background px-2"
          >
            <option value="">Semua</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">Terapkan</Button>
      </form>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {logs.length === 0 ? (
            <EmptyState size="compact" icon={<ListIcon />} title="Belum ada catatan." />
          ) : (
            <table className="data-table w-full text-sm" data-testid="audit-list">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1">Waktu</th>
                  <th>Kejadian</th>
                  <th>Objek</th>
                  <th>Pelaku</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.map((l) => (
                  <tr key={l.id} className="align-top" data-action={l.action}>
                    <td className="whitespace-nowrap py-1">{formatDateTime(l.at, org.timezone)}</td>
                    <td>{ACTION_LABEL[l.action] ?? l.action}</td>
                    <td className="text-xs">
                      {(() => {
                        const named = l.entityId ? names.get(`${l.entity}:${l.entityId}`) : null;
                        if (named?.href)
                          return (
                            <Link href={named.href} className="underline">
                              {named.label}
                            </Link>
                          );
                        if (named) return named.label;
                        return (
                          <span className="text-muted-foreground">
                            {ENTITY_LABEL[l.entity] ?? l.entity}
                            {l.entityId && !ENTITY_LABEL[l.entity]
                              ? ` ${l.entityId.slice(0, 8)}`
                              : ''}
                            {l.entityId &&
                            ENTITY_LABEL[l.entity] &&
                            l.entity !== 'drive_connections' &&
                            l.entity !== 'subscription' &&
                            l.entity !== 'payment_credentials'
                              ? ' (sudah dihapus)'
                              : ''}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {!l.actorId
                        ? l.entity === 'session'
                          ? 'Perangkat booth'
                          : 'Sistem'
                        : l.actorId === user.id
                          ? 'Anda'
                          : `anggota ${l.actorId.slice(0, 8)}`}
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
