import { formatReason, type VerificationReasonDto } from '@teachgrow/shared';
import type { Queryable } from '../db/pool.js';

/**
 * Layer 2: office network. The address compared is the one Express reports as `req.ip`, which
 * honours the TRUST_PROXY setting and therefore ignores any `X-Forwarded-For` that does not come
 * from a trusted proxy. Matching is done by Postgres (`inet <<= cidr`) for IPv4 and IPv6 alike.
 *
 * Browsers cannot reveal which Wi-Fi network they are on, so the only honest proof available is
 * the public address the server sees. That is what is checked here, and nothing else.
 */

export interface NetworkEvaluation {
  result: 'PASS' | 'FAIL';
  reasons: VerificationReasonDto[];
  matched: { id: string; label: string; cidr: string } | null;
}

export async function evaluateNetwork(
  db: Queryable,
  officeId: string,
  ip: string | null,
): Promise<NetworkEvaluation> {
  if (!ip) {
    return { result: 'FAIL', reasons: [formatReason('NETWORK_UNKNOWN')], matched: null };
  }

  // The most specific matching range wins, so the audit trail names the narrowest allowlist entry.
  const { rows } = await db.query<{ id: string; label: string; cidr: string }>(
    `select n.id, n.label, n.cidr::text as cidr
     from public.office_networks n
     where n.office_id = $1 and n.is_active and $2::inet <<= n.cidr
     order by masklen(n.cidr) desc
     limit 1`,
    [officeId, ip],
  );
  const matched = rows[0];
  if (matched) return { result: 'PASS', reasons: [], matched };

  const configured = await db.query<{ n: number }>(
    'select count(*)::int as n from public.office_networks where office_id = $1 and is_active',
    [officeId],
  );
  const code =
    (configured.rows[0]?.n ?? 0) === 0 ? 'NETWORK_NOT_CONFIGURED' : 'NETWORK_NOT_ALLOWED';
  return { result: 'FAIL', reasons: [formatReason(code)], matched: null };
}
