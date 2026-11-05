import { beforeEach, describe, expect, it } from 'vitest';
import { attempt } from '../testing/harness.js';
import {
  checkIn,
  checkOut,
  countEvents,
  getRecord,
  iso,
  seedOffice,
  seedUser,
  seedVerification,
  setPolicy,
  startBreak,
  type SeededUser,
} from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

const MON = '2026-11-02';
const TUE = '2026-11-03';
const at = (time: string, date = MON) => `${date}T${time}+05:30`;
// Well after the days under test so they are all in the past.
const NOW = at('12:00:00', '2026-11-20');

let emp: SeededUser;
let other: SeededUser;
let admin: SeededUser;

beforeEach(async () => {
  await seedOffice(ctx.db);
  emp = await seedUser(ctx.db);
  other = await seedUser(ctx.db);
  admin = await seedUser(ctx.db, { role: 'admin', attendanceRequired: false });
});

async function domainError(sql: string, params: unknown[]): Promise<string | undefined> {
  const err = await attempt(ctx.db, sql, params);
  expect(err, `expected "${sql}" to fail`).not.toBeNull();
  expect(err?.code).toBe('TG001');
  return err?.message;
}

const requestCorrection = (
  employee: string,
  date: string,
  proposed: object,
  reason = 'Forgot to check in',
) =>
  ctx.db.query<{ id: string; status: string }>(
    `select * from private.create_correction($1::uuid, $2::date, $3::jsonb, $4, $1::uuid, 'EMPLOYEE_REQUEST', $5::timestamptz)`,
    [employee, date, JSON.stringify(proposed), reason, NOW],
  );

const decide = (correction: string, adminId: string, approve: boolean) =>
  ctx.db.query<{ id: string; status: string; decided_by: string }>(
    `select * from private.decide_correction($1::uuid, $2::uuid, $3, 'noted', $4::timestamptz)`,
    [correction, adminId, approve, NOW],
  );

describe('attendance corrections', () => {
  it('applies an approved correction without ever altering the original events', async () => {
    await checkIn(ctx.db, emp.id, at('10:45:00')); // late
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    const before = await getRecord(ctx.db, emp.id, MON);
    expect(before?.status).toBe('LATE');

    const [correction] = await requestCorrection(emp.id, MON, {
      check_in_at: at('09:58:00'),
      status: 'PRESENT',
    });
    expect(correction?.status).toBe('PENDING');
    const [decided] = await decide(correction!.id, admin.id, true);
    expect(decided).toMatchObject({ status: 'APPROVED', decided_by: admin.id });

    const after = await getRecord(ctx.db, emp.id, MON);
    expect(after).toMatchObject({ status: 'PRESENT', is_late: false, has_correction: true });
    expect(iso(after!.check_in_at)).toBe(iso(at('09:58:00')));
    // net hours recomputed from the corrected check-in: 09:58 -> 18:00
    expect(after!.net_work_seconds).toBe(8 * 3600 + 2 * 60);

    // The ledger still holds the ORIGINAL check-in, plus a CORRECTION_APPLIED event with before/after.
    const checkInEvent = await ctx.db.query<{ occurred_at: Date }>(
      `select occurred_at from public.attendance_events where attendance_record_id = $1 and event_type = 'CHECK_IN'`,
      [before!.id],
    );
    expect(iso(checkInEvent[0]!.occurred_at)).toBe(iso(at('10:45:00')));
    expect(await countEvents(ctx.db, before!.id, 'CORRECTION_APPLIED')).toBe(1);
    const [applied] = await ctx.db.query<{
      metadata: { before: { status: string }; after: { status: string }; correction_id: string };
      actor_id: string;
      source: string;
    }>(
      `select metadata, actor_id, source from public.attendance_events
       where attendance_record_id = $1 and event_type = 'CORRECTION_APPLIED'`,
      [before!.id],
    );
    expect(applied).toMatchObject({ actor_id: admin.id, source: 'ADMIN' });
    expect(applied!.metadata.before.status).toBe('LATE');
    expect(applied!.metadata.after.status).toBe('PRESENT');
    expect(applied!.metadata.correction_id).toBe(correction!.id);
  });

  it('stores the original snapshot, the reason, the administrator and the timestamp', async () => {
    await checkIn(ctx.db, emp.id, at('10:45:00'));
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    const [correction] = await requestCorrection(
      emp.id,
      MON,
      { check_out_at: at('18:30:00') },
      'Left later than recorded',
    );
    await decide(correction!.id, admin.id, true);

    const [row] = await ctx.db.query<{
      original: { status: string; check_out_at: string };
      proposed: object;
      reason: string;
      decided_by: string;
      decided_at: Date;
      requested_by: string;
    }>(
      'select original, proposed, reason, decided_by, decided_at, requested_by from public.attendance_corrections',
    );
    expect(row!.original.status).toBe('LATE');
    expect(iso(row!.original.check_out_at)).toBe(iso(at('18:00:00')));
    expect(row!.reason).toBe('Left later than recorded');
    expect(row!.decided_by).toBe(admin.id);
    expect(row!.requested_by).toBe(emp.id);
    expect(iso(row!.decided_at)).toBe(iso(NOW));
  });

  it('leaves attendance untouched when a correction is rejected', async () => {
    await checkIn(ctx.db, emp.id, at('10:45:00'));
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    const before = await getRecord(ctx.db, emp.id, MON);
    const [correction] = await requestCorrection(emp.id, MON, {
      check_in_at: at('09:00:00'),
      status: 'PRESENT',
    });
    const [rejected] = await decide(correction!.id, admin.id, false);
    expect(rejected?.status).toBe('REJECTED');
    const after = await getRecord(ctx.db, emp.id, MON);
    expect(after).toMatchObject({ status: 'LATE', has_correction: false });
    expect(iso(after!.check_in_at)).toBe(iso(before!.check_in_at));
    expect(await countEvents(ctx.db, before!.id, 'CORRECTION_APPLIED')).toBe(0);
  });

  it('forbids approving your own correction and requires a real administrator', async () => {
    await checkIn(ctx.db, emp.id, at('10:45:00'));
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    const [correction] = await requestCorrection(emp.id, MON, {
      status: 'PRESENT',
      check_in_at: at('10:00:00'),
    });

    expect(
      await domainError(
        'select private.decide_correction($1::uuid,$2::uuid,true,null,$3::timestamptz)',
        [correction!.id, emp.id, NOW],
      ),
    ).toBe('FORBIDDEN'); // an employee is not an administrator
    expect(
      await domainError(
        'select private.decide_correction($1::uuid,$2::uuid,true,null,$3::timestamptz)',
        [correction!.id, other.id, NOW],
      ),
    ).toBe('FORBIDDEN');

    // An admin who is also the subject cannot approve their own record.
    const adminSubject = await seedUser(ctx.db, { role: 'admin', attendanceRequired: true });
    await checkIn(ctx.db, adminSubject.id, at('10:45:00'));
    await checkOut(ctx.db, adminSubject.id, at('18:00:00'));
    expect(
      await domainError(
        `select private.admin_correct($1::uuid, $2::date, $3::jsonb, 'adjusting my own day', $1::uuid, $4::timestamptz)`,
        [
          adminSubject.id,
          MON,
          JSON.stringify({ status: 'PRESENT', check_in_at: at('10:00:00') }),
          NOW,
        ],
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await getRecord(ctx.db, adminSubject.id, MON))?.status).toBe('LATE');
  });

  it('cannot be decided twice', async () => {
    await checkIn(ctx.db, emp.id, at('10:45:00'));
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    const [correction] = await requestCorrection(emp.id, MON, { check_out_at: at('18:30:00') });
    await decide(correction!.id, admin.id, false);
    expect(
      await domainError(
        'select private.decide_correction($1::uuid,$2::uuid,true,null,$3::timestamptz)',
        [correction!.id, admin.id, NOW],
      ),
    ).toBe('CORRECTION_ALREADY_DECIDED');
  });

  it('allows one pending correction per employee per day', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await requestCorrection(emp.id, MON, { check_out_at: at('18:00:00') });
    expect(
      await domainError(
        `select private.create_correction($1::uuid,$2::date,$3::jsonb,'second request',$1::uuid,'EMPLOYEE_REQUEST',$4::timestamptz)`,
        [emp.id, MON, JSON.stringify({ check_out_at: at('18:10:00') }), NOW],
      ),
    ).toBe('CONFLICT');
  });

  it("does not let an employee file a request on someone else's behalf", async () => {
    expect(
      await domainError(
        `select private.create_correction($1::uuid,$2::date,$3::jsonb,'not mine at all',$4::uuid,'EMPLOYEE_REQUEST',$5::timestamptz)`,
        [emp.id, MON, JSON.stringify({ status: 'ABSENT' }), other.id, NOW],
      ),
    ).toBe('FORBIDDEN');
  });

  it.each([
    ['check-out before check-in', { check_in_at: at('12:00:00'), check_out_at: at('11:00:00') }],
    ['check-in on a different day', { check_in_at: at('10:00:00', TUE) }],
    ['a time in the future', { check_in_at: at('10:00:00', '2026-12-30') }],
    ['an overlong shift', { check_in_at: at('10:00:00'), check_out_at: at('11:00:00', TUE) }],
    ['PRESENT with no check-in', { status: 'PRESENT' }],
    ['ABSENT while keeping a check-in', { status: 'ABSENT', check_in_at: at('10:00:00') }],
    [
      'more break time than the shift',
      { check_in_at: at('10:00:00'), check_out_at: at('11:00:00'), total_break_seconds: 7200 },
    ],
    ['garbage timestamps', { check_in_at: 'not-a-time' }],
    ['a negative break total', { check_in_at: at('10:00:00'), total_break_seconds: -5 }],
  ])('refuses an impossible correction: %s', async (_label, proposed) => {
    await seedUser(ctx.db); // keep fixtures stable
    expect(
      await domainError(
        `select private.create_correction($1::uuid,$2::date,$3::jsonb,'please correct this',$1::uuid,'EMPLOYEE_REQUEST',$4::timestamptz)`,
        [emp.id, MON, JSON.stringify(proposed), NOW],
      ),
    ).toBe('CORRECTION_INVALID');
  });

  it('refuses a correction for a future date, an empty request, unknown fields and a thin reason', async () => {
    expect(
      await domainError(
        `select private.create_correction($1::uuid,'2026-12-30'::date,$2::jsonb,'future date',$1::uuid,'EMPLOYEE_REQUEST',$3::timestamptz)`,
        [emp.id, JSON.stringify({ status: 'ABSENT' }), NOW],
      ),
    ).toBe('CORRECTION_INVALID');

    // Not domain errors: the table's own CHECK constraints reject these shapes.
    for (const [label, proposed, reason] of [
      ['empty proposal', '{}', 'a proper reason'],
      ['unknown field', '{"is_late": false, "status": "PRESENT"}', 'a proper reason'],
      ['reason too short', '{"status": "PRESENT"}', 'ok'],
    ] as const) {
      const err = await attempt(
        ctx.db,
        `insert into public.attendance_corrections (employee_id, work_date, source, original, proposed, reason, requested_by)
         values ($1, $2::date, 'EMPLOYEE_REQUEST', '{}', $3::jsonb, $4, $1)`,
        [emp.id, MON, proposed, reason],
      );
      expect(err?.code, label).toBe('23514');
    }
  });

  it('lets an administrator correct an ABSENT day, recomputing lateness and hours', async () => {
    // Day is finalized as ABSENT first.
    await ctx.db.query('select private.finalize_attendance_day($1::date, $2::timestamptz)', [
      MON,
      NOW,
    ]);
    expect((await getRecord(ctx.db, emp.id, MON))?.status).toBe('ABSENT');

    const [correction] = await ctx.db.query<{ status: string; source: string }>(
      `select * from private.admin_correct($1::uuid,$2::date,$3::jsonb,'Biometric outage, attended in person',$4::uuid,$5::timestamptz)`,
      [
        emp.id,
        MON,
        JSON.stringify({
          check_in_at: at('10:30:00'),
          check_out_at: at('18:30:00'),
          total_break_seconds: 3600,
        }),
        admin.id,
        NOW,
      ],
    );
    expect(correction).toMatchObject({ status: 'APPROVED', source: 'ADMIN_INITIATED' });

    const rec = await getRecord(ctx.db, emp.id, MON);
    expect(rec).toMatchObject({
      status: 'LATE',
      is_late: true,
      live_state: 'CHECKED_OUT',
      is_finalized: true,
      has_correction: true,
      net_work_seconds: 7 * 3600,
    });
  });

  it('can reclassify a worked day as leave only by stating the new status', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await checkOut(ctx.db, emp.id, at('18:00:00'));
    expect(
      await domainError(
        `select private.admin_correct($1::uuid,$2::date,$3::jsonb,'remove the check-in',$4::uuid,$5::timestamptz)`,
        [emp.id, MON, JSON.stringify({ check_in_at: null }), admin.id, NOW],
      ),
    ).toBe('CORRECTION_INVALID');

    await ctx.db.query(
      `select private.admin_correct($1::uuid,$2::date,$3::jsonb,'was on approved leave',$4::uuid,$5::timestamptz)`,
      [emp.id, MON, JSON.stringify({ check_in_at: null, status: 'ON_LEAVE' }), admin.id, NOW],
    );
    expect(await getRecord(ctx.db, emp.id, MON)).toMatchObject({
      status: 'ON_LEAVE',
      live_state: 'NONE',
      check_in_at: null,
      check_out_at: null,
    });
  });

  it('cannot correct a day while a break is running', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await startBreak(ctx.db, emp.id, 'SHORT', at('11:00:00'));
    expect(
      await domainError(
        `select private.admin_correct($1::uuid,$2::date,$3::jsonb,'fix while on break',$4::uuid,$5::timestamptz)`,
        [
          emp.id,
          MON,
          JSON.stringify({ status: 'PRESENT', check_in_at: at('09:00:00') }),
          admin.id,
          at('11:30:00'),
        ],
      ),
    ).toBe('ACTIVE_BREAK');
  });

  it('makes a correction row immutable apart from its single decision', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const [correction] = await requestCorrection(emp.id, MON, { check_out_at: at('18:00:00') });

    const edits = [
      `update public.attendance_corrections set reason = 'a different reason' where id = $1`,
      `update public.attendance_corrections set original = '{"x":1}' where id = $1`,
      `update public.attendance_corrections set proposed = '{"status":"ABSENT"}' where id = $1`,
      `update public.attendance_corrections set requested_by = '${admin.id}' where id = $1`,
    ];
    for (const sql of edits) {
      expect((await attempt(ctx.db, sql, [correction!.id]))?.code, sql).toBe('TG002');
    }
    expect(
      (
        await attempt(ctx.db, 'delete from public.attendance_corrections where id = $1', [
          correction!.id,
        ])
      )?.code,
    ).toBe('TG002');

    await decide(correction!.id, admin.id, true);
    expect(
      (
        await attempt(
          ctx.db,
          `update public.attendance_corrections set decision_note = 'rewritten' where id = $1`,
          [correction!.id],
        )
      )?.code,
    ).toBe('TG002'); // frozen once decided
  });
});

describe('day finalization', () => {
  const finalize = (date: string, now = NOW) =>
    ctx.db.query<{ n: number }>(
      'select private.finalize_attendance_day($1::date, $2::timestamptz) as n',
      [date, now],
    );

  it('marks absentees, incompletes, weekly offs, holidays and leave, once', async () => {
    const worker = await seedUser(ctx.db);
    const forgetful = await seedUser(ctx.db);
    const onLeave = await seedUser(ctx.db);
    const absent = await seedUser(ctx.db);

    await checkIn(ctx.db, worker.id, at('10:00:00'));
    await checkOut(ctx.db, worker.id, at('18:00:00'));
    await checkIn(ctx.db, forgetful.id, at('10:00:00'));
    await ctx.db.query(
      `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
       values ($1, $2::date, $2::date, $3)`,
      [onLeave.id, MON, admin.id],
    );

    await finalize(MON);

    expect(await getRecord(ctx.db, worker.id, MON)).toMatchObject({
      status: 'PRESENT',
      is_finalized: true,
    });
    expect(await getRecord(ctx.db, forgetful.id, MON)).toMatchObject({
      status: 'INCOMPLETE',
      live_state: 'NONE',
      is_finalized: true,
      check_out_at: null,
    });
    expect((await getRecord(ctx.db, onLeave.id, MON))?.status).toBe('ON_LEAVE');
    expect((await getRecord(ctx.db, absent.id, MON))?.status).toBe('ABSENT');

    // Accounts that never mark attendance are not given a record at all.
    expect(await getRecord(ctx.db, admin.id, MON)).toBeUndefined();
  });

  it('records Sunday as WEEKLY_OFF and configured holidays as HOLIDAY', async () => {
    await ctx.db.query(
      `insert into public.holidays (holiday_date, name) values ($1::date, 'Festival')`,
      [TUE],
    );
    await finalize('2026-11-01'); // Sunday
    await finalize(TUE);
    expect((await getRecord(ctx.db, emp.id, '2026-11-01'))?.status).toBe('WEEKLY_OFF');
    expect((await getRecord(ctx.db, emp.id, TUE))?.status).toBe('HOLIDAY');
  });

  it('prefers weekly off, then holiday, over leave', async () => {
    await ctx.db.query(
      `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
       values ($1, '2026-11-01', '2026-11-03', $2)`,
      [emp.id, admin.id],
    );
    await ctx.db.query(
      `insert into public.holidays (holiday_date, name) values ($1::date, 'Festival')`,
      [TUE],
    );
    await finalize('2026-11-01');
    await finalize(MON);
    await finalize(TUE);
    expect((await getRecord(ctx.db, emp.id, '2026-11-01'))?.status).toBe('WEEKLY_OFF');
    expect((await getRecord(ctx.db, emp.id, MON))?.status).toBe('ON_LEAVE');
    expect((await getRecord(ctx.db, emp.id, TUE))?.status).toBe('HOLIDAY');
  });

  it('is idempotent', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const [first] = await finalize(MON);
    const [second] = await finalize(MON);
    expect(first!.n).toBeGreaterThan(0);
    expect(second!.n).toBe(0);
    const rec = await getRecord(ctx.db, emp.id, MON);
    expect(await countEvents(ctx.db, rec!.id, 'DAY_FINALIZED')).toBe(1);
  });

  it('refuses to finalize today or a future day', async () => {
    expect(
      await domainError('select private.finalize_attendance_day($1::date, $2::timestamptz)', [
        MON,
        at('15:00:00'),
      ]),
    ).toBe('CONFLICT');
    expect(
      await domainError('select private.finalize_attendance_day($1::date, $2::timestamptz)', [
        TUE,
        at('15:00:00'),
      ]),
    ).toBe('CONFLICT');
  });

  it('skips employees who had not joined yet or were deactivated earlier, but not those active that day', async () => {
    const future = await seedUser(ctx.db, { joiningDate: '2026-11-10' });
    const departed = await seedUser(ctx.db);
    await ctx.db.query(
      `update public.profiles set is_active = false, deactivated_at = $2::timestamptz where id = $1`,
      [departed.id, at('09:00:00', '2026-10-30')],
    );
    const leftLater = await seedUser(ctx.db);
    await ctx.db.query(
      `update public.profiles set is_active = false, deactivated_at = $2::timestamptz where id = $1`,
      [leftLater.id, at('09:00:00', '2026-11-05')],
    );

    await finalize(MON);
    expect(await getRecord(ctx.db, future.id, MON)).toBeUndefined();
    expect(await getRecord(ctx.db, departed.id, MON)).toBeUndefined();
    expect((await getRecord(ctx.db, leftLater.id, MON))?.status).toBe('ABSENT');
  });

  it('closes a dangling break at zero length rather than inventing time', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    await finalize(MON);

    const [brk] = await ctx.db.query<{ end_reason: string; duration_seconds: number }>(
      'select end_reason::text, duration_seconds from public.break_records where employee_id = $1',
      [emp.id],
    );
    expect(brk).toEqual({ end_reason: 'DAY_FINALIZED', duration_seconds: 0 });
    expect(await getRecord(ctx.db, emp.id, MON)).toMatchObject({
      status: 'INCOMPLETE',
      live_state: 'NONE',
    });
  });

  it('can no longer be checked out after finalization (a correction is required)', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await finalize(MON);
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('09:00:00', '2026-11-21'),
      purpose: 'CHECK_OUT',
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('09:00:10', '2026-11-21'),
      ]),
    ).toBe('NOT_CHECKED_IN');
  });

  it('does nothing before an office exists', async () => {
    await ctx.db.exec('delete from public.office_locations');
    const [row] = await finalize(MON);
    expect(row!.n).toBe(0);
  });

  describe('scheduled entry point', () => {
    const due = (now: string, lookback = 7) =>
      ctx.db.query<{ n: number }>('select private.finalize_due_days($1::timestamptz, $2) as n', [
        now,
        lookback,
      ]);

    it('makes a day due at 02:00 local time the next morning, not before', async () => {
      await due(at('01:59:00', TUE)); // Tue 01:59 -> Monday not yet due
      expect(await getRecord(ctx.db, emp.id, MON)).toBeUndefined();
      await due(at('02:00:00', TUE));
      expect((await getRecord(ctx.db, emp.id, MON))?.status).toBe('ABSENT');
    });

    it('heals missed runs within the look-back window but never before the office existed', async () => {
      await due(at('03:00:00', '2026-11-10'), 3);
      expect(await getRecord(ctx.db, emp.id, '2026-11-09')).toBeDefined();
      expect(await getRecord(ctx.db, emp.id, '2026-11-07')).toBeDefined();
      expect(await getRecord(ctx.db, emp.id, '2026-11-06')).toBeUndefined(); // outside look-back

      // Office configured on 2026-10-01 (fixture): nothing is created before that.
      await due(at('03:00:00', '2026-10-05'), 30);
      expect(await getRecord(ctx.db, emp.id, '2026-09-30')).toBeUndefined();
      expect(await getRecord(ctx.db, emp.id, '2026-10-01')).toBeDefined();
    });

    it('is safe to run repeatedly', async () => {
      await due(at('03:00:00', TUE));
      const [again] = await due(at('04:00:00', TUE));
      expect(again!.n).toBe(0);
    });
  });
});

describe('data retention', () => {
  it('redacts old raw coordinates but keeps the verdict and distance', async () => {
    const old = await seedVerification(ctx.db, emp.id, { at: '2026-06-01T10:00:00+05:30' });
    const recent = await seedVerification(ctx.db, emp.id, { at: '2026-11-18T10:00:00+05:30' });
    await ctx.db.query(
      `update public.attendance_verifications set latitude = 10.5, longitude = 20.5`,
    );

    const [result] = await ctx.db.query<{ r: Record<string, number> }>(
      'select private.apply_retention($1::timestamptz) as r',
      [NOW],
    );
    expect(result!.r.coordinates_purged).toBe(1);

    const rows = await ctx.db.query<{
      id: string;
      latitude: string | null;
      longitude: string | null;
      distance_m: string;
      final_result: string;
      purged: boolean;
    }>(
      `select id, latitude, longitude, distance_m, final_result::text, coordinates_purged_at is not null as purged
       from public.attendance_verifications`,
    );
    const oldRow = rows.find((r) => r.id === old)!;
    const recentRow = rows.find((r) => r.id === recent)!;
    expect(oldRow).toMatchObject({
      latitude: null,
      longitude: null,
      final_result: 'VERIFIED',
      purged: true,
    });
    expect(Number(oldRow.distance_m)).toBeCloseTo(12.5);
    expect(recentRow.latitude).not.toBeNull();
    expect(recentRow.purged).toBe(false);
  });

  it('purges expired QR tokens, old scans and stale idempotency keys only', async () => {
    const office = await ctx.db.query<{ id: string }>('select id from public.office_locations');
    const insertToken = async (hex: string, acceptUntil: string) => {
      const [t] = await ctx.db.query<{ id: string }>(
        `insert into public.qr_tokens (office_id, token_hash, valid_from, expires_at, accept_until)
         values ($1, decode(repeat($2, 32), 'hex'), $3::timestamptz - interval '40 seconds',
                 $3::timestamptz - interval '5 seconds', $3::timestamptz) returning id`,
        [office[0]!.id, hex, acceptUntil],
      );
      return t!.id;
    };
    const oldToken = await insertToken('aa', '2026-11-01T00:00:00Z');
    const freshToken = await insertToken('bb', '2026-11-19T00:00:00Z');
    await ctx.db.query(
      `insert into public.qr_scan_events (qr_token_id, employee_id, outcome, scanned_at) values
         ($1, $3, 'ACCEPTED', '2026-05-01T00:00:00Z'), ($2, $3, 'ACCEPTED', '2026-11-19T00:00:00Z')`,
      [oldToken, freshToken, emp.id],
    );
    await ctx.db.query(
      `insert into public.idempotency_keys (employee_id, key, endpoint, request_hash, created_at) values
         ($1, 'old-key-00000001', 'check-in', 'h', '2026-11-10T00:00:00Z'),
         ($1, 'new-key-00000002', 'check-in', 'h', '2026-11-19T23:00:00Z')`,
      [emp.id],
    );

    const [result] = await ctx.db.query<{ r: Record<string, number> }>(
      'select private.apply_retention($1::timestamptz) as r',
      [NOW],
    );
    expect(result!.r).toMatchObject({
      qr_tokens_deleted: 1,
      qr_scan_events_deleted: 1,
      idempotency_keys_deleted: 1,
    });
    const [tokens] = await ctx.db.query<{ n: string }>(
      'select count(*)::text as n from public.qr_tokens',
    );
    expect(tokens!.n).toBe('1');
  });
});

describe('policy versioning', () => {
  it('uses the policy whose effective date is the latest one on or before the work date', async () => {
    await ctx.db.query(
      `insert into public.attendance_policies (effective_from, late_threshold, notes)
       values ('2026-11-03', '10:30', 'stricter later threshold')`,
    );
    // Monday (before the new policy) uses 10:20; Tuesday (from the new policy) uses 10:30.
    const mon = await checkIn(ctx.db, emp.id, at('10:25:00'));
    expect(mon.status).toBe('LATE');
    const tue = await checkIn(ctx.db, other.id, at('10:25:00', TUE));
    expect(tue.status).toBe('PRESENT');
    await setPolicy(ctx.db, `notes = 'edited'`); // editing history does not touch classified days
    expect((await getRecord(ctx.db, emp.id, MON))?.status).toBe('LATE');
  });
});
