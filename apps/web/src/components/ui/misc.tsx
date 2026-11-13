import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { initialsOf, cn } from '../../lib/utils';
import {
  AlertCircleIcon,
  AlertIcon,
  CheckCircleIcon,
  InboxIcon,
  InfoIcon,
  type AppIcon,
} from './icons';

const AVATAR_SIZE = {
  xs: 'h-7 w-7 text-[10px]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-11 w-11 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-20 w-20 text-2xl',
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE;

/** A hue from 0 to 359 that is always the same for the same name, so a person keeps their colour. */
function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/**
 * A round photo of a person, or their initials on a soft colour of their own when there is no
 * (loadable) photo. The colour follows light and dark mode.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name: string;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const hue = hueOf(name);
  const tint: CSSProperties = {
    backgroundColor: `color-mix(in oklab, hsl(${hue} 70% 50%) 16%, var(--surface))`,
    color: `color-mix(in oklab, hsl(${hue} 70% 38%) 80%, var(--fg))`,
  };
  return (
    <span
      style={tint}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        'rounded-full bg-brand-soft font-semibold text-brand ring-1 ring-inset ring-black/5',
        AVATAR_SIZE[size],
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

/** A person in a list or a table: photo, name, and a line underneath (an ID, an email, a role). */
export function PersonCell({
  name,
  subtitle,
  src,
  size = 'sm',
  className,
}: {
  name: string;
  subtitle?: ReactNode;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <Avatar name={name} src={src} size={size} />
      <div className="min-w-0">
        <p className="truncate font-medium leading-tight">{name}</p>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('skeleton rounded-lg', className)} {...rest} />;
}

/** Nothing to show yet: say so kindly, and say what to do about it. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted ring-1 ring-inset ring-line">
        {icon ?? <InboxIcon className="h-7 w-7" />}
      </span>
      <div>
        <p className="font-semibold tracking-tight">{title}</p>
        {children ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

const NOTICE_ICON: Record<'info' | 'success' | 'warning' | 'danger', AppIcon> = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: AlertIcon,
  danger: AlertCircleIcon,
};

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
    info: 'border-info-solid/25 bg-info-soft text-info',
    success: 'border-success-solid/25 bg-success-soft text-success',
    warning: 'border-warning-solid/30 bg-warning-soft text-warning',
    danger: 'border-danger-solid/25 bg-danger-soft text-danger',
  } as const;
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
        tones[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 h-5 w-5" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5' : ''}>{children}</div> : null}
      </div>
    </div>
  );
}
