import { cn } from '../../lib/utils';
import { QrIcon } from './icons';

/** The TeachGrow mark (a teal tile with a QR glyph) and, optionally, the product name beside it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-brand-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white',
        'shadow-card ring-1 ring-inset ring-white/20',
        className,
      )}
    >
      <QrIcon className="h-5 w-5" />
    </span>
  );
}

export function Logo({
  className,
  tone = 'default',
}: {
  className?: string;
  /** `inverse` is for the dark brand panel, where the text has to be light. */
  tone?: 'default' | 'inverse';
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <div className="leading-tight">
        <p
          className={cn(
            'text-[0.95rem] font-semibold tracking-tight',
            tone === 'inverse' && 'text-white',
          )}
        >
          TeachGrow
        </p>
        <p className={cn('text-xs', tone === 'inverse' ? 'text-white/80' : 'text-muted')}>
          Attendance
        </p>
      </div>
    </div>
  );
}
