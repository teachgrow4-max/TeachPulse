import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { DailyAttendanceReport, DailyAttendanceRow, DailyRowState } from '@teachgrow/shared';
import { api, messageOf } from '../lib/api';
import { formatTime, formatWorkDate } from '../lib/format';
import { useMediaQuery } from '../lib/hooks';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Button, buttonClass } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/form';
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  DownloadIcon,
  HistoryIcon,
  ScanIcon,
  SearchOffIcon,
  UsersIcon,
} from '../components/ui/icons';
import { EmptyState, Notice, PersonCell, Skeleton } from '../components/ui/misc';
import { PageContainer, PageHeader } from '../components/ui/page';
import { Segmented } from '../components/ui/segmented';
import { StatCard, StatCardSkeleton } from '../components/ui/stat-card';
import { Table, TableScroll, Tbody, Td, Th, Thead, Tr } from '../components/ui/table';

/**
 * The administrator's attendance dashboard: who is in, who is late, who is absent, when each person
 * checked in, and the warnings from the scanner. Read-only. The scan history is its own page.
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

export function AttendancePage() {
  const [date, setDate] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const wide = useMediaQuery('(min-width: 768px)', true);

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
  const warned =
    data !== undefined &&
    (data.warnings.duplicateScans > 0 || data.warnings.invalidOrExpiredScans > 0);

  return (
    <PageContainer>
      <PageHeader
        title="Attendance Dashboard"
        description="Who is in, who is late and who is absent, for today or any day, with the warnings from the scanner."
        actions={
          <>
            <Button
              variant="outline"
              disabled={!data || data.rows.length === 0}
              onClick={() => data && download(data)}
            >
              <DownloadIcon className="h-4 w-4" /> Download CSV
            </Button>
            <Link to="/scanner" className={buttonClass({ variant: 'primary' })}>
              <ScanIcon className="h-4 w-4" /> Scan Employee QR
            </Link>
          </>
        }
      />

      {report.isError ? (
        <Notice tone="danger" title="The report could not be loaded">
          {messageOf(report.error)}
        </Notice>
      ) : null}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data ? (
          <>
            <StatCard
              label="Present"
              value={data.summary.present}
              hint={`of ${data.summary.total} tracked`}
              icon={CheckCircleIcon}
              tone="success"
            />
            <StatCard
              label="Late arrivals"
              value={data.summary.late}
              hint="Included in present"
              icon={ClockIcon}
              tone="warning"
            />
            <StatCard
              label="Absent"
              value={data.summary.absent}
              hint="No check-in recorded"
              icon={AlertCircleIcon}
              tone="danger"
            />
            <StatCard
              label="On leave"
              value={data.summary.onLeave}
              hint="Approved leave"
              icon={UsersIcon}
              tone="info"
            />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <StatCardSkeleton key={i} />)
        )}
      </section>

      {warned ? (
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
          <Link
            to="/admin/scan-history"
            className="mt-1.5 inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
          >
            <HistoryIcon className="h-4 w-4" /> See the scan history
          </Link>
        </Notice>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 sm:p-5">
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'Everyone', count: data?.summary.total },
              { value: 'PRESENT', label: 'Present', count: data?.summary.present },
              { value: 'LATE', label: 'Late', count: data?.summary.late },
              { value: 'ABSENT', label: 'Absent', count: data?.summary.absent },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            {date ? (
              <Button variant="ghost" size="sm" onClick={() => setDate('')}>
                Back to today
              </Button>
            ) : null}
            <Input
              type="date"
              aria-label="Date"
              className="w-44"
              value={date || data?.date || ''}
              max={data?.isToday && !date ? data.date : undefined}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        {data ? (
          <p className="border-b border-line px-4 py-2.5 text-sm text-muted sm:px-5">
            {formatWorkDate(data.date)}
            {data.isToday ? ' · live, refreshed every 30 seconds' : ''}
          </p>
        ) : null}

        {report.isLoading ? (
          <div className="space-y-4 p-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : data && rows.length > 0 ? (
          wide ? (
            <TableScroll>
              <Table>
                <caption className="sr-only">Attendance for {formatWorkDate(data.date)}</caption>
                <Thead>
                  <tr>
                    <Th>Employee</Th>
                    <Th>Department</Th>
                    <Th>Status</Th>
                    <Th>Check-in</Th>
                    <Th>Check-out</Th>
                  </tr>
                </Thead>
                <Tbody>
                  {rows.map((row) => (
                    <Tr key={row.employeeId}>
                      <Td>
                        <PersonCell
                          name={row.fullName}
                          subtitle={<span className="font-mono">{row.employeeCode}</span>}
                        />
                      </Td>
                      <Td className="text-muted">{row.department ?? '—'}</Td>
                      <Td>
                        <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
                      </Td>
                      <Td className="tabular-nums">{formatTime(row.checkInAt)}</Td>
                      <Td className="tabular-nums">{formatTime(row.checkOutAt)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </TableScroll>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.employeeId} className="flex flex-col gap-2.5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <PersonCell
                      name={row.fullName}
                      subtitle={`${row.employeeCode}${row.department ? ` · ${row.department}` : ''}`}
                    />
                    <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
                  </div>
                  <p className="text-xs text-muted tabular-nums">
                    In {formatTime(row.checkInAt)} · Out {formatTime(row.checkOutAt)}
                  </p>
                </li>
              ))}
            </ul>
          )
        ) : data ? (
          <EmptyState title="Nobody to show" icon={<SearchOffIcon className="h-7 w-7" />}>
            {data.rows.length === 0
              ? 'No employees are tracked for attendance yet.'
              : 'No employees match this filter.'}
          </EmptyState>
        ) : null}
      </Card>
    </PageContainer>
  );
}
