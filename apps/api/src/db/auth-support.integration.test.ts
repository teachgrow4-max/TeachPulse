import { describe, expect, it } from 'vitest';
import { attempt } from '../testing/harness.js';
import { seedUser } from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

const deactivate = (id: string) =>
  attempt(
    ctx.db,
    'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
    [id],
  );

const demote = (id: string) =>
  attempt(
    ctx.db,
    `update public.profiles set role_id = (select id from public.roles where name = 'employee') where id = $1`,
    [id],
  );

describe('profiles.must_change_password', () => {
  it('defaults to false and can be set', async () => {
    const user = await seedUser(ctx.db);
    const [before] = await ctx.db.query<{ flag: boolean }>(
      'select must_change_password as flag from public.profiles where id = $1',
      [user.id],
    );
    expect(before?.flag).toBe(false);
    await ctx.db.query('update public.profiles set must_change_password = true where id = $1', [
      user.id,
    ]);
    const [after] = await ctx.db.query<{ flag: boolean }>(
      'select must_change_password as flag from public.profiles where id = $1',
      [user.id],
    );
    expect(after?.flag).toBe(true);
  });
});

describe('last administrator protection', () => {
  it('refuses to deactivate or demote the only active administrator', async () => {
    const admin = await seedUser(ctx.db, { role: 'admin' });
    expect(await deactivate(admin.id)).toMatchObject({ code: 'TG001', message: 'LAST_ADMIN' });
    expect(await demote(admin.id)).toMatchObject({ code: 'TG001', message: 'LAST_ADMIN' });
  });

  it('allows it once another active administrator exists, then protects the survivor', async () => {
    const first = await seedUser(ctx.db, { role: 'admin' });
    const second = await seedUser(ctx.db, { role: 'admin' });
    expect(await deactivate(first.id)).toBeNull();
    expect(await deactivate(second.id)).toMatchObject({ message: 'LAST_ADMIN' });
    expect(await demote(second.id)).toMatchObject({ message: 'LAST_ADMIN' });
  });

  it('does not count a deactivated administrator as available', async () => {
    const active = await seedUser(ctx.db, { role: 'admin' });
    const other = await seedUser(ctx.db, { role: 'admin' });
    expect(await deactivate(other.id)).toBeNull();
    expect(await deactivate(active.id)).toMatchObject({ message: 'LAST_ADMIN' });
  });

  it('lets a demotion proceed when another active administrator remains', async () => {
    const a = await seedUser(ctx.db, { role: 'admin' });
    await seedUser(ctx.db, { role: 'admin' });
    expect(await demote(a.id)).toBeNull();
  });

  it('does not interfere with ordinary edits to the last administrator or to employees', async () => {
    const admin = await seedUser(ctx.db, { role: 'admin' });
    const employee = await seedUser(ctx.db);
    expect(
      await attempt(ctx.db, `update public.profiles set full_name = 'Renamed' where id = $1`, [
        admin.id,
      ]),
    ).toBeNull();
    expect(await deactivate(employee.id)).toBeNull();
    expect(await demote(employee.id)).toBeNull();
  });
});

describe('profile retention', () => {
  it('refuses to hard-delete a profile', async () => {
    const user = await seedUser(ctx.db);
    expect(
      await attempt(ctx.db, 'delete from public.profiles where id = $1', [user.id]),
    ).toMatchObject({ code: 'TG002' });
  });
});

describe('login lockout index', () => {
  it('exists as a partial index on the audit log', async () => {
    const [row] = await ctx.db.query<{ def: string }>(
      `select indexdef as def from pg_indexes
       where schemaname = 'public' and indexname = 'audit_logs_login_subject_idx'`,
    );
    expect(row?.def).toContain('subject_hash');
    expect(row?.def).toContain('auth.login.failed');
  });
});
