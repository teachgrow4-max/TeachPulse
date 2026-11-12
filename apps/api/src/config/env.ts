import { z } from 'zod';
import { parseTrustProxy } from './trust-proxy.js';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalBooleanString = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const originList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().refine((origin) => {
        try {
          const url = new URL(origin);
          // An origin is scheme + host (+ port) only.
          return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
        } catch {
          return false;
        }
      }, 'must be an origin such as https://app.example.com (no path, no trailing slash)'),
    ),
  );

const isLocalUrl = (value: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// connection URL'),
    DB_SSL: booleanString,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    /** Legacy HS256 signing secret. Leave unset for projects using asymmetric signing keys. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    /** Override the JWKS endpoint (defaults to `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`). */
    SUPABASE_JWKS_URL: z.url().optional(),
    /** Override the expected `iss` claim (defaults to `<SUPABASE_URL>/auth/v1`). */
    JWT_ISSUER: z.string().min(1).optional(),

    /**
     * Secret that makes the rotating office QR codes unforgeable (HMAC key). At least 32 characters,
     * random, server-only. Changing it simply invalidates the codes currently on screen.
     */
    QR_SIGNING_SECRET: z.string().min(32),
    /**
     * Secret behind the employees' personal QR codes (an HMAC key). At least 32 characters, random,
     * server-only, and different from QR_SIGNING_SECRET so the two can be rotated independently.
     * It is what lets the API show a code again; scanning only needs the stored hash. So changing
     * it leaves printed cards scanning but stops the API displaying them until each is regenerated
     * (and does NOT invalidate them: to retire codes, revoke or regenerate them). Treat it like a
     * database password.
     */
    EMPLOYEE_QR_SECRET: z.string().min(32),

    CORS_ORIGINS: originList,
    /** WebAuthn relying-party id: the web app's domain. Defaults to the first CORS origin's host. */
    WEBAUTHN_RP_ID: z.string().min(1).max(253).optional(),
    WEBAUTHN_RP_NAME: z.string().min(1).max(100).default('TeachGrow Attendance'),
    TRUST_PROXY: z.string().optional(),
    /** Per client IP, all routes. High on purpose: a whole office can share one public IP. */
    RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(1000),
    /** Per signed-in user, after authentication. */
    USER_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(10_000).default(240),

    AUTH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    /** Defaults to true in production, false otherwise (plain-HTTP local development). */
    AUTH_COOKIE_SECURE: optionalBooleanString,
    AUTH_COOKIE_DAYS: z.coerce.number().int().min(1).max(90).default(7),

    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** Failed sign-ins allowed per client IP per 15 minutes (successful ones are not counted). */
    LOGIN_IP_FAILURE_LIMIT: z.coerce.number().int().min(3).max(1000).default(30),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    // Validate TRUST_PROXY eagerly so a bad value stops the process at boot.
    try {
      parseTrustProxy(env.TRUST_PROXY);
    } catch (error) {
      fail('TRUST_PROXY', error instanceof Error ? error.message : 'invalid');
    }

    if (env.AUTH_COOKIE_SAMESITE === 'none' && env.AUTH_COOKIE_SECURE === false) {
      fail('AUTH_COOKIE_SECURE', 'must be true when AUTH_COOKIE_SAMESITE is "none"');
    }

    if (env.NODE_ENV === 'production') {
      if (env.TRUST_PROXY === undefined) {
        fail(
          'TRUST_PROXY',
          'must be set explicitly in production (use "false" if the API is directly exposed)',
        );
      }
      if (env.CORS_ORIGINS.length === 0) {
        fail('CORS_ORIGINS', 'must list at least one allowed origin in production');
      }
      if (!env.DB_SSL && !/(localhost|127\.0\.0\.1|\[::1\])/.test(env.DATABASE_URL)) {
        fail('DB_SSL', 'must be true when connecting to a remote database in production');
      }
      if (env.AUTH_COOKIE_SECURE === false) {
        fail('AUTH_COOKIE_SECURE', 'cannot be false in production');
      }
      if (!env.SUPABASE_URL.startsWith('https://') && !isLocalUrl(env.SUPABASE_URL)) {
        fail('SUPABASE_URL', 'must use https:// in production');
      }
      // The template ships a placeholder that is long enough to pass the length check, and it is
      // public. Anyone who knew it could mint office QR codes.
      if (/replace-with|changeme|change-me|your-secret/i.test(env.QR_SIGNING_SECRET)) {
        fail(
          'QR_SIGNING_SECRET',
          'still has the placeholder from .env.example; generate a real one',
        );
      }
      if (/replace-with|changeme|change-me|your-secret/i.test(env.EMPLOYEE_QR_SECRET)) {
        fail(
          'EMPLOYEE_QR_SECRET',
          'still has the placeholder from .env.example; generate a real one',
        );
      }
      // One secret for both would mean rotating the lobby code also kills every printed ID card.
      if (env.EMPLOYEE_QR_SECRET === env.QR_SIGNING_SECRET) {
        fail('EMPLOYEE_QR_SECRET', 'must differ from QR_SIGNING_SECRET');
      }
    }
  })
  .transform((env) => {
    const base = env.SUPABASE_URL.replace(/\/+$/, '');
    const firstOrigin = env.CORS_ORIGINS[0];
    return {
      ...env,
      AUTH_COOKIE_SECURE: env.AUTH_COOKIE_SECURE ?? env.NODE_ENV === 'production',
      JWT_ISSUER: env.JWT_ISSUER ?? `${base}/auth/v1`,
      SUPABASE_JWKS_URL: env.SUPABASE_JWKS_URL ?? `${base}/auth/v1/.well-known/jwks.json`,
      WEBAUTHN_RP_ID:
        env.WEBAUTHN_RP_ID ?? (firstOrigin ? new URL(firstOrigin).hostname : 'localhost'),
    };
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/**
 * Validates environment variables. Error messages name the variable and the rule,
 * but never echo the offending value (it may be a secret).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `${name}: ${issue.message}`;
    });
    throw new EnvError(problems);
  }
  return result.data;
}
