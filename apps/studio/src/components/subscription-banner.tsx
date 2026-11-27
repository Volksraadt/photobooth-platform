import type { Entitlements } from '@pb/db';
import { Alert } from '@pb/ui';
import Link from 'next/link';
import { formatDateTime, nowMs } from '@/lib/format';

const DAY = 86_400_000;

/**
 * Subscription warnings shown on every Studio page. Booths keep running in all of these states:
 * the grace period keeps the full plan, and after it only the Starter limits apply.
 */
export function SubscriptionBanner({
  entitlements: e,
  timeZone,
}: {
  entitlements: Entitlements | null;
  timeZone: string;
}) {
  if (!e) return null;
  const now = nowMs();
  const daysLeft = e.periodEnd ? Math.ceil((e.periodEnd.getTime() - now) / DAY) : null;
  const cta = (
    <Link href="/billing" className="font-medium underline" data-testid="banner-billing-link">
      Bayar / kelola langganan
    </Link>
  );

  if (e.state === 'grace') {
    return (
      <Alert variant="warning" data-testid="subscription-banner" data-state="grace">
        {e.status === 'trialing' ? 'Masa percobaan' : `Langganan paket ${e.planName}`} berakhir pada{' '}
        <b>{formatDateTime(e.periodEnd, timeZone)}</b>. Booth Anda <b>tetap berjalan</b> penuh
        sampai <b>{formatDateTime(e.graceUntil, timeZone)}</b>; setelah itu paket turun ke Starter
        (1 booth, tanpa video, dengan watermark). {cta}
      </Alert>
    );
  }
  if (e.state === 'downgraded') {
    return (
      <Alert variant="warning" data-testid="subscription-banner" data-state="downgraded">
        Masa tenggang berakhir, paket diturunkan ke <b>Starter</b>. Booth yang sudah ada tetap
        berjalan, tetapi batas paket Starter berlaku (booth baru, video, dan watermark). {cta}
      </Alert>
    );
  }
  if (e.state === 'trial' && daysLeft !== null && daysLeft <= 3) {
    return (
      <Alert variant="info" data-testid="subscription-banner" data-state="trial-ending">
        Masa percobaan berakhir dalam <b>{Math.max(0, daysLeft)} hari</b> (
        {formatDateTime(e.periodEnd, timeZone)}). {cta}
      </Alert>
    );
  }
  if (e.state === 'active' && e.planCode !== 'starter' && daysLeft !== null && daysLeft <= 3) {
    return (
      <Alert variant="info" data-testid="subscription-banner" data-state="renewal-soon">
        Langganan {e.planName} berakhir dalam <b>{Math.max(0, daysLeft)} hari</b>. {cta}
      </Alert>
    );
  }
  return null;
}
