import { writeFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { EmployeeQrService } from '../employee-qr/service.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import { dbFromTestDb } from './db-adapter.js';
import { startFakeGoTrue } from './fake-gotrue.js';
import { openTestDb } from './harness.js';

/**
 * A THROW-AWAY demo of the whole system for trying the web app by hand, without Supabase.
 *
 *   npx tsx apps/api/src/testing/dev-server.ts          (then:  npm run dev -w @teachgrow/web)
 *
 * It starts the real API on an embedded Postgres 17 (all migrations applied) and an in-process
 * stand-in for Supabase Auth, seeds a few made-up people and a made-up office, and prints how to
 * sign in. Everything lives in memory and disappears when the process stops.
 *
 * It lives under src/testing, which the production build excludes, and it must never be pointed at
 * real data: the people, the office coordinates and the passwords below are all invented.
 */

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const PASSWORD = 'Demo-Passw0rd!';
/** Invented office coordinates. The demo web page is told to report these as its own location. */
const OFFICE = { latitude: 10, longitude: 20 };

const SECRET = 'demo-secret-demo-secret-demo-secret-0123456789';
const EMPLOYEE_SECRET = 'demo-employee-secret-demo-employee-secret-0123456789';

const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const PEOPLE = [
  {
    email: 'admin@demo.test',
    name: 'Asha Admin',
    code: 'A-001',
    role: 'admin',
    tracked: false,
    title: 'HR Manager',
  },
  {
    email: 'operator@demo.test',
    name: 'Omar Operator',
    code: 'O-001',
    role: 'attendance_operator',
    tracked: false,
    title: 'Front desk',
  },
  {
    email: 'priya@demo.test',
    name: 'Priya Sharma',
    code: 'E-1001',
    role: 'employee',
    tracked: true,
    title: 'Maths Teacher',
    dept: 'Academics',
  },
  {
    email: 'rahul@demo.test',
    name: 'Rahul Verma',
    code: 'E-1002',
    role: 'employee',
    tracked: true,
    title: 'Science Teacher',
    dept: 'Academics',
  },
  {
    email: 'meera@demo.test',
    name: 'Meera Nair',
    code: 'E-1003',
    role: 'employee',
    tracked: true,
    title: 'Accountant',
    dept: 'Finance',
  },
  {
    email: 'imran@demo.test',
    name: 'Imran Khan',
    code: 'E-1004',
    role: 'employee',
    tracked: true,
    title: 'Librarian',
    dept: 'Academics',
    inactive: true,
  },
  {
    email: 'lobby@demo.test',
    name: 'Lobby Screen',
    code: 'D-001',
    role: 'office_display',
    tracked: false,
    title: null,
  },
] as const;

async function main(): Promise<void> {
  say('Starting the demo database (embedded Postgres, all migrations)...');
  const testDb = await openTestDb();
  // Every request runs in a savepoint inside one long transaction, exactly like the test suite.
  await testDb.exec('begin');

  const fake = await startFakeGoTrue({ mode: 'es256', db: testDb });
  const env = loadEnv({
    NODE_ENV: 'development',
    PORT: String(PORT),
    LOG_LEVEL: 'warn',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    SUPABASE_URL: fake.url,
    SUPABASE_ANON_KEY: fake.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: fake.serviceRoleKey,
    QR_SIGNING_SECRET: SECRET,
    EMPLOYEE_QR_SECRET: EMPLOYEE_SECRET,
    CORS_ORIGINS: WEB_ORIGIN,
    WEBAUTHN_RP_ID: 'localhost',
  });
  const db = dbFromTestDb(testDb);

  // ---- an office, its network, and the people ---------------------------------------------
  const [office] = await testDb.query<{ id: string }>(
    `insert into public.office_locations (name, address, latitude, longitude)
     values ('Demo Office', 'Nowhere in particular', $1, $2) returning id`,
    [OFFICE.latitude, OFFICE.longitude],
  );
  for (const cidr of ['127.0.0.1/32', '::1/128']) {
    await testDb.query(
      `insert into public.office_networks (office_id, label, cidr) values ($1, 'This computer', $2::cidr)`,
      [office!.id, cidr],
    );
  }
  const departments = new Map<string, string>();
  for (const name of ['Academics', 'Finance']) {
    const [row] = await testDb.query<{ id: string }>(
      'insert into public.departments (name) values ($1) returning id',
      [name],
    );
    departments.set(name, row!.id);
  }

  const qr = new EmployeeQrService({ db, clock: systemClock, secret: EMPLOYEE_SECRET });
  const ids = new Map<string, string>();
  for (const person of PEOPLE) {
    const user = await fake.addUser(person.email, PASSWORD);
    ids.set(person.email, user.id);
    const dept = 'dept' in person ? (departments.get(person.dept) ?? null) : null;
    const inactive = 'inactive' in person && person.inactive === true;
    await testDb.query(
      `insert into public.profiles
         (id, employee_code, full_name, email, joining_date, role_id, attendance_required,
          is_active, deactivated_at, department_id, designation)
       values ($1, $2, $3, $4, '2026-01-01', (select id from public.roles where name = $5), $6,
               $7, case when $7 then null else now() end, $8, $9)`,
      [
        user.id,
        person.code,
        person.name,
        person.email,
        person.role,
        person.tracked,
        !inactive,
        dept,
        person.title,
      ],
    );
  }
  await db.withTransaction(async (tx) => {
    for (const person of PEOPLE) {
      if (person.role === 'office_display') continue;
      await qr.issueFirstCode(
        tx,
        ids.get(person.email)!,
        null,
        { ip: null, userAgent: null, requestId: null },
        new Date(),
      );
    }
  });

  // The demo's codes, so a test script can show them to a fake camera.
  const codes: Array<{ email: string; name: string; code: string; payload: string }> = [];
  for (const person of PEOPLE) {
    if (person.role === 'office_display') continue;
    const [row] = await testDb.query<{ id: string; token_nonce: Uint8Array }>(
      `select id, token_nonce from public.employee_qr_codes where employee_id = $1`,
      [ids.get(person.email)],
    );
    const { derivePayload, deriveEmployeeQrKey } = await import('../employee-qr/token.js');
    codes.push({
      email: person.email,
      name: person.name,
      code: person.code,
      payload: derivePayload(
        deriveEmployeeQrKey(EMPLOYEE_SECRET),
        ids.get(person.email)!,
        Buffer.from(row!.token_nonce),
      ),
    });
  }
  if (process.env.DEV_HARNESS_OUT) {
    writeFileSync(
      process.env.DEV_HARNESS_OUT,
      JSON.stringify({ password: PASSWORD, office: OFFICE, codes }, null, 2),
    );
  }

  const app = createApp({ env, logger: createLogger(env), db, clock: systemClock });
  app.listen(PORT, '127.0.0.1', () => {
    say(`\nDemo API ready on http://127.0.0.1:${PORT}   (web app origin allowed: ${WEB_ORIGIN})`);
    say(`Everyone signs in with the password  ${PASSWORD}`);
    for (const person of PEOPLE)
      say(`  ${person.email.padEnd(20)} ${person.role.padEnd(20)} ${person.name}`);
    say('\nThe demo office is at 10.000000, 20.000000 (invented). Press Ctrl+C to stop.');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
