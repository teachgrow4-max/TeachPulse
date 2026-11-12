/**
 * The operator's own position, as evidence for the "are you at the office?" check.
 *
 * The browser reports where the device thinks it is; the SERVER decides whether that is close
 * enough to the office, and compares it with its own clock. Nothing here is trusted.
 */

export type LocationFailure = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class LocationError extends Error {
  constructor(
    readonly reason: LocationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LocationError';
  }
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  fixTime: number;
}

const MESSAGES: Record<LocationFailure, string> = {
  denied:
    'Location is blocked. Allow location for this site in your browser settings, then try again.',
  unavailable: 'Your device could not work out where it is. Move near a window and try again.',
  timeout: 'Finding your location took too long. Try again in a moment.',
  unsupported: 'This browser cannot share a location, so it cannot be used to record attendance.',
};

export function getLocationFix(timeoutMs = 12_000): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new LocationError('unsupported', MESSAGES.unsupported));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          fixTime: position.timestamp,
        }),
      (error) => {
        const reason: LocationFailure =
          error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable';
        reject(new LocationError(reason, MESSAGES[reason]));
      },
      // A fresh, precise reading every time: an old one would be refused by the server anyway.
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
