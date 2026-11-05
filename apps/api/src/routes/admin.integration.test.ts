import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { passwordSchema } from '@teachgrow/shared';
import type { Db } from '../db/pool.js';
import { seedUser } from '../testing/fixtures.js';
import {
  type Account,
  accessTokenFor,
  allAuditJson,
  auditRows,
  bearer,
  createAccount,
  mobileLogin,
  sessionCount,
  useApi,
} from '../testing/api-harness.js';

const h = useApi();

let admin: Account;
let token: string;

beforeEach(async () => {
  admin = await createAccount(h, { role: 'admin', fullName: 'Hema Admin' });
  token = await accessTokenFor(h, admin);
});

const get = (path: string, t = token) => request(h.app).get(path).set(bearer(t));
const post = (path: string, body?: object, t = token) =>
  request(h.app).post(path).set(bearer(t)).send(body);
const put = (path: string, body: object, t = token) =>
  request(h.app).put(path).set(bearer(t)).send(body);

const newEmployee = {
  employeeCode: 'TG-100',
  fullName: 'Ravi Kumar',
  email: 'ravi@teachgrow.test',
  joiningDate: '2026-11-02',
  designation: 'Teacher',
};

describe('who may use the admin API', () => {
  const someId = randomUUID();
  const routes: Array<[string, string, object | undefined]> = [
    ['get', '/api/admin/employees', undefined],
    ['post', '/api/admin/employees', newEmployee],
    ['get', `/api/admin/employees/${someId}`, undefined],
    ['put', `/api/admin/employees/${someId}`, { fullName: 'X' }],
    ['post', `/api/admin/employees/${someId}/reset-password`, undefined],
    ['get', '/api/admin/departments', undefined],
    ['post', '/api/admin/departments', { name: 'Ops' }],
  ];

  const call = (method: string, path: string, body: object | undefined, t?: string) => {
    let r = request(h.app)[method as 'get'](path);
    if (t) r = r.set(bearer(t));
    return body ? r.send(body) : r;
  };

  it.each(routes)('%s %s needs a signed-in user', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(401);
  });

  it.each(routes)('%s %s is forbidden to an ordinary employee', async (method, path, body) => {
    const employee = await createAccount(h);
    const res = await call(method, path, body, await accessTokenFor(h, employee));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('is forbidden to the office display account', async () => {
    const kiosk = await createAccount(h, { role: 'office_display' });
    const res = await get('/api/admin/employees', await accessTokenFor(h, kiosk));
    expect(res.status).toBe(403);
  });

  it('is forbidden to a deactivated administrator, even with a still-valid token', async () => {
    const other = await createAccount(h, { role: 'admin' });
    const otherToken = await accessTokenFor(h, other);
    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [other.id],
    );
    const res = await get('/api/admin/employees', otherToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('has no side effects when an employee tries to create an account, and audits the attempt', async () => {
    const employee = await createAccount(h);
    const users = h.fake.users.size;
    const res = await post('/api/admin/employees', newEmployee, await accessTokenFor(h, employee));
    expect(res.status).toBe(403);
    expect(h.fake.users.size).toBe(users);

    const [denied] = await auditRows(h, 'authz.denied');
    expect(denied).toMatchObject({ actor_id: employee.id, actor_role: 'employee' });
    expect(denied!.metadata).toMatchObject({
      method: 'POST',
      path: '/api/admin/employees',
      required_roles: ['admin'],
    });
  });

  it('is rate limited per signed-in user, not per shared office IP', async () => {
    h.app = h.build({ env: { USER_RATE_LIMIT_PER_MIN: '10' } });
    const t = await accessTokenFor(h, admin);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await get('/api/admin/departments', t)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);

    // A different person on the same IP is unaffected.
    const colleague = await createAccount(h, { role: 'admin' });
    expect((await get('/api/admin/departments', await accessTokenFor(h, colleague))).status).toBe(
      200,
    );
  });
});

describe('POST /api/admin/employees', () => {
  it('creates the employee with a one-time temporary password and forces a change at first sign-in', async () => {
    const res = await post('/api/admin/employees', newEmployee);
    expect(res.status).toBe(201);

    const { employee, temporaryPassword } = res.body;
    expect(res.headers.location).toBe(`/api/admin/employees/${employee.id}`);
    expect(employee).toMatchObject({
      employeeCode: 'TG-100',
      fullName: 'Ravi Kumar',
      email: 'ravi@teachgrow.test',
      designation: 'Teacher',
      role: 'employee',
      attendanceRequired: true,
      isActive: true,
      mustChangePassword: true,
      department: null,
      deactivatedAt: null,
    });
    expect(passwordSchema.safeParse(temporaryPassword).success).toBe(true);

    // The provider holds exactly that password; the database records who created the account.
    expect(h.fake.users.get(employee.id)?.password).toBe(temporaryPassword);
    const [row] = await h.testDb.query<{ created_by: string }>(
      'select created_by from public.profiles where id = $1',
      [employee.id],
    );
    expect(row?.created_by).toBe(admin.id);

    // The audit trail records the creation but never the password.
    const [entry] = await auditRows(h, 'employee.create');
    expect(entry).toMatchObject({
      actor_id: admin.id,
      actor_role: 'admin',
      entity_id: employee.id,
    });
    expect(entry!.after_data).toMatchObject({ employeeCode: 'TG-100', role: 'employee' });
    expect(await allAuditJson(h)).not.toContain(temporaryPassword);
  });

  it('lets the new employee sign in, but only to change the temporary password', async () => {
    const created = (await post('/api/admin/employees', newEmployee)).body;
    const login = await mobileLogin(h, {
      email: 'ravi@teachgrow.test',
      password: created.temporaryPassword,
    });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);

    const blocked = await get('/api/auth/me', login.body.accessToken);
    expect(blocked.status).toBe(200); // may see themselves
    const change = await post(
      '/api/auth/change-password',
      { currentPassword: created.temporaryPassword, newPassword: 'My-Own-Passw0rd1' },
      login.body.accessToken,
    );
    expect(change.status).toBe(204);
    expect(
      (await mobileLogin(h, { email: 'ravi@teachgrow.test', password: 'My-Own-Passw0rd1' })).status,
    ).toBe(200);
    expect(
      (await mobileLogin(h, { email: 'ravi@teachgrow.test', password: created.temporaryPassword }))
        .status,
    ).toBe(401);
  });

  it('uses an administrator-chosen password instead, and does not echo it back', async () => {
    const res = await post('/api/admin/employees', {
      ...newEmployee,
      initialPassword: 'Chosen-Passw0rd1',
    });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Chosen-Passw0rd1');
    expect(res.body.employee.mustChangePassword).toBe(true);
    expect(
      (await mobileLogin(h, { email: newEmployee.email, password: 'Chosen-Passw0rd1' })).status,
    ).toBe(200);
    expect(await allAuditJson(h)).not.toContain('Chosen-Passw0rd1');
  });

  it('can skip the forced password change when asked', async () => {
    const res = await post('/api/admin/employees', {
      ...newEmployee,
      initialPassword: 'Chosen-Passw0rd1',
      requirePasswordChange: false,
    });
    expect(res.body.employee.mustChangePassword).toBe(false);
  });

  it.each([
    ['no employee id', { employeeCode: undefined }],
    ['an invalid email', { email: 'nope' }],
    ['an unknown role', { role: 'superuser' }],
    ['a weak initial password', { initialPassword: 'password' }],
    ['a bad joining date', { joiningDate: '11/02/2026' }],
    ['a malformed department id', { departmentId: 'abc' }],
    ['mass-assignment of isActive', { isActive: false }],
    ['mass-assignment of an id', { id: randomUUID() }],
    ['mass-assignment of the forced-change flag', { mustChangePassword: false }],
  ])('rejects %s without creating anything', async (_label, patch) => {
    const users = h.fake.users.size;
    const res = await post('/api/admin/employees', { ...newEmployee, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(h.fake.users.size).toBe(users);
    expect(await auditRows(h, 'employee.create')).toHaveLength(0);
  });

  describe('duplicates', () => {
    it('refuses a repeated email (any letter case) and a repeated employee id', async () => {
      await post('/api/admin/employees', newEmployee);

      const sameEmail = await post('/api/admin/employees', {
        ...newEmployee,
        employeeCode: 'TG-101',
        email: 'RAVI@TeachGrow.test',
      });
      expect(sameEmail.status).toBe(409);
      expect(sameEmail.body.error.details[0].path).toBe('email');

      const sameCode = await post('/api/admin/employees', {
        ...newEmployee,
        employeeCode: 'tg-100',
        email: 'other@teachgrow.test',
      });
      expect(sameCode.status).toBe(409);
      expect(sameCode.body.error.details[0].path).toBe('employeeCode');
    });

    it('refuses an email the auth provider already knows, leaving no profile behind', async () => {
      await h.fake.addUser('taken@teachgrow.test', 'Whatever-Passw0rd1');
      const res = await post('/api/admin/employees', {
        ...newEmployee,
        email: 'taken@teachgrow.test',
      });
      expect(res.status).toBe(409);
      const rows = await h.testDb.query(
        "select 1 from public.profiles where email = 'taken@teachgrow.test'",
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('departments and roles', () => {
    it('attaches an existing department', async () => {
      const dept = (await post('/api/admin/departments', { name: 'Mathematics' })).body.department;
      const res = await post('/api/admin/employees', { ...newEmployee, departmentId: dept.id });
      expect(res.status).toBe(201);
      expect(res.body.employee.department).toEqual({ id: dept.id, name: 'Mathematics' });
    });

    it('refuses a department that does not exist or has been retired', async () => {
      const missing = await post('/api/admin/employees', {
        ...newEmployee,
        departmentId: randomUUID(),
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error.details[0].path).toBe('departmentId');

      const dept = (await post('/api/admin/departments', { name: 'Old Dept' })).body.department;
      await h.testDb.query('update public.departments set is_active = false where id = $1', [
        dept.id,
      ]);
      const retired = await post('/api/admin/employees', { ...newEmployee, departmentId: dept.id });
      expect(retired.status).toBe(400);
    });

    it('defaults attendance tracking by role: employees yes; administrators and the display no', async () => {
      const adminRes = await post('/api/admin/employees', { ...newEmployee, role: 'admin' });
      expect(adminRes.body.employee).toMatchObject({ role: 'admin', attendanceRequired: false });

      const kiosk = await post('/api/admin/employees', {
        ...newEmployee,
        employeeCode: 'LOBBY-1',
        email: 'lobby@teachgrow.test',
        role: 'office_display',
      });
      expect(kiosk.body.employee).toMatchObject({
        role: 'office_display',
        attendanceRequired: false,
        mustChangePassword: false,
      });

      const hrWhoAttends = await post('/api/admin/employees', {
        ...newEmployee,
        employeeCode: 'TG-102',
        email: 'hr@teachgrow.test',
        role: 'admin',
        attendanceRequired: true,
      });
      expect(hrWhoAttends.body.employee.attendanceRequired).toBe(true);
    });

    it('never lets the office display account be tracked for attendance', async () => {
      const res = await post('/api/admin/employees', {
        ...newEmployee,
        role: 'office_display',
        attendanceRequired: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('attendanceRequired');
    });
  });

  describe('failure handling', () => {
    const failingDb = (db: Db): Db => ({
      ...db,
      withTransaction: async () => {
        throw new Error('simulated database failure');
      },
    });

    it('removes the auth user it created if saving the profile fails', async () => {
      h.app = h.build({ db: failingDb(h.db) });
      const adminToken = await accessTokenFor(h, admin);
      const before = h.fake.users.size;

      const res = await post('/api/admin/employees', newEmployee, adminToken);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
      expect(JSON.stringify(res.body)).not.toContain('simulated');

      expect(h.fake.users.size).toBe(before);
      expect([...h.fake.users.values()].some((u) => u.email === newEmployee.email)).toBe(false);
      expect(
        h.fake.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/admin/users/')),
      ).toBe(true);
    });

    it('turns a lost uniqueness race into a clean 409 and still cleans up', async () => {
      const racing = await seedUser(h.testDb);
      await h.testDb.query('update public.profiles set email = $2 where id = $1', [
        racing.id,
        'ravi@teachgrow.test',
      ]);
      // Simulate the other request winning between our availability check and our insert.
      const blindDb: Db = {
        ...h.db,
        query: async (text, params) =>
          text.includes('email_taken')
            ? {
                rows: [{ email_taken: false, code_taken: false, department_ok: true }] as never[],
                rowCount: 1,
              }
            : h.db.query(text, params),
      };
      h.app = h.build({ db: blindDb });
      const adminToken = await accessTokenFor(h, admin);
      const before = h.fake.users.size;

      const res = await post('/api/admin/employees', newEmployee, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error.details[0].path).toBe('email');
      expect(h.fake.users.size).toBe(before);
    });

    it('answers 503 when the auth provider is down', async () => {
      h.fake.setOutage({ status: 503 });
      const res = await post('/api/admin/employees', newEmployee);
      expect(res.status).toBe(503);
      const rows = await h.testDb.query('select 1 from public.profiles where email = $1', [
        newEmployee.email,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe('GET /api/admin/employees', () => {
  beforeEach(async () => {
    const math = (await post('/api/admin/departments', { name: 'Mathematics' })).body.department;
    const art = (await post('/api/admin/departments', { name: 'Art' })).body.department;
    await createAccount(h, {
      fullName: 'zed Zimmer',
      email: 'zed@teachgrow.test',
      departmentId: math.id,
    });
    await createAccount(h, {
      fullName: 'Amy Adams',
      email: 'amy@teachgrow.test',
      departmentId: art.id,
    });
    await createAccount(h, {
      fullName: 'bob Brown',
      email: 'bob@teachgrow.test',
      departmentId: math.id,
    });
    await createAccount(h, {
      fullName: 'Gone Person',
      email: 'gone@teachgrow.test',
      active: false,
    });
  });

  it('lists everyone sorted by name regardless of letter case, with paging metadata', async () => {
    const res = await get('/api/admin/employees');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 5 });
    expect(res.body.items.map((e: { fullName: string }) => e.fullName)).toEqual([
      'Amy Adams',
      'bob Brown',
      'Gone Person',
      'Hema Admin',
      'zed Zimmer',
    ]);
  });

  it('pages through results', async () => {
    const first = await get('/api/admin/employees?pageSize=2&page=1');
    const second = await get('/api/admin/employees?pageSize=2&page=2');
    const beyond = await get('/api/admin/employees?pageSize=2&page=9');
    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(2);
    expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
    expect(first.body.total).toBe(5);
    expect(beyond.body).toMatchObject({ items: [], total: 5 });
  });

  it('searches name, email and employee id without regard to case', async () => {
    const names = async (q: string) =>
      (await get(`/api/admin/employees?search=${encodeURIComponent(q)}`)).body.items.map(
        (e: { fullName: string }) => e.fullName,
      );
    expect(await names('AMY')).toEqual(['Amy Adams']);
    expect(await names('brown')).toEqual(['bob Brown']);
    expect(await names('zed@teachgrow')).toEqual(['zed Zimmer']);
    const code = (await get('/api/admin/employees?pageSize=1&search=Hema')).body.items[0]
      .employeeCode;
    expect(await names(code.toLowerCase())).toEqual(['Hema Admin']);
    expect(await names('nobody-has-this')).toEqual([]);
  });

  it('treats search characters literally, so "%" and "_" are not wildcards', async () => {
    expect((await get('/api/admin/employees?search=%25')).body.items).toEqual([]);
    expect((await get('/api/admin/employees?search=_')).body.items).toEqual([]);
    expect(
      (await get("/api/admin/employees?search=a'%3B%20drop%20table%20profiles%3B--")).body.items,
    ).toEqual([]);
    expect((await get('/api/admin/employees')).body.total).toBe(5); // and nothing was dropped
  });

  it('filters by status, role and department', async () => {
    expect(
      (await get('/api/admin/employees?status=inactive')).body.items.map(
        (e: { fullName: string }) => e.fullName,
      ),
    ).toEqual(['Gone Person']);
    expect((await get('/api/admin/employees?status=active')).body.total).toBe(4);
    expect((await get('/api/admin/employees?role=admin')).body.total).toBe(1);
    const dept = (await get('/api/admin/departments')).body.items.find(
      (d: { name: string }) => d.name === 'Mathematics',
    );
    const inDept = await get(`/api/admin/employees?departmentId=${dept.id}`);
    expect(inDept.body.items.map((e: { fullName: string }) => e.fullName)).toEqual([
      'bob Brown',
      'zed Zimmer',
    ]);
    expect(inDept.body.items[0].department).toEqual({ id: dept.id, name: 'Mathematics' });
  });

  it('combines filters with search', async () => {
    // "person" matches the inactive "Gone Person" by name and the administrator by email.
    const names = async (query: string) =>
      (await get(`/api/admin/employees?${query}`)).body.items.map(
        (e: { fullName: string }) => e.fullName,
      );
    expect(await names('search=person')).toEqual(['Gone Person', 'Hema Admin']);
    expect(await names('status=active&search=person')).toEqual(['Hema Admin']);
    expect(await names('status=inactive&search=person')).toEqual(['Gone Person']);
    expect(await names('role=admin&search=person')).toEqual(['Hema Admin']);
  });

  it.each([
    ['page size zero', 'pageSize=0'],
    ['a huge page size', 'pageSize=100000'],
    ['page zero', 'page=0'],
    ['an unknown status', 'status=deleted'],
    ['an unknown role', 'role=root'],
    ['a malformed department', 'departmentId=1'],
  ])('rejects %s', async (_label, query) => {
    expect((await get(`/api/admin/employees?${query}`)).status).toBe(400);
  });

  it('returns only the documented fields: no credentials or internals', async () => {
    const item = (await get('/api/admin/employees?pageSize=1')).body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'attendanceRequired',
        'avatarUrl',
        'createdAt',
        'deactivatedAt',
        'department',
        'designation',
        'email',
        'employeeCode',
        'fullName',
        'id',
        'isActive',
        'joiningDate',
        'mustChangePassword',
        'phone',
        'role',
      ].sort(),
    );
  });
});

describe('GET /api/admin/employees/:id', () => {
  it('returns one employee, 404 for an unknown id, 400 for a malformed one', async () => {
    const person = await createAccount(h, { fullName: 'Asha Rao' });
    const found = await get(`/api/admin/employees/${person.id}`);
    expect(found.status).toBe(200);
    expect(found.body.employee).toMatchObject({ id: person.id, fullName: 'Asha Rao' });

    expect((await get(`/api/admin/employees/${randomUUID()}`)).status).toBe(404);
    expect((await get('/api/admin/employees/not-a-uuid')).status).toBe(400);
  });
});

describe('PUT /api/admin/employees/:id', () => {
  it('changes details and audits exactly what changed (before and after)', async () => {
    const person = await createAccount(h, { fullName: 'Old Name' });
    const dept = (await post('/api/admin/departments', { name: 'Science' })).body.department;

    const res = await put(`/api/admin/employees/${person.id}`, {
      fullName: 'New Name',
      designation: 'Lead Teacher',
      departmentId: dept.id,
      phone: '+91 98765 43210',
    });
    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({
      fullName: 'New Name',
      designation: 'Lead Teacher',
      department: { id: dept.id, name: 'Science' },
      phone: '+91 98765 43210',
    });
    expect(res.body.warnings).toBeUndefined();

    const [entry] = await auditRows(h, 'employee.update');
    expect(entry).toMatchObject({ actor_id: admin.id, entity_id: person.id });
    expect(entry!.before_data).toEqual({
      fullName: 'Old Name',
      designation: null,
      departmentId: null,
      phone: null,
    });
    expect(entry!.after_data).toMatchObject({ fullName: 'New Name', designation: 'Lead Teacher' });
  });

  it('can clear optional fields with null', async () => {
    const person = await createAccount(h);
    await put(`/api/admin/employees/${person.id}`, {
      designation: 'Teacher',
      phone: '+91 99999 99999',
    });
    const res = await put(`/api/admin/employees/${person.id}`, { designation: null, phone: null });
    expect(res.body.employee).toMatchObject({ designation: null, phone: null });
  });

  it('does nothing, and writes no audit entry, when nothing actually changes', async () => {
    const person = await createAccount(h, { fullName: 'Same Name' });
    const res = await put(`/api/admin/employees/${person.id}`, { fullName: 'Same Name' });
    expect(res.status).toBe(200);
    expect(await auditRows(h, 'employee.update')).toHaveLength(0);
  });

  it.each([
    ['an empty change', {}],
    ['changing the email', { email: 'new@teachgrow.test' }],
    ['changing the employee id', { employeeCode: 'X-1' }],
    ['mass-assigning the forced-change flag', { mustChangePassword: true }],
    ['an unknown role', { role: 'root' }],
    ['a malformed date', { joiningDate: 'yesterday' }],
  ])('rejects %s', async (_label, body) => {
    const person = await createAccount(h);
    expect((await put(`/api/admin/employees/${person.id}`, body)).status).toBe(400);
  });

  it('answers 404 for an unknown employee and 400 for a malformed id', async () => {
    expect((await put(`/api/admin/employees/${randomUUID()}`, { fullName: 'X' })).status).toBe(404);
    expect((await put('/api/admin/employees/xyz', { fullName: 'X' })).status).toBe(400);
  });

  it('refuses a department that does not exist', async () => {
    const person = await createAccount(h);
    const res = await put(`/api/admin/employees/${person.id}`, { departmentId: randomUUID() });
    expect(res.status).toBe(400);
  });

  describe('roles', () => {
    it('promotes an employee, effective immediately, with a dedicated audit entry', async () => {
      const person = await createAccount(h);
      const personToken = await accessTokenFor(h, person);
      expect((await get('/api/admin/employees', personToken)).status).toBe(403);

      const res = await put(`/api/admin/employees/${person.id}`, { role: 'admin' });
      expect(res.body.employee.role).toBe('admin');

      expect((await get('/api/admin/employees', personToken)).status).toBe(200); // same token, new role
      const [entry] = await auditRows(h, 'employee.role_change');
      expect(entry).toMatchObject({
        before_data: { role: 'employee' },
        after_data: { role: 'admin' },
      });
    });

    it('demotes another administrator, who loses access at once', async () => {
      const other = await createAccount(h, { role: 'admin' });
      const otherToken = await accessTokenFor(h, other);
      await put(`/api/admin/employees/${other.id}`, { role: 'employee' });
      expect((await get('/api/admin/employees', otherToken)).status).toBe(403);
    });

    it('cannot change the type of the office display account in either direction', async () => {
      const kiosk = await createAccount(h, { role: 'office_display' });
      const person = await createAccount(h);
      const a = await put(`/api/admin/employees/${kiosk.id}`, { role: 'employee' });
      const b = await put(`/api/admin/employees/${person.id}`, { role: 'office_display' });
      expect(a.status).toBe(400);
      expect(b.status).toBe(400);
      expect(a.body.error.details[0].path).toBe('role');
    });

    it('cannot make the display account trackable for attendance', async () => {
      const kiosk = await createAccount(h, { role: 'office_display' });
      const res = await put(`/api/admin/employees/${kiosk.id}`, { attendanceRequired: true });
      expect(res.status).toBe(400);
    });
  });

  describe('protecting the administrator from locking themselves out', () => {
    it("refuses to change one's own role", async () => {
      const res = await put(`/api/admin/employees/${admin.id}`, { role: 'employee' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_MODIFICATION_FORBIDDEN');
    });

    it('refuses to deactivate oneself', async () => {
      const res = await put(`/api/admin/employees/${admin.id}`, { isActive: false });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_MODIFICATION_FORBIDDEN');
      expect((await get('/api/auth/me')).status).toBe(200);
    });

    it('still lets an administrator edit their own harmless details', async () => {
      const res = await put(`/api/admin/employees/${admin.id}`, {
        fullName: 'Hema R',
        attendanceRequired: true,
        role: 'admin',
      });
      expect(res.status).toBe(200);
      expect(res.body.employee).toMatchObject({ fullName: 'Hema R', attendanceRequired: true });
    });
  });

  describe('deactivation and reactivation', () => {
    it('cuts access immediately: sessions revoked, tokens refused, provider banned, sign-in blocked', async () => {
      const person = await createAccount(h);
      const login = await mobileLogin(h, person);
      expect(await sessionCount(h, person.id)).toBe(1);

      const res = await put(`/api/admin/employees/${person.id}`, { isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.employee).toMatchObject({ isActive: false });
      expect(res.body.employee.deactivatedAt).toBeTruthy();
      expect(res.body.warnings).toBeUndefined();

      // Their still-valid access token stops working at once.
      const me = await get('/api/auth/me', login.body.accessToken);
      expect([401, 403]).toContain(me.status);
      expect(await sessionCount(h, person.id)).toBe(0);
      // Their refresh token is dead too.
      const refresh = await request(h.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(refresh.status).toBe(401);

      // The provider was told, so they cannot sign in there either.
      const ban = h.fake.calls.find(
        (c) => c.method === 'PUT' && c.path === `/admin/users/${person.id}`,
      );
      expect(ban?.body).toMatchObject({ ban_duration: '876000h' });
      const signIn = await mobileLogin(h, person);
      expect(signIn.status).toBe(403);
      expect(signIn.body.error.code).toBe('ACCOUNT_DEACTIVATED');

      const [row] = await h.testDb.query<{ deactivated_by: string }>(
        'select deactivated_by from public.profiles where id = $1',
        [person.id],
      );
      expect(row?.deactivated_by).toBe(admin.id);
      const [entry] = await auditRows(h, 'employee.deactivate');
      expect(entry).toMatchObject({
        before_data: { isActive: true },
        after_data: { isActive: false },
      });
    });

    it('reactivates: the provider ban is lifted and the person can sign in again', async () => {
      const person = await createAccount(h);
      await put(`/api/admin/employees/${person.id}`, { isActive: false });
      expect((await mobileLogin(h, person)).status).toBe(403);

      const res = await put(`/api/admin/employees/${person.id}`, { isActive: true });
      expect(res.body.employee).toMatchObject({ isActive: true, deactivatedAt: null });
      const unban = [...h.fake.calls].reverse().find((c) => c.method === 'PUT');
      expect(unban?.body).toMatchObject({ ban_duration: 'none' });
      expect((await mobileLogin(h, person)).status).toBe(200);
      expect(await auditRows(h, 'employee.activate')).toHaveLength(1);
    });

    it('stays deactivated at the database even if the provider cannot be updated, and says so', async () => {
      const person = await createAccount(h);
      const login = await mobileLogin(h, person);
      h.fake.setOutage({ status: 500 });

      const res = await put(`/api/admin/employees/${person.id}`, { isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.warnings).toEqual(['AUTH_PROVIDER_SYNC_FAILED']);
      expect(res.body.employee.isActive).toBe(false);

      h.fake.setOutage(null);
      // Our own checks already deny them, with or without the provider ban.
      const me = await get('/api/auth/me', login.body.accessToken);
      expect([401, 403]).toContain(me.status);
    });

    it('is a no-op when the state already matches', async () => {
      const person = await createAccount(h);
      const res = await put(`/api/admin/employees/${person.id}`, { isActive: true });
      expect(res.status).toBe(200);
      expect(await auditRows(h, 'employee.activate')).toHaveLength(0);
      expect(h.fake.calls.some((c) => c.method === 'PUT')).toBe(false);
    });
  });
});

describe('POST /api/admin/employees/:id/reset-password', () => {
  it('issues a new temporary password, signs the person out everywhere, and forces a change', async () => {
    const person = await createAccount(h);
    await mobileLogin(h, person);
    await mobileLogin(h, person);
    expect(await sessionCount(h, person.id)).toBe(2);

    const res = await post(`/api/admin/employees/${person.id}/reset-password`);
    expect(res.status).toBe(200);
    const { temporaryPassword } = res.body;
    expect(passwordSchema.safeParse(temporaryPassword).success).toBe(true);
    expect(temporaryPassword).not.toBe(person.password);

    expect(await sessionCount(h, person.id)).toBe(0);
    expect((await mobileLogin(h, person)).status).toBe(401); // old password no longer works
    const login = await mobileLogin(h, { email: person.email, password: temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);

    const [entry] = await auditRows(h, 'employee.password_reset');
    expect(entry).toMatchObject({ actor_id: admin.id, entity_id: person.id });
    expect(entry!.metadata).toMatchObject({ sessions_revoked: 2 });
    expect(await allAuditJson(h)).not.toContain(temporaryPassword);
  });

  it("cannot be used on one's own account, on unknown accounts, or by non-administrators", async () => {
    expect((await post(`/api/admin/employees/${admin.id}/reset-password`)).status).toBe(403);
    expect((await post(`/api/admin/employees/${randomUUID()}/reset-password`)).status).toBe(404);
    const employee = await createAccount(h);
    const res = await post(
      `/api/admin/employees/${admin.id}/reset-password`,
      undefined,
      await accessTokenFor(h, employee),
    );
    expect(res.status).toBe(403);
  });

  it('fails safe if the provider is down: the person is signed out and must change their (unchanged) password', async () => {
    const person = await createAccount(h);
    await mobileLogin(h, person);
    h.fake.setOutage({ status: 503 });

    const res = await post(`/api/admin/employees/${person.id}/reset-password`);
    expect(res.status).toBe(503);
    h.fake.setOutage(null);

    expect(await sessionCount(h, person.id)).toBe(0);
    const login = await mobileLogin(h, person); // old password still works at the provider...
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true); // ...but must now be changed
  });
});

describe('departments', () => {
  it('lists, creates and audits departments', async () => {
    expect((await get('/api/admin/departments')).body).toEqual({ items: [] });

    const created = await post('/api/admin/departments', { name: '  Teaching  ' });
    expect(created.status).toBe(201);
    expect(created.body.department).toMatchObject({ name: 'Teaching', isActive: true });
    await post('/api/admin/departments', { name: 'accounts' });

    const list = await get('/api/admin/departments');
    expect(list.body.items.map((d: { name: string }) => d.name)).toEqual(['accounts', 'Teaching']);
    expect(await auditRows(h, 'department.create')).toHaveLength(2);
  });

  it('refuses duplicate names regardless of case, and invalid names', async () => {
    await post('/api/admin/departments', { name: 'Teaching' });
    const dup = await post('/api/admin/departments', { name: 'TEACHING' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe('name');
    expect((await post('/api/admin/departments', { name: '   ' })).status).toBe(400);
    expect((await post('/api/admin/departments', { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await post('/api/admin/departments', { name: 'Ops', isActive: false })).status).toBe(
      400,
    );
  });
});
