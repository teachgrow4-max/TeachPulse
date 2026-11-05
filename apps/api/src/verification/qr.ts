import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { QR_PAYLOAD_PREFIX } from '@teachgrow/shared';

/**
 * Layer 3: the rotating office QR code. Pure functions; persistence lives in the QR service.
 *
 * Design
 *   - Time is cut into windows of `rotationSeconds`. Window N covers [N*r, (N+1)*r).
 *   - The code for a window is  HMAC-SHA256(QR_SIGNING_SECRET, "TG1|office|rotation|N").  Nobody
 *     without the server's secret can compute it, yet the server needs no stored copy of the
 *     plaintext: it recomputes the code on demand. Only the SHA-256 of a code is ever stored.
 *   - A code is accepted from a few seconds before its window starts (clock drift between the
 *     lobby display and the employee's request) to a short grace period after it ends (the
 *     employee scanned just before the screen refreshed).
 *   - Single use (per employee) and replay protection are enforced in the database, not here.
 *
 * The payload on screen is  TG1.<window>.<code>.
 */

/** Accept a code this long before its window starts. */
export const QR_EARLY_TOLERANCE_SECONDS = 5;
/** Accept a code this long after its window ends. */
export const QR_GRACE_SECONDS = 10;

export interface QrOffice {
  id: string;
  rotationSeconds: number;
}

export interface QrWindow {
  index: number;
  validFrom: Date;
  expiresAt: Date;
  /** `expiresAt` plus the grace period: the last moment the code is still accepted. */
  acceptUntil: Date;
}

export function windowIndexAt(now: Date, rotationSeconds: number): number {
  return Math.floor(now.getTime() / 1000 / rotationSeconds);
}

export function windowOf(index: number, rotationSeconds: number): QrWindow {
  const validFrom = new Date(index * rotationSeconds * 1000);
  const expiresAt = new Date((index + 1) * rotationSeconds * 1000);
  return {
    index,
    validFrom,
    expiresAt,
    acceptUntil: new Date(expiresAt.getTime() + QR_GRACE_SECONDS * 1000),
  };
}

/** The 43-character base64url code for one window of one office. */
export function deriveCode(secret: string, office: QrOffice, index: number): string {
  return createHmac('sha256', secret)
    .update(`${QR_PAYLOAD_PREFIX}|${office.id}|${office.rotationSeconds}|${index}`)
    .digest('base64url');
}

export const buildPayload = (index: number, code: string): string =>
  `${QR_PAYLOAD_PREFIX}.${index}.${code}`;

export const hashCode = (code: string): Buffer =>
  createHash('sha256').update(code, 'utf8').digest();

export interface QrDisplay {
  payload: string;
  window: QrWindow;
  next: { payload: string; window: QrWindow };
}

/** What the lobby screen should show now, plus the next code. */
export function currentQr(secret: string, office: QrOffice, now: Date): QrDisplay {
  const index = windowIndexAt(now, office.rotationSeconds);
  const make = (i: number) => ({
    payload: buildPayload(i, deriveCode(secret, office, i)),
    window: windowOf(i, office.rotationSeconds),
  });
  const current = make(index);
  return { payload: current.payload, window: current.window, next: make(index + 1) };
}

export type QrCheck =
  /** Authentic and inside its acceptance interval. */
  | { status: 'OK'; code: string; codeHash: Buffer; window: QrWindow }
  /** Authentic but past its grace period. */
  | { status: 'EXPIRED'; code: string; codeHash: Buffer; window: QrWindow }
  /** Malformed, forged, for another office or rotation setting, or not yet valid. */
  | { status: 'INVALID' };

const PAYLOAD_PATTERN = new RegExp(`^${QR_PAYLOAD_PREFIX}\\.(\\d{1,12})\\.([A-Za-z0-9_-]{43})$`);

/**
 * Checks a scanned payload. Authenticity is decided first with a constant-time comparison, so a
 * caller learns nothing about valid codes from how long a rejection takes, and "expired" is only
 * ever reported for a genuine code.
 */
export function checkQrPayload(secret: string, office: QrOffice, raw: string, now: Date): QrCheck {
  const match = PAYLOAD_PATTERN.exec(raw);
  if (!match) return { status: 'INVALID' };

  const indexText = match[1] as string;
  const code = match[2] as string;
  const index = Number(indexText);
  // One canonical spelling per window ("007" is not window 7).
  if (!Number.isSafeInteger(index) || String(index) !== indexText) return { status: 'INVALID' };

  // Compare the exact text, not the decoded bytes. The last of the 43 characters carries only four
  // significant bits, so up to four spellings decode to the same bytes; accepting them would let
  // one code hash to four different token identities and defeat single-use enforcement.
  const expected = Buffer.from(deriveCode(secret, office, index), 'utf8');
  const presented = Buffer.from(code, 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { status: 'INVALID' };
  }

  const window = windowOf(index, office.rotationSeconds);
  const nowMs = now.getTime();
  if (nowMs < window.validFrom.getTime() - QR_EARLY_TOLERANCE_SECONDS * 1000) {
    return { status: 'INVALID' };
  }
  const codeHash = hashCode(code);
  if (nowMs > window.acceptUntil.getTime()) return { status: 'EXPIRED', code, codeHash, window };
  return { status: 'OK', code, codeHash, window };
}
