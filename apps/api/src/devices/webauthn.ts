import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { DeviceProofError } from './proofs.js';

/**
 * The browser's device proof: a WebAuthn PLATFORM passkey (Windows Hello, Touch ID / Face ID,
 * Android screen lock). The private key lives in the machine's secure hardware and every use needs
 * the person's presence and a local unlock, so "this browser" becomes something that can actually
 * be proven rather than guessed from a fingerprint.
 *
 * What this does and does not give you is spelled out in docs/VERIFICATION.md: passkeys that the
 * platform syncs between a person's devices are not strictly bound to one machine.
 */

export interface WebAuthnConfig {
  /** Relying party id: the registrable domain the web app is served from. */
  rpId: string;
  rpName: string;
  /** The exact origins the web app runs on (scheme + host + port). */
  origins: string[];
}

export interface WebAuthnCredentialRecord {
  /** base64url credential id. */
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
}

export interface VerifiedRegistration {
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports: string[];
}

export interface VerifiedAssertion {
  newCounter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}

/** The library insists on `Uint8Array<ArrayBuffer>`; a Node `Buffer` is the wider `ArrayBufferLike`. */
const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);
const b64url = (bytes: Uint8Array): string => isoBase64URL.fromBuffer(plain(bytes));

export class WebAuthnVerifier {
  constructor(private readonly config: WebAuthnConfig) {}

  registrationOptions(input: {
    userId: string;
    userName: string;
    userDisplayName: string;
    challenge: Uint8Array;
    excludeCredentialIds: string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      // An opaque handle, not the email: it is stored on the authenticator.
      userID: plain(new TextEncoder().encode(input.userId)),
      challenge: plain(input.challenge),
      attestationType: 'none',
      timeout: 120_000,
      excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
  }

  async verifyRegistration(input: {
    response: RegistrationResponseJSON;
    challenge: Uint8Array;
  }): Promise<VerifiedRegistration> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: b64url(input.challenge),
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch (cause) {
      throw new DeviceProofError('invalid_proof', 'The passkey could not be verified.', { cause });
    }
    if (!result.verified) {
      throw new DeviceProofError('invalid_proof', 'The passkey could not be verified.');
    }
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports ?? [],
    };
  }

  authenticationOptions(input: {
    credentialId: string;
    challenge: Uint8Array;
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.config.rpId,
      challenge: plain(input.challenge),
      allowCredentials: [{ id: input.credentialId }],
      userVerification: 'required',
      timeout: 120_000,
    });
  }

  async verifyAssertion(input: {
    response: AuthenticationResponseJSON;
    challenge: Uint8Array;
    credential: WebAuthnCredentialRecord;
  }): Promise<VerifiedAssertion> {
    // The assertion must be from the credential this challenge was issued for.
    if (input.response.id !== input.credential.id) {
      throw new DeviceProofError('invalid_proof', 'The passkey is not the registered one.');
    }
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: b64url(input.challenge),
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: {
          id: input.credential.id,
          publicKey: isoBase64URL.toBuffer(input.credential.publicKey),
          counter: input.credential.counter,
        },
      });
    } catch (cause) {
      // The library refuses a signature counter that did not advance. A counter that goes
      // backwards or stands still means the credential has been copied.
      const message = cause instanceof Error ? cause.message : '';
      if (/counter value/i.test(message)) {
        throw new DeviceProofError('clone_suspected', 'The passkey counter did not advance.', {
          cause,
        });
      }
      throw new DeviceProofError('invalid_proof', 'The passkey could not be verified.', { cause });
    }
    if (!result.verified) {
      throw new DeviceProofError('invalid_proof', 'The passkey could not be verified.');
    }
    const info = result.authenticationInfo;
    return {
      newCounter: info.newCounter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
  }
}
