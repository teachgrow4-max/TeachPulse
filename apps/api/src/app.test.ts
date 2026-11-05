import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadEnv, type Env } from './config/env.js';
import type { Db } from './db/pool.js';
import { fixedClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54422/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54421',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  QR_SIGNING_SECRET: 'qr-signing-secret-for-tests-0123456789abcdef',
  CORS_ORIGINS: 'http://localhost:5173',
};

function build(overrides: Record<string, string> = {}, ping: () => Promise<void> = async () => {}) {
  const env: Env = loadEnv({ ...baseEnv, ...overrides });
  const db = {
    ping: vi.fn(ping),
    query: vi.fn(),
    withTransaction: vi.fn(),
    end: vi.fn(),
  } as unknown as Db;
  const app = createApp({
    env,
    logger: createLogger(env),
    db,
    clock: fixedClock('2026-11-05T04:30:00Z'),
  });
  return { app, db, env };
}

describe('health', () => {
  it('liveness returns ok with the server clock time', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', time: '2026-11-05T04:30:00.000Z' });
  });

  it('readiness is 200 when the database answers', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('readiness is 503 with a safe error when the database is down', async () => {
    const { app } = build({}, async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
    });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('10.1.2.3');
  });
});

describe('error responses', () => {
  it('returns a JSON 404 with a request id for unknown routes', async () => {
    const { app } = build();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns 400 VALIDATION_FAILED for malformed JSON without leaking parser details', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|JSON\.parse|position/i);
  });

  it('rejects oversized bodies', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('request id', () => {
  it('echoes a safe client-supplied id', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health').set('X-Request-Id', 'client-req-12345');
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it('replaces an unsafe client-supplied id', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health').set('X-Request-Id', 'bad id with spaces!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('security headers', () => {
  it('sets hardening headers and hides the framework', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('forbids caching of API responses', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('CORS', () => {
  it('allows a listed origin and supports credentials', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives an unlisted origin no CORS headers', async () => {
    const { app } = build();
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight for a listed origin only', async () => {
    const { app } = build();
    const ok = await request(app)
      .options('/api/health')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,idempotency-key');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);

    const bad = await request(app)
      .options('/api/health')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED once the per-minute limit is exceeded', async () => {
    const { app } = build({ RATE_LIMIT_GLOBAL_PER_MIN: '3' });
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app).get('/api/health');
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).get('/api/health');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['ratelimit']).toBeDefined();
  });
});

describe('trust proxy wiring', () => {
  it('defaults to trusting no proxy', () => {
    const { app } = build();
    expect(app.get('trust proxy')).toBe(false);
  });

  it('uses the configured hop count', () => {
    const { app } = build({ TRUST_PROXY: '1' });
    expect(app.get('trust proxy')).toBe(1);
  });
});
