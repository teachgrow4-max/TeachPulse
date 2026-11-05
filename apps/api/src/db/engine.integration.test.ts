import { beforeEach, describe, expect, it } from 'vitest';
import { attempt } from '../testing/harness.js';
import {
  checkIn,
  checkOut,
  countEvents,
  endBreak,
  getRecord,
  iso,
  seedDevice,
  seedOffice,
  seedUser,
  seedVerification,
  setPolicy,
  startBreak,
  type SeededUser,
} from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

// Calendar used throughout (Asia/Kolkata, UTC+05:30, no DST):
//   Sun 2026-11-01 weekly off | Mon 11-02 .. Sat 11-07 working | Sun 11-08 weekly off
const MON = '2026-11-02';
const at = (time: string, date = MON) => `${date}T${time}+05:30`;

let emp: SeededUser;
let admin: SeededUser;

beforeEach(async () => {
  await seedOffice(ctx.db);
  emp = await seedUser(ctx.db);
  admin = await seedUser(ctx.db, { role: 'admin', attendanceRequired: false });
});

async function domainError(sql: string, params: unknown[]): Promise<string | undefined> {
  const err = await attempt(ctx.db, sql, params);
  expect(err, `expected "${sql}" to fail`).not.toBeNull();
  expect(err?.code).toBe('TG001'); // a domain error, not a raw constraint failure
  return err?.message;
}

describe('check-in classification', () => {
  it('marks 10:19:59 as PRESENT and starts the working state', async () => {
    const rec = await checkIn(ctx.db, emp.id, at('10:19:59'));
    expect(rec).toMatchObject({
      status: 'PRESENT',
      is_late: false,
      live_state: 'WORKING',
      work_date: MON,
      is_finalized: false,
    });
    expect(iso(rec.check_in_at)).toBe('2026-11-02T04:49:59.000Z');
  });

  it('marks exactly 10:20:00 as LATE (at-or-after the threshold)', async () => {
    const rec = await checkIn(ctx.db, emp.id, at('10:20:00'));
    expect(rec).toMatchObject({ status: 'LATE', is_late: true, live_state: 'WORKING' });
  });

  it('treats an early arrival as PRESENT, not special-cased', async () => {
    expect((await checkIn(ctx.db, emp.id, at('08:30:00'))).status).toBe('PRESENT');
  });

  it('records a CHECK_IN event, consumes the verification and snapshots the policy', async () => {
    const verification = await seedVerification(ctx.db, emp.id, { at: at('09:59:00') });
    const rec = await checkIn(ctx.db, emp.id, at('10:00:00'), { verificationId: verification });

    expect(await countEvents(ctx.db, rec.id, 'CHECK_IN')).toBe(1);
    const [v] = await ctx.db.query<{ consumed: boolean }>(
      'select consumed_at is not null as consumed from public.attendance_verifications where id = $1',
      [verification],
    );
    expect(v?.consumed).toBe(true);
    expect(rec.policy_snapshot).toMatchObject({
      late_threshold: '10:20:00',
      lunch_allowance_minutes: 60,
    });
  });

  it('assigns the work date in the office timezone across midnight', async () => {
    const lateNight = await checkIn(ctx.db, emp.id, at('23:50:00'));
    expect(lateNight.work_date).toBe(MON);
    // 00:10 IST on Tuesday is 18:40 UTC on Monday: it must belong to Tuesday.
    const other = await seedUser(ctx.db);
    const afterMidnight = await checkIn(ctx.db, other.id, at('00:10:00', '2026-11-03'));
    expect(afterMidnight.work_date).toBe('2026-11-03');
  });

  it('uses the time the server was given, never a time the caller can embed in the verification', async () => {
    // The verification was made at 09:00, but the check-in happens at 10:25 -> LATE.
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('09:00:00'),
      ttlSeconds: 600 * 60,
    });
    const rec = await checkIn(ctx.db, emp.id, at('10:25:00'), { verificationId: verification });
    expect(rec.status).toBe('LATE');
  });
});

describe('check-in rejections', () => {
  it('rejects a duplicate check-in on the same day', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const fresh = await seedVerification(ctx.db, emp.id, { at: at('10:05:00') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        fresh,
        at('10:06:00'),
      ]),
    ).toBe('ALREADY_CHECKED_IN');
    const rec = await getRecord(ctx.db, emp.id, MON);
    expect(await countEvents(ctx.db, rec!.id, 'CHECK_IN')).toBe(1);
  });

  it('is idempotent when the same verification is replayed', async () => {
    const verification = await seedVerification(ctx.db, emp.id, { at: at('10:00:00') });
    const first = await checkIn(ctx.db, emp.id, at('10:00:30'), { verificationId: verification });
    const replay = await checkIn(ctx.db, emp.id, at('10:00:45'), { verificationId: verification });
    expect(replay.id).toBe(first.id);
    expect(iso(replay.check_in_at)).toBe(iso(first.check_in_at));
    expect(await countEvents(ctx.db, first.id, 'CHECK_IN')).toBe(1);
  });

  it('rejects an expired verification', async () => {
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('10:00:00'),
      ttlSeconds: 120,
    });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('10:02:00'), // exactly at expiry
      ]),
    ).toBe('VERIFICATION_EXPIRED');
    // ...and the failed attempt leaves no attendance behind.
    expect(await getRecord(ctx.db, emp.id, MON)).toBeUndefined();
  });

  it("rejects someone else's verification", async () => {
    const other = await seedUser(ctx.db);
    const verification = await seedVerification(ctx.db, other.id, { at: at('10:00:00') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('10:00:30'),
      ]),
    ).toBe('VERIFICATION_INVALID');
  });

  it('rejects a REJECTED verification and a verification of the wrong purpose', async () => {
    const rejected = await seedVerification(ctx.db, emp.id, {
      at: at('10:00:00'),
      final: 'REJECTED',
    });
    const wrongPurpose = await seedVerification(ctx.db, emp.id, {
      at: at('10:00:00'),
      purpose: 'CHECK_OUT',
    });
    for (const id of [rejected, wrongPurpose]) {
      expect(
        await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
          emp.id,
          id,
          at('10:00:30'),
        ]),
      ).toBe('VERIFICATION_INVALID');
    }
  });

  it('rejects an unknown verification id', async () => {
    expect(
      await domainError('select private.check_in($1::uuid, gen_random_uuid(), $2::timestamptz)', [
        emp.id,
        at('10:00:00'),
      ]),
    ).toBe('VERIFICATION_INVALID');
  });

  it('rejects a check-in when the verified device was revoked before use', async () => {
    const device = await seedDevice(ctx.db, emp.id);
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('10:00:00'),
      deviceId: device,
    });
    await ctx.db.query(
      `update public.registered_devices set status = 'REVOKED', revoked_at = now() where id = $1`,
      [device],
    );
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('10:00:30'),
      ]),
    ).toBe('DEVICE_NOT_ACTIVE');
  });

  it.each([
    ['Sunday (weekly off)', '2026-11-01', 'WEEKLY_OFF'],
    ['the next Sunday', '2026-11-08', 'WEEKLY_OFF'],
  ])('refuses check-in on %s', async (_label, date, code) => {
    const verification = await seedVerification(ctx.db, emp.id, { at: at('10:00:00', date) });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('10:00:30', date),
      ]),
    ).toBe(code);
    expect(await getRecord(ctx.db, emp.id, date)).toBeUndefined();
  });

  it('refuses check-in on a configured holiday and during approved leave', async () => {
    await ctx.db.query(
      `insert into public.holidays (holiday_date, name) values ('2026-11-03', 'Festival')`,
    );
    const holidayV = await seedVerification(ctx.db, emp.id, { at: at('10:00:00', '2026-11-03') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        holidayV,
        at('10:00:30', '2026-11-03'),
      ]),
    ).toBe('HOLIDAY');

    await ctx.db.query(
      `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
       values ($1, '2026-11-04', '2026-11-05', $2)`,
      [emp.id, admin.id],
    );
    const leaveV = await seedVerification(ctx.db, emp.id, { at: at('10:00:00', '2026-11-04') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        leaveV,
        at('10:00:30', '2026-11-04'),
      ]),
    ).toBe('ON_LEAVE');
  });

  it('refuses deactivated and non-attendance accounts', async () => {
    const gone = await seedUser(ctx.db);
    await ctx.db.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [gone.id],
    );
    const v1 = await seedVerification(ctx.db, gone.id, { at: at('10:00:00') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        gone.id,
        v1,
        at('10:00:30'),
      ]),
    ).toBe('ACCOUNT_DEACTIVATED');

    const v2 = await seedVerification(ctx.db, admin.id, { at: at('10:00:00') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        admin.id,
        v2,
        at('10:00:30'),
      ]),
    ).toBe('FORBIDDEN');
  });

  it('refuses to run before the office is configured', async () => {
    await ctx.db.exec('delete from public.office_locations');
    const verification = await seedVerification(ctx.db, emp.id, { at: at('10:00:00') });
    expect(
      await domainError('select private.check_in($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('10:00:30'),
      ]),
    ).toBe('OFFICE_NOT_CONFIGURED');
  });
});

describe('check-out and working hours', () => {
  it('computes net hours as elapsed minus recorded breaks', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    await endBreak(ctx.db, emp.id, at('14:00:00'));
    await startBreak(ctx.db, emp.id, 'SHORT', at('16:00:00'));
    await endBreak(ctx.db, emp.id, at('16:15:00'));

    const rec = await checkOut(ctx.db, emp.id, at('19:00:00'));
    // 9h elapsed - 1h lunch - 15m short break = 7h45m
    expect(rec).toMatchObject({
      live_state: 'CHECKED_OUT',
      total_break_seconds: 4500,
      net_work_seconds: 27900,
      status: 'PRESENT',
    });
    expect(await countEvents(ctx.db, rec.id, 'CHECK_OUT')).toBe(1);
  });

  it('rejects checkout without a check-in', async () => {
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('18:00:00'),
      purpose: 'CHECK_OUT',
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('18:00:10'),
      ]),
    ).toBe('NOT_CHECKED_IN');
  });

  it('rejects a second checkout and is idempotent on replay of the same verification', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('18:00:00'),
      purpose: 'CHECK_OUT',
    });
    const first = await checkOut(ctx.db, emp.id, at('18:00:10'), { verificationId: verification });
    const replay = await checkOut(ctx.db, emp.id, at('18:00:20'), { verificationId: verification });
    expect(replay.id).toBe(first.id);
    expect(iso(replay.check_out_at)).toBe(iso(first.check_out_at));
    expect(await countEvents(ctx.db, first.id, 'CHECK_OUT')).toBe(1);

    const another = await seedVerification(ctx.db, emp.id, {
      at: at('18:05:00'),
      purpose: 'CHECK_OUT',
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        another,
        at('18:05:10'),
      ]),
    ).toBe('ALREADY_CHECKED_OUT');
  });

  it('rejects checkout with a CHECK_IN verification or an expired one', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const wrong = await seedVerification(ctx.db, emp.id, {
      at: at('18:00:00'),
      purpose: 'CHECK_IN',
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        wrong,
        at('18:00:10'),
      ]),
    ).toBe('VERIFICATION_INVALID');
    const stale = await seedVerification(ctx.db, emp.id, {
      at: at('17:00:00'),
      purpose: 'CHECK_OUT',
      ttlSeconds: 60,
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        stale,
        at('18:00:10'),
      ]),
    ).toBe('VERIFICATION_EXPIRED');
  });

  it('allows an overnight checkout on the open record before the day is finalized', async () => {
    await checkIn(ctx.db, emp.id, at('18:00:00'));
    const rec = await checkOut(ctx.db, emp.id, at('00:20:00', '2026-11-03'));
    expect(rec).toMatchObject({
      work_date: MON,
      live_state: 'CHECKED_OUT',
      is_early_checkout: false,
    });
    expect(rec.net_work_seconds).toBe(6 * 3600 + 20 * 60);
  });

  it('classifies LATE and half-day independently on the same day', async () => {
    await setPolicy(ctx.db, 'half_day_enabled = true, half_day_below_net_minutes = 240');
    await checkIn(ctx.db, emp.id, at('10:30:00')); // late
    const rec = await checkOut(ctx.db, emp.id, at('13:30:00')); // worked 3h < 4h
    expect(rec).toMatchObject({ status: 'LATE', is_late: true, is_half_day: true });

    const onTime = await seedUser(ctx.db);
    await checkIn(ctx.db, onTime.id, at('10:00:00')); // present
    const rec2 = await checkOut(ctx.db, onTime.id, at('13:00:00'));
    expect(rec2).toMatchObject({ status: 'PRESENT', is_late: false, is_half_day: true });

    const fullDay = await seedUser(ctx.db);
    await checkIn(ctx.db, fullDay.id, at('10:30:00')); // late but a full day
    const rec3 = await checkOut(ctx.db, fullDay.id, at('18:30:00'));
    expect(rec3).toMatchObject({ status: 'LATE', is_late: true, is_half_day: false });
  });

  it('does not flag half-day, overtime or early checkout while those rules are disabled', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const rec = await checkOut(ctx.db, emp.id, at('11:00:00'));
    expect(rec).toMatchObject({
      is_half_day: false,
      is_early_checkout: false,
      overtime_minutes: 0,
    });
  });

  it('computes overtime beyond the configured net threshold', async () => {
    await setPolicy(ctx.db, 'overtime_enabled = true, overtime_after_net_minutes = 480');
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const rec = await checkOut(ctx.db, emp.id, at('20:30:00')); // 10.5h net
    expect(rec.overtime_minutes).toBe(150);
  });

  it('flags early checkout only before the configured time (with grace)', async () => {
    await setPolicy(
      ctx.db,
      `early_checkout_enabled = true, early_checkout_before = '19:00', early_checkout_grace_minutes = 10`,
    );

    const early = await seedUser(ctx.db);
    await checkIn(ctx.db, early.id, at('10:00:00'));
    expect((await checkOut(ctx.db, early.id, at('18:49:59'))).is_early_checkout).toBe(true);

    const withinGrace = await seedUser(ctx.db);
    await checkIn(ctx.db, withinGrace.id, at('10:00:00'));
    expect((await checkOut(ctx.db, withinGrace.id, at('18:50:00'))).is_early_checkout).toBe(false);
  });

  it("classifies a day with the policy snapshot taken at check-in, not today's policy", async () => {
    await setPolicy(ctx.db, 'half_day_enabled = true, half_day_below_net_minutes = 240');
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    // An admin edits the policy mid-day...
    await setPolicy(ctx.db, 'half_day_enabled = false');
    const rec = await checkOut(ctx.db, emp.id, at('12:00:00'));
    // ...but this day was classified under the rule in force when it started.
    expect(rec.is_half_day).toBe(true);
  });
});

describe('breaks', () => {
  beforeEach(async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
  });

  it('tracks lunch start and end with durations and live state', async () => {
    const started = await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    expect(started.break_type).toBe('LUNCH');
    expect((await getRecord(ctx.db, emp.id, MON))?.live_state).toBe('ON_LUNCH');

    const ended = await endBreak(ctx.db, emp.id, at('13:45:00'));
    expect(ended.duration_seconds).toBe(45 * 60);
    const rec = await getRecord(ctx.db, emp.id, MON);
    expect(rec).toMatchObject({ live_state: 'WORKING', total_break_seconds: 2700 });
  });

  it('tracks a short break distinctly', async () => {
    await startBreak(ctx.db, emp.id, 'SHORT', at('11:00:00'));
    expect((await getRecord(ctx.db, emp.id, MON))?.live_state).toBe('ON_SHORT_BREAK');
  });

  it('does not allow overlapping breaks', async () => {
    await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    expect(
      await domainError(`select private.start_break($1::uuid, 'SHORT', $2::timestamptz)`, [
        emp.id,
        at('13:10:00'),
      ]),
    ).toBe('ALREADY_ON_BREAK');
    expect(
      await domainError(`select private.start_break($1::uuid, 'LUNCH', $2::timestamptz)`, [
        emp.id,
        at('13:10:00'),
      ]),
    ).toBe('ALREADY_ON_BREAK');
  });

  it('enforces non-overlap in the database as well, independent of the function', async () => {
    const started = await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    await endBreak(ctx.db, emp.id, at('13:30:00'));
    const [rec] = await ctx.db.query<{ id: string }>(
      'select id from public.attendance_records where employee_id = $1',
      [emp.id],
    );
    const overlap = await attempt(
      ctx.db,
      `insert into public.break_records (attendance_record_id, employee_id, break_type, started_at, ended_at, end_reason)
       values ($1, $2, 'SHORT', $3::timestamptz, $4::timestamptz, 'USER')`,
      [rec!.id, emp.id, at('13:15:00'), at('13:20:00')],
    );
    expect(overlap?.code).toBe('23P01');
    expect(started.id).toBeTruthy();

    const twoActive = await attempt(
      ctx.db,
      `insert into public.break_records (attendance_record_id, employee_id, break_type, started_at)
       values ($1, $2, 'SHORT', $3::timestamptz), ($1, $2, 'LUNCH', $4::timestamptz)`,
      [rec!.id, emp.id, at('15:00:00'), at('16:00:00')],
    );
    expect(twoActive).not.toBeNull();
  });

  it('rejects ending a break that is not running, or ending the wrong type', async () => {
    expect(
      await domainError('select private.end_break($1::uuid, null, $2::timestamptz)', [
        emp.id,
        at('11:00:00'),
      ]),
    ).toBe('NO_ACTIVE_BREAK');
    await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    expect(
      await domainError(`select private.end_break($1::uuid, 'SHORT', $2::timestamptz)`, [
        emp.id,
        at('13:05:00'),
      ]),
    ).toBe('BREAK_TYPE_MISMATCH');
  });

  it('rejects breaks before check-in and after checkout', async () => {
    const other = await seedUser(ctx.db);
    expect(
      await domainError(`select private.start_break($1::uuid, 'LUNCH', $2::timestamptz)`, [
        other.id,
        at('13:00:00'),
      ]),
    ).toBe('NOT_CHECKED_IN');

    await checkOut(ctx.db, emp.id, at('18:00:00'));
    expect(
      await domainError(`select private.start_break($1::uuid, 'LUNCH', $2::timestamptz)`, [
        emp.id,
        at('18:10:00'),
      ]),
    ).toBe('ALREADY_CHECKED_OUT');
  });

  it('enforces the configured short-break limit but not for lunch', async () => {
    // Policy is snapshotted at check-in, so the limit must be set before the day starts.
    await setPolicy(ctx.db, 'max_short_breaks_per_day = 2');
    const worker = await seedUser(ctx.db);
    await checkIn(ctx.db, worker.id, at('10:00:00'));
    await startBreak(ctx.db, worker.id, 'SHORT', at('11:00:00'));
    await endBreak(ctx.db, worker.id, at('11:05:00'));
    await startBreak(ctx.db, worker.id, 'SHORT', at('12:00:00'));
    await endBreak(ctx.db, worker.id, at('12:05:00'));
    expect(
      await domainError(`select private.start_break($1::uuid, 'SHORT', $2::timestamptz)`, [
        worker.id,
        at('15:00:00'),
      ]),
    ).toBe('SHORT_BREAK_LIMIT');
    await expect(startBreak(ctx.db, worker.id, 'LUNCH', at('15:00:00'))).resolves.toBeTruthy();
  });

  it('applies a mid-day break-rule edit only from the next check-in', async () => {
    // `emp` already checked in (beforeEach) under the unlimited rule.
    await setPolicy(ctx.db, 'max_short_breaks_per_day = 0');
    await expect(startBreak(ctx.db, emp.id, 'SHORT', at('11:00:00'))).resolves.toBeTruthy();
  });

  it('keeps break start and end as separate, ordered events', async () => {
    await startBreak(ctx.db, emp.id, 'LUNCH', at('13:00:00'));
    await endBreak(ctx.db, emp.id, at('13:30:00'));
    const rec = await getRecord(ctx.db, emp.id, MON);
    const events = await ctx.db.query<{ event_type: string }>(
      `select event_type::text from public.attendance_events where attendance_record_id = $1 order by occurred_at, id`,
      [rec!.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(['CHECK_IN', 'BREAK_START', 'BREAK_END']);
  });
});

describe('checkout with an active break', () => {
  beforeEach(async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await startBreak(ctx.db, emp.id, 'SHORT', at('17:50:00'));
  });

  it('is blocked while a break is open', async () => {
    const verification = await seedVerification(ctx.db, emp.id, {
      at: at('18:00:00'),
      purpose: 'CHECK_OUT',
    });
    expect(
      await domainError('select private.check_out($1::uuid,$2::uuid,$3::timestamptz)', [
        emp.id,
        verification,
        at('18:00:10'),
      ]),
    ).toBe('ACTIVE_BREAK');
    expect((await getRecord(ctx.db, emp.id, MON))?.live_state).toBe('ON_SHORT_BREAK');
  });

  it('succeeds under an administrator-granted exception, closing the break at checkout', async () => {
    const [exception] = await ctx.db.query<{ id: string }>(
      'select * from private.grant_checkout_exception($1::uuid, $2::uuid, $3, $4::timestamptz)',
      [emp.id, admin.id, 'Employee had to leave urgently', at('17:55:00')],
    );
    expect(exception?.id).toBeTruthy();

    const rec = await checkOut(ctx.db, emp.id, at('18:00:00'));
    expect(rec).toMatchObject({ live_state: 'CHECKED_OUT', total_break_seconds: 600 });

    const [brk] = await ctx.db.query<{ end_reason: string; duration_seconds: number }>(
      'select end_reason::text, duration_seconds from public.break_records where employee_id = $1',
      [emp.id],
    );
    expect(brk).toEqual({ end_reason: 'CHECKOUT_EXCEPTION', duration_seconds: 600 });

    const [used] = await ctx.db.query<{ used: boolean; granted_by: string }>(
      'select used_at is not null as used, granted_by from public.checkout_exceptions where id = $1',
      [exception!.id],
    );
    expect(used).toEqual({ used: true, granted_by: admin.id });
  });

  it('can only be granted by an administrator, for someone else, once', async () => {
    const reason = 'Employee had to leave urgently';
    expect(
      await domainError(
        'select private.grant_checkout_exception($1::uuid,$2::uuid,$3,$4::timestamptz)',
        [emp.id, emp.id, reason, at('17:55:00')],
      ),
    ).toBe('FORBIDDEN'); // employees cannot grant themselves an exception
    expect(
      await domainError(
        'select private.grant_checkout_exception($1::uuid,$2::uuid,$3,$4::timestamptz)',
        [admin.id, admin.id, reason, at('17:55:00')],
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');

    await ctx.db.query(
      'select private.grant_checkout_exception($1::uuid,$2::uuid,$3,$4::timestamptz)',
      [emp.id, admin.id, reason, at('17:55:00')],
    );
    expect(
      await domainError(
        'select private.grant_checkout_exception($1::uuid,$2::uuid,$3,$4::timestamptz)',
        [emp.id, admin.id, reason, at('17:56:00')],
      ),
    ).toBe('CONFLICT');
  });
});

describe('concurrency-relevant invariants', () => {
  it('allows only one attendance row per employee per day', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const err = await attempt(
      ctx.db,
      `insert into public.attendance_records (employee_id, work_date, status) values ($1, $2::date, 'ABSENT')`,
      [emp.id, MON],
    );
    expect(err?.code).toBe('23505');
  });

  it('forbids deleting attendance, events or breaks', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    await startBreak(ctx.db, emp.id, 'SHORT', at('11:00:00'));
    for (const table of ['attendance_records', 'attendance_events', 'break_records']) {
      const err = await attempt(ctx.db, `delete from public.${table}`);
      expect(err?.code, table).toBe('TG002');
    }
    expect(
      (await attempt(ctx.db, `update public.attendance_events set event_type = 'CHECK_OUT'`))?.code,
    ).toBe('TG002');
  });

  it('keeps record states internally consistent (constraints back the functions)', async () => {
    await checkIn(ctx.db, emp.id, at('10:00:00'));
    const bad = [
      `update public.attendance_records set status = 'LATE' where employee_id = $1`, // late flag mismatch
      `update public.attendance_records set check_out_at = check_in_at - interval '1 minute' where employee_id = $1`,
      `update public.attendance_records set status = 'ABSENT' where employee_id = $1`, // absent with a check-in
      `update public.attendance_records set live_state = 'CHECKED_OUT' where employee_id = $1`, // no checkout
    ];
    for (const sql of bad) {
      expect((await attempt(ctx.db, sql, [emp.id]))?.code, sql).toBe('23514');
    }
  });
});
