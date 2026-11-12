import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QR_FILTER_STATES,
  type AdminEmployeeQrRow,
  type BackfillQrResponse,
  type DepartmentDto,
  type Paginated,
} from '@teachgrow/shared';
import { api, messageOf } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { cn } from '../lib/utils';
import { QrDialog } from '../components/admin/qr-dialog';
import { ScanHistory } from '../components/admin/scan-history';
import { Badge, type BadgeTone } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input, Select } from '../components/ui/form';
import { HistoryIcon, QrIcon, SearchIcon } from '../components/ui/icons';
import { Avatar, EmptyState, Notice, Skeleton } from '../components/ui/misc';
import { Pager } from '../components/ui/pager';
import { useToast } from '../components/ui/toast';

const PAGE_SIZE = 25;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  attendance_operator: 'Operator',
  employee: 'Employee',
};

const QR_STATE: Record<AdminEmployeeQrRow['qr']['status'], { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  REVOKED: { label: 'Revoked', tone: 'danger' },
  NONE: { label: 'No code', tone: 'neutral' },
};

const FILTER_LABEL: Record<(typeof QR_FILTER_STATES)[number], string> = {
  ACTIVE: 'Active code',
  REVOKED: 'Revoked code',
  NONE: 'No code yet',
};

type Tab = 'employees' | 'history';

function EmployeesTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [qrStatus, setQrStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(search.trim(), 300);

  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ items: DepartmentDto[] }>('/api/admin/departments'),
    select: (data) => data.items,
    staleTime: 5 * 60_000,
  });

  const list = useQuery({
    queryKey: ['employee-qr', 'list', q, qrStatus, departmentId, page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (q) params.set('search', q);
      if (qrStatus) params.set('qrStatus', qrStatus);
      if (departmentId) params.set('departmentId', departmentId);
      return api<Paginated<AdminEmployeeQrRow>>(`/api/admin/employee-qr?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const backfill = useMutation({
    mutationFn: () =>
      api<BackfillQrResponse>('/api/admin/employee-qr/backfill', { method: 'POST', body: {} }),
    onSuccess: async ({ issued }) => {
      toast.show({
        tone: 'success',
        title:
          issued === 0
            ? 'Everyone already has a code'
            : `${issued} new ${issued === 1 ? 'code' : 'codes'} issued`,
      });
      await queryClient.invalidateQueries({ queryKey: ['employee-qr'] });
    },
    onError: (error) =>
      toast.show({ tone: 'danger', title: 'Could not issue codes', text: messageOf(error) }),
  });

  const reset =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))_auto]"
          onSubmit={(event) => event.preventDefault()}
          role="search"
          aria-label="Find an employee"
        >
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input
              type="search"
              aria-label="Search employees"
              placeholder="Search by name, ID or email"
              className="pl-9"
              value={search}
              onChange={(event) => reset(setSearch)(event.target.value)}
            />
          </div>
          <Select
            aria-label="Filter by QR code"
            value={qrStatus}
            onChange={(e) => reset(setQrStatus)(e.target.value)}
          >
            <option value="">Any code status</option>
            {QR_FILTER_STATES.map((state) => (
              <option key={state} value={state}>
                {FILTER_LABEL[state]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by department"
            value={departmentId}
            onChange={(e) => reset(setDepartmentId)(e.target.value)}
          >
            <option value="">All departments</option>
            {departments.data?.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Button variant="outline" loading={backfill.isPending} onClick={() => backfill.mutate()}>
            <QrIcon /> Issue missing codes
          </Button>
        </form>
      </Card>

      {list.isError ? (
        <Notice tone="danger" title="The list could not be loaded">
          {messageOf(list.error)}
        </Notice>
      ) : null}

      <Card>
        {list.isLoading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.data && list.data.items.length > 0 ? (
          <>
            <ul className="divide-y divide-line">
              {list.data.items.map((row) => {
                const state = QR_STATE[row.qr.status];
                return (
                  <li
                    key={row.employee.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3',
                      !row.employee.isActive && 'opacity-70',
                    )}
                  >
                    <Avatar name={row.employee.fullName} className="h-11 w-11 text-sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {row.employee.fullName}
                        {!row.employee.isActive ? (
                          <span className="ml-2 text-xs font-normal text-muted">(inactive)</span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted">
                        <span className="font-mono">{row.employee.employeeCode}</span>
                        {' · '}
                        {ROLE_LABEL[row.employee.role] ?? row.employee.role}
                        {row.employee.department ? ` · ${row.employee.department}` : ''}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        Last scanned: {row.lastScanAt ? formatDateTime(row.lastScanAt) : 'never'}
                      </p>
                    </div>
                    <Badge tone={state.tone} className="hidden sm:inline-flex">
                      {state.label}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenId(row.employee.id)}
                      aria-label={`View QR code for ${row.employee.fullName}`}
                    >
                      <QrIcon className="h-4 w-4" />
                      <span className="hidden sm:inline">View QR</span>
                      <Badge tone={state.tone} className="sm:hidden">
                        {state.label}
                      </Badge>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-line px-3 pb-3">
              <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={list.data.total}
                onPage={setPage}
                busy={list.isFetching}
              />
            </div>
          </>
        ) : (
          <EmptyState title="No employees match" icon={<SearchIcon className="h-8 w-8" />}>
            Try a different name, or clear a filter.
          </EmptyState>
        )}
      </Card>

      <QrDialog employeeId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

/** The administrator's home for QR codes: who has one, their history, and every scan made. */
export function QrManagementPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'employees';
  const select = (next: Tab) =>
    setParams(next === 'employees' ? {} : { tab: next }, { replace: true });

  const tabs: Array<{ id: Tab; label: string; icon: typeof QrIcon }> = [
    { id: 'employees', label: 'Employee codes', icon: QrIcon },
    { id: 'history', label: 'Scan history', icon: HistoryIcon },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5">
      <h1 className="text-2xl font-bold">QR management</h1>
      <p className="mb-4 mt-1 text-sm text-muted">
        View, download, regenerate or revoke employees’ QR codes, and see every scan that was made.
      </p>

      <div
        role="tablist"
        aria-label="QR management"
        className="mb-4 inline-flex rounded-xl bg-surface-2 p-1"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                select(tab === 'employees' ? 'history' : 'employees');
              }
            }}
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
        {tab === 'employees' ? <EmployeesTab /> : <ScanHistory />}
      </div>
    </div>
  );
}
