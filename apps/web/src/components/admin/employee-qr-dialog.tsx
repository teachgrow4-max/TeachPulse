import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Paginated, QrOverviewRow, ScanLogDto } from '@teachgrow/shared';
import { api, messageOf } from '../../lib/api';
import { formatDateTime, formatWhen, formatWorkDate } from '../../lib/format';
import { outcomeText, statusTone } from '../../lib/scan-labels';
import { Badge } from '../ui/badge';
import { buttonClass } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { HistoryIcon, QrIcon, ShieldCheckIcon } from '../ui/icons';
import { Avatar, EmptyState, Notice, Skeleton } from '../ui/misc';
import { qrStateLook, qrStateDetail } from './qr-state';

/**
 * One employee's QR activity: where today's code stands, and their latest scans. It answers "did
 * this person's code work, and who scanned it?" without ever showing a code (nobody can: only the
 * employee sees theirs, once, and only a hash is kept).
 */
export function EmployeeQrDialog({
  row,
  date,
  onClose,
}: {
  row: QrOverviewRow | null;
  /** The day the overview is showing. */
  date: string;
  onClose: () => void;
}) {
  const scans = useQuery({
    queryKey: ['qr-scans', 'employee', row?.employeeId],
    queryFn: () =>
      api<Paginated<ScanLogDto>>(`/api/admin/qr-scans?employeeId=${row!.employeeId}&pageSize=8`),
    enabled: row !== null,
  });

  const look = row ? qrStateLook(row.state) : null;
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="QR activity"
      description="Where this employee’s code stands and how their latest scans went."
      size="md"
      footer={
        row ? (
          <Link
            to={`/admin/scan-history?employee=${row.employeeId}&name=${encodeURIComponent(row.fullName)}`}
            className={buttonClass({ variant: 'outline' })}
            onClick={onClose}
          >
            <HistoryIcon className="h-4 w-4" /> Open full scan history
          </Link>
        ) : null
      }
    >
      {row && look ? (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <Avatar name={row.fullName} src={row.avatarUrl} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold leading-tight">{row.fullName}</p>
              <p className="font-mono text-sm text-muted">{row.employeeCode}</p>
              <p className="truncate text-sm text-muted">
                {[row.designation, row.department].filter(Boolean).join(' · ') || row.email}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <QrIcon className="h-4 w-4 text-muted" />
                Code on {formatWorkDate(date)}
              </p>
              <Badge tone={look.tone} dot={row.state === 'ACTIVE'}>
                {look.label}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted">{qrStateDetail(row)}</p>
            <p className="mt-1 text-xs text-muted">
              {row.generated === 0
                ? 'No code was made.'
                : `${row.generated} code${row.generated === 1 ? '' : 's'} made. Last scanned: ${formatWhen(row.lastScannedAt)}.`}
            </p>
          </div>

          <section aria-labelledby="employee-scans-title">
            <h3 id="employee-scans-title" className="mb-2 text-sm font-semibold">
              Latest scans
            </h3>
            {scans.isLoading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : scans.isError ? (
              <Notice tone="danger" title="The scans could not be loaded">
                {messageOf(scans.error)}
              </Notice>
            ) : scans.data && scans.data.items.length > 0 ? (
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {scans.data.items.map((scan) => (
                  <li key={scan.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{formatDateTime(scan.scannedAt)}</p>
                      <p className="truncate text-xs text-muted">
                        Scanned by {scan.scannedBy.fullName}
                      </p>
                    </div>
                    <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No scans yet" className="rounded-2xl border border-line py-8">
                Nobody has scanned a code for this employee.
              </EmptyState>
            )}
          </section>

          <p className="flex items-start gap-2 text-xs text-muted">
            <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            Codes are made by the employee after they verify at the office, and only they see them.
            They cannot be viewed, printed or reissued here, and each works once.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
