import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { DailyAttendanceReport, DailyAttendanceRow, DailyRowState } from '@teachgrow/shared';
import { api, messageOf } from '../lib/api';
import { formatTime, formatWorkDate } from '../lib/format';
import { cn } from '../lib/utils';
import { ScanHistory } from '../components/admin/scan-history';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/form';
import { DownloadIcon, HistoryIcon, ScanIcon, UserIcon } from '../components/ui/icons';
import { EmptyState, Notice, Skeleton } from '../components/ui/misc';

/**
 * The administrator's attendance dashboard: who is in, who is late, who is absent, when each person
 * checked in, the warnings from the scanner, and the scan history. Read-only.
 */

const STATE_LABEL: Record<DailyRowState, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
};

const STATE_TONE: Record<DailyRowState, BadgeTone> = {
  PRESENT: 'success',
  LATE: 'warning',
  ABSENT: 'danger',
  ON_LEAVE: 'info',
  HOLIDAY: 'neutral',
  WEEKLY_OFF: 'neutral',
};

type Filter = 'ALL' | 'PRESENT' | 'LATE' | 'ABSENT';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'ALL', label: 'Everyone' },
  { id: 'PRESENT', label: 'Present' },
  { id: 'LATE', label: 'Late' },
  { id: 'ABSENT', label: 'Absent' },
];

const matches = (row: DailyAttendanceRow, filter: Filter): boolean =>
  filter === 'ALL' ||
  (filter === 'PRESENT' ? row.state === 'PRESENT' || row.state === 'LATE' : row.state === filter);

function hours(seconds: number | null): string {
  if (seconds === null) return '';
  return (seconds / 3600).toFixed(2);
}

function csvCell(value: string): string {
  // A cell that starts like a formula is read as one by spreadsheet programs; keep it text.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(report: DailyAttendanceReport): string {
  const head = [
    'Employee ID',
    'Name',
    'Department',
    'Status',
    'Check-in',
    'Check-out',
    'Net hours',
    'Recorded by',
  ];
  const time = (iso: string | null) => (iso ? new Date(iso).toISOString() : '');
  const lines = report.rows.map((row) =>
    [
      row.employeeCode,
      row.fullName,
      row.department ?? '',
      STATE_LABEL[row.state],
      time(row.checkInAt),
      time(row.checkOutAt),
      hours(row.netWorkSeconds),
      row.source === 'ADMIN_QR' ? 'QR scan' : (row.source ?? ''),
    ]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\n');
}

function download(report: DailyAttendanceReport): void {
  const url = URL.createObjectURL(new Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `attendance-${report.date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Tile({ label, value, tone }: { label: string; value: number; tone: BadgeTone }) {
  const ring: Record<BadgeTone, string> = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    info: 'text-info',
    neutral: 'text-fg',
    brand: 'text-fg',
  } as Record<BadgeTone, string>;
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('mt-0.5 text-3xl font-extrabold tabular-nums', ring[tone])}>{value}</p>
    </Card>
  );
}

function DailyReport() {
  const [date, setDate] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [, setParams] = useSearchParams();

  const report = useQuery({
    queryKey: ['attendance-daily', date || 'today'],
    queryFn: () =>
      api<DailyAttendanceReport>(`/api/admin/attendance/daily${date ? `?date=${date}` : ''}`),
    // Today changes as people are scanned in.
    refetchInterval: date === '' ? 30_000 : false,
  });
  const data = report.data;
  const rows = useMemo(
    () => data?.rows.filter((row) => matches(row, filter)) ?? [],
    [data, filter],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Date" className="w-48">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={date || data?.date || ''}
              max={data?.isToday && !date ? data.date : undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        {date ? (
          <Button variant="ghost" onClick={() => setDate('')}>
            Back to today
          </Button>
        ) : null}
        <Button
          variant="outline"
          className="ml-auto"
          disabled={!data || data.rows.length === 0}
          onClick={() => data && download(data)}
        >
          <DownloadIcon className="h-4 w-4" /> Download CSV
        </Button>
      </div>

      {report.isError ? (
        <Notice tone="danger" title="The report could not be loaded">
          {messageOf(report.error)}
        </Notice>
      ) : null}

      {report.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : data ? (
        <>
          <p className="text-sm text-muted">
            {formatWorkDate(data.date)}
            {data.isToday ? ' · live, refreshed every 30 seconds' : ''}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Present" value={data.summary.present} tone="success" />
            <Tile label="Late arrivals" value={data.summary.late} tone="warning" />
            <Tile label="Absent" value={data.summary.absent} tone="danger" />
            <Tile label="On leave" value={data.summary.onLeave} tone="info" />
          </div>

          {data.warnings.duplicateScans > 0 || data.warnings.invalidOrExpiredScans > 0 ? (
            <Notice tone="warning" title="Scan warnings for this day">
              <ul className="list-disc pl-5">
                {data.warnings.duplicateScans > 0 ? (
                  <li>
                    {data.warnings.duplicateScans} duplicate scan
                    {data.warnings.duplicateScans === 1 ? '' : 's'} (a code that was already used)
                  </li>
                ) : null}
                {data.warnings.invalidOrExpiredScans > 0 ? (
                  <li>
                    {data.warnings.invalidOrExpiredScans} invalid or expired code
                    {data.warnings.invalidOrExpiredScans === 1 ? '' : 's'}
                  </li>
                ) : null}
              </ul>
              <button
                type="button"
                className="mt-1 font-semibold underline underline-offset-4"
                onClick={() => setParams({ tab: 'history' }, { replace: true })}
              >
                See the scan history
              </button>
            </Notice>
          ) : null}

          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors',
                  filter === id
                    ? 'border-brand bg-brand text-brand-fg'
                    : 'border-line bg-surface text-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <Card className="overflow-hidden">
            {rows.length === 0 ? (
              <EmptyState title="Nobody to show" icon={<UserIcon className="h-8 w-8" />}>
                {data.rows.length === 0
                  ? 'No employees are tracked for attendance yet.'
                  : 'No employees match this filter.'}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Employee
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Department
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Check-in
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Check-out
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.employeeId}>
                        <td className="px-4 py-3">
                          <p className="font-semibold">{row.fullName}</p>
                          <p className="font-mono text-xs text-muted">{row.employeeCode}</p>
                        </td>
                        <td className="px-4 py-3 text-muted">{row.department ?? '—'}</td>
                        <td className="px-4 py-3">
                          <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
                        </td>
                        <td className="px-4 py-3 tabular-nums">{formatTime(row.checkInAt)}</td>
                        <td className="px-4 py-3 tabular-nums">{formatTime(row.checkOutAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

type Tab = 'daily' | 'history';

export function AttendancePage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'daily';
  const tabs: Array<{ id: Tab; label: string; icon: typeof UserIcon }> = [
    { id: 'daily', label: 'Daily report', icon: UserIcon },
    { id: 'history', label: 'Scan history', icon: HistoryIcon },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Attendance management</h1>
          <p className="text-sm text-muted">
            Who is in, who is late, who is absent, and every QR scan.
          </p>
        </div>
        <Link
          to="/scanner"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90"
        >
          <ScanIcon className="h-5 w-5" /> Scan Employee QR
        </Link>
      </div>
      <div
        role="tablist"
        aria-label="Attendance views"
        className="mb-5 inline-flex rounded-xl bg-surface-2 p-1"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setParams(id === 'daily' ? {} : { tab: id }, { replace: true })}
            className={cn(
              'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
              tab === id ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'daily' ? <DailyReport /> : <ScanHistory />}
      </div>
    </div>
  );
}
