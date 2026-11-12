import { z } from 'zod';
import type { AttendanceStatus, LiveState } from './enums.js';
import { isoDateSchema, uuidSchema } from './schemas.js';
import type { ScanAction } from './employee-qr.js';
import { gpsEvidenceSchema, type VerifyResponse } from './verification.js';

/**
 * The employee's own attendance QR code, and the administrator's scan of it.
 *
 *   employee   proves GPS + office network -> generates a code for today and ONE action
 *              (check in, or check out) -> shows it on screen
 *   admin      opens the scanner -> scans -> the server validates and records, in one step
 *
 * The scanner's own location and network are never looked at. The proof of presence is the
 * employee's, made when the code was generated, and the code carries it: short lived, single use,
 * bound to the employee, the day and the action.
 */

/** Prefix of a generated attendance code. (`TG1` is the lobby screen, `TGE1` the retired ID card.) */
export const DAILY_QR_PREFIX = 'TGD1';

/** `TGD1.` followed by 43 base64url characters (a 256-bit random token). Nothing about the person is in it. */
export const DAILY_QR_PATTERN = /^TGD1\.[A-Za-z0-9_-]{43}$/;

export const looksLikeDailyQr = (text: string): boolean => DAILY_QR_PATTERN.test(text);

/**
 * `POST /api/attendance-qr/verify`: the employee proves they are at the office (GPS inside the
 * geofence, and the office network, which the server sees for itself). What the code will be for
 * (check in or check out) is decided by the server, not the client.
 */
export const dailyQrVerifyRequestSchema = z.strictObject({ gps: gpsEvidenceSchema });
export type DailyQrVerifyRequest = z.input<typeof dailyQrVerifyRequestSchema>;

/** Body of a passed `POST /api/attendance-qr/verify`. */
export interface DailyQrVerified extends VerifyResponse {
  action: ScanAction;
}

/**
 * `POST /api/attendance-qr/generate`. `verificationId` is the passed verification from
 * `POST /api/attendance-qr/verify`.
 * Administrators are exempt from location checks and send none.
 */
export const generateDailyQrRequestSchema = z.strictObject({
  verificationId: uuidSchema.optional(),
});
export type GenerateDailyQrRequest = z.input<typeof generateDailyQrRequestSchema>;

/** What the next code would be for. */
export type DailyQrNextAction = ScanAction | 'ALREADY_CHECKED_OUT' | 'BLOCKED';

/** Body of `GET /api/attendance-qr/today`. */
export interface DailyQrToday {
  workDate: string;
  /** What a code generated now would record. */
  next: DailyQrNextAction;
  /** Why nothing can be recorded (holiday, leave …); null otherwise. */
  blockedReason: { code: string; message: string } | null;
  /** Administrators are never asked for their location or network. */
  verificationRequired: boolean;
  /** Which of today's codes is still scannable, if any. The code text itself is never returned again. */
  live: { expiresAt: string; action: ScanAction } | null;
  generatedToday: number;
  maxPerDay: number;
  ttlSeconds: number;
  attendance: {
    status: AttendanceStatus | null;
    liveState: LiveState;
    checkInAt: string | null;
    checkOutAt: string | null;
    isLate: boolean;
  };
}

/** Body of `POST /api/attendance-qr/generate`. The only response that ever contains the code. */
export interface DailyQrIssued {
  id: string;
  /** The text to draw as a QR image. */
  payload: string;
  action: ScanAction;
  workDate: string;
  issuedAt: string;
  expiresAt: string;
  generatedToday: number;
  maxPerDay: number;
}

/** Body of `GET /api/attendance-qr/:id`: has the code been used yet? (The owner polls this.) */
export interface DailyQrProgress {
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'USED' | 'SUPERSEDED';
  action: ScanAction;
  expiresAt: string;
  usedAt: string | null;
}

/** Body of a successful `POST /api/qr-attendance/scan`: the code was valid and attendance is recorded. */
export interface ScanRecorded {
  scanId: string;
  action: ScanAction;
  recordedAt: string;
  source: 'ADMIN_QR';
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    department: string | null;
    designation: string | null;
    avatarUrl: string | null;
  };
  attendance: {
    workDate: string;
    status: AttendanceStatus;
    isLate: boolean;
    liveState: LiveState;
    checkInAt: string | null;
    checkOutAt: string | null;
    netWorkSeconds: number | null;
  };
}

/** `error.details` of a refused scan: staff learn who it concerned and when it was first recorded. */
export interface ScanRefusalDetails {
  scanId: string;
  employee?: { employeeCode: string; fullName: string };
  /** For a duplicate: when the code was first used. */
  firstRecordedAt?: string;
}

// ---------------------------------------------------------------------------------------------
// The administrator's attendance dashboard
// ---------------------------------------------------------------------------------------------

export const dailyAttendanceQuerySchema = z.strictObject({
  /** Office-timezone calendar date; today when omitted. */
  date: isoDateSchema.optional(),
});
export type DailyAttendanceQuery = z.output<typeof dailyAttendanceQuerySchema>;

export const DAILY_ROW_STATES = [
  'PRESENT',
  'LATE',
  'ABSENT',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
] as const;
export type DailyRowState = (typeof DAILY_ROW_STATES)[number];

export interface DailyAttendanceRow {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  department: string | null;
  designation: string | null;
  state: DailyRowState;
  checkInAt: string | null;
  checkOutAt: string | null;
  liveState: LiveState;
  isLate: boolean;
  netWorkSeconds: number | null;
  /** ADMIN_QR, EMPLOYEE, ADMIN … where the check-in came from. */
  source: string | null;
}

/** Body of `GET /api/admin/attendance/daily`. */
export interface DailyAttendanceReport {
  date: string;
  isToday: boolean;
  summary: { total: number; present: number; late: number; absent: number; onLeave: number };
  warnings: { duplicateScans: number; invalidOrExpiredScans: number };
  rows: DailyAttendanceRow[];
}
