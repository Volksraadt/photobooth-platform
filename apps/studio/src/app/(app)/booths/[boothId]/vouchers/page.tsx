import { getBooth, listBoothVouchers } from '@pb/db';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  EmptyState,
} from '@pb/ui';
import { TicketIcon } from '@/components/icons';
import { BackLink } from '@/components/back-link';
import { notFound } from 'next/navigation';
import { formatInZone } from '@/lib/timezones';
import { asUser, requireOrg } from '@/lib/org';
import { VoucherForm } from './voucher-form';
import { VoucherList, VoucherOfflineToggle, type VoucherRowView } from './voucher-list';

const nowMs = () => Date.now();

export default async function VouchersPage({ params }: { params: Promise<{ boothId: string }> }) {
  const { boothId } = await params;
  const { user, org } = await requireOrg();
  const data = await asUser(user, async (tx) => {
    const row = await getBooth(tx, boothId);
    if (!row) return null;
    return { booth: row.booth, vouchers: await listBoothVouchers(tx, boothId), now: nowMs() };
  });
  if (!data) notFound();
  const { booth, vouchers, now } = data;
  const tz = booth.timezone;
  const canEdit = org.role !== 'operator';
  const rows: VoucherRowView[] = vouchers.map((v) => {
    const expired = !v.usedAt && !!v.expiresAt && v.expiresAt.getTime() < now;
    return {
      id: v.id,
      last4: v.codeLast4,
      valueLabel:
        v.valueType === 'full' ? 'Penuh (gratis 1 sesi)' : `Rp${v.value.toLocaleString('id-ID')}`,
      expiresLabel: v.expiresAt
        ? `berlaku s.d. ${formatInZone(v.expiresAt, tz)}`
        : 'tanpa batas waktu',
      status: v.usedAt ? 'used' : expired ? 'expired' : 'available',
      statusLabel: v.usedAt
        ? `Terpakai sesi ${v.usedSessionCode ?? '?'} · ${formatInZone(v.usedAt, tz)}`
        : expired
          ? 'Kedaluwarsa'
          : 'Tersedia',
      usedOffline: v.usedOffline,
      note: v.note ?? '',
      revealable: v.revealable,
    };
  });
  const used = rows.filter((r) => r.status === 'used').length;
  const available = rows.filter((r) => r.status === 'available').length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href={`/booths/${boothId}`}>{booth.name}</BackLink>}
        title="Voucher"
        description={`${rows.length} voucher · ${used} terpakai · ${available} tersedia`}
      />

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Buat voucher</CardTitle>
            <CardDescription>
              Kode 8 digit (dicetak 1234-5678) dimasukkan pembeli di halaman Pembayaran.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VoucherForm boothId={boothId} boothName={booth.name} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saat booth offline</CardTitle>
        </CardHeader>
        <CardContent>
          <VoucherOfflineToggle
            boothId={boothId}
            enabled={booth.voucherOffline}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daftar voucher</CardTitle>
          <CardDescription>
            {canEdit
              ? 'Kode disamarkan; tekan Tampilkan untuk melihat dan menyalinnya kapan saja.'
              : 'Hanya owner/manager yang dapat melihat kode lengkap.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState size="compact" icon={<TicketIcon />} title="Belum ada voucher." />
          ) : (
            <VoucherList boothId={boothId} boothName={booth.name} rows={rows} canReveal={canEdit} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
