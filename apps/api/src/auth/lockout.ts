import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

/**
 * Failed-sign-in lockout, derived from the audit log so it is durable and shared by every API
 * instance (no in-memory counters to lose on restart or to diverge behind a load balancer).
 *
 * An account is locked while it has `maxFailures` or more failed attempts inside the last
 * `windowSeconds`, counting only attempts after its most recent successful sign-in. It unlocks
 * on its own as the oldest relevant failure ages out of the window.
 *
 * Properties worth keeping:
 *   - keyed by a hash of the email, never by whether the account exists, so lockout cannot be
 *     used to discover valid accounts;
 *   - attempts made while locked are logged as `auth.login.blocked` and are NOT counted, so an
 *     attacker cannot extend a lock indefinitely by hammering it.
 */

export interface LockoutPolicy {
  maxFailures: number;
  windowSeconds: number;
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

export function subjectHashOf(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export async function checkLockout(
  db: Queryable,
  subjectHash: string,
  now: Date,
  policy: LockoutPolicy,
): Promise<LockoutStatus> {
  const { rows } = await db.query<{ occurred_at: Date | string }>(
    `select f.occurred_at
     from public.audit_logs f
     where f.action = 'auth.login.failed'
       and f.metadata ->> 'subject_hash' = $1
       and f.occurred_at > $2::timestamptz - make_interval(secs => $3::int)
       -- "after the last success" is decided by insertion order (the identity id), not by
       -- timestamp, so two events stamped in the same instant can never be misordered.
       and f.id > coalesce(
             (select max(s.id) from public.audit_logs s
              where s.action = 'auth.login.success' and s.metadata ->> 'subject_hash' = $1),
             0)
     order by f.occurred_at desc, f.id desc
     limit $4::int`,
    [subjectHash, now, policy.windowSeconds, policy.maxFailures],
  );

  if (rows.length < policy.maxFailures) return { locked: false, retryAfterSeconds: 0 };

  // The Nth most recent failure is the one whose expiry brings the count back under the limit.
  const decisive = new Date(rows[policy.maxFailures - 1]!.occurred_at).getTime();
  const unlockAt = decisive + policy.windowSeconds * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((unlockAt - now.getTime()) / 1000));
  return { locked: true, retryAfterSeconds };
}
