import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  QR_EARLY_TOLERANCE_SECONDS,
  QR_GRACE_SECONDS,
  buildPayload,
  checkQrPayload,
  currentQr,
  deriveCode,
  hashCode,
  windowIndexAt,
  windowOf,
  type QrOffice,
} from './qr.js';

const SECRET = 'a-long-random-qr-signing-secret-for-tests-000000';
const OFFICE: QrOffice = { id: randomUUID(), rotationSeconds: 30 };

/** 2026-11-02T04:30:00Z is exactly on a 30-second boundary. */
const T0 = new Date('2026-11-02T04:30:00Z');
const INDEX0 = windowIndexAt(T0, 30);
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const payloadFor = (index: number, office: QrOffice = OFFICE, secret = SECRET) =>
  buildPayload(index, deriveCode(secret, office, index));

describe('windows', () => {
  it('cuts time into fixed windows that tile without gaps', () => {
    expect(windowIndexAt(T0, 30)).toBe(INDEX0);
    expect(windowIndexAt(at(29.999), 30)).toBe(INDEX0);
    expect(windowIndexAt(at(30), 30)).toBe(INDEX0 + 1);
    expect(windowIndexAt(at(-0.001), 30)).toBe(INDEX0 - 1);
    expect(windowIndexAt(at(45), 60)).toBe(windowIndexAt(T0, 60));
  });

  it('knows where a window starts, ends, and when its grace period ends', () => {
    const w = windowOf(INDEX0, 30);
    expect(w.validFrom).toEqual(T0);
    expect(w.expiresAt).toEqual(at(30));
    expect(w.acceptUntil).toEqual(at(30 + QR_GRACE_SECONDS));
    expect(windowOf(INDEX0 + 1, 30).validFrom).toEqual(w.expiresAt);
  });
});

describe('deriveCode', () => {
  it('is deterministic and a 43-character base64url string', () => {
    const code = deriveCode(SECRET, OFFICE, INDEX0);
    expect(code).toBe(deriveCode(SECRET, OFFICE, INDEX0));
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('changes with the window, the office, the rotation setting and the secret', () => {
    const base = deriveCode(SECRET, OFFICE, INDEX0);
    const variants = [
      deriveCode(SECRET, OFFICE, INDEX0 + 1),
      deriveCode(SECRET, { ...OFFICE, id: randomUUID() }, INDEX0),
      deriveCode(SECRET, { ...OFFICE, rotationSeconds: 60 }, INDEX0),
      deriveCode(`${SECRET}x`, OFFICE, INDEX0),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set([base, ...variants]).size).toBe(5);
  });

  it('never repeats across a long run of consecutive windows', () => {
    const codes = new Set(
      Array.from({ length: 2000 }, (_, i) => deriveCode(SECRET, OFFICE, INDEX0 + i)),
    );
    expect(codes.size).toBe(2000);
  });
});

describe('currentQr (what the lobby screen shows)', () => {
  it('shows the current window and previews the next one', () => {
    const display = currentQr(SECRET, OFFICE, at(12));
    expect(display.payload).toBe(payloadFor(INDEX0));
    expect(display.window.index).toBe(INDEX0);
    expect(display.next.payload).toBe(payloadFor(INDEX0 + 1));
    expect(display.next.window.validFrom).toEqual(display.window.expiresAt);
  });

  it('rotates exactly on the boundary', () => {
    expect(currentQr(SECRET, OFFICE, at(29.999)).payload).toBe(payloadFor(INDEX0));
    expect(currentQr(SECRET, OFFICE, at(30)).payload).toBe(payloadFor(INDEX0 + 1));
  });

  it('produces a payload the checker accepts', () => {
    const display = currentQr(SECRET, OFFICE, at(5));
    expect(checkQrPayload(SECRET, OFFICE, display.payload, at(5)).status).toBe('OK');
  });

  it('respects a 60-second rotation setting', () => {
    const slow = { ...OFFICE, rotationSeconds: 60 };
    const a = currentQr(SECRET, slow, at(1));
    const b = currentQr(SECRET, slow, at(59));
    const c = currentQr(SECRET, slow, at(61));
    expect(a.payload).toBe(b.payload);
    expect(c.payload).not.toBe(a.payload);
  });
});

describe('checkQrPayload - timing', () => {
  const index = INDEX0;
  const payload = payloadFor(index);

  it('accepts the code throughout its window', () => {
    for (const second of [0, 1, 15, 29.9]) {
      expect(checkQrPayload(SECRET, OFFICE, payload, at(second)).status, `${second}s`).toBe('OK');
    }
  });

  it('accepts it a little early (display clock drift) but not further back', () => {
    expect(checkQrPayload(SECRET, OFFICE, payload, at(-QR_EARLY_TOLERANCE_SECONDS)).status).toBe(
      'OK',
    );
    expect(
      checkQrPayload(SECRET, OFFICE, payload, at(-QR_EARLY_TOLERANCE_SECONDS - 0.001)).status,
    ).toBe('INVALID');
    expect(checkQrPayload(SECRET, OFFICE, payload, at(-3600)).status).toBe('INVALID');
  });

  it('accepts it through the grace period after the window, then reports it expired', () => {
    expect(checkQrPayload(SECRET, OFFICE, payload, at(30)).status).toBe('OK');
    expect(checkQrPayload(SECRET, OFFICE, payload, at(30 + QR_GRACE_SECONDS)).status).toBe('OK');
    const expired = checkQrPayload(SECRET, OFFICE, payload, at(30 + QR_GRACE_SECONDS + 0.001));
    expect(expired.status).toBe('EXPIRED');
    expect(checkQrPayload(SECRET, OFFICE, payload, at(3600)).status).toBe('EXPIRED');
  });

  it('therefore never accepts a code for longer than window + grace', () => {
    const lifetime = 30 + QR_GRACE_SECONDS + QR_EARLY_TOLERANCE_SECONDS;
    expect(lifetime).toBe(45);
    let accepted = 0;
    for (let tenths = -100; tenths <= 800; tenths += 1) {
      if (checkQrPayload(SECRET, OFFICE, payload, at(tenths / 10)).status === 'OK') accepted += 1;
    }
    expect(accepted / 10).toBeLessThanOrEqual(lifetime + 0.1);
  });

  it('returns the data needed to record the scan', () => {
    const result = checkQrPayload(SECRET, OFFICE, payload, at(10));
    if (result.status !== 'OK') throw new Error('expected OK');
    expect(result.window).toEqual(windowOf(index, 30));
    expect(result.codeHash).toHaveLength(32);
    expect(result.codeHash.equals(hashCode(result.code))).toBe(true);
    expect(result.codeHash.equals(createHash('sha256').update(result.code).digest())).toBe(true);
  });
});

describe('checkQrPayload - forgery and malformed input', () => {
  const index = INDEX0;
  const good = payloadFor(index);
  const check = (raw: string, secret = SECRET, office = OFFICE) =>
    checkQrPayload(secret, office, raw, at(10)).status;

  it('rejects a code made with a different secret', () => {
    expect(check(payloadFor(index, OFFICE, 'someone-elses-secret-someone-elses-secret'))).toBe(
      'INVALID',
    );
  });

  it('rejects any single-character change to the code', () => {
    const [prefix, idx, code] = good.split('.') as [string, string, string];
    for (let i = 0; i < code.length; i += 1) {
      const flipped = `${code.slice(0, i)}${code[i] === 'A' ? 'B' : 'A'}${code.slice(i + 1)}`;
      expect(check(`${prefix}.${idx}.${flipped}`), `position ${i}`).toBe('INVALID');
    }
  });

  it('accepts exactly one spelling of a code, whatever its final character is', () => {
    // The 43rd base64url character holds 4 data bits and 2 padding bits, so several spellings
    // decode to the same bytes. Only the canonical one may be accepted, or a single code would
    // answer to four different token hashes and could be used four times.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const [prefix, idx, code] = good.split('.') as [string, string, string];
    const accepted = [...alphabet].filter(
      (ch) => check(`${prefix}.${idx}.${code.slice(0, -1)}${ch}`) === 'OK',
    );
    expect(accepted).toEqual([code.slice(-1)]);
  });

  it('identifies a code by one hash only', () => {
    const [prefix, idx, code] = good.split('.') as [string, string, string];
    const result = checkQrPayload(SECRET, OFFICE, `${prefix}.${idx}.${code}`, at(10));
    expect(result.status).toBe('OK');
    if (result.status === 'OK') expect(result.codeHash.equals(hashCode(code))).toBe(true);
  });

  it('rejects a genuine code replayed under a different window number', () => {
    const code = deriveCode(SECRET, OFFICE, index);
    expect(check(buildPayload(index + 1, code))).toBe('INVALID');
    expect(check(buildPayload(index - 1, code))).toBe('INVALID');
  });

  it('rejects a code for another office and one made before the rotation setting changed', () => {
    expect(check(good, SECRET, { ...OFFICE, id: randomUUID() })).toBe('INVALID');
    expect(check(good, SECRET, { ...OFFICE, rotationSeconds: 60 })).toBe('INVALID');
  });

  it('does not report "expired" for a forged code, so expiry reveals nothing about valid codes', () => {
    const forged = payloadFor(index, OFFICE, 'attacker-secret-attacker-secret-attacker');
    expect(checkQrPayload(SECRET, OFFICE, forged, at(3600)).status).toBe('INVALID');
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', good.replace('TG1', 'TG2')],
    ['lower-case prefix', good.replace('TG1', 'tg1')],
    ['missing window', `TG1..${good.split('.')[2]}`],
    ['non-numeric window', `TG1.abc.${good.split('.')[2]}`],
    ['negative window', `TG1.-5.${good.split('.')[2]}`],
    ['window with leading zeros', `TG1.0${INDEX0}.${good.split('.')[2]}`],
    ['window over 12 digits', `TG1.${'9'.repeat(13)}.${good.split('.')[2]}`],
    ['short code', 'TG1.1.abc'],
    ['long code', `${good}A`],
    ['code with padding', `${good.slice(0, -1)}=`],
    ['surrounding whitespace', ` ${good} `],
    ['trailing newline', `${good}\n`],
    ['embedded null byte', `${good.slice(0, 20)}\0${good.slice(21)}`],
    ['a URL instead of a payload', `https://example.com/?c=${good}`],
    ['SQL-looking text', "TG1.1.'; drop table qr_tokens;--"],
  ])('rejects malformed input: %s', (_label, raw) => {
    expect(check(raw)).toBe('INVALID');
  });

  it('copes with absurd window numbers without throwing or hanging', () => {
    const started = Date.now();
    expect(check(`TG1.${Number.MAX_SAFE_INTEGER}.${'A'.repeat(43)}`)).toBe('INVALID');
    expect(check(`TG1.999999999999.${'A'.repeat(43)}`)).toBe('INVALID');
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('hashCode', () => {
  it('is the SHA-256 of the code text, so only a digest ever needs storing', () => {
    const code = deriveCode(SECRET, OFFICE, INDEX0);
    const hash = hashCode(code);
    expect(hash).toHaveLength(32);
    expect(hash.toString('hex')).toBe(createHash('sha256').update(code).digest('hex'));
    expect(hashCode(code).equals(hash)).toBe(true);
    expect(hashCode(`${code}x`).equals(hash)).toBe(false);
  });
});
