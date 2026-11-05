import type { Queryable } from '../db/pool.js';

/**
 * Session revocation. Supabase Auth (GoTrue) keeps one row per session in `auth.sessions`, and
 * removing it cascades to that session's refresh tokens. Deleting the row is exactly what
 * GoTrue's own sign-out does, but it also lets us revoke by user id (deactivation, password
 * reset) where we do not hold the user's JWT. The API treats a JWT as valid only while its
 * session row exists, so revocation is immediate even though the JWT itself has not expired.
 *
 * Production note: the API's database role needs SELECT + DELETE on `auth.sessions`.
 */

export async function revokeSession(db: Queryable, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    'delete from auth.sessions where id = $1 returning id',
    [sessionId],
  );
  return rows.length;
}

/** Revoke every session of a user, optionally keeping the one making the request. */
export async function revokeUserSessions(
  db: Queryable,
  userId: string,
  exceptSessionId: string | null = null,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `delete from auth.sessions
     where user_id = $1 and ($2::uuid is null or id <> $2::uuid)
     returning id`,
    [userId, exceptSessionId],
  );
  return rows.length;
}
