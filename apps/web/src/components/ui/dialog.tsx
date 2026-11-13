import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { XIcon } from './icons';

const SIZE = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-xl',
  lg: 'sm:max-w-3xl',
} as const;

/**
 * A modal dialog. Radix does the hard parts (focus trap, Escape, returning focus, hiding the page
 * from screen readers); this gives it the app's look. On a phone it is a sheet that slides up from
 * the bottom edge, where a thumb can reach it; from the `sm` breakpoint up it is a centred card.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  size?: keyof typeof SIZE;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[3px]" />
        <RadixDialog.Content
          className={cn(
            'dialog-panel fixed z-50 flex max-h-[min(92dvh,46rem)] flex-col border border-line bg-surface',
            'text-fg shadow-pop focus:outline-none',
            // a bottom sheet on a phone ...
            'inset-x-0 bottom-0 w-full rounded-t-3xl',
            // ... a centred card from `sm` up
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-2rem)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl',
            SIZE[size],
            className,
          )}
        >
          <span
            aria-hidden="true"
            className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong sm:hidden"
          />
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <RadixDialog.Title className="text-lg font-semibold leading-tight tracking-tight">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm text-muted">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-2 -mt-1">
                <XIcon />
              </Button>
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">{children}</div>
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
