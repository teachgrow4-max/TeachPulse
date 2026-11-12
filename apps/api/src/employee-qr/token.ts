import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { EMPLOYEE_QR_PATTERN, EMPLOYEE_QR_PREFIX } from '@teachgrow/shared';

/**
 * The personal QR code printed on an employee's ID card.
 *
 *     TGE1.<token>      token = base64url( HMAC-SHA256(key, employeeId "\n" nonce-hex) )   (43 chars)
 *
 * Why it is derived rather than simply random-and-forgotten: the employee and the administrators
 * must be able to see the SAME code again whenever they want it (profile page, ID-card download),
 * yet the database must not hold anything that works as a code. So:
 *
 *   - `nonce` is 32 random bytes from the operating system's CSPRNG, stored next to the hash;
 *   - `key` is derived (HKDF-SHA256) from EMPLOYEE_QR_SECRET, which only the API process holds;
 *   - the token is the HMAC of the two, so it is as unguessable as a random 256-bit value;
 *   - the database stores only SHA-256 of the full code text.
 *
 * Reading the table therefore reveals no usable code (the secret is also needed), the API can
 * re-derive a code on demand, and issuing a new nonce kills every earlier code instantly.
 * Nothing about the employee is inside the code.
 *
 * Lookups hash the exact text that was scanned. Never decode the base64url: several spellings of
 * the final character decode to the same bytes, which once let one office QR scan be reused
 * (docs/phase-reports/PHASE-5.md). Exact text means exactly one spelling is accepted.
 */

const HKDF_SALT = 'teachgrow/employee-qr/v1';
const HKDF_INFO = 'token-key';

/** The HMAC key, derived once at start-up from EMPLOYEE_QR_SECRET. */
export function deriveEmployeeQrKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32));
}

/** 32 fresh random bytes: what makes a new code different from every earlier one. */
export const newNonce = (): Buffer => randomBytes(32);

/** The full text to draw as a QR image. */
export function derivePayload(key: Buffer, employeeId: string, nonce: Buffer): string {
  const token = createHmac('sha256', key)
    .update(`${employeeId}\n${nonce.toString('hex')}`)
    .digest('base64url');
  return `${EMPLOYEE_QR_PREFIX}.${token}`;
}

/** What the database stores: SHA-256 of the exact text. */
export const hashPayload = (payload: string): Buffer =>
  createHash('sha256').update(payload, 'utf8').digest();

/** Is this text shaped like an employee code at all? (It says nothing about whether it is valid.) */
export const isWellFormed = (text: string): boolean => EMPLOYEE_QR_PATTERN.test(text);
