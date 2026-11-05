import { PassThrough } from 'node:stream';
import { AuthApiError, AuthRetryableFetchError, AuthWeakPasswordError } from '@supabase/auth-js';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { passwordSchema } from '@teachgrow/shared';
import { redact, writeAudit } from '../audit/audit.js';
import { normalizeIp, requestMeta } from '../lib/request-meta.js';
import { createPrompter } from '../scripts/prompt.js';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies.js';
import { assertTrustedBrowserRequest } from './csrf.js';
import { AuthGatewayError, mapGatewayError } from './gateway.js';
import { generateTemporaryPassword } from './password.js';
import { subjectHashOf } from './lockout.js';

describe('generateTemporaryPassword', () => {
  it('always satisfies the password policy', () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateTemporaryPassword();
      expect(passwordSchema.safeParse(password).success, password).toBe(true);
      expect(password).toHaveLength(16);
    }
  });

  it('avoids look-alike characters so it can be read aloud or copied from paper', () => {
    for (let i = 0; i < 300; i += 1) expect(generateTemporaryPassword()).not.toMatch(/[0O1lI]/);
  });

  it('is unpredictable: no repeats and no fixed layout of character classes', () => {
    const samples = Array.from({ length: 300 }, () => generateTemporaryPassword());
    expect(new Set(samples).size).toBe(samples.length);
    const firstCharClasses = new Set(
      samples.map((p) => (/[a-z]/.test(p[0]!) ? 'l' : /[A-Z]/.test(p[0]!) ? 'u' : 'd')),
    );
    expect(firstCharClasses.size).toBe(3);
  });

  it('honours a longer length but refuses weak short ones', () => {
    expect(generateTemporaryPassword(24)).toHaveLength(24);
    expect(() => generateTemporaryPassword(8)).toThrow(RangeError);
  });
});

describe('subjectHashOf', () => {
  it('is stable, case-insensitive and does not contain the address', () => {
    expect(subjectHashOf('Asha@TeachGrow.test')).toBe(subjectHashOf('  asha@teachgrow.test '));
    expect(subjectHashOf('asha@teachgrow.test')).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectHashOf('asha@teachgrow.test')).not.toContain('asha');
    expect(subjectHashOf('a@teachgrow.test')).not.toBe(subjectHashOf('b@teachgrow.test'));
  });
});

describe('assertTrustedBrowserRequest', () => {
  const allowed = ['https://app.teachgrow.test'];
  const reqWith = (headers: Record<string, string>) =>
    ({ get: (name: string) => headers[name.toLowerCase()] }) as never;

  it('accepts a listed origin carrying the custom header', () => {
    expect(() =>
      assertTrustedBrowserRequest(
        reqWith({ origin: 'https://app.teachgrow.test', 'x-requested-with': 'teachgrow-web' }),
        allowed,
      ),
    ).not.toThrow();
  });

  it.each([
    ['no Origin', { 'x-requested-with': 'teachgrow-web' }],
    ['an unlisted Origin', { origin: 'https://evil.test', 'x-requested-with': 'teachgrow-web' }],
    ['the literal Origin "null"', { origin: 'null', 'x-requested-with': 'teachgrow-web' }],
    [
      'a look-alike Origin',
      { origin: 'https://app.teachgrow.test.evil.test', 'x-requested-with': 'teachgrow-web' },
    ],
    [
      'a different scheme',
      { origin: 'http://app.teachgrow.test', 'x-requested-with': 'teachgrow-web' },
    ],
    ['no custom header', { origin: 'https://app.teachgrow.test' }],
    [
      'the wrong custom header value',
      { origin: 'https://app.teachgrow.test', 'x-requested-with': 'XMLHttpRequest' },
    ],
  ])('rejects %s', (_label, headers) => {
    expect(() => assertTrustedBrowserRequest(reqWith(headers), allowed)).toThrowError(
      expect.objectContaining({ code: 'CSRF_REJECTED', status: 403 }),
    );
  });

  it('rejects everything when no origin is configured', () => {
    expect(() =>
      assertTrustedBrowserRequest(
        reqWith({ origin: 'https://app.teachgrow.test', 'x-requested-with': 'teachgrow-web' }),
        [],
      ),
    ).toThrow();
  });
});

describe('refresh cookie', () => {
  const app = express();
  app.get('/set', (_req, res) => {
    setRefreshCookie(res, 'tok_123', { secure: true, sameSite: 'strict', maxAgeSeconds: 600 });
    res.end();
  });
  app.get('/clear', (_req, res) => {
    clearRefreshCookie(res, { secure: true, sameSite: 'strict' });
    res.end();
  });
  app.get('/read', (req, res) => {
    res.json({ value: readRefreshCookie(req) ?? null });
  });

  it('is HttpOnly, Secure, SameSite=Strict and confined to /api/auth', async () => {
    const header = String((await request(app).get('/set')).headers['set-cookie']);
    expect(header).toContain(`${REFRESH_COOKIE_NAME}=tok_123`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toContain('Path=/api/auth');
    expect(header).toMatch(/Max-Age=600/i);
  });

  it('is removed with the same scoping attributes so the browser actually deletes it', async () => {
    const header = String((await request(app).get('/clear')).headers['set-cookie']);
    expect(header).toContain(`${REFRESH_COOKIE_NAME}=;`);
    expect(header).toContain('Path=/api/auth');
    expect(header).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(header).toMatch(/HttpOnly/i);
  });

  it('is read back from the Cookie header, ignoring other cookies and oversized values', async () => {
    const ok = await request(app)
      .get('/read')
      .set('Cookie', `a=1; ${REFRESH_COOKIE_NAME}=tok_123; b=2`);
    expect(ok.body.value).toBe('tok_123');
    const none = await request(app).get('/read').set('Cookie', 'a=1');
    expect(none.body.value).toBeNull();
    const huge = await request(app)
      .get('/read')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${'x'.repeat(3000)}`);
    expect(huge.body.value).toBeNull();
  });
});

describe('audit redaction', () => {
  it('replaces secrets at any depth but keeps flags and ordinary data', () => {
    const redacted = redact({
      password: 'hunter2',
      newPassword: 'hunter3',
      accessToken: 'abc',
      refresh_token: 'def',
      authorization: 'Bearer xyz',
      apiKey: 'k',
      nested: { clientSecret: 's', keep: 'visible', list: [{ cookie: 'c', ok: 1 }] },
      must_change_password: true,
      email: 'asha@teachgrow.test',
      when: new Date('2026-11-02T04:30:00Z'),
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toMatch(/hunter|abc|def|Bearer|"k"|"s"|"c"/);
    expect(redacted).toMatchObject({
      password: '[redacted]',
      nested: { keep: 'visible', list: [{ cookie: '[redacted]', ok: 1 }] },
      must_change_password: true,
      email: 'asha@teachgrow.test',
      when: '2026-11-02T04:30:00.000Z',
    });
  });

  it('does not recurse forever on deep structures', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('writes a redacted, normalised row', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    await writeAudit(
      {
        query: async (text, params) => {
          calls.push({ text, params: [...(params ?? [])] });
          return { rows: [], rowCount: 0 };
        },
      },
      {
        action: 'employee.update',
        actorId: 'actor-1',
        before: { fullName: 'Old', password: 'p' },
        after: { fullName: 'New' },
        metadata: { token: 't' },
        ip: '203.0.113.5',
      },
    );
    expect(calls).toHaveLength(1);
    const params = calls[0]!.params;
    expect(params[3]).toBe('employee.update');
    expect(JSON.parse(params[6] as string)).toEqual({ fullName: 'Old', password: '[redacted]' });
    expect(JSON.parse(params[8] as string)).toEqual({ token: '[redacted]' });
    expect(params[9]).toBe('203.0.113.5');
  });
});

describe('request metadata', () => {
  it('normalises IPv4-mapped IPv6 and drops invalid addresses', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it('truncates a hostile user agent', () => {
    const meta = requestMeta({
      ip: '::ffff:10.0.0.1',
      requestId: 'r1',
      get: () => 'x'.repeat(5000),
    } as never);
    expect(meta.userAgent).toHaveLength(512);
    expect(meta.ip).toBe('10.0.0.1');
    expect(meta.requestId).toBe('r1');
  });
});

describe('mapGatewayError', () => {
  const kind = (error: unknown) => mapGatewayError(error).kind;

  it.each([
    ['invalid_credentials', 400, 'invalid_credentials'],
    ['user_banned', 400, 'user_banned'],
    ['email_exists', 422, 'email_exists'],
    ['user_already_exists', 422, 'email_exists'],
    ['weak_password', 422, 'weak_password'],
    ['refresh_token_not_found', 400, 'refresh_token_invalid'],
    ['refresh_token_already_used', 400, 'refresh_token_invalid'],
    ['session_not_found', 400, 'refresh_token_invalid'],
    ['over_request_rate_limit', 429, 'rate_limited'],
    ['unexpected_failure', 500, 'unavailable'],
    ['something_new', 400, 'unknown'],
  ])('maps provider code %s (HTTP %i) to %s', (code, status, expected) => {
    const mapped = mapGatewayError(new AuthApiError('boom', status, code));
    expect(mapped.kind).toBe(expected);
    expect(mapped.code).toBe(code);
  });

  it('maps by HTTP status when the provider sends no code', () => {
    expect(kind(new AuthApiError('slow down', 429, undefined))).toBe('rate_limited');
    expect(kind(new AuthApiError('down', 503, undefined))).toBe('unavailable');
  });

  it('maps network failures to "unavailable" and carries weak-password reasons', () => {
    expect(kind(new AuthRetryableFetchError('fetch failed', 0))).toBe('unavailable');
    const weak = mapGatewayError(new AuthWeakPasswordError('weak', 422, ['length']));
    expect(weak.kind).toBe('weak_password');
    expect(weak.reasons).toEqual(['length']);
  });

  it('passes an already-mapped error through and flags anything unrecognised as unknown', () => {
    const own = new AuthGatewayError('rate_limited', 'x');
    expect(mapGatewayError(own)).toBe(own);
    expect(kind(new Error('mystery'))).toBe('unknown');
    expect(kind('a string')).toBe('unknown');
  });
});

describe('createPrompter without a terminal', () => {
  it('reads plain and secret answers line by line from a pipe', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createPrompter(input, output);
    expect(prompter.interactive).toBe(false);

    const first = prompter.ask('Name: ');
    input.write('Asha Rao\n');
    expect(await first).toBe('Asha Rao');

    const second = prompter.askSecret('Password: ');
    input.write('s3cret-Value1\n');
    expect(await second).toBe('s3cret-Value1');
    expect(output.read()?.toString()).toContain('Name: ');
  });

  it('fails clearly if the input ends before an answer arrives', async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, new PassThrough());
    const pending = prompter.ask('Name: ');
    input.end();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
