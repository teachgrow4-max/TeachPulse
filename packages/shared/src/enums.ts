/**
 * Enumerations shared by the API, web and mobile apps.
 *
 * Every list that also exists as a Postgres enum MUST stay identical to the
 * database definition. `supabase/tests/` and the API integration tests assert this,
 * so a drift fails CI rather than production.
 */

export const ROLE_NAMES = ['employee', 'admin', 'office_display', 'attendance_operator'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Who may operate the QR attendance scanner (administrators and designated operators). */
export const SCANNER_ROLES = [
  'admin',
  'attendance_operator',
] as const satisfies readonly RoleName[];
export type ScannerRole = (typeof SCANNER_ROLES)[number];

export function isScannerRole(role: RoleName): role is ScannerRole {
  return (SCANNER_ROLES as readonly RoleName[]).includes(role);
}

/** Outcome classification for a work day. `PRESENT`/`LATE` describe arrival. */
export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'LATE',
  'ABSENT',
  'INCOMPLETE',
  'ON_LEAVE',
  'WEEKLY_OFF',
  'HOLIDAY',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Where the employee is right now. Independent of the day's outcome status. */
export const LIVE_STATES = [
  'NONE',
  'WORKING',
  'ON_LUNCH',
  'ON_SHORT_BREAK',
  'CHECKED_OUT',
] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const EVENT_TYPES = [
  'CHECK_IN',
  'CHECK_OUT',
  'BREAK_START',
  'BREAK_END',
  'CORRECTION_APPLIED',
  'DAY_FINALIZED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const BREAK_TYPES = ['LUNCH', 'SHORT'] as const;
export type BreakType = (typeof BREAK_TYPES)[number];

export const BREAK_END_REASONS = ['USER', 'CHECKOUT_EXCEPTION', 'DAY_FINALIZED'] as const;
export type BreakEndReason = (typeof BREAK_END_REASONS)[number];

export const VERIFICATION_LAYERS = ['GPS', 'NETWORK', 'QR', 'DEVICE'] as const;
export type VerificationLayer = (typeof VERIFICATION_LAYERS)[number];

/** GPS and NETWORK can never be switched off for check-in (enforced in the database). */
export const MANDATORY_CHECK_IN_LAYERS = [
  'GPS',
  'NETWORK',
] as const satisfies readonly VerificationLayer[];

export const LAYER_RESULTS = ['PASS', 'FAIL', 'NOT_REQUIRED', 'NOT_EVALUATED'] as const;
export type LayerResult = (typeof LAYER_RESULTS)[number];

export const VERIFICATION_RESULTS = ['VERIFIED', 'REJECTED'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/**
 * What a verification is FOR. ADMIN_SCAN is the proof that the person operating the QR scanner is
 * at the office; it is only ever requested by the scanner endpoints, never by an employee marking
 * their own attendance (see {@link ATTENDANCE_VERIFICATION_PURPOSES}). Same order as the database.
 */
export const VERIFICATION_PURPOSES = ['CHECK_IN', 'CHECK_OUT', 'ADMIN_SCAN'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** The purposes an employee may ask for when marking their OWN attendance. */
export const ATTENDANCE_VERIFICATION_PURPOSES = ['CHECK_IN', 'CHECK_OUT'] as const;
export type AttendanceVerificationPurpose = (typeof ATTENDANCE_VERIFICATION_PURPOSES)[number];

/** Where an attendance event came from (`attendance_events.source`). */
export const ATTENDANCE_EVENT_SOURCES = ['EMPLOYEE', 'ADMIN', 'SYSTEM', 'ADMIN_QR'] as const;
export type AttendanceEventSource = (typeof ATTENDANCE_EVENT_SOURCES)[number];

export const CHANNELS = ['WEB', 'MOBILE'] as const;
export type Channel = (typeof CHANNELS)[number];

export const DEVICE_PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const CORRECTION_SOURCES = ['EMPLOYEE_REQUEST', 'ADMIN_INITIATED'] as const;
export type CorrectionSource = (typeof CORRECTION_SOURCES)[number];

/** ISO weekday numbers as used by Postgres `isodow`: 1 = Monday ... 7 = Sunday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoWeekday = (typeof ISO_WEEKDAYS)[number];
