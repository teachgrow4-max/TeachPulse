import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  SCAN_DISPLAY_STATUSES,
  type EmployeeDto,
  type Paginated,
  type ScanLogDto,
} from '@teachgrow/shared';
import { api, messageOf } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { outcomeText, STATUS_LABEL, statusTone } from '../../lib/scan-labels';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field, Input, Select } from '../ui/form';
import { HistoryIcon } from '../ui/icons';
import { EmptyState, Notice, Skeleton } from '../ui/misc';
import { Pager } from '../ui/pager';
import { EmployeePicker, type PickedEmployee } from './employee-picker';

const PAGE_SIZE = 25;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  attendance_operator: 'Operator',
  employee: 'Employee',
};

interface Filters {
  from: string;
  to: string;
  employee: PickedEmployee | null;
  scannedBy: string;
  status: string;
}
const NO_FILTERS: Filters = { from: '', to: '', employee: null, scannedBy: '', status: '' };

function queryString(filters: Filters, page: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.employee) params.set('employeeId', filters.employee.id);
  if (filters.scannedBy) params.set('scannedBy', filters.scannedBy);
  if (filters.status) params.set('status', filters.status);
  return params.toString();
}

function VerificationBadge({ result }: { result: ScanLogDto['officeVerification'] }) {
  if (!result) return <span className="text-muted">—</span>;
  return result === 'VERIFIED' ? (
    <Badge tone="success">Verified</Badge>
  ) : (
    <Badge tone="danger">Rejected</Badge>
  );
}

/** Everything that was scanned: who, what became of it, and which operator was holding the camera. */
export function ScanHistory() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const change = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const scanners = useQuery({
    queryKey: ['staff', 'scanners'],
    queryFn: async () => {
      const [admins, operators] = await Promise.all([
        api<Paginated<EmployeeDto>>('/api/admin/employees?role=admin&status=all&pageSize=200'),
        api<Paginated<EmployeeDto>>(
          '/api/admin/employees?role=attendance_operator&status=all&pageSize=200',
        ),
      ]);
      return [...admins.items, ...operators.items];
    },
    staleTime: 60_000,
  });

  const history = useQuery({
    queryKey: [
      'qr-scans',
      filters.from,
      filters.to,
      filters.employee?.id,
      filters.scannedBy,
      filters.status,
      page,
    ],
    queryFn: () => api<Paginated<ScanLogDto>>(`/api/admin/qr-scans?${queryString(filters, page)}`),
    placeholderData: keepPreviousData,
  });

  const rangeError =
    filters.from && filters.to && filters.from > filters.to ? '“From” is after “to”.' : null;
  const filtered =
    filters.from || filters.to || filters.employee || filters.scannedBy || filters.status;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Filter the scan history"
        >
          <Field label="From" error={rangeError}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={filters.from}
                onChange={(e) => change({ from: e.target.value })}
              />
            )}
          </Field>
          <Field label="To">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={filters.to}
                onChange={(e) => change({ to: e.target.value })}
              />
            )}
          </Field>
          <EmployeePicker value={filters.employee} onChange={(employee) => change({ employee })} />
          <Field label="Recorded by">
            {(props) => (
              <Select
                {...props}
                value={filters.scannedBy}
                onChange={(e) => change({ scannedBy: e.target.value })}
              >
                <option value="">Everyone</option>
                {scanners.data?.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName} ({ROLE_LABEL[person.role] ?? person.role})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Outcome">
            {(props) => (
              <Select
                {...props}
                value={filters.status}
                onChange={(e) => change({ status: e.target.value })}
              >
                <option value="">All outcomes</option>
                {SCAN_DISPLAY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex items-end">
            <Button
              variant="outline"
              disabled={!filtered}
              onClick={() => {
                setFilters(NO_FILTERS);
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>
        </form>
      </Card>

      {history.isError ? (
        <Notice tone="danger" title="The history could not be loaded">
          {messageOf(history.error)}
        </Notice>
      ) : null}

      <Card>
        {history.isLoading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : history.data && history.data.items.length > 0 ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">QR scan history</caption>
                <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      When
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Employee
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Outcome
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Recorded by
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Office check
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Device
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.data.items.map((scan) => (
                    <tr key={scan.id}>
                      <td className="whitespace-nowrap px-4 py-3">
                        {formatDateTime(scan.scannedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {scan.employee ? (
                          <>
                            <p className="font-medium">{scan.employee.fullName}</p>
                            <p className="font-mono text-xs text-muted">
                              {scan.employee.employeeCode}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted">Unknown code</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{scan.scannedBy.fullName}</p>
                        <p className="text-xs text-muted">
                          {ROLE_LABEL[scan.scannedBy.role] ?? scan.scannedBy.role}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <VerificationBadge result={scan.officeVerification} />
                      </td>
                      <td className="px-4 py-3">
                        <p>{scan.scanner.label ?? '—'}</p>
                        {scan.clientIp ? (
                          <p className="font-mono text-xs text-muted">{scan.clientIp}</p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-line md:hidden">
              {history.data.items.map((scan) => (
                <li key={scan.id} className="flex flex-col gap-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">
                        {scan.employee ? scan.employee.fullName : 'Unknown code'}
                      </p>
                      <p className="text-xs text-muted">{formatDateTime(scan.scannedAt)}</p>
                    </div>
                    <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    Recorded by {scan.scannedBy.fullName} · {scan.scanner.label ?? 'unknown device'}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted">Office check</span>
                    <VerificationBadge result={scan.officeVerification} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-3 pb-3">
              <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={history.data.total}
                onPage={setPage}
                busy={history.isFetching}
              />
            </div>
          </>
        ) : (
          <EmptyState
            title={filtered ? 'No scans match these filters' : 'No scans yet'}
            icon={<HistoryIcon className="h-8 w-8" />}
          >
            {filtered
              ? 'Try widening the dates or clearing a filter.'
              : 'Scans appear here as soon as an operator reads a code.'}
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
