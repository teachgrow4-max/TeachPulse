import type {
  ConfirmScanResponse,
  ScanLogDto,
  ScanRejectionDetails,
  ScanResolution,
} from '@teachgrow/shared';
import type { ApiError } from '../../lib/api';
import { countdown, formatTime, formatWorkDate, timeAgo } from '../../lib/format';
import {
  ACTION_LABEL,
  outcomeText,
  rejectionTitle,
  statusTone,
  todayLabel,
} from '../../lib/scan-labels';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import {
  AlertIcon,
  BanIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  ScanIcon,
  ShieldCheckIcon,
} from '../ui/icons';
import { Avatar, EmptyState, Notice, Skeleton } from '../ui/misc';

// ---------------------------------------------------------------------------------------------
// Who is this?
// ---------------------------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold">{children}</dd>
    </div>
  );
}

/** The employee the code belongs to: photo, name, ID, department, designation, status, today. */
export function EmployeeIdCard({ scan }: { scan: ScanResolution }) {
  const { employee, today } = scan;
  const label = todayLabel(today);
  return (
    <Card className="overflow-hidden" aria-label={`Employee ${employee.fullName}`}>
      <div className="flex items-center gap-4 p-5">
        <Avatar name={employee.fullName} src={employee.avatarUrl} className="h-20 w-20 text-2xl" />
        <div className="min-w-0">
          <p className="truncate text-xl font-bold leading-tight">{employee.fullName}</p>
          <p className="font-mono text-sm text-muted">{employee.employeeCode}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={employee.accountStatus === 'ACTIVE' ? 'success' : 'danger'}>
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              Account {employee.accountStatus === 'ACTIVE' ? 'active' : 'inactive'}
            </Badge>
            <Badge tone={label.tone}>{label.text}</Badge>
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line">
        <Fact label="Department">{employee.department ?? '—'}</Fact>
        <Fact label="Designation">{employee.designation ?? '—'}</Fact>
        <Fact label="Checked in">{formatTime(today.checkInAt)}</Fact>
        <Fact label="Checked out">{formatTime(today.checkOutAt)}</Fact>
      </dl>
      <p className="border-t border-line bg-surface-2 px-4 py-2 text-xs text-muted">
        {formatWorkDate(today.workDate)}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// What will happen, and the button that makes it happen
// ---------------------------------------------------------------------------------------------

export type SubmitStep = 'idle' | 'location' | 'verifying' | 'recording';

export interface SubmitFailure {
  title: string;
  message: string;
  reasons?: Array<{ message: string; hint: string }>;
  /** True when pressing the button again is the right next step. */
  canRetry: boolean;
}

const STEP_TEXT: Record<Exclude<SubmitStep, 'idle'>, string> = {
  location: 'Finding your location…',
  verifying: 'Checking you are at the office…',
  recording: 'Recording attendance…',
};

export function ActionPanel({
  scan,
  secondsLeft,
  step,
  failure,
  blockedNotice,
  onConfirm,
  onCancel,
}: {
  scan: ScanResolution;
  secondsLeft: number;
  step: SubmitStep;
  failure: SubmitFailure | null;
  /** Something that stops this device recording (for example a policy it cannot satisfy). */
  blockedNotice: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { action, employee } = scan;
  const busy = step !== 'idle';

  if (action === 'ALREADY_CHECKED_OUT' || action === 'BLOCKED') {
    return (
      <div className="fade-up flex flex-col gap-3">
        <div
          role="status"
          className="rounded-2xl border border-info-solid/30 bg-info-soft px-5 py-6 text-center text-info"
        >
          <InfoIcon className="mx-auto h-8 w-8" />
          <p className="mt-2 text-2xl font-extrabold tracking-wide">
            {action === 'ALREADY_CHECKED_OUT' ? 'ALREADY CHECKED OUT' : 'NOTHING TO RECORD'}
          </p>
          {scan.reason ? <p className="mt-1 text-sm">{scan.reason.message}</p> : null}
        </div>
        <Button variant="primary" size="lg" onClick={onCancel} autoFocus>
          <ScanIcon /> Scan another employee
        </Button>
      </div>
    );
  }

  const expired = secondsLeft <= 0;
  const stuck = failure !== null && !failure.canRetry;
  const isIn = action === 'CHECK_IN';
  return (
    <div className="fade-up flex flex-col gap-3">
      <Button
        size="xl"
        variant={isIn ? 'success' : 'warning'}
        className="w-full"
        loading={busy}
        disabled={expired || stuck || blockedNotice !== null}
        onClick={onConfirm}
        aria-describedby="scan-confirm-note"
      >
        {isIn ? 'CHECK IN' : 'CHECK OUT'}
      </Button>

      <p id="scan-confirm-note" className="text-center text-sm text-muted">
        {busy ? (
          <span role="status">{STEP_TEXT[step as Exclude<SubmitStep, 'idle'>]}</span>
        ) : expired ? (
          'This scan has expired. Scan the code again.'
        ) : (
          <>
            Confirm to record <strong>{employee.fullName}</strong> as{' '}
            {isIn ? 'checked in' : 'checked out'} now. Confirm within{' '}
            <span className="font-mono font-semibold">{countdown(secondsLeft)}</span>.
          </>
        )}
      </p>

      {blockedNotice ? <Notice tone="warning">{blockedNotice}</Notice> : null}

      {failure ? (
        <Notice tone="danger" title={failure.title} className="shake">
          <p>{failure.message}</p>
          {failure.reasons && failure.reasons.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5">
              {failure.reasons.map((reason) => (
                <li key={reason.message}>
                  {reason.message} <span className="opacity-80">{reason.hint}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      <Button variant={stuck ? 'primary' : 'ghost'} onClick={onCancel} disabled={busy}>
        {expired || stuck ? 'Scan again' : 'Cancel'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Done, or refused
// ---------------------------------------------------------------------------------------------

export function SuccessPanel({
  result,
  onNext,
}: {
  result: ConfirmScanResponse;
  onNext: () => void;
}) {
  const isIn = result.action === 'CHECK_IN';
  return (
    <div className="pop-in flex flex-col items-center gap-4 text-center" role="status">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <span className="ring-burst absolute inset-0 rounded-full bg-success-solid/30" />
        <span className="relative flex h-24 w-24 items-center justify-center rounded-full bg-success-solid text-on-solid">
          <svg
            viewBox="0 0 24 24"
            className="h-12 w-12"
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
      <div>
        <p className="text-3xl font-extrabold">{isIn ? 'Checked in' : 'Checked out'}</p>
        <p className="mt-1 text-lg font-semibold">{result.employee.fullName}</p>
        <p className="font-mono text-sm text-muted">{result.employee.employeeCode}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Badge tone="success">
          <ClockIcon className="h-3.5 w-3.5" /> {formatTime(result.recordedAt)}
        </Badge>
        {result.attendance.isLate && isIn ? <Badge tone="warning">Arrived late</Badge> : null}
        <Badge tone="info">Recorded by QR scan</Badge>
      </div>
      <Button size="lg" onClick={onNext} className="w-full max-w-sm" autoFocus>
        <ScanIcon /> Scan another employee
      </Button>
    </div>
  );
}

export function RejectionPanel({ error, onNext }: { error: ApiError; onNext: () => void }) {
  const details = (error.details ?? {}) as Partial<ScanRejectionDetails>;
  return (
    <div className="shake flex flex-col items-center gap-4 text-center" role="alert">
      <span className="flex h-24 w-24 items-center justify-center rounded-full bg-danger-soft text-danger">
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

export { ACTION_LABEL };
