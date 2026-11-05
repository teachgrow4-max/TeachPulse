import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy.js';

describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false', 'FALSE', '0'])('treats %j as "no proxy"', (value) => {
    expect(parseTrustProxy(value)).toBe(false);
  });

  it('accepts a small hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('rejects an excessive hop count', () => {
    expect(() => parseTrustProxy('6')).toThrow(/hop count/);
  });

  it.each(['true', 'TRUE', '*'])('refuses to trust every proxy (%s)', (value) => {
    expect(() => parseTrustProxy(value)).toThrow(/must not trust every proxy/);
  });

  it('accepts explicit proxy addresses, CIDRs and keywords', () => {
    expect(parseTrustProxy('10.0.0.0/8, loopback, 2001:db8::/32, 203.0.113.7')).toEqual([
      '10.0.0.0/8',
      'loopback',
      '2001:db8::/32',
      '203.0.113.7',
    ]);
  });

  it.each(['0.0.0.0/0', '::/0', '10.0.0.0/33', '10.0.0.0/abc', 'not-an-ip', '10.0.0.1/8/8'])(
    'rejects invalid or overly broad entry %s',
    (value) => {
      expect(() => parseTrustProxy(value)).toThrow(/TRUST_PROXY/);
    },
  );
});

/**
 * The office-network check trusts req.ip. These tests prove Express honours the parsed
 * setting and that a spoofed X-Forwarded-For cannot change the client address.
 */
describe('req.ip with spoofed X-Forwarded-For', () => {
  function ipOf(setting: string | undefined) {
    const app = express();
    app.set('trust proxy', parseTrustProxy(setting));
    app.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  }

  it('ignores the header entirely when no proxy is configured', async () => {
    const res = await request(ipOf('false')).get('/ip').set('X-Forwarded-For', '203.0.113.50');
    expect(res.body.ip).not.toBe('203.0.113.50');
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(res.body.ip);
  });

  it('with one trusted hop, uses the address that hop appended, not a forged leftmost value', async () => {
    // Client forges "198.51.100.1"; our single trusted proxy appends the real peer "203.0.113.50".
    const res = await request(ipOf('1'))
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.50');
    expect(res.body.ip).toBe('203.0.113.50');
  });

  it('does not trust the header when the immediate peer is not a listed proxy', async () => {
    // Only 10.0.0.0/8 is trusted; the test client connects from loopback, so XFF is ignored.
    const res = await request(ipOf('10.0.0.0/8')).get('/ip').set('X-Forwarded-For', '203.0.113.50');
    expect(res.body.ip).not.toBe('203.0.113.50');
  });
});
