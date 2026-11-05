import { isIP } from 'node:net';
import type { Request } from 'express';

/** Who/where a request came from, recorded on audit entries. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * `req.ip` can be an IPv4-mapped IPv6 address (`::ffff:203.0.113.5`). Store the plain IPv4 form
 * and drop anything that is not a valid address (Postgres `inet` would reject it).
 */
export function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const stripped = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  return isIP(stripped) === 0 ? null : stripped;
}

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.get('user-agent');
  return {
    ip: normalizeIp(req.ip),
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
    requestId: req.requestId ?? null,
  };
}

export const NO_META: RequestMeta = { ip: null, userAgent: null, requestId: null };
