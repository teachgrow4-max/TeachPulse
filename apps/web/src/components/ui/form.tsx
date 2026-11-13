import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { ChevronDownIcon, SearchIcon, XIcon } from './icons';

const control =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 text-fg shadow-card ' +
  'placeholder:text-muted transition-[border-color,box-shadow] duration-150 hover:border-muted/60 ' +
  'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 ' +
  'disabled:opacity-60 aria-[invalid=true]:border-danger-solid aria-[invalid=true]:focus-visible:ring-danger-solid/15';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-11 text-sm sm:h-10', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-24 py-2.5 text-sm', className)} {...rest} />;
}

/**
 * The browser's own select, dressed to match: the best experience on a phone (the system picker),
 * and fully accessible. `className` styles the wrapper, so it can set a width.
 */
export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(control, 'h-11 appearance-none pr-10 text-sm sm:h-10')} {...rest}>
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

/** A text box with a magnifier inside, and a clear button once something is typed. */
export function SearchInput({
  className,
  value,
  onClear,
  ...rest
}: Omit<ComponentProps<'input'>, 'type'> & { onClear?: () => void }) {
  return (
    <div className={cn('relative', className)}>
      <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <Input
        type="text"
        inputMode="search"
        autoComplete="off"
        value={value}
        className="pl-10 pr-10"
        {...rest}
      />
      {onClear && value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <XIcon className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

/** A label, the control, and a hint or error, wired together for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error || hint ? `${id}-note` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <p id={`${id}-note`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-note`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
