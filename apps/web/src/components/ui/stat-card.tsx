import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Card } from './card';
import type { AppIcon } from './icons';
import { Skeleton } from './misc';

const TONE = {
  neutral: 'bg-surface-2 text-muted',
  brand: 'bg-brand-soft text-brand',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
} as const;

export type StatTone = keyof typeof TONE;

/** One number that matters, with a small icon and a line of context. */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: AppIcon;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <Card
      interactive
      className={cn('flex items-start justify-between gap-3 p-4 sm:p-5', className)}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted">{label}</p>
        <p className="mt-1.5 text-3xl font-semibold leading-none tracking-tight tabular-nums">
          {value}
        </p>
        {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
      </div>
      {Icon ? (
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            TONE[tone],
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card className="p-4 sm:p-5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-8 w-16" />
      <Skeleton className="mt-3 h-3 w-28" />
    </Card>
  );
}
