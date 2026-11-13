import { cn } from '../../lib/utils';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** A small number after the label (how many rows this choice would show). */
  count?: number;
}

/**
 * A row of mutually exclusive choices, drawn as one pill-shaped control: "Everyone / Present / Late".
 * Each choice is a toggle button, so a screen reader says which one is pressed.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<SegmentOption<T>>;
  /** What the group is for, read out by screen readers. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-surface-2 p-1 ring-1 ring-inset ring-line',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all',
              active ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  active ? 'bg-brand-soft text-brand' : 'bg-surface-3 text-muted',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
