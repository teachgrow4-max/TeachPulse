import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * Table building blocks, so every table in the app has the same quiet look: a tinted header row with
 * small capitals, generous row height, a hairline between rows and a soft highlight under the pointer.
 */

export function TableScroll({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('overflow-x-auto', className)} {...rest} />;
}

export function Table({ className, ...rest }: ComponentProps<'table'>) {
  return <table className={cn('w-full text-left text-sm', className)} {...rest} />;
}

export function Thead({ className, ...rest }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-line bg-surface-2/60', className)} {...rest} />;
}

export function Th({ className, ...rest }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted',
        'first:pl-5 last:pr-5',
        className,
      )}
      {...rest}
    />
  );
}

export function Tbody({ className, ...rest }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line', className)} {...rest} />;
}

export function Tr({ className, ...rest }: ComponentProps<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-2/50', className)} {...rest} />;
}

export function Td({ className, ...rest }: ComponentProps<'td'>) {
  return (
    <td className={cn('px-4 py-3.5 align-middle first:pl-5 last:pr-5', className)} {...rest} />
  );
}
