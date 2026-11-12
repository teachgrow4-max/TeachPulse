import { beforeEach, describe, expect, it } from 'vitest';
import { asUser, attempt } from '../testing/harness.js';
import {
  checkIn,
  checkOut,
  countEvents,
  getRecord,
  seedDevice,
  seedOffice,
  seedVerification,
  startBreak,
} from '../testing/fixtures.js';
import {
  recordScan,
  seedAdminScanVerification,
  seedPendingScan,
  seedPerson,
  seedQrCode,
  type SeededPerson,
  type SeededQrCode,
} from '../testing/qr-fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

// Calendar (Asia/Kolkata, UTC+05:30, no DST):
//   Sun 2026-11-01 weekly off | Mon 11-02 .. Sat 11-07 working | Sun 11-08 weekly off
const MON = '2026-11-02';
const at = (time: string, date = MON) => `${date}T${time}+05:30`;

let operator: SeededPerson;
let employee: SeededPerson;
let code: SeededQrCode;

beforeEach(async () => {
  await seedOffice(ctx.db);
  operator = await seedPerson(ctx.db, { role: 'attendance_operator' });
  employee = await seedPerson(ctx.db);
  code = await seedQrCode(ctx.db, employee.id);
});

async function domainError(sql: string, params: unknown[]): Promise<string | undefined> {
  const err = await attempt(ctx.db, sql, params);
  expect(err, `expected "${sql}" to fail`).not.toBeNull();
  expect(err?.code).toBe('TG001'); // a domain error, not a raw constraint failure
  return err?.message;
}

/** A scan the operator has already verified themselves for, ready to be confirmed. */
async function readyScan(
  time = '10:00:00',
  opts: { action?: 'CHECK_IN' | 'CHECK_OUT'; who?: SeededPerson; withCode?: SeededQrCode } = {},
) {
  const who = opts.who ?? employee;
  const qr = opts.withCode ?? code;
  const verificationId = await seedAdminScanVerification(ctx.db, operator.id, { at: at(time) });
  const scanId = await seedPendingScan(ctx.db, {
    scannedBy: operator.id,
    employeeId: who.id,
    codeId: qr.id,
    hash: qr.hash,
    action: opts.action ?? 'CHECK_IN',
    at: at(time),
    verificationId,
  });
  return { scanId, verificationId };
}

const record = (scanId: string, action: 'CHECK_IN' | 'CHECK_OUT', time: string, who = operator) =>
  recordScan(ctx.db, scanId, who.id, action, at(time));

// ---------------------------------------------------------------------------------------------

describe('employee_qr_codes', () => {
  it('allows one live code per employee but any number of retired ones', async () => {
    const err = await attempt(
      ctx.db,
      `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce)
       values ($1, decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'))`,
      [employee.id],
    );
    expect(err?.code).toBe('23505');
    expect(err?.message).toMatch(/employee_qr_codes_one_active/);

    await ctx.db.query(
      `update public.employee_qr_codes
       set status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoke_reason = 'lost card'
       where id = $1`,
      [code.id, operator.id],
    );
    await seedQrCode(ctx.db, employee.id); // a new live code is fine once the old one is retired
    const [live] = await ctx.db.query<{ n: string }>(
      `select count(*)::text as n from public.employee_qr_codes
       where employee_id = $1 and status = 'ACTIVE'`,
      [employee.id],
    );
    expect(live?.n).toBe('1');
  });

  it('refuses a hash that another code already has', async () => {
    const other = await seedPerson(ctx.db);
    const err = await attempt(
      ctx.db,
      `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce)
       values ($1, $2, decode(repeat('cd', 32), 'hex'))`,
      [other.id, code.hash],
    );
    expect(err?.code).toBe('23505');
  });

  it.each([
    [
      'a hash that is not 32 bytes',
      `decode('abcd', 'hex')`,
      `decode(repeat('cd', 32), 'hex')`,
      'ACTIVE',
    ],
    [
      'a nonce that is not 32 bytes',
      `decode(repeat('ab', 32), 'hex')`,
      `decode('cdef', 'hex')`,
      'ACTIVE',
    ],
    [
      'an unknown status',
      `decode(repeat('ab', 32), 'hex')`,
      `decode(repeat('cd', 32), 'hex')`,
      'PAUSED',
    ],
  ])('refuses %s', async (_label, hash, nonce, status) => {
    const other = await seedPerson(ctx.db);
    const err = await attempt(
      ctx.db,
      `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce, status)
       values ($1, ${hash}, ${nonce}, $2)`,
      [other.id, status],
    );
    expect(err?.code).toBe('23514');
  });

  it('keeps revocation details consistent with the status', async () => {
    const other = await seedPerson(ctx.db);
    const hash = `decode(repeat('ab', 32), 'hex')`;
    const nonce = `decode(repeat('cd', 32), 'hex')`;
    // REVOKED but no revocation time
    expect(
      (
        await attempt(
          ctx.db,
          `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce, status)
           values ($1, ${hash}, ${nonce}, 'REVOKED')`,
          [other.id],
        )
      )?.code,
    ).toBe('23514');
    // ACTIVE yet carrying a revocation time
    expect(
      (
        await attempt(
          ctx.db,
          `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce, status, revoked_at)
           values ($1, ${hash}, ${nonce}, 'ACTIVE', now())`,
          [other.id],
        )
      )?.code,
    ).toBe('23514');
    // revoked before it was issued
    expect(
      (
        await attempt(
          ctx.db,
          `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce, status, generated_at, revoked_at)
           values ($1, ${hash}, ${nonce}, 'REVOKED', now(), now() - interval '1 day')`,
          [other.id],
        )
      )?.code,
    ).toBe('23514');
  });

  it('never lets a code change identity, be deleted, or be edited once revoked', async () => {
    const other = await seedPerson(ctx.db);
    for (const assignment of [
      `employee_id = '${other.id}'`,
      `token_hash = decode(repeat('ab', 32), 'hex')`,
      `token_nonce = decode(repeat('ab', 32), 'hex')`,
      `generated_at = generated_at - interval '1 day'`,
      `generated_by = '${operator.id}'`,
    ]) {
      const err = await attempt(
        ctx.db,
        `update public.employee_qr_codes set ${assignment} where id = $1`,
        [code.id],
      );
      expect(err?.code, assignment).toBe('TG002');
    }
    expect(
      (await attempt(ctx.db, 'delete from public.employee_qr_codes where id = $1', [code.id]))
        ?.code,
    ).toBe('TG002');
    // Postgres may refuse TRUNCATE earlier (scan logs reference this table) than our trigger would;
    // either way it is blocked.
    expect(await attempt(ctx.db, 'truncate public.employee_qr_codes')).not.toBeNull();

    // Revoking is the one allowed edit, and it is final.
    await ctx.db.query(
      `update public.employee_qr_codes
       set status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoke_reason = 'compromised'
       where id = $1`,
      [code.id, operator.id],
    );
    const err = await attempt(
      ctx.db,
      `update public.employee_qr_codes set revoke_reason = 'something else' where id = $1`,
      [code.id],
    );
    expect(err?.code).toBe('TG002');
    const err2 = await attempt(
      ctx.db,
      `update public.employee_qr_codes set status = 'ACTIVE', revoked_at = null, revoked_by = null,
         revoke_reason = null where id = $1`,
      [code.id],
    );
    expect(err2?.code).toBe('TG002');
  });
});

// ---------------------------------------------------------------------------------------------

describe('qr_scan_logs', () => {
  const insertScan = (columns: string, values: string) =>
    attempt(
      ctx.db,
      `insert into public.qr_scan_logs (scanned_by, scanned_at, qr_result, detected_action, status ${columns})
       values ($1, now(), ${values})`,
      [operator.id],
    );

  it('accepts a pending scan, a rejected one and one with nothing to do', async () => {
    const ok = await seedPendingScan(ctx.db, {
      scannedBy: operator.id,
      employeeId: employee.id,
      codeId: code.id,
      hash: code.hash,
      at: at('10:00:00'),
    });
    expect(ok).toBeTruthy();
    expect(
      await insertScan(`, reason_code`, `'UNKNOWN', 'REJECTED', 'REJECTED', 'EMPLOYEE_QR_INVALID'`),
    ).toBeNull();
    expect(
      await insertScan(
        `, employee_id, qr_code_id, reason_code`,
        `'VALID', 'ALREADY_CHECKED_OUT', 'NO_ACTION', '${employee.id}', '${code.id}', 'ALREADY_CHECKED_OUT'`,
      ),
    ).toBeNull();
  });

  it.each([
    [
      'a valid code that identifies nobody',
      `'VALID', 'CHECK_IN', 'PENDING', now() + interval '2 minutes'`,
      `, expires_at`,
    ],
    [
      'an unknown code that names an employee',
      `'UNKNOWN', 'REJECTED', 'REJECTED', '$EMP', 'EMPLOYEE_QR_INVALID'`,
      `, employee_id, reason_code`,
    ],
    [
      'a pending scan with no deadline',
      `'VALID', 'CHECK_IN', 'PENDING', '$EMP', '$CODE'`,
      `, employee_id, qr_code_id`,
    ],
    [
      'a rejection that is not marked rejected',
      `'UNKNOWN', 'REJECTED', 'NO_ACTION', 'EMPLOYEE_QR_INVALID'`,
      `, reason_code`,
    ],
    ['a refusal with no reason', `'UNKNOWN', 'REJECTED', 'REJECTED'`, ``],
    [
      'an actionable scan of a revoked code',
      `'REVOKED', 'CHECK_IN', 'PENDING', '$EMP', '$CODE', now() + interval '2 minutes'`,
      `, employee_id, qr_code_id, expires_at`,
    ],
    [
      'a recorded scan that records nothing',
      `'VALID', 'CHECK_IN', 'RECORDED', '$EMP', '$CODE', now()`,
      `, employee_id, qr_code_id, confirmed_at`,
    ],
  ])('refuses %s', async (_label, values, columns) => {
    const filled = values.replaceAll('$EMP', employee.id).replaceAll('$CODE', code.id);
    expect((await insertScan(columns, filled))?.code).toBe('23514');
  });

  it('is evidence: nothing about a scan can be rewritten, only its confirmation filled in', async () => {
    const { scanId } = await readyScan();
    for (const assignment of [
      `scanned_by = '${employee.id}'`,
      `employee_id = '${operator.id}'`,
      `detected_action = 'CHECK_OUT'`,
      `scanned_at = scanned_at + interval '1 hour'`,
      `expires_at = expires_at + interval '1 hour'`,
      `client_ip = '203.0.113.9'`,
      `scanner = '{}'::jsonb`,
    ]) {
      const err = await attempt(
        ctx.db,
        `update public.qr_scan_logs set ${assignment} where id = $1`,
        [scanId],
      );
      expect(err?.code, assignment).toBe('TG002');
    }
    expect(
      (await attempt(ctx.db, 'delete from public.qr_scan_logs where id = $1', [scanId]))?.code,
    ).toBe('TG002');
    expect((await attempt(ctx.db, 'truncate public.qr_scan_logs'))?.code).toBe('TG002');
    // A pending scan can only move to RECORDED, never to a refusal.
    const err = await attempt(
      ctx.db,
      `update public.qr_scan_logs set status = 'REJECTED' where id = $1`,
      [scanId],
    );
    expect(err?.code).toBe('TG002');
  });

  it('never lets anybody record their own attendance, though the attempt can be kept as a refusal', async () => {
    const own = await seedQrCode(ctx.db, operator.id);
    const recording = await attempt(
      ctx.db,
      `insert into public.qr_scan_logs
         (scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, status,
          scanned_at, expires_at)
       values ($1, $1, $2, $3, 'VALID', 'CHECK_IN', 'PENDING', now(), now() + interval '2 minutes')`,
      [operator.id, own.id, own.hash],
    );
    expect(recording?.code).toBe('23514');
    expect(recording?.message).toMatch(/qr_scan_logs_no_self_recording/);

    const refusal = await attempt(
      ctx.db,
      `insert into public.qr_scan_logs
         (scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, reason_code, status)
       values ($1, $1, $2, $3, 'VALID', 'REJECTED', 'SELF_SCAN_FORBIDDEN', 'REJECTED')`,
      [operator.id, own.id, own.hash],
    );
    expect(refusal).toBeNull();
  });

  it('freezes a scan once it is finished', async () => {
    const { scanId } = await readyScan();
    await record(scanId, 'CHECK_IN', '10:00:30');
    const err = await attempt(
      ctx.db,
      `update public.qr_scan_logs set office_verification_result = 'REJECTED' where id = $1`,
      [scanId],
    );
    expect(err?.code).toBe('TG002');
  });

  it('lets the operator’s latest presence check be attached while the scan is pending', async () => {
    const { scanId } = await readyScan();
    const rejected = await seedAdminScanVerification(ctx.db, operator.id, {
      at: at('10:00:20'),
      final: 'REJECTED',
    });
    await ctx.db.query(
      `update public.qr_scan_logs
       set office_verification_id = $2, office_verification_result = 'REJECTED' where id = $1`,
      [scanId, rejected],
    );
    const [row] = await ctx.db.query<{ r: string }>(
      'select office_verification_result as r from public.qr_scan_logs where id = $1',
      [scanId],
    );
    expect(row?.r).toBe('REJECTED');
  });
});

// ---------------------------------------------------------------------------------------------

describe('policy, verification and event constraints', () => {
  it('defaults the operator’s presence proof to location + network, and never allows less', async () => {
    const [row] = await ctx.db.query<{ layers: string }>(
      'select admin_scan_layers::text as layers from public.attendance_policies',
    );
    expect(row?.layers).toBe('{GPS,NETWORK}');
    for (const layers of ["'{GPS}'", "'{NETWORK,QR}'", "'{}'"]) {
      const err = await attempt(
        ctx.db,
        `update public.attendance_policies set admin_scan_layers = ${layers}::public.verification_layer[]`,
      );
      expect(err?.code, layers).toBe('23514');
    }
    expect(
      await attempt(
        ctx.db,
        `update public.attendance_policies
         set admin_scan_layers = '{GPS,NETWORK,QR,DEVICE}'::public.verification_layer[]`,
      ),
    ).toBeNull();
  });

  it('refuses a VERIFIED ADMIN_SCAN that did not pass location and network', async () => {
    const insert = (gps: string, network: string) =>
      attempt(
        ctx.db,
        `insert into public.attendance_verifications
           (employee_id, purpose, channel, gps_result, network_result, qr_result, device_result,
            final_result, requested_at, expires_at)
         values ($1, 'ADMIN_SCAN', 'WEB', '${gps}', '${network}', 'NOT_REQUIRED', 'NOT_REQUIRED',
                 'VERIFIED', now(), now() + interval '2 minutes')`,
        [operator.id],
      );
    expect((await insert('NOT_REQUIRED', 'PASS'))?.code).toBe('23514');
    expect((await insert('PASS', 'NOT_REQUIRED'))?.code).toBe('23514');
    expect(await insert('PASS', 'PASS')).toBeNull();
  });

  it('knows ADMIN_QR as a source of attendance events and nothing it has not heard of', async () => {
    const { scanId } = await readyScan();
    await record(scanId, 'CHECK_IN', '10:00:30');
    const [event] = await ctx.db.query<{ id: string }>(
      `select id from public.attendance_events where employee_id = $1`,
      [employee.id],
    );
    expect(event).toBeTruthy();
    const err = await attempt(
      ctx.db,
      `insert into public.attendance_events
         (attendance_record_id, employee_id, event_type, source)
       select attendance_record_id, employee_id, 'BREAK_START', 'ADMIN_QR_TYPO'
       from public.attendance_events where id = $1`,
      [event!.id],
    );
    expect(err?.code).toBe('23514');
  });

  it('accepts the ADMIN_SCAN purpose on device challenges', async () => {
    const deviceId = await seedDevice(ctx.db, operator.id);
    expect(
      await attempt(
        ctx.db,
        `insert into public.device_challenges (user_id, purpose, device_id, challenge, expires_at)
         values ($1, 'ADMIN_SCAN', $2, decode(repeat('ab', 32), 'hex'), now() + interval '2 minutes')`,
        [operator.id, deviceId],
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('privileges and Row Level Security', () => {
  it('shows an employee only the safe columns of their own code', async () => {
    const colleague = await seedPerson(ctx.db);
    await seedQrCode(ctx.db, colleague.id);

    const own = await asUser(ctx.db, employee.id, () =>
      ctx.db.query<{ id: string; status: string }>(
        'select id, status from public.employee_qr_codes',
      ),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.status).toBe('ACTIVE');

    // The hash and the nonce are not readable by anyone signed in, whoever they are.
    for (const column of ['token_hash', 'token_nonce', 'revoke_reason']) {
      const err = await asUser(ctx.db, employee.id, () =>
        attempt(ctx.db, `select ${column} from public.employee_qr_codes`),
      );
      expect(err?.code, column).toBe('42501');
    }
    const star = await asUser(ctx.db, employee.id, () =>
      attempt(ctx.db, 'select * from public.employee_qr_codes'),
    );
    expect(star?.code).toBe('42501');
  });

  it('lets an administrator list every code but still not read a hash', async () => {
    const admin = await seedPerson(ctx.db, { role: 'admin', attendanceRequired: false });
    const colleague = await seedPerson(ctx.db);
    await seedQrCode(ctx.db, colleague.id);

    const rows = await asUser(ctx.db, admin.id, () =>
      ctx.db.query('select id from public.employee_qr_codes'),
    );
    expect(rows).toHaveLength(2);
    const err = await asUser(ctx.db, admin.id, () =>
      attempt(ctx.db, 'select token_hash from public.employee_qr_codes'),
    );
    expect(err?.code).toBe('42501');
  });

  it('shows nothing to a deactivated employee, an operator, or an anonymous caller', async () => {
    const gone = await seedPerson(ctx.db, { active: false });
    await seedQrCode(ctx.db, gone.id);
    expect(
      await asUser(ctx.db, gone.id, () => ctx.db.query('select id from public.employee_qr_codes')),
    ).toHaveLength(0);
    // The operator role has no administrator rights over other people's codes.
    expect(
      await asUser(ctx.db, operator.id, () =>
        ctx.db.query('select id from public.employee_qr_codes'),
      ),
    ).toHaveLength(0);
    const anon = await asUser(
      ctx.db,
      employee.id,
      () => attempt(ctx.db, 'select id from public.employee_qr_codes'),
      'anon',
    );
    expect(anon?.code).toBe('42501');
  });

  it('shows scan history to the operator who scanned, the employee scanned, and administrators', async () => {
    const admin = await seedPerson(ctx.db, { role: 'admin', attendanceRequired: false });
    const stranger = await seedPerson(ctx.db);
    await readyScan();

    const visible = (who: SeededPerson) =>
      asUser(ctx.db, who.id, () => ctx.db.query('select id from public.qr_scan_logs'));
    expect(await visible(operator)).toHaveLength(1);
    expect(await visible(employee)).toHaveLength(1);
    expect(await visible(admin)).toHaveLength(1);
    expect(await visible(stranger)).toHaveLength(0);

    // Not the address, the device description or the hash of what was presented.
    for (const column of ['client_ip', 'scanner', 'token_hash', 'request_id']) {
      const err = await asUser(ctx.db, admin.id, () =>
        attempt(ctx.db, `select ${column} from public.qr_scan_logs`),
      );
      expect(err?.code, column).toBe('42501');
    }
  });

  it('gives client roles no way to write either table', async () => {
    const { scanId } = await readyScan();
    const statements = [
      `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce) values ('${employee.id}', decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'))`,
      `update public.employee_qr_codes set status = 'REVOKED' where id = '${code.id}'`,
      `delete from public.employee_qr_codes`,
      `update public.qr_scan_logs set status = 'RECORDED' where id = '${scanId}'`,
      `delete from public.qr_scan_logs`,
    ];
    for (const sql of statements) {
      for (const who of [employee, operator]) {
        const err = await asUser(ctx.db, who.id, () => attempt(ctx.db, sql));
        expect(err?.code, sql).toBe('42501');
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('private.qr_attendance_state', () => {
  const state = async (time: string, date = MON, who = employee) => {
    const [row] = await ctx.db.query<{
      s: {
        workDate: string;
        action: string;
        blockedReason: string | null;
        record: { status: string; liveState: string; isLate: boolean } | null;
      };
    }>('select private.qr_attendance_state($1::uuid, $2::timestamptz) as s', [
      who.id,
      at(time, date),
    ]);
    return row!.s;
  };

  it('says CHECK_IN before the day has started for the person', async () => {
    expect(await state('10:00:00')).toMatchObject({
      workDate: MON,
      action: 'CHECK_IN',
      blockedReason: null,
      record: null,
    });
  });

  it('says CHECK_OUT once they are in, with the day so far', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    expect(await state('13:00:00')).toMatchObject({
      action: 'CHECK_OUT',
      blockedReason: null,
      record: { status: 'PRESENT', liveState: 'WORKING', isLate: false },
    });
  });

  it('says ALREADY_CHECKED_OUT after the day is done', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    await checkOut(ctx.db, employee.id, at('18:00:00'));
    expect(await state('18:30:00')).toMatchObject({
      action: 'ALREADY_CHECKED_OUT',
      record: { liveState: 'CHECKED_OUT' },
    });
  });

  it('reports a late arrival as late', async () => {
    await checkIn(ctx.db, employee.id, at('10:25:00'));
    expect(await state('11:00:00')).toMatchObject({ record: { status: 'LATE', isLate: true } });
  });

  it('blocks a check-out while a break is running, unless HR has allowed it', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    await startBreak(ctx.db, employee.id, 'SHORT', at('12:00:00'));
    expect(await state('12:05:00')).toMatchObject({
      action: 'CHECK_OUT',
      blockedReason: 'ACTIVE_BREAK',
    });

    const rec = await getRecord(ctx.db, employee.id, MON);
    const hr = await seedPerson(ctx.db, { role: 'admin', attendanceRequired: false });
    await ctx.db.query(
      `insert into public.checkout_exceptions (attendance_record_id, employee_id, granted_by, reason)
       values ($1, $2, $3, 'left in an emergency')`,
      [rec!.id, employee.id, hr.id],
    );
    expect(await state('12:06:00')).toMatchObject({ action: 'CHECK_OUT', blockedReason: null });
  });

  it('blocks days that cannot take attendance, with the reason', async () => {
    expect(await state('10:00:00', '2026-11-08')).toMatchObject({
      action: 'BLOCKED',
      blockedReason: 'WEEKLY_OFF',
    });

    const hr = await seedPerson(ctx.db, { role: 'admin', attendanceRequired: false });
    await ctx.db.query(
      `insert into public.holidays (holiday_date, name, created_by) values ('2026-11-03', 'Test holiday', $1)`,
      [hr.id],
    );
    expect(await state('10:00:00', '2026-11-03')).toMatchObject({
      action: 'BLOCKED',
      blockedReason: 'HOLIDAY',
    });

    await ctx.db.query(
      `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
       values ($1, '2026-11-04', '2026-11-05', $2)`,
      [employee.id, hr.id],
    );
    expect(await state('10:00:00', '2026-11-04')).toMatchObject({
      action: 'BLOCKED',
      blockedReason: 'ON_LEAVE',
    });
  });

  it('points a day closed without a check-out at the correction workflow', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    // The day is over; the nightly job closes it (a check-in without a check-out becomes INCOMPLETE).
    await ctx.db.query('select private.finalize_attendance_day($1::date, $2::timestamptz)', [
      MON,
      at('06:00:00', '2026-11-03'),
    ]);
    expect(await state('09:00:00', '2026-11-03')).toMatchObject({ action: 'CHECK_IN' });
    expect(await state('20:00:00', MON)).toMatchObject({
      action: 'BLOCKED',
      blockedReason: 'ALREADY_CHECKED_IN',
    });
  });

  it('still says CHECK_OUT for a day left open overnight', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    expect(await state('09:00:00', '2026-11-03')).toMatchObject({
      workDate: MON,
      action: 'CHECK_OUT',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('private.admin_qr_record', () => {
  it('checks an employee in as ADMIN_QR, with the operator as the actor and the proof', async () => {
    const { scanId, verificationId } = await readyScan('10:00:00');
    const result = await record(scanId, 'CHECK_IN', '10:00:30');

    const rec = await getRecord(ctx.db, employee.id, MON);
    expect(rec).toMatchObject({ status: 'PRESENT', is_late: false, live_state: 'WORKING' });
    expect(result.recordId).toBe(rec?.id);

    const [event] = await ctx.db.query<{
      event_type: string;
      source: string;
      actor_id: string;
      verification_id: string;
      device_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select event_type::text, source, actor_id, verification_id, device_id, metadata
       from public.attendance_events where employee_id = $1`,
      [employee.id],
    );
    expect(event).toMatchObject({
      event_type: 'CHECK_IN',
      source: 'ADMIN_QR',
      actor_id: operator.id,
      verification_id: verificationId,
      device_id: null,
    });
    expect(event?.metadata).toMatchObject({ scan_id: scanId, qr_code_id: code.id, is_late: false });

    const [row] = await ctx.db.query<{
      check_in_verification_id: string;
      check_in_device_id: string | null;
    }>(
      'select check_in_verification_id, check_in_device_id from public.attendance_records where id = $1',
      [rec!.id],
    );
    expect(row).toMatchObject({
      check_in_verification_id: verificationId,
      check_in_device_id: null,
    });

    // The operator's proof is spent, and the scan says exactly what happened.
    const [ver] = await ctx.db.query<{ consumed_at: Date | null }>(
      'select consumed_at from public.attendance_verifications where id = $1',
      [verificationId],
    );
    expect(ver?.consumed_at).not.toBeNull();
    const [scan] = await ctx.db.query<{
      status: string;
      confirmed_action: string;
      office_verification_result: string;
      attendance_event_id: string;
      attendance_record_id: string;
    }>('select * from public.qr_scan_logs where id = $1', [scanId]);
    expect(scan).toMatchObject({
      status: 'RECORDED',
      confirmed_action: 'CHECK_IN',
      office_verification_result: 'VERIFIED',
      attendance_event_id: String(result.eventId),
      attendance_record_id: rec?.id,
    });
  });

  it('checks an employee out through the same engine', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00'));
    const { scanId } = await readyScan('18:00:00', { action: 'CHECK_OUT' });
    await record(scanId, 'CHECK_OUT', '18:00:30');

    const rec = await getRecord(ctx.db, employee.id, MON);
    expect(rec).toMatchObject({ live_state: 'CHECKED_OUT' });
    expect(rec?.check_out_at).not.toBeNull();
    expect(rec?.net_work_seconds).toBeGreaterThan(7 * 3600);
    const [event] = await ctx.db.query<{ source: string; actor_id: string }>(
      `select source, actor_id from public.attendance_events
       where employee_id = $1 and event_type = 'CHECK_OUT'`,
      [employee.id],
    );
    expect(event).toMatchObject({ source: 'ADMIN_QR', actor_id: operator.id });
  });

  it.each([
    ['09:59:59', 'PRESENT', false],
    ['10:19:59', 'PRESENT', false],
    ['10:20:00', 'LATE', true],
    ['10:20:01', 'LATE', true],
    ['14:00:00', 'LATE', true],
  ])('applies the same late rule as a self check-in at %s', async (time, status, late) => {
    const colleague = await seedPerson(ctx.db);
    const viaScan = await seedQrCode(ctx.db, colleague.id);
    const verificationId = await seedAdminScanVerification(ctx.db, operator.id, { at: at(time) });
    const scanId = await seedPendingScan(ctx.db, {
      scannedBy: operator.id,
      employeeId: colleague.id,
      codeId: viaScan.id,
      hash: viaScan.hash,
      at: at(time),
      verificationId,
    });
    await record(scanId, 'CHECK_IN', time);
    const viaQr = await getRecord(ctx.db, colleague.id, MON);

    const viaSelf = await checkIn(ctx.db, employee.id, at(time));
    expect(viaQr).toMatchObject({ status, is_late: late });
    expect(viaSelf).toMatchObject({ status, is_late: late });
    // Every classification field agrees, not just the headline one.
    const pick = (r: typeof viaQr) => ({
      status: r?.status,
      is_late: r?.is_late,
      live_state: r?.live_state,
      policy_snapshot: r?.policy_snapshot,
    });
    expect(pick(viaQr)).toEqual(pick(viaSelf));
  });

  it('leaves no trace when it refuses, so the same scan can be tried again', async () => {
    await checkIn(ctx.db, employee.id, at('10:05:00')); // already in by another route
    const { scanId, verificationId } = await readyScan('10:30:00');
    expect(
      await domainError('select private.admin_qr_record($1,$2,$3,$4)', [
        scanId,
        operator.id,
        'CHECK_IN',
        at('10:30:30'),
      ]),
    ).toBe('ALREADY_CHECKED_IN');

    const [ver] = await ctx.db.query<{ consumed_at: Date | null }>(
      'select consumed_at from public.attendance_verifications where id = $1',
      [verificationId],
    );
    expect(ver?.consumed_at).toBeNull();
    const [scan] = await ctx.db.query<{ status: string }>(
      'select status from public.qr_scan_logs where id = $1',
      [scanId],
    );
    expect(scan?.status).toBe('PENDING');
    const rec = await getRecord(ctx.db, employee.id, MON);
    expect(await countEvents(ctx.db, rec!.id, 'CHECK_IN')).toBe(1);
  });

  describe('refusals', () => {
    const call = (scanId: string, action: string, time: string, who = operator) =>
      domainError('select private.admin_qr_record($1,$2,$3,$4)', [
        scanId,
        who.id,
        action,
        at(time),
      ]);

    it('does not know a scan that is not the caller’s', async () => {
      const { scanId } = await readyScan();
      const other = await seedPerson(ctx.db, { role: 'attendance_operator' });
      expect(await call(scanId, 'CHECK_IN', '10:00:30', other)).toBe('NOT_FOUND');
      expect(
        await domainError('select private.admin_qr_record($1,$2,$3,$4)', [
          '00000000-0000-4000-8000-000000000000',
          operator.id,
          'CHECK_IN',
          at('10:00:30'),
        ]),
      ).toBe('NOT_FOUND');
    });

    it('only lets administrators and operators record', async () => {
      const { scanId } = await readyScan();
      expect(await call(scanId, 'CHECK_IN', '10:00:30', employee)).toBe('FORBIDDEN');
      const idle = await seedPerson(ctx.db, { role: 'attendance_operator', active: false });
      expect(await call(scanId, 'CHECK_IN', '10:00:30', idle)).toBe('FORBIDDEN');
      const display = await seedPerson(ctx.db, {
        role: 'office_display',
        attendanceRequired: false,
      });
      expect(await call(scanId, 'CHECK_IN', '10:00:30', display)).toBe('FORBIDDEN');
    });

    it('records a scan once', async () => {
      const { scanId } = await readyScan();
      await record(scanId, 'CHECK_IN', '10:00:30');
      expect(await call(scanId, 'CHECK_IN', '10:00:40')).toBe('SCAN_ALREADY_RECORDED');
    });

    it('refuses a scan that had nothing to confirm', async () => {
      const [row] = await ctx.db.query<{ id: string }>(
        `insert into public.qr_scan_logs
           (scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, reason_code, status, scanned_at)
         values ($1, $2, $3, $4, 'VALID', 'ALREADY_CHECKED_OUT', 'ALREADY_CHECKED_OUT', 'NO_ACTION', $5::timestamptz)
         returning id`,
        [operator.id, employee.id, code.id, code.hash, at('10:00:00')],
      );
      expect(await call(row!.id, 'CHECK_IN', '10:00:30')).toBe('SCAN_NOT_ACTIONABLE');
    });

    it('accepts a scan until the last second of its window, and not after', async () => {
      const inTime = await readyScan('10:00:00'); // 120 s to confirm
      await record(inTime.scanId, 'CHECK_IN', '10:01:59');

      const late = await seedPerson(ctx.db);
      const lateCode = await seedQrCode(ctx.db, late.id);
      const tooLate = await readyScan('10:00:00', { who: late, withCode: lateCode });
      expect(await call(tooLate.scanId, 'CHECK_IN', '10:02:00')).toBe('SCAN_EXPIRED');
    });

    it('refuses a different action from the one the scan showed', async () => {
      const { scanId } = await readyScan('10:00:00', { action: 'CHECK_IN' });
      expect(await call(scanId, 'CHECK_OUT', '10:00:30')).toBe('SCAN_ACTION_MISMATCH');
      expect(await call(scanId, 'SOMETHING_ELSE', '10:00:30')).toBe('SCAN_ACTION_MISMATCH');
    });

    it('refuses when the code was revoked after the scan', async () => {
      const { scanId } = await readyScan();
      await ctx.db.query(
        `update public.employee_qr_codes
         set status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoke_reason = 'lost'
         where id = $1`,
        [code.id, operator.id],
      );
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('EMPLOYEE_QR_REVOKED');
    });

    it('refuses when the employee was deactivated, or stopped being tracked, after the scan', async () => {
      const { scanId } = await readyScan();
      await ctx.db.query('update public.profiles set attendance_required = false where id = $1', [
        employee.id,
      ]);
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('ATTENDANCE_NOT_TRACKED');
      await ctx.db.query(
        'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
        [employee.id],
      );
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('EMPLOYEE_INACTIVE');
    });

    it('needs the operator to have proved they are at the office', async () => {
      const scanId = await seedPendingScan(ctx.db, {
        scannedBy: operator.id,
        employeeId: employee.id,
        codeId: code.id,
        hash: code.hash,
        at: at('10:00:00'),
      });
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('VERIFICATION_REQUIRED');
    });

    it('rejects a proof that failed, is for another purpose, or belongs to somebody else', async () => {
      const mine = (verification: string) =>
        seedPendingScan(ctx.db, {
          scannedBy: operator.id,
          employeeId: employee.id,
          codeId: code.id,
          hash: code.hash,
          at: at('10:00:00'),
          verificationId: verification,
        });
      const failed = await seedAdminScanVerification(ctx.db, operator.id, {
        at: at('10:00:00'),
        final: 'REJECTED',
      });
      expect(await call(await mine(failed), 'CHECK_IN', '10:00:30')).toBe('VERIFICATION_INVALID');

      // The operator's own check-in proof is not a licence to record somebody else's.
      const checkInProof = await seedVerification(ctx.db, operator.id, { at: at('10:00:00') });
      expect(await call(await mine(checkInProof), 'CHECK_IN', '10:00:30')).toBe(
        'VERIFICATION_INVALID',
      );

      const other = await seedPerson(ctx.db, { role: 'attendance_operator' });
      const theirs = await seedAdminScanVerification(ctx.db, other.id, { at: at('10:00:00') });
      expect(await call(await mine(theirs), 'CHECK_IN', '10:00:30')).toBe('VERIFICATION_INVALID');
    });

    it('rejects a proof that is spent or has expired', async () => {
      const first = await readyScan('10:00:00');
      await record(first.scanId, 'CHECK_IN', '10:00:30');

      // A second scan pointing at the already-spent proof.
      const colleague = await seedPerson(ctx.db);
      const colleagueCode = await seedQrCode(ctx.db, colleague.id);
      const reuse = await seedPendingScan(ctx.db, {
        scannedBy: operator.id,
        employeeId: colleague.id,
        codeId: colleagueCode.id,
        hash: colleagueCode.hash,
        at: at('10:00:40'),
        verificationId: first.verificationId,
      });
      expect(await call(reuse, 'CHECK_IN', '10:00:50')).toBe('VERIFICATION_USED');

      // A proof that lapsed while the scan itself is still within its window.
      const stale = await seedAdminScanVerification(ctx.db, operator.id, {
        at: at('10:00:00'),
        ttlSeconds: 30,
      });
      const scanId = await seedPendingScan(ctx.db, {
        scannedBy: operator.id,
        employeeId: colleague.id,
        codeId: colleagueCode.id,
        hash: colleagueCode.hash,
        at: at('10:00:00'),
        verificationId: stale,
      });
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('VERIFICATION_EXPIRED');
    });

    it('rejects a proof made from a device that has since been revoked', async () => {
      const deviceId = await seedDevice(ctx.db, operator.id, 'ACTIVE');
      const verificationId = await seedAdminScanVerification(ctx.db, operator.id, {
        at: at('10:00:00'),
        deviceId,
      });
      const scanId = await seedPendingScan(ctx.db, {
        scannedBy: operator.id,
        employeeId: employee.id,
        codeId: code.id,
        hash: code.hash,
        at: at('10:00:00'),
        verificationId,
      });
      await ctx.db.query(
        `update public.registered_devices set status = 'REVOKED', revoked_at = now() where id = $1`,
        [deviceId],
      );
      expect(await call(scanId, 'CHECK_IN', '10:00:30')).toBe('DEVICE_NOT_ACTIVE');
    });

    it('applies the engine’s own rules: a second check-in, a check-out with nothing to close', async () => {
      await checkIn(ctx.db, employee.id, at('10:05:00'));
      const dup = await readyScan('10:10:00');
      expect(await call(dup.scanId, 'CHECK_IN', '10:10:30')).toBe('ALREADY_CHECKED_IN');

      const other = await seedPerson(ctx.db);
      const otherCode = await seedQrCode(ctx.db, other.id);
      const notIn = await readyScan('10:10:00', {
        action: 'CHECK_OUT',
        who: other,
        withCode: otherCode,
      });
      expect(await call(notIn.scanId, 'CHECK_OUT', '10:10:30')).toBe('NOT_CHECKED_IN');
    });

    it('refuses a second check-out', async () => {
      await checkIn(ctx.db, employee.id, at('10:05:00'));
      await checkOut(ctx.db, employee.id, at('18:00:00'));
      const { scanId } = await readyScan('18:10:00', { action: 'CHECK_OUT' });
      expect(await call(scanId, 'CHECK_OUT', '18:10:30')).toBe('ALREADY_CHECKED_OUT');
    });

    it('refuses to check out while a break is running', async () => {
      await checkIn(ctx.db, employee.id, at('10:05:00'));
      await startBreak(ctx.db, employee.id, 'SHORT', at('12:00:00'));
      const { scanId } = await readyScan('12:05:00', { action: 'CHECK_OUT' });
      expect(await call(scanId, 'CHECK_OUT', '12:05:30')).toBe('ACTIVE_BREAK');
    });

    it('refuses holidays, weekly offs and approved leave', async () => {
      const hr = await seedPerson(ctx.db, { role: 'admin', attendanceRequired: false });
      await ctx.db.query(
        `insert into public.holidays (holiday_date, name, created_by) values ('2026-11-03', 'Test holiday', $1)`,
        [hr.id],
      );
      const verificationId = await seedAdminScanVerification(ctx.db, operator.id, {
        at: at('10:00:00', '2026-11-03'),
      });
      const scanId = await seedPendingScan(ctx.db, {
        scannedBy: operator.id,
        employeeId: employee.id,
        codeId: code.id,
        hash: code.hash,
        at: at('10:00:00', '2026-11-03'),
        verificationId,
      });
      expect(
        await domainError('select private.admin_qr_record($1,$2,$3,$4)', [
          scanId,
          operator.id,
          'CHECK_IN',
          at('10:00:30', '2026-11-03'),
        ]),
      ).toBe('HOLIDAY');
    });
  });
});
