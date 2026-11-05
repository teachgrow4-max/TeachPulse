import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registrationProofMessage, verificationProofMessage } from '@teachgrow/shared';
import { SoftwareDevice } from '../testing/software-device.js';
import { DeviceProofError, parseAppPublicKey, verifyAppSignature } from './proofs.js';

const spki = (type: 'rsa' | 'ed25519' | 'p384') => {
  const pair =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : type === 'ed25519'
        ? generateKeyPairSync('ed25519')
        : generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
};

describe('parseAppPublicKey', () => {
  const phone = new SoftwareDevice();

  it('accepts a P-256 public key and returns its canonical spelling', () => {
    const parsed = parseAppPublicKey(phone.publicKey);
    expect(parsed.canonical).toBe(phone.publicKey);
    expect(parsed.key.asymmetricKeyType).toBe('ec');
  });

  it('gives one key one spelling, however the final character was written', () => {
    // SPKI for P-256 is 91 bytes = 121.33 base64url characters: the last character has spare bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const spellings = [...alphabet].map((ch) => phone.publicKey.slice(0, -1) + ch);
    const canonical = new Set(
      spellings.flatMap((s) => {
        try {
          return [parseAppPublicKey(s).canonical];
        } catch {
          return [];
        }
      }),
    );
    expect([...canonical]).toEqual([phone.publicKey]);
  });

  it('keeps only the key itself: bytes after the key structure are dropped, never stored', () => {
    // OpenSSL ignores anything after the first ASN.1 structure; we re-encode so nothing rides along.
    expect(parseAppPublicKey(`${phone.publicKey}AAAA`).canonical).toBe(phone.publicKey);
  });

  it.each([
    ['an RSA key', () => spki('rsa')],
    ['an Ed25519 key', () => spki('ed25519')],
    ['a P-384 key', () => spki('p384')],
    ['text that is not a key', () => 'not-a-key'],
    ['an empty string', () => ''],
    ['a truncated key', () => phone.publicKey.slice(0, 60)],
  ])('refuses %s', (_label, make) => {
    expect(() => parseAppPublicKey(make())).toThrow(DeviceProofError);
    try {
      parseAppPublicKey(make());
    } catch (error) {
      expect((error as DeviceProofError).kind).toBe('malformed_key');
    }
  });
});

describe('verifyAppSignature', () => {
  const phone = new SoftwareDevice();
  const message = verificationProofMessage({
    challenge: 'c'.repeat(43),
    employeeId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    purpose: 'CHECK_IN',
  });
  const good = phone.signMessage(message);

  it('accepts a genuine signature over exactly this message', () => {
    expect(verifyAppSignature(phone.publicKey, message, good)).toBe(true);
  });

  it('accepts registration proofs too: same mechanism, different message', () => {
    const registration = registrationProofMessage({
      challenge: 'c'.repeat(43),
      employeeId: '11111111-1111-4111-8111-111111111111',
      platform: 'ANDROID',
      deviceIdentifier: phone.identifier,
    });
    expect(verifyAppSignature(phone.publicKey, registration, phone.signMessage(registration))).toBe(
      true,
    );
  });

  it.each([
    ['another challenge', { challenge: 'd'.repeat(43) }],
    ['another employee', { employeeId: '33333333-3333-4333-8333-333333333333' }],
    ['another device id', { deviceId: '44444444-4444-4444-8444-444444444444' }],
    ['another purpose', { purpose: 'CHECK_OUT' as const }],
  ])('rejects a signature made for %s', (_label, change) => {
    const other = verificationProofMessage({
      challenge: 'c'.repeat(43),
      employeeId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      purpose: 'CHECK_IN',
      ...change,
    });
    expect(verifyAppSignature(phone.publicKey, other, good)).toBe(false);
  });

  it('keeps a check-in signature from being used to register, and the reverse', () => {
    const registration = registrationProofMessage({
      challenge: 'c'.repeat(43),
      employeeId: '11111111-1111-4111-8111-111111111111',
      platform: 'ANDROID',
      deviceIdentifier: phone.identifier,
    });
    expect(verifyAppSignature(phone.publicKey, registration, good)).toBe(false);
    expect(verifyAppSignature(phone.publicKey, message, phone.signMessage(registration))).toBe(
      false,
    );
  });

  it('rejects a signature from a different key', () => {
    const stranger = new SoftwareDevice();
    expect(verifyAppSignature(phone.publicKey, message, stranger.signMessage(message))).toBe(false);
  });

  it('rejects a DER-encoded signature: the contract is r||s', () => {
    const der = sign('sha256', Buffer.from(message), phone.privateKey).toString('base64url');
    expect(verifyAppSignature(phone.publicKey, message, der)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', good.slice(0, 40)],
    ['too long', `${good}AAAA`],
    ['not base64url', '!!!!'],
    ['all zeros', 'A'.repeat(86)],
  ])('rejects a malformed signature (%s) without throwing', (_label, signature) => {
    expect(verifyAppSignature(phone.publicKey, message, signature)).toBe(false);
  });

  it('answers false, not an exception, when the stored key is unusable', () => {
    expect(verifyAppSignature('garbage', message, good)).toBe(false);
    expect(verifyAppSignature(spki('rsa'), message, good)).toBe(false);
  });
});
