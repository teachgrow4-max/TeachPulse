import { useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EmployeeDto, Paginated } from '@teachgrow/shared';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Input } from '../ui/form';
import { SearchIcon, XIcon } from '../ui/icons';
import { Avatar } from '../ui/misc';

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
      api<Paginated<EmployeeDto>>(
        `/api/admin/employees?pageSize=8&search=${encodeURIComponent(search)}`,
      ),
    enabled: open && search.length > 0,
    placeholderData: keepPreviousData,
  });
  const items = search ? (results.data?.items ?? []) : [];

  function choose(person: EmployeeDto) {
    onChange({ id: person.id, label: `${person.fullName} (${person.employeeCode})` });
    setText('');
    setOpen(false);
  }

  if (value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex h-11 items-center justify-between gap-2 rounded-xl border border-line-strong bg-surface px-3.5 text-sm shadow-card sm:h-10">
          <span className="truncate font-medium">{value.label}</span>
          <button
            type="button"
            className="rounded-lg p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
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
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
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
          className="pl-10"
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
          className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-72 overflow-auto rounded-2xl border border-line bg-surface p-1.5 shadow-pop"
        >
          {items.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted" role="presentation">
              {results.isFetching ? 'Searching…' : 'No one matches that.'}
            </li>
          ) : (
            items.map((person, index) => (
              <li
                key={person.id}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm',
                  index === active ? 'bg-brand-soft' : 'hover:bg-surface-2',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(person);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <Avatar name={person.fullName} src={person.avatarUrl} size="xs" />
                <span className="min-w-0 truncate font-medium">{person.fullName}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted">
                  {person.employeeCode}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
