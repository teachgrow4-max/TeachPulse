import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './schemas.js';
import { gpsEvidenceSchema, type VerificationReasonDto } from './verification.js';

/**
 * Office configuration contracts (administrator only). The office coordinates and network
 * addresses are supplied by the company: nothing in this codebase ships with defaults for them.
 */

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Create or change the office. On first use `name`, `latitude` and `longitude` are required; later
 * only the fields you send change.
 */
export const officeSettingsUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(150).optional(),
    address: z.string().trim().max(500).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    /** How close to the office (metres) counts as "at the office". */
    geofenceRadiusM: z.number().int().min(10).max(5000).optional(),
    /** A location reading less precise than this (metres) is rejected outright. */
    maxGpsAccuracyM: z.number().int().min(5).max(500).optional(),
    /** A location reading older than this many seconds is rejected as stale. */
    maxFixAgeSeconds: z.number().int().min(5).max(300).optional(),
    qrRotationSeconds: z.number().int().min(30).max(60).optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isTimeZone, 'Use an IANA timezone name such as Asia/Kolkata.')
      .optional(),
    /** ISO weekdays, 1 = Monday ... 7 = Sunday. Days not listed are weekly offs. */
    workingDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'List each day once.')
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one setting to change.' });
    }
    if (value.latitude === 0 && value.longitude === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['latitude'],
        message: 'Coordinates 0, 0 are almost certainly a mistake. Enter the real office location.',
      });
    }
  });
export type OfficeSettingsUpdate = z.output<typeof officeSettingsUpdateSchema>;

export const createNetworkSchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  /** A single public IP (`203.0.113.10`) or a range in CIDR form (`203.0.113.0/29`). IPv4 or IPv6. */
  cidr: z.string().trim().min(2).max(64),
});

export const updateNetworkSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(100).optional(),
    cidr: z.string().trim().min(2).max(64).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change.');

/** Try a hypothetical location and/or network against the saved configuration. Writes nothing. */
export const officeTestRequestSchema = z.strictObject({
  gps: gpsEvidenceSchema.optional(),
  /** Defaults to the address this request came from. */
  ipAddress: z.string().trim().min(2).max(64).optional(),
});

export interface OfficeSettingsDto {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
  maxGpsAccuracyM: number;
  maxFixAgeSeconds: number;
  qrRotationSeconds: number;
  timezone: string;
  workingDays: number[];
  updatedAt: string;
}

export interface OfficeNetworkDto {
  id: string;
  label: string;
  cidr: string;
  isActive: boolean;
  /**
   * True for private, loopback, link-local or shared-address ranges. The API only ever sees the
   * office's PUBLIC address, so such an entry can never match a real employee.
   */
  nonPublic: boolean;
  createdAt: string;
}

export const READINESS_ISSUE_CODES = [
  'OFFICE_NOT_CONFIGURED',
  'NO_ACTIVE_NETWORK',
  'ONLY_NON_PUBLIC_NETWORKS',
  'NO_QR_DISPLAY_ACCOUNT',
  'ACCURACY_EXCEEDS_RADIUS',
] as const;
export type ReadinessIssueCode = (typeof READINESS_ISSUE_CODES)[number];

export interface OfficeReadinessIssue {
  code: ReadinessIssueCode;
  message: string;
}

export interface OfficeSettingsResponse {
  office: OfficeSettingsDto | null;
  networks: OfficeNetworkDto[];
  /** What would stop employees from verifying right now. Empty `issues` means ready. */
  readiness: { ready: boolean; issues: OfficeReadinessIssue[] };
}

export interface OfficeTestResponse {
  gps: {
    result: 'PASS' | 'FAIL' | 'NOT_TESTED';
    distanceMeters: number | null;
    radiusM: number;
    maxAccuracyM: number;
    reasons: VerificationReasonDto[];
  };
  network: {
    result: 'PASS' | 'FAIL';
    ipAddress: string | null;
    /** `request` = the address this call came from; `supplied` = the one you typed. */
    source: 'request' | 'supplied';
    matchedNetwork: { id: string; label: string; cidr: string } | null;
    reasons: VerificationReasonDto[];
  };
  qr: {
    rotationSeconds: number;
    currentWindow: { validFrom: string; expiresAt: string };
  };
}
