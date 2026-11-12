import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { XIcon } from './icons';

/**
 * A modal dialog. Radix does the hard parts (focus trap, Escape, returning focus, hiding the page
 * from screen readers); this gives it the app's look.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={cn(
            'pop-in fixed left-1/2 top-1/2 z-50 flex max-h-[min(92dvh,48rem)] w-[calc(100vw-1.5rem)]',
            'max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line',
            'bg-surface text-fg shadow-card focus:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 p-5 pb-3">
            <div className="min-w-0">
              <RadixDialog.Title className="text-lg font-semibold leading-tight">
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
            <RadixDialog.Close
              className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Close"
            >
              <XIcon />
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
