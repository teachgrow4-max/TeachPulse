import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { SupabaseAuthGateway } from '../auth/gateway.js';
import { EmployeeService } from '../employees/service.js';
import { createLogger } from '../lib/logger.js';
import { allAuditJson, auditRows, bearer, mobileLogin, useApi } from '../testing/api-harness.js';
import { EXIT, runBootstrap, type CliIo } from './bootstrap-admin.js';
import type { Prompter } from './prompt.js';

const h = useApi();

const PASSWORD = 'Op3rator-Chosen-Passw0rd';

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  asked: string[];
}

function makeIo(
  options: { interactive?: boolean; answers?: string[]; secrets?: string[] } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(options.answers ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const prompter: Prompter = {
    interactive: options.interactive ?? false,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    askSecret: async (question) => {
      asked.push(question);
      return secrets.shift() ?? '';
    },
  };
  return {
    out,
    err,
    asked,
    io: {
      prompter,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      today: () => '2026-11-02',
    },
  };
}

let service: EmployeeService;

beforeEach(() => {
  const env = h.env;
  service = new EmployeeService({
    db: h.db,
    gateway: new SupabaseAuthGateway({
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    clock: h.clock,
    logger: createLogger(env),
  });
});

const args = [
  '--email',
  'Hema@TeachGrow.test',
  '--name',
  'Hema Rao',
  '--code',
  'TG-001',
  '--joining-date',
  '2026-01-15',
];

describe('first-administrator bootstrap', () => {
  it('creates the first administrator that can then sign in and manage the system', async () => {
    const cli = makeIo();
    const code = await runBootstrap(args, { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }, cli.io, service);

    expect(code).toBe(EXIT.ok);
    expect(cli.out.join('')).toContain('Hema Rao');
    expect(cli.out.join('')).not.toContain(PASSWORD); // the password is never printed

    const [row] = await h.testDb.query<{
      role: string;
      email: string;
      attendance_required: boolean;
      must_change_password: boolean;
      joining_date: string;
      created_by: string | null;
    }>(
      `select r.name as role, p.email, p.attendance_required, p.must_change_password,
              p.joining_date, p.created_by
       from public.profiles p join public.roles r on r.id = p.role_id`,
    );
    expect(row).toEqual({
      role: 'admin',
      email: 'hema@teachgrow.test',
      attendance_required: false,
      must_change_password: false,
      joining_date: '2026-01-15',
      created_by: null,
    });

    const login = await mobileLogin(h, { email: 'hema@teachgrow.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
    expect(
      (await request(h.app).get('/api/admin/employees').set(bearer(login.body.accessToken))).status,
    ).toBe(200);
  });

  it('audits the creation with no actor and no secrets', async () => {
    await runBootstrap(args, { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }, makeIo().io, service);
    const [entry] = await auditRows(h, 'bootstrap.admin_created');
    expect(entry).toMatchObject({ actor_id: null, entity_type: 'profile' });
    expect(await allAuditJson(h)).not.toContain(PASSWORD);
  });

  it('honours the optional flags', async () => {
    const code = await runBootstrap(
      [...args, '--tracks-attendance', '--require-password-change'],
      { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
      makeIo().io,
      service,
    );
    expect(code).toBe(EXIT.ok);
    const [row] = await h.testDb.query<{
      attendance_required: boolean;
      must_change_password: boolean;
    }>('select attendance_required, must_change_password from public.profiles');
    expect(row).toEqual({ attendance_required: true, must_change_password: true });
  });

  it('refuses to run again once an administrator exists, creating nothing', async () => {
    expect(
      await runBootstrap(args, { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }, makeIo().io, service),
    ).toBe(EXIT.ok);
    const users = h.fake.users.size;

    const second = makeIo();
    const code = await runBootstrap(
      ['--email', 'second@teachgrow.test', '--name', 'Second Admin', '--code', 'TG-002'],
      { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
      second.io,
      service,
    );
    expect(code).toBe(EXIT.adminExists);
    expect(second.err.join('')).toContain('administrator already exists');
    expect(h.fake.users.size).toBe(users);
    expect(await h.testDb.query('select 1 from public.profiles')).toHaveLength(1);
  });

  it('refuses even if the only existing administrator has been deactivated', async () => {
    // Recovery from a lost administrator is a deliberate, manual database operation - not a way
    // for anyone with the service credentials to mint a new administrator unnoticed.
    await runBootstrap(args, { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD }, makeIo().io, service);
    await h.testDb.exec('alter table public.profiles disable trigger profiles_protect_last_admin');
    await h.testDb.exec('update public.profiles set is_active = false, deactivated_at = now()');
    await h.testDb.exec('alter table public.profiles enable trigger profiles_protect_last_admin');
    const code = await runBootstrap(
      ['--email', 'again@teachgrow.test', '--name', 'Again', '--code', 'TG-003'],
      { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
      makeIo().io,
      service,
    );
    expect(code).toBe(EXIT.adminExists);
  });

  describe('input handling', () => {
    it('rejects a weak password before contacting the auth provider', async () => {
      const cli = makeIo();
      const code = await runBootstrap(
        args,
        { BOOTSTRAP_ADMIN_PASSWORD: 'weakpass' },
        cli.io,
        service,
      );
      expect(code).toBe(EXIT.invalid);
      expect(cli.err.join('')).toContain('initialPassword');
      expect(cli.err.join('')).not.toContain('weakpass');
      expect(h.fake.users.size).toBe(0);
    });

    it('rejects an invalid email or employee id', async () => {
      const cli = makeIo();
      const code = await runBootstrap(
        ['--email', 'nope', '--name', 'X', '--code', 'bad code!'],
        { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        cli.io,
        service,
      );
      expect(code).toBe(EXIT.invalid);
      expect(cli.err.join('')).toMatch(/email/);
      expect(cli.err.join('')).toMatch(/employeeCode/);
    });

    it('reads values from BOOTSTRAP_ADMIN_* environment variables', async () => {
      const code = await runBootstrap(
        [],
        {
          BOOTSTRAP_ADMIN_EMAIL: 'env@teachgrow.test',
          BOOTSTRAP_ADMIN_NAME: 'Env Admin',
          BOOTSTRAP_ADMIN_CODE: 'ENV-1',
          BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
        },
        makeIo().io,
        service,
      );
      expect(code).toBe(EXIT.ok);
      expect(
        (await mobileLogin(h, { email: 'env@teachgrow.test', password: PASSWORD })).status,
      ).toBe(200);
    });

    it('defaults the joining date to today', async () => {
      await runBootstrap(
        ['--email', 'a@teachgrow.test', '--name', 'A', '--code', 'A-1'],
        { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        makeIo().io,
        service,
      );
      const [row] = await h.testDb.query<{ joining_date: string }>(
        'select joining_date from public.profiles',
      );
      expect(row?.joining_date).toBe('2026-11-02');
    });

    it('lists what is missing when not in a terminal, instead of hanging on a prompt', async () => {
      const cli = makeIo({ interactive: false });
      const code = await runBootstrap(['--email', 'a@teachgrow.test'], {}, cli.io, service);
      expect(code).toBe(EXIT.invalid);
      expect(cli.err.join('')).toMatch(/Missing: name, code, password/);
      expect(cli.asked).toEqual([]);
    });

    it('asks for anything missing in a terminal, and confirms the password', async () => {
      const cli = makeIo({
        interactive: true,
        answers: ['prompt@teachgrow.test', 'Prompted Admin', 'P-1'],
        secrets: [PASSWORD, PASSWORD],
      });
      const code = await runBootstrap(['--joining-date', '2026-02-01'], {}, cli.io, service);
      expect(code).toBe(EXIT.ok);
      expect(cli.asked.filter((q) => /password/i.test(q))).toHaveLength(2);
      expect(
        (await mobileLogin(h, { email: 'prompt@teachgrow.test', password: PASSWORD })).status,
      ).toBe(200);
    });

    it('stops if the two typed passwords differ', async () => {
      const cli = makeIo({
        interactive: true,
        answers: ['prompt@teachgrow.test', 'Prompted Admin', 'P-1', '2026-02-01'],
        secrets: [PASSWORD, `${PASSWORD}x`],
      });
      const code = await runBootstrap([], {}, cli.io, service);
      expect(code).toBe(EXIT.invalid);
      expect(cli.err.join('')).toContain('do not match');
      expect(h.fake.users.size).toBe(0);
    });

    it('rejects unknown options and prints help on request', async () => {
      const bad = makeIo();
      expect(await runBootstrap(['--bogus'], {}, bad.io, service)).toBe(EXIT.invalid);
      expect(bad.err.join('')).toContain('Create the first TeachGrow Attendance administrator');

      const help = makeIo();
      expect(await runBootstrap(['--help'], {}, help.io, service)).toBe(EXIT.ok);
      expect(help.out.join('')).toContain('BOOTSTRAP_ADMIN_PASSWORD');
      expect(h.fake.users.size).toBe(0);
    });
  });

  describe('failures', () => {
    it('reports an unreachable auth provider and creates no profile', async () => {
      h.fake.setOutage({ status: 503 });
      const cli = makeIo();
      const code = await runBootstrap(
        args,
        { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        cli.io,
        service,
      );
      expect(code).toBe(EXIT.failed);
      expect(await h.testDb.query('select 1 from public.profiles')).toHaveLength(0);
    });

    it('reports an email that already exists at the auth provider', async () => {
      await h.fake.addUser('hema@teachgrow.test', 'Existing-Passw0rd1');
      const cli = makeIo();
      const code = await runBootstrap(
        args,
        { BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
        cli.io,
        service,
      );
      expect(code).toBe(EXIT.invalid);
      expect(await h.testDb.query('select 1 from public.profiles')).toHaveLength(0);
    });
  });
});
