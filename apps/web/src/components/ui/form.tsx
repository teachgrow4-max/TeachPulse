import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

const control =
  'w-full rounded-xl border border-line bg-surface px-3.5 text-fg placeholder:text-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ' +
  'disabled:opacity-60 aria-[invalid=true]:border-danger-solid';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-11 text-sm', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-24 py-2.5 text-sm', className)} {...rest} />;
}

/** The browser's own select: the best experience on a phone, and fully accessible. */
export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cn(control, 'h-11 text-sm', className)} {...rest}>
      {children}
    </select>
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
