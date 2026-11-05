import { z } from 'zod';
import {
  CHANNELS,
  VERIFICATION_PURPOSES,
  type LayerResult,
  type VerificationLayer,
  type VerificationPurpose,
} from './enums.js';
import { latitudeSchema, longitudeSchema, uuidSchema } from './schemas.js';

/**
 * Office verification contracts shared by the API, web and mobile apps.
 *
 * The client sends raw EVIDENCE (a location fix, the scanned QR text, a device proof). It never
 * sends a verdict, a distance or a timestamp to be trusted: the server decides everything.
 */

// ---------------------------------------------------------------------------------------------
// Reasons: stable codes with a friendly message and a "what to do next" hint for each.
// ---------------------------------------------------------------------------------------------

interface ReasonDefinition {
  layer: VerificationLayer;
  /** May contain `{placeholders}` filled from the reason's params. */
  message: string;
  hint: string;
}

export const VERIFICATION_REASONS = {
  // ---- GPS ----
  GPS_MISSING: {
    layer: 'GPS',
    message: 'Your location was not shared.',
    hint: 'Allow location access for this app or browser, then try again.',
  },
  GPS_INVALID: {
    layer: 'GPS',
    message: 'Your location reading was not valid.',
    hint: 'Wait a few seconds for a fresh reading and try again.',
  },
  GPS_LOW_ACCURACY: {
    layer: 'GPS',
    message:
      'Your location is not accurate enough (about {accuracyM} m; the limit is {maxAccuracyM} m).',
    hint: 'Move near a window or outdoors, wait a few seconds for a better reading, and try again.',
  },
  GPS_STALE: {
    layer: 'GPS',
    message:
      'Your location reading is out of date ({ageSeconds} s old; the limit is {maxAgeSeconds} s).',
    hint: 'Wait for a fresh reading and try again. If this keeps happening, check that your device date and time are set automatically.',
  },
  GPS_FUTURE: {
    layer: 'GPS',
    message: 'The time on your device does not match the correct time.',
    hint: 'Turn on automatic date and time in your device settings, then try again.',
  },
  GPS_MOCKED: {
    layer: 'GPS',
    message: 'A mock or simulated location was detected.',
    hint: 'Turn off any mock-location or location-spoofing apps and try again.',
  },
  GPS_OUTSIDE_RADIUS: {
    layer: 'GPS',
    message: 'You are about {distanceM} m from the office; you must be within {radiusM} m.',
    hint: 'Go to the office and try again.',
  },

  // ---- NETWORK ----
  NETWORK_UNKNOWN: {
    layer: 'NETWORK',
    message: 'Your network address could not be determined.',
    hint: 'Connect to the office Wi-Fi and try again.',
  },
  NETWORK_NOT_ALLOWED: {
    layer: 'NETWORK',
    message: 'You are not connected to the office network.',
    hint: 'Connect to the office Wi-Fi (not mobile data or a VPN) and try again.',
  },
  NETWORK_NOT_CONFIGURED: {
    layer: 'NETWORK',
    message: 'No office network has been set up yet.',
    hint: 'Ask your administrator to add the office network.',
  },

  // ---- QR ----
  QR_MISSING: {
    layer: 'QR',
    message: 'The office QR code was not scanned.',
    hint: 'Scan the QR code shown on the office screen.',
  },
  QR_INVALID: {
    layer: 'QR',
    message: 'That is not a valid office QR code.',
    hint: 'Scan the QR code shown on the office screen.',
  },
  QR_EXPIRED: {
    layer: 'QR',
    message: 'That QR code has expired.',
    hint: 'Scan the code that is showing on the office screen right now.',
  },
  QR_REPLAYED: {
    layer: 'QR',
    message: 'You have already used that QR code.',
    hint: 'Wait a few seconds for the screen to show a new code, then scan it.',
  },

  // ---- DEVICE ----
  DEVICE_MISSING: {
    layer: 'DEVICE',
    message: 'This device was not identified.',
    hint: 'Update the app or reload the page, then try again.',
  },
  DEVICE_NOT_REGISTERED: {
    layer: 'DEVICE',
    message: 'This device is not registered to your account.',
    hint: 'Register this device first, or use the device you registered.',
  },
  DEVICE_PENDING: {
    layer: 'DEVICE',
    message: 'This device is waiting for approval.',
    hint: 'Ask your administrator to approve this device.',
  },
  DEVICE_REVOKED: {
    layer: 'DEVICE',
    message: 'This device has been removed from your account.',
    hint: 'Register it again, or use another registered device.',
  },
  DEVICE_PLATFORM_MISMATCH: {
    layer: 'DEVICE',
    message: 'This device cannot be used from here.',
    hint: 'Use the app on your registered phone, or your registered browser on the web.',
  },
  DEVICE_CHALLENGE_INVALID: {
    layer: 'DEVICE',
    message: 'The security check for this device is not valid.',
    hint: 'Try again.',
  },
  DEVICE_CHALLENGE_EXPIRED: {
    layer: 'DEVICE',
    message: 'The security check for this device expired.',
    hint: 'Try again.',
  },
  DEVICE_PROOF_MISSING: {
    layer: 'DEVICE',
    message: 'This device did not confirm its identity.',
    hint: 'Try again and approve the device prompt.',
  },
  DEVICE_PROOF_INVALID: {
    layer: 'DEVICE',
    message: 'This device could not confirm its identity.',
    hint: 'Try again. If it keeps failing, ask your administrator to re-register the device.',
  },
  DEVICE_CLONE_SUSPECTED: {
    layer: 'DEVICE',
    message: 'This device’s security key looks like a copy.',
    hint: 'Contact your administrator.',
  },
} as const satisfies Record<string, ReasonDefinition>;

export type VerificationReasonCode = keyof typeof VERIFICATION_REASONS;
export const VERIFICATION_REASON_CODES = Object.keys(
  VERIFICATION_REASONS,
) as VerificationReasonCode[];

export function isVerificationReasonCode(value: string): value is VerificationReasonCode {
  return Object.prototype.hasOwnProperty.call(VERIFICATION_REASONS, value);
}

export interface VerificationReasonDto {
  code: VerificationReasonCode;
  layer: VerificationLayer;
  message: string;
  hint: string;
}

/** Fills `{placeholders}` in a reason's message. Unknown placeholders are left visible, not hidden. */
export function formatReason(
  code: VerificationReasonCode,
  params: Record<string, string | number> = {},
): VerificationReasonDto {
  const definition: ReasonDefinition = VERIFICATION_REASONS[code];
  const message = definition.message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
  return { code, layer: definition.layer, message, hint: definition.hint };
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/** A location fix as the device reports it. `fixTime` is epoch milliseconds or an ISO timestamp. */
export const gpsEvidenceSchema = z.strictObject({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Horizontal accuracy radius in metres, as reported by the device. */
  accuracyM: z.number().min(0).max(100_000),
  fixTime: z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]),
  /** Android's "this fix came from a mock provider" flag, when available. */
  mocked: z.boolean().optional(),
});
export type GpsEvidence = z.infer<typeof gpsEvidenceSchema>;

export const qrEvidenceSchema = z.strictObject({
  payload: z.string().min(1).max(200),
});

const base64urlText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url text.');

/** Native apps: an ES256 (ECDSA P-256) signature, IEEE P1363 `r||s` (64 bytes), base64url. */
export const appKeyProofSchema = z.strictObject({
  type: z.literal('APP_KEY'),
  signature: z
    .string()
    .length(86)
    .regex(/^[A-Za-z0-9_-]+$/),
});

/** Browsers: the JSON form of a WebAuthn assertion (`@simplewebauthn/browser` produces this). */
export const webauthnAssertionSchema = z.strictObject({
  id: base64urlText(1024),
  rawId: base64urlText(1024),
  // Loose on purpose: browsers may add members over time, and refusing the whole assertion for
  // that would lock people out. The server only ever reads the four members below.
  response: z.looseObject({
    clientDataJSON: base64urlText(4096),
    authenticatorData: base64urlText(4096),
    signature: base64urlText(2048),
    userHandle: z.string().max(1024).nullish(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullish(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  type: z.literal('public-key'),
});
export type WebauthnAssertion = z.infer<typeof webauthnAssertionSchema>;

export const webauthnProofSchema = z.strictObject({
  type: z.literal('WEBAUTHN'),
  response: webauthnAssertionSchema,
});

export const deviceProofSchema = z.discriminatedUnion('type', [
  appKeyProofSchema,
  webauthnProofSchema,
]);
export type DeviceProof = z.infer<typeof deviceProofSchema>;

export const deviceEvidenceSchema = z.strictObject({
  deviceId: uuidSchema,
  challengeId: uuidSchema,
  /** Optional in the schema so a missing proof is reported as a clear verification failure. */
  proof: deviceProofSchema.optional(),
});

export type DeviceEvidence = z.output<typeof deviceEvidenceSchema>;

export const verifyRequestSchema = z.strictObject({
  purpose: z.enum(VERIFICATION_PURPOSES),
  channel: z.enum(CHANNELS),
  gps: gpsEvidenceSchema.optional(),
  qr: qrEvidenceSchema.optional(),
  device: deviceEvidenceSchema.optional(),
});
export type VerifyRequest = z.input<typeof verifyRequestSchema>;
export type VerifyRequestBody = z.output<typeof verifyRequestSchema>;

/** Pre-check of a scanned QR code, before the user is asked for anything else. */
export const qrCheckRequestSchema = qrEvidenceSchema;

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface VerificationGpsSummary {
  distanceMeters: number | null;
  accuracyMeters: number | null;
}

export type VerificationLayers = Record<VerificationLayer, LayerResult>;

/** Body of a successful `POST /api/attendance/verify`. */
export interface VerifyResponse {
  result: 'VERIFIED';
  verificationId: string;
  /** The verification can be used to check in / out until this time, once. */
  expiresAt: string;
  layers: VerificationLayers;
  gps: VerificationGpsSummary;
}

/** `error.details` of a rejected verification (HTTP 422, code `VERIFICATION_FAILED`). */
export interface VerifyFailureDetails {
  result: 'REJECTED';
  verificationId: string;
  layers: VerificationLayers;
  reasons: VerificationReasonDto[];
  gps: VerificationGpsSummary;
}

export interface QrCheckResponse {
  valid: true;
  /** Last moment this code is accepted (inclusive of the short grace period). */
  acceptUntil: string;
}

/** `error.details` of a rejected QR pre-check (HTTP 422, code `VERIFICATION_FAILED`). */
export interface QrCheckFailureDetails {
  reasons: VerificationReasonDto[];
}

// ---------------------------------------------------------------------------------------------
// The office QR code
// ---------------------------------------------------------------------------------------------

export const QR_PAYLOAD_PREFIX = 'TG1';

export interface QrWindowDto {
  index: number;
  validFrom: string;
  expiresAt: string;
  acceptUntil: string;
}

/** Body of `GET /api/office/qr/current`, for the lobby display. */
export interface QrCurrentResponse {
  payload: string;
  window: QrWindowDto;
  /** The next code, so the display can switch at the exact boundary even if a request is late. */
  next: { payload: string; window: QrWindowDto };
  rotationSeconds: number;
  serverTime: string;
}

// ---------------------------------------------------------------------------------------------
// What a device signs. Shared so the mobile app and the server can never disagree on the bytes.
// ---------------------------------------------------------------------------------------------

/** Proves the registrant holds the private key being registered (native apps). */
export function registrationProofMessage(input: {
  challenge: string;
  employeeId: string;
  platform: string;
  deviceIdentifier: string;
}): string {
  return [
    'tg-register-v1',
    input.challenge,
    input.employeeId,
    input.platform,
    input.deviceIdentifier,
  ].join('\n');
}

/** Proves the registered device is present for this specific verification (native apps). */
export function verificationProofMessage(input: {
  challenge: string;
  employeeId: string;
  deviceId: string;
  purpose: VerificationPurpose;
}): string {
  return ['tg-verify-v1', input.challenge, input.employeeId, input.deviceId, input.purpose].join(
    '\n',
  );
}
