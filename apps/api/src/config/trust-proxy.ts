import { isIP } from 'node:net';

/**
 * Parses the TRUST_PROXY setting into a value that is safe to hand to Express.
 *
 * Why this is strict: the office-network verification layer trusts `req.ip`. If Express
 * is told to trust every proxy (`true`, `*`, `0.0.0.0/0`), any client can forge
 * `X-Forwarded-For` and appear to be on the office network. So we only accept:
 *   - `false` / empty / `0`  -> no proxy; req.ip is the TCP peer address
 *   - a positive integer      -> that many trusted proxy hops in front of the app
 *   - a list of proxy IPs, CIDRs or the keywords loopback/linklocal/uniquelocal
 */

export type TrustProxySetting = false | number | string[];

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 5;

function isValidCidrOrIp(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  const max = family === 4 ? 32 : 128;
  // A /0 prefix would trust the whole internet, which defeats the purpose.
  return bits >= 1 && bits <= max;
}

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') return false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops === 0) return false;
    if (hops > MAX_HOPS) {
      throw new Error(`TRUST_PROXY hop count must be between 1 and ${MAX_HOPS}, got ${hops}`);
    }
    return hops;
  }

  const lowered = value.toLowerCase();
  if (lowered === 'true' || value === '*') {
    throw new Error(
      'TRUST_PROXY must not trust every proxy ("true" or "*"). ' +
        'Set the exact number of proxy hops or a list of trusted proxy IPs/CIDRs.',
    );
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) return false;

  for (const entry of entries) {
    if (KEYWORDS.has(entry.toLowerCase())) continue;
    if (!isValidCidrOrIp(entry)) {
      throw new Error(`TRUST_PROXY contains an invalid or overly broad entry: "${entry}"`);
    }
  }

  return entries.map((entry) => (KEYWORDS.has(entry.toLowerCase()) ? entry.toLowerCase() : entry));
}
