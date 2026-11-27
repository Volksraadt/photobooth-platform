import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export type EmptyStateProps = Omit<ComponentProps<'div'>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /** `compact` for use inside a card, without the dashed frame. */
  size?: 'default' | 'compact';
};

/** Shown in place of a list or chart that has nothing to show yet. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'default',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'default'
          ? 'rounded-lg border border-dashed bg-background px-6 py-12'
          : 'rounded-md bg-muted/50 px-4 py-8',
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
