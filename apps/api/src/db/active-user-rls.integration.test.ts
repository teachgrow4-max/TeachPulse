import { beforeEach, describe, expect, it } from 'vitest';
import { asUser } from '../testing/harness.js';
import {
  checkIn,
  seedDevice,
  seedOffice,
  seedUser,
  startBreak,
  type SeededUser,
} from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

/**
 * Supabase's Data API and Realtime only verify the JWT, which outlives a deactivation.
 * Row Level Security therefore also requires an ACTIVE profile for own-row access.
 */
const ctx = useTestDb();

let alice: SeededUser;
let bob: SeededUser;
let admin: SeededUser;

const personalTables: Array<[table: string, column: string]> = [
  ['attendance_records', 'employee_id'],
  ['attendance_events', 'employee_id'],
  ['break_records', 'employee_id'],
  ['registered_devices', 'employee_id'],
  ['leave_records', 'employee_id'],
  ['notifications', 'user_id'],
  ['profiles', 'id'],
];

beforeEach(async () => {
  const { db } = ctx;
  await seedOffice(db);
  alice = await seedUser(db, { name: 'Alice' });
  bob = await seedUser(db, { name: 'Bob' });
  admin = await seedUser(db, { role: 'admin', attendanceRequired: false });

  for (const person of [alice, bob]) {
    const device = await seedDevice(db, person.id);
    await checkIn(db, person.id, '2026-11-02T09:55:00+05:30', { deviceId: device });
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
});

const deactivate = (id: string) =>
  ctx.db.query(
    'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
    [id],
  );

const reactivate = (id: string) =>
  ctx.db.query('update public.profiles set is_active = true, deactivated_at = null where id = $1', [
    id,
  ]);

async function visibleTo(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, column] of personalTables) {
    const rows = await asUser(ctx.db, userId, () =>
      ctx.db.query(`select 1 from public.${table} where ${column} = $1`, [userId]),
    );
    counts[table] = rows.length;
  }
  return counts;
}

describe('deactivation takes effect on the Data API immediately', () => {
  it('stops a deactivated employee reading their own rows, and restores access on reactivation', async () => {
    const before = await visibleTo(alice.id);
    for (const [table] of personalTables) expect(before[table], table).toBeGreaterThan(0);

    await deactivate(alice.id);
    const during = await visibleTo(alice.id);
    for (const [table] of personalTables) expect(during[table], table).toBe(0);

    await reactivate(alice.id);
    expect(await visibleTo(alice.id)).toEqual(before);
  });

  it('does not affect other employees, and administrators still see the deactivated employee', async () => {
    await deactivate(alice.id);

    const bobSees = await visibleTo(bob.id);
    for (const [table] of personalTables) expect(bobSees[table], table).toBeGreaterThan(0);

    const rows = await asUser(ctx.db, admin.id, () =>
      ctx.db.query('select 1 from public.attendance_records where employee_id = $1', [alice.id]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('hides announcements from deactivated users as well', async () => {
    await ctx.db.query(
      `insert into public.announcements (title, body, created_by, published_at)
       values ('Holiday notice', 'Office closed', $1, '2020-01-01')`,
      [admin.id],
    );
    const seen = () =>
      asUser(ctx.db, alice.id, () => ctx.db.query('select 1 from public.announcements'));

    expect(await seen()).toHaveLength(1);
    await deactivate(alice.id);
    expect(await seen()).toHaveLength(0);
  });

  it('still lets any signed-in user read shared reference data', async () => {
    await deactivate(alice.id);
    const rows = await asUser(ctx.db, alice.id, () =>
      ctx.db.query('select 1 from public.attendance_policies'),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('knows who is active without exposing the helper to anonymous callers', async () => {
    const asAlice = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ active: boolean }>('select private.is_active_user() as active'),
    );
    expect(asAlice[0]?.active).toBe(true);
    await deactivate(alice.id);
    const after = await asUser(ctx.db, alice.id, () =>
      ctx.db.query<{ active: boolean }>('select private.is_active_user() as active'),
    );
    expect(after[0]?.active).toBe(false);

    const nobody = await ctx.db.query<{ active: boolean }>(
      'select private.is_active_user() as active',
    );
    expect(nobody[0]?.active).toBe(false);
  });
});
