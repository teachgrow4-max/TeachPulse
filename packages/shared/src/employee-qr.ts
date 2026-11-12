import { z } from 'zod';
import {
  CHANNELS,
  type AttendanceStatus,
  type LiveState,
  type RoleName,
  type VerificationLayer,
} from './enums.js';
import type { Paginated } from './employees.js';
import { isoDateSchema, paginationSchema, uuidSchema } from './schemas.js';
import { deviceEvidenceSchema, gpsEvidenceSchema, qrEvidenceSchema } from './verification.js';

/**
 * Employee QR codes and the administrator-operated scanner.
 *
 * Every employee has one personal QR code (printable on an ID card). An administrator or attendance
 * operator scans it, sees whose it is and what will happen, and confirms. The attendance goes into
 * the same records as a normal check-in, marked as coming from ADMIN_QR.
 *
 * Not to be confused with the OFFICE QR (`TG1.…`), the rotating code on the lobby screen that an
 * employee scans to prove they are in the building.
 */

// ---------------------------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------------------------

/** Prefix of an employee's personal code. The rotating office code uses `TG1`. */
export const EMPLOYEE_QR_PREFIX = 'TGE1';

/** `TGE1.` followed by 43 base64url characters (a 256-bit token). Nothing about the person is in it. */
export const EMPLOYEE_QR_PATTERN = /^TGE1\.[A-Za-z0-9_-]{43}$/;

export const looksLikeEmployeeQr = (text: string): boolean => EMPLOYEE_QR_PATTERN.test(text);

export const EMPLOYEE_QR_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type EmployeeQrStatus = (typeof EMPLOYEE_QR_STATUSES)[number];

/** What the API reports about a person's code: it also covers "never issued" and "revoked, none live". */
export type EmployeeQrState = EmployeeQrStatus | 'NONE';

// ---------------------------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------------------------

/** How a scan stands. EXPIRED is derived (a PENDING scan nobody confirmed in time). */
export const SCAN_STATUSES = ['PENDING', 'RECORDED', 'NO_ACTION', 'REJECTED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
export const SCAN_DISPLAY_STATUSES = [...SCAN_STATUSES, 'EXPIRED'] as const;
export type ScanDisplayStatus = (typeof SCAN_DISPLAY_STATUSES)[number];

/** The two things an operator can confirm. */
export const SCAN_ACTIONS = ['CHECK_IN', 'CHECK_OUT'] as const;
export type ScanAction = (typeof SCAN_ACTIONS)[number];

/** Everything a scan can turn out to mean. */
export const DETECTED_ACTIONS = [
  'CHECK_IN',
  'CHECK_OUT',
  'ALREADY_CHECKED_OUT',
  'BLOCKED',
  'REJECTED',
] as const;
export type DetectedAction = (typeof DETECTED_ACTIONS)[number];

export const QR_RESULTS = ['VALID', 'REVOKED', 'UNKNOWN', 'MALFORMED'] as const;
export type QrResult = (typeof QR_RESULTS)[number];

/** Why a valid scan has nothing to confirm. Also the reason stored on the scan log. */
export const SCAN_REASON_MESSAGES = {
  ALREADY_CHECKED_OUT: 'This employee has already checked out today.',
  HOLIDAY: 'Today is a company holiday, so attendance cannot be recorded.',
  WEEKLY_OFF: 'Today is a weekly off day, so attendance cannot be recorded.',
  ON_LEAVE: 'This employee is on approved leave today, so attendance cannot be recorded.',
  ACTIVE_BREAK:
    'This employee is on a break. They must end it before checking out, unless HR has allowed checkout during a break.',
  ALREADY_CHECKED_IN:
    'This employee’s day was closed without a check-out. An administrator has to correct it.',
} as const;
export type ScanReasonCode = keyof typeof SCAN_REASON_MESSAGES;

export function isScanReasonCode(value: string): value is ScanReasonCode {
  return Object.prototype.hasOwnProperty.call(SCAN_REASON_MESSAGES, value);
}

/** Describes the device in the operator's hands. Declared by the client, so informational only. */
export const scannerInfoSchema = z.strictObject({
  kind: z.enum(CHANNELS),
  label: z.string().trim().max(80).optional(),
  camera: z.string().trim().max(120).optional(),
});
export type ScannerInfo = z.infer<typeof scannerInfoSchema>;

/**
 * A scanned code. The limit is generous on purpose: a camera may read any QR in view (a URL, a
 * poster), and that should be answered "not recognised", not "your request was malformed".
 */
export const scanRequestSchema = z.strictObject({
  payload: z.string().min(1).max(4096),
  scanner: scannerInfoSchema,
});
export type ScanRequest = z.input<typeof scanRequestSchema>;

/** The operator's own presence evidence. The purpose (ADMIN_SCAN) is implied by the endpoint. */
export const scanVerifyRequestSchema = z.strictObject({
  channel: z.enum(CHANNELS),
  gps: gpsEvidenceSchema.optional(),
  qr: qrEvidenceSchema.optional(),
  device: deviceEvidenceSchema.optional(),
});
export type ScanVerifyRequest = z.input<typeof scanVerifyRequestSchema>;
export type ScanVerifyBody = z.output<typeof scanVerifyRequestSchema>;

/** Ask for a one-time challenge for the operator's registered device (ADMIN_SCAN). */
export const scannerChallengeRequestSchema = z.strictObject({ deviceId: uuidSchema });

/** The operator confirms what the scan showed. The server refuses if it no longer matches. */
export const confirmScanRequestSchema = z.strictObject({ action: z.enum(SCAN_ACTIONS) });
export type ConfirmScanRequest = z.input<typeof confirmScanRequestSchema>;

export interface ScanEmployeeCard {
  id: string;
  employeeCode: string;
  fullName: string;
  avatarUrl: string | null;
  department: string | null;
  designation: string | null;
  accountStatus: 'ACTIVE' | 'INACTIVE';
}

export interface ScanTodayDto {
  workDate: string;
  /** null while nothing has happened today. */
  status: AttendanceStatus | null;
  liveState: LiveState;
  checkInAt: string | null;
  checkOutAt: string | null;
  isLate: boolean;
}

export interface ScanReasonDto {
  code: ScanReasonCode;
  message: string;
}

/** Body of a successful `POST /api/qr-attendance/scan`. */
export interface ScanResolution {
  scanId: string;
  scannedAt: string;
  /** The operator has until then to confirm. */
  expiresAt: string;
  employee: ScanEmployeeCard;
  today: ScanTodayDto;
  /** CHECK_IN / CHECK_OUT await confirmation; the others are shown and nothing more. */
  action: Exclude<DetectedAction, 'REJECTED'>;
  reason: ScanReasonDto | null;
  /** The presence layers the operator must pass before confirming (their own, not the employee's). */
  requiredLayers: VerificationLayer[];
}

/** `error.details` of a scan that was refused (unknown, revoked, inactive …). */
export interface ScanRejectionDetails {
  scanId: string;
  /** Present when the code did identify somebody (revoked, inactive), so staff know who to help. */
  employee?: { employeeCode: string; fullName: string };
}

/** Body of a successful `POST /api/qr-attendance/scans/:id/confirm`. */
export interface ConfirmScanResponse {
  scanId: string;
  action: ScanAction;
  recordedAt: string;
  source: 'ADMIN_QR';
  employee: { id: string; employeeCode: string; fullName: string };
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

export interface ScanLogPerson {
  id: string;
  employeeCode: string;
  fullName: string;
}

/** One row of scan history. */
export interface ScanLogDto {
  id: string;
  scannedAt: string;
  status: ScanDisplayStatus;
  qrResult: QrResult;
  detectedAction: DetectedAction;
  reasonCode: string | null;
  employee: ScanLogPerson | null;
  scannedBy: ScanLogPerson & { role: RoleName };
  confirmedAt: string | null;
  confirmedAction: ScanAction | null;
  /** The operator's own presence check: the last attempt made for this scan. */
  officeVerification: 'VERIFIED' | 'REJECTED' | null;
  attendanceEventId: string | null;
  scanner: { kind?: string; label?: string; camera?: string; userAgent?: string };
  /** Administrators only. */
  clientIp: string | null;
}

export const listScansQuerySchema = paginationSchema
  .extend({
    /** Office-timezone calendar dates, inclusive. */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    employeeId: uuidSchema.optional(),
    scannedBy: uuidSchema.optional(),
    status: z.enum(SCAN_DISPLAY_STATUSES).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '`from` must not be after `to`.',
    path: ['to'],
  });
export type ListScansQuery = z.output<typeof listScansQuerySchema>;
export type ScanLogPage = Paginated<ScanLogDto>;

// ---------------------------------------------------------------------------------------------
// Looking after the codes
// ---------------------------------------------------------------------------------------------

export interface EmployeeQrHolder {
  employeeCode: string;
  fullName: string;
  department: string | null;
  designation: string | null;
  avatarUrl: string | null;
}

/** Body of `GET /api/employee-qr/me`. */
export interface EmployeeQrDto {
  status: EmployeeQrState;
  /** The text to draw as a QR image. null when there is no live code. */
  payload: string | null;
  generatedAt: string | null;
  revokedAt: string | null;
  holder: EmployeeQrHolder;
}

export interface EmployeeQrCodeRecordDto {
  id: string;
  status: EmployeeQrStatus;
  generatedAt: string;
  generatedBy: { id: string; fullName: string } | null;
  revokedAt: string | null;
  revokedBy: { id: string; fullName: string } | null;
  revokeReason: string | null;
}

/** One row of the administrator's list of employees and their codes. */
export interface AdminEmployeeQrRow {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    email: string;
    role: RoleName;
    department: string | null;
    designation: string | null;
    isActive: boolean;
  };
  qr: {
    status: EmployeeQrState;
    generatedAt: string | null;
    revokedAt: string | null;
    /** How many codes this person has ever had. */
    issued: number;
  };
  lastScanAt: string | null;
}

/** Body of `GET /api/admin/employee-qr/:employeeId`. */
export interface AdminEmployeeQrDetail extends EmployeeQrDto {
  employeeId: string;
  history: EmployeeQrCodeRecordDto[];
}

export const QR_FILTER_STATES = ['ACTIVE', 'REVOKED', 'NONE'] as const;

export const listEmployeeQrQuerySchema = paginationSchema.extend({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : undefined)),
  qrStatus: z.enum(QR_FILTER_STATES).optional(),
  departmentId: uuidSchema.optional(),
});
export type ListEmployeeQrQuery = z.output<typeof listEmployeeQrQuerySchema>;

export const regenerateQrRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500).optional(),
});

export const revokeQrRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

/** Body of `POST /api/admin/employee-qr/backfill`. */
export interface BackfillQrResponse {
  issued: number;
}
