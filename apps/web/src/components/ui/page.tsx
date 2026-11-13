import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

const WIDTH = {
  sm: 'max-w-2xl',
  md: 'max-w-4xl',
  lg: 'max-w-6xl',
} as const;

/** The column every page sits in: a comfortable width, with the same gutters and rhythm everywhere. */
export function PageContainer({
  children,
  width = 'lg',
  className,
}: {
  children: ReactNode;
  width?: keyof typeof WIDTH;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8',
        WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A page's title, a line saying what it is for, and its main actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.7rem] sm:leading-9">
          {title}
        </h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
