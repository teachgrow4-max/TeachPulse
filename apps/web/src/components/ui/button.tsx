import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
import { SpinnerIcon } from './icons';

const button = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-xl font-medium select-none whitespace-nowrap',
    'transition-[background-color,color,border-color,box-shadow,opacity,transform] duration-150',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-brand text-brand-fg shadow-card hover:bg-brand-strong hover:shadow-lift active:shadow-card',
        soft: 'bg-brand-soft text-brand hover:bg-brand-soft/70',
        secondary: 'bg-surface-2 text-fg hover:bg-surface-3',
        outline: 'border border-line-strong bg-surface text-fg shadow-card hover:bg-surface-2',
        ghost: 'text-fg hover:bg-surface-2',
        danger: 'bg-danger-solid text-on-solid shadow-card hover:opacity-90',
        success: 'bg-success-solid text-on-solid shadow-card hover:opacity-90',
        warning: 'bg-warning-solid text-on-solid shadow-card hover:opacity-90',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm sm:h-10',
        lg: 'h-12 px-6 text-base',
        xl: 'h-14 px-8 text-base font-semibold tracking-tight',
        icon: 'h-10 w-10 shrink-0 p-0',
        'icon-sm': 'h-9 w-9 shrink-0 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  /** Shows a spinner and blocks clicks while something is happening. */
  loading?: boolean;
}

/** The look of a button, for a link (`<Link className={buttonClass()}>`) that should read as one. */
export const buttonClass = (props?: VariantProps<typeof button>, className?: string): string =>
  cn(button(props), className);

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <SpinnerIcon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}
