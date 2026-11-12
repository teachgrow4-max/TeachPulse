import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocationFix, LocationError } from './geo';
import { classifyCameraError } from '../components/scanner/use-camera-scanner';

afterEach(() => {
  vi.unstubAllGlobals();
});

function geolocation(
  impl: (ok: PositionCallback, fail: PositionErrorCallback, options?: PositionOptions) => void,
) {
  vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition: impl } });
}

describe('getLocationFix', () => {
  it('reports the device’s reading as evidence, and asks for a fresh precise one', async () => {
    const seen: PositionOptions[] = [];
    geolocation((ok, _fail, options) => {
      seen.push(options!);
      ok({
        coords: { latitude: 10.5, longitude: 20.25, accuracy: 12 },
        timestamp: 1_700_000_000_000,
      } as GeolocationPosition);
    });
    await expect(getLocationFix()).resolves.toEqual({
      latitude: 10.5,
      longitude: 20.25,
      accuracyM: 12,
      fixTime: 1_700_000_000_000,
    });
    expect(seen[0]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
  });

  it.each([
    [1, 'denied', /blocked/i],
    [2, 'unavailable', /work out where/i],
    [3, 'timeout', /too long/i],
  ] as const)('explains error %i in plain words', async (code, reason, message) => {
    geolocation((_ok, fail) => fail({ code } as GeolocationPositionError));
    const error = (await getLocationFix().catch((e: unknown) => e)) as LocationError;
    expect(error).toBeInstanceOf(LocationError);
    expect(error.reason).toBe(reason);
    expect(error.message).toMatch(message);
  });

  it('copes with a browser that has no location support', async () => {
    vi.stubGlobal('navigator', { userAgent: 'old' });
    const error = (await getLocationFix().catch((e: unknown) => e)) as LocationError;
    expect(error.reason).toBe('unsupported');
  });
});

describe('classifyCameraError', () => {
  it.each([
    [new DOMException('x', 'NotAllowedError'), 'denied'],
    [new DOMException('x', 'PermissionDeniedError'), 'denied'],
    [new DOMException('x', 'NotFoundError'), 'no-camera'],
    ['Camera not found.', 'no-camera'],
    [new DOMException('x', 'NotReadableError'), 'busy'],
    [new Error('something odd'), 'error'],
  ] as const)('puts %s under %s', (error, status) => {
    expect(classifyCameraError(error).status).toBe(status);
  });
});
