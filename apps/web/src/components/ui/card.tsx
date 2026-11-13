import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/** A white surface with a hairline border and a very soft shadow. `interactive` lifts it on hover. */
export function Card({
  className,
  interactive = false,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-line bg-surface shadow-card',
        interactive && 'hover-lift',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3 sm:p-6 sm:pb-3', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-base font-semibold leading-tight tracking-tight', className)}
      {...rest}
    />
  );
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-2 sm:p-6 sm:pt-2', className)} {...rest} />;
}
