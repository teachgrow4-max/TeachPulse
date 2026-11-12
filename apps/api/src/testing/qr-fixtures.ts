import { randomUUID } from 'node:crypto';
import { deriveEmployeeQrKey, derivePayload, hashPayload, newNonce } from '../employee-qr/token.js';
import type { TestDb } from './harness.js';

/**
 * Test-only builders for the employee QR / admin scanner feature. Like fixtures.ts, everything here
 * is synthetic: production code and migrations contain no codes, people or coordinates.
 */

export type PersonRole = 'employee' | 'admin' | 'attendance_operator' | 'office_display';

/** The secret the test app derives employee codes from (see api-harness.ts). */
export const EMPLOYEE_QR_SECRET = 'employee-qr-secret-for-tests-0123456789abcdef';

let counter = 0;

export interface SeededPerson {
  id: string;
  code: string;
}

export async function seedPerson(
  db: TestDb,
  opts: {
    role?: PersonRole;
    attendanceRequired?: boolean;
    active?: boolean;
    name?: string;
  } = {},
): Promise<SeededPerson> {
  counter += 1;
  const id = randomUUID();
  const code = `Q${String(counter).padStart(4, '0')}`;
  const role = opts.role ?? 'employee';
  const active = opts.active ?? true;
  await db.query('insert into auth.users (id, email) values ($1, $2)', [
    id,
    `qr${counter}@test.invalid`,
  ]);
  await db.query(
    `insert into public.profiles
       (id, employee_code, full_name, email, joining_date, role_id, attendance_required,
        is_active, deactivated_at)
     values ($1, $2, $3, $4, '2026-01-01', (select id from public.roles where name = $5), $6,
             $7, case when $7 then null else now() end)`,
    [
      id,
      code,
      opts.name ?? `QR Person ${counter}`,
      `qr${counter}@test.invalid`,
      role,
      opts.attendanceRequired ?? role === 'employee',
      active,
    ],
  );
  return { id, code };
}

export interface SeededQrCode {
  id: string;
  payload: string;
  hash: Buffer;
  nonce: Buffer;
}

/** Issues a code exactly as the service does (same derivation), straight into the table. */
export async function seedQrCode(
  db: TestDb,
  employeeId: string,
  opts: { status?: 'ACTIVE' | 'REVOKED'; secret?: string; generatedAt?: string } = {},
): Promise<SeededQrCode> {
  const nonce = newNonce();
  const payload = derivePayload(
    deriveEmployeeQrKey(opts.secret ?? EMPLOYEE_QR_SECRET),
    employeeId,
    nonce,
  );
  const hash = hashPayload(payload);
  const revoked = opts.status === 'REVOKED';
  const generatedAt = opts.generatedAt ?? '2026-10-01T00:00:00Z';
  const [row] = await db.query<{ id: string }>(
    `insert into public.employee_qr_codes
       (employee_id, token_hash, token_nonce, status, generated_at, revoked_at, revoke_reason)
     values ($1, $2, $3, $4, $5::timestamptz,
             case when $4 = 'REVOKED' then $5::timestamptz + interval '1 hour' end,
             case when $4 = 'REVOKED' then 'seeded' end)
     returning id`,
    [employeeId, hash, nonce, revoked ? 'REVOKED' : 'ACTIVE', generatedAt],
  );
  return { id: row!.id, payload, hash, nonce };
}

/** A presence proof for the person operating the scanner (purpose ADMIN_SCAN). */
export async function seedAdminScanVerification(
  db: TestDb,
  operatorId: string,
  opts: {
    at: string;
    ttlSeconds?: number;
    final?: 'VERIFIED' | 'REJECTED';
    deviceId?: string | null;
    purpose?: 'ADMIN_SCAN' | 'CHECK_IN' | 'CHECK_OUT';
  },
): Promise<string> {
  const rejected = opts.final === 'REJECTED';
  const [row] = await db.query<{ id: string }>(
    `insert into public.attendance_verifications
       (employee_id, purpose, channel, device_id,
        gps_result, network_result, qr_result, device_result, final_result, failure_reasons,
        distance_m, gps_accuracy_m, client_ip, requested_at, expires_at)
     values
       ($1, $2::public.verification_purpose, 'WEB', $3,
        case when $4 then 'FAIL' else 'PASS' end::public.verification_layer_result,
        'PASS', 'NOT_REQUIRED',
        case when $3::uuid is not null then 'PASS' else 'NOT_REQUIRED' end::public.verification_layer_result,
        $5::public.verification_result,
        case when $4 then array['GPS_OUTSIDE_RADIUS'] else '{}'::text[] end,
        12.5, 8.0, '203.0.113.10', $6::timestamptz,
        case when $4 then null else $6::timestamptz + make_interval(secs => $7) end)
     returning id`,
    [
      operatorId,
      opts.purpose ?? 'ADMIN_SCAN',
      opts.deviceId ?? null,
      rejected,
      rejected ? 'REJECTED' : 'VERIFIED',
      opts.at,
      opts.ttlSeconds ?? 120,
    ],
  );
  return row!.id;
}

export interface PendingScanOptions {
  scannedBy: string;
  employeeId: string;
  codeId: string;
  hash: Buffer;
  action?: 'CHECK_IN' | 'CHECK_OUT';
  at: string;
  /** Seconds after `at` that the scan can still be confirmed. Default 120. */
  ttlSeconds?: number;
  verificationId?: string | null;
}

/** A scan that is waiting for the operator to confirm it. */
export async function seedPendingScan(db: TestDb, o: PendingScanOptions): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into public.qr_scan_logs
       (scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, status,
        scanned_at, expires_at, scanner, office_verification_id, office_verification_result)
     values
       ($1, $2, $3, $4, 'VALID', $5, 'PENDING', $6::timestamptz,
        $6::timestamptz + make_interval(secs => $7), '{"kind":"WEB"}'::jsonb, $8,
        case when $8::uuid is not null then 'VERIFIED' end)
     returning id`,
    [
      o.scannedBy,
      o.employeeId,
      o.codeId,
      o.hash,
      o.action ?? 'CHECK_IN',
      o.at,
      o.ttlSeconds ?? 120,
      o.verificationId ?? null,
    ],
  );
  return row!.id;
}

/** Calls the recording function and returns its JSON answer. */
export async function recordScan(
  db: TestDb,
  scanId: string,
  adminId: string,
  action: 'CHECK_IN' | 'CHECK_OUT',
  at: string,
): Promise<{ scanId: string; eventId: number | string; recordId: string }> {
  const [row] = await db.query<{
    result: { scanId: string; eventId: number | string; recordId: string };
  }>('select private.admin_qr_record($1::uuid, $2::uuid, $3, $4::timestamptz) as result', [
    scanId,
    adminId,
    action,
    at,
  ]);
  return row!.result;
}
