import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

/**
 * `Idempotency-Key` support for actions that change attendance.
 *
 * A phone on a bad connection retries; a person double-taps. Sending the same key again must not
 * do the thing twice, and must give the same answer the first attempt got.
 *
 * How it stays correct:
 *   - The key row and the action commit in ONE transaction. There is no moment in which the action
 *     happened but its key is missing (or the reverse), so a crash cannot leave a half-recorded key.
 *   - `insert ... on conflict do nothing` makes two simultaneous requests with the same key
 *     serialise: the second waits for the first to commit, then reads its stored answer.
 *   - A failed action rolls back with its key, so an error is never "remembered": the caller can
 *     fix the problem and retry with the same key.
 *   - The same key with a different request is refused, not silently answered with the old result.
 */

export interface Idempotent<T> {
  status: number;
  body: T;
  /** true when the answer was stored by an earlier request with the same key. */
  replayed: boolean;
}

/** Stable text for "this request", so two spellings of the same JSON body hash identically. */
export function fingerprint(endpoint: string, body: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, canonical(inner)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(`${endpoint}\n${JSON.stringify(canonical(body))}`)
    .digest('hex');
}

interface StoredKey {
  endpoint: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/**
 * Runs `work` once per (employee, key). Must be called inside a transaction: the caller's
 * `withTransaction` is what makes the key and the action atomic.
 */
export async function withIdempotency<T>(
  tx: Queryable,
  scope: { employeeId: string; key: string; endpoint: string; request: unknown; now: Date },
  work: () => Promise<{ status: number; body: T }>,
): Promise<Idempotent<T>> {
  const requestHash = fingerprint(scope.endpoint, scope.request);

  const claimed = await tx.query(
    `insert into public.idempotency_keys (employee_id, key, endpoint, request_hash, created_at)
     values ($1, $2, $3, $4, $5::timestamptz)
     on conflict (employee_id, key) do nothing
     returning key`,
    [scope.employeeId, scope.key, scope.endpoint, requestHash, scope.now],
  );

  if (claimed.rows.length === 0) {
    const { rows } = await tx.query<StoredKey>(
      `select endpoint, request_hash, response_status, response_body
       from public.idempotency_keys
       where employee_id = $1 and key = $2`,
      [scope.employeeId, scope.key],
    );
    const stored = rows[0];
    if (!stored || stored.endpoint !== scope.endpoint || stored.request_hash !== requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED');
    }
    if (stored.response_status === null) {
      // Cannot happen while key and action share a transaction; refuse rather than guess.
      throw new AppError(
        'CONFLICT',
        'This request is still being processed. Please retry shortly.',
      );
    }
    return { status: stored.response_status, body: stored.response_body as T, replayed: true };
  }

  const result = await work();
  await tx.query(
    `update public.idempotency_keys
     set response_status = $3, response_body = $4::jsonb
     where employee_id = $1 and key = $2`,
    [scope.employeeId, scope.key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
