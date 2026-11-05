import type { DeviceDto, DevicePlatform, DeviceStatus } from '@teachgrow/shared';

export interface DeviceRow {
  id: string;
  employee_id: string;
  device_identifier: string;
  platform: DevicePlatform;
  device_name: string | null;
  status: DeviceStatus;
  public_key: string | null;
  credential_id: string | null;
  attestation_provider: string | null;
  /** bigint columns arrive as strings (see db/pool.ts). */
  attestation_counter: string | null;
  registered_at: Date | string;
  approved_at: Date | string | null;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
}

/** Selected from `public.registered_devices` aliased as `d`; keep in sync with {@link DeviceRow}. */
export const DEVICE_COLUMNS = `
  d.id, d.employee_id, d.device_identifier, d.platform::text as platform, d.device_name,
  d.status::text as status, d.public_key, d.credential_id, d.attestation_provider,
  d.attestation_counter, d.registered_at, d.approved_at, d.last_seen_at, d.revoked_at,
  d.revoked_reason`;

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value ? iso(value) : null);

export function toDeviceDto(row: DeviceRow): DeviceDto {
  return {
    id: row.id,
    platform: row.platform,
    name: row.device_name,
    status: row.status,
    attestationProvider: row.attestation_provider,
    registeredAt: iso(row.registered_at),
    approvedAt: isoOrNull(row.approved_at),
    lastSeenAt: isoOrNull(row.last_seen_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}
