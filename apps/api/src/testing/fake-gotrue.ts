import { randomBytes, randomUUID, type webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { TestDb } from './harness.js';

/**
 * A faithful-enough stand-in for Supabase Auth (GoTrue) for tests:
 *   - real signed JWTs (ES256 + a JWKS endpoint, or legacy HS256)
 *   - sessions stored in `auth.sessions` of the test database, like GoTrue does
 *   - refresh-token rotation with reuse detection, bans, admin user management
 *   - GoTrue's error JSON shapes (`error_code` / `msg`)
 *
 * It lets the REAL gateway and token verifier run end-to-end without Docker. It is NOT proof
 * of behaviour against a real GoTrue; that check is listed as outstanding in the phase report.
 */

export type SigningMode = 'es256' | 'hs256';

export interface FakeUser {
  id: string;
  email: string;
  password: string;
  bannedUntil: Date | null;
}

export interface FakeGoTrueOptions {
  mode: SigningMode;
  db: TestDb;
  now?: () => Date;
  accessTokenTtlSeconds?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface SignOptions {
  alg?: string;
  /** Override the signing key (e.g. an attacker's key). */
  key?: webcrypto.CryptoKey | Uint8Array;
  kid?: string | null;
}

export interface FakeGoTrue {
  url: string;
  issuer: string;
  jwksUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  hs256Secret: string | null;
  publicJwk: JWK | null;
  calls: RecordedCall[];
  users: Map<string, FakeUser>;
  reset(): void;
  addUser(email: string, password: string): Promise<FakeUser>;
  signAccessToken(claims?: Record<string, unknown>, options?: SignOptions): Promise<string>;
  /** Make /token and admin calls fail with this HTTP status until cleared (null). */
  setOutage(outage: { status: number; code?: string } | null): void;
  setJwksDown(down: boolean): void;
  close(): Promise<void>;
}

interface RefreshRecord {
  sessionId: string;
  userId: string;
  used: boolean;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const gotrueError = (
  res: ServerResponse,
  status: number,
  errorCode: string,
  msg: string,
  extra = {},
) => json(res, status, { code: status, error_code: errorCode, msg, ...extra });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startFakeGoTrue(options: FakeGoTrueOptions): Promise<FakeGoTrue> {
  const { db, mode } = options;
  const now = options.now ?? (() => new Date());
  const ttl = options.accessTokenTtlSeconds ?? 3600;

  const anonKey = `anon-${randomUUID()}`;
  const serviceRoleKey = `service-${randomUUID()}`;
  const hs256Secret = mode === 'hs256' ? `hs256-secret-${randomBytes(24).toString('hex')}` : null;

  const keyPair = mode === 'es256' ? await generateKeyPair('ES256', { extractable: true }) : null;
  const kid = mode === 'es256' ? `kid-${randomUUID()}` : null;
  const publicJwk: JWK | null = keyPair
    ? { ...(await exportJWK(keyPair.publicKey)), kid: kid!, alg: 'ES256', use: 'sig' }
    : null;

  const users = new Map<string, FakeUser>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const calls: RecordedCall[] = [];
  let outage: { status: number; code?: string } | null = null;
  let jwksDown = false;
  let issuer = '';

  async function signAccessToken(
    claims: Record<string, unknown> = {},
    sign: SignOptions = {},
  ): Promise<string> {
    const nowSec = Math.floor(now().getTime() / 1000);
    const payload = {
      iss: issuer,
      aud: 'authenticated',
      role: 'authenticated',
      iat: nowSec,
      exp: nowSec + ttl,
      aal: 'aal1',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      ...claims,
    };
    const alg = sign.alg ?? (mode === 'es256' ? 'ES256' : 'HS256');
    const key =
      sign.key ?? (mode === 'es256' ? keyPair!.privateKey : new TextEncoder().encode(hs256Secret!));
    const header: Record<string, unknown> = { alg, typ: 'JWT' };
    const headerKid = sign.kid === undefined ? kid : sign.kid;
    if (headerKid) header.kid = headerKid;
    return new SignJWT(payload).setProtectedHeader(header as { alg: string }).sign(key);
  }

  const userJson = (user: FakeUser) => ({
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: now().toISOString(),
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now().toISOString(),
    updated_at: now().toISOString(),
    banned_until: user.bannedUntil?.toISOString() ?? null,
  });

  const isBanned = (user: FakeUser): boolean =>
    user.bannedUntil !== null && user.bannedUntil.getTime() > now().getTime();

  async function insertAuthUser(user: FakeUser): Promise<void> {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [user.id, user.email]);
  }

  async function issueSession(user: FakeUser, existingSessionId?: string) {
    const sessionId = existingSessionId ?? randomUUID();
    if (!existingSessionId) {
      await db.query(
        'insert into auth.sessions (id, user_id, created_at, updated_at) values ($1, $2, $3, $3)',
        [sessionId, user.id, now()],
      );
    } else {
      await db.query('update auth.sessions set updated_at = $2 where id = $1', [sessionId, now()]);
    }
    const refreshToken = randomBytes(9).toString('base64url');
    refreshTokens.set(refreshToken, { sessionId, userId: user.id, used: false });
    const accessToken = await signAccessToken({
      sub: user.id,
      session_id: sessionId,
      email: user.email,
    });
    const expiresAt = Math.floor(now().getTime() / 1000) + ttl;
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ttl,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: userJson(user),
    };
  }

  const apiKeyOk = (req: IncomingMessage): boolean => {
    const key = req.headers.apikey;
    return key === anonKey || key === serviceRoleKey;
  };
  const isServiceCaller = (req: IncomingMessage): boolean =>
    req.headers.authorization === `Bearer ${serviceRoleKey}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/auth\/v1/, '');
    const query = Object.fromEntries(url.searchParams);
    const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req);
    calls.push({ method: req.method ?? 'GET', path, query, body });

    if (path === '/.well-known/jwks.json') {
      if (jwksDown) return json(res, 503, { message: 'jwks unavailable' });
      return json(res, 200, { keys: publicJwk ? [publicJwk] : [] });
    }

    if (outage) {
      return gotrueError(
        res,
        outage.status,
        outage.code ?? 'unexpected_failure',
        'simulated outage',
      );
    }

    // ---- user-facing token grants -------------------------------------------------------
    if (path === '/token' && req.method === 'POST') {
      if (!apiKeyOk(req)) return json(res, 401, { message: 'Invalid API key' });

      if (query.grant_type === 'password') {
        const email = String(body?.email ?? '').toLowerCase();
        const password = String(body?.password ?? '');
        const user = [...users.values()].find((candidate) => candidate.email === email);
        if (!user || user.password !== password) {
          return gotrueError(res, 400, 'invalid_credentials', 'Invalid login credentials');
        }
        if (isBanned(user)) return gotrueError(res, 400, 'user_banned', 'User is banned');
        return json(res, 200, await issueSession(user));
      }

      if (query.grant_type === 'refresh_token') {
        const record = refreshTokens.get(String(body?.refresh_token ?? ''));
        if (!record) {
          return gotrueError(
            res,
            400,
            'refresh_token_not_found',
            'Invalid Refresh Token: Refresh Token Not Found',
          );
        }
        const live = await db.query('select 1 from auth.sessions where id = $1', [
          record.sessionId,
        ]);
        if (live.length === 0) {
          return gotrueError(
            res,
            400,
            'session_not_found',
            'Invalid Refresh Token: Session Not Found',
          );
        }
        if (record.used) {
          // Reuse of a rotated token signals theft: GoTrue revokes the whole session.
          await db.query('delete from auth.sessions where id = $1', [record.sessionId]);
          return gotrueError(
            res,
            400,
            'refresh_token_already_used',
            'Invalid Refresh Token: Already Used',
          );
        }
        const user = users.get(record.userId);
        if (!user) return gotrueError(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        if (isBanned(user)) return gotrueError(res, 400, 'user_banned', 'User is banned');
        record.used = true;
        return json(res, 200, await issueSession(user, record.sessionId));
      }
      return gotrueError(res, 400, 'validation_failed', 'unsupported grant_type');
    }

    // ---- admin API (service role only) --------------------------------------------------
    if (path.startsWith('/admin/users')) {
      if (!isServiceCaller(req)) return json(res, 401, { message: 'not admin' });
      const id = path.split('/')[3];

      if (req.method === 'POST' && !id) {
        const email = String(body?.email ?? '').toLowerCase();
        const password = String(body?.password ?? '');
        if (!email.includes('@'))
          return gotrueError(res, 422, 'validation_failed', 'Invalid email');
        if (password.length < 10) {
          return gotrueError(
            res,
            422,
            'weak_password',
            'Password should be at least 10 characters.',
            {
              weak_password: { reasons: ['length'] },
            },
          );
        }
        if ([...users.values()].some((candidate) => candidate.email === email)) {
          return gotrueError(
            res,
            422,
            'email_exists',
            'A user with this email address has already been registered',
          );
        }
        const user: FakeUser = { id: randomUUID(), email, password, bannedUntil: null };
        await insertAuthUser(user);
        users.set(user.id, user);
        return json(res, 200, userJson(user));
      }

      const target = id ? users.get(id) : undefined;
      if (!target) return gotrueError(res, 404, 'user_not_found', 'User not found');

      if (req.method === 'GET') return json(res, 200, userJson(target));

      if (req.method === 'PUT') {
        if (typeof body?.password === 'string') {
          if (body.password.length < 10) {
            return gotrueError(
              res,
              422,
              'weak_password',
              'Password should be at least 10 characters.',
              {
                weak_password: { reasons: ['length'] },
              },
            );
          }
          target.password = body.password;
        }
        if (typeof body?.ban_duration === 'string') {
          const hours = /^(\d+)h$/.exec(body.ban_duration);
          target.bannedUntil =
            body.ban_duration === 'none' || !hours
              ? null
              : new Date(now().getTime() + Number(hours[1]) * 3_600_000);
        }
        return json(res, 200, userJson(target));
      }

      if (req.method === 'DELETE') {
        await db.query('delete from auth.users where id = $1', [target.id]);
        users.delete(target.id);
        return json(res, 200, userJson(target));
      }
    }

    return gotrueError(res, 404, 'not_found', `no route for ${req.method} ${path}`);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      json(res, 500, { code: 500, error_code: 'unexpected_failure', msg: String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  issuer = `${url}/auth/v1`;

  return {
    url,
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    anonKey,
    serviceRoleKey,
    hs256Secret,
    publicJwk,
    calls,
    users,
    reset() {
      users.clear();
      refreshTokens.clear();
      calls.length = 0;
      outage = null;
      jwksDown = false;
    },
    async addUser(email, password) {
      const user: FakeUser = {
        id: randomUUID(),
        email: email.toLowerCase(),
        password,
        bannedUntil: null,
      };
      await insertAuthUser(user);
      users.set(user.id, user);
      return user;
    },
    signAccessToken,
    setOutage(next) {
      outage = next;
    },
    setJwksDown(down) {
      jwksDown = down;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
