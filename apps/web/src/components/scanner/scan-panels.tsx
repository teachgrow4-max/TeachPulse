import type { ScanLogDto, ScanRecorded, ScanRefusalDetails } from '@teachgrow/shared';
import type { ApiError } from '../../lib/api';
import { formatTime, formatTimeExact, formatWorkDate, timeAgo } from '../../lib/format';
import { outcomeText, rejectionTitle, statusTone } from '../../lib/scan-labels';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import {
  AlertCircleIcon,
  BanIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  HourglassIcon,
  QrIcon,
  RefreshIcon,
  ScanIcon,
  ShieldCheckIcon,
  WifiOffIcon,
  XCircleIcon,
  type AppIcon,
} from '../ui/icons';
import { Avatar, EmptyState, Skeleton } from '../ui/misc';

// ---------------------------------------------------------------------------------------------
// Done: who was recorded, when, and how the day stands
// ---------------------------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold">{children}</dd>
    </div>
  );
}

const STATUS_TEXT: Record<string, { text: string; tone: 'success' | 'warning' | 'neutral' }> = {
  PRESENT: { text: 'Present', tone: 'success' },
  LATE: { text: 'Late', tone: 'warning' },
};

/** An animated tick: a ring that pulses once, and a check that draws itself. */
export function SuccessMark({ className }: { className?: string }) {
  return (
    <div className={cn('relative flex h-24 w-24 items-center justify-center', className)}>
      <span className="ring-burst absolute inset-0 rounded-full bg-success-solid/25" />
      <span className="relative flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-success-solid text-on-solid shadow-lift">
        <svg
          viewBox="0 0 24 24"
          className="h-9 w-9"
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
  );
}

/**
 * Attendance was recorded. The top says so (with the exact time); below is the employee's
 * verification panel: who they are, that the code was valid, and how their day stands.
 */
export function SuccessPanel({ result, onNext }: { result: ScanRecorded; onNext: () => void }) {
  const isIn = result.action === 'CHECK_IN';
  const { employee, attendance } = result;
  const status = STATUS_TEXT[attendance.status] ?? { text: attendance.status, tone: 'neutral' };
  return (
    <div className="pop-in" role="status">
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center gap-3 bg-gradient-to-b from-success-soft to-surface px-6 pb-6 pt-8 text-center">
          <SuccessMark />
          <div>
            <p className="text-2xl font-semibold tracking-tight">
              {isIn ? 'Checked in' : 'Checked out'}
            </p>
            <p className="mt-1 text-sm text-muted">Attendance recorded successfully</p>
          </div>
          <p className="inline-flex items-center gap-2 rounded-full bg-surface px-4 py-1.5 text-sm font-semibold tabular-nums shadow-card ring-1 ring-inset ring-line">
            <ClockIcon className="h-4 w-4 text-success" />
            <span>{formatTimeExact(result.recordedAt)}</span>
          </p>
        </div>

        {/* the employee's verification panel: who they are, and how the day stands */}
        <div role="group" aria-label={`Employee ${employee.fullName}`}>
          <div className="border-t border-line p-5 sm:p-6">
            <div className="flex items-center gap-4">
              <Avatar name={employee.fullName} src={employee.avatarUrl} size="xl" />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold leading-tight">{employee.fullName}</p>
                <p className="mt-0.5 font-mono text-sm text-muted">{employee.employeeCode}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={status.tone} dot>
                    {status.text}
                  </Badge>
                  <Badge tone="info">Recorded by QR scan</Badge>
                </div>
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-px border-t border-line bg-line">
            <Fact label="Department">{employee.department ?? '—'}</Fact>
            <Fact label="Designation">{employee.designation ?? '—'}</Fact>
            <Fact label="Attendance date">{formatWorkDate(attendance.workDate)}</Fact>
            <Fact label="QR status">
              <span className="inline-flex items-center gap-1.5 text-success">
                <ShieldCheckIcon className="h-4 w-4" /> Valid, now used
              </span>
            </Fact>
            <Fact label="Check-in time">{formatTime(attendance.checkInAt)}</Fact>
            <Fact label="Check-out time">{formatTime(attendance.checkOutAt)}</Fact>
          </dl>
        </div>

        <div className="border-t border-line p-5 sm:p-6">
          <Button size="lg" onClick={onNext} className="w-full" autoFocus>
            <ScanIcon className="h-5 w-5" /> Scan another employee
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Refused
// ---------------------------------------------------------------------------------------------

type Look = { icon: AppIcon; tone: 'danger' | 'warning' | 'info' };

/** How each kind of refusal looks: an icon, and whether it is a warning (fixable) or an error. */
function lookOf(code: string): Look {
  switch (code) {
    case 'QR_EXPIRED':
      return { icon: HourglassIcon, tone: 'warning' };
    case 'QR_ALREADY_USED':
      return { icon: CopyIcon, tone: 'warning' };
    case 'QR_SUPERSEDED':
    case 'SCAN_ACTION_MISMATCH':
      return { icon: RefreshIcon, tone: 'warning' };
    case 'ALREADY_CHECKED_OUT':
    case 'HOLIDAY':
    case 'WEEKLY_OFF':
    case 'ON_LEAVE':
    case 'ACTIVE_BREAK':
    case 'ALREADY_CHECKED_IN':
      return { icon: CalendarIcon, tone: 'warning' };
    case 'NETWORK_ERROR':
    case 'RATE_LIMITED':
      return { icon: WifiOffIcon, tone: 'info' };
    case 'EMPLOYEE_QR_REVOKED':
    case 'EMPLOYEE_INACTIVE':
    case 'ATTENDANCE_NOT_TRACKED':
    case 'SELF_SCAN_FORBIDDEN':
    case 'FORBIDDEN':
      return { icon: BanIcon, tone: 'danger' };
    case 'EMPLOYEE_QR_INVALID':
      return { icon: XCircleIcon, tone: 'danger' };
    default:
      return { icon: AlertCircleIcon, tone: 'danger' };
  }
}

const LOOK_TONE = {
  danger: { disc: 'bg-danger-soft text-danger', wash: 'from-danger-soft/60' },
  warning: { disc: 'bg-warning-soft text-warning', wash: 'from-warning-soft/70' },
  info: { disc: 'bg-info-soft text-info', wash: 'from-info-soft/70' },
} as const;

/**
 * Refused: unrecognised, expired, replaced, a duplicate, an inactive employee, a day with nothing to
 * record, or the server could not be reached. Says what happened and what to do next. When the
 * trouble was only the connection, the same code can be sent again without scanning it again.
 */
export function RejectionPanel({
  error,
  onNext,
  onRetry,
}: {
  error: ApiError;
  onNext: () => void;
  /** Offered when nothing reached the server, so the same code is still good. */
  onRetry?: () => void;
}) {
  const details = (error.details ?? {}) as Partial<ScanRefusalDetails>;
  const look = lookOf(error.code);
  const tone = LOOK_TONE[look.tone];
  const Icon = look.icon;
  const showRetry = error.code === 'NETWORK_ERROR' && onRetry;
  return (
    <div className="shake" role="alert">
      <Card className="overflow-hidden">
        <div
          className={cn(
            'flex flex-col items-center gap-3 bg-gradient-to-b to-surface px-6 pb-6 pt-8 text-center',
            tone.wash,
          )}
        >
          <span
            className={cn('flex h-20 w-20 items-center justify-center rounded-full', tone.disc)}
          >
            <Icon className="h-10 w-10" />
          </span>
          <div>
            <p className="text-2xl font-semibold tracking-tight">{rejectionTitle(error.code)}</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{error.message}</p>
          </div>
        </div>

        {details.employee || details.firstRecordedAt ? (
          <div className="flex flex-col gap-3 border-t border-line p-5 sm:p-6">
            {details.employee ? (
              <div className="flex items-center gap-3">
                <Avatar name={details.employee.fullName} size="md" />
                <p className="min-w-0 text-sm">
                  Code belongs to{' '}
                  <strong className="font-semibold">{details.employee.fullName}</strong>{' '}
                  <span className="font-mono text-muted">({details.employee.employeeCode})</span>
                </p>
              </div>
            ) : null}
            {details.firstRecordedAt ? (
              <p className="text-sm">
                First recorded at{' '}
                <strong className="font-semibold">{formatTime(details.firstRecordedAt)}</strong>.
                Nothing was recorded twice.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-line p-5 sm:flex-row sm:p-6">
          {showRetry ? (
            <Button variant="outline" size="lg" onClick={onRetry} className="sm:flex-1">
              <RefreshIcon className="h-5 w-5" /> Try again
            </Button>
          ) : null}
          <Button size="lg" onClick={onNext} className="sm:flex-1" autoFocus>
            <ScanIcon className="h-5 w-5" /> Scan another employee
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent scans: a short activity timeline
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
      <Card>
        <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
          <div>
            <h2 id="recent-scans-title" className="text-base font-semibold tracking-tight">
              Recent scans
            </h2>
            <p className="text-xs text-muted">The last scans made with this account.</p>
          </div>
          <Badge tone="success" dot>
            Live
          </Badge>
        </div>
        {loading ? (
          <div className="space-y-4 p-5 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : items && items.length > 0 ? (
          <ul className="px-3 pb-3">
            {items.map((scan) => {
              const recorded = scan.status === 'RECORDED';
              const name = scan.employee ? scan.employee.fullName : 'Unknown code';
              return (
                <li key={scan.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
                  <span className="relative shrink-0">
                    <Avatar name={name} src={scan.employee?.avatarUrl} size="md" />
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 flex h-[1.1rem] w-[1.1rem] items-center justify-center rounded-full ring-2 ring-surface',
                        recorded
                          ? 'bg-success-solid text-on-solid'
                          : scan.status === 'REJECTED'
                            ? 'bg-danger-solid text-on-solid'
                            : 'bg-surface-3 text-muted',
                      )}
                    >
                      {recorded ? (
                        <CheckIcon className="h-2.5 w-2.5" />
                      ) : scan.employee ? (
                        <AlertCircleIcon className="h-2.5 w-2.5" />
                      ) : (
                        <QrIcon className="h-2.5 w-2.5" />
                      )}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">{name}</p>
                    <p className="truncate text-xs text-muted">
                      {scan.employee ? (
                        <span className="font-mono">{scan.employee.employeeCode}</span>
                      ) : null}
                      {scan.employee ? ' · ' : ''}
                      <time dateTime={scan.scannedAt} title={formatTime(scan.scannedAt)}>
                        {timeAgo(scan.scannedAt, now)}
                      </time>
                    </p>
                  </div>
                  <Badge tone={statusTone(scan.status)}>{outcomeText(scan)}</Badge>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            title="No scans yet"
            icon={<ScanIcon className="h-7 w-7" />}
            className="py-10"
          >
            Scans you make today will appear here.
          </EmptyState>
        )}
      </Card>
    </section>
  );
}
