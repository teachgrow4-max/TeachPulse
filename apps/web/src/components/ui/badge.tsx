import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const badge = cva(
  [
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
    'whitespace-nowrap ring-1 ring-inset',
  ],
  {
    variants: {
      tone: {
        neutral: 'bg-surface-2 text-muted ring-line',
        brand: 'bg-brand-soft text-brand ring-brand/20',
        success: 'bg-success-soft text-success ring-success-solid/25',
        warning: 'bg-warning-soft text-warning ring-warning-solid/25',
        danger: 'bg-danger-soft text-danger ring-danger-solid/25',
        info: 'bg-info-soft text-info ring-info-solid/25',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

/** A small label for a status. `dot` adds a coloured dot, for states that are happening live. */
export function Badge({
  className,
  tone,
  dot = false,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge> & { dot?: boolean }) {
  return (
    <span className={cn(badge({ tone }), className)} {...rest}>
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
