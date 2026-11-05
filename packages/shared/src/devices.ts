import { z } from 'zod';
import {
  DEVICE_PLATFORMS,
  DEVICE_STATUSES,
  VERIFICATION_PURPOSES,
  type DevicePlatform,
  type DeviceStatus,
} from './enums.js';
import { uuidSchema } from './schemas.js';

/**
 * Device registration contracts.
 *
 * A "device" is proven by a private key that never leaves it:
 *   - native apps (ANDROID / IOS) generate an ES256 key pair and sign server challenges;
 *   - browsers (WEB) use a WebAuthn platform passkey.
 * A browser fingerprint is NOT an identity and is never used as one.
 */

const base64urlText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url text.');

const deviceNameSchema = z.string().trim().min(1).max(100);

/** Step 1 of registration: ask the server for a one-time challenge. */
export const registerOptionsRequestSchema = z.strictObject({
  platform: z.enum(DEVICE_PLATFORMS),
  deviceName: deviceNameSchema.optional(),
});

/** The JSON form of a WebAuthn registration result (`@simplewebauthn/browser` produces this). */
export const webauthnRegistrationSchema = z.strictObject({
  id: base64urlText(1024),
  rawId: base64urlText(1024),
  response: z.looseObject({
    clientDataJSON: base64urlText(4096),
    attestationObject: base64urlText(65_536),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullish(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  type: z.literal('public-key'),
});

/**
 * Step 2: register. Re-enter your password (a stolen access token must not be enough to enrol a
 * device), and prove you hold the key being registered. The new device stays PENDING until an
 * administrator approves it.
 */
export const registerDeviceRequestSchema = z
  .strictObject({
    challengeId: uuidSchema,
    platform: z.enum(DEVICE_PLATFORMS),
    deviceName: deviceNameSchema.optional(),
    currentPassword: z.string().min(1).max(256),
    /** Native only: a random identifier (at least 128 bits) kept in the device's secure storage. */
    deviceIdentifier: z.string().min(16).max(200).optional(),
    /** Native only: the SPKI public key (base64url) and a signature over the registration message. */
    appKey: z
      .strictObject({
        publicKey: base64urlText(200),
        signature: z
          .string()
          .length(86)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .optional(),
    /** Web only. */
    webauthn: webauthnRegistrationSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (value.platform === 'WEB') {
      if (!value.webauthn) issue('webauthn', 'A browser registration needs a passkey.');
      if (value.appKey) issue('appKey', 'Not used for browsers.');
      if (value.deviceIdentifier) issue('deviceIdentifier', 'Not used for browsers.');
    } else {
      if (!value.appKey) issue('appKey', 'An app registration needs a device key.');
      if (!value.deviceIdentifier)
        issue('deviceIdentifier', 'An app registration needs an identifier.');
      if (value.webauthn) issue('webauthn', 'Not used for apps.');
    }
  });
export type RegisterDeviceRequest = z.input<typeof registerDeviceRequestSchema>;
export type RegisterDeviceInput = z.output<typeof registerDeviceRequestSchema>;

/** Ask for a one-time challenge to prove a registered device during a check-in or check-out. */
export const attendanceChallengeRequestSchema = z.strictObject({
  deviceId: uuidSchema,
  purpose: z.enum(VERIFICATION_PURPOSES),
});

export const revokeDeviceRequestSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const adminDevicesQuerySchema = z.object({
  employeeId: uuidSchema.optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminDevicesQuery = z.output<typeof adminDevicesQuerySchema>;

export interface DeviceDto {
  id: string;
  platform: DevicePlatform;
  name: string | null;
  status: DeviceStatus;
  attestationProvider: string | null;
  registeredAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AdminDeviceDto extends DeviceDto {
  employee: { id: string; fullName: string; employeeCode: string };
  revokedReason: string | null;
}

/** A one-time challenge. `webauthn` holds the browser options for WEB devices. */
export interface ChallengeResponse {
  challengeId: string;
  /** base64url, 32 random bytes. Native apps sign it (see `verificationProofMessage`). */
  challenge: string;
  expiresAt: string;
  webauthn?: unknown;
}
