import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, refreshSession, session } from './api';
import { json, mockFetch } from '../test/utils';

beforeEach(() => {
  session.set(null);
  session.onLost(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renewed = {
  accessToken: 'fresh-token',
  tokenType: 'bearer',
  expiresIn: 900,
  expiresAt: 0,
  user: { id: 'u' },
};

describe('api', () => {
  it('sends the access token, and cookies, with every request', async () => {
    session.set('abc');
    const { fetchMock, calls } = mockFetch({ 'GET /api/thing': json(200, { ok: true }) });
    await expect(api('/api/thing')).resolves.toEqual({ ok: true });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer abc');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('adds the CSRF header and the idempotency key only where asked', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': json(200, renewed),
      'POST /api/x': json(200, {}),
    });
    await api('/api/auth/login', { method: 'POST', body: {}, auth: false, csrf: true });
    await api('/api/x', { method: 'POST', body: {}, idempotencyKey: 'key-12345678' });
    expect(calls[0]?.headers.get('x-requested-with')).toBe('teachgrow-web');
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(calls[1]?.headers.get('idempotency-key')).toBe('key-12345678');
    expect(calls[1]?.headers.get('x-requested-with')).toBeNull();
  });

  it('turns an error body into an ApiError with the server’s code and message', async () => {
    mockFetch({
      'GET /api/x': json(422, {
        error: {
          code: 'EMPLOYEE_QR_REVOKED',
          message: 'Revoked.',
          requestId: 'r1',
          details: { a: 1 },
        },
      }),
    });
    const error = await api('/api/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'EMPLOYEE_QR_REVOKED',
      message: 'Revoked.',
      details: { a: 1 },
      requestId: 'r1',
    });
  });

  it('copes with an error page that is not JSON', async () => {
    mockFetch({ 'GET /api/x': new Response('<html>bad gateway</html>', { status: 502 }) });
    const error = (await api('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 502, code: 'UNKNOWN' });
  });

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = (await api('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.isNetwork).toBe(true);
    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('on a 401 renews the session once and repeats the request', async () => {
    session.set('old');
    const { calls } = mockFetch({
      'GET /api/x': [
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }),
        json(200, { n: 1 }),
      ],
      'POST /api/auth/refresh': json(200, renewed),
    });
    await expect(api('/api/x')).resolves.toEqual({ n: 1 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/x',
      'POST /api/auth/refresh',
      'GET /api/x',
    ]);
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer fresh-token');
    // the refresh asked with the CSRF header and no bearer token
    expect(calls[1]?.headers.get('x-requested-with')).toBe('teachgrow-web');
  });

  it('shares one renewal between requests that fail together', async () => {
    session.set('old');
    const { called } = mockFetch({
      'GET /api/a': [
        json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
        json(200, 'a'),
      ],
      'GET /api/b': [
        json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
        json(200, 'b'),
      ],
      'POST /api/auth/refresh': json(200, renewed),
    });
    await Promise.all([api('/api/a'), api('/api/b')]);
    expect(called('POST /api/auth/refresh')).toHaveLength(1);
  });

  it('gives up, and says the session is gone, when it cannot be renewed', async () => {
    session.set('old');
    const lost = vi.fn();
    session.onLost(lost);
    mockFetch({
      'GET /api/x': json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } }),
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
    });
    await expect(api('/api/x')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(session.has()).toBe(false);
  });

  it('does not try to renew the session for a sign-in that was refused', async () => {
    const { called } = mockFetch({
      'POST /api/auth/login': json(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Wrong.' },
      }),
    });
    await expect(
      api('/api/auth/login', { method: 'POST', body: {}, auth: false, csrf: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(called('POST /api/auth/refresh')).toHaveLength(0);
  });

  it('refreshSession reports "no session" as null and stores nothing', async () => {
    mockFetch({
      'POST /api/auth/refresh': json(401, { error: { code: 'UNAUTHENTICATED', message: '' } }),
    });
    await expect(refreshSession()).resolves.toBeNull();
    expect(session.has()).toBe(false);
  });
});
