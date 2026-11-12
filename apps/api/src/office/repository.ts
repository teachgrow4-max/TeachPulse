import type { VerificationLayer } from '@teachgrow/shared';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

/**
 * Reads of the office configuration and the attendance policy, shared by the admin API and the
 * verification engine so both always see the same thing.
 */

export interface OfficeRow {
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
  createdAt: Date;
  updatedAt: Date;
}

interface OfficeDbRow {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  geofence_radius_m: number;
  max_gps_accuracy_m: number;
  max_fix_age_seconds: number;
  qr_rotation_seconds: number;
  timezone: string;
  working_days: number[];
  created_at: Date | string;
  updated_at: Date | string;
}

// numeric(9,6) would arrive as text; float8 gives plain numbers (6 decimals is ~11 cm).
const OFFICE_COLUMNS = `
  id, name, address,
  latitude::float8 as latitude, longitude::float8 as longitude,
  geofence_radius_m, max_gps_accuracy_m, max_fix_age_seconds, qr_rotation_seconds,
  timezone, working_days::int[] as working_days, created_at, updated_at`;

export function toOffice(row: OfficeDbRow): OfficeRow {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    geofenceRadiusM: row.geofence_radius_m,
    maxGpsAccuracyM: row.max_gps_accuracy_m,
    maxFixAgeSeconds: row.max_fix_age_seconds,
    qrRotationSeconds: row.qr_rotation_seconds,
    timezone: row.timezone,
    workingDays: [...row.working_days].sort((a, b) => a - b),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function loadActiveOffice(
  q: Queryable,
  options: { lock?: boolean } = {},
): Promise<OfficeRow | null> {
  const { rows } = await q.query<OfficeDbRow>(
    `select ${OFFICE_COLUMNS} from public.office_locations where is_active ${
      options.lock ? 'for update' : ''
    }`,
  );
  return rows[0] ? toOffice(rows[0]) : null;
}

/** The office, or a 503: until an administrator configures it nobody can verify anything. */
export async function requireActiveOffice(q: Queryable): Promise<OfficeRow> {
  const office = await loadActiveOffice(q);
  if (!office) throw new AppError('OFFICE_NOT_CONFIGURED');
  return office;
}

export interface PolicyRow {
  id: string;
  checkInLayersWeb: VerificationLayer[];
  checkInLayersMobile: VerificationLayer[];
  checkOutLayers: VerificationLayer[];
  /** What the person operating the QR attendance scanner must prove about their OWN presence. */
  adminScanLayers: VerificationLayer[];
  verificationTtlSeconds: number;
  maxDevicesPerEmployee: number;
  /** What an employee must prove before generating an attendance QR code (GPS and NETWORK always). */
  dailyQrLayers: VerificationLayer[];
  /** How long a generated attendance QR code can be scanned. */
  dailyQrTtlSeconds: number;
  /** How many attendance QR codes one person may generate per day. */
  dailyQrMaxPerDay: number;
}

/** The policy in force on the office-local calendar date of `at`. */
export async function loadPolicyAt(q: Queryable, at: Date, timezone: string): Promise<PolicyRow> {
  const { rows } = await q.query<{
    id: string;
    web: VerificationLayer[];
    mobile: VerificationLayer[];
    checkout: VerificationLayer[];
    admin_scan: VerificationLayer[];
    ttl: number;
    max_devices: number;
    qr_layers: VerificationLayer[];
    qr_ttl: number;
    qr_max: number;
  }>(
    `select id,
            check_in_layers_web::text[]    as web,
            check_in_layers_mobile::text[] as mobile,
            check_out_layers::text[]       as checkout,
            admin_scan_layers::text[]      as admin_scan,
            verification_ttl_seconds       as ttl,
            max_devices_per_employee       as max_devices,
            daily_qr_layers::text[]        as qr_layers,
            daily_qr_ttl_seconds           as qr_ttl,
            daily_qr_max_per_day           as qr_max
     from public.attendance_policies
     where effective_from <= (($1::timestamptz) at time zone $2)::date
     order by effective_from desc
     limit 1`,
    [at, timezone],
  );
  const row = rows[0];
  if (!row) throw new AppError('POLICY_NOT_FOUND');
  return {
    id: row.id,
    checkInLayersWeb: row.web,
    checkInLayersMobile: row.mobile,
    checkOutLayers: row.checkout,
    adminScanLayers: row.admin_scan,
    verificationTtlSeconds: row.ttl,
    maxDevicesPerEmployee: row.max_devices,
    dailyQrLayers: row.qr_layers,
    dailyQrTtlSeconds: row.qr_ttl,
    dailyQrMaxPerDay: row.qr_max,
  };
}

export interface NetworkRow {
  id: string;
  label: string;
  cidr: string;
  isActive: boolean;
  nonPublic: boolean;
  createdAt: Date;
}

/**
 * Ranges that can never be the office's public address as the API sees it: private (RFC 1918),
 * loopback, link-local, carrier-grade NAT, "this network", and the IPv6 equivalents.
 */
const NON_PUBLIC_RANGES = `array[
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16',
  '100.64.0.0/10', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128'
]::inet[]`;

export const NETWORK_COLUMNS = `
  n.id, n.label, n.cidr::text as cidr, n.is_active, n.created_at,
  (n.cidr <<= any (${NON_PUBLIC_RANGES})) as non_public`;

export interface NetworkDbRow {
  id: string;
  label: string;
  cidr: string;
  is_active: boolean;
  created_at: Date | string;
  non_public: boolean;
}

export function toNetwork(row: NetworkDbRow): NetworkRow {
  return {
    id: row.id,
    label: row.label,
    cidr: row.cidr,
    isActive: row.is_active,
    nonPublic: row.non_public,
    createdAt: new Date(row.created_at),
  };
}

export async function listNetworks(q: Queryable, officeId: string): Promise<NetworkRow[]> {
  const { rows } = await q.query<NetworkDbRow>(
    `select ${NETWORK_COLUMNS}
     from public.office_networks n
     where n.office_id = $1
     order by n.created_at, n.label`,
    [officeId],
  );
  return rows.map(toNetwork);
}
