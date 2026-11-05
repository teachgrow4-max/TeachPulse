import { beforeEach, describe, expect, it } from 'vitest';
import { asUser, attempt } from '../testing/harness.js';
import {
  checkIn,
  seedDevice,
  seedOffice,
  seedUser,
  seedVerification,
  startBreak,
  type SeededUser,
} from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

// Monday 2026-11-02, a normal working day in Asia/Kolkata.
const A_IN = '2026-11-02T09:55:00+05:30';

let alice: SeededUser;
let bob: SeededUser;
let admin: SeededUser;

beforeEach(async () => {
  const { db } = ctx;
  await seedOffice(db);
  alice = await seedUser(db, { name: 'Alice' });
  bob = await seedUser(db, { name: 'Bob' });
  admin = await seedUser(db, { role: 'admin', attendanceRequired: false, name: 'Hema Admin' });

  for (const person of [alice, bob]) {
    const device = await seedDevice(db, person.id);
    await checkIn(db, person.id, A_IN, { deviceId: device });
    await startBreak(db, person.id, 'SHORT', '2026-11-02T11:00:00+05:30');
    await db.query(
      `insert into public.notifications (user_id, type, dedupe_key, title, body)
       values ($1, 'CHECK_IN_SUCCESS', 'k1', 'Checked in', 'ok')`,
      [person.id],
    );
    await db.query(
      `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
       values ($1, '2026-12-01', '2026-12-02', $2)`,
      [person.id, admin.id],
    );
  }
  await db.query(
    `insert into public.audit_logs (actor_id, actor_role, action) values ($1, 'admin', 'test')`,
    [admin.id],
  );
});

const count = async (table: string, where = ''): Promise<number> => {
  const [row] = await ctx.db.query<{ n: number }>(
    `select count(*)::int as n from public.${table} ${where}`,
  );
  return row!.n;
};

describe('employee data isolation', () => {
  const ownRowTables = [
    'attendance_records',
    'attendance_events',
    'break_records',
    'registered_devices',
    'leave_records',
    'notifications',
  ];

  it.each(ownRowTables)('lets an employee read only their own %s', async (table) => {
    const aliceRows = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ owner: string }>(
        `select ${table === 'notifications' ? 'user_id' : 'employee_id'} as owner from public.${table}`,
      ),
    );
    expect(aliceRows.length).toBeGreaterThan(0);
    expect(new Set(aliceRows.map((r) => r.owner))).toEqual(new Set([alice.id]));
  });

  it("cannot be bypassed by filtering for another employee's rows", async () => {
    for (const table of ['attendance_records', 'attendance_events', 'break_records']) {
      const rows = await asUser(ctx.db, alice.id, () =>
        ctx.db.query(`select 1 from public.${table} where employee_id = $1`, [bob.id]),
      );
      expect(rows, table).toHaveLength(0);
    }
  });

  it('shows an employee only their own profile', async () => {
    const rows = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ id: string }>('select id from public.profiles'),
    );
    expect(rows.map((r) => r.id)).toEqual([alice.id]);
  });

  it('hides verification evidence (GPS, IP) from employees entirely', async () => {
    expect(await count('attendance_verifications')).toBeGreaterThan(0);
    const rows = await asUser(ctx.db, alice.id, () =>
      ctx.db.query('select 1 from public.attendance_verifications'),
    );
    expect(rows).toHaveLength(0);
  });

  it.each(['audit_logs', 'office_locations', 'office_networks'])(
    'hides %s from employees',
    async (table) => {
      const rows = await asUser(ctx.db, alice.id, () =>
        ctx.db.query(`select 1 from public.${table}`),
      );
      expect(rows).toHaveLength(0);
    },
  );

  it('lets employees read shared reference data (policy, holidays, departments, roles)', async () => {
    await ctx.db.query(
      `insert into public.holidays (holiday_date, name) values ('2026-12-25', 'Winter break')`,
    );
    await ctx.db.query(`insert into public.departments (name) values ('Teaching')`);
    for (const [table, minimum] of [
      ['attendance_policies', 1],
      ['holidays', 1],
      ['departments', 1],
      ['roles', 3],
    ] as const) {
      const rows = await asUser(ctx.db, alice.id, () =>
        ctx.db.query(`select 1 from public.${table}`),
      );
      expect(rows.length, table).toBeGreaterThanOrEqual(minimum);
    }
  });
});

describe('administrator elevation', () => {
  it('lets an admin read every employee row', async () => {
    const rows = await asUser(ctx.db, admin.id, () =>
      ctx.db.query<{ employee_id: string }>('select employee_id from public.attendance_records'),
    );
    expect(new Set(rows.map((r) => r.employee_id))).toEqual(new Set([alice.id, bob.id]));
  });

  it('lets an admin read verifications, office config and the audit log', async () => {
    for (const table of [
      'attendance_verifications',
      'office_locations',
      'audit_logs',
      'profiles',
    ]) {
      const rows = await asUser(ctx.db, admin.id, () =>
        ctx.db.query(`select 1 from public.${table}`),
      );
      expect(rows.length, table).toBeGreaterThan(0);
    }
  });

  it('removes elevation immediately when the admin is deactivated', async () => {
    // The system refuses to deactivate its only administrator, so a second one must exist.
    await seedUser(ctx.db, { role: 'admin', attendanceRequired: false });
    await ctx.db.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [admin.id],
    );
    const rows = await asUser(ctx.db, admin.id, () =>
      ctx.db.query('select 1 from public.attendance_records'),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not treat an ordinary employee as admin', async () => {
    const [row] = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ admin: boolean; role: string | null }>(
        'select private.is_admin() as admin, private.current_role_name() as role',
      ),
    );
    expect(row).toEqual({ admin: false, role: 'employee' });
  });

  it('gives an unauthenticated session no admin rights', async () => {
    const [row] = await ctx.db.query<{ admin: boolean }>('select private.is_admin() as admin');
    expect(row?.admin).toBe(false);
  });
});

describe('write lockout for client roles', () => {
  const writes: Array<[string, string]> = [
    [
      'insert attendance_records',
      `insert into public.attendance_records (employee_id, work_date, status) values ($1, '2026-11-03', 'PRESENT')`,
    ],
    [
      'update own attendance_records',
      `update public.attendance_records set status = 'ABSENT' where employee_id = $1`,
    ],
    [
      'delete own attendance_records',
      `delete from public.attendance_records where employee_id = $1`,
    ],
    [
      'update own check-in time',
      `update public.attendance_records set check_in_at = now() where employee_id = $1`,
    ],
    [
      'insert attendance_events',
      `insert into public.attendance_events (attendance_record_id, employee_id, event_type) select id, employee_id, 'CHECK_IN' from public.attendance_records where employee_id = $1`,
    ],
    [
      'update break_records',
      `update public.break_records set ended_at = now() where employee_id = $1`,
    ],
    [
      'promote self to admin',
      `update public.profiles set role_id = (select id from public.roles where name = 'admin') where id = $1`,
    ],
    ['reactivate self', `update public.profiles set is_active = true where id = $1`],
    [
      'insert registered_devices',
      `insert into public.registered_devices (employee_id, device_identifier, platform, status, approved_at) values ($1, 'self-approved-device', 'IOS', 'ACTIVE', now())`,
    ],
    [
      'approve own device',
      `update public.registered_devices set status = 'ACTIVE', approved_at = now() where employee_id = $1`,
    ],
    [
      'insert attendance_corrections',
      `insert into public.attendance_corrections (employee_id, work_date, source, original, proposed, reason, requested_by) values ($1, '2026-11-02', 'EMPLOYEE_REQUEST', '{}', '{"status":"PRESENT"}', 'please fix this', $1)`,
    ],
    ['insert audit_logs', `insert into public.audit_logs (action, actor_id) values ('forged', $1)`],
    [
      'insert verification',
      `insert into public.attendance_verifications (employee_id, purpose, channel, gps_result, network_result, qr_result, device_result, final_result, expires_at) values ($1, 'CHECK_IN', 'WEB', 'PASS', 'PASS', 'PASS', 'PASS', 'VERIFIED', now() + interval '1 hour')`,
    ],
  ];

  it.each(writes)('denies an employee to %s', async (_name, sql) => {
    const err = await asUser(ctx.db, alice.id, () => attempt(ctx.db, sql, [alice.id]));
    expect(err?.code).toBe('42501');
  });

  it('denies even an admin direct writes to attendance tables (writes go through the API)', async () => {
    const err = await asUser(ctx.db, admin.id, () =>
      attempt(ctx.db, `update public.attendance_records set status = 'PRESENT'`),
    );
    expect(err?.code).toBe('42501');
  });

  it('denies the anon role any access', async () => {
    for (const table of ['attendance_records', 'profiles', 'attendance_policies', 'roles']) {
      const err = await asUser(
        ctx.db,
        alice.id,
        () => attempt(ctx.db, `select 1 from public.${table}`),
        'anon',
      );
      expect(err?.code, table).toBe('42501');
    }
  });

  it.each(['qr_tokens', 'qr_scan_events', 'idempotency_keys', 'push_subscriptions'])(
    'makes %s unreadable even to an admin',
    async (table) => {
      const err = await asUser(ctx.db, admin.id, () =>
        attempt(ctx.db, `select 1 from public.${table}`),
      );
      expect(err?.code).toBe('42501');
    },
  );

  it('denies clients the business functions (they cannot mint check-ins or corrections)', async () => {
    const verification = await seedVerification(ctx.db, alice.id, {
      at: '2026-11-03T09:55:00+05:30',
    });
    const calls: Array<[string, unknown[]]> = [
      [`select private.check_in($1::uuid, $2::uuid, now())`, [alice.id, verification]],
      [`select private.check_out($1::uuid, $2::uuid, now())`, [alice.id, verification]],
      [`select private.start_break($1::uuid, 'LUNCH', now())`, [alice.id]],
      [
        `select private.admin_correct($1::uuid, '2026-11-02', '{"status":"PRESENT","check_in_at":"2026-11-02T04:00:00Z"}'::jsonb, 'forged correction', $1::uuid, now())`,
        [alice.id],
      ],
      [`select private.finalize_due_days()`, []],
      [`select private.apply_retention()`, []],
    ];
    for (const [sql, params] of calls) {
      const err = await asUser(ctx.db, alice.id, () => attempt(ctx.db, sql, params));
      expect(err?.code, sql).toBe('42501');
    }
  });
});

describe('announcements visibility', () => {
  beforeEach(async () => {
    const insert = (title: string, publishedAt: string, expiresAt: string | null) =>
      ctx.db.query(
        `insert into public.announcements (title, body, created_by, published_at, expires_at)
         values ($1, 'body', $2, $3::timestamptz, $4::timestamptz)`,
        [title, admin.id, publishedAt, expiresAt],
      );
    await insert('live', '2020-01-01T00:00:00Z', null);
    await insert('scheduled', '2099-01-01T00:00:00Z', null);
    await insert('expired', '2020-01-01T00:00:00Z', '2020-06-01T00:00:00Z');
  });

  it('shows employees only published, unexpired announcements', async () => {
    const rows = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ title: string }>('select title from public.announcements'),
    );
    expect(rows.map((r) => r.title)).toEqual(['live']);
  });

  it('shows admins everything', async () => {
    const rows = await asUser(ctx.db, admin.id, () =>
      ctx.db.query<{ title: string }>('select title from public.announcements order by title'),
    );
    expect(rows.map((r) => r.title)).toEqual(['expired', 'live', 'scheduled']);
  });
});
