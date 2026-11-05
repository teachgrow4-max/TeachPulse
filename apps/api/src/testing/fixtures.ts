import { randomUUID } from 'node:crypto';
import type { TestDb } from './harness.js';

/**
 * Test-only data builders. Coordinates, codes and names here are synthetic: production code and
 * migrations contain no office coordinates, IP addresses or employee IDs.
 */

export type RoleName = 'employee' | 'admin' | 'office_display';

export interface SeededUser {
  id: string;
  code: string;
}

let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};

export async function seedUser(
  db: TestDb,
  opts: {
    role?: RoleName;
    joiningDate?: string;
    attendanceRequired?: boolean;
    name?: string;
  } = {},
): Promise<SeededUser> {
  const n = next();
  const id = randomUUID();
  const code = `T${String(n).padStart(4, '0')}`;
  const email = `user${n}@test.invalid`;
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  await db.query(
    `insert into public.profiles
       (id, employee_code, full_name, email, joining_date, role_id, attendance_required)
     values ($1, $2, $3, $4, $5::date, (select id from public.roles where name = $6), $7)`,
    [
      id,
      code,
      opts.name ?? `Test User ${n}`,
      email,
      opts.joiningDate ?? '2026-01-01',
      opts.role ?? 'employee',
      opts.attendanceRequired ?? (opts.role ?? 'employee') === 'employee',
    ],
  );
  return { id, code };
}

export async function seedOffice(
  db: TestDb,
  overrides: { workingDays?: number[]; createdAt?: string } = {},
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into public.office_locations (name, latitude, longitude, working_days, created_at)
     values ('Test Office', 10.000000, 20.000000, $1::smallint[], $2::timestamptz)
     returning id`,
    [
      `{${(overrides.workingDays ?? [1, 2, 3, 4, 5, 6]).join(',')}}`,
      overrides.createdAt ?? '2026-10-01T00:00:00Z',
    ],
  );
  return row!.id;
}

export async function seedDevice(
  db: TestDb,
  employeeId: string,
  status: 'PENDING' | 'ACTIVE' | 'REVOKED' = 'ACTIVE',
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into public.registered_devices
       (employee_id, device_identifier, platform, status, approved_at, revoked_at)
     values ($1, $2, 'ANDROID', $3::public.device_status,
             case when $3 <> 'PENDING' then now() end,
             case when $3 = 'REVOKED' then now() end)
     returning id`,
    [employeeId, `device-${randomUUID()}`, status],
  );
  return row!.id;
}

export interface VerificationOptions {
  purpose?: 'CHECK_IN' | 'CHECK_OUT';
  /** When the verification was made. */
  at: string;
  ttlSeconds?: number;
  deviceId?: string | null;
  final?: 'VERIFIED' | 'REJECTED';
}

export async function seedVerification(
  db: TestDb,
  employeeId: string,
  opts: VerificationOptions,
): Promise<string> {
  const purpose = opts.purpose ?? 'CHECK_IN';
  const final = opts.final ?? 'VERIFIED';
  const rejected = final === 'REJECTED';
  const full = purpose === 'CHECK_IN';
  const [row] = await db.query<{ id: string }>(
    `insert into public.attendance_verifications
       (employee_id, purpose, channel, device_id,
        gps_result, network_result, qr_result, device_result, final_result, failure_reasons,
        distance_m, gps_accuracy_m, client_ip, requested_at, expires_at)
     values
       ($1, $2::public.verification_purpose, 'MOBILE', $3,
        case when $5 then 'FAIL' else 'PASS' end::public.verification_layer_result,
        'PASS',
        case when $4 then 'PASS' else 'NOT_REQUIRED' end::public.verification_layer_result,
        case when $3::uuid is not null then 'PASS' else 'NOT_REQUIRED' end::public.verification_layer_result,
        $6::public.verification_result,
        case when $5 then array['GPS_OUTSIDE_RADIUS'] else '{}'::text[] end,
        12.5, 8.0, '203.0.113.10', $7::timestamptz,
        case when $5 then null else $7::timestamptz + make_interval(secs => $8) end)
     returning id`,
    [
      employeeId,
      purpose,
      opts.deviceId ?? null,
      full,
      rejected,
      final,
      opts.at,
      opts.ttlSeconds ?? 120,
    ],
  );
  return row!.id;
}

export interface AttendanceRow {
  id: string;
  employee_id: string;
  work_date: string;
  status: string;
  live_state: string;
  check_in_at: Date | null;
  check_out_at: Date | null;
  is_late: boolean;
  is_half_day: boolean;
  is_early_checkout: boolean;
  overtime_minutes: number;
  total_break_seconds: number;
  net_work_seconds: number | null;
  is_finalized: boolean;
  has_correction: boolean;
  policy_snapshot: Record<string, unknown> | null;
}

export async function checkIn(
  db: TestDb,
  employeeId: string,
  at: string,
  opts: { deviceId?: string | null; verificationId?: string } = {},
): Promise<AttendanceRow> {
  const verification =
    opts.verificationId ??
    (await seedVerification(db, employeeId, { at, deviceId: opts.deviceId ?? null }));
  const [row] = await db.query<AttendanceRow>(
    'select * from private.check_in($1::uuid, $2::uuid, $3::timestamptz)',
    [employeeId, verification, at],
  );
  return row!;
}

export async function checkOut(
  db: TestDb,
  employeeId: string,
  at: string,
  opts: { verificationId?: string } = {},
): Promise<AttendanceRow> {
  const verification =
    opts.verificationId ?? (await seedVerification(db, employeeId, { at, purpose: 'CHECK_OUT' }));
  const [row] = await db.query<AttendanceRow>(
    'select * from private.check_out($1::uuid, $2::uuid, $3::timestamptz)',
    [employeeId, verification, at],
  );
  return row!;
}

export async function startBreak(
  db: TestDb,
  employeeId: string,
  type: 'LUNCH' | 'SHORT',
  at: string,
) {
  const [row] = await db.query<{ id: string; break_type: string }>(
    'select * from private.start_break($1::uuid, $2::public.break_type, $3::timestamptz)',
    [employeeId, type, at],
  );
  return row!;
}

export async function endBreak(
  db: TestDb,
  employeeId: string,
  at: string,
  type: 'LUNCH' | 'SHORT' | null = null,
) {
  const [row] = await db.query<{ id: string; duration_seconds: number }>(
    'select * from private.end_break($1::uuid, $2::public.break_type, $3::timestamptz)',
    [employeeId, type, at],
  );
  return row!;
}

export async function getRecord(
  db: TestDb,
  employeeId: string,
  workDate: string,
): Promise<AttendanceRow | undefined> {
  const [row] = await db.query<AttendanceRow>(
    'select * from public.attendance_records where employee_id = $1 and work_date = $2::date',
    [employeeId, workDate],
  );
  return row;
}

export async function countEvents(db: TestDb, recordId: string, type?: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    `select count(*)::text as n from public.attendance_events
     where attendance_record_id = $1 and ($2::text is null or event_type::text = $2)`,
    [recordId, type ?? null],
  );
  return Number(row!.n);
}

/** Update the seeded policy row in place (the test DB starts with the brief's defaults). */
export async function setPolicy(db: TestDb, assignments: string): Promise<void> {
  await db.exec(
    `update public.attendance_policies set ${assignments} where effective_from = '2000-01-01'`,
  );
}

export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
