import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeftIcon } from './icons';

/** "← Parent" link shown above a page title. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      {children}
    </Link>
  );
}
