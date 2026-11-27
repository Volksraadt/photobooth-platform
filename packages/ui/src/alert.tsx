import type { ComponentProps } from 'react';
import { cn } from './cn';

export type AlertVariant = 'default' | 'destructive' | 'success' | 'warning' | 'info';

export function Alert({
  className,
  variant = 'default',
  role,
  ...props
}: ComponentProps<'div'> & { variant?: AlertVariant }) {
  return (
    <div
      // Errors interrupt screen readers; other notices are announced politely.
      role={role ?? (variant === 'destructive' ? 'alert' : 'status')}
      className={cn(
        'rounded-md border px-4 py-3 text-sm',
        variant === 'destructive' && 'border-destructive/30 bg-destructive-soft text-destructive',
        variant === 'success' && 'border-success/30 bg-success-soft text-success',
        variant === 'warning' && 'border-warning/30 bg-warning-soft text-warning',
        variant === 'info' && 'border-info/30 bg-info-soft text-info',
        variant === 'default' && 'bg-muted text-foreground',
        className,
      )}
      {...props}
    />
  );
}
