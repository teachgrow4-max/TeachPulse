import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPLOYEE_QR_PATTERN, EMPLOYEE_QR_PREFIX } from '@teachgrow/shared';
import {
  deriveEmployeeQrKey,
  derivePayload,
  hashPayload,
  isWellFormed,
  newNonce,
} from './token.js';

const SECRET = 'employee-qr-secret-for-tests-0123456789abcdef';
const key = deriveEmployeeQrKey(SECRET);
const employee = randomUUID();

describe('employee QR code', () => {
  it('has a fixed, recognisable shape and nothing else in it', () => {
    const payload = derivePayload(key, employee, newNonce());
    expect(payload).toMatch(EMPLOYEE_QR_PATTERN);
    expect(payload.startsWith(`${EMPLOYEE_QR_PREFIX}.`)).toBe(true);
    // 43 base64url characters carry 32 bytes: the whole token is the MAC.
    expect(payload).toHaveLength(EMPLOYEE_QR_PREFIX.length + 1 + 43);
    expect(isWellFormed(payload)).toBe(true);
  });

  it('does not contain the employee id, the nonce, or anything derived from a name', () => {
    const nonce = newNonce();
    const payload = derivePayload(key, employee, nonce);
    expect(payload).not.toContain(employee);
    expect(payload).not.toContain(employee.replaceAll('-', ''));
    expect(payload).not.toContain(nonce.toString('hex'));
    expect(payload).not.toContain(nonce.toString('base64url'));
  });

  it('is the same every time for the same person and nonce (so it can be shown again)', () => {
    const nonce = newNonce();
    expect(derivePayload(key, employee, nonce)).toBe(derivePayload(key, employee, nonce));
  });

  it('changes completely with a new nonce, which is how regeneration kills the old code', () => {
    const first = derivePayload(key, employee, newNonce());
    const second = derivePayload(key, employee, newNonce());
    expect(second).not.toBe(first);
    expect(hashPayload(second).equals(hashPayload(first))).toBe(false);
  });

  it('is different for different people even with the same nonce', () => {
    const nonce = newNonce();
    expect(derivePayload(key, randomUUID(), nonce)).not.toBe(
      derivePayload(key, randomUUID(), nonce),
    );
  });

  it('cannot be reproduced without the secret', () => {
    const nonce = newNonce();
    const other = deriveEmployeeQrKey('a-completely-different-secret-0123456789abcdef');
    expect(derivePayload(other, employee, nonce)).not.toBe(derivePayload(key, employee, nonce));
  });

  it('is not related to the lobby QR key even if the same secret text were reused', () => {
    // The key is derived with a purpose-specific salt, so it is not the raw secret.
    expect(key.equals(Buffer.from(SECRET))).toBe(false);
    expect(key).toHaveLength(32);
  });

  it('is stored as a 32-byte SHA-256 of the exact text', () => {
    const payload = derivePayload(key, employee, newNonce());
    const hash = hashPayload(payload);
    expect(hash).toHaveLength(32);
    expect(hash.equals(hashPayload(payload))).toBe(true);
    expect(hash.equals(hashPayload(`${payload} `))).toBe(false);
    expect(hash.equals(hashPayload(payload.toLowerCase()))).toBe(false);
  });

  it('accepts exactly one spelling of a code (no base64url malleability)', () => {
    // The last base64url character of a 32-byte value carries only 4 bits, so decoding would map
    // four different last characters to the same bytes. Hashing the exact text must not.
    const payload = derivePayload(key, employee, newNonce());
    const body = payload.slice(0, -1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const accepted = [...alphabet].filter((c) =>
      hashPayload(body + c).equals(hashPayload(payload)),
    );
    expect(accepted).toEqual([payload.slice(-1)]);
  });

  describe('isWellFormed', () => {
    const good = derivePayload(key, employee, newNonce());
    it.each([
      ['empty', ''],
      ['no prefix', good.slice(5)],
      ['lobby prefix', good.replace('TGE1', 'TG1')],
      ['wrong case', good.replace('TGE1', 'tge1')],
      ['too short', good.slice(0, -1)],
      ['too long', `${good}A`],
      ['padding', `${good.slice(0, -1)}=`],
      ['whitespace', `${good} `],
      ['newline', `${good}\n`],
      ['plus sign', `${good.slice(0, -1)}+`],
      ['slash', `${good.slice(0, -1)}/`],
      ['a URL', `https://example.com/${good}`],
    ])('rejects %s', (_label, text) => {
      expect(isWellFormed(text)).toBe(false);
    });
  });
});
