import { formatReason, type VerificationReasonDto } from '@teachgrow/shared';

/**
 * Layer 1: GPS geofence. Pure functions: no I/O, no clock of their own, fully unit-tested.
 *
 * The distance is ALWAYS computed here, on the server, from the raw coordinates the device
 * reports. The device never says "I am inside"; it only says where it thinks it is.
 *
 * What this can and cannot prove is documented in docs/VERIFICATION.md: a determined user with a
 * rooted phone can report any coordinates, which is why GPS is only one of four layers.
 */

/** Mean Earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** A device clock this far ahead of the server is treated as wrong, not as a fresh reading. */
export const FUTURE_TOLERANCE_SECONDS = 10;

export interface LatLng {
  latitude: number;
  longitude: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance between two points, in metres (Haversine formula). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  // atan2 stays accurate for nearly-antipodal points where asin(sqrt(h)) loses precision.
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export interface GpsEvidenceInput {
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy, metres. */
  accuracyM: number;
  /** Epoch milliseconds, or anything `Date` can parse. */
  fixTime: number | string | Date;
  mocked?: boolean | undefined;
}

export interface GpsPolicy extends LatLng {
  radiusM: number;
  maxAccuracyM: number;
  maxFixAgeSeconds: number;
}

export interface GpsEvaluation {
  result: 'PASS' | 'FAIL';
  reasons: VerificationReasonDto[];
  /** Always measured when coordinates were usable, even if the reading was rejected. */
  distanceM: number | null;
  accuracyM: number | null;
  fixTime: Date | null;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function fail(
  reasons: VerificationReasonDto[],
  extra: Partial<Omit<GpsEvaluation, 'result' | 'reasons'>> = {},
): GpsEvaluation {
  return { result: 'FAIL', reasons, distanceM: null, accuracyM: null, fixTime: null, ...extra };
}

/**
 * Decides whether a location reading proves presence at the office.
 *
 * A reading is rejected if it is missing, malformed, flagged as mocked, stale, from a device clock
 * in the future, or too imprecise. Only a trustworthy reading is judged against the radius: telling
 * someone "you are 450 m away" from a reading that is itself unreliable would be misleading, so
 * they are first asked for a better reading.
 *
 * Boundaries are inclusive: exactly the limit passes, anything beyond it fails.
 */
export function evaluateGps(
  evidence: GpsEvidenceInput | undefined,
  office: GpsPolicy,
  now: Date,
): GpsEvaluation {
  if (!evidence) return fail([formatReason('GPS_MISSING')]);

  const fix = new Date(evidence.fixTime);
  if (
    !isFiniteNumber(evidence.latitude) ||
    !isFiniteNumber(evidence.longitude) ||
    !isFiniteNumber(evidence.accuracyM) ||
    evidence.latitude < -90 ||
    evidence.latitude > 90 ||
    evidence.longitude < -180 ||
    evidence.longitude > 180 ||
    evidence.accuracyM < 0 ||
    Number.isNaN(fix.getTime())
  ) {
    return fail([formatReason('GPS_INVALID')]);
  }

  const distanceM = haversineMeters(evidence, office);
  const reasons: VerificationReasonDto[] = [];

  if (evidence.mocked === true) reasons.push(formatReason('GPS_MOCKED'));

  const ageSeconds = (now.getTime() - fix.getTime()) / 1000;
  if (ageSeconds > office.maxFixAgeSeconds) {
    reasons.push(
      formatReason('GPS_STALE', {
        ageSeconds: Math.round(ageSeconds),
        maxAgeSeconds: office.maxFixAgeSeconds,
      }),
    );
  } else if (ageSeconds < -FUTURE_TOLERANCE_SECONDS) {
    reasons.push(formatReason('GPS_FUTURE'));
  }

  if (evidence.accuracyM > office.maxAccuracyM) {
    reasons.push(
      formatReason('GPS_LOW_ACCURACY', {
        accuracyM: Math.round(evidence.accuracyM),
        maxAccuracyM: office.maxAccuracyM,
      }),
    );
  }

  // Only judge the position once the reading itself is trustworthy.
  if (reasons.length === 0 && distanceM > office.radiusM) {
    reasons.push(
      formatReason('GPS_OUTSIDE_RADIUS', {
        distanceM: Math.round(distanceM),
        radiusM: office.radiusM,
      }),
    );
  }

  return {
    result: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
    distanceM,
    accuracyM: evidence.accuracyM,
    fixTime: fix,
  };
}
