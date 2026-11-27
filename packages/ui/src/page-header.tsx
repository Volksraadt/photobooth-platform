import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

export type PageHeaderProps = Omit<ComponentProps<'div'>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  /** Shown above the title, e.g. a back link. */
  eyebrow?: ReactNode;
  /** Buttons/links aligned to the right on wide screens. */
  actions?: ReactNode;
  titleProps?: ComponentProps<'h1'> & { [key: `data-${string}`]: string };
};

/** One consistent page title block for every Studio page. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  titleProps,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}
      {...props}
    >
      <div className="min-w-0 max-w-3xl space-y-1">
        {eyebrow && <div className="mb-2 text-sm text-muted-foreground">{eyebrow}</div>}
        <h1
          {...titleProps}
          className={cn('text-2xl font-semibold tracking-tight', titleProps?.className)}
        >
          {title}
        </h1>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
