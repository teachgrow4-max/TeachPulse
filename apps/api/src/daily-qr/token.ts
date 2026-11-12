import { createHash, randomBytes } from 'node:crypto';
import { DAILY_QR_PREFIX } from '@teachgrow/shared';

/**
 * The code an employee shows to the scanner:  TGD1.<43 base64url characters>.
 *
 * It is 32 bytes from the operating system's CSPRNG, so it cannot be guessed, derived or
 * recomputed from anything the server keeps. The database stores only SHA-256 of the exact text.
 * Reading the table therefore reveals no usable code, and the code is shown once, to the person
 * who generated it.
 *
 * Nothing about the person is inside it: who it belongs to, which day and which action it is for
 * are looked up on the server when it is scanned, never trusted from the code.
 *
 * Lookups hash the exact scanned text. Never decode it: the last base64url character carries
 * only 4 bits, so several spellings would decode to the same bytes.
 */
export function newDailyPayload(): { payload: string; hash: Buffer } {
  const payload = `${DAILY_QR_PREFIX}.${randomBytes(32).toString('base64url')}`;
  return { payload, hash: hashDailyPayload(payload) };
}

export const hashDailyPayload = (payload: string): Buffer =>
  createHash('sha256').update(payload, 'utf8').digest();
