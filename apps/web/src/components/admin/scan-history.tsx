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
import { useMediaQuery } from '../../lib/hooks';
import { outcomeText, STATUS_LABEL, statusTone } from '../../lib/scan-labels';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field, Input, Select } from '../ui/form';
import { HistoryIcon, SearchOffIcon } from '../ui/icons';
import { EmptyState, Notice, PersonCell, Skeleton } from '../ui/misc';
import { Pager } from '../ui/pager';
import { Table, TableScroll, Tbody, Td, Th, Thead, Tr } from '../ui/table';
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

/** Everything that was scanned: who, what became of it, and which operator was holding the camera. */
export function ScanHistory({
  initialEmployee = null,
}: {
  initialEmployee?: PickedEmployee | null;
}) {
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, employee: initialEmployee });
  const [page, setPage] = useState(1);
  // The table needs about 800 px; below that, each scan is a card.
  const wide = useMediaQuery('(min-width: 1100px)', true);
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
    <div className="flex flex-col gap-5">
      <Card className="p-4 sm:p-5">
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Filter the scan history"
        >
          <EmployeePicker value={filters.employee} onChange={(employee) => change({ employee })} />
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
                {SCAN_DISPLAY_STATUSES.filter(
                  (status) => status !== 'PENDING' && status !== 'EXPIRED',
                ).map((status) => (
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
          <p>{messageOf(history.error)}</p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            loading={history.isFetching}
            onClick={() => void history.refetch()}
          >
            Try again
          </Button>
        </Notice>
      ) : null}

      {/* when the first load failed there is nothing to show: the message above says so */}
      <Card hidden={history.isError && !history.data}>
        {history.isLoading ? (
          <div className="space-y-4 p-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-44" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : history.data && history.data.items.length > 0 ? (
          <>
            {wide ? (
              <TableScroll>
                <Table>
                  <caption className="sr-only">QR scan history</caption>
                  <Thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Employee</Th>
                      <Th>Outcome</Th>
                      <Th>Recorded by</Th>
                      <Th>Device</Th>
                    </tr>
                  </Thead>
                  <Tbody>
                    {history.data.items.map((scan) => (
                      <Tr key={scan.id}>
                        <Td className="whitespace-nowrap tabular-nums">
                          {formatDateTime(scan.scannedAt)}
                        </Td>
                        <Td>
                          {scan.employee ? (
                            <PersonCell
                              name={scan.employee.fullName}
                              subtitle={
                                <span className="font-mono">{scan.employee.employeeCode}</span>
                              }
                              src={scan.employee.avatarUrl}
                            />
                          ) : (
                            <span className="text-muted">Unknown code</span>
                          )}
                        </Td>
                        <Td>
                          <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                        </Td>
                        <Td>
                          <PersonCell
                            name={scan.scannedBy.fullName}
                            subtitle={ROLE_LABEL[scan.scannedBy.role] ?? scan.scannedBy.role}
                            src={scan.scannedBy.avatarUrl}
                          />
                        </Td>
                        <Td>
                          <p>{scan.scanner.label ?? '—'}</p>
                          {scan.clientIp ? (
                            <p className="font-mono text-xs text-muted">{scan.clientIp}</p>
                          ) : null}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </TableScroll>
            ) : (
              <ul className="divide-y divide-line">
                {history.data.items.map((scan) => (
                  <li key={scan.id} className="flex flex-col gap-2.5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <PersonCell
                        name={scan.employee ? scan.employee.fullName : 'Unknown code'}
                        subtitle={formatDateTime(scan.scannedAt)}
                        src={scan.employee?.avatarUrl}
                      />
                      <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                    </div>
                    <p className="text-xs text-muted">
                      Recorded by {scan.scannedBy.fullName} ·{' '}
                      {scan.scanner.label ?? 'unknown device'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line px-4 pb-4 sm:px-5">
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
            icon={
              filtered ? <SearchOffIcon className="h-7 w-7" /> : <HistoryIcon className="h-7 w-7" />
            }
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
