import { z } from 'zod';
import { CHANNELS, type RoleName } from './enums.js';
import type { Paginated } from './employees.js';
import { isoDateSchema, paginationSchema, uuidSchema } from './schemas.js';

/**
 * The administrator-operated scanner's request and its history, and the retired ID-card codes.
 *
 * Attendance is now recorded from the short-lived code an employee generates (see daily-qr.ts):
 * the scanner reads it and the server records the attendance in one step. The permanent ID-card
 * code (`TGE1.…`) below is NO LONGER ACCEPTED by the scanner; its tables and types remain so that
 * history is not lost.
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

/**
 * How a scan stands. A scan is now recorded or refused at once; PENDING (and the derived EXPIRED)
 * only exist on scans made by the earlier two-step ID-card scanner.
 */
export const SCAN_STATUSES = ['PENDING', 'RECORDED', 'NO_ACTION', 'REJECTED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
export const SCAN_DISPLAY_STATUSES = [...SCAN_STATUSES, 'EXPIRED'] as const;
export type ScanDisplayStatus = (typeof SCAN_DISPLAY_STATUSES)[number];

/** The two actions a scan can record. */
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

export const QR_RESULTS = [
  'VALID',
  'REVOKED',
  'UNKNOWN',
  'MALFORMED',
  'EXPIRED',
  'USED',
  'SUPERSEDED',
] as const;
export type QrResult = (typeof QR_RESULTS)[number];

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
  /** Only on scans made by the earlier ID-card scanner, whose operator had to prove their location. */
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
