import { cn } from '@pb/ui';
import { CameraIcon } from './icons';

/** Studio logo: mark + wordmark. */
export function Brand({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span
        className={cn(
          'flex size-7 items-center justify-center rounded-md',
          inverted ? 'bg-white/15 text-white' : 'bg-primary text-primary-foreground',
        )}
      >
        <CameraIcon className="size-4" />
      </span>
      <span>Photobooth Studio</span>
    </span>
  );
}
