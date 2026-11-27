import { Button } from '@pb/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppNav, type NavItem } from '@/components/app-nav';
import { SubscriptionBanner } from '@/components/subscription-banner';
import { getEntitlements, isPlatformAdmin } from '@/lib/entitlements';
import { requireOrg } from '@/lib/org';
import { logoutAction } from '../login/actions';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, org } = await requireOrg();
  const entitlements = await getEntitlements(user, org.id);
  const manager = org.role !== 'operator';
  const navItems: NavItem[] = [
    { href: '/booths', label: 'Booth', testId: 'nav-booths' },
    { href: '/reports', label: 'Rekap', testId: 'nav-reports' },
    { href: '/transactions', label: 'Transaksi', testId: 'nav-transactions' },
    { href: '/devices', label: 'Perangkat', testId: 'nav-devices' },
    { href: '/integrations', label: 'Integrasi', testId: 'nav-integrations' },
    { href: '/billing', label: 'Langganan', testId: 'nav-billing' },
    ...(manager ? [{ href: '/audit', label: 'Log audit', testId: 'nav-audit' }] : []),
    ...(isPlatformAdmin(user) ? [{ href: '/admin', label: 'Admin', testId: 'nav-admin' }] : []),
  ];
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex h-14 items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/booths" className="whitespace-nowrap font-semibold">
                Photobooth Studio
              </Link>
              <span
                className="truncate rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
                title={org.name}
                data-testid="org-name"
              >
                {org.name}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span
                className="hidden truncate text-muted-foreground sm:inline"
                title={user.email ?? ''}
              >
                {user.email}
              </span>
              <form action={logoutAction}>
                <Button type="submit" variant="ghost" size="sm">
                  Keluar
                </Button>
              </form>
            </div>
          </div>
          <AppNav items={navItems} />
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <SubscriptionBanner entitlements={entitlements} timeZone={org.timezone} />
        {children}
      </main>
    </div>
  );
}
