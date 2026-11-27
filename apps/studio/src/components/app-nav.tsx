'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type NavItem = { href: string; label: string; testId?: string };

/** Main Studio navigation: one scrollable row, the current section underlined. */
export function AppNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav
      className="-mb-px -mx-2 flex gap-1 overflow-x-auto text-sm [scrollbar-width:none]"
      aria-label="Navigasi utama"
    >
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testId}
            aria-current={active ? 'page' : undefined}
            className={`relative whitespace-nowrap px-2 py-3 font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:outline-offset-[-2px] ${
              active
                ? 'text-foreground after:bg-primary'
                : 'text-muted-foreground after:bg-transparent hover:text-foreground'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
