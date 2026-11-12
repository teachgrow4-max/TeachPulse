import { useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdminEmployeeQrRow, Paginated } from '@teachgrow/shared';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Input } from '../ui/form';
import { SearchIcon, XIcon } from '../ui/icons';

export interface PickedEmployee {
  id: string;
  label: string;
}

/**
 * Finds an employee by name, employee ID or email. Used to filter the scan history to one person.
 * It is a standard "combobox": type, use the arrow keys or the mouse, press Enter.
 */
export function EmployeePicker({
  value,
  onChange,
  label = 'Employee',
}: {
  value: PickedEmployee | null;
  onChange: (value: PickedEmployee | null) => void;
  label?: string;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = useDebounced(text.trim(), 250);

  const results = useQuery({
    queryKey: ['employee-picker', search],
    queryFn: () =>
      api<Paginated<AdminEmployeeQrRow>>(
        `/api/admin/employee-qr?pageSize=8&search=${encodeURIComponent(search)}`,
      ),
    enabled: open && search.length > 0,
    placeholderData: keepPreviousData,
  });
  const items = search ? (results.data?.items ?? []) : [];

  function choose(row: AdminEmployeeQrRow) {
    onChange({
      id: row.employee.id,
      label: `${row.employee.fullName} (${row.employee.employeeCode})`,
    });
    setText('');
    setOpen(false);
  }

  if (value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex h-11 items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 text-sm">
          <span className="truncate font-medium">{value.label}</span>
          <button
            type="button"
            className="rounded p-1 text-muted hover:text-fg"
            aria-label={`Clear ${label.toLowerCase()} filter`}
            onClick={() => {
              onChange(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          id={id}
          ref={input}
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={items[active] ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          placeholder="Name, ID or email"
          className="pl-9"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(items.length - 1, i + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (event.key === 'Enter' && items[active]) {
              event.preventDefault();
              choose(items[active]);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && search ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} matches`}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-xl border border-line bg-surface p-1 shadow-card"
        >
          {items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted" role="presentation">
              {results.isFetching ? 'Searching…' : 'No one matches that.'}
            </li>
          ) : (
            items.map((row, index) => (
              <li
                key={row.employee.id}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                className={cn(
                  'cursor-pointer rounded-lg px-3 py-2 text-sm',
                  index === active ? 'bg-brand-soft' : 'hover:bg-surface-2',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(row);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="font-medium">{row.employee.fullName}</span>{' '}
                <span className="font-mono text-xs text-muted">{row.employee.employeeCode}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
