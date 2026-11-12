import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_STATUSES,
  BREAK_END_REASONS,
  BREAK_TYPES,
  CHANNELS,
  CORRECTION_SOURCES,
  CORRECTION_STATUSES,
  DEVICE_PLATFORMS,
  DEVICE_STATUSES,
  EVENT_TYPES,
  LAYER_RESULTS,
  LIVE_STATES,
  ROLE_NAMES,
  VERIFICATION_LAYERS,
  VERIFICATION_PURPOSES,
  VERIFICATION_RESULTS,
} from '@teachgrow/shared';
import { attempt } from '../testing/harness.js';
import { seedDevice, seedOffice, seedUser, seedVerification } from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

const REQUIRED_TABLES = [
  'profiles',
  'roles',
  'office_locations',
  'office_networks',
  'registered_devices',
  'attendance_records',
  'attendance_events',
  'attendance_verifications',
  'break_records',
  'attendance_policies',
  'holidays',
  'attendance_corrections',
  'audit_logs',
  'qr_tokens',
];

const SUPPORTING_TABLES = [
  'departments',
  'leave_records',
  'qr_scan_events',
  'device_challenges',
  'checkout_exceptions',
  'idempotency_keys',
  'push_subscriptions',
  'notifications',
  'announcements',
  'employee_qr_codes',
  'qr_scan_logs',
];

async function publicTables(): Promise<string[]> {
  const rows = await ctx.db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  );
  return rows.map((r) => r.relname);
}

describe('schema contract', () => {
  it('contains the 14 required tables plus the supporting tables', async () => {
    const tables = await publicTables();
    for (const name of [...REQUIRED_TABLES, ...SUPPORTING_TABLES]) {
      expect(tables, `missing table ${name}`).toContain(name);
    }
  });

  it('keeps every Postgres enum identical to the shared TypeScript lists', async () => {
    const expected: Record<string, readonly string[]> = {
      attendance_status: ATTENDANCE_STATUSES,
      live_state: LIVE_STATES,
      event_type: EVENT_TYPES,
      break_type: BREAK_TYPES,
      break_end_reason: BREAK_END_REASONS,
      verification_layer: VERIFICATION_LAYERS,
      verification_layer_result: LAYER_RESULTS,
      verification_result: VERIFICATION_RESULTS,
      verification_purpose: VERIFICATION_PURPOSES,
      client_channel: CHANNELS,
      device_platform: DEVICE_PLATFORMS,
      device_status: DEVICE_STATUSES,
      correction_status: CORRECTION_STATUSES,
      correction_source: CORRECTION_SOURCES,
    };
    for (const [typeName, values] of Object.entries(expected)) {
      const rows = await ctx.db.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_enum e
         join pg_type t on t.oid = e.enumtypid
         join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public' and t.typname = $1 order by e.enumsortorder`,
        [typeName],
      );
      expect(
        rows.map((r) => r.enumlabel),
        `enum ${typeName} drifted from packages/shared`,
      ).toEqual([...values]);
    }
  });

  it('seeds exactly the shared roles', async () => {
    const rows = await ctx.db.query<{ name: string }>(
      'select name from public.roles order by name',
    );
    expect(rows.map((r) => r.name)).toEqual([...ROLE_NAMES].sort());
  });

  it('seeds no users, no office, no networks and no devices', async () => {
    for (const table of ['profiles', 'office_locations', 'office_networks', 'registered_devices']) {
      const [row] = await ctx.db.query<{ n: string }>(
        `select count(*)::text as n from public.${table}`,
      );
      expect(row?.n, `${table} must start empty`).toBe('0');
    }
  });

  it('seeds the initial TeachGrow policy from the brief, with optional rules disabled', async () => {
    const [policy] = await ctx.db.query<Record<string, unknown>>(
      `select office_start::text, office_end::text, late_threshold::text, lunch_allowance_minutes,
              half_day_enabled, overtime_enabled, early_checkout_enabled,
              check_in_layers_web::text as web, check_in_layers_mobile::text as mobile,
              check_out_layers::text as checkout
       from public.attendance_policies`,
    );
    expect(policy).toMatchObject({
      office_start: '10:00:00',
      office_end: '19:00:00',
      late_threshold: '10:20:00',
      lunch_allowance_minutes: 60,
      half_day_enabled: false,
      overtime_enabled: false,
      early_checkout_enabled: false,
      web: '{GPS,NETWORK,QR,DEVICE}',
      mobile: '{GPS,NETWORK,QR,DEVICE}',
      checkout: '{GPS,NETWORK}',
    });
  });

  it('defaults a new office to Asia/Kolkata, Monday-Saturday, 150 m', async () => {
    await seedOffice(ctx.db);
    const [office] = await ctx.db.query<Record<string, unknown>>(
      `select timezone, working_days::text as working_days, geofence_radius_m, qr_rotation_seconds
       from public.office_locations`,
    );
    expect(office).toMatchObject({
      timezone: 'Asia/Kolkata',
      working_days: '{1,2,3,4,5,6}',
      geofence_radius_m: 150,
      qr_rotation_seconds: 30,
    });
  });
});

describe('privileges and Row Level Security posture', () => {
  it('has RLS enabled on every table in public', async () => {
    const rows = await ctx.db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('gives client roles no write or DDL-ish privilege on any table', async () => {
    const offenders: string[] = [];
    for (const table of await publicTables()) {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of [
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const [row] = await ctx.db.query<{ ok: boolean }>(
            'select has_table_privilege($1, $2, $3) as ok',
            [role, `public.${table}`, privilege],
          );
          if (row?.ok) offenders.push(`${role} ${privilege} ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives the anon role no access at all', async () => {
    const offenders: string[] = [];
    for (const table of await publicTables()) {
      const [row] = await ctx.db.query<{ ok: boolean }>(
        `select has_table_privilege('anon', $1, 'SELECT') as ok`,
        [`public.${table}`],
      );
      if (row?.ok) offenders.push(table);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps QR, scan, idempotency and push tables unreadable by clients', async () => {
    for (const table of ['qr_tokens', 'qr_scan_events', 'idempotency_keys', 'push_subscriptions']) {
      const [row] = await ctx.db.query<{ ok: boolean }>(
        `select has_table_privilege('authenticated', $1, 'SELECT') as ok`,
        [`public.${table}`],
      );
      expect(row?.ok, `authenticated must not read ${table}`).toBe(false);
    }
  });

  it('allows client roles to execute only the RLS helper functions', async () => {
    const rows = await ctx.db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('anon', p.oid, 'EXECUTE'))
       order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['current_role_name', 'is_active_user', 'is_admin']);
  });

  it('exposes no application function in the public schema to client roles', async () => {
    const rows = await ctx.db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or has_function_privilege('anon', p.oid, 'EXECUTE'))`,
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });
});

describe('table constraints', () => {
  it('allows only one active office', async () => {
    await seedOffice(ctx.db);
    const err = await attempt(
      ctx.db,
      `insert into public.office_locations (name, latitude, longitude) values ('Second', 1, 1)`,
    );
    expect(err?.code).toBe('23505');
  });

  it.each([
    ['latitude out of range', `latitude, longitude`, '91, 0'],
    ['longitude out of range', `latitude, longitude`, '0, 181'],
  ])('rejects an office with %s', async (_label, columns, values) => {
    const err = await attempt(
      ctx.db,
      `insert into public.office_locations (name, ${columns}) values ('X', ${values})`,
    );
    expect(err?.code).toBe('23514');
  });

  it.each([
    ['radius below minimum', 'geofence_radius_m', '5'],
    ['QR rotation under 30s', 'qr_rotation_seconds', '10'],
    ['QR rotation over 60s', 'qr_rotation_seconds', '120'],
    ['unknown timezone', 'timezone', `'Mars/Olympus'`],
    ['no working days', 'working_days', `'{}'::smallint[]`],
    ['invalid weekday', 'working_days', `'{1,8}'::smallint[]`],
  ])('rejects an office with %s', async (_label, column, value) => {
    const err = await attempt(
      ctx.db,
      `insert into public.office_locations (name, latitude, longitude, ${column}) values ('X', 1, 1, ${value})`,
    );
    expect(err?.code).toBe('23514');
  });

  it('refuses office network ranges that are too broad', async () => {
    const office = await seedOffice(ctx.db);
    for (const cidr of ['0.0.0.0/0', '10.0.0.0/8', '::/0', '2001:db8::/32']) {
      const err = await attempt(
        ctx.db,
        'insert into public.office_networks (office_id, label, cidr) values ($1, $2, $3::cidr)',
        [office, 'too broad', cidr],
      );
      expect(err?.code, cidr).toBe('23514');
    }
    for (const cidr of ['203.0.113.10/32', '198.51.100.0/24', '10.1.0.0/16', '2001:db8:1::/48']) {
      const err = await attempt(
        ctx.db,
        'insert into public.office_networks (office_id, label, cidr) values ($1, $2, $3::cidr)',
        [office, 'ok', cidr],
      );
      expect(err, cidr).toBeNull();
    }
  });

  it('matches client IPs against stored ranges with inet containment', async () => {
    const office = await seedOffice(ctx.db);
    await ctx.db.query(
      `insert into public.office_networks (office_id, label, cidr) values ($1, 'main', '198.51.100.0/24')`,
      [office],
    );
    const [inside] = await ctx.db.query<{ ok: boolean }>(
      `select exists (select 1 from public.office_networks where is_active and $1::inet <<= cidr) as ok`,
      ['198.51.100.77'],
    );
    const [outside] = await ctx.db.query<{ ok: boolean }>(
      `select exists (select 1 from public.office_networks where is_active and $1::inet <<= cidr) as ok`,
      ['198.51.101.77'],
    );
    expect(inside?.ok).toBe(true);
    expect(outside?.ok).toBe(false);
  });

  it('allows a physical device to be live for only one employee at a time', async () => {
    const a = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    await ctx.db.query(
      `insert into public.registered_devices (employee_id, device_identifier, platform, status, approved_at)
       values ($1, 'shared-device-0001', 'ANDROID', 'ACTIVE', now())`,
      [a.id],
    );
    const err = await attempt(
      ctx.db,
      `insert into public.registered_devices (employee_id, device_identifier, platform)
       values ($1, 'shared-device-0001', 'ANDROID')`,
      [b.id],
    );
    expect(err?.code).toBe('23505');

    // Once revoked, the identifier is free again.
    await ctx.db.query(
      `update public.registered_devices set status = 'REVOKED', revoked_at = now()
       where device_identifier = 'shared-device-0001'`,
    );
    const ok = await attempt(
      ctx.db,
      `insert into public.registered_devices (employee_id, device_identifier, platform)
       values ($1, 'shared-device-0001', 'ANDROID')`,
      [b.id],
    );
    expect(ok).toBeNull();
  });

  it('requires approval before a device can be ACTIVE, and a timestamp when REVOKED', async () => {
    const a = await seedUser(ctx.db);
    const noApproval = await attempt(
      ctx.db,
      `insert into public.registered_devices (employee_id, device_identifier, platform, status)
       values ($1, 'device-needs-approval', 'IOS', 'ACTIVE')`,
      [a.id],
    );
    expect(noApproval?.code).toBe('23514');
    const noTimestamp = await attempt(
      ctx.db,
      `insert into public.registered_devices (employee_id, device_identifier, platform, status)
       values ($1, 'device-revoked-nots', 'IOS', 'REVOKED')`,
      [a.id],
    );
    expect(noTimestamp?.code).toBe('23514');
  });

  it('keeps profile deactivation fields consistent and identifiers unique', async () => {
    const a = await seedUser(ctx.db);
    const inconsistent = await attempt(
      ctx.db,
      'update public.profiles set is_active = false where id = $1',
      [a.id],
    );
    expect(inconsistent?.code).toBe('23514');

    const dup = await attempt(
      ctx.db,
      `insert into auth.users (id, email) values (gen_random_uuid(), 'dup@test.invalid')`,
    );
    expect(dup).toBeNull();
    const dupCode = await attempt(
      ctx.db,
      `with u as (select id from auth.users where email = 'dup@test.invalid')
       insert into public.profiles (id, employee_code, full_name, email, joining_date, role_id)
       select u.id, lower($1), 'Dup', 'dup@test.invalid', '2026-01-01', (select id from public.roles where name = 'employee') from u`,
      [a.code],
    );
    expect(dupCode?.code).toBe('23505');
  });

  it('forbids overlapping approved leave for the same employee but allows cancelled overlaps', async () => {
    const emp = await seedUser(ctx.db);
    const admin = await seedUser(ctx.db, { role: 'admin' });
    const insertLeave = (start: string, end: string) =>
      attempt(
        ctx.db,
        `insert into public.leave_records (employee_id, start_date, end_date, approved_by)
         values ($1, $2::date, $3::date, $4)`,
        [emp.id, start, end, admin.id],
      );
    expect(await insertLeave('2026-11-10', '2026-11-12')).toBeNull();
    expect((await insertLeave('2026-11-12', '2026-11-14'))?.code).toBe('23P01');
    expect(await insertLeave('2026-11-13', '2026-11-14')).toBeNull();

    await ctx.db.query(
      `update public.leave_records set cancelled_at = now(), cancelled_by = $2
       where employee_id = $1 and start_date = '2026-11-10'`,
      [emp.id, admin.id],
    );
    expect(await insertLeave('2026-11-10', '2026-11-11')).toBeNull();
  });

  it('rejects policies whose rules are inconsistent', async () => {
    const insert = (assignments: string) =>
      attempt(
        ctx.db,
        `insert into public.attendance_policies (effective_from, ${assignments.split('=')[0]})
         values ('2027-01-01', ${assignments.split('=').slice(1).join('=')})`,
      );
    expect((await insert(`late_threshold = '09:00'`))?.code).toBe('23514'); // before office start
    expect((await insert(`late_threshold = '19:00'`))?.code).toBe('23514'); // not before close
    expect((await insert(`half_day_enabled = true`))?.code).toBe('23514'); // threshold missing
    expect((await insert(`overtime_enabled = true`))?.code).toBe('23514');
    expect((await insert(`early_checkout_enabled = true`))?.code).toBe('23514');
    expect((await insert(`check_out_layers = '{}'::public.verification_layer[]`))?.code).toBe(
      '23514',
    );
  });

  it('never lets check-in drop the GPS or NETWORK layer', async () => {
    for (const layers of ["'{GPS,QR,DEVICE}'", "'{NETWORK,QR,DEVICE}'", "'{QR,DEVICE}'", "'{}'"]) {
      for (const column of ['check_in_layers_web', 'check_in_layers_mobile']) {
        const err = await attempt(
          ctx.db,
          `insert into public.attendance_policies (effective_from, ${column})
           values ('2027-02-01', ${layers}::public.verification_layer[])`,
        );
        expect(err?.code, `${column} ${layers}`).toBe('23514');
      }
    }
    // QR and DEVICE may be relaxed (documented policy decision D1/D2).
    const ok = await attempt(
      ctx.db,
      `insert into public.attendance_policies (effective_from, check_in_layers_web)
       values ('2027-02-01', '{GPS,NETWORK}'::public.verification_layer[])`,
    );
    expect(ok).toBeNull();
  });
});

describe('verification evidence invariants', () => {
  const base = `insert into public.attendance_verifications
      (employee_id, purpose, channel, gps_result, network_result, qr_result, device_result,
       final_result, expires_at)`;

  it('refuses to record VERIFIED when any layer failed', async () => {
    const emp = await seedUser(ctx.db);
    for (const [gps, net, qr, dev] of [
      ['FAIL', 'PASS', 'PASS', 'PASS'],
      ['PASS', 'FAIL', 'PASS', 'PASS'],
      ['PASS', 'PASS', 'FAIL', 'PASS'],
      ['PASS', 'PASS', 'PASS', 'FAIL'],
      ['PASS', 'PASS', 'PASS', 'NOT_EVALUATED'],
    ]) {
      const err = await attempt(
        ctx.db,
        `${base} values ($1, 'CHECK_IN', 'MOBILE', $2::public.verification_layer_result,
          $3::public.verification_layer_result, $4::public.verification_layer_result,
          $5::public.verification_layer_result, 'VERIFIED', now() + interval '2 minutes')`,
        [emp.id, gps, net, qr, dev],
      );
      expect(err?.code, `${gps}/${net}/${qr}/${dev}`).toBe('23514');
    }
  });

  it('never accepts a check-in whose GPS or NETWORK was merely "not required"', async () => {
    const emp = await seedUser(ctx.db);
    for (const [gps, net] of [
      ['NOT_REQUIRED', 'PASS'],
      ['PASS', 'NOT_REQUIRED'],
    ]) {
      const err = await attempt(
        ctx.db,
        `${base} values ($1, 'CHECK_IN', 'WEB', $2::public.verification_layer_result,
          $3::public.verification_layer_result, 'PASS', 'PASS', 'VERIFIED', now() + interval '2 minutes')`,
        [emp.id, gps, net],
      );
      expect(err?.code, `${gps}/${net}`).toBe('23514');
    }
  });

  it('requires an expiry on VERIFIED and forbids consuming a REJECTED verification', async () => {
    const emp = await seedUser(ctx.db);
    const noExpiry = await attempt(
      ctx.db,
      `${base} values ($1, 'CHECK_IN', 'WEB', 'PASS', 'PASS', 'PASS', 'PASS', 'VERIFIED', null)`,
      [emp.id],
    );
    expect(noExpiry?.code).toBe('23514');
    const consumedRejected = await attempt(
      ctx.db,
      `insert into public.attendance_verifications
        (employee_id, purpose, channel, gps_result, network_result, qr_result, device_result,
         final_result, consumed_at)
       values ($1, 'CHECK_IN', 'WEB', 'FAIL', 'PASS', 'PASS', 'PASS', 'REJECTED', now())`,
      [emp.id],
    );
    expect(consumedRejected?.code).toBe('23514');
  });

  it('allows only consumption and coordinate redaction to change on a stored verification', async () => {
    const emp = await seedUser(ctx.db);
    const id = await seedVerification(ctx.db, emp.id, { at: '2026-11-02T04:00:00Z' });
    await ctx.db.query(
      `update public.attendance_verifications set latitude = 10, longitude = 20 where id = $1`,
      [id],
    );
    expect(
      await attempt(
        ctx.db,
        `update public.attendance_verifications set final_result = 'REJECTED' where id = $1`,
        [id],
      ),
    ).toMatchObject({ code: 'TG002' });
    expect(
      await attempt(
        ctx.db,
        `update public.attendance_verifications set distance_m = 0 where id = $1`,
        [id],
      ),
    ).toMatchObject({ code: 'TG002' });
    expect(
      await attempt(
        ctx.db,
        `update public.attendance_verifications set expires_at = now() + interval '1 day' where id = $1`,
        [id],
      ),
    ).toMatchObject({ code: 'TG002' });

    await ctx.db.query(
      `update public.attendance_verifications set consumed_at = now() where id = $1`,
      [id],
    );
    expect(
      await attempt(
        ctx.db,
        `update public.attendance_verifications set consumed_at = now() + interval '1 hour' where id = $1`,
        [id],
      ),
    ).toMatchObject({ code: 'TG002' });
    expect(
      await attempt(ctx.db, 'delete from public.attendance_verifications where id = $1', [id]),
    ).toMatchObject({ code: 'TG002' });
  });

  it('scopes a QR token to at most one accepted scan per employee', async () => {
    const office = await seedOffice(ctx.db);
    const a = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    const [token] = await ctx.db.query<{ id: string }>(
      `insert into public.qr_tokens (office_id, token_hash, valid_from, expires_at, accept_until)
       values ($1, decode(repeat('ab', 32), 'hex'), now(), now() + interval '30 seconds', now() + interval '35 seconds')
       returning id`,
      [office],
    );
    const scan = (employee: string, outcome: string) =>
      attempt(
        ctx.db,
        `insert into public.qr_scan_events (qr_token_id, employee_id, outcome) values ($1, $2, $3)`,
        [token!.id, employee, outcome],
      );
    expect(await scan(a.id, 'ACCEPTED')).toBeNull();
    expect(await scan(b.id, 'ACCEPTED')).toBeNull(); // many employees may scan the same on-screen code
    expect((await scan(a.id, 'ACCEPTED'))?.code).toBe('23505'); // but never the same employee twice
    expect(await scan(a.id, 'REPLAYED')).toBeNull(); // failed attempts are still recorded
  });

  it('stores QR tokens only as 32-byte hashes', async () => {
    const office = await seedOffice(ctx.db);
    const err = await attempt(
      ctx.db,
      `insert into public.qr_tokens (office_id, token_hash, valid_from, expires_at, accept_until)
       values ($1, 'plaintext-token'::bytea, now(), now() + interval '30 seconds', now() + interval '35 seconds')`,
      [office],
    );
    expect(err?.code).toBe('23514');
  });

  it('keeps the audit log and attendance events append-only', async () => {
    const admin = await seedUser(ctx.db, { role: 'admin' });
    await ctx.db.query(
      `insert into public.audit_logs (actor_id, actor_role, action) values ($1, 'admin', 'test.action')`,
      [admin.id],
    );
    expect(await attempt(ctx.db, `update public.audit_logs set action = 'x'`)).toMatchObject({
      code: 'TG002',
    });
    expect(await attempt(ctx.db, 'delete from public.audit_logs')).toMatchObject({ code: 'TG002' });
    expect(await attempt(ctx.db, 'truncate public.audit_logs')).toMatchObject({ code: 'TG002' });
    // Postgres may refuse TRUNCATE earlier (FK references) than our trigger; either way it is blocked.
    expect(await attempt(ctx.db, 'truncate public.attendance_events')).not.toBeNull();
  });

  it('refuses a device row referenced by evidence from being deleted', async () => {
    const emp = await seedUser(ctx.db);
    const device = await seedDevice(ctx.db, emp.id);
    await seedVerification(ctx.db, emp.id, { at: '2026-11-02T04:00:00Z', deviceId: device });
    const err = await attempt(ctx.db, 'delete from public.registered_devices where id = $1', [
      device,
    ]);
    expect(err?.code).toBe('23001'); // restrict_violation (ON DELETE RESTRICT)
  });
});
