import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  allAuditJson,
  auditRows,
  bearer,
  createAccount,
  START_TIME,
  useApi,
} from '../testing/api-harness.js';
import { checkIn } from '../testing/fixtures.js';
import { QrScene } from '../testing/qr-scene.js';

const h = useApi();
const s = new QrScene(h);

const T0 = Date.parse(START_TIME); // Monday 2026-11-02 10:00 in Asia/Kolkata
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(async () => {
  await s.setUp();
});

const moveTo = async (ms: number) => {
  h.clock.set(new Date(ms));
  await s.refreshTokens();
};

async function tokenRow(id: string) {
  const [row] = await h.testDb.query<{
    status: string;
    action: string;
    work_date: string;
    verification_id: string | null;
    verification_waived: boolean;
    token_hash: Uint8Array;
    expires_at: Date;
    issued_at: Date;
    used_by: string | null;
  }>(
    `select status, action, work_date::text, verification_id, verification_waived, token_hash,
            expires_at, issued_at, used_by
     from public.attendance_qr_tokens where id = $1`,
    [id],
  );
  return row!;
}

// =============================================================================================
describe('an employee generates their attendance QR', () => {
  it('needs the office check first, then returns a short-lived code bound to one action', async () => {
    const today = await s.get('/api/attendance-qr/today', s.tok.employee);
    expect(today.status).toBe(200);
    expect(today.body).toMatchObject({
      next: 'CHECK_IN',
      verificationRequired: true,
      live: null,
      generatedToday: 0,
      maxPerDay: 5,
      ttlSeconds: 90,
    });

    const issued = await s.code('employee');
    expect(issued.payload).toMatch(/^TGD1\.[A-Za-z0-9_-]{43}$/);
    expect(issued).toMatchObject({ action: 'CHECK_IN', workDate: '2026-11-02', generatedToday: 1 });
    expect(new Date(issued.issuedAt).getTime()).toBe(T0);
    expect(new Date(issued.expiresAt).getTime()).toBe(T0 + 90_000);

    // Only a hash is stored, bound to the employee, the day and the action.
    const row = await tokenRow(issued.id);
    expect(row).toMatchObject({ status: 'ACTIVE', action: 'CHECK_IN', work_date: '2026-11-02' });
    expect(
      Buffer.from(row.token_hash).equals(createHash('sha256').update(issued.payload).digest()),
    ).toBe(true);
    const [dump] = await h.testDb.query<{ text: string }>(
      "select string_agg(t::text, E'\\n') as text from public.attendance_qr_tokens t",
    );
    expect(dump?.text).not.toContain(issued.payload);

    // The code is never shown again: "today" only says that one is live.
    const again = await s.get('/api/attendance-qr/today', s.tok.employee);
    expect(again.body.live).toMatchObject({ action: 'CHECK_IN' });
    expect(JSON.stringify(again.body)).not.toContain(issued.payload);
    expect(await allAuditJson(h)).not.toContain(issued.payload);
    expect((await auditRows(h, 'daily_qr.generated')).length).toBe(1);
  });

  it('reports the progress of a code to its owner only', async () => {
    const issued = await s.code();
    const mine = await s.get(`/api/attendance-qr/${issued.id}`, s.tok.employee);
    expect(mine.body).toMatchObject({ status: 'ACTIVE', action: 'CHECK_IN', usedAt: null });
    expect((await s.get(`/api/attendance-qr/${issued.id}`, s.tok.colleague)).status).toBe(404);

    await moveTo(T0 + 91_000);
    expect((await s.get(`/api/attendance-qr/${issued.id}`, s.tok.employee)).body.status).toBe(
      'EXPIRED',
    );
  });

  it('refuses without a verification, and names the layer that failed', async () => {
    expect((await s.generate('employee')).status).toBe(422);
    expect((await s.generate('employee')).body.error.code).toBe('VERIFICATION_REQUIRED');

    // 200 m from the office is outside the 150 m geofence; 100 m is inside.
    const far = await s.verify('employee', s.gpsMetresNorth(200));
    expect(far.status).toBe(422);
    expect(far.body.error.details.layers.GPS).toBe('FAIL');
    expect(far.body.error.details.layers.NETWORK).toBe('PASS');
    expect(far.body.error.details.reasons.length).toBeGreaterThan(0);
    expect((await s.generate('employee', far.body.error.details.verificationId)).status).toBe(422);

    expect((await s.verify('employee', s.gpsMetresNorth(100))).status).toBe(200);

    // Off the office Wi-Fi (a different network from the allowed one).
    await s.forgetNetworks();
    const elsewhere = await s.verify('employee');
    expect(elsewhere.status).toBe(422);
    expect(elsewhere.body.error.details.layers).toMatchObject({ GPS: 'PASS', NETWORK: 'FAIL' });
    expect(await h.testDb.query('select 1 from public.attendance_qr_tokens')).toHaveLength(0);
  });

  it('spends the verification: it cannot make a second code, expire, or be borrowed', async () => {
    const verified = await s.verify('employee');
    const id = verified.body.verificationId as string;

    expect((await s.generate('colleague', id)).body.error.code).toBe('VERIFICATION_INVALID');
    expect((await s.generate('employee', id)).status).toBe(201);
    const reused = await s.generate('employee', id);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('VERIFICATION_USED');

    const stale = await s.verify('employee');
    await moveTo(T0 + 121_000);
    expect((await s.generate('employee', stale.body.verificationId)).body.error.code).toBe(
      'VERIFICATION_EXPIRED',
    );
  });

  it('is for a checked-in-or-out person’s next action, and for nothing on a day off', async () => {
    // After checking in, the next code is for checking out.
    await checkIn(h.testDb, s.employee.id, '2026-11-02T10:00:00+05:30');
    expect((await s.get('/api/attendance-qr/today', s.tok.employee)).body.next).toBe('CHECK_OUT');
    const out = await s.code('employee');
    expect(out.action).toBe('CHECK_OUT');

    // A weekly off (Sunday): nothing to generate, and the proof is not spent.
    await moveTo(Date.parse('2026-11-08T04:30:00Z'));
    const today = await s.get('/api/attendance-qr/today', s.tok.colleague);
    expect(today.body).toMatchObject({ next: 'BLOCKED', blockedReason: { code: 'WEEKLY_OFF' } });
    // The check is refused up front, so no evidence is written and nothing is spent.
    const checked = await s.verify('colleague');
    expect(checked.status).toBe(422);
    expect(checked.body.error.code).toBe('WEEKLY_OFF');
    const refused = await s.generate('colleague');
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('WEEKLY_OFF');
    expect(
      await h.testDb.query('select 1 from public.attendance_verifications where employee_id = $1', [
        s.colleague.id,
      ]),
    ).toHaveLength(0);
  });

  it('lets a new code replace the old one, up to the daily limit', async () => {
    const first = await s.code();
    const second = await s.code();
    expect((await tokenRow(first.id)).status).toBe('SUPERSEDED');
    expect((await tokenRow(second.id)).status).toBe('ACTIVE');

    const old = await s.scan(first.payload);
    expect(old.status).toBe(422);
    expect(old.body.error.code).toBe('QR_SUPERSEDED');
    expect(old.body.error.details.employee.fullName).toBe(s.employee.fullName);

    await s.code();
    await s.code();
    const fifth = await s.code();
    expect(fifth.generatedToday).toBe(5);

    const verified = await s.verify();
    const sixth = await s.generate('employee', verified.body.verificationId);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('QR_LIMIT_REACHED');
    // The limit is the policy's to change.
    await h.testDb.query('update public.attendance_policies set daily_qr_max_per_day = 6');
    expect((await s.generate('employee', verified.body.verificationId)).status).toBe(201);
  });

  it('honours the configured lifetime', async () => {
    await h.testDb.query('update public.attendance_policies set daily_qr_ttl_seconds = 45');
    const issued = await s.code();
    expect(new Date(issued.expiresAt).getTime() - new Date(issued.issuedAt).getTime()).toBe(45_000);
    await moveTo(T0 + 46_000);
    expect((await s.scan(issued.payload, s.tok.admin)).body.error.code).toBe('QR_EXPIRED');
  });

  it('does not ask an administrator for location or Wi-Fi', async () => {
    const boss = await createAccount(h, { role: 'admin', attendanceRequired: true });
    const token = await accessTokenFor(h, boss);
    await s.forgetNetworks(); // not on the office network
    const today = await request(h.app).get('/api/attendance-qr/today').set(bearer(token));
    expect(today.body.verificationRequired).toBe(false);
    const made = await request(h.app)
      .post('/api/attendance-qr/generate')
      .set(bearer(token))
      .send({});
    expect(made.status).toBe(201);
    const row = await tokenRow(made.body.id);
    expect(row).toMatchObject({ verification_id: null, verification_waived: true });

    // Nobody else is exempt, even if they say they are an administrator.
    const forged = await s.generate('employee');
    expect(forged.status).toBe(422);
  });

  it('is not available to accounts that do not mark attendance, or are inactive', async () => {
    expect((await s.get('/api/attendance-qr/today', s.tok.admin)).status).toBe(403);
    expect((await s.get('/api/attendance-qr/today', s.tok.display)).status).toBe(403);
    expect((await s.get('/api/attendance-qr/today', s.tok.operator)).status).toBe(403);
    expect((await request(h.app).get('/api/attendance-qr/today')).status).toBe(401);

    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [s.employee.id],
    );
    expect((await s.get('/api/attendance-qr/today', s.tok.employee)).status).toBe(403);
  });
});

// =============================================================================================
describe('an administrator scans the code', () => {
  it('records the attendance in one step, with no location and no Wi-Fi', async () => {
    const issued = await s.code();
    // The scanner is nowhere near the office and not on its network.
    await s.forgetNetworks();

    const res = await s.scan(issued.payload, s.tok.admin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      action: 'CHECK_IN',
      source: 'ADMIN_QR',
      employee: {
        id: s.employee.id,
        employeeCode: s.employee.code,
        fullName: s.employee.fullName,
      },
      attendance: {
        workDate: '2026-11-02',
        status: 'PRESENT',
        isLate: false,
        liveState: 'WORKING',
      },
    });
    expect(new Date(res.body.attendance.checkInAt).getTime()).toBe(T0);

    // One event, by the admin, as ADMIN_QR, with the EMPLOYEE's verification as evidence.
    const events = await s.events(s.employee.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'CHECK_IN',
      source: 'ADMIN_QR',
      actor_id: s.admin.id,
      verification_id: (await tokenRow(issued.id)).verification_id,
    });
    const token = await tokenRow(issued.id);
    expect(token).toMatchObject({ status: 'USED', used_by: s.admin.id });

    const log = await s.scanRow(res.body.scanId);
    expect(log).toMatchObject({
      status: 'RECORDED',
      detected_action: 'CHECK_IN',
      confirmed_action: 'CHECK_IN',
      employee_id: s.employee.id,
      scanned_by: s.admin.id,
      office_verification_id: null,
    });

    // The scanner never sent, and the server never stored, a location for the scanner.
    const [verifications] = await h.testDb.query<{ n: string }>(
      'select count(*)::text as n from public.attendance_verifications where employee_id = $1',
      [s.admin.id],
    );
    expect(verifications?.n).toBe('0');

    const audit = await auditRows(h, 'qr_attendance.recorded');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: s.admin.id, entity_type: 'attendance_event' });
    expect(await allAuditJson(h)).not.toContain(issued.payload);
  });

  it('lets an attendance operator scan too, and sends a late arrival to LATE', async () => {
    await moveTo(T0 + 30 * MIN); // 10:30, after the 10:20 threshold
    const issued = await s.code();
    const res = await s.scan(issued.payload, s.tok.operator);
    expect(res.status).toBe(200);
    expect(res.body.attendance).toMatchObject({ status: 'LATE', isLate: true });
  });

  it('records the check-out with the same engine, and a third code has nothing to do', async () => {
    const inCode = await s.code();
    expect((await s.scan(inCode.payload, s.tok.admin)).status).toBe(200);

    await moveTo(T0 + 8 * HOUR);
    const outCode = await s.code('employee');
    const out = await s.scan(outCode.payload, s.tok.admin);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({
      action: 'CHECK_OUT',
      attendance: { liveState: 'CHECKED_OUT' },
    });
    expect(out.body.attendance.netWorkSeconds).toBe(8 * 3600);
    expect((await s.events(s.employee.id)).map((e) => e.event_type)).toEqual([
      'CHECK_IN',
      'CHECK_OUT',
    ]);

    const today = await s.get('/api/attendance-qr/today', s.tok.employee);
    expect(today.body.next).toBe('ALREADY_CHECKED_OUT');
    const verified = await s.verify('employee');
    const refused = await s.generate('employee', verified.body.verificationId);
    expect(refused.body.error.code).toBe('ALREADY_CHECKED_OUT');
  });

  it('refuses a duplicate scan, says when it was first recorded, and records nothing twice', async () => {
    const issued = await s.code();
    const first = await s.scan(issued.payload, s.tok.admin);
    expect(first.status).toBe(200);

    await moveTo(T0 + 20_000);
    const second = await s.scan(issued.payload, s.tok.operator);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('QR_ALREADY_USED');
    expect(second.body.error.details).toMatchObject({
      employee: { fullName: s.employee.fullName },
    });
    expect(new Date(second.body.error.details.firstRecordedAt).getTime()).toBe(T0);

    expect(await s.events(s.employee.id)).toHaveLength(1);
    const log = await s.scanRow(second.body.error.details.scanId);
    expect(log).toMatchObject({
      status: 'REJECTED',
      qr_result: 'USED',
      reason_code: 'QR_ALREADY_USED',
    });
  });

  it('records a code once when two scanners read it at the same moment', async () => {
    const issued = await s.code();
    const results = await Promise.all([
      s.scan(issued.payload, s.tok.admin),
      s.scan(issued.payload, s.tok.operator),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await s.events(s.employee.id)).toHaveLength(1);
  });

  it('refuses an expired code, and an expired code stays expired', async () => {
    const issued = await s.code();
    await moveTo(T0 + 91_000);
    const res = await s.scan(issued.payload, s.tok.admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('QR_EXPIRED');
    expect(await s.scanRow(res.body.error.details.scanId)).toMatchObject({
      qr_result: 'EXPIRED',
      status: 'REJECTED',
    });
    expect(await s.events(s.employee.id)).toHaveLength(0);
    expect((await tokenRow(issued.id)).status).toBe('ACTIVE'); // the code is untouched; it is simply too late
  });

  it('is bound to the day: a code does not survive midnight', async () => {
    await h.testDb.query('update public.attendance_policies set daily_qr_ttl_seconds = 900');
    // 23:55 office time on Monday; the code would still be "fresh" at 00:05 on Tuesday.
    await moveTo(Date.parse('2026-11-02T18:25:00Z'));
    const issued = await s.code();
    await moveTo(Date.parse('2026-11-02T18:35:00Z'));
    expect((await s.scan(issued.payload, s.tok.admin)).body.error.code).toBe('QR_EXPIRED');
  });

  it('refuses a code made for check-in once the day has moved on', async () => {
    const issued = await s.code('employee');
    await checkIn(h.testDb, s.employee.id, '2026-11-02T10:00:00+05:30');
    const res = await s.scan(issued.payload, s.tok.admin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SCAN_ACTION_MISMATCH');
    expect(await s.events(s.employee.id)).toHaveLength(1);
  });

  it('refuses an employee who was deactivated after generating', async () => {
    const issued = await s.code();
    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [s.employee.id],
    );
    const res = await s.scan(issued.payload, s.tok.admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPLOYEE_INACTIVE');
    expect(await s.events(s.employee.id)).toHaveLength(0);
  });

  it('never lets anyone record their own attendance', async () => {
    const boss = await createAccount(h, { role: 'admin', attendanceRequired: true });
    const token = await accessTokenFor(h, boss);
    const made = await request(h.app)
      .post('/api/attendance-qr/generate')
      .set(bearer(token))
      .send({});
    expect(made.status).toBe(201);

    const own = await s.scan(made.body.payload, token);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SELF_SCAN_FORBIDDEN');
    expect(await s.events(boss.id)).toHaveLength(0);

    // Somebody else can record the administrator, and they were never asked for a location.
    const other = await s.scan(made.body.payload, s.tok.admin);
    expect(other.status).toBe(200);
    expect((await s.events(boss.id))[0]).toMatchObject({
      source: 'ADMIN_QR',
      verification_id: null,
    });
  });

  describe('a code that is not acceptable', () => {
    it.each([
      ['some other text', 'hello'],
      ['a web address', 'https://example.com/employee/42'],
      ['a code with a letter missing', 'TGD1.abc'],
      ['the right shape in the wrong case', 'tgd1.' + 'A'.repeat(43)],
      ['a well-formed code nobody was given', 'TGD1.' + 'A'.repeat(43)],
    ])('refuses %s', async (_label, payload) => {
      const res = await s.scan(payload, s.tok.admin);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
      const row = await s.scanRow(res.body.error.details.scanId);
      expect(row).toMatchObject({ status: 'REJECTED', employee_id: null });
      const [dump] = await h.testDb.query<{ text: string }>(
        'select row_to_json(l)::text as text from public.qr_scan_logs l where id = $1',
        [res.body.error.details.scanId],
      );
      expect(dump?.text).not.toContain(payload);
    });

    it('refuses a code with one character changed, and every other spelling of the last one', async () => {
      const issued = await s.code();
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      let accepted = 0;
      for (const c of alphabet) {
        const attempt = issued.payload.slice(0, -1) + c;
        if (attempt === issued.payload) continue;
        const res = await s.scan(attempt, s.tok.admin);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
        accepted += 1;
      }
      expect(accepted).toBe(63);
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('says plainly when the lobby code or an old ID-card code was scanned', async () => {
      const lobby = (await s.get('/api/office/qr/current', s.tok.display)).body.payload as string;
      expect((await s.scan(lobby, s.tok.admin)).body.error.message).toMatch(/office QR code/);

      const card = await s.codeOf(s.employee);
      const res = await s.scan(card, s.tok.admin);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
      expect(res.body.error.message).toMatch(/no longer record attendance/);
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });
  });

  describe('who may use the scanner', () => {
    it('refuses an employee, the lobby screen and a signed-out caller', async () => {
      const issued = await s.code();
      const asEmployee = await s.scan(issued.payload, s.tok.colleague);
      expect(asEmployee.status).toBe(403);
      expect((await s.scan(issued.payload, s.tok.display)).status).toBe(403);
      expect(
        (await request(h.app).post('/api/qr-attendance/scan').send({ payload: issued.payload }))
          .status,
      ).toBe(401);
      // The refusal is the router's own (audited, and the request never reaches the scanner), not
      // just the database function's: nothing is written to the scan log for the employee.
      const denied = await auditRows(h, 'authz.denied');
      expect(denied.some((entry) => entry.actor_id === s.colleague.id)).toBe(true);
      expect(
        await h.testDb.query('select 1 from public.qr_scan_logs where scanned_by = $1', [
          s.colleague.id,
        ]),
      ).toHaveLength(0);
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('does not accept a location or any extra field from the scanner', async () => {
      const issued = await s.code();
      const res = await s.post(
        '/api/qr-attendance/scan',
        { payload: issued.payload, scanner: { kind: 'WEB' }, gps: s.gps() },
        s.tok.admin,
      );
      expect(res.status).toBe(400);
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('has no verify, confirm or challenge step any more', async () => {
      for (const path of [
        '/api/qr-attendance/scans/00000000-0000-4000-8000-000000000000/verify',
        '/api/qr-attendance/scans/00000000-0000-4000-8000-000000000000/confirm',
        '/api/qr-attendance/challenge',
      ]) {
        expect((await s.post(path, {}, s.tok.admin)).status, path).toBe(404);
      }
    });
  });

  it('remembers which device did the scanning, and lists recent scans', async () => {
    const issued = await s.code();
    const res = await request(h.app)
      .post('/api/qr-attendance/scan')
      .set(bearer(s.tok.operator))
      .set('User-Agent', 'FrontDeskTablet/1.0')
      .send({
        payload: issued.payload,
        scanner: { kind: 'MOBILE', label: 'Reception iPad', camera: 'Back Camera' },
      });
    expect(res.status).toBe(200);
    expect((await s.scanRow(res.body.scanId))?.scanner).toEqual({
      kind: 'MOBILE',
      label: 'Reception iPad',
      camera: 'Back Camera',
      userAgent: 'FrontDeskTablet/1.0',
    });

    const recent = await s.get('/api/qr-attendance/recent', s.tok.operator);
    expect(recent.body.items).toHaveLength(1);
    expect(recent.body.items[0]).toMatchObject({
      status: 'RECORDED',
      employee: { id: s.employee.id },
    });
    expect((await s.get('/api/qr-attendance/recent', s.tok.admin)).body.items).toHaveLength(0);
  });
});

// =============================================================================================
describe('the administrator’s attendance dashboard', () => {
  it('lists who is in, who is late and who is absent, with the scan warnings', async () => {
    const a = await s.code('employee');
    expect((await s.scan(a.payload, s.tok.admin)).status).toBe(200);
    await s.scan(a.payload, s.tok.admin); // duplicate
    await s.scan('not a code', s.tok.admin); // unrecognised

    const report = await s.get('/api/admin/attendance/daily', s.tok.admin);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      date: '2026-11-02',
      isToday: true,
      summary: { total: 2, present: 1, late: 0, absent: 1, onLeave: 0 },
      warnings: { duplicateScans: 1, invalidOrExpiredScans: 1 },
    });
    const byName = Object.fromEntries(
      report.body.rows.map((r: { fullName: string }) => [r.fullName, r]),
    ) as Record<string, { state: string; checkInAt: string | null; source: string | null }>;
    expect(byName[s.employee.fullName]).toMatchObject({ state: 'PRESENT', source: 'ADMIN_QR' });
    expect(new Date(byName[s.employee.fullName]!.checkInAt!).getTime()).toBe(T0);
    expect(byName[s.colleague.fullName]).toMatchObject({ state: 'ABSENT', checkInAt: null });
    // The administrator, the operator and the lobby screen are not counted.
    expect(Object.keys(byName)).toHaveLength(2);
  });

  it('shows another day, a holiday and leave, and refuses the future', async () => {
    const sunday = await s.get('/api/admin/attendance/daily?date=2026-11-01', s.tok.admin);
    expect(sunday.body.rows.every((r: { state: string }) => r.state === 'WEEKLY_OFF')).toBe(true);
    expect((await s.get('/api/admin/attendance/daily?date=2026-11-03', s.tok.admin)).status).toBe(
      400,
    );
    expect((await s.get('/api/admin/attendance/daily?date=soon', s.tok.admin)).status).toBe(400);
  });

  it('is for administrators only', async () => {
    for (const who of ['employee', 'operator', 'display'] as const) {
      expect((await s.get('/api/admin/attendance/daily', s.tok[who])).status, who).toBe(403);
    }
  });
});

// =============================================================================================
describe('scan history', () => {
  it('lists recorded and refused scans, newest first, and filters them', async () => {
    const issued = await s.code();
    const recorded = (await s.scan(issued.payload, s.tok.operator)).body.scanId as string;
    await moveTo(T0 + 60_000);
    const refused = (await s.scan('definitely not a code', s.tok.operator)).body.error.details
      .scanId as string;

    const all = await s.get('/api/admin/qr-scans', s.tok.admin);
    expect(all.body.total).toBe(2);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([refused, recorded]);
    expect(all.body.items[1]).toMatchObject({
      status: 'RECORDED',
      detectedAction: 'CHECK_IN',
      confirmedAction: 'CHECK_IN',
      employee: { id: s.employee.id },
      scannedBy: { id: s.operator.id, role: 'attendance_operator' },
      clientIp: '127.0.0.1',
    });
    expect(all.body.items[0]).toMatchObject({
      status: 'REJECTED',
      qrResult: 'MALFORMED',
      employee: null,
    });

    const ids = async (q: string) =>
      (
        (await s.get(`/api/admin/qr-scans?${q}`, s.tok.admin)).body.items as Array<{ id: string }>
      ).map((i) => i.id);
    expect(await ids('status=RECORDED')).toEqual([recorded]);
    expect(await ids('status=REJECTED')).toEqual([refused]);
    expect(await ids(`employeeId=${s.employee.id}`)).toEqual([recorded]);
    expect(await ids('from=2026-11-02&to=2026-11-02')).toEqual([refused, recorded]);
    expect(await ids('from=2026-11-03')).toEqual([]);
    expect((await s.get('/api/admin/qr-scans', s.tok.operator)).status).toBe(403);
  });
});
