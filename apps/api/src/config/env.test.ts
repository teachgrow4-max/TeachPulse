import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54422/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54421',
  SUPABASE_ANON_KEY: 'anon-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
  QR_SIGNING_SECRET: 'qr-signing-secret-for-tests-0123456789abcdef',
  EMPLOYEE_QR_SECRET: 'employee-qr-secret-for-tests-0123456789abcdef',
};

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.DB_SSL).toBe(false);
    expect(env.RATE_LIMIT_GLOBAL_PER_MIN).toBe(1000);
  });

  it('parses a CORS origin list', () => {
    const env = loadEnv({
      ...valid,
      CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('rejects origins with paths or trailing slashes', () => {
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'https://app.example.com/' })).toThrow(EnvError);
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'https://app.example.com/app' })).toThrow(
      EnvError,
    );
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: 'ftp://app.example.com' })).toThrow(EnvError);
  });

  it('reports every missing required variable by name', () => {
    try {
      loadEnv({});
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const { problems } = error as EnvError;
      const names = problems.map((p) => p.split(':')[0]);
      expect(names).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'SUPABASE_URL',
          'SUPABASE_ANON_KEY',
          'SUPABASE_SERVICE_ROLE_KEY',
        ]),
      );
    }
  });

  it('never echoes secret values in error messages', () => {
    try {
      loadEnv({ ...valid, DATABASE_URL: 'not-a-url-but-secret-hunter2' });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it('rejects a trust-everything TRUST_PROXY at boot', () => {
    expect(() => loadEnv({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => loadEnv({ ...valid, TRUST_PROXY: '0.0.0.0/0' })).toThrow(/TRUST_PROXY/);
  });

  describe('production hardening', () => {
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      CORS_ORIGINS: 'https://app.example.com',
      DB_SSL: 'true',
    };

    it('accepts a fully specified production config', () => {
      expect(loadEnv(prod).NODE_ENV).toBe('production');
    });

    it('requires TRUST_PROXY to be set explicitly', () => {
      const { TRUST_PROXY: _omitted, ...rest } = prod;
      expect(() => loadEnv(rest)).toThrow(/TRUST_PROXY/);
    });

    it('requires at least one CORS origin', () => {
      expect(() => loadEnv({ ...prod, CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
    });

    it('refuses the placeholder QR signing secret from .env.example', () => {
      const placeholder = 'replace-with-a-long-random-secret-of-at-least-32-characters';
      expect(() => loadEnv({ ...prod, QR_SIGNING_SECRET: placeholder })).toThrow(
        /QR_SIGNING_SECRET/,
      );
      // ...but it is only a development convenience: other environments still boot with it.
      expect(loadEnv({ ...valid, QR_SIGNING_SECRET: placeholder }).QR_SIGNING_SECRET).toBe(
        placeholder,
      );
    });

    it('refuses the placeholder employee QR secret from .env.example', () => {
      const placeholder = 'replace-with-another-long-random-secret-of-at-least-32-characters';
      expect(() => loadEnv({ ...prod, EMPLOYEE_QR_SECRET: placeholder })).toThrow(
        /EMPLOYEE_QR_SECRET/,
      );
      expect(loadEnv({ ...valid, EMPLOYEE_QR_SECRET: placeholder }).EMPLOYEE_QR_SECRET).toBe(
        placeholder,
      );
    });

    it('refuses to reuse the lobby QR secret for employee codes in production', () => {
      expect(() => loadEnv({ ...prod, EMPLOYEE_QR_SECRET: prod.QR_SIGNING_SECRET })).toThrow(
        /EMPLOYEE_QR_SECRET.*differ/,
      );
    });

    it('requires an employee QR secret of at least 32 characters', () => {
      const { EMPLOYEE_QR_SECRET: _omitted, ...without } = valid;
      expect(() => loadEnv(without)).toThrow(/EMPLOYEE_QR_SECRET/);
      expect(() => loadEnv({ ...valid, EMPLOYEE_QR_SECRET: 'too-short' })).toThrow(
        /EMPLOYEE_QR_SECRET/,
      );
    });

    it('requires TLS for a remote database', () => {
      const remote = {
        ...prod,
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/postgres',
        DB_SSL: 'false',
      };
      expect(() => loadEnv(remote)).toThrow(/DB_SSL/);
    });
  });
});
