/**
 * Stable, machine-readable error codes returned by the API.
 *
 * Codes raised from PL/pgSQL use SQLSTATE `TG001` with the code as the exception
 * message, so the API can translate them without parsing prose.
 */

export const DB_ERROR_SQLSTATE = 'TG001';

/** code -> HTTP status. The single place where domain errors get a status. */
export const ERROR_STATUS = {
  // generic
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,

  // account and session
  ACCOUNT_DEACTIVATED: 403,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  PASSWORD_CHANGE_REQUIRED: 403,
  CSRF_REJECTED: 403,
  LAST_ADMIN: 409,
  SELF_MODIFICATION_FORBIDDEN: 403,

  // check-in / check-out state machine
  ALREADY_CHECKED_IN: 409,
  NOT_CHECKED_IN: 409,
  ALREADY_CHECKED_OUT: 409,
  WEEKLY_OFF: 422,
  HOLIDAY: 422,
  ON_LEAVE: 422,
  OFFICE_NOT_CONFIGURED: 503,
  POLICY_NOT_FOUND: 503,

  // breaks
  ACTIVE_BREAK: 409,
  ALREADY_ON_BREAK: 409,
  NO_ACTIVE_BREAK: 409,
  BREAK_TYPE_MISMATCH: 409,
  SHORT_BREAK_LIMIT: 422,

  // employee QR codes and admin-operated scanning
  EMPLOYEE_QR_INVALID: 422,
  EMPLOYEE_QR_REVOKED: 422,
  EMPLOYEE_INACTIVE: 422,
  ATTENDANCE_NOT_TRACKED: 422,
  SCAN_EXPIRED: 422,
  SCAN_ALREADY_RECORDED: 409,
  SCAN_NOT_ACTIONABLE: 409,
  SCAN_ACTION_MISMATCH: 409,
  SELF_SCAN_FORBIDDEN: 403,

  // generated attendance QR codes
  QR_EXPIRED: 422,
  QR_ALREADY_USED: 409,
  QR_SUPERSEDED: 422,
  QR_LIMIT_REACHED: 429,

  // verification
  VERIFICATION_REQUIRED: 422,
  VERIFICATION_INVALID: 422,
  VERIFICATION_EXPIRED: 422,
  VERIFICATION_USED: 409,
  VERIFICATION_FAILED: 422,
  DEVICE_NOT_ACTIVE: 403,

  // devices
  CHALLENGE_INVALID: 422,
  CHALLENGE_EXPIRED: 422,
  DEVICE_PROOF_INVALID: 422,
  DEVICE_LIMIT_REACHED: 409,
  DEVICE_ALREADY_REGISTERED: 409,

  // idempotency
  IDEMPOTENCY_KEY_REUSED: 422,

  // corrections
  CORRECTION_INVALID: 422,
  CORRECTION_ALREADY_DECIDED: 409,
  SELF_APPROVAL_FORBIDDEN: 403,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Default human-readable message for each code. Safe to show to end users. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You do not have permission to do this.',
  VALIDATION_FAILED: 'Some of the information provided is not valid.',
  NOT_FOUND: 'The requested item was not found.',
  CONFLICT: 'This action conflicts with the current state.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again shortly.',

  ACCOUNT_DEACTIVATED: 'This account has been deactivated. Please contact HR.',
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  ACCOUNT_LOCKED: 'Too many failed sign-in attempts. Please wait a few minutes and try again.',
  PASSWORD_CHANGE_REQUIRED: 'You must set a new password before you can continue.',
  CSRF_REJECTED: 'This request was blocked because it did not come from the TeachGrow app.',
  LAST_ADMIN: 'There must always be at least one active administrator.',
  SELF_MODIFICATION_FORBIDDEN: 'You cannot make this change to your own account.',

  ALREADY_CHECKED_IN: 'You have already checked in today.',
  NOT_CHECKED_IN: 'You have not checked in, so there is nothing to update.',
  ALREADY_CHECKED_OUT: 'You have already checked out today.',
  WEEKLY_OFF: 'Today is a weekly off day, so attendance cannot be marked.',
  HOLIDAY: 'Today is a holiday, so attendance cannot be marked.',
  ON_LEAVE: 'You are on approved leave today, so attendance cannot be marked.',
  OFFICE_NOT_CONFIGURED:
    'The office has not been configured yet. Please contact your administrator.',
  POLICY_NOT_FOUND: 'No attendance policy is in effect. Please contact your administrator.',

  ACTIVE_BREAK: 'End your current break before checking out.',
  ALREADY_ON_BREAK: 'You are already on a break. End it before starting another.',
  NO_ACTIVE_BREAK: 'You are not on a break.',
  BREAK_TYPE_MISMATCH: 'This is a different type of break from the one that is running.',
  SHORT_BREAK_LIMIT: 'You have reached the maximum number of short breaks for today.',

  EMPLOYEE_QR_INVALID:
    'This QR code is not recognised. Ask the employee to generate their attendance QR code in the TeachGrow app.',
  EMPLOYEE_QR_REVOKED:
    'This QR code has been revoked and can no longer be used. The employee needs a new one from HR.',
  EMPLOYEE_INACTIVE: 'This employee’s account is inactive, so attendance cannot be recorded.',
  ATTENDANCE_NOT_TRACKED: 'Attendance is not tracked for this account.',
  SCAN_EXPIRED: 'This scan has expired. Scan the code again.',
  SCAN_ALREADY_RECORDED: 'Attendance for this scan has already been recorded.',
  SCAN_NOT_ACTIONABLE: 'There is nothing to record for this scan.',
  SCAN_ACTION_MISMATCH: 'That action no longer matches this scan. Scan the code again.',
  SELF_SCAN_FORBIDDEN:
    'You cannot record your own attendance with the scanner. Ask another operator or an administrator to scan your code.',

  QR_EXPIRED: 'This QR code has expired. Ask the employee to generate a new one.',
  QR_ALREADY_USED: 'This QR code has already been scanned.',
  QR_SUPERSEDED:
    'This QR code was replaced by a newer one. Ask the employee to show the latest code.',
  QR_LIMIT_REACHED:
    'You have generated the maximum number of attendance QR codes for today. Ask an administrator for help.',

  VERIFICATION_REQUIRED: 'Verify that you are at the office first.',
  VERIFICATION_INVALID: 'This office verification is not valid. Please verify again.',
  VERIFICATION_EXPIRED: 'Your office verification has expired. Please verify again.',
  VERIFICATION_USED: 'This office verification has already been used. Please verify again.',
  VERIFICATION_FAILED: 'Office verification failed.',
  DEVICE_NOT_ACTIVE: 'This device is not registered or has been revoked.',

  CHALLENGE_INVALID: 'This security check is not valid. Please start again.',
  CHALLENGE_EXPIRED: 'This security check has expired. Please start again.',
  DEVICE_PROOF_INVALID: 'This device could not prove its identity.',
  DEVICE_LIMIT_REACHED:
    'You have reached the maximum number of devices. Remove one before adding another.',
  DEVICE_ALREADY_REGISTERED: 'This device is already registered.',

  IDEMPOTENCY_KEY_REUSED:
    'This Idempotency-Key was already used for a different request. Use a new key for a new action.',

  CORRECTION_INVALID: 'The requested correction is not valid.',
  CORRECTION_ALREADY_DECIDED: 'This correction request has already been decided.',
  SELF_APPROVAL_FORBIDDEN: 'You cannot approve a correction to your own attendance.',
};

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, value);
}

/** Shape of every error body the API returns. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
