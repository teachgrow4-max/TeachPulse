import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD,
  START_TIME,
  WEB_HEADERS,
  WEB_ORIGIN,
  accessTokenFor,
  allAuditJson,
  auditRows,
  bearer,
  cookieHeader,
  createAccount,
  mobileLogin,
  sessionCount,
  setCookieOf,
  useApi,
  webLogin,
} from '../testing/api-harness.js';

const h = useApi();

const STANDARD_UNAUTHENTICATED = 'Please sign in to continue.';

const addSeconds = (seconds: number) =>
  new Date(new Date(START_TIME).getTime() + seconds * 1000).toISOString();

describe('POST /api/auth/login', () => {
  it('signs a web user in: access token in the body, refresh token ONLY in an HttpOnly cookie', async () => {
    const acct = await createAccount(h, { fullName: 'Asha Rao' });
    const res = await webLogin(h, acct);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tokenType: 'bearer',
      expiresIn: 3600,
      user: {
        id: acct.id,
        email: acct.email,
        fullName: 'Asha Rao',
        role: 'employee',
        isActive: true,
        mustChangePassword: false,
        department: null,
      },
    });
    expect(res.body.accessToken.split('.')).toHaveLength(3);
    expect(res.body.refreshToken).toBeUndefined();

    const cookie = setCookieOf(res);
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/auth', maxAge: 7 * 24 * 3600 });
    expect(String(cookie?.sameSite).toLowerCase()).toBe('strict');
    expect(cookie?.value).toBeTruthy();
    // The refresh token must not leak into the JSON body in any form.
    expect(JSON.stringify(res.body)).not.toContain(cookie!.value);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('marks the cookie Secure and SameSite=None when configured for a cross-site deployment', async () => {
    h.app = h.build({ env: { AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAMESITE: 'none' } });
    const acct = await createAccount(h);
    const cookie = setCookieOf(await webLogin(h, acct));
    expect(cookie?.secure).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('none');
  });

  it('gives a mobile client the refresh token in the body and sets no cookie', async () => {
    const acct = await createAccount(h);
    const res = await mobileLogin(h, acct);
    expect(res.status).toBe(200);
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('records a success audit entry with the client address', async () => {
    const acct = await createAccount(h);
    await webLogin(h, acct);
    const rows = await auditRows(h, 'auth.login.success');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: acct.id, actor_role: 'employee', ip: '127.0.0.1' });
    expect(rows[0]!.metadata).toMatchObject({
      client: 'web',
      subject_hash: createHash('sha256').update(acct.email).digest('hex'),
    });
  });

  it('treats the email case-insensitively', async () => {
    const acct = await createAccount(h, { email: 'asha@teachgrow.test' });
    const res = await webLogin(h, { email: 'ASHA@TeachGrow.Test', password: acct.password });
    expect(res.status).toBe(200);
  });

  describe('validation', () => {
    it.each([
      ['no body', undefined],
      ['no password', { email: 'a@b.co' }],
      ['an empty password', { email: 'a@b.co', password: '' }],
      ['a malformed email', { email: 'not-an-email', password: 'x' }],
      ['an unknown client type', { email: 'a@b.co', password: 'x', client: 'tv' }],
      ['an unexpected extra field', { email: 'a@b.co', password: 'x', role: 'admin' }],
      ['an enormous password', { email: 'a@b.co', password: 'x'.repeat(5000) }],
    ])('rejects %s with 400 and does not contact the auth provider', async (_label, body) => {
      const before = h.fake.calls.length;
      const res = await request(h.app).post('/api/auth/login').set(WEB_HEADERS).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(h.fake.calls.length).toBe(before);
    });

    it('never echoes the submitted password back in an error', async () => {
      const res = await request(h.app)
        .post('/api/auth/login')
        .set(WEB_HEADERS)
        .send({ email: 'not-an-email', password: 'MySuperSecret-Passw0rd' });
      expect(JSON.stringify(res.body)).not.toContain('MySuperSecret');
    });
  });

  describe('CSRF protection for the cookie flow', () => {
    it.each([
      ['no Origin header', { 'X-Requested-With': 'teachgrow-web' }],
      ['a foreign Origin', { Origin: 'https://evil.test', 'X-Requested-With': 'teachgrow-web' }],
      ['no custom header', { Origin: WEB_ORIGIN }],
      ['the wrong custom header value', { Origin: WEB_ORIGIN, 'X-Requested-With': 'fetch' }],
    ])(
      'refuses a web sign-in with %s - before any password is checked',
      async (_label, headers) => {
        const acct = await createAccount(h);
        const before = h.fake.calls.length;
        const res = await request(h.app)
          .post('/api/auth/login')
          .set(headers)
          .send({ email: acct.email, password: acct.password, client: 'web' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('CSRF_REJECTED');
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(h.fake.calls.length).toBe(before);
        expect(await auditRows(h, 'auth.login.failed')).toHaveLength(0);
      },
    );

    it('does not apply to mobile sign-in, which has no ambient cookie to abuse', async () => {
      const acct = await createAccount(h);
      const res = await request(h.app)
        .post('/api/auth/login')
        .send({ email: acct.email, password: acct.password, client: 'mobile' });
      expect(res.status).toBe(200);
    });

    it('does not let a browser dodge CSRF checks by claiming to be mobile and reading the token', async () => {
      // A cross-site page could ask for client=mobile, but without Origin approval the response
      // is unreadable to it (CORS) and it needs the victim's password anyway.
      const acct = await createAccount(h);
      const res = await request(h.app)
        .post('/api/auth/login')
        .set({ Origin: 'https://evil.test' })
        .send({ email: acct.email, password: acct.password, client: 'mobile' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('bad credentials', () => {
    it('rejects a wrong password with a generic message', async () => {
      const acct = await createAccount(h);
      const res = await webLogin(h, { email: acct.email, password: 'Wrong-Passw0rd!' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect email or password.',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('is indistinguishable for an unknown account (no account enumeration)', async () => {
      const acct = await createAccount(h);
      const wrongPassword = await webLogin(h, { email: acct.email, password: 'Wrong-Passw0rd!' });
      const unknown = await webLogin(h, {
        email: 'nobody@teachgrow.test',
        password: 'Wrong-Passw0rd!',
      });
      expect(unknown.status).toBe(wrongPassword.status);
      expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('audits failures against a hash of the address, never the raw address or password', async () => {
      const acct = await createAccount(h);
      await webLogin(h, { email: acct.email, password: 'Wrong-Passw0rd!' });
      await webLogin(h, { email: 'ghost@teachgrow.test', password: 'Another-Wrong-1' });

      const rows = await auditRows(h, 'auth.login.failed');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.actor_id).toBe(acct.id); // linked for administrators when the account exists
      expect(rows[1]!.actor_id).toBeNull();
      const dump = await allAuditJson(h);
      expect(dump).not.toContain('ghost@teachgrow.test');
      expect(dump).not.toContain('Wrong-Passw0rd');
      expect(dump).not.toContain('Another-Wrong-1');
    });
  });

  describe('account lockout', () => {
    const failN = async (email: string, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const res = await webLogin(h, { email, password: 'Wrong-Passw0rd!' });
        expect(res.status).toBe(401);
      }
    };

    it('locks after 5 failures, even for the correct password, without contacting the provider', async () => {
      const acct = await createAccount(h);
      await failN(acct.email, 5);

      const before = h.fake.calls.length;
      const res = await webLogin(h, acct);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(res.body.error.details.retryAfterSeconds).toBe(900);
      expect(res.headers['retry-after']).toBe('900');
      expect(res.body.error.message).toContain('15 minutes');
      expect(h.fake.calls.length).toBe(before);
    });

    it('does not extend the lock when someone keeps hammering it', async () => {
      const acct = await createAccount(h);
      await failN(acct.email, 5);
      for (let i = 0; i < 5; i += 1) {
        expect((await webLogin(h, { email: acct.email, password: 'Guess-Again-1x' })).status).toBe(
          429,
        );
      }
      expect(await auditRows(h, 'auth.login.blocked')).toHaveLength(5);

      h.clock.set(addSeconds(901));
      expect((await webLogin(h, acct)).status).toBe(200);
    });

    it('unlocks by itself once the window has passed, not before', async () => {
      const acct = await createAccount(h);
      await failN(acct.email, 5);

      h.clock.set(addSeconds(899));
      const stillLocked = await webLogin(h, acct);
      expect(stillLocked.status).toBe(429);
      expect(stillLocked.body.error.details.retryAfterSeconds).toBe(1);

      h.clock.set(addSeconds(901));
      expect((await webLogin(h, acct)).status).toBe(200);
    });

    it('locks unknown addresses identically, so lockout cannot be used to find real accounts', async () => {
      await failN('ghost@teachgrow.test', 5);
      const res = await webLogin(h, { email: 'ghost@teachgrow.test', password: 'Anything-1234x' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('is keyed by the address regardless of letter case', async () => {
      const acct = await createAccount(h, { email: 'asha@teachgrow.test' });
      await failN('ASHA@teachgrow.test', 3);
      await failN('Asha@TeachGrow.test', 2);
      expect((await webLogin(h, acct)).status).toBe(429);
    });

    it('counts only failures since the last successful sign-in', async () => {
      const acct = await createAccount(h);
      await failN(acct.email, 4);
      expect((await webLogin(h, acct)).status).toBe(200);
      await failN(acct.email, 4); // 4 + 4 failures overall, but never 5 in a row
      expect((await webLogin(h, acct)).status).toBe(200);
      await failN(acct.email, 5);
      expect((await webLogin(h, acct)).status).toBe(429);
    });

    it('does not lock one account because of failures against another', async () => {
      const a = await createAccount(h);
      const b = await createAccount(h);
      await failN(a.email, 5);
      expect((await webLogin(h, b)).status).toBe(200);
    });

    it('also protects the current-password check on the change-password endpoint', async () => {
      const acct = await createAccount(h);
      const token = await accessTokenFor(h, acct);
      for (let i = 0; i < 5; i += 1) {
        const res = await request(h.app)
          .post('/api/auth/change-password')
          .set(bearer(token))
          .send({ currentPassword: 'Wrong-Passw0rd!', newPassword: 'Brand-New-Passw0rd1' });
        expect(res.status).toBe(401);
      }
      const locked = await request(h.app)
        .post('/api/auth/change-password')
        .set(bearer(token))
        .send({ currentPassword: acct.password, newPassword: 'Brand-New-Passw0rd1' });
      expect(locked.status).toBe(429);
      expect((await webLogin(h, acct)).status).toBe(429); // same lock as the sign-in form
    });
  });

  describe('per-IP failure limit', () => {
    it('throttles an address that keeps failing, without locking any single account', async () => {
      h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '3' } });
      const acct = await createAccount(h);
      for (let i = 0; i < 3; i += 1) {
        const res = await webLogin(h, {
          email: `guess${i}@teachgrow.test`,
          password: 'Nope-Nope-1x',
        });
        expect(res.status).toBe(401);
      }
      const limited = await webLogin(h, acct);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    });

    it('never counts successful sign-ins, so a whole office behind one public IP is not throttled', async () => {
      h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '3' } });
      const acct = await createAccount(h);
      for (let i = 0; i < 12; i += 1) expect((await webLogin(h, acct)).status).toBe(200);
    });
  });

  describe('accounts that may not sign in', () => {
    it('refuses a deactivated account even with the right password, and removes the session it just created', async () => {
      const acct = await createAccount(h, { active: false });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await sessionCount(h, acct.id)).toBe(0);
      expect((await auditRows(h, 'auth.login.denied'))[0]!.metadata).toMatchObject({
        reason: 'deactivated',
      });
    });

    it('does not count denied-but-correct attempts toward the lockout', async () => {
      const acct = await createAccount(h, { active: false });
      for (let i = 0; i < 7; i += 1) expect((await webLogin(h, acct)).status).toBe(403);
    });

    it('refuses an account the provider has banned', async () => {
      const acct = await createAccount(h);
      h.fake.users.get(acct.id)!.bannedUntil = new Date('2099-01-01');
      const res = await webLogin(h, acct);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });

    it('refuses an auth user with no profile and removes its session', async () => {
      const acct = await createAccount(h, { profile: false });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toContain('contact HR');
      expect(await sessionCount(h, acct.id)).toBe(0);
    });
  });

  describe('when dependencies misbehave', () => {
    it('answers 503 (and does not count a failed attempt) when the auth provider is down', async () => {
      const acct = await createAccount(h);
      h.fake.setOutage({ status: 503 });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(await auditRows(h, 'auth.login.failed')).toHaveLength(0);
    });

    it('answers 503 when the provider cannot be reached at all', async () => {
      const acct = await createAccount(h);
      h.app = h.build({ env: { SUPABASE_URL: 'http://127.0.0.1:1' } });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(503);
    });

    it('relays the provider rate limit as 429 without penalising the user', async () => {
      const acct = await createAccount(h);
      h.fake.setOutage({ status: 429, code: 'over_request_rate_limit' });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(await auditRows(h, 'auth.login.failed')).toHaveLength(0);
    });

    it('fails loudly (503) and cleans up if tokens it was just issued cannot be verified', async () => {
      const acct = await createAccount(h);
      h.app = h.build({
        env: { SUPABASE_JWKS_URL: 'http://127.0.0.1:1/auth/v1/.well-known/jwks.json' },
      });
      const res = await webLogin(h, acct);
      expect(res.status).toBe(503);
      expect(await sessionCount(h, acct.id)).toBe(0);
    });
  });
});

describe('authenticating requests (GET /api/auth/me)', () => {
  it('returns the signed-in person, loaded fresh from the database', async () => {
    const acct = await createAccount(h, { fullName: 'Asha Rao', role: 'admin' });
    const token = await accessTokenFor(h, acct);
    const res = await request(h.app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: acct.id, fullName: 'Asha Rao', role: 'admin' });
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty bearer', 'Bearer '],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare token with no scheme', 'abc.def.ghi'],
    ['junk after Bearer', 'Bearer not.a.jwt'],
  ])('rejects %s with the same generic 401', async (_label, header) => {
    const req = request(h.app).get('/api/auth/me');
    const res = await (header === undefined ? req : req.set('Authorization', header));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: STANDARD_UNAUTHENTICATED,
    });
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  describe('forged and invalid tokens', () => {
    const expectRejected = async (token: string) => {
      const res = await request(h.app).get('/api/auth/me').set(bearer(token));
      expect(res.status).toBe(401);
      // Every failure looks the same: no hint about which check tripped.
      expect(res.body.error).toEqual({
        code: 'UNAUTHENTICATED',
        message: STANDARD_UNAUTHENTICATED,
        requestId: expect.any(String),
      });
    };

    it('rejects a token whose payload was edited after signing', async () => {
      const victim = await createAccount(h, { role: 'admin' });
      const attacker = await createAccount(h);
      const token = await accessTokenFor(h, attacker);
      const [header, payload, signature] = token.split('.') as [string, string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      const forged = Buffer.from(JSON.stringify({ ...claims, sub: victim.id })).toString(
        'base64url',
      );
      await expectRejected(`${header}.${forged}.${signature}`);
    });

    it('rejects a token signed by someone else even if it uses the real key id', async () => {
      const acct = await createAccount(h);
      const sessionId = randomUUID();
      const attackerKey = (await generateKeyPair('ES256')).privateKey;
      await expectRejected(
        await h.fake.signAccessToken({ sub: acct.id, session_id: sessionId }, { key: attackerKey }),
      );
    });

    it('rejects "alg: none"', async () => {
      const acct = await createAccount(h);
      const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(new Date(START_TIME).getTime() / 1000);
      await expectRejected(
        `${enc({ alg: 'none', typ: 'JWT' })}.${enc({
          iss: h.fake.issuer,
          aud: 'authenticated',
          role: 'authenticated',
          sub: acct.id,
          session_id: randomUUID(),
          exp: now + 3600,
        })}.`,
      );
    });

    it('rejects an HS256 token forged with the public key as the secret', async () => {
      const acct = await createAccount(h);
      const forged = await h.fake.signAccessToken(
        { sub: acct.id, session_id: randomUUID() },
        { alg: 'HS256', key: new TextEncoder().encode(JSON.stringify(h.fake.publicJwk)) },
      );
      await expectRejected(forged);
    });

    it.each([
      ['the wrong issuer', { iss: 'https://evil.test/auth/v1' }],
      ['the wrong audience', { aud: 'anon' }],
      ['a service_role claim', { role: 'service_role' }],
      ['an anon claim', { role: 'anon' }],
      ['no session id', { session_id: undefined }],
      ['an expiry in the past', { exp: 1_000_000_000 }],
    ])('rejects a correctly signed token with %s', async (_label, claims) => {
      const acct = await createAccount(h);
      const token = await h.fake.signAccessToken({
        sub: acct.id,
        session_id: randomUUID(),
        ...claims,
      });
      await expectRejected(token);
    });

    it('rejects a correctly signed token whose session does not exist (revoked or never created)', async () => {
      const acct = await createAccount(h);
      const token = await h.fake.signAccessToken({ sub: acct.id, session_id: randomUUID() });
      await expectRejected(token);
    });

    it('rejects a token belonging to a session of a DIFFERENT user', async () => {
      const a = await createAccount(h);
      const b = await createAccount(h);
      const loginA = await mobileLogin(h, a);
      const sessionOfA = JSON.parse(
        Buffer.from(loginA.body.accessToken.split('.')[1], 'base64url').toString(),
      ).session_id as string;
      await expectRejected(await h.fake.signAccessToken({ sub: b.id, session_id: sessionOfA }));
    });
  });

  it('expires tokens with the (injectable) clock', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);

    h.clock.set(addSeconds(3000));
    expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(200);

    h.clock.set(addSeconds(3700));
    const expired = await request(h.app).get('/api/auth/me').set(bearer(token));
    expect(expired.status).toBe(401);
  });

  it('takes deactivation effect on the very next request, while the token is still valid', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(200);

    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [acct.id],
    );
    const res = await request(h.app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('takes a role change effect immediately (the role is never read from the token)', async () => {
    const admin = await createAccount(h, { role: 'admin' });
    await createAccount(h, { role: 'admin' }); // keep the system with an administrator
    const token = await accessTokenFor(h, admin);
    expect((await request(h.app).get('/api/admin/employees').set(bearer(token))).status).toBe(200);

    await h.testDb.query(
      `update public.profiles set role_id = (select id from public.roles where name = 'employee') where id = $1`,
      [admin.id],
    );
    const res = await request(h.app).get('/api/admin/employees').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a person who authenticated at the provider but was never given a profile', async () => {
    const acct = await createAccount(h, { profile: false });
    const sessionId = randomUUID();
    await h.testDb.query('insert into auth.sessions (id, user_id) values ($1, $2)', [
      sessionId,
      acct.id,
    ]);
    const token = await h.fake.signAccessToken({ sub: acct.id, session_id: sessionId });
    const res = await request(h.app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  describe('signing-key availability', () => {
    it('answers 503 (not 401) when the signing keys cannot be fetched', async () => {
      const acct = await createAccount(h);
      const token = await accessTokenFor(h, acct);
      h.fake.setJwksDown(true);
      h.app = h.build(); // a fresh verifier with an empty key cache
      const res = await request(h.app).get('/api/auth/me').set(bearer(token));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('keeps serving from its key cache if the key endpoint later goes down', async () => {
      const acct = await createAccount(h);
      const token = await accessTokenFor(h, acct);
      expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(200);
      h.fake.setJwksDown(true);
      expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(200);
    });
  });

  describe('forced first-login password change', () => {
    it('lets the person see themselves, but nothing else, until the password is changed', async () => {
      const admin = await createAccount(h, { role: 'admin', mustChangePassword: true });
      const token = await accessTokenFor(h, admin);

      const me = await request(h.app).get('/api/auth/me').set(bearer(token));
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(true);

      const blocked = await request(h.app).get('/api/admin/employees').set(bearer(token));
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      const change = await request(h.app)
        .post('/api/auth/change-password')
        .set(bearer(token))
        .send({ currentPassword: admin.password, newPassword: 'My-New-Passw0rd!' });
      expect(change.status).toBe(204);

      expect((await request(h.app).get('/api/admin/employees').set(bearer(token))).status).toBe(
        200,
      );
      expect(
        (await request(h.app).get('/api/auth/me').set(bearer(token))).body.user.mustChangePassword,
      ).toBe(false);
    });

    it('still lets the person sign out', async () => {
      const acct = await createAccount(h, { mustChangePassword: true });
      const token = await accessTokenFor(h, acct);
      expect(
        (await request(h.app).post('/api/auth/logout').set(bearer(token)).send({})).status,
      ).toBe(204);
      expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
    });
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the cookie and returns a new access token', async () => {
    const acct = await createAccount(h);
    const login = await webLogin(h, acct);
    const cookie1 = setCookieOf(login)!.value;

    const res = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie1));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.id).toBe(acct.id);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie2 = setCookieOf(res)!;
    expect(cookie2.value).not.toBe(cookie1);
    expect(cookie2).toMatchObject({ httpOnly: true, path: '/api/auth' });

    const me = await request(h.app).get('/api/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
  });

  it('demands the CSRF headers when relying on the cookie', async () => {
    const acct = await createAccount(h);
    const cookie = setCookieOf(await webLogin(h, acct))!.value;
    for (const headers of [
      {},
      { Origin: 'https://evil.test', 'X-Requested-With': 'teachgrow-web' },
      { Origin: WEB_ORIGIN },
    ]) {
      const res = await request(h.app)
        .post('/api/auth/refresh')
        .set(headers)
        .set(cookieHeader(cookie));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    }
    // ...and the refused attempts did not burn the token.
    const ok = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(ok.status).toBe(200);
  });

  it('treats reuse of an already-rotated token as theft: revokes the session and clears the cookie', async () => {
    const acct = await createAccount(h);
    const stolen = setCookieOf(await webLogin(h, acct))!.value;
    const rotated = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(stolen));
    expect(rotated.status).toBe(200);

    const replay = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(stolen));
    expect(replay.status).toBe(401);
    expect(setCookieOf(replay)).toMatchObject({ value: '' }); // cleared
    expect(await sessionCount(h, acct.id)).toBe(0);
    expect(await auditRows(h, 'auth.refresh.reuse_detected')).toHaveLength(1);

    // The legitimate holder's newest access token died with the session.
    const me = await request(h.app).get('/api/auth/me').set(bearer(rotated.body.accessToken));
    expect(me.status).toBe(401);
  });

  it('answers 401 for a missing or invalid token, clearing a bad cookie', async () => {
    const none = await request(h.app).post('/api/auth/refresh').set(WEB_HEADERS);
    expect(none.status).toBe(401);

    const bad = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader('garbage-token'));
    expect(bad.status).toBe(401);
    expect(setCookieOf(bad)).toMatchObject({ value: '' });
  });

  it('works for mobile with the token in the body, without Origin or cookies', async () => {
    const acct = await createAccount(h);
    const login = await mobileLogin(h, acct);
    const res = await request(h.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(login.body.refreshToken);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses to renew a session once the account was deactivated, and removes the sessions', async () => {
    const acct = await createAccount(h);
    const cookie = setCookieOf(await webLogin(h, acct))!.value;
    await h.testDb.query(
      'update public.profiles set is_active = false, deactivated_at = now() where id = $1',
      [acct.id],
    );
    const res = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    expect(setCookieOf(res)).toMatchObject({ value: '' });
    expect(await sessionCount(h, acct.id)).toBe(0);
  });

  it('keeps the cookie when the failure is temporary, so the user can simply retry', async () => {
    const acct = await createAccount(h);
    const cookie = setCookieOf(await webLogin(h, acct))!.value;
    h.fake.setOutage({ status: 503 });
    const res = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(res.status).toBe(503);
    expect(setCookieOf(res)).toBeUndefined();
    h.fake.setOutage(null);
    const retry = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(retry.status).toBe(200);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session at once and clears the cookie', async () => {
    const acct = await createAccount(h);
    const login = await webLogin(h, acct);
    const token = login.body.accessToken as string;
    const cookie = setCookieOf(login)!.value;

    const res = await request(h.app)
      .post('/api/auth/logout')
      .set(WEB_HEADERS)
      .set(bearer(token))
      .set(cookieHeader(cookie))
      .send({});
    expect(res.status).toBe(204);
    expect(setCookieOf(res)).toMatchObject({ value: '', path: '/api/auth' });

    // The access token has not expired, yet it is dead.
    expect((await request(h.app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
    // And so is the refresh token.
    const refresh = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(refresh.status).toBe(401);

    const [entry] = await auditRows(h, 'auth.logout');
    expect(entry).toMatchObject({ actor_id: acct.id });
    expect(entry!.metadata).toMatchObject({ all_devices: false, sessions_revoked: 1 });
  });

  it('still signs out completely when the access token has already expired', async () => {
    const acct = await createAccount(h);
    const login = await webLogin(h, acct);
    const cookie = setCookieOf(login)!.value;

    h.clock.set(addSeconds(2 * 3600)); // idle for two hours
    const res = await request(h.app)
      .post('/api/auth/logout')
      .set(WEB_HEADERS)
      .set(bearer(login.body.accessToken))
      .set(cookieHeader(cookie))
      .send({});
    expect(res.status).toBe(204);
    expect(await sessionCount(h, acct.id)).toBe(0);
    const refresh = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(cookie));
    expect(refresh.status).toBe(401);
  });

  it('signs out only the current device by default, and all devices on request', async () => {
    const acct = await createAccount(h);
    const phone = await mobileLogin(h, acct);
    const laptop = await mobileLogin(h, acct);
    expect(await sessionCount(h, acct.id)).toBe(2);

    await request(h.app).post('/api/auth/logout').set(bearer(phone.body.accessToken)).send({});
    expect(await sessionCount(h, acct.id)).toBe(1);
    expect(
      (await request(h.app).get('/api/auth/me').set(bearer(laptop.body.accessToken))).status,
    ).toBe(200);

    const third = await mobileLogin(h, acct);
    await request(h.app)
      .post('/api/auth/logout')
      .set(bearer(third.body.accessToken))
      .send({ allDevices: true });
    expect(await sessionCount(h, acct.id)).toBe(0);
    expect(
      (await request(h.app).get('/api/auth/me').set(bearer(laptop.body.accessToken))).status,
    ).toBe(401);
  });

  it('is idempotent and reveals nothing: always 204, even with no or bogus credentials', async () => {
    for (const set of [{}, bearer('not.a.jwt'), bearer('x')]) {
      const res = await request(h.app).post('/api/auth/logout').set(set).send({});
      expect(res.status).toBe(204);
    }
    expect(await auditRows(h, 'auth.logout')).toHaveLength(0);
  });

  it('refuses a cookie-based logout without the CSRF headers, leaving the session alive', async () => {
    const acct = await createAccount(h);
    const login = await webLogin(h, acct);
    const res = await request(h.app)
      .post('/api/auth/logout')
      .set(cookieHeader(setCookieOf(login)!.value))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect(await sessionCount(h, acct.id)).toBe(1);
  });

  it('signs a mobile client out using the refresh token in the body', async () => {
    const acct = await createAccount(h);
    const login = await mobileLogin(h, acct);
    h.clock.set(addSeconds(2 * 3600));
    const res = await request(h.app)
      .post('/api/auth/logout')
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(204);
    expect(await sessionCount(h, acct.id)).toBe(0);
  });
});

describe('POST /api/auth/change-password', () => {
  const NEW_PASSWORD = 'Brand-New-Passw0rd1';

  it('changes the password, ends other sessions, keeps the current one, and clears the forced-change flag', async () => {
    const acct = await createAccount(h, { mustChangePassword: true });
    const current = await mobileLogin(h, acct);
    const other = await mobileLogin(h, acct);

    const res = await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(current.body.accessToken))
      .send({ currentPassword: acct.password, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(204);

    expect(
      (await request(h.app).get('/api/auth/me').set(bearer(current.body.accessToken))).status,
    ).toBe(200);
    expect(
      (await request(h.app).get('/api/auth/me').set(bearer(other.body.accessToken))).status,
    ).toBe(401);
    // The throw-away session created to verify the old password is gone too.
    expect(await sessionCount(h, acct.id)).toBe(1);

    expect((await mobileLogin(h, acct)).status).toBe(401); // old password
    expect((await mobileLogin(h, { email: acct.email, password: NEW_PASSWORD })).status).toBe(200);
    const [entry] = await auditRows(h, 'auth.password.changed');
    expect(entry!.metadata).toMatchObject({ other_sessions_revoked: 1, was_forced: true });
    expect(await allAuditJson(h)).not.toContain(NEW_PASSWORD);
    expect(await allAuditJson(h)).not.toContain(acct.password);
  });

  it('refuses the wrong current password', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    const res = await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: 'Not-My-Password1', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Your current password is incorrect.');
    expect((await mobileLogin(h, acct)).status).toBe(200); // password unchanged
  });

  it.each([
    ['too short', 'Ab1'],
    ['no uppercase', 'alllowercase1234'],
    ['no digit', 'NoDigitsInThisOne'],
    ['over 72 bytes', `Aa1${'x'.repeat(80)}`],
  ])('refuses a new password that is %s', async (_label, newPassword) => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    const res = await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: acct.password, newPassword });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('newPassword');
    expect(JSON.stringify(res.body)).not.toContain(newPassword);
  });

  it('refuses to "change" to the same password', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    const res = await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: acct.password, newPassword: acct.password });
    expect(res.status).toBe(400);
  });

  it('requires a signed-in user', async () => {
    const res = await request(h.app)
      .post('/api/auth/change-password')
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('is rate limited per user', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (
        await request(h.app)
          .post('/api/auth/change-password')
          .set(bearer(token))
          .send({ currentPassword: acct.password, newPassword: acct.password })
      ).status;
    }
    expect(last).toBe(429);
  });

  it('reports a provider outage as 503 and leaves the password untouched', async () => {
    const acct = await createAccount(h);
    const token = await accessTokenFor(h, acct);
    h.fake.setOutage({ status: 503 });
    const res = await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: acct.password, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(503);
    h.fake.setOutage(null);
    expect((await mobileLogin(h, acct)).status).toBe(200);
  });
});

describe('security headers on auth responses', () => {
  it('never allows caching of tokens and exposes no framework details', async () => {
    const acct = await createAccount(h);
    const res = await webLogin(h, acct);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers a CORS preflight only for the configured web origin, with credentials', async () => {
    const ok = await request(h.app)
      .options('/api/auth/login')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with');
    expect(ok.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers']).toMatch(/x-requested-with/i);

    const bad = await request(h.app)
      .options('/api/auth/login')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the per-IP failure budget cannot be burned by junk', () => {
  it('ignores malformed, cross-site and invalid sign-in requests when counting failures', async () => {
    h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '3' } });
    const acct = await createAccount(h);

    for (let i = 0; i < 10; i += 1) {
      // A cross-site HTML form post: its urlencoded body is not JSON, so it is rejected as invalid.
      const form = await request(h.app)
        .post('/api/auth/login')
        .type('form')
        .send({ email: acct.email, password: 'x' });
      expect(form.status).toBe(400);
      // A browser request from the wrong origin.
      const crossSite = await request(h.app)
        .post('/api/auth/login')
        .set({ Origin: 'https://evil.test', 'X-Requested-With': 'teachgrow-web' })
        .send({ email: acct.email, password: 'x', client: 'web' });
      expect(crossSite.status).toBe(403);
      // A schema-invalid request.
      expect(
        (await request(h.app).post('/api/auth/login').set(WEB_HEADERS).send({ nope: true })).status,
      ).toBe(400);
    }

    // The office's shared IP can still sign in.
    expect((await webLogin(h, acct)).status).toBe(200);
  });

  it('does not count refresh calls that carried no token at all (every logged-out page load makes one)', async () => {
    h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '3' } }); // refresh budget: 30
    for (let i = 0; i < 40; i += 1) {
      const res = await request(h.app).post('/api/auth/refresh').set(WEB_HEADERS);
      expect(res.status).toBe(401);
    }
  });

  it('does count rejected refresh tokens, against a budget ten times looser than sign-in', async () => {
    h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '3' } }); // refresh budget: 30
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push(
        (
          await request(h.app)
            .post('/api/auth/refresh')
            .set(WEB_HEADERS)
            .set(cookieHeader('bogus-token-value'))
        ).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('counts lockout hits too, so hammering a locked account is throttled by address', async () => {
    h.app = h.build({ env: { LOGIN_IP_FAILURE_LIMIT: '8' } });
    const acct = await createAccount(h);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await webLogin(h, { email: acct.email, password: 'Wrong-Passw0rd!' })).status);
    }
    // 5 wrong guesses, then lockout responses, then the per-IP limiter takes over.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5, 8)).toEqual([429, 429, 429]);
    expect(statuses.slice(8)).toEqual([429, 429]);
  });
});
