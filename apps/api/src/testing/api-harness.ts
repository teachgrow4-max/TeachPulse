import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { parseSetCookie, type SetCookie } from 'cookie';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { RoleName } from '@teachgrow/shared';
import { createApp } from '../app.js';
import { loadEnv, type Env } from '../config/env.js';
import type { Db } from '../db/pool.js';
import { fixedClock } from '../lib/clock.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { dbFromTestDb } from './db-adapter.js';
import { startFakeGoTrue, type FakeGoTrue, type SigningMode } from './fake-gotrue.js';
import type { TestDb } from './harness.js';
import { useTestDb } from './setup.js';

/** Headers a browser sends from the configured web origin (CSRF defence expects both). */
export const WEB_ORIGIN = 'https://app.test';
export const WEB_HEADERS = { Origin: WEB_ORIGIN, 'X-Requested-With': 'teachgrow-web' } as const;

/** Monday 2026-11-02, 10:00 in Asia/Kolkata. */
export const START_TIME = '2026-11-02T04:30:00Z';

export const DEFAULT_PASSWORD = 'Str0ng-Passw0rd!';

/** The QR signing secret the test app is configured with (tests derive real codes from it). */
export const QR_TEST_SECRET = 'qr-signing-secret-for-tests-0123456789abcdef';

/** The secret behind employees' personal QR codes in the test app (tests derive real codes from it). */
export const EMPLOYEE_QR_TEST_SECRET = 'employee-qr-secret-for-tests-0123456789abcdef';

export interface ApiHarness {
  testDb: TestDb;
  db: Db;
  fake: FakeGoTrue;
  clock: ReturnType<typeof fixedClock>;
  env: Env;
  app: Express;
  /** Build another app instance (different env, wrapped database, injected collaborators). */
  build(options?: { env?: Record<string, string | undefined>; db?: Db; logger?: Logger }): Express;
  envWith(overrides?: Record<string, string | undefined>): Env;
}

export interface UseApiOptions {
  mode?: SigningMode;
  env?: Record<string, string | undefined>;
}

/**
 * Boots the real application against the in-process database and a fake auth server.
 * Call at module top level; use the returned object's fields inside tests (they are refreshed
 * before every test, and the database is rolled back after every test).
 */
export function useApi(options: UseApiOptions = {}): ApiHarness {
  const mode = options.mode ?? 'es256';
  const ctx = useTestDb();
  const h = {} as ApiHarness;
  let fake: FakeGoTrue;

  beforeAll(async () => {
    fake = await startFakeGoTrue({ mode, db: ctx.db, now: () => h.clock.now() });
  });

  afterAll(async () => {
    await fake?.close();
  });

  beforeEach(() => {
    fake.reset();
    h.testDb = ctx.db;
    h.db = dbFromTestDb(ctx.db);
    h.fake = fake;
    h.clock = fixedClock(START_TIME);
    h.envWith = (overrides = {}) =>
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        SUPABASE_URL: fake.url,
        SUPABASE_ANON_KEY: fake.anonKey,
        SUPABASE_SERVICE_ROLE_KEY: fake.serviceRoleKey,
        QR_SIGNING_SECRET: QR_TEST_SECRET,
        EMPLOYEE_QR_SECRET: EMPLOYEE_QR_TEST_SECRET,
        ...(fake.hs256Secret ? { SUPABASE_JWT_SECRET: fake.hs256Secret } : {}),
        CORS_ORIGINS: WEB_ORIGIN,
        ...options.env,
        ...overrides,
      });
    h.build = (build = {}) => {
      const env = h.envWith(build.env);
      return createApp({
        env,
        logger: build.logger ?? createLogger(env),
        db: build.db ?? h.db,
        clock: h.clock,
      });
    };
    h.env = h.envWith();
    h.app = h.build();
  });

  return h;
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export interface AccountOptions {
  role?: RoleName;
  email?: string;
  password?: string;
  fullName?: string;
  active?: boolean;
  mustChangePassword?: boolean;
  attendanceRequired?: boolean;
  /** false = an auth user with no profile (never provisioned). */
  profile?: boolean;
  departmentId?: string | null;
}

export interface Account {
  id: string;
  email: string;
  password: string;
  fullName: string;
  code: string;
}

let sequence = 0;

export async function createAccount(h: ApiHarness, opts: AccountOptions = {}): Promise<Account> {
  sequence += 1;
  const email = (opts.email ?? `person${sequence}@teachgrow.test`).toLowerCase();
  const password = opts.password ?? DEFAULT_PASSWORD;
  const role = opts.role ?? 'employee';
  const fullName = opts.fullName ?? `Person ${sequence}`;
  const code = `E${String(sequence).padStart(4, '0')}`;

  const user = await h.fake.addUser(email, password);

  if (opts.profile !== false) {
    const active = opts.active ?? true;
    await h.testDb.query(
      `insert into public.profiles
         (id, employee_code, full_name, email, joining_date, role_id, attendance_required,
          is_active, deactivated_at, must_change_password, department_id)
       values ($1, $2, $3, $4, '2026-01-01', (select id from public.roles where name = $5), $6,
               $7, case when $7 then null else now() end, $8, $9)`,
      [
        user.id,
        code,
        fullName,
        email,
        role,
        opts.attendanceRequired ?? role === 'employee',
        active,
        opts.mustChangePassword ?? false,
        opts.departmentId ?? null,
      ],
    );
  }
  return { id: user.id, email, password, fullName, code };
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function webLogin(h: ApiHarness, who: { email: string; password: string }) {
  return request(h.app)
    .post('/api/auth/login')
    .set(WEB_HEADERS)
    .send({ email: who.email, password: who.password, client: 'web' });
}

export function mobileLogin(h: ApiHarness, who: { email: string; password: string }) {
  return request(h.app)
    .post('/api/auth/login')
    .send({ email: who.email, password: who.password, client: 'mobile' });
}

/** Signs in (mobile style, no cookie) and returns the access token. */
export async function accessTokenFor(
  h: ApiHarness,
  who: { email: string; password: string },
): Promise<string> {
  const res = await mobileLogin(h, who);
  if (res.status !== 200) {
    throw new Error(`test sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

/** The parsed Set-Cookie for `name` in a supertest response, if present. */
export function setCookieOf(
  res: { headers: Record<string, unknown> },
  name = 'tg_refresh',
): SetCookie | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  for (const header of list) {
    const parsed = parseSetCookie(header);
    if (parsed.name === name) return parsed;
  }
  return undefined;
}

export const cookieHeader = (value: string | undefined) => {
  if (value === undefined) throw new Error('expected the response to set a refresh cookie');
  return { Cookie: `tg_refresh=${value}` };
};

export const randomId = (): string => randomUUID();

// ---------------------------------------------------------------------------------------------
// Database peeks
// ---------------------------------------------------------------------------------------------

export async function auditRows(
  h: ApiHarness,
  action?: string,
): Promise<
  Array<{
    action: string;
    actor_id: string | null;
    actor_role: string | null;
    entity_type: string | null;
    entity_id: string | null;
    before_data: Record<string, unknown> | null;
    after_data: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
    ip: string | null;
  }>
> {
  return h.testDb.query(
    `select action, actor_id, actor_role, entity_type, entity_id, before_data, after_data,
            metadata, host(ip) as ip
     from public.audit_logs
     where ($1::text is null or action = $1)
     order by id`,
    [action ?? null],
  );
}

export async function sessionCount(h: ApiHarness, userId: string): Promise<number> {
  const [row] = await h.testDb.query<{ n: string }>(
    'select count(*)::text as n from auth.sessions where user_id = $1',
    [userId],
  );
  return Number(row?.n ?? 0);
}

export async function allAuditJson(h: ApiHarness): Promise<string> {
  const rows = await h.testDb.query<{ row: string }>(
    'select row_to_json(a)::text as row from public.audit_logs a',
  );
  return rows.map((r) => r.row).join('\n');
}
