import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54422/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54421',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  QR_SIGNING_SECRET: 'qr-signing-secret-for-tests-0123456789abcdef',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://project.supabase.co',
  DATABASE_URL: 'postgresql://u:p@db.project.supabase.co:5432/postgres',
  DB_SSL: 'true',
  TRUST_PROXY: '1',
  CORS_ORIGINS: 'https://app.teachgrow.test',
};

describe('authentication settings', () => {
  it('has safe defaults for lockout, cookies and rate limits', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      AUTH_COOKIE_SAMESITE: 'strict',
      AUTH_COOKIE_DAYS: 7,
      LOGIN_MAX_FAILURES: 5,
      LOGIN_LOCKOUT_MINUTES: 15,
      LOGIN_IP_FAILURE_LIMIT: 30,
      USER_RATE_LIMIT_PER_MIN: 240,
    });
  });

  it('derives the issuer and JWKS URL from the project URL (tolerating a trailing slash)', () => {
    const env = loadEnv({ ...base, SUPABASE_URL: 'https://project.supabase.co/' });
    expect(env.JWT_ISSUER).toBe('https://project.supabase.co/auth/v1');
    expect(env.SUPABASE_JWKS_URL).toBe('https://project.supabase.co/auth/v1/.well-known/jwks.json');
  });

  it('lets the issuer and JWKS URL be overridden', () => {
    const env = loadEnv({
      ...base,
      JWT_ISSUER: 'http://kong:8000/auth/v1',
      SUPABASE_JWKS_URL: 'http://kong:8000/auth/v1/.well-known/jwks.json',
    });
    expect(env.JWT_ISSUER).toBe('http://kong:8000/auth/v1');
    expect(env.SUPABASE_JWKS_URL).toBe('http://kong:8000/auth/v1/.well-known/jwks.json');
  });

  it('uses Secure cookies in production and not on plain-HTTP development', () => {
    expect(loadEnv(base).AUTH_COOKIE_SECURE).toBe(false);
    expect(loadEnv(production).AUTH_COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, AUTH_COOKIE_SECURE: 'true' }).AUTH_COOKIE_SECURE).toBe(true);
  });

  it('requires Secure when SameSite=None (browsers reject the cookie otherwise)', () => {
    expect(() =>
      loadEnv({ ...base, AUTH_COOKIE_SAMESITE: 'none', AUTH_COOKIE_SECURE: 'false' }),
    ).toThrow(/AUTH_COOKIE_SECURE/);
    expect(
      loadEnv({ ...base, AUTH_COOKIE_SAMESITE: 'none', AUTH_COOKIE_SECURE: 'true' }),
    ).toMatchObject({
      AUTH_COOKIE_SAMESITE: 'none',
    });
  });

  it('refuses insecure production settings', () => {
    expect(() => loadEnv({ ...production, AUTH_COOKIE_SECURE: 'false' })).toThrow(
      /AUTH_COOKIE_SECURE/,
    );
    expect(() => loadEnv({ ...production, SUPABASE_URL: 'http://project.supabase.co' })).toThrow(
      /SUPABASE_URL/,
    );
    expect(loadEnv(production).NODE_ENV).toBe('production');
  });

  it('rejects a legacy JWT secret that is too short to be real', () => {
    expect(() => loadEnv({ ...base, SUPABASE_JWT_SECRET: 'short' })).toThrow(/SUPABASE_JWT_SECRET/);
    const env = loadEnv({ ...base, SUPABASE_JWT_SECRET: 'x'.repeat(40) });
    expect(env.SUPABASE_JWT_SECRET).toHaveLength(40);
  });

  it.each([
    ['LOGIN_MAX_FAILURES', '1'],
    ['LOGIN_MAX_FAILURES', '100'],
    ['LOGIN_LOCKOUT_MINUTES', '0'],
    ['AUTH_COOKIE_DAYS', '0'],
    ['AUTH_COOKIE_DAYS', '365'],
    ['AUTH_COOKIE_SAMESITE', 'maybe'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadEnv({ ...base, [name]: value })).toThrow(EnvError);
  });

  it('never echoes secrets when reporting problems', () => {
    try {
      loadEnv({ ...base, SUPABASE_JWT_SECRET: 'tiny-secret-value' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('tiny-secret-value');
    }
  });
});
