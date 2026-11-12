import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db, Queryable } from '../db/pool.js';
import { deriveEmployeeQrKey, derivePayload, newNonce } from '../employee-qr/token.js';
import { createLogger } from '../lib/logger.js';
import {
  accessTokenFor,
  allAuditJson,
  auditRows,
  bearer,
  createAccount,
  START_TIME,
  useApi,
} from '../testing/api-harness.js';
import { checkIn, checkOut, startBreak } from '../testing/fixtures.js';
import { QrScene } from '../testing/qr-scene.js';

const h = useApi();
const s = new QrScene(h);

const T0 = Date.parse(START_TIME); // Monday 2026-11-02 10:00 in Asia/Kolkata
const MON = '2026-11-02';
const at = (time: string, date = MON) => `${date}T${time}+05:30`;

beforeEach(async () => {
  await s.setUp();
});

// =============================================================================================
describe('reading an employee code', () => {
  it('shows who it is and what would happen, and changes no attendance', async () => {
    const payload = await s.codeOf(s.employee);
    const res = await s.scan(payload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: 'CHECK_IN',
      reason: null,
      employee: {
        id: s.employee.id,
        employeeCode: s.employee.code,
        fullName: s.employee.fullName,
        department: null,
        designation: null,
        avatarUrl: null,
        accountStatus: 'ACTIVE',
      },
      today: {
        workDate: MON,
        status: null,
        liveState: 'NONE',
        checkInAt: null,
        checkOutAt: null,
        isLate: false,
      },
      requiredLayers: ['GPS', 'NETWORK'],
    });
    expect(new Date(res.body.scannedAt).getTime()).toBe(T0);
    // two minutes to confirm: the policy's verification window
    expect(new Date(res.body.expiresAt).getTime()).toBe(T0 + 120_000);

    // The scan is written down, but attendance is untouched.
    const row = await s.scanRow(res.body.scanId);
    expect(row).toMatchObject({
      status: 'PENDING',
      detected_action: 'CHECK_IN',
      qr_result: 'VALID',
      employee_id: s.employee.id,
      scanned_by: s.operator.id,
    });
    expect(await s.record_(s.employee.id)).toBeUndefined();
    expect(await s.events(s.employee.id)).toHaveLength(0);
  });

  it('never records anything by itself, however often the same code is read', async () => {
    const payload = await s.codeOf(s.employee);
    for (let i = 0; i < 4; i += 1) {
      const res = await s.scan(payload);
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('CHECK_IN');
    }
    expect(await s.record_(s.employee.id)).toBeUndefined();
    const [pending] = await h.testDb.query<{ n: string }>(
      `select count(*)::text as n from public.qr_scan_logs where status = 'PENDING'`,
    );
    expect(pending?.n).toBe('4');
  });

  it('remembers which device did the scanning', async () => {
    const res = await request(h.app)
      .post('/api/qr-attendance/scan')
      .set(bearer(s.tok.operator))
      .set('User-Agent', 'FrontDeskTablet/1.0')
      .send({
        payload: await s.codeOf(s.employee),
        scanner: { kind: 'MOBILE', label: 'Reception iPad', camera: 'Back Camera' },
      });
    expect(res.status).toBe(200);
    const row = await s.scanRow(res.body.scanId);
    expect(row?.scanner).toEqual({
      kind: 'MOBILE',
      label: 'Reception iPad',
      camera: 'Back Camera',
      userAgent: 'FrontDeskTablet/1.0',
    });
    const [ip] = await h.testDb.query<{ ip: string }>(
      'select host(client_ip) as ip from public.qr_scan_logs where id = $1',
      [res.body.scanId],
    );
    expect(ip?.ip).toBe('127.0.0.1');
  });

  it('asks for the scanner’s details and nothing extra', async () => {
    const payload = await s.codeOf(s.employee);
    expect((await s.post('/api/qr-attendance/scan', { payload })).status).toBe(400);
    expect(
      (
        await s.post('/api/qr-attendance/scan', {
          payload,
          scanner: { kind: 'WEB' },
          employeeId: s.colleague.id,
        })
      ).status,
    ).toBe(400);
    expect((await s.post('/api/qr-attendance/scan', { scanner: { kind: 'WEB' } })).status).toBe(
      400,
    );
  });

  describe('a code that is not acceptable', () => {
    it.each([
      ['some other text', 'hello'],
      ['a web address', 'https://example.com/employee/42'],
      ['a lot of text', 'x'.repeat(3000)],
      ['a code with a letter missing', 'TGE1.abc'],
      ['the right shape in the wrong case', 'tge1.' + 'A'.repeat(43)],
    ])('refuses %s, and keeps no copy of it', async (_label, payload) => {
      const res = await s.scan(payload);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');

      const row = await s.scanRow(res.body.error.details.scanId);
      expect(row).toMatchObject({
        status: 'REJECTED',
        detected_action: 'REJECTED',
        qr_result: 'MALFORMED',
        reason_code: 'EMPLOYEE_QR_INVALID',
        employee_id: null,
        token_hash: null,
      });
      // What was scanned is not stored anywhere in the row.
      const [dump] = await h.testDb.query<{ text: string }>(
        'select row_to_json(l)::text as text from public.qr_scan_logs l where id = $1',
        [res.body.error.details.scanId],
      );
      expect(dump?.text).not.toContain(payload);
    });

    it('refuses a well-formed code nobody was ever given, storing only its hash', async () => {
      const stranger = derivePayload(
        deriveEmployeeQrKey('some-other-secret-0123456789abcdef0123456789'),
        randomUUID(),
        newNonce(),
      );
      const res = await s.scan(stranger);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
      const row = await s.scanRow(res.body.error.details.scanId);
      expect(row).toMatchObject({ qr_result: 'UNKNOWN', status: 'REJECTED' });
      expect(
        Buffer.from(row!.token_hash!).equals(createHash('sha256').update(stranger).digest()),
      ).toBe(true);
    });

    it('refuses a code with one character changed, and every other spelling of the last one', async () => {
      const payload = await s.codeOf(s.employee);
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      // The last character of 43 base64url characters carries only 4 bits, so a decoder would
      // accept four spellings of it. Exactly one spelling may work.
      const accepted: string[] = [];
      for (const c of alphabet) {
        const res = await s.scan(payload.slice(0, -1) + c);
        if (res.status === 200) accepted.push(c);
        else expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
      }
      expect(accepted).toEqual([payload.slice(-1)]);

      const changed = payload.slice(0, 10) + (payload[10] === 'A' ? 'B' : 'A') + payload.slice(11);
      expect((await s.scan(changed)).status).toBe(422);
    });

    it('says plainly when the office’s lobby code was scanned by mistake', async () => {
      const lobby = (await s.get('/api/office/qr/current', s.tok.display)).body.payload as string;
      expect(lobby).toMatch(/^TG1\./);
      const res = await s.scan(lobby);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_INVALID');
      expect(res.body.error.message).toMatch(/office QR code/);
    });

    it('refuses a revoked code, naming the employee so staff know who to help', async () => {
      const payload = await s.codeOf(s.employee);
      const revoke = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'ID card lost' },
        s.tok.admin,
      );
      expect(revoke.status).toBe(200);

      const res = await s.scan(payload);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_REVOKED');
      expect(res.body.error.details.employee).toEqual({
        employeeCode: s.employee.code,
        fullName: s.employee.fullName,
      });
      const row = await s.scanRow(res.body.error.details.scanId);
      expect(row).toMatchObject({
        qr_result: 'REVOKED',
        status: 'REJECTED',
        employee_id: s.employee.id,
      });
    });

    it('refuses an inactive employee', async () => {
      const payload = await s.codeOf(s.employee);
      await h.testDb.query(
        'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
        [s.employee.id],
      );
      const res = await s.scan(payload);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_INACTIVE');
      expect(res.body.error.details.employee.employeeCode).toBe(s.employee.code);
      expect(await s.scanRow(res.body.error.details.scanId)).toMatchObject({
        status: 'REJECTED',
        qr_result: 'VALID',
        reason_code: 'EMPLOYEE_INACTIVE',
      });
    });

    it('refuses somebody whose attendance is not tracked', async () => {
      const res = await s.scan(await s.codeOf(s.admin));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ATTENDANCE_NOT_TRACKED');
    });
  });

  describe('what the code means for today', () => {
    it('is a check-out for somebody who is in', async () => {
      await checkIn(h.testDb, s.employee.id, at('10:05:00'));
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body).toMatchObject({
        action: 'CHECK_OUT',
        today: { status: 'PRESENT', liveState: 'WORKING', isLate: false, checkOutAt: null },
      });
      expect(new Date(res.body.today.checkInAt).getTime()).toBe(Date.parse(at('10:05:00')));
    });

    it('shows a late arrival as late', async () => {
      await checkIn(h.testDb, s.employee.id, at('10:25:00'));
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body.today).toMatchObject({ status: 'LATE', isLate: true });
    });

    it('has nothing to do once they have checked out', async () => {
      await checkIn(h.testDb, s.employee.id, at('10:05:00'));
      await checkOut(h.testDb, s.employee.id, at('18:00:00'));
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        action: 'ALREADY_CHECKED_OUT',
        reason: { code: 'ALREADY_CHECKED_OUT' },
        today: { liveState: 'CHECKED_OUT' },
      });
      expect(res.body.reason.message).toMatch(/already checked out/i);
      expect(await s.scanRow(res.body.scanId)).toMatchObject({
        status: 'NO_ACTION',
        detected_action: 'ALREADY_CHECKED_OUT',
      });

      // ...and there is nothing to confirm.
      const confirm = await s.confirm(res.body.scanId, 'CHECK_OUT');
      expect(confirm.status).toBe(409);
      expect(confirm.body.error.code).toBe('SCAN_NOT_ACTIONABLE');
    });

    it('is blocked on a holiday', async () => {
      await h.testDb.query(
        `insert into public.holidays (holiday_date, name) values ($1, 'Test holiday')`,
        [MON],
      );
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body).toMatchObject({ action: 'BLOCKED', reason: { code: 'HOLIDAY' } });
      expect(await s.scanRow(res.body.scanId)).toMatchObject({
        status: 'NO_ACTION',
        reason_code: 'HOLIDAY',
      });
    });

    it('is blocked on a weekly off day', async () => {
      await h.testDb.query(`update public.office_locations set working_days = '{2,3,4,5,6}'`);
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body).toMatchObject({ action: 'BLOCKED', reason: { code: 'WEEKLY_OFF' } });
    });

    it('is blocked for somebody on approved leave', async () => {
      await h.testDb.query(
        `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
         values ($1, $2, $2, $3)`,
        [s.employee.id, MON, s.admin.id],
      );
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body).toMatchObject({ action: 'BLOCKED', reason: { code: 'ON_LEAVE' } });
    });

    it('is blocked from checking out while a break is running', async () => {
      await checkIn(h.testDb, s.employee.id, at('10:05:00'));
      await startBreak(h.testDb, s.employee.id, 'SHORT', at('10:30:00'));
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body).toMatchObject({ action: 'BLOCKED', reason: { code: 'ACTIVE_BREAK' } });
    });

    it('lists the presence checks the operator will have to pass', async () => {
      await s.setAdminScanLayers(['GPS', 'NETWORK', 'QR', 'DEVICE']);
      const res = await s.scan(await s.codeOf(s.employee));
      expect(res.body.requiredLayers).toEqual(['GPS', 'NETWORK', 'QR', 'DEVICE']);
    });
  });
});

// =============================================================================================
describe('who may use the scanner', () => {
  const endpoints: Array<[string, string, Record<string, unknown>?]> = [
    ['post', '/api/qr-attendance/scan', { payload: 'x', scanner: { kind: 'WEB' } }],
    ['post', `/api/qr-attendance/scans/${randomUUID()}/verify`, { channel: 'WEB' }],
    ['post', `/api/qr-attendance/scans/${randomUUID()}/confirm`, { action: 'CHECK_IN' }],
    ['post', '/api/qr-attendance/challenge', { deviceId: randomUUID() }],
    ['get', '/api/qr-attendance/recent'],
  ];

  it.each(endpoints)(
    'turns an employee away from %s %s, and records the attempt',
    async (method, path, body) => {
      const send =
        method === 'post' ? s.post(path, body, s.tok.employee) : s.get(path, s.tok.employee);
      const res = await send;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      const denials = await auditRows(h, 'authz.denied');
      expect(denials.at(-1)).toMatchObject({
        actor_id: s.employee.id,
        actor_role: 'employee',
        metadata: { required_roles: ['admin', 'attendance_operator'] },
      });
    },
  );

  it.each(endpoints)('turns the lobby display away from %s %s', async (method, path, body) => {
    const send = method === 'post' ? s.post(path, body, s.tok.display) : s.get(path, s.tok.display);
    expect((await send).status).toBe(403);
  });

  it.each(endpoints)('needs a signed-in user for %s %s', async (method, path, body) => {
    const send =
      method === 'post' ? request(h.app).post(path).send(body) : request(h.app).get(path);
    const res = await send;
    expect(res.status).toBe(401);
  });

  it('refuses an employee even when they hold a perfectly valid code', async () => {
    const payload = await s.codeOf(s.employee);
    const res = await s.scan(payload, s.tok.employee);
    expect(res.status).toBe(403);
    expect(await s.record_(s.employee.id)).toBeUndefined();
  });

  it('lets both an administrator and an operator scan', async () => {
    const payload = await s.codeOf(s.employee);
    expect((await s.scan(payload, s.tok.admin)).status).toBe(200);
    expect((await s.scan(payload, s.tok.operator)).status).toBe(200);
  });

  it('turns a deactivated operator away at once, even with a token that has not expired', async () => {
    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [s.operator.id],
    );
    const res = await s.scan(await s.codeOf(s.employee));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('turns away a session that has expired', async () => {
    const payload = await s.codeOf(s.employee);
    const { body } = await s.scan(payload);
    h.clock.set(new Date(T0 + 2 * 3600_000)); // access tokens last an hour
    for (const res of [
      await s.scan(payload),
      await s.verifyScan(body.scanId),
      await s.confirm(body.scanId, 'CHECK_IN'),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(await s.record_(s.employee.id)).toBeUndefined();
  });

  it('keeps one operator’s scans away from another', async () => {
    const other = await createAccount(h, { role: 'attendance_operator' });
    const otherToken = await accessTokenFor(h, other);
    const { body } = await s.scan(await s.codeOf(s.employee));

    const verify = await s.verifyScan(body.scanId, undefined, otherToken);
    expect(verify.status).toBe(404);
    const confirm = await s.confirm(body.scanId, 'CHECK_IN', undefined, otherToken);
    expect(confirm.status).toBe(404);
    expect((await s.get('/api/qr-attendance/recent', otherToken)).body.items).toHaveLength(0);
  });
});

// =============================================================================================
describe('recording your own attendance', () => {
  // The scanner checks fewer things than a check-in may require (the lobby code and a registered
  // device are optional here), so letting somebody record THEMSELVES with it would be a way round
  // the stricter policy. Their own check-in path stays as strict as everybody else's.
  it.each([
    ['an operator', 'operator'],
    ['an administrator', 'admin'],
  ] as const)('is refused for %s scanning their own code', async (_label, who) => {
    const person = s[who];
    await h.testDb.query('update public.profiles set attendance_required = true where id = $1', [
      person.id,
    ]);
    const ownCode = await s.codeOf(person);

    const res = await s.scan(ownCode, s.tok[who]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_SCAN_FORBIDDEN');

    // The attempt is on record, as a refusal, and nothing was recorded.
    expect(await s.scanRow(res.body.error.details.scanId)).toMatchObject({
      status: 'REJECTED',
      reason_code: 'SELF_SCAN_FORBIDDEN',
      employee_id: person.id,
      scanned_by: person.id,
    });
    expect(await s.events(person.id)).toHaveLength(0);
    expect(await s.record_(person.id)).toBeUndefined();
  });

  it('is refused even when the scanner’s own code has been revoked', async () => {
    const ownCode = await s.codeOf(s.admin);
    await s.post(`/api/admin/employee-qr/${s.admin.id}/revoke`, { reason: 'test' }, s.tok.admin);
    const res = await s.scan(ownCode, s.tok.admin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_SCAN_FORBIDDEN');
  });

  it('still lets somebody else record an operator whose attendance is tracked', async () => {
    await h.testDb.query('update public.profiles set attendance_required = true where id = $1', [
      s.operator.id,
    ]);
    const { confirmation } = await s.record(await s.codeOf(s.operator), 'CHECK_IN', s.tok.admin);
    expect(confirmation.employee.id).toBe(s.operator.id);
    expect((await s.events(s.operator.id))[0]).toMatchObject({
      actor_id: s.admin.id,
      source: 'ADMIN_QR',
    });
  });

  it('does not stop the same people recording everybody else', async () => {
    await s.record(await s.codeOf(s.employee), 'CHECK_IN', s.tok.operator);
    await s.record(await s.codeOf(s.colleague), 'CHECK_IN', s.tok.admin);
    expect(await s.events(s.employee.id)).toHaveLength(1);
    expect(await s.events(s.colleague.id)).toHaveLength(1);
  });
});

// =============================================================================================
describe('proving the person at the scanner is at the office', () => {
  let scanId: string;
  beforeEach(async () => {
    scanId = (await s.scan(await s.codeOf(s.employee))).body.scanId as string;
  });

  it('accepts an operator at the office, on its network', async () => {
    const res = await s.verifyScan(scanId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: 'VERIFIED',
      layers: { GPS: 'PASS', NETWORK: 'PASS', QR: 'NOT_REQUIRED', DEVICE: 'NOT_REQUIRED' },
    });
    expect(new Date(res.body.expiresAt).getTime()).toBe(T0 + 120_000);

    // It is the OPERATOR's proof, for the scanner purpose, and the scan points at it.
    const [ver] = await h.testDb.query<{
      employee_id: string;
      purpose: string;
      final_result: string;
      consumed_at: Date | null;
    }>(
      'select employee_id, purpose::text, final_result::text, consumed_at from public.attendance_verifications where id = $1',
      [res.body.verificationId],
    );
    expect(ver).toMatchObject({
      employee_id: s.operator.id,
      purpose: 'ADMIN_SCAN',
      final_result: 'VERIFIED',
      consumed_at: null,
    });
    expect(await s.scanRow(scanId)).toMatchObject({
      office_verification_id: res.body.verificationId,
      office_verification_result: 'VERIFIED',
    });
  });

  it('refuses an operator who is not at the office', async () => {
    const res = await s.verifyScan(scanId, { channel: 'WEB', gps: s.gpsMetresNorth(500) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VERIFICATION_FAILED');
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code)).toEqual([
      'GPS_OUTSIDE_RADIUS',
    ]);
    expect(await s.scanRow(scanId)).toMatchObject({
      status: 'PENDING',
      office_verification_result: 'REJECTED',
    });

    // ...and with that attempt on file the scan cannot be confirmed.
    const confirm = await s.confirm(scanId, 'CHECK_IN');
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe('VERIFICATION_INVALID');
    expect(await s.events(s.employee.id)).toHaveLength(0);
  });

  it('refuses a missing location', async () => {
    const res = await s.verifyScan(scanId, { channel: 'WEB' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code)).toEqual([
      'GPS_MISSING',
    ]);
  });

  it('refuses an operator who is not on the office network', async () => {
    await s.forgetNetworks();
    await s.allowNetwork('203.0.113.0/24');
    const res = await request(h.app)
      .post(`/api/qr-attendance/scans/${scanId}/verify`)
      .set(bearer(s.tok.operator))
      // A forged forwarding header does not change where the request really came from.
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ channel: 'WEB', gps: s.gps() });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code)).toEqual([
      'NETWORK_NOT_ALLOWED',
    ]);
  });

  it('reports every failed layer at once', async () => {
    await s.forgetNetworks();
    const res = await s.verifyScan(scanId, { channel: 'WEB', gps: s.gpsMetresNorth(500) });
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code).sort()).toEqual([
      'GPS_OUTSIDE_RADIUS',
      'NETWORK_NOT_CONFIGURED',
    ]);
  });

  it('can be told to ask for the lobby code and a registered device as well', async () => {
    await s.setAdminScanLayers(['GPS', 'NETWORK', 'QR', 'DEVICE']);
    const fresh = (await s.scan(await s.codeOf(s.employee))).body.scanId as string;
    const res = await s.verifyScan(fresh);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code).sort()).toEqual([
      'DEVICE_MISSING',
      'QR_MISSING',
    ]);

    // The lobby code passes the QR layer; an employee's own code does not.
    const lobby = (await s.get('/api/office/qr/current', s.tok.display)).body.payload as string;
    const withLobby = await s.verifyScan(fresh, {
      channel: 'WEB',
      gps: s.gps(),
      qr: { payload: lobby },
    });
    expect(withLobby.body.error.details.reasons.map((r: { code: string }) => r.code)).toEqual([
      'DEVICE_MISSING',
    ]);
    const withEmployeeCode = await s.verifyScan(fresh, {
      channel: 'WEB',
      gps: s.gps(),
      qr: { payload: await s.codeOf(s.colleague) },
    });
    expect(
      withEmployeeCode.body.error.details.reasons.map((r: { code: string }) => r.code),
    ).toContain('QR_INVALID');
  });

  it('cannot be requested through the employee check-in endpoint', async () => {
    const res = await s.post(
      '/api/attendance/verify',
      { purpose: 'ADMIN_SCAN', channel: 'WEB', gps: s.gps() },
      s.tok.employee,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // ...and the operator role has no way into that endpoint at all.
    const asOperator = await s.post(
      '/api/attendance/verify',
      { purpose: 'CHECK_IN', channel: 'WEB', gps: s.gps() },
      s.tok.operator,
    );
    expect(asOperator.status).toBe(403);
    const challenge = await s.post(
      '/api/attendance/challenge',
      { deviceId: randomUUID(), purpose: 'ADMIN_SCAN' },
      s.tok.employee,
    );
    expect(challenge.status).toBe(400);
  });

  it('is not accepted after the scan has run out of time', async () => {
    h.clock.set(new Date(T0 + 121_000));
    const res = await s.verifyScan(scanId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SCAN_EXPIRED');
  });

  it('is refused for a scan that is already recorded or has nothing to confirm', async () => {
    await s.verifyScan(scanId);
    expect((await s.confirm(scanId, 'CHECK_IN')).status).toBe(200);
    const again = await s.verifyScan(scanId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SCAN_ALREADY_RECORDED');
  });

  it('has no registered device to challenge for a plain operator', async () => {
    const res = await s.post('/api/qr-attendance/challenge', { deviceId: randomUUID() });
    expect(res.status).toBe(404);
  });
});

// =============================================================================================
describe('recording attendance', () => {
  it('checks an employee in through the same records as a normal check-in', async () => {
    const payload = await s.codeOf(s.employee);
    const { scan, confirmation } = await s.record(payload, 'CHECK_IN');

    expect(confirmation).toMatchObject({
      scanId: scan.scanId,
      action: 'CHECK_IN',
      source: 'ADMIN_QR',
      employee: { id: s.employee.id, employeeCode: s.employee.code, fullName: s.employee.fullName },
      attendance: {
        workDate: MON,
        status: 'PRESENT',
        isLate: false,
        liveState: 'WORKING',
        checkOutAt: null,
        netWorkSeconds: null,
      },
    });
    expect(new Date(confirmation.recordedAt).getTime()).toBe(T0);
    expect(new Date(confirmation.attendance.checkInAt!).getTime()).toBe(T0);

    // One ordinary attendance record, one event saying who recorded it and from where.
    const rec = await s.record_(s.employee.id);
    expect(rec).toMatchObject({ status: 'PRESENT', is_late: false, live_state: 'WORKING' });
    const events = await s.events(s.employee.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'CHECK_IN',
      source: 'ADMIN_QR',
      actor_id: s.operator.id,
    });
    expect(events[0]!.occurred_at.getTime()).toBe(T0); // the server's clock, not the client's
    expect(events[0]!.metadata).toMatchObject({
      scan_id: scan.scanId,
      scanned_by: s.operator.id,
      is_late: false,
    });

    // The evidence is the operator's presence proof, spent now.
    const [ver] = await h.testDb.query<{
      employee_id: string;
      purpose: string;
      consumed_at: Date | null;
    }>(
      'select employee_id, purpose::text, consumed_at from public.attendance_verifications where id = $1',
      [events[0]!.verification_id],
    );
    expect(ver).toMatchObject({ employee_id: s.operator.id, purpose: 'ADMIN_SCAN' });
    expect(ver?.consumed_at).not.toBeNull();
    expect(rec?.check_in_verification_id).toBe(events[0]!.verification_id);
    expect(rec?.check_in_device_id).toBeNull();

    // The scan says what became of it.
    expect(await s.scanRow(scan.scanId)).toMatchObject({
      status: 'RECORDED',
      confirmed_action: 'CHECK_IN',
      office_verification_result: 'VERIFIED',
      attendance_event_id: events[0]!.id,
    });
  });

  it('leaves an audit trail naming who recorded it, and never the code', async () => {
    const payload = await s.codeOf(s.employee);
    const { scan } = await s.record(payload, 'CHECK_IN');
    const rows = await auditRows(h, 'qr_attendance.recorded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: s.operator.id,
      actor_role: 'attendance_operator',
      entity_type: 'attendance_event',
      metadata: {
        scan_id: scan.scanId,
        action: 'CHECK_IN',
        employee_id: s.employee.id,
        source: 'ADMIN_QR',
      },
    });
    const everything = await allAuditJson(h);
    expect(everything).not.toContain(payload);
    expect(everything).not.toContain(payload.slice(5));
  });

  it('applies the late-arrival rule at the moment of confirming', async () => {
    h.clock.set(new Date(Date.parse(at('10:25:00'))));
    const { confirmation } = await s.record(await s.codeOf(s.employee), 'CHECK_IN');
    expect(confirmation.attendance).toMatchObject({ status: 'LATE', isLate: true });
    expect(await s.record_(s.employee.id)).toMatchObject({ status: 'LATE', is_late: true });
  });

  it('checks the same employee out later, on the same day record', async () => {
    const payload = await s.codeOf(s.employee);
    await s.record(payload, 'CHECK_IN');

    h.clock.set(new Date(Date.parse(at('18:00:00'))));
    await s.refreshTokens();
    const { confirmation } = await s.record(payload, 'CHECK_OUT');

    expect(confirmation).toMatchObject({
      action: 'CHECK_OUT',
      attendance: { workDate: MON, liveState: 'CHECKED_OUT' },
    });
    expect(confirmation.attendance.netWorkSeconds).toBe(8 * 3600);
    const events = await s.events(s.employee.id);
    expect(events.map((e) => [e.event_type, e.source, e.actor_id])).toEqual([
      ['CHECK_IN', 'ADMIN_QR', s.operator.id],
      ['CHECK_OUT', 'ADMIN_QR', s.operator.id],
    ]);
    const [records] = await h.testDb.query<{ n: string }>(
      'select count(*)::text as n from public.attendance_records where employee_id = $1',
      [s.employee.id],
    );
    expect(records?.n).toBe('1'); // one record for the day, not one per route

    // And once checked out, the same code leads nowhere.
    const again = await s.scan(payload);
    expect(again.body.action).toBe('ALREADY_CHECKED_OUT');
  });

  it('lets an administrator record too, and marks them as the actor', async () => {
    await s.record(await s.codeOf(s.employee), 'CHECK_IN', s.tok.admin);
    expect((await s.events(s.employee.id))[0]).toMatchObject({
      actor_id: s.admin.id,
      source: 'ADMIN_QR',
    });
  });

  it('records the time from the server, whatever the request says', async () => {
    const { body } = await s.scan(await s.codeOf(s.employee));
    await s.verifyScan(body.scanId);
    const res = await request(h.app)
      .post(`/api/qr-attendance/scans/${body.scanId}/confirm`)
      .set(bearer(s.tok.operator))
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'CHECK_IN', occurredAt: '2026-11-02T03:00:00Z', timestamp: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await s.events(s.employee.id)).toHaveLength(0);
  });

  describe('confirming', () => {
    let scanId: string;
    beforeEach(async () => {
      scanId = (await s.scan(await s.codeOf(s.employee))).body.scanId as string;
    });

    it('needs the operator to have proved their presence first', async () => {
      const res = await s.confirm(scanId, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('needs an Idempotency-Key', async () => {
      await s.verifyScan(scanId);
      for (const header of [undefined, 'short', 'has spaces in it!!']) {
        let req = request(h.app)
          .post(`/api/qr-attendance/scans/${scanId}/confirm`)
          .set(bearer(s.tok.operator));
        if (header !== undefined) req = req.set('Idempotency-Key', header);
        const res = await req.send({ action: 'CHECK_IN' });
        expect(res.status, String(header)).toBe(400);
        expect(res.body.error.details[0].path).toBe('Idempotency-Key');
      }
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('only accepts the two actions', async () => {
      await s.verifyScan(scanId);
      for (const action of ['ALREADY_CHECKED_OUT', 'BLOCKED', 'DELETE', '']) {
        expect((await s.confirm(scanId, action)).status, action).toBe(400);
      }
    });

    it('insists on the action the scan showed', async () => {
      await s.verifyScan(scanId);
      const res = await s.confirm(scanId, 'CHECK_OUT');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SCAN_ACTION_MISMATCH');
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('uses the presence proof once', async () => {
      await s.verifyScan(scanId);
      expect((await s.confirm(scanId, 'CHECK_IN')).status).toBe(200);

      // A second scan of somebody else cannot ride on the same proof: it needs its own.
      const other = (await s.scan(await s.codeOf(s.colleague))).body.scanId as string;
      const res = await s.confirm(other, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VERIFICATION_REQUIRED');
    });

    it('expires with the scan', async () => {
      await s.verifyScan(scanId);
      h.clock.set(new Date(T0 + 121_000));
      const res = await s.confirm(scanId, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SCAN_EXPIRED');
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('is refused if the code was revoked after it was read', async () => {
      await s.verifyScan(scanId);
      await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'lost' },
        s.tok.admin,
      );
      const res = await s.confirm(scanId, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_QR_REVOKED');
      expect(await s.events(s.employee.id)).toHaveLength(0);
    });

    it('is refused if the employee was deactivated after the code was read', async () => {
      await s.verifyScan(scanId);
      await h.testDb.query(
        'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
        [s.employee.id],
      );
      const res = await s.confirm(scanId, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EMPLOYEE_INACTIVE');
    });

    it('is refused if the day became a holiday after the code was read', async () => {
      await s.verifyScan(scanId);
      await h.testDb.query(
        `insert into public.holidays (holiday_date, name) values ($1, 'Surprise holiday')`,
        [MON],
      );
      const res = await s.confirm(scanId, 'CHECK_IN');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('HOLIDAY');
    });
  });

  describe('two operators at once', () => {
    let other: Awaited<ReturnType<typeof createAccount>>;
    let otherToken: string;
    beforeEach(async () => {
      other = await createAccount(h, { role: 'attendance_operator' });
      otherToken = await accessTokenFor(h, other);
    });

    it('checks an employee in only once', async () => {
      const payload = await s.codeOf(s.employee);
      const a = (await s.scan(payload, s.tok.operator)).body.scanId as string;
      const b = (await s.scan(payload, otherToken)).body.scanId as string;
      expect((await s.verifyScan(a)).status).toBe(200);
      expect((await s.verifyScan(b, undefined, otherToken)).status).toBe(200);

      expect((await s.confirm(a, 'CHECK_IN')).status).toBe(200);
      const second = await s.confirm(b, 'CHECK_IN', undefined, otherToken);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('ALREADY_CHECKED_IN');

      expect(await s.events(s.employee.id, 'CHECK_IN')).toHaveLength(1);
      // The loser's scan and proof are untouched, so it can simply be read again.
      expect(await s.scanRow(b)).toMatchObject({ status: 'PENDING', confirmed_action: null });
      const rescan = await s.scan(payload, otherToken);
      expect(rescan.body.action).toBe('CHECK_OUT');
    });

    it('checks an employee out only once', async () => {
      const payload = await s.codeOf(s.employee);
      await s.record(payload, 'CHECK_IN');

      h.clock.set(new Date(Date.parse(at('18:00:00'))));
      await s.refreshTokens();
      otherToken = await accessTokenFor(h, other);
      const a = (await s.scan(payload, s.tok.operator)).body.scanId as string;
      const b = (await s.scan(payload, otherToken)).body.scanId as string;
      await s.verifyScan(a);
      await s.verifyScan(b, undefined, otherToken);

      expect((await s.confirm(a, 'CHECK_OUT')).status).toBe(200);
      const second = await s.confirm(b, 'CHECK_OUT', undefined, otherToken);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('ALREADY_CHECKED_OUT');
      expect(await s.events(s.employee.id, 'CHECK_OUT')).toHaveLength(1);
    });

    it('keeps each operator’s recent scans to themselves', async () => {
      await s.scan(await s.codeOf(s.employee), s.tok.operator);
      await s.scan(await s.codeOf(s.colleague), otherToken);
      const mine = (await s.get('/api/qr-attendance/recent', s.tok.operator)).body.items;
      const theirs = (await s.get('/api/qr-attendance/recent', otherToken)).body.items;
      expect(mine.map((i: { employee: { id: string } }) => i.employee.id)).toEqual([s.employee.id]);
      expect(theirs.map((i: { employee: { id: string } }) => i.employee.id)).toEqual([
        s.colleague.id,
      ]);
    });
  });
});

// =============================================================================================
describe('retrying after a failure', () => {
  it('answers a repeated confirmation with the original result and records nothing twice', async () => {
    const { body } = await s.scan(await s.codeOf(s.employee));
    await s.verifyScan(body.scanId);
    const key = randomUUID();

    const first = await s.confirm(body.scanId, 'CHECK_IN', key);
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // The phone never saw the reply, so it asks again with the same key.
    const second = await s.confirm(body.scanId, 'CHECK_IN', key);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    expect(await s.events(s.employee.id)).toHaveLength(1);
    expect(await auditRows(h, 'qr_attendance.recorded')).toHaveLength(1);
  });

  it('refuses a new key for something already recorded, instead of recording it again', async () => {
    const { body } = await s.scan(await s.codeOf(s.employee));
    await s.verifyScan(body.scanId);
    expect((await s.confirm(body.scanId, 'CHECK_IN')).status).toBe(200);

    const res = await s.confirm(body.scanId, 'CHECK_IN', randomUUID());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SCAN_ALREADY_RECORDED');
    expect(await s.events(s.employee.id)).toHaveLength(1);
  });

  it('refuses a key that was used for something else', async () => {
    const { body } = await s.scan(await s.codeOf(s.employee));
    await s.verifyScan(body.scanId);
    const key = randomUUID();
    expect((await s.confirm(body.scanId, 'CHECK_IN', key)).status).toBe(200);

    const other = (await s.scan(await s.codeOf(s.colleague))).body.scanId as string;
    await s.verifyScan(other);
    const res = await s.confirm(other, 'CHECK_IN', key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await s.events(s.colleague.id)).toHaveLength(0);
  });

  it('does not remember a key whose attempt failed, so the same key can be tried again', async () => {
    const { body } = await s.scan(await s.codeOf(s.colleague));
    await s.verifyScan(body.scanId);
    const key = randomUUID();
    // The wrong action is refused, and the refusal does not use the key up.
    const bad = await s.confirm(body.scanId, 'CHECK_OUT', key);
    expect(bad.status).toBe(409);
    const good = await s.confirm(body.scanId, 'CHECK_IN', key);
    expect(good.status).toBe(200);
    expect(await s.events(s.colleague.id)).toHaveLength(1);
  });

  describe('when the server fails part-way', () => {
    /** The real database, except that one chosen statement fails the first time it is tried. */
    function flaky(failOn: RegExp): { db: Db; failures: () => number } {
      let failures = 0;
      const db: Db = {
        ...h.db,
        withTransaction: (fn) =>
          h.db.withTransaction((tx) =>
            fn({
              query: async (text: string, params?: readonly unknown[]) => {
                if (failures === 0 && failOn.test(text)) {
                  failures += 1;
                  throw new Error('connection terminated unexpectedly');
                }
                return (tx as Queryable).query(text, params);
              },
            }),
          ),
      };
      return { db, failures: () => failures };
    }

    const confirmVia = (app: Parameters<typeof request>[0], scanId: string, key: string) =>
      request(app)
        .post(`/api/qr-attendance/scans/${scanId}/confirm`)
        .set(bearer(s.tok.operator))
        .set('Idempotency-Key', key)
        .send({ action: 'CHECK_IN' });

    it.each([
      ['before the attendance is written', /private\.admin_qr_record/],
      [
        'after the attendance is written, before the answer is saved',
        /update public\.idempotency_keys/,
      ],
    ])(
      'records nothing when the connection drops %s, and succeeds on retry',
      async (_label, failOn) => {
        const { body } = await s.scan(await s.codeOf(s.employee));
        const verify = await s.verifyScan(body.scanId);
        const { db, failures } = flaky(failOn);
        const app = h.build({ db });
        const key = randomUUID();

        const broken = await confirmVia(app, body.scanId, key);
        expect(broken.status).toBe(500);
        expect(failures()).toBe(1);

        // All or nothing: no attendance, no half-finished scan, the proof still unspent, no key.
        expect(await s.record_(s.employee.id)).toBeUndefined();
        expect(await s.events(s.employee.id)).toHaveLength(0);
        expect(await s.scanRow(body.scanId)).toMatchObject({
          status: 'PENDING',
          confirmed_action: null,
        });
        const [ver] = await h.testDb.query<{ consumed_at: Date | null }>(
          'select consumed_at from public.attendance_verifications where id = $1',
          [verify.body.verificationId],
        );
        expect(ver?.consumed_at).toBeNull();
        const [stored] = await h.testDb.query<{ keys: string }>(
          'select count(*)::text as keys from public.idempotency_keys',
        );
        expect(stored?.keys).toBe('0');
        expect(await auditRows(h, 'qr_attendance.recorded')).toHaveLength(0);

        // The retry, with the same key, goes through exactly once.
        const retry = await confirmVia(app, body.scanId, key);
        expect(retry.status).toBe(200);
        expect(await s.events(s.employee.id)).toHaveLength(1);
        const again = await confirmVia(app, body.scanId, key);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(await s.events(s.employee.id)).toHaveLength(1);
      },
    );
  });
});

// =============================================================================================
describe('a copied code', () => {
  it('records nothing unless the person at the scanner is provably at the office', async () => {
    // Somebody photographs the code and shows it to an operator who is somewhere else.
    const copy = await s.codeOf(s.employee);
    const { body } = await s.scan(copy);
    const far = await s.verifyScan(body.scanId, { channel: 'WEB', gps: s.gpsMetresNorth(5000) });
    expect(far.status).toBe(422);
    expect((await s.confirm(body.scanId, 'CHECK_IN')).status).toBe(422);
    expect(await s.record_(s.employee.id)).toBeUndefined();
    expect(await s.events(s.employee.id)).toHaveLength(0);
  });

  it('gives an employee nothing to use it with: they cannot reach the scanner', async () => {
    const copy = await s.codeOf(s.colleague);
    const res = await s.post(
      '/api/qr-attendance/scan',
      { payload: copy, scanner: { kind: 'WEB' } },
      s.tok.employee,
    );
    expect(res.status).toBe(403);
    expect(await s.record_(s.colleague.id)).toBeUndefined();
  });

  it('is not accepted as the office code when an employee tries to check themselves in with it', async () => {
    const res = await s.post(
      '/api/attendance/verify',
      {
        purpose: 'CHECK_IN',
        channel: 'WEB',
        gps: s.gps(),
        qr: { payload: await s.codeOf(s.employee) },
      },
      s.tok.employee,
    );
    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons.map((r: { code: string }) => r.code)).toContain(
      'QR_INVALID',
    );
  });

  it('is dead the moment the code is regenerated', async () => {
    const copy = await s.codeOf(s.employee);
    expect((await s.scan(copy)).status).toBe(200);
    const regen = await s.post(
      `/api/admin/employee-qr/${s.employee.id}/regenerate`,
      {},
      s.tok.admin,
    );
    expect(regen.status).toBe(200);
    expect(regen.body.payload).not.toBe(copy);

    const old = await s.scan(copy);
    expect(old.status).toBe(422);
    expect(old.body.error.code).toBe('EMPLOYEE_QR_REVOKED');
    expect((await s.scan(regen.body.payload)).status).toBe(200);
  });

  it('works from any device for an operator who is at the office (the code alone proves nothing)', async () => {
    const payload = await s.codeOf(s.employee);
    for (const scanner of [
      { kind: 'WEB', label: 'Desktop webcam' },
      { kind: 'MOBILE', label: 'Android phone', camera: 'back camera' },
    ]) {
      const res = await s.scan(payload, s.tok.operator, scanner);
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('CHECK_IN');
    }
  });
});

// =============================================================================================
describe('recent scans', () => {
  it('lists the caller’s latest scans, newest first, refusals included', async () => {
    const good = await s.codeOf(s.employee);
    await s.scan(good);
    h.clock.set(new Date(T0 + 30_000));
    await s.scan('not a code at all');
    h.clock.set(new Date(T0 + 60_000));
    await s.scan(await s.codeOf(s.colleague));

    const res = await s.get('/api/qr-attendance/recent');
    expect(res.status).toBe(200);
    expect(
      res.body.items.map((i: { status: string; qrResult: string }) => [i.status, i.qrResult]),
    ).toEqual([
      ['PENDING', 'VALID'],
      ['REJECTED', 'MALFORMED'],
      ['PENDING', 'VALID'],
    ]);
    expect(res.body.items[0].employee.fullName).toBe(s.colleague.fullName);
    expect(res.body.items[1].employee).toBeNull();
    // An operator never sees network addresses.
    expect(res.body.items.every((i: { clientIp: string | null }) => i.clientIp === null)).toBe(
      true,
    );
  });

  it('shows a scan nobody confirmed as expired', async () => {
    await s.scan(await s.codeOf(s.employee));
    h.clock.set(new Date(T0 + 121_000));
    await s.refreshTokens();
    const res = await s.get('/api/qr-attendance/recent');
    expect(res.body.items[0].status).toBe('EXPIRED');
  });

  it('honours the limit', async () => {
    const payload = await s.codeOf(s.employee);
    for (let i = 0; i < 5; i += 1) await s.scan(payload);
    expect((await s.get('/api/qr-attendance/recent?limit=2')).body.items).toHaveLength(2);
  });
});

// =============================================================================================
describe('log hygiene', () => {
  it('never writes the code, the person’s name or their location to the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const env = h.envWith({ NODE_ENV: 'development', LOG_LEVEL: 'trace' });
    h.app = h.build({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' },
      logger: createLogger(env, sink),
    });

    const payload = await s.codeOf(s.employee);
    const secretLatitude = 10.123456;
    await s.record(payload, 'CHECK_IN');
    const res = await s.scan(payload);
    await s.verifyScan(res.body.scanId, {
      channel: 'WEB',
      gps: s.gps({ latitude: secretLatitude }),
    });

    const output = lines.join('\n');
    expect(output.length).toBeGreaterThan(0); // requests were logged...
    expect(output).not.toContain(payload); // ...but never what was scanned,
    expect(output).not.toContain(payload.slice(5));
    expect(output).not.toContain(String(secretLatitude)); // where the operator was,
    expect(output).not.toContain(s.employee.fullName); // or who the employee is
  });
});
