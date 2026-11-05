import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  FUTURE_TOLERANCE_SECONDS,
  evaluateGps,
  haversineMeters,
  type GpsEvidenceInput,
  type GpsPolicy,
  type LatLng,
} from './gps.js';

// Synthetic coordinates: no real company location appears in this codebase.
const OFFICE: GpsPolicy = {
  latitude: 10,
  longitude: 20,
  radiusM: 100,
  maxAccuracyM: 50,
  maxFixAgeSeconds: 30,
};

const NOW = new Date('2026-11-02T04:30:00Z');
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

/** A point `metres` due north of `origin` (exact on the sphere along a meridian). */
const north = (origin: LatLng, metres: number): LatLng => ({
  latitude: origin.latitude + metres / METRES_PER_DEGREE,
  longitude: origin.longitude,
});

const evidence = (overrides: Partial<GpsEvidenceInput> = {}): GpsEvidenceInput => ({
  latitude: OFFICE.latitude,
  longitude: OFFICE.longitude,
  accuracyM: 10,
  fixTime: NOW.getTime() - 2000,
  ...overrides,
});

const codes = (result: ReturnType<typeof evaluateGps>) => result.reasons.map((r) => r.code);

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters({ latitude: 10, longitude: 20 }, { latitude: 10, longitude: 20 })).toBe(
      0,
    );
  });

  it('matches well-known distances', () => {
    // One degree of longitude on the equator.
    expect(
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    ).toBeCloseTo(111_195, -1);
    // London to Paris is about 343.5 km.
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    expect(Math.abs(haversineMeters(london, paris) - 343_500)).toBeLessThan(1000);
    // New York to Los Angeles is about 3,936 km.
    const ny = { latitude: 40.7128, longitude: -74.006 };
    const la = { latitude: 34.0522, longitude: -118.2437 };
    expect(Math.abs(haversineMeters(ny, la) - 3_936_000)).toBeLessThan(10_000);
  });

  it('handles antipodal points, the antimeridian and the poles', () => {
    expect(
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }),
    ).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 0);
    // 0.2 degrees apart across the 180th meridian, not 359.8.
    expect(
      haversineMeters({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }),
    ).toBeCloseTo(0.2 * METRES_PER_DEGREE, 0);
    // Every longitude is the same point at a pole.
    expect(
      haversineMeters({ latitude: 90, longitude: 0 }, { latitude: 90, longitude: 123 }),
    ).toBeCloseTo(0, 5);
    expect(
      haversineMeters({ latitude: -90, longitude: 0 }, { latitude: 90, longitude: 0 }),
    ).toBeCloseTo(Math.PI * EARTH_RADIUS_M, 0);
  });

  it('is symmetric and agrees with a flat approximation over short distances', () => {
    const a = { latitude: 10.0003, longitude: 20.0004 };
    const b = { latitude: 10.0011, longitude: 19.9992 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);

    const dLat = (b.latitude - a.latitude) * METRES_PER_DEGREE;
    const dLng = (b.longitude - a.longitude) * METRES_PER_DEGREE * Math.cos((10 * Math.PI) / 180);
    expect(haversineMeters(a, b)).toBeCloseTo(Math.hypot(dLat, dLng), 1);
  });

  it('measures a due-north offset exactly', () => {
    for (const metres of [1, 10, 99, 100, 101, 250, 5000]) {
      expect(haversineMeters(OFFICE, north(OFFICE, metres))).toBeCloseTo(metres, 6);
    }
  });
});

describe('evaluateGps - the geofence', () => {
  it('passes at the office, reporting the measured distance', () => {
    const result = evaluateGps(evidence(), OFFICE, NOW);
    expect(result.result).toBe('PASS');
    expect(result.reasons).toEqual([]);
    expect(result.distanceM).toBeCloseTo(0, 6);
    expect(result.accuracyM).toBe(10);
  });

  it('passes just inside and exactly on the boundary, fails just outside', () => {
    expect(evaluateGps(evidence(north(OFFICE, 99.9)), OFFICE, NOW).result).toBe('PASS');

    const onTheLine = evidence(north(OFFICE, 100));
    const measured = haversineMeters(OFFICE, onTheLine);
    expect(evaluateGps(onTheLine, { ...OFFICE, radiusM: measured }, NOW).result).toBe('PASS'); // inclusive
    expect(evaluateGps(onTheLine, { ...OFFICE, radiusM: measured - 1e-6 }, NOW).result).toBe(
      'FAIL',
    );

    const outside = evaluateGps(evidence(north(OFFICE, 100.5)), OFFICE, NOW);
    expect(outside.result).toBe('FAIL');
    expect(codes(outside)).toEqual(['GPS_OUTSIDE_RADIUS']);
  });

  it('explains how far away the person is, in plain words, with a next step', () => {
    const [reason] = evaluateGps(evidence(north(OFFICE, 450)), OFFICE, NOW).reasons;
    expect(reason).toMatchObject({ code: 'GPS_OUTSIDE_RADIUS', layer: 'GPS' });
    expect(reason!.message).toBe('You are about 450 m from the office; you must be within 100 m.');
    expect(reason!.hint).toMatch(/go to the office/i);
  });

  it('honours a larger or smaller configured radius', () => {
    const at250 = evidence(north(OFFICE, 250));
    expect(evaluateGps(at250, { ...OFFICE, radiusM: 300 }, NOW).result).toBe('PASS');
    expect(evaluateGps(at250, { ...OFFICE, radiusM: 200 }, NOW).result).toBe('FAIL');
  });

  it('still reports the distance for a rejected reading (it is recorded for audit)', () => {
    const result = evaluateGps(evidence({ ...north(OFFICE, 800), accuracyM: 400 }), OFFICE, NOW);
    expect(result.result).toBe('FAIL');
    expect(result.distanceM).toBeCloseTo(800, 3);
  });
});

describe('evaluateGps - accuracy', () => {
  it('accepts exactly the maximum and rejects anything less precise', () => {
    expect(evaluateGps(evidence({ accuracyM: 50 }), OFFICE, NOW).result).toBe('PASS');
    const result = evaluateGps(evidence({ accuracyM: 50.001 }), OFFICE, NOW);
    expect(result.result).toBe('FAIL');
    expect(codes(result)).toEqual(['GPS_LOW_ACCURACY']);
    expect(result.reasons[0]!.message).toBe(
      'Your location is not accurate enough (about 50 m; the limit is 50 m).',
    );
  });

  it('asks for a better reading first instead of judging distance from an unreliable one', () => {
    const farAndFuzzy = evaluateGps(
      evidence({ ...north(OFFICE, 900), accuracyM: 300 }),
      OFFICE,
      NOW,
    );
    expect(codes(farAndFuzzy)).toEqual(['GPS_LOW_ACCURACY']); // no "you are 900 m away"
  });

  it('accepts a perfect zero-metre accuracy', () => {
    expect(evaluateGps(evidence({ accuracyM: 0 }), OFFICE, NOW).result).toBe('PASS');
  });
});

describe('evaluateGps - staleness and clock skew', () => {
  const at = (offsetMs: number) => evidence({ fixTime: NOW.getTime() + offsetMs });

  it('accepts a reading exactly as old as the limit, rejects older', () => {
    expect(evaluateGps(at(-30_000), OFFICE, NOW).result).toBe('PASS');
    const stale = evaluateGps(at(-30_001), OFFICE, NOW);
    expect(codes(stale)).toEqual(['GPS_STALE']);
    expect(stale.reasons[0]!.message).toBe(
      'Your location reading is out of date (30 s old; the limit is 30 s).',
    );
  });

  it('reports how old a stale reading really is', () => {
    expect(evaluateGps(at(-95_000), OFFICE, NOW).reasons[0]!.message).toContain('95 s old');
  });

  it('tolerates a few seconds of device clock drift ahead, but not more', () => {
    expect(FUTURE_TOLERANCE_SECONDS).toBe(10);
    expect(evaluateGps(at(10_000), OFFICE, NOW).result).toBe('PASS');
    const future = evaluateGps(at(10_001), OFFICE, NOW);
    expect(codes(future)).toEqual(['GPS_FUTURE']);
    expect(future.reasons[0]!.hint).toMatch(/automatic date and time/i);
  });

  it('follows the configured maximum age', () => {
    expect(evaluateGps(at(-60_000), { ...OFFICE, maxFixAgeSeconds: 120 }, NOW).result).toBe('PASS');
    expect(evaluateGps(at(-60_000), { ...OFFICE, maxFixAgeSeconds: 30 }, NOW).result).toBe('FAIL');
  });

  it('judges time against the server clock passed in, never against a clock of its own', () => {
    const fix = evidence({ fixTime: NOW.getTime() });
    const later = new Date(NOW.getTime() + 31_000);
    expect(evaluateGps(fix, OFFICE, NOW).result).toBe('PASS');
    expect(evaluateGps(fix, OFFICE, later).result).toBe('FAIL');
  });

  it('accepts the fix time as epoch milliseconds, an ISO string or a Date', () => {
    const ms = NOW.getTime() - 1000;
    for (const fixTime of [
      ms,
      new Date(ms).toISOString(),
      new Date(ms),
      '2026-11-02T10:00:00+05:30',
    ]) {
      expect(evaluateGps(evidence({ fixTime }), OFFICE, NOW).result, String(fixTime)).toBe('PASS');
    }
  });
});

describe('evaluateGps - spoofing signals and bad input', () => {
  it('rejects a reading flagged as a mock location even when it is exactly at the office', () => {
    const result = evaluateGps(evidence({ mocked: true }), OFFICE, NOW);
    expect(result.result).toBe('FAIL');
    expect(codes(result)).toEqual(['GPS_MOCKED']);
    expect(result.reasons[0]!.hint).toMatch(/mock-location/i);
  });

  it('treats "not mocked" and "unknown" the same: no penalty', () => {
    expect(evaluateGps(evidence({ mocked: false }), OFFICE, NOW).result).toBe('PASS');
    expect(evaluateGps(evidence({ mocked: undefined }), OFFICE, NOW).result).toBe('PASS');
  });

  it('reports every reliability problem at once', () => {
    const result = evaluateGps(
      evidence({ mocked: true, accuracyM: 90, fixTime: NOW.getTime() - 60_000 }),
      OFFICE,
      NOW,
    );
    expect(codes(result)).toEqual(['GPS_MOCKED', 'GPS_STALE', 'GPS_LOW_ACCURACY']);
  });

  it('reports missing evidence', () => {
    const result = evaluateGps(undefined, OFFICE, NOW);
    expect(result).toMatchObject({ result: 'FAIL', distanceM: null, accuracyM: null });
    expect(codes(result)).toEqual(['GPS_MISSING']);
    expect(result.reasons[0]!.hint).toMatch(/allow location/i);
  });

  it.each([
    ['NaN latitude', { latitude: Number.NaN }],
    ['infinite longitude', { longitude: Number.POSITIVE_INFINITY }],
    ['latitude above 90', { latitude: 90.0001 }],
    ['latitude below -90', { latitude: -91 }],
    ['longitude above 180', { longitude: 180.5 }],
    ['negative accuracy', { accuracyM: -1 }],
    ['NaN accuracy', { accuracyM: Number.NaN }],
    ['an unparseable fix time', { fixTime: 'not a date' }],
    ['a NaN fix time', { fixTime: Number.NaN }],
  ])('rejects %s as invalid without throwing', (_label, patch) => {
    const result = evaluateGps(evidence(patch as Partial<GpsEvidenceInput>), OFFICE, NOW);
    expect(result.result).toBe('FAIL');
    expect(codes(result)).toEqual(['GPS_INVALID']);
    expect(result.distanceM).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const input = evidence();
    const office = { ...OFFICE };
    const before = JSON.stringify({ input, office });
    evaluateGps(input, office, NOW);
    expect(JSON.stringify({ input, office })).toBe(before);
  });
});
