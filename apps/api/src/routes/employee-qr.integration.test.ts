import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allAuditJson,
  auditRows,
  bearer,
  createAccount,
  START_TIME,
  useApi,
} from '../testing/api-harness.js';
import { QrScene } from '../testing/qr-scene.js';

const h = useApi();
const s = new QrScene(h);
const T0 = Date.parse(START_TIME);

beforeEach(async () => {
  await s.setUp();
});

const sha256 = (text: string) => createHash('sha256').update(text).digest();

async function codeRows(employeeId: string) {
  return h.testDb.query<{
    id: string;
    status: string;
    token_hash: Uint8Array;
    token_nonce: Uint8Array;
    generated_by: string | null;
    revoked_by: string | null;
    revoke_reason: string | null;
    revoked_at: Date | null;
  }>(
    `select id, status, token_hash, token_nonce, generated_by, revoked_by, revoke_reason, revoked_at
     from public.employee_qr_codes where employee_id = $1
     order by generated_at, (status = 'ACTIVE'), id`,
    [employeeId],
  );
}

const newHire = {
  employeeCode: 'TG-900',
  fullName: 'Nina New-Hire',
  email: 'nina@teachgrow.test',
  joiningDate: '2026-11-02',
  designation: 'Teacher',
};

// =============================================================================================
describe('every employee gets one code', () => {
  it('is issued in the same step as the account is created', async () => {
    const res = await s.post('/api/admin/employees', newHire, s.tok.admin);
    expect(res.status).toBe(201);
    const id = res.body.employee.id as string;

    const rows = await codeRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ACTIVE', generated_by: s.admin.id, revoked_by: null });

    const issued = await auditRows(h, 'employee_qr.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      actor_id: s.admin.id,
      entity_id: id,
      metadata: { reason: 'first_code' },
    });

    // The administrator can fetch it straight away to print the ID card.
    const card = await s.get(`/api/admin/employee-qr/${id}`, s.tok.admin);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ status: 'ACTIVE', holder: { fullName: 'Nina New-Hire' } });
    expect(Buffer.from(rows[0]!.token_hash).equals(sha256(card.body.payload as string))).toBe(true);
  });

  it('is issued to operators and administrators too, but never to the lobby screen', async () => {
    const operator = await s.post(
      '/api/admin/employees',
      { ...newHire, role: 'attendance_operator' },
      s.tok.admin,
    );
    expect(operator.status).toBe(201);
    expect(await codeRows(operator.body.employee.id)).toHaveLength(1);

    const display = await s.post(
      '/api/admin/employees',
      {
        ...newHire,
        employeeCode: 'TG-901',
        email: 'screen@teachgrow.test',
        role: 'office_display',
      },
      s.tok.admin,
    );
    expect(display.status).toBe(201);
    expect(await codeRows(display.body.employee.id)).toHaveLength(0);
  });

  it('leaves no code behind when the account could not be created', async () => {
    const before = await h.testDb.query('select id from public.employee_qr_codes');
    const dup = await s.post(
      '/api/admin/employees',
      { ...newHire, email: s.employee.email },
      s.tok.admin,
    );
    expect(dup.status).toBe(409);
    expect(await h.testDb.query('select id from public.employee_qr_codes')).toHaveLength(
      before.length,
    );
  });

  it('gives accounts that predate the feature a code the first time they ask', async () => {
    expect(await codeRows(s.employee.id)).toHaveLength(0);
    const res = await s.get('/api/employee-qr/me', s.tok.employee);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', revokedAt: null });
    expect(await codeRows(s.employee.id)).toHaveLength(1);
    const lazy = await auditRows(h, 'employee_qr.issued');
    expect(lazy.at(-1)).toMatchObject({ actor_id: s.employee.id, entity_id: s.employee.id });

    // Asking again never makes a second one.
    const again = await s.get('/api/employee-qr/me', s.tok.employee);
    expect(again.body.payload).toBe(res.body.payload);
    expect(await codeRows(s.employee.id)).toHaveLength(1);
  });

  it('is different for every person and the same every time for one person', async () => {
    const a = await s.codeOf(s.employee);
    const b = await s.codeOf(s.colleague);
    expect(a).not.toBe(b);
    expect(await s.codeOf(s.employee)).toBe(a);
  });

  it('shows the holder’s details beside the code so it can be printed on a card', async () => {
    await h.testDb.query(
      `update public.profiles set designation = 'Maths Teacher', avatar_url = 'https://img.test/me.png'
       where id = $1`,
      [s.employee.id],
    );
    const res = await s.get('/api/employee-qr/me', s.tok.employee);
    expect(res.body.holder).toEqual({
      employeeCode: s.employee.code,
      fullName: s.employee.fullName,
      department: null,
      designation: 'Maths Teacher',
      avatarUrl: 'https://img.test/me.png',
    });
  });

  it('keeps the code to the person it belongs to', async () => {
    expect((await s.get('/api/employee-qr/me', s.tok.display)).status).toBe(403);
    expect((await request(h.app).get('/api/employee-qr/me')).status).toBe(401);
    // There is no way to ask for somebody else's code through the employee endpoint.
    const other = await request(h.app)
      .get(`/api/employee-qr/me?employeeId=${s.colleague.id}`)
      .set(bearer(s.tok.employee));
    expect(other.body.holder.employeeCode).toBe(s.employee.code);
  });
});

// =============================================================================================
describe('what is stored', () => {
  it('is a hash and a nonce, from which nothing usable can be read', async () => {
    const payload = await s.codeOf(s.employee);
    const [row] = await codeRows(s.employee.id);

    expect(Buffer.from(row!.token_hash).equals(sha256(payload))).toBe(true);
    expect(row!.token_nonce).toHaveLength(32);

    // Nothing in the stored row is the code, or any readable form of it.
    const [dump] = await h.testDb.query<{ text: string }>(
      'select row_to_json(c)::text as text from public.employee_qr_codes c where employee_id = $1',
      [s.employee.id],
    );
    const token = payload.slice('TGE1.'.length);
    expect(dump!.text).not.toContain(payload);
    expect(dump!.text).not.toContain(token);
    expect(dump!.text).not.toContain(Buffer.from(token, 'base64url').toString('hex'));
  });

  it('carries nothing about the person inside the code', async () => {
    const payload = await s.codeOf(s.employee);
    for (const secret of [
      s.employee.id,
      s.employee.id.replaceAll('-', ''),
      s.employee.code,
      s.employee.email,
      s.employee.fullName,
    ]) {
      expect(payload.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(payload).toMatch(/^TGE1\.[A-Za-z0-9_-]{43}$/);
  });

  it('can be shown again only by a server that holds the same secret', async () => {
    const payload = await s.codeOf(s.employee);
    // The same database seen by a server with a different secret: it cannot show the code...
    const other = h.build({
      env: { EMPLOYEE_QR_SECRET: 'a-different-secret-for-this-test-0123456789ab' },
    });
    const res = await request(other).get('/api/employee-qr/me').set(bearer(s.tok.employee));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/regenerated/);
    // ...yet the printed card still scans, because scanning needs only the stored hash.
    const scan = await request(other)
      .post('/api/qr-attendance/scan')
      .set(bearer(s.tok.operator))
      .send({ payload, scanner: { kind: 'WEB' } });
    expect(scan.status).toBe(200);
  });
});

// =============================================================================================
describe('administrators looking after codes', () => {
  describe('the list', () => {
    it('shows everybody except the lobby screen, with the state of their code', async () => {
      await s.codeOf(s.employee);
      const res = await s.get('/api/admin/employee-qr?pageSize=100', s.tok.admin);
      expect(res.status).toBe(200);
      const byCode = Object.fromEntries(
        res.body.items.map((i: { employee: { employeeCode: string } }) => [
          i.employee.employeeCode,
          i,
        ]),
      );
      expect(byCode[s.employee.code]).toMatchObject({
        employee: { fullName: s.employee.fullName, role: 'employee', isActive: true },
        qr: { status: 'ACTIVE', issued: 1 },
        lastScanAt: null,
      });
      expect(byCode[s.colleague.code].qr).toMatchObject({
        status: 'NONE',
        issued: 0,
        generatedAt: null,
      });
      expect(byCode[s.display.code]).toBeUndefined();
      expect(byCode[s.operator.code]).toBeDefined();
      expect(res.body.total).toBe(4); // admin, operator, employee, colleague
    });

    it('searches by name, employee ID or email, and filters by the state of the code', async () => {
      await s.codeOf(s.employee);
      await s.codeOf(s.colleague);
      await s.post(
        `/api/admin/employee-qr/${s.colleague.id}/revoke`,
        { reason: 'lost card' },
        s.tok.admin,
      );

      const names = (path: string) =>
        s
          .get(path, s.tok.admin)
          .then((r) =>
            r.body.items.map(
              (i: { employee: { employeeCode: string } }) => i.employee.employeeCode,
            ),
          );
      expect(
        await names(`/api/admin/employee-qr?search=${encodeURIComponent(s.employee.fullName)}`),
      ).toEqual([s.employee.code]);
      expect(
        await names(`/api/admin/employee-qr?search=${s.colleague.code.toLowerCase()}`),
      ).toEqual([s.colleague.code]);
      expect(
        await names(`/api/admin/employee-qr?search=${encodeURIComponent(s.employee.email)}`),
      ).toEqual([s.employee.code]);
      expect(await names('/api/admin/employee-qr?qrStatus=REVOKED')).toEqual([s.colleague.code]);
      expect(await names('/api/admin/employee-qr?qrStatus=ACTIVE')).toEqual([s.employee.code]);
      expect((await names('/api/admin/employee-qr?qrStatus=NONE')).sort()).toEqual(
        [s.operator.code, s.admin.code].sort(),
      );
      // A search for "%" means a percent sign, not "everything".
      expect(await names('/api/admin/employee-qr?search=%25')).toEqual([]);
    });

    it('pages through the results', async () => {
      const first = await s.get('/api/admin/employee-qr?pageSize=2&page=1', s.tok.admin);
      const second = await s.get('/api/admin/employee-qr?pageSize=2&page=2', s.tok.admin);
      expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 4 });
      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(2);
      const ids = [...first.body.items, ...second.body.items].map(
        (i: { employee: { id: string } }) => i.employee.id,
      );
      expect(new Set(ids).size).toBe(4);
    });

    it('rejects nonsense in the query', async () => {
      for (const q of ['qrStatus=MAYBE', 'page=0', 'pageSize=9999', 'departmentId=nope']) {
        expect((await s.get(`/api/admin/employee-qr?${q}`, s.tok.admin)).status, q).toBe(400);
      }
    });
  });

  describe('viewing one', () => {
    it('shows the code to download, and every code they have had', async () => {
      const first = await s.codeOf(s.employee);
      await s.post(`/api/admin/employee-qr/${s.employee.id}/regenerate`, {}, s.tok.admin);

      const res = await s.get(`/api/admin/employee-qr/${s.employee.id}`, s.tok.admin);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        employeeId: s.employee.id,
        status: 'ACTIVE',
        holder: { employeeCode: s.employee.code, fullName: s.employee.fullName },
      });
      expect(res.body.payload).toMatch(/^TGE1\./);
      expect(res.body.payload).not.toBe(first);
      expect(res.body.history).toHaveLength(2);
      expect(res.body.history.map((c: { status: string }) => c.status)).toEqual([
        'ACTIVE',
        'REVOKED',
      ]);
      expect(res.body.history[1]).toMatchObject({
        revokedBy: { id: s.admin.id },
        revokeReason: 'Regenerated by an administrator.',
      });
    });

    it('records that somebody looked, but never what they saw', async () => {
      await s.get(`/api/admin/employee-qr/${s.employee.id}`, s.tok.admin);
      const views = await auditRows(h, 'employee_qr.viewed');
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ actor_id: s.admin.id, entity_id: s.employee.id });
      const payload = (await s.get(`/api/admin/employee-qr/${s.employee.id}`, s.tok.admin)).body
        .payload as string;
      expect(await allAuditJson(h)).not.toContain(payload.slice(5));
    });

    it('answers for somebody who does not exist or has no card', async () => {
      expect((await s.get(`/api/admin/employee-qr/${randomUUID()}`, s.tok.admin)).status).toBe(404);
      expect((await s.get(`/api/admin/employee-qr/${s.display.id}`, s.tok.admin)).status).toBe(400);
      expect((await s.get('/api/admin/employee-qr/not-a-uuid', s.tok.admin)).status).toBe(400);
    });
  });

  describe('regenerating', () => {
    it('retires the old code at once and issues a new one', async () => {
      const old = await s.codeOf(s.employee);
      const res = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/regenerate`,
        { reason: 'Card photographed on social media' },
        s.tok.admin,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.payload).not.toBe(old);
      expect(res.body.payload).toMatch(/^TGE1\./);

      const rows = await codeRows(s.employee.id);
      expect(rows.map((r) => r.status)).toEqual(['REVOKED', 'ACTIVE']);
      expect(rows[0]).toMatchObject({
        revoked_by: s.admin.id,
        revoke_reason: 'Card photographed on social media',
      });
      expect(rows[1]).toMatchObject({ generated_by: s.admin.id });
      expect(Buffer.from(rows[1]!.token_hash).equals(sha256(res.body.payload))).toBe(true);

      // The employee sees the new one; the old one no longer scans.
      expect((await s.get('/api/employee-qr/me', s.tok.employee)).body.payload).toBe(
        res.body.payload,
      );
      expect((await s.scan(old)).body.error.code).toBe('EMPLOYEE_QR_REVOKED');
      expect((await s.scan(res.body.payload)).status).toBe(200);
    });

    it('is audited, naming the codes but never their contents', async () => {
      const old = await s.codeOf(s.employee);
      const before = await codeRows(s.employee.id);
      const res = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/regenerate`,
        {},
        s.tok.admin,
      );
      const [entry] = await auditRows(h, 'employee_qr.regenerated');
      expect(entry).toMatchObject({
        actor_id: s.admin.id,
        actor_role: 'admin',
        entity_id: s.employee.id,
        before_data: { code_id: before[0]!.id, status: 'ACTIVE' },
        after_data: { status: 'ACTIVE' },
      });
      const everything = await allAuditJson(h);
      expect(everything).not.toContain(old.slice(5));
      expect(everything).not.toContain((res.body.payload as string).slice(5));
    });

    it('works for somebody whose code was revoked, and for somebody with none', async () => {
      await s.codeOf(s.employee);
      await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'lost' },
        s.tok.admin,
      );
      const back = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/regenerate`,
        {},
        s.tok.admin,
      );
      expect(back.body.status).toBe('ACTIVE');

      const fresh = await s.post(
        `/api/admin/employee-qr/${s.colleague.id}/regenerate`,
        {},
        s.tok.admin,
      );
      expect(fresh.status).toBe(200);
      expect(await codeRows(s.colleague.id)).toHaveLength(1);
    });

    it('keeps exactly one live code however many times it is done', async () => {
      for (let i = 0; i < 4; i += 1) {
        await s.post(`/api/admin/employee-qr/${s.employee.id}/regenerate`, {}, s.tok.admin);
      }
      const rows = await codeRows(s.employee.id);
      expect(rows).toHaveLength(4);
      expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
      expect(new Set(rows.map((r) => Buffer.from(r.token_hash).toString('hex'))).size).toBe(4);
    });

    it('refuses the lobby screen, an unknown person and an over-long reason', async () => {
      expect(
        (await s.post(`/api/admin/employee-qr/${s.display.id}/regenerate`, {}, s.tok.admin)).status,
      ).toBe(400);
      expect(
        (await s.post(`/api/admin/employee-qr/${randomUUID()}/regenerate`, {}, s.tok.admin)).status,
      ).toBe(404);
      expect(
        (
          await s.post(
            `/api/admin/employee-qr/${s.employee.id}/regenerate`,
            { reason: 'x'.repeat(501) },
            s.tok.admin,
          )
        ).status,
      ).toBe(400);
    });
  });

  describe('revoking', () => {
    it('withdraws the live code and leaves the person without one until it is regenerated', async () => {
      const payload = await s.codeOf(s.employee);
      const res = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'ID card reported lost' },
        s.tok.admin,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'REVOKED', payload: null });
      expect(res.body.revokedAt).toBe(new Date(T0).toISOString());

      const rows = await codeRows(s.employee.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'REVOKED',
        revoked_by: s.admin.id,
        revoke_reason: 'ID card reported lost',
      });
      expect((await s.scan(payload)).body.error.code).toBe('EMPLOYEE_QR_REVOKED');

      // The employee is told, and no one quietly gives them a replacement.
      const mine = await s.get('/api/employee-qr/me', s.tok.employee);
      expect(mine.body).toMatchObject({ status: 'REVOKED', payload: null });
      expect(await codeRows(s.employee.id)).toHaveLength(1);
      expect((await auditRows(h, 'employee_qr.revoked'))[0]).toMatchObject({
        actor_id: s.admin.id,
        entity_id: s.employee.id,
        metadata: { reason: 'ID card reported lost' },
      });
    });

    it('needs a reason, and has nothing to do twice', async () => {
      await s.codeOf(s.employee);
      for (const body of [{}, { reason: '' }, { reason: 'ab' }, { reason: 'x'.repeat(501) }]) {
        expect(
          (await s.post(`/api/admin/employee-qr/${s.employee.id}/revoke`, body, s.tok.admin))
            .status,
        ).toBe(400);
      }
      expect(
        (
          await s.post(
            `/api/admin/employee-qr/${s.employee.id}/revoke`,
            { reason: 'lost' },
            s.tok.admin,
          )
        ).status,
      ).toBe(200);
      const again = await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'lost' },
        s.tok.admin,
      );
      expect(again.status).toBe(409);
    });
  });

  describe('catching up', () => {
    it('gives a code to everybody who has never had one, once', async () => {
      await s.codeOf(s.employee); // already has one
      const res = await s.post('/api/admin/employee-qr/backfill', {}, s.tok.admin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ issued: 3 }); // admin, operator, colleague - not the lobby screen

      for (const who of [s.admin, s.operator, s.colleague, s.employee]) {
        expect(await codeRows(who.id)).toHaveLength(1);
      }
      expect(await codeRows(s.display.id)).toHaveLength(0);
      expect((await s.post('/api/admin/employee-qr/backfill', {}, s.tok.admin)).body).toEqual({
        issued: 0,
      });
      expect((await auditRows(h, 'employee_qr.backfilled')).at(-1)?.metadata).toEqual({
        issued: 0,
      });
    });

    it('does not replace a code that was revoked', async () => {
      await s.codeOf(s.employee);
      await s.post(
        `/api/admin/employee-qr/${s.employee.id}/revoke`,
        { reason: 'lost' },
        s.tok.admin,
      );
      await s.post('/api/admin/employee-qr/backfill', {}, s.tok.admin);
      const rows = await codeRows(s.employee.id);
      expect(rows.map((r) => r.status)).toEqual(['REVOKED']);
    });
  });

  describe('who may', () => {
    // `:id` stands for somebody real; it is filled in when the test runs.
    const calls: Array<[string, string, object | undefined]> = [
      ['get', '/api/admin/employee-qr', undefined],
      ['get', '/api/admin/employee-qr/:id', undefined],
      ['post', '/api/admin/employee-qr/:id/regenerate', {}],
      ['post', '/api/admin/employee-qr/:id/revoke', { reason: 'lost' }],
      ['post', '/api/admin/employee-qr/backfill', {}],
      ['get', '/api/admin/qr-scans', undefined],
    ];

    it.each(calls)('%s %s is for administrators only', async (method, template, body) => {
      const path = template.replace(':id', s.employee.id);
      for (const who of ['employee', 'operator', 'display'] as const) {
        const r = request(h.app)[method as 'get'](path).set(bearer(s.tok[who]));
        const res = body ? await r.send(body) : await r;
        expect(res.status, `${who} ${method} ${path}`).toBe(403);
      }
      const anonymous = request(h.app)[method as 'get'](path);
      expect((body ? await anonymous.send(body) : await anonymous).status).toBe(401);
    });

    it('lets an operator do nothing here, even though they can scan', async () => {
      expect((await s.scan(await s.codeOf(s.employee), s.tok.operator)).status).toBe(200);
      expect((await s.get(`/api/admin/employee-qr/${s.employee.id}`, s.tok.operator)).status).toBe(
        403,
      );
    });

    it('stops at once for an administrator who has been deactivated', async () => {
      // (the database will not deactivate the only administrator, so there has to be another)
      await createAccount(h, { role: 'admin', attendanceRequired: false });
      await h.testDb.query(
        'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
        [s.admin.id],
      );
      const res = await s.get('/api/admin/employee-qr', s.tok.admin);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });
  });
});

// =============================================================================================
describe('scan history', () => {
  let recordedScanId: string;
  let refusedScanId: string;
  let expiredScanId: string;

  beforeEach(async () => {
    const mine = await s.codeOf(s.employee);
    ({
      scan: { scanId: recordedScanId },
    } = await s.record(mine, 'CHECK_IN'));

    h.clock.set(new Date(T0 + 60_000));
    refusedScanId = (await s.scan('definitely not a code')).body.error.details.scanId as string;
    h.clock.set(new Date(T0 + 120_000));
    expiredScanId = (await s.scan(await s.codeOf(s.colleague), s.tok.admin)).body.scanId as string;
    h.clock.set(new Date(T0 + 300_000)); // well past the colleague's two minutes
  });

  const history = async (query = '') => {
    const res = await s.get(`/api/admin/qr-scans${query ? `?${query}` : ''}`, s.tok.admin);
    expect(res.status).toBe(200);
    return res.body as {
      items: Array<{
        id: string;
        status: string;
        qrResult: string;
        detectedAction: string;
        confirmedAction: string | null;
        officeVerification: string | null;
        attendanceEventId: string | null;
        employee: { id: string } | null;
        scannedBy: { id: string; role: string; fullName: string };
        scanner: { label?: string };
        clientIp: string | null;
      }>;
      total: number;
    };
  };

  it('lists every scan, newest first, with who recorded it and what became of it', async () => {
    const res = await history();
    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.id)).toEqual([expiredScanId, refusedScanId, recordedScanId]);

    const [expired, refused, recorded] = res.items;
    expect(recorded).toMatchObject({
      status: 'RECORDED',
      qrResult: 'VALID',
      detectedAction: 'CHECK_IN',
      confirmedAction: 'CHECK_IN',
      officeVerification: 'VERIFIED',
      employee: { id: s.employee.id },
      scannedBy: { id: s.operator.id, role: 'attendance_operator', fullName: s.operator.fullName },
      scanner: { label: 'Front desk' },
      clientIp: '127.0.0.1',
    });
    expect(recorded!.attendanceEventId).toBe((await s.events(s.employee.id))[0]!.id);
    expect(refused).toMatchObject({
      status: 'REJECTED',
      qrResult: 'MALFORMED',
      employee: null,
      confirmedAction: null,
    });
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      employee: { id: s.colleague.id },
      scannedBy: { id: s.admin.id, role: 'admin' },
      attendanceEventId: null,
    });
  });

  it('filters by employee, by who scanned, and by outcome', async () => {
    const ids = async (q: string) => (await history(q)).items.map((i) => i.id);
    expect(await ids(`employeeId=${s.employee.id}`)).toEqual([recordedScanId]);
    expect(await ids(`employeeId=${s.colleague.id}`)).toEqual([expiredScanId]);
    expect(await ids(`scannedBy=${s.admin.id}`)).toEqual([expiredScanId]);
    expect(await ids(`scannedBy=${s.operator.id}`)).toEqual([refusedScanId, recordedScanId]);
    expect(await ids('status=RECORDED')).toEqual([recordedScanId]);
    expect(await ids('status=REJECTED')).toEqual([refusedScanId]);
    expect(await ids('status=EXPIRED')).toEqual([expiredScanId]);
    expect(await ids('status=PENDING')).toEqual([]);
    expect(await ids(`employeeId=${s.employee.id}&status=EXPIRED`)).toEqual([]);
  });

  it('filters by date, as calendar days at the office', async () => {
    const ids = async (q: string) => (await history(q)).items.map((i) => i.id);
    const all = [expiredScanId, refusedScanId, recordedScanId];
    expect(await ids('from=2026-11-02&to=2026-11-02')).toEqual(all);
    expect(await ids('from=2026-11-03')).toEqual([]);
    expect(await ids('to=2026-11-01')).toEqual([]);
    expect(await ids('from=2026-11-01&to=2026-11-30')).toEqual(all);

    // 22:00 UTC on the 2nd is already 03:30 on the 3rd in Kolkata: the office's day decides.
    h.clock.set(new Date('2026-11-02T22:00:00Z'));
    await s.refreshTokens();
    const nightScan = (await s.scan(await s.codeOf(s.colleague))).body.scanId as string;
    expect(await ids('from=2026-11-03&to=2026-11-03')).toEqual([nightScan]);
    expect(await ids('from=2026-11-02&to=2026-11-02')).toEqual(all);
  });

  it('pages through the results', async () => {
    const first = await history('pageSize=2&page=1');
    const second = await history('pageSize=2&page=2');
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
  });

  it('rejects nonsense in the query', async () => {
    for (const q of [
      'from=yesterday',
      'from=2026-11-05&to=2026-11-01',
      'status=LOST',
      'employeeId=nope',
      'page=0',
    ]) {
      expect((await s.get(`/api/admin/qr-scans?${q}`, s.tok.admin)).status, q).toBe(400);
    }
  });

  it('shows the scan history of an employee to nobody but administrators', async () => {
    expect((await s.get('/api/admin/qr-scans', s.tok.employee)).status).toBe(403);
    expect((await s.get('/api/admin/qr-scans', s.tok.operator)).status).toBe(403);
  });

  it('feeds the last-scan column of the code list', async () => {
    const list = await s.get(`/api/admin/employee-qr?search=${s.employee.code}`, s.tok.admin);
    expect(new Date(list.body.items[0].lastScanAt).getTime()).toBe(T0);
  });
});
