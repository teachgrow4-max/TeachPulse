import { randomBytes } from 'node:crypto';
import type { DevicePlatform, VerificationPurpose } from '@teachgrow/shared';
import type { Queryable } from '../db/pool.js';

/**
 * One-time challenges a device signs to prove it is present.
 *
 *   - 32 random bytes, so there is nothing to guess;
 *   - bound to one person, one purpose and (for check-in / check-out) one device;
 *   - short lived;
 *   - SINGLE USE: spent the moment a proof is attempted, whether or not the proof was good, so a
 *     signature can never be ground out against the same challenge.
 */

export const REGISTER_CHALLENGE_TTL_SECONDS = 300;
export const VERIFY_CHALLENGE_TTL_SECONDS = 120;

export type ChallengePurpose = 'REGISTER' | VerificationPurpose;

export interface IssuedChallenge {
  id: string;
  /** The raw 32 bytes. Clients receive these base64url-encoded. */
  bytes: Buffer;
  expiresAt: Date;
}

export async function issueChallenge(
  q: Queryable,
  input: {
    userId: string;
    purpose: ChallengePurpose;
    /** Required for CHECK_IN / CHECK_OUT, absent for REGISTER. */
    deviceId?: string;
    /** Required for REGISTER, absent otherwise. */
    platform?: DevicePlatform;
    now: Date;
    ttlSeconds: number;
  },
): Promise<IssuedChallenge> {
  // Only the newest challenge for a given purpose and device is live. A second request retires the
  // first, which keeps the table small and stops anyone stockpiling challenges.
  await q.query(
    `update public.device_challenges
     set consumed_at = $4::timestamptz
     where user_id = $1 and purpose = $2 and device_id is not distinct from $3::uuid
       and consumed_at is null`,
    [input.userId, input.purpose, input.deviceId ?? null, input.now],
  );

  const bytes = randomBytes(32);
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  const { rows } = await q.query<{ id: string }>(
    `insert into public.device_challenges
       (user_id, purpose, device_id, platform, challenge, expires_at, created_at)
     values ($1, $2, $3, $4::public.device_platform, $5, $6::timestamptz, $7::timestamptz)
     returning id`,
    [
      input.userId,
      input.purpose,
      input.deviceId ?? null,
      input.platform ?? null,
      bytes,
      expiresAt,
      input.now,
    ],
  );
  return { id: rows[0]!.id, bytes, expiresAt };
}

export type ChallengeOutcome =
  { ok: true; bytes: Buffer } | { ok: false; reason: 'INVALID' | 'EXPIRED' };

/**
 * Spends a challenge. "Invalid" covers unknown, someone else's, already spent, and issued for a
 * different purpose, device or platform; none of those is distinguished to the caller.
 */
export async function consumeChallenge(
  q: Queryable,
  input: {
    id: string;
    userId: string;
    purpose: ChallengePurpose;
    deviceId?: string;
    platform?: DevicePlatform;
    now: Date;
  },
): Promise<ChallengeOutcome> {
  const { rows } = await q.query<{
    challenge: Buffer;
    purpose: string;
    device_id: string | null;
    platform: string | null;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `select challenge, purpose, device_id, platform::text as platform, expires_at, consumed_at
     from public.device_challenges
     where id = $1 and user_id = $2
     for update`,
    [input.id, input.userId],
  );
  const row = rows[0];
  if (!row || row.consumed_at) return { ok: false, reason: 'INVALID' };

  // Spent from here on, whatever happens next.
  await q.query('update public.device_challenges set consumed_at = $2::timestamptz where id = $1', [
    input.id,
    input.now,
  ]);

  if (
    row.purpose !== input.purpose ||
    row.device_id !== (input.deviceId ?? null) ||
    row.platform !== (input.platform ?? null)
  ) {
    return { ok: false, reason: 'INVALID' };
  }
  if (new Date(row.expires_at).getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  // Drivers differ in how they hand back bytea (a Buffer, or a plain Uint8Array); always a Buffer here.
  return { ok: true, bytes: Buffer.from(row.challenge) };
}

/** Retires every live challenge for a device (it was revoked). */
export async function retireDeviceChallenges(
  q: Queryable,
  deviceId: string,
  now: Date,
): Promise<void> {
  await q.query(
    `update public.device_challenges set consumed_at = $2::timestamptz
     where device_id = $1 and consumed_at is null`,
    [deviceId, now],
  );
}
