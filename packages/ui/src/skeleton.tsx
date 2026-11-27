import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Placeholder block shown while content loads. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div aria-hidden className={cn('animate-shimmer rounded-md bg-muted', className)} {...props} />
  );
}
