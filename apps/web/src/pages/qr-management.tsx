import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  QR_OVERVIEW_STATES,
  type DepartmentDto,
  type QrOverview,
  type QrOverviewRow,
  type QrOverviewState,
} from '@teachgrow/shared';
import { api, messageOf } from '../lib/api';
import { formatWhen, formatWorkDate } from '../lib/format';
import { useDebounced, useMediaQuery } from '../lib/hooks';
import { EmployeeQrDialog } from '../components/admin/employee-qr-dialog';
import { qrStateDetail, qrStateLook } from '../components/admin/qr-state';
import { Badge } from '../components/ui/badge';
import { Button, buttonClass } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input, SearchInput, Select } from '../components/ui/form';
import {
  AlertCircleIcon,
  CheckCircleIcon,
  EyeIcon,
  HistoryIcon,
  HourglassIcon,
  MoreIcon,
  QrIcon,
  RefreshIcon,
  SearchOffIcon,
  UsersIcon,
} from '../components/ui/icons';
import { Menu, MenuItem, MenuLabel } from '../components/ui/menu';
import { EmptyState, Notice, PersonCell, Skeleton } from '../components/ui/misc';
import { PageContainer, PageHeader } from '../components/ui/page';
import { Pager } from '../components/ui/pager';
import { StatCard, StatCardSkeleton } from '../components/ui/stat-card';
import { Table, TableScroll, Tbody, Td, Th, Thead, Tr } from '../components/ui/table';

/**
 * QR management for administrators: where every employee's attendance QR stands today (or on a day
 * you pick), who has not made one, whose ran out unscanned, and when each was last scanned.
 *
 * Codes are made by the employees themselves after they prove they are at the office, are shown only
 * to them, and only a hash is kept, so there is nothing here to view, print or reissue. What an
 * administrator needs is the picture this page gives, and the scan history behind it.
 */

const PAGE_SIZE = 15;

const STATE_FILTER_LABEL: Record<QrOverviewState, string> = {
  ACTIVE: 'Active',
  USED: 'Scanned',
  EXPIRED: 'Expired',
  NONE: 'Not generated',
};

interface Filters {
  search: string;
  departmentId: string;
  state: '' | QrOverviewState;
  date: string;
}
const NO_FILTERS: Filters = { search: '', departmentId: '', state: '', date: '' };

function StatusCell({ row }: { row: QrOverviewRow }) {
  const look = qrStateLook(row.state);
  return (
    <div className="min-w-0">
      <Badge tone={look.tone} dot={row.state === 'ACTIVE'}>
        {look.label}
      </Badge>
      <p className="mt-1 max-w-[16rem] truncate text-xs text-muted">{qrStateDetail(row)}</p>
    </div>
  );
}

function RowMenu({ row, onView }: { row: QrOverviewRow; onView: (row: QrOverviewRow) => void }) {
  const navigate = useNavigate();
  return (
    <Menu
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.fullName}`}>
          <MoreIcon />
        </Button>
      }
    >
      <MenuLabel>{row.fullName}</MenuLabel>
      <MenuItem icon={EyeIcon} onSelect={() => onView(row)}>
        View QR activity
      </MenuItem>
      <MenuItem
        icon={HistoryIcon}
        onSelect={() =>
          navigate(
            `/admin/scan-history?employee=${row.employeeId}&name=${encodeURIComponent(row.fullName)}`,
          )
        }
      >
        Open scan history
      </MenuItem>
    </Menu>
  );
}

export function QrManagementPage() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<QrOverviewRow | null>(null);
  // The table needs about 850 px; below that, each employee is a card.
  const wide = useMediaQuery('(min-width: 1100px)', true);
  const search = useDebounced(filters.search.trim(), 300);
  const change = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ items: DepartmentDto[] }>('/api/admin/departments'),
    select: (data) => data.items,
    staleTime: 5 * 60_000,
  });

  const overview = useQuery({
    queryKey: ['qr-overview', filters.date, search, filters.departmentId, filters.state, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (filters.date) params.set('date', filters.date);
      if (search) params.set('search', search);
      if (filters.departmentId) params.set('departmentId', filters.departmentId);
      if (filters.state) params.set('state', filters.state);
      return api<QrOverview>(`/api/admin/qr/overview?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
    // Today changes as employees make codes and are scanned in.
    refetchInterval: filters.date === '' ? 15_000 : false,
  });
  const data = overview.data;
  const when = data?.isToday === false ? 'that day' : 'today';
  const filtered = Boolean(filters.search || filters.departmentId || filters.state || filters.date);

  return (
    <PageContainer>
      <PageHeader
        title="QR Management"
        description="Manage employee QR credentials and monitor attendance scanning activity."
        actions={
          <>
            <Button
              variant="outline"
              loading={overview.isFetching && !overview.isLoading}
              onClick={() => void overview.refetch()}
            >
              {overview.isFetching && !overview.isLoading ? null : (
                <RefreshIcon className="h-4 w-4" />
              )}
              Refresh
            </Button>
            <Link to="/admin/scan-history" className={buttonClass({ variant: 'primary' })}>
              <HistoryIcon className="h-4 w-4" /> Scan history
            </Link>
          </>
        }
      />

      {overview.isError ? (
        <Notice tone="danger" title="QR management could not be loaded">
          <p>{messageOf(overview.error)}</p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            loading={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            Try again
          </Button>
        </Notice>
      ) : null}

      <section aria-label="QR summary" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {data ? (
          <>
            <StatCard
              className="col-span-2 lg:col-span-1"
              label="Total employees"
              value={data.summary.total}
              hint="Tracked for attendance"
              icon={UsersIcon}
              tone="brand"
            />
            <StatCard
              label="Active QR codes"
              value={data.summary.active}
              hint={`Live now · each lasts ${data.ttlSeconds} s`}
              icon={QrIcon}
              tone="success"
            />
            <StatCard
              label="Scanned"
              value={data.summary.used}
              hint="Attendance recorded"
              icon={CheckCircleIcon}
              tone="info"
            />
            <StatCard
              label="Missing QR codes"
              value={data.summary.none}
              hint={`No code made ${when}`}
              icon={AlertCircleIcon}
              tone="neutral"
            />
            <StatCard
              label="Expired codes"
              value={data.summary.expired}
              hint="Made but never scanned"
              icon={HourglassIcon}
              tone="warning"
            />
          </>
        ) : (
          [0, 1, 2, 3, 4].map((i) => <StatCardSkeleton key={i} />)
        )}
      </section>

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:p-5">
          <form
            aria-label="Filter employees"
            onSubmit={(event) => event.preventDefault()}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))]"
          >
            <SearchInput
              aria-label="Search employees"
              placeholder="Search name, employee ID or email"
              value={filters.search}
              onChange={(event) => change({ search: event.target.value })}
              onClear={() => change({ search: '' })}
              className="sm:col-span-2 lg:col-span-1"
            />
            <Select
              aria-label="Department"
              value={filters.departmentId}
              onChange={(event) => change({ departmentId: event.target.value })}
            >
              <option value="">All departments</option>
              {departments.data?.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="QR status"
              value={filters.state}
              onChange={(event) => change({ state: event.target.value as Filters['state'] })}
            >
              <option value="">All QR statuses</option>
              {QR_OVERVIEW_STATES.map((state) => (
                <option key={state} value={state}>
                  {STATE_FILTER_LABEL[state]}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              aria-label="Day"
              value={filters.date || data?.date || ''}
              max={data?.isToday && !filters.date ? data.date : undefined}
              onChange={(event) => change({ date: event.target.value })}
            />
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <p>
              {data ? (
                <>
                  {formatWorkDate(data.date)}
                  {data.isToday ? ' · live, refreshed every 15 seconds' : ''}
                  {' · '}
                  <span className="tabular-nums">{data.total}</span>{' '}
                  {data.total === 1 ? 'employee' : 'employees'}
                  {filtered ? ' match' : ''}
                </>
              ) : overview.isError ? null : (
                'Loading…'
              )}
            </p>
            {filtered ? (
              <Button variant="ghost" size="sm" onClick={() => change(NO_FILTERS)}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        {overview.isLoading ? (
          <div className="space-y-4 p-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : data && data.rows.length > 0 ? (
          <>
            {wide ? (
              <TableScroll>
                <Table>
                  <caption className="sr-only">Employees and the state of their QR code</caption>
                  <Thead>
                    <tr>
                      <Th>Employee</Th>
                      <Th>Employee ID</Th>
                      <Th>Department</Th>
                      <Th>QR status</Th>
                      <Th>Last scanned</Th>
                      <Th className="text-right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </Thead>
                  <Tbody>
                    {data.rows.map((row) => (
                      <Tr key={row.employeeId}>
                        <Td>
                          <PersonCell
                            name={row.fullName}
                            subtitle={row.email}
                            src={row.avatarUrl}
                          />
                        </Td>
                        <Td className="font-mono text-xs text-muted">{row.employeeCode}</Td>
                        <Td className="text-muted">{row.department ?? '—'}</Td>
                        <Td>
                          <StatusCell row={row} />
                        </Td>
                        <Td className="whitespace-nowrap text-muted">
                          {formatWhen(row.lastScannedAt)}
                        </Td>
                        <Td className="text-right">
                          <RowMenu row={row} onView={setOpen} />
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </TableScroll>
            ) : (
              <ul className="divide-y divide-line">
                {data.rows.map((row) => (
                  <li key={row.employeeId} className="flex flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <PersonCell
                        name={row.fullName}
                        subtitle={`${row.employeeCode}${row.department ? ` · ${row.department}` : ''}`}
                        src={row.avatarUrl}
                      />
                      <RowMenu row={row} onView={setOpen} />
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <StatusCell row={row} />
                      <p className="shrink-0 text-right text-xs text-muted">
                        Last scanned
                        <br />
                        <span className="font-medium text-fg">{formatWhen(row.lastScannedAt)}</span>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-line px-4 pb-4 sm:px-5">
              <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={data.total}
                onPage={setPage}
                busy={overview.isFetching}
              />
            </div>
          </>
        ) : overview.isError ? null : (
          <EmptyState
            title={filtered ? 'No employees match these filters' : 'No employees to show'}
            icon={<SearchOffIcon className="h-7 w-7" />}
            action={
              filtered ? (
                <Button variant="outline" onClick={() => change(NO_FILTERS)}>
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {filtered
              ? 'Try a different name, department or status.'
              : 'No employees are tracked for attendance yet. Add one to get started.'}
          </EmptyState>
        )}
      </Card>

      <EmployeeQrDialog row={open} date={data?.date ?? ''} onClose={() => setOpen(null)} />
    </PageContainer>
  );
}
