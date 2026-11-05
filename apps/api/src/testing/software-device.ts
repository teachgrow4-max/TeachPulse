import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import {
  registrationProofMessage,
  verificationProofMessage,
  type VerificationPurpose,
} from '@teachgrow/shared';

/**
 * A stand-in for a phone's secure key store, for tests: it generates a real ECDSA P-256 key pair
 * and produces exactly the registration and verification proofs the mobile app will send.
 */
export class SoftwareDevice {
  readonly privateKey: KeyObject;
  /** SPKI public key, base64url: what the app sends when registering. */
  readonly publicKey: string;
  /** A random identifier, as the app would keep in its secure storage. */
  readonly identifier: string;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    this.identifier = randomBytes(24).toString('base64url');
  }

  /** ES256 in IEEE P1363 form (`r || s`), base64url. */
  signMessage(message: string): string {
    return sign('sha256', Buffer.from(message, 'utf8'), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  }

  /** The body for POST /api/devices/register. */
  registrationBody(input: {
    challengeId: string;
    challenge: string;
    employeeId: string;
    password: string;
    platform?: 'ANDROID' | 'IOS';
    name?: string;
  }) {
    const platform = input.platform ?? 'ANDROID';
    return {
      challengeId: input.challengeId,
      platform,
      ...(input.name ? { deviceName: input.name } : {}),
      currentPassword: input.password,
      deviceIdentifier: this.identifier,
      appKey: {
        publicKey: this.publicKey,
        signature: this.signMessage(
          registrationProofMessage({
            challenge: input.challenge,
            employeeId: input.employeeId,
            platform,
            deviceIdentifier: this.identifier,
          }),
        ),
      },
    };
  }

  /** The `device` evidence for POST /api/attendance/verify. */
  evidence(input: {
    challengeId: string;
    challenge: string;
    employeeId: string;
    deviceId: string;
    purpose: VerificationPurpose;
  }) {
    return {
      deviceId: input.deviceId,
      challengeId: input.challengeId,
      proof: {
        type: 'APP_KEY' as const,
        signature: this.signMessage(
          verificationProofMessage({
            challenge: input.challenge,
            employeeId: input.employeeId,
            deviceId: input.deviceId,
            purpose: input.purpose,
          }),
        ),
      },
    };
  }
}
