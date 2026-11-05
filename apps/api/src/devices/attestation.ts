import type { DevicePlatform } from '@teachgrow/shared';

/**
 * Platform integrity attestation for the native apps: Google Play Integrity on Android, Apple App
 * Attest on iOS. They answer a different question from the device key: "is this a genuine,
 * unmodified build of our app on a genuine device?" rather than "is it the same device as before?".
 *
 * This is the seam where they plug in. Phase 5 ships the key-based device proof only; the real
 * verifiers arrive with the mobile app (Phase 9), where the evidence can actually be produced and
 * tested end to end. Until then every native registration is recorded with provider `NONE`, and
 * administrators approve devices knowing that is the case.
 */

export type AttestationProvider = 'PLAY_INTEGRITY' | 'APP_ATTEST' | 'NONE';

export interface AttestationResult {
  provider: AttestationProvider;
  /** When the platform vouched for the device; null when nothing was verified. */
  verifiedAt: Date | null;
}

export interface NativeAttestationInput {
  platform: Exclude<DevicePlatform, 'WEB'>;
  /** The device public key being registered (SPKI, base64url). */
  publicKey: string;
  /** The registration challenge, base64url: what the attestation must be bound to. */
  challenge: string;
}

export interface AttestationVerifier {
  /** Throws an AppError to refuse the registration; otherwise says what was established. */
  verifyNative(input: NativeAttestationInput, now: Date): Promise<AttestationResult>;
}

/** Establishes nothing, and says so. */
export const noAttestation: AttestationVerifier = {
  async verifyNative() {
    return { provider: 'NONE', verifiedAt: null };
  },
};
