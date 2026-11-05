import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, TokenError, type TokenFailure } from './token-verifier.js';

const SECRET = 'a-legacy-hs256-secret-that-is-long-enough-123456';
const ISSUER = 'https://project.supabase.co/auth/v1';
const NOW = new Date('2026-11-02T04:30:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

const userId = randomUUID();
const sessionId = randomUUID();

const goodClaims = () => ({
  iss: ISSUER,
  aud: 'authenticated',
  sub: userId,
  session_id: sessionId,
  role: 'authenticated',
  email: 'asha@teachgrow.test',
  iat: nowSec,
  exp: nowSec + 3600,
});

let jwksServer: Server;
let jwksUrl: string;
let jwksRequests = 0;
let jwksUp = true;
let publicJwk: JWK;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let privateKey: SigningKey;
let attackerKey: SigningKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  attackerKey = (await generateKeyPair('ES256')).privateKey;

  jwksServer = createServer((req, res) => {
    if (req.url?.endsWith('/jwks.json')) {
      jwksRequests += 1;
      if (!jwksUp) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/auth/v1/jwks.json`;
});

afterAll(async () => {
  jwksServer.closeAllConnections();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

const hs256 = (claims: Record<string, unknown>, secret = SECRET) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret));

const es256 = (
  claims: Record<string, unknown>,
  { key = privateKey, kid = 'kid-1' }: { key?: SigningKey; kid?: string } = {},
) => new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid }).sign(key);

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const make = (opts: { secret?: boolean; jwks?: boolean } = { secret: true, jwks: true }) =>
  createTokenVerifier({
    issuer: ISSUER,
    hs256Secret: opts.secret ? SECRET : undefined,
    jwksUrl: opts.jwks ? jwksUrl : undefined,
    now: () => NOW,
  });

async function reasonOf(promise: Promise<unknown>): Promise<TokenFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TokenError);
    return (error as TokenError).reason;
  }
  throw new Error('expected the token to be rejected');
}

describe('accepting valid tokens', () => {
  it('verifies an HS256 token signed with the project secret', async () => {
    const verified = await make().verify(await hs256(goodClaims()));
    expect(verified).toEqual({
      userId,
      sessionId,
      email: 'asha@teachgrow.test',
      issuedAt: nowSec,
      expiresAt: nowSec + 3600,
    });
  });

  it('verifies an ES256 token against the JWKS endpoint', async () => {
    const verified = await make().verify(await es256(goodClaims()));
    expect(verified.userId).toBe(userId);
    expect(verified.sessionId).toBe(sessionId);
  });

  it('caches the JWKS instead of fetching it for every token', async () => {
    const verifier = make();
    const before = jwksRequests;
    for (let i = 0; i < 5; i += 1) await verifier.verify(await es256(goodClaims()));
    expect(jwksRequests - before).toBe(1);
  });

  it('keeps working from cache if the JWKS endpoint later goes down', async () => {
    const verifier = make();
    await verifier.verify(await es256(goodClaims()));
    jwksUp = false;
    try {
      await expect(verifier.verify(await es256(goodClaims()))).resolves.toBeDefined();
    } finally {
      jwksUp = true;
    }
  });
});

describe('rejecting bad tokens', () => {
  it('rejects expired tokens, honouring only a few seconds of clock skew', async () => {
    const verifier = make();
    const expiredBy = (seconds: number) => ({ ...goodClaims(), exp: nowSec - seconds });
    expect(await reasonOf(verifier.verify(await hs256(expiredBy(60))))).toBe('expired');
    await expect(verifier.verify(await hs256(expiredBy(3)))).resolves.toBeDefined();
    expect(await reasonOf(verifier.verify(await hs256(expiredBy(10))))).toBe('expired');
  });

  it('rejects the wrong issuer and the wrong audience', async () => {
    const verifier = make();
    expect(
      await reasonOf(
        verifier.verify(await hs256({ ...goodClaims(), iss: 'https://evil.example/auth/v1' })),
      ),
    ).toBe('invalid_claims');
    expect(
      await reasonOf(verifier.verify(await hs256({ ...goodClaims(), aud: 'someone-else' }))),
    ).toBe('invalid_claims');
    const { aud: _aud, ...noAudience } = goodClaims();
    expect(await reasonOf(verifier.verify(await hs256(noAudience)))).toBe('invalid_claims');
  });

  it('rejects the public anon and service_role API keys, which are JWTs under the same secret', async () => {
    const verifier = make();
    const anon = await hs256({ iss: 'supabase', role: 'anon', iat: nowSec, exp: nowSec + 3600 });
    const service = await hs256({
      iss: 'supabase',
      role: 'service_role',
      iat: nowSec,
      exp: nowSec + 3600,
    });
    expect(await reasonOf(verifier.verify(anon))).toBe('invalid_claims');
    expect(await reasonOf(verifier.verify(service))).toBe('invalid_claims');
  });

  it('rejects a service_role token even if it carries every other claim', async () => {
    const claims = { ...goodClaims(), role: 'service_role' };
    expect(await reasonOf(make().verify(await hs256(claims)))).toBe('invalid_claims');
  });

  it.each([
    ['no subject', (c: Record<string, unknown>) => ({ ...c, sub: undefined })],
    ['a non-UUID subject', (c: Record<string, unknown>) => ({ ...c, sub: 'admin' })],
    ['no session_id', (c: Record<string, unknown>) => ({ ...c, session_id: undefined })],
    ['a non-UUID session_id', (c: Record<string, unknown>) => ({ ...c, session_id: '1' })],
    ['no expiry', (c: Record<string, unknown>) => ({ ...c, exp: undefined })],
  ])('rejects a token with %s', async (_label, mutate) => {
    const reason = await reasonOf(make().verify(await hs256(mutate(goodClaims()))));
    expect(['invalid_claims']).toContain(reason);
  });

  it('rejects a payload that was edited after signing', async () => {
    const [header, , signature] = (await es256(goodClaims())).split('.');
    const forged = `${header}.${b64({ ...goodClaims(), sub: randomUUID() })}.${signature}`;
    expect(await reasonOf(make().verify(forged))).toBe('invalid_signature');
  });

  it('rejects a damaged signature', async () => {
    const token = await hs256(goodClaims());
    const flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(await reasonOf(make().verify(flipped))).toBe('invalid_signature');
  });

  it('rejects a token signed with the wrong HS256 secret', async () => {
    const forged = await hs256(goodClaims(), 'an-attackers-guess-of-the-secret-000000');
    expect(await reasonOf(make().verify(forged))).toBe('invalid_signature');
  });

  it('rejects an ES256 token signed by someone else, even when it claims a real key id', async () => {
    const forged = await es256(goodClaims(), { key: attackerKey, kid: 'kid-1' });
    expect(await reasonOf(make().verify(forged))).toBe('invalid_signature');
  });

  it('rejects an unknown key id', async () => {
    const forged = await es256(goodClaims(), { kid: 'kid-from-nowhere' });
    expect(await reasonOf(make().verify(forged))).toBe('invalid_signature');
  });

  it('rejects "alg: none" tokens', async () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(goodClaims())}.`;
    expect(await reasonOf(make().verify(unsigned))).toBe('alg_not_allowed');
    const withJunk = `${b64({ alg: 'none' })}.${b64(goodClaims())}.AAAA`;
    expect(await reasonOf(make().verify(withJunk))).toBe('alg_not_allowed');
  });

  it.each([['HS384'], ['RS384'], ['PS256'], ['ES512']])(
    'rejects the unsupported algorithm %s',
    async (alg) => {
      const token = `${b64({ alg, typ: 'JWT' })}.${b64(goodClaims())}.AAAA`;
      expect(await reasonOf(make().verify(token))).toBe('alg_not_allowed');
    },
  );

  it.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['non-base64 junk', '!!!.???.***'],
    ['an oversized token', 'a'.repeat(9000)],
  ])('rejects malformed input: %s', async (_label, token) => {
    expect(['malformed']).toContain(await reasonOf(make().verify(token)));
  });
});

describe('algorithm confusion', () => {
  it('refuses an HS256 token when only asymmetric keys are configured', async () => {
    const verifier = make({ jwks: true });
    expect(await reasonOf(verifier.verify(await hs256(goodClaims())))).toBe('alg_not_allowed');
  });

  it('refuses an asymmetric token when only the legacy secret is configured', async () => {
    const verifier = make({ secret: true });
    expect(await reasonOf(verifier.verify(await es256(goodClaims())))).toBe('alg_not_allowed');
  });

  it('never uses the public key as an HMAC secret (classic key-confusion forgery)', async () => {
    // The attacker knows the public JWKS and signs an HS256 token using it as the "secret".
    const publicKeyAsSecret = JSON.stringify(publicJwk);
    const forged = await hs256(goodClaims(), publicKeyAsSecret);
    // Even with BOTH key families configured, HS256 is checked only against the real shared secret.
    expect(await reasonOf(make().verify(forged))).toBe('invalid_signature');
    // And with only JWKS configured it is not even attempted.
    expect(await reasonOf(make({ jwks: true }).verify(forged))).toBe('alg_not_allowed');
  });
});

describe('infrastructure failures', () => {
  it('reports an unreachable JWKS endpoint as key_unavailable, not as a bad token', async () => {
    jwksUp = false;
    try {
      const fresh = make({ jwks: true });
      expect(await reasonOf(fresh.verify(await es256(goodClaims())))).toBe('key_unavailable');
    } finally {
      jwksUp = true;
    }
  });
});
