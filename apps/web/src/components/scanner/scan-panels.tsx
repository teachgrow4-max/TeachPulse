import type { ScanLogDto, ScanRecorded, ScanRefusalDetails } from '@teachgrow/shared';
import type { ApiError } from '../../lib/api';
import { formatTime, formatWorkDate, timeAgo } from '../../lib/format';
import { outcomeText, rejectionTitle, statusTone } from '../../lib/scan-labels';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { AlertIcon, BanIcon, CheckIcon, ScanIcon } from '../ui/icons';
import { Avatar, EmptyState, Skeleton } from '../ui/misc';

// ---------------------------------------------------------------------------------------------
// Done, or refused
// ---------------------------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold">{children}</dd>
    </div>
  );
}

const STATUS_TEXT: Record<string, { text: string; tone: 'success' | 'warning' | 'neutral' }> = {
  PRESENT: { text: 'Present', tone: 'success' },
  LATE: { text: 'Late', tone: 'warning' },
};

/** Attendance was recorded: who, when and how the day stands. */
export function SuccessPanel({ result, onNext }: { result: ScanRecorded; onNext: () => void }) {
  const isIn = result.action === 'CHECK_IN';
  const { employee, attendance } = result;
  const status = STATUS_TEXT[attendance.status] ?? { text: attendance.status, tone: 'neutral' };
  return (
    <div className="pop-in flex flex-col items-center gap-4 text-center" role="status">
      <div className="relative flex h-24 w-24 items-center justify-center">
        <span className="ring-burst absolute inset-0 rounded-full bg-success-solid/30" />
        <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-success-solid text-on-solid">
          <svg
            viewBox="0 0 24 24"
            className="h-10 w-10"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path className="draw-check" d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      </div>
      <p className="text-3xl font-extrabold">{isIn ? 'Checked in' : 'Checked out'}</p>

      <Card
        className="w-full overflow-hidden text-left"
        aria-label={`Employee ${employee.fullName}`}
      >
        <div className="flex items-center gap-4 p-4">
          <Avatar name={employee.fullName} src={employee.avatarUrl} className="h-16 w-16 text-xl" />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold leading-tight">{employee.fullName}</p>
            <p className="font-mono text-sm text-muted">{employee.employeeCode}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge tone={status.tone}>{status.text}</Badge>
              <Badge tone="info">Recorded by QR scan</Badge>
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px border-t border-line bg-line">
          <Fact label="Department">{employee.department ?? '—'}</Fact>
          <Fact label="Attendance date">{formatWorkDate(attendance.workDate)}</Fact>
          <Fact label="Check-in time">{formatTime(attendance.checkInAt)}</Fact>
          <Fact label="Check-out time">{formatTime(attendance.checkOutAt)}</Fact>
        </dl>
      </Card>

      <Button size="lg" onClick={onNext} className="w-full max-w-sm" autoFocus>
        <ScanIcon /> Scan another employee
      </Button>
    </div>
  );
}

/** Refused: unrecognised, expired, replaced, a duplicate, or a day with nothing to record. */
export function RejectionPanel({ error, onNext }: { error: ApiError; onNext: () => void }) {
  const details = (error.details ?? {}) as Partial<ScanRefusalDetails>;
  const warning = [
    'QR_EXPIRED',
    'QR_ALREADY_USED',
    'QR_SUPERSEDED',
    'SCAN_ACTION_MISMATCH',
    'ALREADY_CHECKED_OUT',
    'HOLIDAY',
    'WEEKLY_OFF',
    'ON_LEAVE',
  ].includes(error.code);
  return (
    <div className="shake flex flex-col items-center gap-4 text-center" role="alert">
      <span
        className={cn(
          'flex h-24 w-24 items-center justify-center rounded-full',
          warning ? 'bg-warning-soft text-warning' : 'bg-danger-soft text-danger',
        )}
      >
        {error.code === 'NETWORK_ERROR' ? (
          <AlertIcon className="h-12 w-12" />
        ) : (
          <BanIcon className="h-12 w-12" />
        )}
      </span>
      <div>
        <p className="text-2xl font-extrabold">{rejectionTitle(error.code)}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">{error.message}</p>
        {details.employee ? (
          <p className="mt-3 text-sm">
            Code belongs to <strong>{details.employee.fullName}</strong>{' '}
            <span className="font-mono text-muted">({details.employee.employeeCode})</span>
          </p>
        ) : null}
        {details.firstRecordedAt ? (
          <p className="mt-1 text-sm">
            First recorded at <strong>{formatTime(details.firstRecordedAt)}</strong>. Nothing was
            recorded twice.
          </p>
        ) : null}
      </div>
      <Button size="lg" onClick={onNext} className="w-full max-w-sm" autoFocus>
        <ScanIcon /> Scan another employee
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent scans
// ---------------------------------------------------------------------------------------------

export function RecentScans({
  items,
  loading,
  now = Date.now(),
}: {
  items: ScanLogDto[] | undefined;
  loading: boolean;
  now?: number;
}) {
  return (
    <section aria-labelledby="recent-scans-title">
      <h2
        id="recent-scans-title"
        className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
      >
        Recent scans
      </h2>
      <Card>
        {loading ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : items && items.length > 0 ? (
          <ul className="divide-y divide-line">
            {items.map((scan) => (
              <li key={scan.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    scan.status === 'RECORDED'
                      ? 'bg-success-soft text-success'
                      : 'bg-surface-2 text-muted',
                  )}
                >
                  {scan.status === 'RECORDED' ? (
                    <CheckIcon className="h-5 w-5" />
                  ) : (
                    <ScanIcon className="h-5 w-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {scan.employee ? scan.employee.fullName : 'Unknown code'}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {timeAgo(scan.scannedAt, now)}
                    {scan.employee ? ` · ${scan.employee.employeeCode}` : ''}
                  </p>
                </div>
                <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No scans yet" icon={<ScanIcon className="h-8 w-8" />}>
            Scans you make today will appear here.
          </EmptyState>
        )}
      </Card>
    </section>
  );
}
