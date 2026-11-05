import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { QrCurrentResponse } from '@teachgrow/shared';
import { createLogger } from '../lib/logger.js';
import {
  type Account,
  QR_TEST_SECRET,
  START_TIME,
  accessTokenFor,
  auditRows,
  bearer,
  createAccount,
  useApi,
} from '../testing/api-harness.js';
import {
  QR_EARLY_TOLERANCE_SECONDS,
  QR_GRACE_SECONDS,
  buildPayload,
  deriveCode,
  windowIndexAt,
} from '../verification/qr.js';

const h = useApi();

/** The harness clock starts exactly on a rotation boundary (04:30:00Z is a multiple of 30 s). */
const T0 = Date.parse(START_TIME);
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const ROTATION = 30;

let admin: Account; // does not mark attendance
let trackedAdmin: Account; // does
let employee: Account;
let colleague: Account;
let display: Account;
let tokens: Record<'admin' | 'trackedAdmin' | 'employee' | 'colleague' | 'display', string>;
let officeId: string;

beforeEach(async () => {
  admin = await createAccount(h, { role: 'admin', attendanceRequired: false });
  trackedAdmin = await createAccount(h, { role: 'admin', attendanceRequired: true });
  employee = await createAccount(h);
  colleague = await createAccount(h);
  display = await createAccount(h, { role: 'office_display' });
  tokens = {
    admin: await accessTokenFor(h, admin),
    trackedAdmin: await accessTokenFor(h, trackedAdmin),
    employee: await accessTokenFor(h, employee),
    colleague: await accessTokenFor(h, colleague),
    display: await accessTokenFor(h, display),
  };
});

async function configureOffice(patch: object = {}): Promise<void> {
  const res = await request(h.app)
    .put('/api/admin/office/settings')
    .set(bearer(tokens.admin))
    // Synthetic coordinates: this codebase never contains the company's real location.
    .send({ name: 'Test Office', latitude: 10, longitude: 20, ...patch });
  expect(res.status).toBe(200);
  officeId = res.body.office.id as string;
}

const showing = (token = tokens.display) =>
  request(h.app).get('/api/office/qr/current').set(bearer(token));
const scan = (payload: unknown, token = tokens.employee) =>
  request(h.app).post('/api/office/qr/verify').set(bearer(token)).send({ payload });
const onScreen = async (): Promise<QrCurrentResponse> => (await showing()).body;

/** A code minted locally, as the lobby display would show it for window `index`. */
const mint = (
  index: number,
  opts: { secret?: string; officeId?: string; rotationSeconds?: number } = {},
) =>
  buildPayload(
    index,
    deriveCode(
      opts.secret ?? QR_TEST_SECRET,
      { id: opts.officeId ?? officeId, rotationSeconds: opts.rotationSeconds ?? ROTATION },
      index,
    ),
  );

const codeOf = (payload: string) => payload.split('.')[2] as string;
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const scans = () =>
  h.testDb.query<{
    outcome: string;
    employee_id: string;
    qr_token_id: string | null;
    device_id: string | null;
    verification_id: string | null;
    ip: string | null;
  }>(
    `select outcome, employee_id, qr_token_id, device_id, verification_id, host(client_ip) as ip
     from public.qr_scan_events order by id`,
  );
const tokenRows = () =>
  h.testDb.query<{
    id: string;
    office_id: string;
    hash: string;
    valid_from: Date;
    expires_at: Date;
    accept_until: Date;
  }>(
    `select id, office_id, encode(token_hash, 'hex') as hash, valid_from, expires_at, accept_until
     from public.qr_tokens order by created_at, id`,
  );

describe('who may use the QR endpoints', () => {
  beforeEach(() => configureOffice());

  it('needs a signed-in user', async () => {
    expect((await request(h.app).get('/api/office/qr/current')).status).toBe(401);
    expect((await request(h.app).post('/api/office/qr/verify').send({ payload: 'x' })).status).toBe(
      401,
    );
  });

  it.each(['employee', 'colleague'] as const)(
    'keeps upcoming codes from the %s: only the lobby screen may read them',
    async (who) => {
      const res = await showing(tokens[who]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toMatch(/TG1\./);
    },
  );

  it('writes an audit entry when an employee probes the display endpoint', async () => {
    await showing(tokens.employee);
    const [entry] = await auditRows(h, 'authz.denied');
    expect(entry).toMatchObject({ actor_id: employee.id, actor_role: 'employee' });
    expect(entry!.metadata).toMatchObject({
      method: 'GET',
      path: '/api/office/qr/current',
      required_roles: ['office_display', 'admin'],
    });
  });

  it('lets the display account and administrators read the current code', async () => {
    expect((await showing(tokens.display)).status).toBe(200);
    expect((await showing(tokens.admin)).status).toBe(200);
  });

  it('refuses the display account the scan pre-check: it is not a person who marks attendance', async () => {
    const res = await scan(mint(windowIndexAt(at(0), ROTATION)), tokens.display);
    expect(res.status).toBe(403);
    expect(await scans()).toHaveLength(0);
  });

  it('refuses an administrator whose account is not tracked for attendance', async () => {
    const res = await scan(mint(windowIndexAt(at(0), ROTATION)), tokens.admin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await scans()).toHaveLength(0);
  });

  it('lets a tracked administrator use the pre-check like anyone else', async () => {
    const res = await scan(mint(windowIndexAt(at(0), ROTATION)), tokens.trackedAdmin);
    expect(res.status).toBe(200);
  });

  it('is shut for deactivated accounts straight away', async () => {
    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [display.id],
    );
    const res = await showing(tokens.display);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });
});

describe('before the office is configured', () => {
  it('has nothing to show or check, and says so plainly', async () => {
    const shown = await showing();
    expect(shown.status).toBe(503);
    expect(shown.body.error.code).toBe('OFFICE_NOT_CONFIGURED');

    const checked = await scan('TG1.1.' + 'a'.repeat(43));
    expect(checked.status).toBe(503);
    expect(checked.body.error.code).toBe('OFFICE_NOT_CONFIGURED');
    expect(await scans()).toHaveLength(0);
  });
});

describe('GET /api/office/qr/current (the lobby display)', () => {
  beforeEach(() => configureOffice());

  it('returns the code on screen, the one after it, and the exact window boundaries', async () => {
    const res = await showing();
    expect(res.status).toBe(200);
    const index = windowIndexAt(at(0), ROTATION);

    expect(res.body.payload).toMatch(/^TG1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(res.body.payload).toBe(mint(index));
    expect(res.body.window).toEqual({
      index,
      validFrom: at(0).toISOString(),
      expiresAt: at(ROTATION).toISOString(),
      acceptUntil: at(ROTATION + QR_GRACE_SECONDS).toISOString(),
    });
    expect(res.body.next.payload).toBe(mint(index + 1));
    expect(res.body.next.window.index).toBe(index + 1);
    expect(res.body.next.window.validFrom).toBe(at(ROTATION).toISOString());
    expect(res.body.rotationSeconds).toBe(ROTATION);
    expect(res.body.serverTime).toBe(at(0).toISOString());
  });

  it('shows the same code for the whole window and a new one the instant it ends', async () => {
    const first = await onScreen();
    h.clock.set(new Date(at(ROTATION).getTime() - 1));
    expect((await onScreen()).payload).toBe(first.payload);

    h.clock.set(at(ROTATION));
    const second = await onScreen();
    expect(second.payload).not.toBe(first.payload);
    // The display can pre-load "next" and switch locally without waiting for the network.
    expect(second.payload).toBe(first.next.payload);
  });

  it('never repeats a code across many consecutive windows', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      h.clock.set(at(i * ROTATION));
      seen.add((await onScreen()).payload);
    }
    expect(seen.size).toBe(20);
  });

  it('follows the rotation period the administrator sets', async () => {
    await configureOffice({ qrRotationSeconds: 60 });
    const res = await showing();
    expect(res.body.rotationSeconds).toBe(60);
    expect(Date.parse(res.body.window.expiresAt) - Date.parse(res.body.window.validFrom)).toBe(
      60_000,
    );
    expect(res.body.payload).toBe(mint(windowIndexAt(at(0), 60), { rotationSeconds: 60 }));
  });

  it('derives different codes under a different signing secret', async () => {
    const other = h.build({
      env: { QR_SIGNING_SECRET: 'another-secret-of-sufficient-length-0123456789' },
    });
    const theirs = await request(other).get('/api/office/qr/current').set(bearer(tokens.display));
    expect(theirs.status).toBe(200);
    expect(theirs.body.payload).not.toBe((await onScreen()).payload);
  });

  it('is never cacheable by browsers or proxies', async () => {
    const res = await showing();
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('writes nothing: tokens are created only when somebody scans one', async () => {
    await showing();
    await showing(tokens.admin);
    expect(await tokenRows()).toHaveLength(0);
    expect(await scans()).toHaveLength(0);
  });
});

describe('POST /api/office/qr/verify (pre-check)', () => {
  beforeEach(() => configureOffice());

  it('accepts the code that is on screen', async () => {
    const shown = await onScreen();
    const res = await scan(shown.payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, acceptUntil: shown.window.acceptUntil });
    expect(res.body.acceptUntil).toBe(at(ROTATION + QR_GRACE_SECONDS).toISOString());
  });

  it('does not use the code up: checking is free, and repeatable', async () => {
    const { payload } = await onScreen();
    for (let i = 0; i < 3; i += 1) expect((await scan(payload)).status).toBe(200);

    expect(await tokenRows()).toHaveLength(1);
    const events = await scans();
    expect(events.map((e) => e.outcome)).toEqual(['VALID', 'VALID', 'VALID']);
    expect(events.some((e) => e.outcome === 'ACCEPTED')).toBe(false);
  });

  it('records who scanned, from where, and which window the code belonged to', async () => {
    const { payload } = await onScreen();
    await scan(payload);

    const [event] = await scans();
    const [token] = await tokenRows();
    expect(event).toMatchObject({
      outcome: 'VALID',
      employee_id: employee.id,
      qr_token_id: token!.id,
      device_id: null,
      verification_id: null,
    });
    expect(event!.ip).toBe('127.0.0.1');
    expect(token).toMatchObject({ office_id: officeId });
    expect(token!.valid_from).toEqual(at(0));
    expect(token!.expires_at).toEqual(at(ROTATION));
    expect(token!.accept_until).toEqual(at(ROTATION + QR_GRACE_SECONDS));
  });

  it('keeps only a hash of the code, never the code itself', async () => {
    const { payload } = await onScreen();
    await scan(payload);

    const [token] = await tokenRows();
    expect(token!.hash).toBe(sha256Hex(codeOf(payload)));
    expect(token!.hash).toHaveLength(64);

    const stored = await h.testDb.query<{ doc: string }>(
      `select to_jsonb(t)::text as doc from public.qr_tokens t
       union all select to_jsonb(e)::text from public.qr_scan_events e
       union all select to_jsonb(a)::text from public.audit_logs a`,
    );
    for (const row of stored) expect(row.doc).not.toContain(codeOf(payload));
  });

  it('gives each window its own token row, and reuses it for repeat scans', async () => {
    const first = await onScreen();
    await scan(first.payload);
    await scan(first.payload, tokens.colleague);
    h.clock.set(at(ROTATION));
    await scan((await onScreen()).payload);

    expect(await tokenRows()).toHaveLength(2);
    const events = await scans();
    expect(events).toHaveLength(3);
    expect(events[0]!.qr_token_id).toBe(events[1]!.qr_token_id);
    expect(events[2]!.qr_token_id).not.toBe(events[0]!.qr_token_id);
  });

  describe('timing', () => {
    it('still accepts a code for a few seconds after the screen has moved on', async () => {
      const { payload } = await onScreen();
      h.clock.set(at(ROTATION + QR_GRACE_SECONDS)); // the last accepted instant, inclusive
      const res = await scan(payload);
      expect(res.status).toBe(200);
      expect(res.body.acceptUntil).toBe(at(ROTATION + QR_GRACE_SECONDS).toISOString());
    });

    it('refuses it one millisecond after that', async () => {
      const { payload } = await onScreen();
      h.clock.set(new Date(at(ROTATION + QR_GRACE_SECONDS).getTime() + 1));
      const res = await scan(payload);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VERIFICATION_FAILED');
      expect(res.body.error.details.reasons).toEqual([
        expect.objectContaining({ code: 'QR_EXPIRED', layer: 'QR' }),
      ]);
      expect(res.body.error.details.reasons[0].hint).toMatch(/office screen/);
    });

    it('records the expired scan against the (genuine) code it was', async () => {
      const { payload } = await onScreen();
      h.clock.set(at(10 * 60));
      await scan(payload);

      const [event] = await scans();
      const [token] = await tokenRows();
      expect(event).toMatchObject({ outcome: 'EXPIRED', qr_token_id: token!.id });
    });

    it('accepts the next code slightly early, to absorb clock drift on the display', async () => {
      const next = (await onScreen()).next.payload;
      h.clock.set(at(ROTATION - QR_EARLY_TOLERANCE_SECONDS)); // inclusive
      expect((await scan(next)).status).toBe(200);
    });

    it('refuses a code from further ahead than that: it is not a code that exists yet', async () => {
      const next = (await onScreen()).next.payload;
      h.clock.set(new Date(at(ROTATION - QR_EARLY_TOLERANCE_SECONDS).getTime() - 1));
      const res = await scan(next);
      expect(res.status).toBe(422);
      expect(res.body.error.details.reasons[0].code).toBe('QR_INVALID');
    });

    it('refuses codes from windows far in the future that nobody could have seen', async () => {
      const index = windowIndexAt(at(0), ROTATION);
      const res = await scan(mint(index + 1000));
      expect(res.status).toBe(422);
      expect(res.body.error.details.reasons[0].code).toBe('QR_INVALID');
      expect(await tokenRows()).toHaveLength(0);
    });
  });

  describe('forgeries', () => {
    const index = () => windowIndexAt(at(0), ROTATION);

    const forgeries: Array<[string, () => string]> = [
      ['signed with another secret', () => mint(index(), { secret: 'x'.repeat(40) })],
      ['issued for a different office', () => mint(index(), { officeId: randomUUID() })],
      ['derived with another rotation period', () => mint(index(), { rotationSeconds: 60 })],
      [
        'a genuine code with the window number changed',
        () => `TG1.${index() + 1}.${codeOf(mint(index()))}`,
      ],
      [
        'a genuine code with one character changed',
        () => {
          const genuine = mint(index());
          const position = genuine.length - 20;
          const replacement = genuine[position] === 'A' ? 'B' : 'A';
          return genuine.slice(0, position) + replacement + genuine.slice(position + 1);
        },
      ],
      ['an unrelated string', () => 'hello'],
      ['a URL', () => 'https://example.com/?c=TG1.1.' + 'a'.repeat(43)],
      ['the right shape, wrong prefix', () => mint(index()).replace('TG1', 'TG2')],
      ['a short code', () => `TG1.${index()}.abc`],
      ['a long code', () => `${mint(index())}extra`],
      [
        'a window number with leading zeros',
        () => mint(index()).replace(`.${index()}.`, `.0${index()}.`),
      ],
      ['a negative window number', () => `TG1.-5.${'a'.repeat(43)}`],
      ['whitespace around a genuine code', () => ` ${mint(index())} `],
      ['a code with a newline', () => `${mint(index())}\n`],
    ];

    it.each(forgeries)('rejects %s', async (_label, make) => {
      const res = await scan(make());
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VERIFICATION_FAILED');
      expect(res.body.error.details.reasons).toEqual([
        expect.objectContaining({ code: 'QR_INVALID', layer: 'QR' }),
      ]);
    });

    it('records the attempt, but creates no token for something that was never issued', async () => {
      await scan(mint(index(), { secret: 'x'.repeat(40) }));
      expect(await tokenRows()).toHaveLength(0);
      const [event] = await scans();
      expect(event).toMatchObject({
        outcome: 'UNKNOWN',
        employee_id: employee.id,
        qr_token_id: null,
      });
    });

    it('accepts one spelling of a code only, so it can never answer to two token identities', async () => {
      // The final base64url character has spare bits: several spellings decode to the same bytes.
      const genuine = (await onScreen()).payload;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const spellings = [...alphabet].map((ch) => genuine.slice(0, -1) + ch);

      const statuses = new Map<string, number>();
      for (const spelling of spellings) statuses.set(spelling, (await scan(spelling)).status);

      expect([...statuses].filter(([, status]) => status === 200).map(([s]) => s)).toEqual([
        genuine,
      ]);
      expect(await tokenRows()).toHaveLength(1);
    });

    it('gives a forger no hint about how close they were', async () => {
      const wrongSecret = await scan(mint(index(), { secret: 'x'.repeat(40) }));
      const nonsense = await scan('hello');
      expect(wrongSecret.body.error).toEqual({
        ...nonsense.body.error,
        requestId: expect.any(String),
      });
    });
  });

  describe('replay (one use per person, as agreed for a shared screen)', () => {
    /** What a completed check-in leaves behind: the scan marked ACCEPTED for that person. */
    async function markUsed(who: Account, payload: string) {
      const [token] = await h.testDb.query<{ id: string }>(
        "select id from public.qr_tokens where token_hash = decode($1, 'hex')",
        [sha256Hex(codeOf(payload))],
      );
      await h.testDb.query(
        `insert into public.qr_scan_events (qr_token_id, employee_id, outcome, client_ip)
         values ($1, $2, 'ACCEPTED', '127.0.0.1')`,
        [token!.id, who.id],
      );
    }

    it('tells a person who already used a code that they have, and why it is not an error in the code', async () => {
      const { payload } = await onScreen();
      await scan(payload); // creates the token
      await markUsed(employee, payload);

      const res = await scan(payload);
      expect(res.status).toBe(422);
      expect(res.body.error.details.reasons).toEqual([
        expect.objectContaining({ code: 'QR_REPLAYED', layer: 'QR' }),
      ]);
      expect(res.body.error.details.reasons[0].hint).toMatch(/new code/);
      expect((await scans()).at(-1)!.outcome).toBe('REPLAYED');
    });

    it('does not stop a colleague using the very same code a moment later', async () => {
      const { payload } = await onScreen();
      await scan(payload);
      await markUsed(employee, payload);

      expect((await scan(payload, tokens.colleague)).status).toBe(200);
    });

    it('still applies inside the grace period', async () => {
      const { payload } = await onScreen();
      await scan(payload);
      await markUsed(employee, payload);
      h.clock.set(at(ROTATION + 5));

      expect((await scan(payload)).body.error.details.reasons[0].code).toBe('QR_REPLAYED');
    });

    it('reports an expired code as expired even if it was used', async () => {
      const { payload } = await onScreen();
      await scan(payload);
      await markUsed(employee, payload);
      h.clock.set(at(10 * 60));

      expect((await scan(payload)).body.error.details.reasons[0].code).toBe('QR_EXPIRED');
    });

    it('is enforced by the database too: a second ACCEPTED scan of one code by one person cannot exist', async () => {
      const { payload } = await onScreen();
      await scan(payload);
      await markUsed(employee, payload);
      await expect(markUsed(employee, payload)).rejects.toThrow(/qr_scan_events_one_accept/);
    });
  });

  describe('request validation', () => {
    beforeEach(async () => {
      // Make "nothing was recorded" meaningful.
      expect(await scans()).toHaveLength(0);
    });

    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['an empty payload', { payload: '' }],
      ['a non-string payload', { payload: 12345 }],
      ['a null payload', { payload: null }],
      ['an enormous payload', { payload: 'A'.repeat(201) }],
      ['unexpected extra fields', { payload: 'TG1.1.x', admin: true }],
    ] as const)('answers %s with a 400 and records nothing', async (_label, body) => {
      const call = request(h.app).post('/api/office/qr/verify').set(bearer(tokens.employee));
      const res = await (body === undefined ? call : call.send(body));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await scans()).toHaveLength(0);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(h.app)
        .post('/api/office/qr/verify')
        .set(bearer(tokens.employee))
        .set('Content-Type', 'application/json')
        .send('{"payload": ');
      expect(res.status).toBe(400);
      expect(await scans()).toHaveLength(0);
    });
  });
});

describe('rate limiting', () => {
  beforeEach(() => configureOffice());

  it('limits how fast one person can fire scans at the server, per person not per address', async () => {
    h.app = h.build({ env: { USER_RATE_LIMIT_PER_MIN: '10' } });
    const { payload } = await onScreen();

    for (let i = 0; i < 10; i += 1) expect((await scan(payload)).status).toBe(200);
    const limited = await scan(payload);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();

    // A colleague on the very same address is unaffected.
    expect((await scan(payload, tokens.colleague)).status).toBe(200);
  });
});

describe('log hygiene', () => {
  beforeEach(() => configureOffice());

  it('never writes scanned or displayed codes to the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const env = h.envWith({ NODE_ENV: 'development', LOG_LEVEL: 'trace' });
    h.app = h.build({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' },
      logger: createLogger(env, sink),
    });

    const shown = await onScreen();
    const forged = mint(windowIndexAt(at(0), ROTATION), { secret: 'x'.repeat(40) });
    await scan(shown.payload);
    await scan(forged);
    h.clock.set(at(10 * 60));
    await scan(shown.payload);

    const logs = lines.join('');
    expect(logs).toContain('/api/office/qr/verify'); // the logger was genuinely active
    for (const secret of [shown.payload, shown.next.payload, forged]) {
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(codeOf(secret));
    }
  });
});
