import { generateKeyPair } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  bearer,
  createAccount,
  mobileLogin,
  randomId,
  useApi,
} from '../testing/api-harness.js';

/**
 * The same flows with a legacy project that signs tokens with a shared HS256 secret (this is also
 * what the local Supabase CLI stack has historically used).
 */
const h = useApi({ mode: 'hs256' });

describe('HS256 (legacy shared-secret) projects', () => {
  it('signs in and authenticates requests', async () => {
    const acct = await createAccount(h, { fullName: 'Asha Rao' });
    const login = await mobileLogin(h, acct);
    expect(login.status).toBe(200);
    const header = JSON.parse(
      Buffer.from(login.body.accessToken.split('.')[0], 'base64url').toString(),
    );
    expect(header.alg).toBe('HS256');

    const me = await request(h.app).get('/api/auth/me').set(bearer(login.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.fullName).toBe('Asha Rao');
  });

  it('rejects a token signed with any other secret', async () => {
    const acct = await createAccount(h);
    const forged = await h.fake.signAccessToken(
      { sub: acct.id, session_id: randomId() },
      { alg: 'HS256', key: new TextEncoder().encode('an-attackers-guess-at-the-secret-1234567') },
    );
    expect((await request(h.app).get('/api/auth/me').set(bearer(forged))).status).toBe(401);
  });

  it('rejects an asymmetric token, since the project publishes no signing keys', async () => {
    const acct = await createAccount(h);
    const attackerKey = (await generateKeyPair('ES256')).privateKey;
    const forged = await h.fake.signAccessToken(
      { sub: acct.id, session_id: randomId() },
      { alg: 'ES256', key: attackerKey, kid: 'attacker' },
    );
    expect((await request(h.app).get('/api/auth/me').set(bearer(forged))).status).toBe(401);
  });

  it('rejects the public anon API key presented as a user token', async () => {
    const acct = await createAccount(h);
    await accessTokenFor(h, acct);
    const anon = await h.fake.signAccessToken({
      sub: undefined,
      aud: undefined,
      session_id: undefined,
      role: 'anon',
      iss: 'supabase',
    });
    expect((await request(h.app).get('/api/auth/me').set(bearer(anon))).status).toBe(401);
  });

  it('still revokes sessions immediately on logout', async () => {
    const acct = await createAccount(h);
    const login = await mobileLogin(h, acct);
    await request(h.app).post('/api/auth/logout').set(bearer(login.body.accessToken)).send({});
    expect(
      (await request(h.app).get('/api/auth/me').set(bearer(login.body.accessToken))).status,
    ).toBe(401);
  });
});
