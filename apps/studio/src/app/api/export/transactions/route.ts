import { listBooths, listOrgDevices, listTransactions } from '@pb/db';
import { NextResponse, type NextRequest } from 'next/server';
import { getEntitlements, hasFeature, recapDays } from '@/lib/entitlements';
import { formatDateTime, METHOD_LABEL } from '@/lib/format';
import { asUser, requireOrg } from '@/lib/org';
import { resolveRange, todayIn } from '@/lib/range';
import { buildCsv, buildXlsx, type Cell } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, string> = {
  started: 'dimulai',
  paid: 'lunas',
  capturing: 'berfoto',
  completed: 'selesai',
  abandoned: 'ditinggal',
  failed: 'gagal',
};
const MAX_ROWS = 20_000;

type Responses = Awaited<ReturnType<typeof listTransactions>>['rows'][number]['responses'];

/** Ticked consents, one per line in the cell. */
function consentCell(responses: Responses): string | null {
  const labels = responses.flatMap((r) => (r.kind === 'consent' ? [r.label] : []));
  return labels.length ? labels.join('\n') : null;
}

/** "Question: answer, answer", one question per line in the cell. */
function surveyCell(responses: Responses): string | null {
  const lines = responses.flatMap((r) =>
    r.kind === 'survey' ? [`${r.question || r.elementId}: ${r.optionLabels.join(', ')}`] : [],
  );
  return lines.length ? lines.join('\n') : null;
}

/**
 * CSV / Excel export of the transactions in a range (plan feature `export`). Runs as the signed-in
 * user (RLS), so it can only contain that user's org. Times are in each booth's own timezone.
 */
export async function GET(req: NextRequest) {
  const { user, org } = await requireOrg();
  const ent = await getEntitlements(user, org.id);
  if (!hasFeature(ent, 'export')) {
    return NextResponse.json(
      { message: 'Ekspor tersedia di paket Pro dan Business.' },
      { status: 403 },
    );
  }
  const q = req.nextUrl.searchParams;
  const range = resolveRange(
    { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined },
    todayIn(org.timezone),
    recapDays(ent),
  );
  const format = q.get('format') === 'xlsx' ? 'xlsx' : 'csv';

  const rows = await asUser(user, async (tx) => {
    const [boothList, deviceList] = await Promise.all([
      listBooths(tx, org.id),
      listOrgDevices(tx, org.id),
    ]);
    const boothParam = q.get('booth');
    const deviceParam = q.get('device');
    const boothId = boothList.some((b) => b.id === boothParam) ? boothParam : null;
    const deviceId = deviceList.some((d) => d.id === deviceParam) ? deviceParam : null;
    const out = [];
    for (let offset = 0; offset < MAX_ROWS; offset += 200) {
      const page = await listTransactions(tx, {
        orgId: org.id,
        from: range.from,
        to: range.to,
        boothId,
        deviceId,
        limit: 200,
        offset,
      });
      out.push(...page.rows);
      if (offset + 200 >= page.total) break;
    }
    return out;
  });

  const header: Cell[] = [
    'Kode sesi',
    'Booth',
    'Perangkat',
    'Mulai (zona booth)',
    'Zona waktu',
    'Metode',
    'Kotor (Rp)',
    'Fee (Rp)',
    'Bersih (Rp)',
    'Cetak tambahan',
    'Offline',
    'Status',
    'Link Drive',
    'Persetujuan',
    'Survei',
  ];
  const body: Cell[][] = rows.map((r) => [
    r.code,
    r.boothName,
    r.deviceName,
    formatDateTime(r.startedAt, r.timezone),
    r.timezone,
    r.paymentMethod ? (METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod) : null,
    r.grossAmount,
    r.feeAmount,
    r.netAmount,
    r.extraPrints,
    r.offline ? 'ya' : 'tidak',
    STATUS[r.status] ?? r.status,
    r.driveFolderUrl,
    consentCell(r.responses),
    surveyCell(r.responses),
  ]);
  const name = `transaksi-${range.from}_${range.to}`;
  if (format === 'xlsx') {
    return new Response(new Uint8Array(buildXlsx('Transaksi', [header, ...body])), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${name}.xlsx"`,
        'cache-control': 'no-store',
      },
    });
  }
  return new Response(buildCsv([header, ...body]), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
