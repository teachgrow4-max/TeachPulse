import type { RequestMeta } from '../lib/request-meta.js';
import type { Queryable } from '../db/pool.js';

/**
 * Append-only audit trail (`public.audit_logs`).
 *
 * Rules enforced here: secrets never reach the log (any key that looks like a password, token or
 * secret is replaced), and `before`/`after` are plain JSON snapshots of the *changed* fields.
 */

export interface AuditEntry extends Partial<RequestMeta> {
  action: string;
  actorId?: string | null;
  actorRole?: string | null;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Defaults to the database clock; callers pass their Clock for testability. */
  at?: Date;
}

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|credential/i;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // Booleans are flags (e.g. must_change_password), never secrets, and are useful in diffs.
    const hide = SENSITIVE_KEY.test(key) && typeof inner !== 'boolean';
    out[key] = hide ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(redact(value));

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into public.audit_logs
       (occurred_at, actor_id, actor_role, action, entity_type, entity_id,
        before_data, after_data, metadata, ip, user_agent, request_id)
     values
       (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6,
        $7::jsonb, $8::jsonb, coalesce($9::jsonb, '{}'::jsonb), $10::inet, $11, $12)`,
    [
      entry.at ?? null,
      entry.actorId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      json(entry.before),
      json(entry.after),
      json(entry.metadata),
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
    ],
  );
}
