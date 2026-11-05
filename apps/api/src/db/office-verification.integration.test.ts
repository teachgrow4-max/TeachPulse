import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attempt } from '../testing/harness.js';
import { seedDevice, seedOffice, seedUser } from '../testing/fixtures.js';
import { useTestDb } from '../testing/setup.js';

const ctx = useTestDb();

async function seedToken(hexByte = 'ab'): Promise<string> {
  const office = await seedOffice(ctx.db);
  const [token] = await ctx.db.query<{ id: string }>(
    `insert into public.qr_tokens (office_id, token_hash, valid_from, expires_at, accept_until)
     values ($1, decode(repeat($2, 32), 'hex'), now(), now() + interval '30 seconds', now() + interval '40 seconds')
     returning id`,
    [office, hexByte],
  );
  return token!.id;
}

describe('QR scan outcomes', () => {
  it('accepts every defined outcome and refuses anything else', async () => {
    const tokenId = await seedToken();
    const emp = await seedUser(ctx.db);
    for (const outcome of ['ACCEPTED', 'VALID', 'EXPIRED', 'UNKNOWN', 'REPLAYED']) {
      const err = await attempt(
        ctx.db,
        'insert into public.qr_scan_events (qr_token_id, employee_id, outcome) values ($1, $2, $3)',
        [outcome === 'ACCEPTED' ? tokenId : null, emp.id, outcome],
      );
      expect(err, outcome).toBeNull();
    }
    const bad = await attempt(
      ctx.db,
      `insert into public.qr_scan_events (employee_id, outcome) values ($1, 'CONSUMED')`,
      [emp.id],
    );
    expect(bad?.code).toBe('23514');
  });

  it('lets an employee hold many VALID scans of a token but only ONE ACCEPTED (single use)', async () => {
    const tokenId = await seedToken();
    const emp = await seedUser(ctx.db);
    const insert = (outcome: string) =>
      attempt(
        ctx.db,
        'insert into public.qr_scan_events (qr_token_id, employee_id, outcome) values ($1, $2, $3)',
        [tokenId, emp.id, outcome],
      );
    expect(await insert('VALID')).toBeNull();
    expect(await insert('VALID')).toBeNull();
    expect(await insert('ACCEPTED')).toBeNull();
    expect((await insert('ACCEPTED'))?.code).toBe('23505');
    expect(await insert('REPLAYED')).toBeNull();
  });

  it('lets different employees each have an ACCEPTED scan of the same displayed code', async () => {
    const tokenId = await seedToken();
    const a = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    for (const who of [a, b]) {
      const err = await attempt(
        ctx.db,
        `insert into public.qr_scan_events (qr_token_id, employee_id, outcome) values ($1, $2, 'ACCEPTED')`,
        [tokenId, who.id],
      );
      expect(err).toBeNull();
    }
  });
});

describe('device challenges', () => {
  const challenge = () => randomBytes(32);
  const insert = (sql: string, params: unknown[]) => attempt(ctx.db, sql, params);

  it('accepts a well-formed registration challenge and a well-formed verification challenge', async () => {
    const emp = await seedUser(ctx.db);
    const device = await seedDevice(ctx.db, emp.id);
    expect(
      await insert(
        `insert into public.device_challenges (user_id, purpose, platform, challenge, expires_at)
         values ($1, 'REGISTER', 'WEB', $2, now() + interval '2 minutes')`,
        [emp.id, challenge()],
      ),
    ).toBeNull();
    for (const purpose of ['CHECK_IN', 'CHECK_OUT']) {
      expect(
        await insert(
          `insert into public.device_challenges (user_id, purpose, device_id, challenge, expires_at)
           values ($1, $2, $3, $4, now() + interval '2 minutes')`,
          [emp.id, purpose, device, challenge()],
        ),
        purpose,
      ).toBeNull();
    }
  });

  it('refuses malformed shapes: registration needs a platform and no device; verification the reverse', async () => {
    const emp = await seedUser(ctx.db);
    const device = await seedDevice(ctx.db, emp.id);
    const expires = "now() + interval '2 minutes'";
    const cases: Array<[string, string, unknown[]]> = [
      [
        'registration without a platform',
        `values ($1, 'REGISTER', null, null, $2, ${expires})`,
        [emp.id, challenge()],
      ],
      [
        'registration naming a device',
        `values ($1, 'REGISTER', $3, 'WEB', $2, ${expires})`,
        [emp.id, challenge(), device],
      ],
      [
        'verification without a device',
        `values ($1, 'CHECK_IN', null, null, $2, ${expires})`,
        [emp.id, challenge()],
      ],
      [
        'verification with a platform',
        `values ($1, 'CHECK_IN', $3, 'WEB', $2, ${expires})`,
        [emp.id, challenge(), device],
      ],
    ];
    for (const [label, values, params] of cases) {
      const err = await insert(
        `insert into public.device_challenges (user_id, purpose, device_id, platform, challenge, expires_at) ${values}`,
        params,
      );
      expect(err?.code, label).toBe('23514');
    }
  });

  it('requires exactly 32 bytes and a known purpose', async () => {
    const emp = await seedUser(ctx.db);
    const short = await insert(
      `insert into public.device_challenges (user_id, purpose, platform, challenge, expires_at)
       values ($1, 'REGISTER', 'WEB', $2, now() + interval '2 minutes')`,
      [emp.id, randomBytes(16)],
    );
    expect(short?.code).toBe('23514');
    const unknownPurpose = await insert(
      `insert into public.device_challenges (user_id, purpose, platform, challenge, expires_at)
       values ($1, 'LOGIN', 'WEB', $2, now() + interval '2 minutes')`,
      [emp.id, challenge()],
    );
    expect(unknownPurpose?.code).toBe('23514');
  });

  it('is invisible to clients: RLS on, no grants, no policy', async () => {
    const [rls] = await ctx.db.query<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = 'public.device_challenges'::regclass`,
    );
    expect(rls?.on).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const [row] = await ctx.db.query<{ ok: boolean }>(
          'select has_table_privilege($1, $2, $3) as ok',
          [role, 'public.device_challenges', privilege],
        );
        expect(row?.ok, `${role} ${privilege}`).toBe(false);
      }
    }
  });

  it('is purged a day after it expired, and only then', async () => {
    const emp = await seedUser(ctx.db);
    const add = (expires: string) =>
      ctx.db.query(
        `insert into public.device_challenges (user_id, purpose, platform, challenge, expires_at)
         values ($1, 'REGISTER', 'WEB', $2, $3::timestamptz)`,
        [emp.id, challenge(), expires],
      );
    await add('2026-11-01T00:00:00Z'); // expired 3 days before "now"
    await add('2026-11-03T23:00:00Z'); // expired 1 hour before "now"
    await add('2026-11-05T00:00:00Z'); // still valid

    const [result] = await ctx.db.query<{ r: Record<string, number> }>(
      `select private.apply_retention('2026-11-04T00:00:00Z'::timestamptz) as r`,
    );
    expect(result?.r.device_challenges_deleted).toBe(1);
    const left = await ctx.db.query('select 1 from public.device_challenges');
    expect(left).toHaveLength(2);
  });
});

describe('device policy and credentials', () => {
  it('defaults to two devices per employee and bounds the setting', async () => {
    const [row] = await ctx.db.query<{ n: number }>(
      'select max_devices_per_employee as n from public.attendance_policies',
    );
    expect(row?.n).toBe(2);
    for (const bad of [0, 11]) {
      const err = await attempt(
        ctx.db,
        'update public.attendance_policies set max_devices_per_employee = $1',
        [bad],
      );
      expect(err?.code, String(bad)).toBe('23514');
    }
    expect(
      await attempt(ctx.db, 'update public.attendance_policies set max_devices_per_employee = 5'),
    ).toBeNull();
  });

  it('allows a WebAuthn credential id on only one live device, and frees it on revocation', async () => {
    const a = await seedUser(ctx.db);
    const b = await seedUser(ctx.db);
    const add = (employee: string, identifier: string) =>
      attempt(
        ctx.db,
        `insert into public.registered_devices
           (employee_id, device_identifier, platform, credential_id)
         values ($1, $2, 'WEB', 'shared-credential-id')`,
        [employee, identifier],
      );
    expect(await add(a.id, 'identifier-for-device-aaa')).toBeNull();
    expect((await add(b.id, 'identifier-for-device-bbb'))?.code).toBe('23505');

    await ctx.db.query(
      `update public.registered_devices set status = 'REVOKED', revoked_at = now() where employee_id = $1`,
      [a.id],
    );
    expect(await add(b.id, 'identifier-for-device-bbb')).toBeNull();
  });
});
