import type { HTMLAttributes, ReactNode } from 'react';
import { initialsOf, cn } from '../../lib/utils';
import { InfoIcon } from './icons';

/** A round photo of a person, or their initials when there is no (loadable) photo. */
export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'relative inline-flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden',
        'rounded-full bg-brand-soft text-lg font-bold text-brand',
        className,
      )}
    >
      <span aria-hidden={src ? true : undefined}>{initialsOf(name)}</span>
      {src ? (
        <img
          src={src}
          alt={`Photo of ${name}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => {
            // A broken link falls back to the initials underneath.
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
    </span>
  );
}

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('skeleton rounded-lg', className)} {...rest} />;
}

export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-muted">{icon ?? <InfoIcon className="h-8 w-8" />}</div>
      <p className="font-semibold">{title}</p>
      {children ? <p className="max-w-sm text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** A message that sits in the page: errors, warnings, tips. */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
  role,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
  className?: string;
  role?: 'alert' | 'status';
}) {
  const tones = {
    info: 'border-info-solid/30 bg-info-soft text-info',
    success: 'border-success-solid/30 bg-success-soft text-success',
    warning: 'border-warning-solid/30 bg-warning-soft text-warning',
    danger: 'border-danger-solid/30 bg-danger-soft text-danger',
  } as const;
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cn('rounded-xl border px-4 py-3 text-sm', tones[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-0.5' : ''}>{children}</div> : null}
    </div>
  );
}
