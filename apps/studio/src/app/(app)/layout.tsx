import { Button } from '@pb/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppNav, type NavItem } from '@/components/app-nav';
import { Brand } from '@/components/brand';
import { LogOutIcon } from '@/components/icons';
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
  const initial = (user.email ?? org.name).trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="min-h-screen bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      >
        Lewati ke konten utama
      </a>
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/booths"
                className="whitespace-nowrap rounded-md"
                aria-label="Beranda Studio"
              >
                <Brand />
              </Link>
              <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
              <span
                className="truncate text-sm font-medium text-muted-foreground"
                title={org.name}
                data-testid="org-name"
              >
                {org.name}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <span
                className="hidden max-w-56 truncate pr-2 text-muted-foreground md:inline"
                title={user.email ?? ''}
              >
                {user.email}
              </span>
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary-hover"
              >
                {initial}
              </span>
              <form action={logoutAction}>
                <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                  <LogOutIcon />
                  Keluar
                </Button>
              </form>
            </div>
          </div>
          <AppNav items={navItems} />
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-6xl space-y-8 px-4 py-8 outline-none sm:px-6 sm:py-10"
      >
        <SubscriptionBanner entitlements={entitlements} timeZone={org.timezone} />
        {children}
      </main>
    </div>
  );
}
