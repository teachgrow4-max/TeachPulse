import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { AppIcon } from './icons';

/**
 * A dropdown menu: the "…" at the end of a table row, the account menu. Radix does the keyboard
 * handling (arrow keys, type-ahead, Escape, focus returning to the button) and the positioning.
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  className,
}: {
  /** The button that opens the menu. Pass a real `<Button>` (or any button): it is used as is. */
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'menu-panel z-50 min-w-52 max-w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-line',
            'bg-surface p-1.5 text-fg shadow-pop focus:outline-none',
            className,
          )}
        >
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export function MenuItem({
  icon: Icon,
  tone = 'default',
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof RadixMenu.Item>, 'children'> & {
  icon?: AppIcon;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  return (
    <RadixMenu.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium outline-none',
        'transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        tone === 'danger'
          ? 'text-danger data-[highlighted]:bg-danger-soft'
          : 'data-[highlighted]:bg-surface-2',
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon className="h-4 w-4 text-muted" /> : null}
      {children}
    </RadixMenu.Item>
  );
}

export function MenuLabel({ className, ...rest }: ComponentProps<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cn('px-3 py-2 text-xs text-muted', className)} {...rest} />;
}

export function MenuSeparator({ className, ...rest }: ComponentProps<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cn('-mx-1.5 my-1.5 h-px bg-line', className)} {...rest} />;
}
