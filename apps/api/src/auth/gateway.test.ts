import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthGatewayError, SupabaseAuthGateway } from './gateway.js';

/**
 * Exercises the REAL gateway against a scripted HTTP server, to pin down the exact requests it
 * sends and how it reacts to responses a well-behaved auth server never sends (HTML error pages,
 * malformed bodies, hangs). The richer behavioural tests use the fake GoTrue instead.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: (seen: Seen) => { status: number; body?: string; contentType?: string; hang?: boolean };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      } catch {
        body = null;
      }
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      seen.push(record);
      const out = reply(record);
      if (out.hang) return; // never answer
      res.writeHead(out.status, { 'Content-Type': out.contentType ?? 'application/json' });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, body: '{}' });
});

const gateway = (timeoutMs?: number) =>
  new SupabaseAuthGateway({
    url: `${baseUrl}/`,
    anonKey: 'anon-key-123',
    serviceRoleKey: 'service-key-456',
    timeoutMs,
  });

const sessionJson = JSON.stringify({
  access_token: 'access.jwt.value',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1_800_000_000,
  refresh_token: 'refresh-abc',
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.co' },
});

const kindOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthGatewayError);
    return (error as AuthGatewayError).kind;
  }
  return 'resolved';
};

describe('refreshSession', () => {
  it('posts the refresh token to the token endpoint with only the public anon key', async () => {
    reply = () => ({ status: 200, body: sessionJson });
    const session = await gateway().refreshSession('old-refresh-token');

    expect(session).toEqual({
      accessToken: 'access.jwt.value',
      refreshToken: 'refresh-abc',
      expiresIn: 3600,
      expiresAt: 1_800_000_000,
      userId: '11111111-1111-4111-8111-111111111111',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/auth/v1/token?grant_type=refresh_token',
    });
    expect(seen[0]!.headers.apikey).toBe('anon-key-123');
    expect(seen[0]!.headers.authorization).toBeUndefined(); // the service key is never sent here
    expect(seen[0]!.body).toEqual({ refresh_token: 'old-refresh-token' });
  });

  it.each([
    ['refresh_token_not_found', 'refresh_token_invalid'],
    ['refresh_token_already_used', 'refresh_token_invalid'],
    ['session_not_found', 'refresh_token_invalid'],
    ['user_banned', 'user_banned'],
    ['over_request_rate_limit', 'rate_limited'],
  ])('maps the provider code %s to %s', async (errorCode, expected) => {
    reply = () => ({
      status: 400,
      body: JSON.stringify({ code: 400, error_code: errorCode, msg: 'm' }),
    });
    expect(await kindOf(gateway().refreshSession('t'))).toBe(expected);
  });

  it('understands the older OAuth-style error body', async () => {
    reply = () => ({
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }),
    });
    expect(await kindOf(gateway().refreshSession('t'))).toBe('refresh_token_invalid');
  });

  it('keeps the provider error code so callers can spot token reuse', async () => {
    reply = () => ({
      status: 400,
      body: JSON.stringify({ error_code: 'refresh_token_already_used', msg: 'used' }),
    });
    await expect(gateway().refreshSession('t')).rejects.toMatchObject({
      kind: 'refresh_token_invalid',
      code: 'refresh_token_already_used',
    });
  });

  it('treats server errors and non-JSON error pages as "unavailable"', async () => {
    reply = () => ({ status: 502, body: '<html>Bad gateway</html>', contentType: 'text/html' });
    expect(await kindOf(gateway().refreshSession('t'))).toBe('unavailable');
    reply = () => ({ status: 503, body: '' });
    expect(await kindOf(gateway().refreshSession('t'))).toBe('unavailable');
  });

  it('refuses a success response that is missing what it needs', async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ access_token: 'x' }) });
    expect(await kindOf(gateway().refreshSession('t'))).toBe('unknown');
    reply = () => ({ status: 200, body: 'not json', contentType: 'text/plain' });
    expect(await kindOf(gateway().refreshSession('t'))).toBe('unknown');
  });

  it('does not retry: one failed attempt means one request, so API calls fail fast', async () => {
    reply = () => ({ status: 503, body: '' });
    await kindOf(gateway().refreshSession('t'));
    expect(seen).toHaveLength(1);
  });

  it('gives up on a server that never answers instead of hanging the request', async () => {
    reply = () => ({ status: 200, hang: true });
    const started = Date.now();
    expect(await kindOf(gateway(250).refreshSession('t'))).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports an unreachable server as unavailable', async () => {
    const dead = new SupabaseAuthGateway({
      url: 'http://127.0.0.1:1',
      anonKey: 'a',
      serviceRoleKey: 's',
    });
    expect(await kindOf(dead.refreshSession('t'))).toBe('unavailable');
  });
});

describe('signInWithPassword', () => {
  it('sends the credentials with the anon key and returns the session', async () => {
    reply = () => ({ status: 200, body: sessionJson });
    const session = await gateway().signInWithPassword('a@b.co', 'pw');
    expect(session.accessToken).toBe('access.jwt.value');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/auth/v1/token?grant_type=password' });
    expect(seen[0]!.headers.apikey).toBe('anon-key-123');
    expect(seen[0]!.body).toMatchObject({ email: 'a@b.co', password: 'pw' });
  });

  it.each([
    [400, 'invalid_credentials', 'invalid_credentials'],
    [400, 'user_banned', 'user_banned'],
    [429, 'over_request_rate_limit', 'rate_limited'],
    [500, 'unexpected_failure', 'unavailable'],
  ])('maps HTTP %i / %s to %s', async (status, errorCode, expected) => {
    reply = () => ({
      status,
      body: JSON.stringify({ code: status, error_code: errorCode, msg: 'm' }),
    });
    expect(await kindOf(gateway().signInWithPassword('a@b.co', 'pw'))).toBe(expected);
  });

  it('times out on a server that never answers', async () => {
    reply = () => ({ status: 200, hang: true });
    expect(await kindOf(gateway(250).signInWithPassword('a@b.co', 'pw'))).toBe('unavailable');
  });
});

describe('account administration', () => {
  const userJson = JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', email: 'n@b.co' });

  it('creates users pre-confirmed, authenticating with the service-role key', async () => {
    reply = () => ({ status: 200, body: userJson });
    const created = await gateway().createUser({
      email: 'n@b.co',
      password: 'Pw-Str0ng-Value',
      fullName: 'New Person',
    });
    expect(created).toEqual({ id: '22222222-2222-4222-8222-222222222222' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/auth/v1/admin/users' });
    expect(seen[0]!.headers.authorization).toBe('Bearer service-key-456');
    expect(seen[0]!.headers.apikey).toBe('service-key-456');
    expect(seen[0]!.body).toMatchObject({
      email: 'n@b.co',
      email_confirm: true,
      user_metadata: { full_name: 'New Person' },
    });
  });

  it('maps duplicate emails and weak passwords', async () => {
    reply = () => ({
      status: 422,
      body: JSON.stringify({ code: 422, error_code: 'email_exists', msg: 'dup' }),
    });
    expect(
      await kindOf(gateway().createUser({ email: 'n@b.co', password: 'x', fullName: 'N' })),
    ).toBe('email_exists');
    reply = () => ({
      status: 422,
      body: JSON.stringify({
        code: 422,
        error_code: 'weak_password',
        msg: 'weak',
        weak_password: { reasons: ['length'] },
      }),
    });
    expect(
      await kindOf(gateway().createUser({ email: 'n@b.co', password: 'x', fullName: 'N' })),
    ).toBe('weak_password');
  });

  it('bans for a very long time, and lifts the ban with "none"', async () => {
    reply = () => ({ status: 200, body: userJson });
    await gateway().setBanned('22222222-2222-4222-8222-222222222222', true);
    await gateway().setBanned('22222222-2222-4222-8222-222222222222', false);
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      url: '/auth/v1/admin/users/22222222-2222-4222-8222-222222222222',
    });
    expect(seen[0]!.body).toEqual({ ban_duration: '876000h' });
    expect(seen[1]!.body).toEqual({ ban_duration: 'none' });
  });

  it('updates passwords and deletes users through the admin endpoints', async () => {
    reply = () => ({ status: 200, body: userJson });
    await gateway().updatePassword('22222222-2222-4222-8222-222222222222', 'New-Str0ng-Value');
    await gateway().deleteUser('22222222-2222-4222-8222-222222222222');
    expect(seen[0]).toMatchObject({ method: 'PUT' });
    expect(seen[0]!.body).toEqual({ password: 'New-Str0ng-Value' });
    // auth-js looks the user up before deleting it (so it can return the deleted user).
    expect(seen.slice(1).map((r) => r.method)).toEqual(['GET', 'DELETE']);
    expect(seen[2]).toMatchObject({
      url: '/auth/v1/admin/users/22222222-2222-4222-8222-222222222222',
    });
  });

  it('reports a failed delete (e.g. the user is already gone) as an error for the caller to log', async () => {
    reply = () => ({
      status: 404,
      body: JSON.stringify({ code: 404, error_code: 'user_not_found', msg: 'User not found' }),
    });
    expect(await kindOf(gateway().deleteUser('22222222-2222-4222-8222-222222222222'))).toBe(
      'unknown',
    );
  });
});
