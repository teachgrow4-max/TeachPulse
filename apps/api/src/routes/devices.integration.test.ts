import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { registrationProofMessage, verificationProofMessage } from '@teachgrow/shared';
import { issueChallenge } from '../devices/challenges.js';
import { createLogger } from '../lib/logger.js';
import {
  type Account,
  WEB_ORIGIN,
  accessTokenFor,
  allAuditJson,
  auditRows,
  bearer,
  createAccount,
  mobileLogin,
  useApi,
} from '../testing/api-harness.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { SoftwareDevice } from '../testing/software-device.js';

const h = useApi();

const RP_ID = 'app.test';
const NOW_MS = Date.parse('2026-11-02T04:30:00Z');

let employee: Account;
let colleague: Account;
let admin: Account; // does not mark attendance
let tok: { employee: string; colleague: string; admin: string };

beforeEach(async () => {
  employee = await createAccount(h);
  colleague = await createAccount(h);
  admin = await createAccount(h, { role: 'admin', attendanceRequired: false });
  tok = {
    employee: await accessTokenFor(h, employee),
    colleague: await accessTokenFor(h, colleague),
    admin: await accessTokenFor(h, admin),
  };
});

const get = (path: string, t = tok.employee) => request(h.app).get(path).set(bearer(t));
const post = (path: string, body: object = {}, t = tok.employee) =>
  request(h.app).post(path).set(bearer(t)).send(body);
const del = (path: string, t = tok.employee) => request(h.app).delete(path).set(bearer(t));

const authenticator = (
  options: Partial<ConstructorParameters<typeof SoftwareAuthenticator>[0]> = {},
) => new SoftwareAuthenticator({ origin: WEB_ORIGIN, rpId: RP_ID, ...options });

// ---- enrolment helpers ------------------------------------------------------------------------

interface Enrolled {
  id: string;
  res: request.Response;
}

async function challengeFor(platform: 'ANDROID' | 'IOS' | 'WEB', t = tok.employee) {
  const res = await post('/api/devices/register/options', { platform }, t);
  expect(res.status).toBe(200);
  return res.body as {
    challengeId: string;
    challenge: string;
    expiresAt: string;
    webauthn?: { challenge: string; rp: { id: string; name: string } };
  };
}

async function enrolPhone(
  opts: {
    who?: Account;
    token?: string;
    phone?: SoftwareDevice;
    name?: string;
    platform?: 'ANDROID' | 'IOS';
  } = {},
): Promise<Enrolled & { phone: SoftwareDevice }> {
  const who = opts.who ?? employee;
  const token = opts.token ?? tok.employee;
  const phone = opts.phone ?? new SoftwareDevice();
  const platform = opts.platform ?? 'ANDROID';
  const c = await challengeFor(platform, token);
  const res = await post(
    '/api/devices/register',
    phone.registrationBody({
      challengeId: c.challengeId,
      challenge: c.challenge,
      employeeId: who.id,
      password: who.password,
      platform,
      name: opts.name ?? 'Test phone',
    }),
    token,
  );
  return { phone, res, id: res.body.device?.id };
}

async function enrolBrowser(
  opts: { who?: Account; token?: string; passkey?: SoftwareAuthenticator; name?: string } = {},
): Promise<Enrolled & { passkey: SoftwareAuthenticator }> {
  const who = opts.who ?? employee;
  const token = opts.token ?? tok.employee;
  const passkey = opts.passkey ?? authenticator();
  const c = await challengeFor('WEB', token);
  const res = await post(
    '/api/devices/register',
    {
      challengeId: c.challengeId,
      platform: 'WEB',
      deviceName: opts.name ?? 'Test browser',
      currentPassword: who.password,
      webauthn: passkey.register({ challenge: c.webauthn!.challenge }),
    },
    token,
  );
  return { passkey, res, id: res.body.device?.id };
}

// ---- database peeks ---------------------------------------------------------------------------

interface DeviceDbRow {
  id: string;
  employee_id: string;
  device_identifier: string;
  platform: string;
  device_name: string | null;
  status: string;
  public_key: string | null;
  credential_id: string | null;
  attestation_provider: string | null;
  attestation_verified_at: Date | null;
  attestation_counter: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}
const deviceRows = () =>
  h.testDb.query<DeviceDbRow>(
    `select id, employee_id, device_identifier, platform::text as platform, device_name,
            status::text as status, public_key, credential_id, attestation_provider,
            attestation_verified_at, attestation_counter::text as attestation_counter,
            approved_by, approved_at, revoked_at, revoked_by, revoked_reason
     from public.registered_devices order by registered_at, id`,
  );
const challengeRows = (userId = employee.id) =>
  h.testDb.query<{
    purpose: string;
    platform: string | null;
    device_id: string | null;
    bytes: number;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `select purpose, platform::text as platform, device_id, octet_length(challenge) as bytes,
            expires_at, consumed_at
     from public.device_challenges where user_id = $1 order by created_at, id`,
    [userId],
  );

// ================================================================================================

describe('who may manage devices', () => {
  const id = randomUUID();
  const routes: Array<[string, string, object | undefined]> = [
    ['get', '/api/devices', undefined],
    ['post', '/api/devices/register/options', { platform: 'ANDROID' }],
    ['post', '/api/devices/register', {}],
    ['delete', `/api/devices/${id}`, undefined],
  ];
  const call = (method: string, path: string, body: object | undefined, t?: string) => {
    let r = request(h.app)[method as 'get'](path);
    if (t) r = r.set(bearer(t));
    return body ? r.send(body) : r;
  };

  it.each(routes)('%s %s needs a signed-in user', async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(401);
  });

  it.each(routes)(
    '%s %s is closed to accounts that do not mark attendance',
    async (method, path, body) => {
      expect((await call(method, path, body, tok.admin)).status).toBe(403);
    },
  );

  it('is closed to the office display account', async () => {
    const kiosk = await createAccount(h, { role: 'office_display' });
    const res = await get('/api/devices', await accessTokenFor(h, kiosk));
    expect(res.status).toBe(403);
  });

  it('is open to an administrator who does mark attendance', async () => {
    const tracked = await createAccount(h, { role: 'admin', attendanceRequired: true });
    expect((await get('/api/devices', await accessTokenFor(h, tracked))).status).toBe(200);
  });

  it.each([
    ['get', '/api/admin/devices', undefined],
    ['post', `/api/admin/devices/${id}/approve`, {}],
    ['post', `/api/admin/devices/${id}/revoke`, { reason: 'Lost phone' }],
  ])('%s %s is for administrators only', async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(401);
    expect((await call(method, path, body, tok.employee)).status).toBe(403);
  });
});

describe('registration step 1: the challenge', () => {
  it('issues a one-time challenge for an app, with nothing browser-specific in it', async () => {
    const res = await post('/api/devices/register/options', { platform: 'ANDROID' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.expiresAt).toBe(new Date(NOW_MS + 300_000).toISOString());
    expect(res.body.webauthn).toBeUndefined();

    const [row] = await challengeRows();
    expect(row).toMatchObject({
      purpose: 'REGISTER',
      platform: 'ANDROID',
      device_id: null,
      bytes: 32,
      consumed_at: null,
    });
  });

  it('never repeats a challenge', async () => {
    const seen = new Set<string>();
    for (const platform of ['ANDROID', 'IOS', 'ANDROID', 'IOS'] as const) {
      seen.add((await challengeFor(platform)).challenge);
    }
    expect(seen.size).toBe(4);
  });

  it('gives a browser the passkey creation options, tied to the same challenge', async () => {
    const res = await post('/api/devices/register/options', { platform: 'WEB' });
    const options = res.body.webauthn;
    expect(options.challenge).toBe(res.body.challenge);
    expect(options.rp).toEqual({ id: RP_ID, name: 'TeachGrow Attendance' });
    expect(options.user.name).toBe(employee.email);
    expect(options.user.displayName).toBe(employee.fullName);
    // The handle stored on the authenticator is opaque: not the email, not the name.
    expect(Buffer.from(options.user.id, 'base64url').toString()).toBe(employee.id);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'platform',
      userVerification: 'required',
    });
    expect(options.excludeCredentials ?? []).toEqual([]);
  });

  it('tells the browser which passkeys this person already has, so it cannot enrol one twice', async () => {
    const { passkey } = await enrolBrowser();
    const options = (await challengeFor('WEB')).webauthn as {
      excludeCredentials?: Array<{ id: string }>;
    };
    expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: passkey.id })]);
  });

  it('retires the previous challenge when a new one is requested', async () => {
    const first = await challengeFor('ANDROID');
    await challengeFor('ANDROID');
    const phone = new SoftwareDevice();
    const res = await post(
      '/api/devices/register',
      phone.registrationBody({
        challengeId: first.challengeId,
        challenge: first.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHALLENGE_INVALID');
    expect(await deviceRows()).toHaveLength(0);
  });

  it.each([
    ['an unknown platform', { platform: 'WINDOWS' }],
    ['no platform', {}],
    ['extra fields', { platform: 'ANDROID', admin: true }],
  ])('answers %s with a 400', async (_label, body) => {
    const res = await post('/api/devices/register/options', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await challengeRows()).toHaveLength(0);
  });
});

describe('registering a phone', () => {
  it('enrols it as PENDING, and says the platform has not vouched for the app yet', async () => {
    const { res, phone } = await enrolPhone({ name: 'Pixel 8' });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/devices/${res.body.device.id}`);
    expect(res.body.device).toEqual({
      id: expect.any(String),
      platform: 'ANDROID',
      name: 'Pixel 8',
      status: 'PENDING',
      attestationProvider: 'NONE',
      registeredAt: new Date(NOW_MS).toISOString(),
      approvedAt: null,
      lastSeenAt: null,
      revokedAt: null,
    });

    const [row] = await deviceRows();
    expect(row).toMatchObject({
      employee_id: employee.id,
      platform: 'ANDROID',
      status: 'PENDING',
      public_key: phone.publicKey,
      credential_id: null,
      attestation_provider: 'NONE',
      attestation_verified_at: null,
      approved_at: null,
    });
  });

  it('stores a hash of the device identifier, never the identifier', async () => {
    const { phone } = await enrolPhone();
    const [row] = await deviceRows();
    expect(row!.device_identifier).toMatch(/^app:[A-Za-z0-9_-]{43}$/);
    expect(row!.device_identifier).not.toContain(phone.identifier);
  });

  it('works the same for an iPhone', async () => {
    const { res } = await enrolPhone({ platform: 'IOS' });
    expect(res.status).toBe(201);
    expect(res.body.device.platform).toBe('IOS');
  });

  it('writes an audit entry that mentions neither keys nor signatures', async () => {
    const { phone } = await enrolPhone({ name: 'Pixel 8' });
    const [entry] = await auditRows(h, 'device.register');
    expect(entry).toMatchObject({
      actor_id: employee.id,
      actor_role: 'employee',
      entity_type: 'device',
      after_data: { status: 'PENDING' },
      metadata: { platform: 'ANDROID', name: 'Pixel 8', attestation: 'NONE' },
    });
    const everything = await allAuditJson(h);
    expect(everything).not.toContain(phone.publicKey);
    expect(everything).not.toContain(phone.identifier);
  });

  it('spends the challenge: it cannot be used a second time', async () => {
    const c = await challengeFor('ANDROID');
    const phone = new SoftwareDevice();
    const body = phone.registrationBody({
      challengeId: c.challengeId,
      challenge: c.challenge,
      employeeId: employee.id,
      password: employee.password,
    });
    expect((await post('/api/devices/register', body)).status).toBe(201);

    const again = await post('/api/devices/register', body);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('CHALLENGE_INVALID');
    expect(await deviceRows()).toHaveLength(1);
  });

  it('refuses an expired challenge', async () => {
    const c = await challengeFor('ANDROID');
    h.clock.set(new Date(NOW_MS + 301_000));
    const res = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(await deviceRows()).toHaveLength(0);
  });

  it('accepts it right up to the moment it expires', async () => {
    const c = await challengeFor('ANDROID');
    h.clock.set(new Date(NOW_MS + 299_000));
    const res = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("will not use someone else's challenge, and does not say it exists", async () => {
    const theirs = await challengeFor('ANDROID', tok.colleague);
    const res = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: theirs.challengeId,
        challenge: theirs.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHALLENGE_INVALID');
    // ...and the colleague's challenge was not burned by the attempt.
    expect((await challengeRows(colleague.id))[0]!.consumed_at).toBeNull();
  });

  it('will not use a challenge issued for another platform, or one that does not exist', async () => {
    const web = await challengeFor('WEB');
    const wrongPlatform = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: web.challengeId,
        challenge: web.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(wrongPlatform.body.error.code).toBe('CHALLENGE_INVALID');

    const unknown = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: randomUUID(),
        challenge: 'c'.repeat(43),
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(unknown.body.error.code).toBe('CHALLENGE_INVALID');
  });

  describe('the password check', () => {
    it('refuses a wrong password, creates nothing, and leaves the challenge usable', async () => {
      const c = await challengeFor('ANDROID');
      const phone = new SoftwareDevice();
      const body = phone.registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: 'Not-My-Passw0rd!',
      });
      const wrong = await post('/api/devices/register', body);
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(await deviceRows()).toHaveLength(0);
      expect((await challengeRows())[0]!.consumed_at).toBeNull();

      // A typo does not cost the person their challenge: the same one works with the right password.
      const right = await post('/api/devices/register', {
        ...body,
        currentPassword: employee.password,
      });
      expect(right.status).toBe(201);
    });

    it('counts wrong passwords towards the sign-in lockout, so it is not a guessing oracle', async () => {
      const c = await challengeFor('ANDROID');
      const body = new SoftwareDevice().registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: 'Not-My-Passw0rd!',
      });
      for (let i = 0; i < h.env.LOGIN_MAX_FAILURES; i += 1) {
        expect((await post('/api/devices/register', body)).status).toBe(401);
      }
      const locked = await post('/api/devices/register', {
        ...body,
        currentPassword: employee.password,
      });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(await deviceRows()).toHaveLength(0);
      // The lockout is the account's: signing in is blocked too.
      expect((await mobileLogin(h, employee)).status).toBe(429);
    });

    it('leaves no session behind from the check', async () => {
      const before = await h.testDb.query('select 1 from auth.sessions where user_id = $1', [
        employee.id,
      ]);
      await enrolPhone();
      const after = await h.testDb.query('select 1 from auth.sessions where user_id = $1', [
        employee.id,
      ]);
      expect(after).toHaveLength(before.length);
    });

    it('is required: a body without it is a 400', async () => {
      const c = await challengeFor('ANDROID');
      const { currentPassword: _omitted, ...withoutPassword } =
        new SoftwareDevice().registrationBody({
          challengeId: c.challengeId,
          challenge: c.challenge,
          employeeId: employee.id,
          password: 'x',
        });
      const res = await post('/api/devices/register', withoutPassword);
      expect(res.status).toBe(400);
    });
  });

  describe('proof that the phone holds the key', () => {
    /** Registers with a signature built by `sign`, which receives the pieces of the message. */
    async function registerSigned(
      sign: (m: { challenge: string; phone: SoftwareDevice }) => string,
      overrides: { appKeyPublicKey?: (phone: SoftwareDevice) => string } = {},
    ) {
      const c = await challengeFor('ANDROID');
      const phone = new SoftwareDevice();
      const body = phone.registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: employee.password,
      });
      body.appKey.signature = sign({ challenge: c.challenge, phone });
      if (overrides.appKeyPublicKey) body.appKey.publicKey = overrides.appKeyPublicKey(phone);
      return { c, phone, body, res: await post('/api/devices/register', body) };
    }
    const message = (m: { challenge: string; phone: SoftwareDevice }, over: object = {}) =>
      registrationProofMessage({
        challenge: m.challenge,
        employeeId: employee.id,
        platform: 'ANDROID',
        deviceIdentifier: m.phone.identifier,
        ...over,
      });

    it.each([
      [
        'for a different challenge',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          m.phone.signMessage(message(m, { challenge: 'x'.repeat(43) })),
      ],
      [
        'for a different employee',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          m.phone.signMessage(message(m, { employeeId: colleague.id })),
      ],
      [
        'for a different platform',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          m.phone.signMessage(message(m, { platform: 'IOS' })),
      ],
      [
        'for a different device identifier',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          m.phone.signMessage(message(m, { deviceIdentifier: 'some-other-identifier-0123456789' })),
      ],
      [
        'by a different key',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          new SoftwareDevice().signMessage(message(m)),
      ],
      [
        'over a check-in message instead',
        (m: { challenge: string; phone: SoftwareDevice }) =>
          m.phone.signMessage(
            verificationProofMessage({
              challenge: m.challenge,
              employeeId: employee.id,
              deviceId: randomUUID(),
              purpose: 'CHECK_IN',
            }),
          ),
      ],
    ])('rejects a signature made %s', async (_label, sign) => {
      const { res } = await registerSigned(sign);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DEVICE_PROOF_INVALID');
      expect(await deviceRows()).toHaveLength(0);
    });

    it('spends the challenge even though the proof was bad, so signatures cannot be ground out', async () => {
      const { c, phone, body } = await registerSigned(() => 'A'.repeat(86));
      const retry = await post('/api/devices/register', {
        ...body,
        appKey: {
          publicKey: phone.publicKey,
          signature: phone.signMessage(
            registrationProofMessage({
              challenge: c.challenge,
              employeeId: employee.id,
              platform: 'ANDROID',
              deviceIdentifier: phone.identifier,
            }),
          ),
        },
      });
      expect(retry.status).toBe(422);
      expect(retry.body.error.code).toBe('CHALLENGE_INVALID');
    });

    it('accepts the right signature (the control for the cases above)', async () => {
      const { res } = await registerSigned((m) => m.phone.signMessage(message(m)));
      expect(res.status).toBe(201);
    });

    it.each([
      ['an Ed25519 public key', () => publicKeyOfAnotherKind('ed25519')],
      ['a P-384 public key', () => publicKeyOfAnotherKind('p384')],
      ['text that is not a key', () => 'bm90LWEta2V5LW5vdC1hLWtleQ'],
    ])('rejects %s', async (_label, key) => {
      const { res } = await registerSigned((m) => m.phone.signMessage(message(m)), {
        appKeyPublicKey: () => key(),
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DEVICE_PROOF_INVALID');
    });
  });

  describe('the request itself', () => {
    const valid = () =>
      challengeFor('ANDROID').then((c) =>
        new SoftwareDevice().registrationBody({
          challengeId: c.challengeId,
          challenge: c.challenge,
          employeeId: employee.id,
          password: employee.password,
        }),
      );

    it.each([
      [
        'a device key that is far too large to be P-256 (RSA)',
        (b: Record<string, unknown>) => ({
          ...b,
          appKey: { ...(b.appKey as object), publicKey: publicKeyOfAnotherKind('rsa') },
        }),
      ],
      ['no device key', (b: Record<string, unknown>) => ({ ...b, appKey: undefined })],
      [
        'no device identifier',
        (b: Record<string, unknown>) => ({ ...b, deviceIdentifier: undefined }),
      ],
      [
        'a device identifier that is too short',
        (b: Record<string, unknown>) => ({ ...b, deviceIdentifier: 'short' }),
      ],
      [
        'a passkey where an app key belongs',
        (b: Record<string, unknown>) => ({ ...b, webauthn: {} }),
      ],
      [
        'a signature of the wrong length',
        (b: Record<string, unknown>) => ({
          ...b,
          appKey: { ...(b.appKey as object), signature: 'AAAA' },
        }),
      ],
      [
        'a device name that is too long',
        (b: Record<string, unknown>) => ({ ...b, deviceName: 'x'.repeat(101) }),
      ],
      ['an unexpected field', (b: Record<string, unknown>) => ({ ...b, status: 'ACTIVE' })],
      [
        'a challenge id that is not a UUID',
        (b: Record<string, unknown>) => ({ ...b, challengeId: 'nope' }),
      ],
    ])('answers %s with a 400 and creates nothing', async (_label, mutate) => {
      const res = await post('/api/devices/register', mutate(await valid()));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await deviceRows()).toHaveLength(0);
    });

    it('cannot be used to pick its own status or owner', async () => {
      const body = { ...(await valid()), status: 'ACTIVE', employeeId: colleague.id };
      expect((await post('/api/devices/register', body)).status).toBe(400);
      expect(await deviceRows()).toHaveLength(0);
    });
  });

  describe('one physical device, one person at a time', () => {
    it('refuses the same phone registered twice by the same person', async () => {
      const phone = new SoftwareDevice();
      expect((await enrolPhone({ phone })).res.status).toBe(201);
      const again = await enrolPhone({ phone });
      expect(again.res.status).toBe(409);
      expect(again.res.body.error.code).toBe('DEVICE_ALREADY_REGISTERED');
      expect(await deviceRows()).toHaveLength(1);
    });

    it("refuses a colleague registering a phone that is already someone's", async () => {
      const phone = new SoftwareDevice();
      await enrolPhone({ phone });
      const theirs = await enrolPhone({ phone, who: colleague, token: tok.colleague });
      expect(theirs.res.status).toBe(409);
      expect(theirs.res.body.error.code).toBe('DEVICE_ALREADY_REGISTERED');
    });

    it('frees the phone once it has been removed', async () => {
      const phone = new SoftwareDevice();
      const first = await enrolPhone({ phone });
      await del(`/api/devices/${first.id}`);
      const second = await enrolPhone({ phone, who: colleague, token: tok.colleague });
      expect(second.res.status).toBe(201);
    });
  });
});

describe('registering a browser (platform passkey)', () => {
  it('enrols it as PENDING and keeps the public half of the passkey', async () => {
    const { res, passkey } = await enrolBrowser({ name: 'Work laptop' });
    expect(res.status).toBe(201);
    expect(res.body.device).toMatchObject({
      platform: 'WEB',
      name: 'Work laptop',
      status: 'PENDING',
      attestationProvider: 'WEBAUTHN',
    });
    const [row] = await deviceRows();
    expect(row).toMatchObject({
      platform: 'WEB',
      credential_id: passkey.id,
      attestation_provider: 'WEBAUTHN',
      attestation_counter: '0',
    });
    expect(row!.attestation_verified_at).toEqual(new Date(NOW_MS));
    expect(row!.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row!.device_identifier).toMatch(/^web:[A-Za-z0-9_-]{43}$/);
    expect(row!.device_identifier).not.toContain(passkey.id);
  });

  it('records whether the passkey is synced across devices, so administrators can judge it', async () => {
    await enrolBrowser({ passkey: authenticator({ backupEligible: true, backedUp: true }) });
    const [entry] = await auditRows(h, 'device.register');
    expect(entry!.metadata).toMatchObject({
      attestation: 'WEBAUTHN',
      synced_across_devices: true,
      backed_up: true,
    });
  });

  it('records a hardware-bound passkey as such', async () => {
    await enrolBrowser();
    const [entry] = await auditRows(h, 'device.register');
    expect(entry!.metadata).toMatchObject({ synced_across_devices: false, backed_up: false });
  });

  it.each([
    ['a different website', () => authenticator({ origin: 'https://evil.test' })],
    ['a different relying party id', () => authenticator({ rpId: 'evil.test' })],
    ['no screen lock / biometric check', () => authenticator({ userVerified: false })],
    ['a separate security key or phone', () => authenticator({ attachment: 'cross-platform' })],
  ])('rejects a passkey made for %s', async (_label, make) => {
    const { res } = await enrolBrowser({ passkey: make() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEVICE_PROOF_INVALID');
    expect(await deviceRows()).toHaveLength(0);
  });

  it('rejects a passkey created for a different challenge', async () => {
    const c = await challengeFor('WEB');
    const other = await challengeFor('WEB'); // retires the first, but we sign for it anyway
    const res = await post('/api/devices/register', {
      challengeId: other.challengeId,
      platform: 'WEB',
      currentPassword: employee.password,
      webauthn: authenticator().register({ challenge: c.webauthn!.challenge }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEVICE_PROOF_INVALID');
  });

  it('rejects a replayed registration', async () => {
    const c = await challengeFor('WEB');
    const body = {
      challengeId: c.challengeId,
      platform: 'WEB',
      currentPassword: employee.password,
      webauthn: authenticator().register({ challenge: c.webauthn!.challenge }),
    };
    expect((await post('/api/devices/register', body)).status).toBe(201);
    const again = await post('/api/devices/register', body);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('CHALLENGE_INVALID');
  });

  it('refuses the same passkey registered twice, by anyone', async () => {
    const passkey = authenticator();
    expect((await enrolBrowser({ passkey })).res.status).toBe(201);
    const again = await enrolBrowser({ passkey, who: colleague, token: tok.colleague });
    expect(again.res.status).toBe(409);
    expect(again.res.body.error.code).toBe('DEVICE_ALREADY_REGISTERED');
  });

  it('needs a passkey, and refuses an app key, for a browser', async () => {
    const c = await challengeFor('WEB');
    const phone = new SoftwareDevice();
    const asApp = phone.registrationBody({
      challengeId: c.challengeId,
      challenge: c.challenge,
      employeeId: employee.id,
      password: employee.password,
    });
    expect((await post('/api/devices/register', { ...asApp, platform: 'WEB' })).status).toBe(400);
    const { appKey: _a, deviceIdentifier: _d, ...bare } = asApp;
    expect((await post('/api/devices/register', { ...bare, platform: 'WEB' })).status).toBe(400);
  });

  it('checks the password first, like every other registration', async () => {
    const c = await challengeFor('WEB');
    const res = await post('/api/devices/register', {
      challengeId: c.challengeId,
      platform: 'WEB',
      currentPassword: 'Not-My-Passw0rd!',
      webauthn: authenticator().register({ challenge: c.webauthn!.challenge }),
    });
    expect(res.status).toBe(401);
    expect(await deviceRows()).toHaveLength(0);
  });
});

describe('how many devices one person may have', () => {
  it('defaults to two, counting pending ones, and says so before asking for anything', async () => {
    expect((await enrolPhone()).res.status).toBe(201);
    expect((await enrolBrowser()).res.status).toBe(201);

    const res = await post('/api/devices/register/options', { platform: 'ANDROID' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_LIMIT_REACHED');
    expect(res.body.error.message).toMatch(/up to 2 registered devices/);
  });

  it('enforces it at registration too, not only when the challenge is requested', async () => {
    // Two other tabs took the last slots after this challenge was issued.
    const c = await challengeFor('ANDROID');
    for (const identifier of ['app:taken-slot-one-0123456789', 'app:taken-slot-two-0123456789']) {
      await h.testDb.query(
        `insert into public.registered_devices (employee_id, device_identifier, platform)
         values ($1, $2, 'ANDROID')`,
        [employee.id, identifier],
      );
    }
    const res = await post(
      '/api/devices/register',
      new SoftwareDevice().registrationBody({
        challengeId: c.challengeId,
        challenge: c.challenge,
        employeeId: employee.id,
        password: employee.password,
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_LIMIT_REACHED');
    expect(await deviceRows()).toHaveLength(2);
  });

  it('frees a slot when a device is removed', async () => {
    const first = await enrolPhone();
    await enrolBrowser();
    await del(`/api/devices/${first.id}`);
    expect((await enrolPhone()).res.status).toBe(201);
  });

  it('is counted per person', async () => {
    await enrolPhone();
    await enrolBrowser();
    expect((await enrolPhone({ who: colleague, token: tok.colleague })).res.status).toBe(201);
  });

  it('follows the limit the policy sets', async () => {
    await h.testDb.query('update public.attendance_policies set max_devices_per_employee = 1');
    await enrolPhone();
    const res = await post('/api/devices/register/options', { platform: 'IOS' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/up to 1 registered device\./);
  });
});

describe("an employee's own devices", () => {
  it('lists their devices, newest first, removed ones last', async () => {
    const phone = await enrolPhone({ name: 'Old phone' });
    h.clock.set(new Date(NOW_MS + 60_000));
    await enrolBrowser({ name: 'Laptop' });
    await del(`/api/devices/${phone.id}`);

    const res = await get('/api/devices');
    expect(res.status).toBe(200);
    expect(res.body.items.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual(
      [
        ['Laptop', 'PENDING'],
        ['Old phone', 'REVOKED'],
      ],
    );
  });

  it("shows only the caller's devices", async () => {
    await enrolPhone({ who: colleague, token: tok.colleague });
    expect((await get('/api/devices')).body.items).toEqual([]);
  });

  it('exposes nothing that identifies the key or the hardware', async () => {
    await enrolPhone();
    await enrolBrowser();
    const [device] = (await get('/api/devices')).body.items;
    expect(Object.keys(device).sort()).toEqual([
      'approvedAt',
      'attestationProvider',
      'id',
      'lastSeenAt',
      'name',
      'platform',
      'registeredAt',
      'revokedAt',
      'status',
    ]);
  });

  describe('removing a device', () => {
    it('revokes it at once and records who and why', async () => {
      const { id } = await enrolPhone();
      const res = await del(`/api/devices/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.device).toMatchObject({
        id,
        status: 'REVOKED',
        revokedAt: new Date(NOW_MS).toISOString(),
      });

      const [row] = await deviceRows();
      expect(row).toMatchObject({
        status: 'REVOKED',
        revoked_by: employee.id,
        revoked_reason: 'Removed by the employee.',
      });
      const [entry] = await auditRows(h, 'device.revoke');
      expect(entry).toMatchObject({
        actor_id: employee.id,
        entity_id: id,
        before_data: { status: 'PENDING' },
        after_data: { status: 'REVOKED' },
      });
    });

    it("will not touch somebody else's device, and does not say whether it exists", async () => {
      const { id } = await enrolPhone({ who: colleague, token: tok.colleague });
      const res = await del(`/api/devices/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await deviceRows())[0]!.status).toBe('PENDING');
      expect(await auditRows(h, 'device.revoke')).toHaveLength(0);

      const unknown = await del(`/api/devices/${randomUUID()}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toEqual({ ...res.body.error, requestId: expect.any(String) });
    });

    it('says so when it was already removed', async () => {
      const { id } = await enrolPhone();
      await del(`/api/devices/${id}`);
      const again = await del(`/api/devices/${id}`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFLICT');
    });

    it('rejects an id that is not a UUID', async () => {
      expect((await del('/api/devices/not-a-uuid')).status).toBe(400);
    });

    it('voids any challenge that was waiting to be signed', async () => {
      const { id } = await enrolPhone();
      await issueChallenge(h.db, {
        userId: employee.id,
        purpose: 'CHECK_IN',
        deviceId: id,
        now: new Date(NOW_MS),
        ttlSeconds: 120,
      });
      await del(`/api/devices/${id}`);
      const live = await h.testDb.query(
        'select 1 from public.device_challenges where device_id = $1 and consumed_at is null',
        [id],
      );
      expect(live).toHaveLength(0);
    });
  });
});

describe('the administrator’s device queue', () => {
  const adminGet = (query = '') => get(`/api/admin/devices${query}`, tok.admin);
  const adminPost = (path: string, body: object = {}) => post(path, body, tok.admin);

  it('lists devices with the owner, pending approvals first', async () => {
    const old = await enrolPhone({ name: 'Approved phone' });
    await adminPost(`/api/admin/devices/${old.id}/approve`);
    h.clock.set(new Date(NOW_MS + 60_000));
    await enrolBrowser({ who: colleague, token: tok.colleague, name: 'Colleague laptop' });

    const res = await adminGet();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 50, total: 2 });
    expect(res.body.items.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual(
      [
        ['Colleague laptop', 'PENDING'],
        ['Approved phone', 'ACTIVE'],
      ],
    );
    expect(res.body.items[0].employee).toEqual({
      id: colleague.id,
      fullName: colleague.fullName,
      employeeCode: colleague.code,
    });
  });

  it('filters by employee and by status, and pages', async () => {
    await enrolPhone();
    await enrolBrowser();
    const theirs = await enrolPhone({ who: colleague, token: tok.colleague });
    await adminPost(`/api/admin/devices/${theirs.id}/approve`);

    expect((await adminGet(`?employeeId=${employee.id}`)).body.total).toBe(2);
    expect((await adminGet('?status=ACTIVE')).body.items).toHaveLength(1);
    expect((await adminGet('?status=PENDING')).body.total).toBe(2);
    const page = await adminGet('?pageSize=2&page=2');
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.body.items).toHaveLength(1);
  });

  it.each([
    ['?status=BOGUS'],
    ['?employeeId=nope'],
    ['?pageSize=0'],
    ['?pageSize=500'],
    ['?page=0'],
  ])('rejects the query %s', async (query) => {
    expect((await adminGet(query)).status).toBe(400);
  });

  describe('approving', () => {
    it('activates a pending device and records who approved it', async () => {
      const { id } = await enrolPhone();
      const res = await adminPost(`/api/admin/devices/${id}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.device).toMatchObject({
        id,
        status: 'ACTIVE',
        approvedAt: new Date(NOW_MS).toISOString(),
        employee: { id: employee.id },
      });

      const [row] = await deviceRows();
      expect(row).toMatchObject({ status: 'ACTIVE', approved_by: admin.id });
      const [entry] = await auditRows(h, 'device.approve');
      expect(entry).toMatchObject({
        actor_id: admin.id,
        actor_role: 'admin',
        entity_id: id,
        before_data: { status: 'PENDING' },
        after_data: { status: 'ACTIVE' },
        metadata: { employee_id: employee.id },
      });
    });

    it('cannot approve a device twice, or one that was removed', async () => {
      const { id } = await enrolPhone();
      await adminPost(`/api/admin/devices/${id}/approve`);
      const twice = await adminPost(`/api/admin/devices/${id}/approve`);
      expect(twice.status).toBe(409);
      expect(twice.body.error.message).toMatch(/already approved/);

      const removed = await enrolBrowser();
      await del(`/api/devices/${removed.id}`);
      const res = await adminPost(`/api/admin/devices/${removed.id}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/register it again/);
      expect(await auditRows(h, 'device.approve')).toHaveLength(1);
    });

    it('answers 404 for a device that does not exist, 400 for a bad id', async () => {
      expect((await adminPost(`/api/admin/devices/${randomUUID()}/approve`)).status).toBe(404);
      expect((await adminPost('/api/admin/devices/not-a-uuid/approve')).status).toBe(400);
    });

    it('is something an employee cannot do for themselves', async () => {
      const { id } = await enrolPhone();
      const res = await post(`/api/admin/devices/${id}/approve`, {}, tok.employee);
      expect(res.status).toBe(403);
      expect((await deviceRows())[0]!.status).toBe('PENDING');
    });
  });

  describe('revoking', () => {
    it('removes an active device and keeps the reason', async () => {
      const { id } = await enrolPhone();
      await adminPost(`/api/admin/devices/${id}/approve`);
      const res = await adminPost(`/api/admin/devices/${id}/revoke`, {
        reason: 'Phone reported lost',
      });
      expect(res.status).toBe(200);
      expect(res.body.device).toMatchObject({
        status: 'REVOKED',
        revokedReason: 'Phone reported lost',
        revokedAt: new Date(NOW_MS).toISOString(),
      });

      const [row] = await deviceRows();
      expect(row).toMatchObject({
        status: 'REVOKED',
        revoked_by: admin.id,
        revoked_reason: 'Phone reported lost',
      });
      expect(row!.approved_at).not.toBeNull(); // the history of when it was trusted is kept
      const [entry] = await auditRows(h, 'device.revoke');
      expect(entry).toMatchObject({
        actor_id: admin.id,
        before_data: { status: 'ACTIVE' },
        after_data: { status: 'REVOKED' },
        metadata: { employee_id: employee.id, reason: 'Phone reported lost' },
      });
    });

    it('can turn down a pending device', async () => {
      const { id } = await enrolPhone();
      const res = await adminPost(`/api/admin/devices/${id}/revoke`, {
        reason: 'Not a company device',
      });
      expect(res.status).toBe(200);
      expect(res.body.device.status).toBe('REVOKED');
    });

    it.each([
      ['no reason', {}],
      ['a blank reason', { reason: '   ' }],
      ['a one-letter reason', { reason: 'x' }],
      ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
      ['unexpected fields', { reason: 'Lost phone', status: 'ACTIVE' }],
    ])('insists on a proper reason (%s)', async (_label, body) => {
      const { id } = await enrolPhone();
      const res = await adminPost(`/api/admin/devices/${id}/revoke`, body);
      expect(res.status).toBe(400);
      expect((await deviceRows())[0]!.status).toBe('PENDING');
    });

    it('cannot revoke twice, and answers 404 for a stranger', async () => {
      const { id } = await enrolPhone();
      await adminPost(`/api/admin/devices/${id}/revoke`, { reason: 'Lost phone' });
      const again = await adminPost(`/api/admin/devices/${id}/revoke`, { reason: 'Lost phone' });
      expect(again.status).toBe(409);
      expect(
        (await adminPost(`/api/admin/devices/${randomUUID()}/revoke`, { reason: 'Lost phone' }))
          .status,
      ).toBe(404);
    });

    it('is something an employee cannot do, even to their own device with a reason', async () => {
      const { id } = await enrolPhone();
      const res = await post(
        `/api/admin/devices/${id}/revoke`,
        { reason: 'Lost phone' },
        tok.employee,
      );
      expect(res.status).toBe(403);
      expect((await deviceRows())[0]!.status).toBe('PENDING');
    });
  });
});

describe('rate limiting', () => {
  it('limits how often one person can ask to enrol devices', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      statuses.push((await post('/api/devices/register/options', { platform: 'ANDROID' })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);

    // A colleague on the same address is unaffected.
    expect(
      (await post('/api/devices/register/options', { platform: 'ANDROID' }, tok.colleague)).status,
    ).toBe(200);
  });
});

describe('log hygiene', () => {
  it('never writes passwords, keys, signatures, identifiers or challenges to the logs', async () => {
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

    const phone = new SoftwareDevice();
    const c = await challengeFor('ANDROID');
    const body = phone.registrationBody({
      challengeId: c.challengeId,
      challenge: c.challenge,
      employeeId: employee.id,
      password: employee.password,
    });
    await post('/api/devices/register', { ...body, currentPassword: 'Not-My-Passw0rd!' }); // fails
    await post('/api/devices/register', body); // succeeds
    const passkey = authenticator({ origin: 'https://evil.test' });
    const web = await challengeFor('WEB');
    const webBody = passkey.register({ challenge: web.webauthn!.challenge });
    await post('/api/devices/register', {
      challengeId: web.challengeId,
      platform: 'WEB',
      currentPassword: employee.password,
      webauthn: webBody,
    }); // fails the origin check

    const logs = lines.join('');
    expect(logs).toContain('/api/devices/register'); // the logger was genuinely active
    for (const [label, secret] of Object.entries({
      password: employee.password,
      'wrong password': 'Not-My-Passw0rd!',
      'public key': phone.publicKey,
      signature: body.appKey.signature,
      identifier: phone.identifier,
      'native challenge': c.challenge,
      'web challenge': web.challenge,
      'passkey attestation': webBody.response.attestationObject,
    })) {
      expect(logs, label).not.toContain(secret);
    }
  });
});

/** A well-formed SPKI public key, but not an ECDSA P-256 one. */
function publicKeyOfAnotherKind(kind: 'ed25519' | 'p384' | 'rsa'): string {
  const pair =
    kind === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : kind === 'p384'
        ? generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
}
