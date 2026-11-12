import type {
  DetectedAction,
  ScanAction,
  ScanDisplayStatus,
  ScanLogDto,
  ScanTodayDto,
} from '@teachgrow/shared';
import type { BadgeTone } from '../components/ui/badge';

/** Words for the things a scan can turn out to be, shared by the scanner and the history table. */

export function todayLabel(today: ScanTodayDto): { text: string; tone: BadgeTone } {
  switch (today.liveState) {
    case 'CHECKED_OUT':
      return { text: 'Checked out', tone: 'neutral' };
    case 'ON_LUNCH':
      return { text: 'On lunch break', tone: 'info' };
    case 'ON_SHORT_BREAK':
      return { text: 'On a short break', tone: 'info' };
    case 'WORKING':
      return today.isLate
        ? { text: 'Working · arrived late', tone: 'warning' }
        : { text: 'Working', tone: 'success' };
    default:
      return { text: 'Not checked in', tone: 'neutral' };
  }
}

export const ACTION_LABEL: Record<ScanAction, string> = {
  CHECK_IN: 'Check in',
  CHECK_OUT: 'Check out',
};

export const DETECTED_LABEL: Record<DetectedAction, string> = {
  CHECK_IN: 'Check in',
  CHECK_OUT: 'Check out',
  ALREADY_CHECKED_OUT: 'Already checked out',
  BLOCKED: 'Not allowed today',
  REJECTED: 'Refused',
};

const REASON_LABEL: Record<string, string> = {
  EMPLOYEE_QR_INVALID: 'Code not recognised',
  EMPLOYEE_QR_REVOKED: 'Revoked code',
  EMPLOYEE_INACTIVE: 'Inactive employee',
  ATTENDANCE_NOT_TRACKED: 'Attendance not tracked',
  SELF_SCAN_FORBIDDEN: 'Own code',
  ALREADY_CHECKED_OUT: 'Already checked out',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
  ON_LEAVE: 'On leave',
  ACTIVE_BREAK: 'On a break',
  ALREADY_CHECKED_IN: 'Day closed without check-out',
};

export const reasonLabel = (code: string | null): string =>
  code ? (REASON_LABEL[code] ?? code) : '';

export function statusTone(status: ScanDisplayStatus): BadgeTone {
  switch (status) {
    case 'RECORDED':
      return 'success';
    case 'REJECTED':
      return 'danger';
    case 'PENDING':
      return 'warning';
    case 'NO_ACTION':
      return 'info';
    default:
      return 'neutral';
  }
}

export const STATUS_LABEL: Record<ScanDisplayStatus, string> = {
  PENDING: 'Waiting',
  RECORDED: 'Recorded',
  NO_ACTION: 'Nothing to do',
  REJECTED: 'Refused',
  EXPIRED: 'Expired',
};

/** One line describing what became of a scan: "Checked in", "Revoked code", "Expired"... */
export function outcomeText(
  scan: Pick<ScanLogDto, 'status' | 'confirmedAction' | 'reasonCode'>,
): string {
  switch (scan.status) {
    case 'RECORDED':
      return scan.confirmedAction === 'CHECK_OUT' ? 'Checked out' : 'Checked in';
    case 'REJECTED':
    case 'NO_ACTION':
      return reasonLabel(scan.reasonCode) || STATUS_LABEL[scan.status];
    default:
      return STATUS_LABEL[scan.status];
  }
}

/** Headline for a refused scan, by the server's error code. */
export function rejectionTitle(code: string): string {
  switch (code) {
    case 'EMPLOYEE_QR_INVALID':
      return 'QR code not recognised';
    case 'EMPLOYEE_QR_REVOKED':
      return 'This QR code was revoked';
    case 'EMPLOYEE_INACTIVE':
      return 'Employee account is inactive';
    case 'ATTENDANCE_NOT_TRACKED':
      return 'Attendance is not tracked here';
    case 'SELF_SCAN_FORBIDDEN':
      return 'You cannot scan your own code';
    case 'RATE_LIMITED':
      return 'Too many scans, please wait';
    case 'NETWORK_ERROR':
      return 'Cannot reach the server';
    case 'FORBIDDEN':
      return 'Not allowed';
    default:
      return 'The scan could not be used';
  }
}
