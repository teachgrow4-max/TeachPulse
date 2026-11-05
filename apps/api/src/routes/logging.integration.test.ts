import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/pool.js';
import { createLogger } from '../lib/logger.js';
import {
  WEB_HEADERS,
  bearer,
  cookieHeader,
  createAccount,
  setCookieOf,
  useApi,
  webLogin,
} from '../testing/api-harness.js';

const h = useApi();

/**
 * Secrets must never reach the logs - not in success paths, not in failure paths, not in
 * unexpected-error paths. This captures everything the logger writes and searches it.
 */
function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const env = h.envWith({ NODE_ENV: 'development', LOG_LEVEL: 'trace' });
  return { lines, logger: createLogger(env, sink), text: () => lines.join('') };
}

describe('log hygiene', () => {
  it('logs requests but never passwords, tokens, cookies or temporary passwords', async () => {
    const log = capture();
    h.app = h.build({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' },
      logger: log.logger,
    });

    const SECRET_PASSWORD = 'Super-Secret-Passw0rd!';
    const NEW_PASSWORD = 'Another-Secret-Passw0rd9';
    const WRONG_PASSWORD = 'Definitely-Wrong-Passw0rd1';
    const admin = await createAccount(h, { role: 'admin', password: SECRET_PASSWORD });

    const login = await webLogin(h, admin);
    const accessToken = login.body.accessToken as string;
    const refreshCookie = setCookieOf(login)!.value!;

    await request(h.app).get('/api/auth/me').set(bearer(accessToken));
    await webLogin(h, { email: admin.email, password: WRONG_PASSWORD });

    const refreshed = await request(h.app)
      .post('/api/auth/refresh')
      .set(WEB_HEADERS)
      .set(cookieHeader(refreshCookie));
    const newAccess = refreshed.body.accessToken as string;
    const newRefresh = setCookieOf(refreshed)!.value!;

    const created = await request(h.app).post('/api/admin/employees').set(bearer(newAccess)).send({
      employeeCode: 'TG-777',
      fullName: 'Logged Person',
      email: 'logged@teachgrow.test',
      joiningDate: '2026-11-02',
    });
    const temporaryPassword = created.body.temporaryPassword as string;
    expect(temporaryPassword).toBeTruthy();

    await request(h.app)
      .post('/api/auth/change-password')
      .set(bearer(newAccess))
      .send({ currentPassword: SECRET_PASSWORD, newPassword: NEW_PASSWORD });
    await request(h.app)
      .post('/api/auth/logout')
      .set(WEB_HEADERS)
      .set(bearer(newAccess))
      .set(cookieHeader(newRefresh))
      .send({});

    const logs = log.text();

    // The logger was genuinely active and recorded the traffic...
    expect(logs).toContain('/api/auth/login');
    expect(logs).toContain('"statusCode":200');
    expect(logs).toContain('"statusCode":401');

    // ...but none of the secrets that flowed through the system are in it.
    for (const [label, secret] of Object.entries({
      'current password': SECRET_PASSWORD,
      'new password': NEW_PASSWORD,
      'wrong password': WRONG_PASSWORD,
      'access token': accessToken,
      'rotated access token': newAccess,
      'refresh token': refreshCookie,
      'rotated refresh token': newRefresh,
      'temporary password': temporaryPassword,
    })) {
      expect(logs, `${label} leaked into the logs`).not.toContain(secret);
    }
    expect(logs).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    expect(logs).not.toContain('tg_refresh=');
  });

  it('logs only the path of a request, never its query string', async () => {
    const log = capture();
    h.app = h.build({ env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' }, logger: log.logger });
    const admin = await createAccount(h, { role: 'admin' });
    const login = await webLogin(h, admin);
    await request(h.app)
      .get('/api/admin/employees?search=secret-search-term&token=abc123')
      .set(bearer(login.body.accessToken));
    expect(log.text()).toContain('/api/admin/employees');
    expect(log.text()).not.toContain('secret-search-term');
    expect(log.text()).not.toContain('abc123');
  });

  it('logs unexpected failures server-side with detail, while telling the client nothing', async () => {
    const log = capture();
    const failingDb: Db = {
      ...h.db,
      withTransaction: async () => {
        throw new Error('boom: connection to 10.0.0.5 refused');
      },
    };
    h.app = h.build({
      env: { NODE_ENV: 'development', LOG_LEVEL: 'trace' },
      logger: log.logger,
      db: failingDb,
    });
    const admin = await createAccount(h, { role: 'admin' });
    const login = await webLogin(h, admin);
    const res = await request(h.app)
      .post('/api/admin/employees')
      .set(bearer(login.body.accessToken))
      .send({
        employeeCode: 'TG-778',
        fullName: 'Nobody',
        email: 'nobody@teachgrow.test',
        joiningDate: '2026-11-02',
      });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    expect(log.text()).toContain('10.0.0.5'); // operators can still diagnose it
    expect(log.text()).toContain(res.body.error.requestId); // and correlate it with the response
  });
});
