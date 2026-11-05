import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A stand-in for a platform passkey (Windows Hello, Touch ID, Android screen lock), for tests.
 *
 * It builds the same bytes a real authenticator does - authenticator data, a "none" attestation
 * object, ES256 signatures in ASN.1 form - so the server's WebAuthn verification is exercised for
 * real. Nothing here is a mock of the library under test.
 */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface SoftwareAuthenticatorOptions {
  /** The origin the "browser" reports, e.g. https://app.test */
  origin: string;
  /** The relying party id the credential is scoped to, e.g. app.test */
  rpId: string;
  /** Real passkeys mostly report 0 forever; hardware keys count. Default: false (reports 0). */
  reportsCounter?: boolean;
  /** Multi-device (synced) passkey flags. */
  backupEligible?: boolean;
  backedUp?: boolean;
  /** What the browser claims about the authenticator. Default: platform. */
  attachment?: 'platform' | 'cross-platform';
  /** Whether the user was verified (PIN / biometric). Default: true. */
  userVerified?: boolean;
}

const b64u = (bytes: Uint8Array): string => isoBase64URL.fromBuffer(Uint8Array.from(bytes));
const sha256 = (data: string | Uint8Array): Buffer => createHash('sha256').update(data).digest();

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  /** The signature counter this authenticator will report next time (when it reports one). */
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;

  constructor(readonly options: SoftwareAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x as string, 'base64url');
    this.y = Buffer.from(jwk.y as string, 'base64url');
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private flags(extra = 0): number {
    const { userVerified = true, backupEligible = false, backedUp = false } = this.options;
    return (
      FLAG_UP |
      (userVerified ? FLAG_UV : 0) |
      (backupEligible || backedUp ? FLAG_BE : 0) |
      (backedUp ? FLAG_BS : 0) |
      extra
    );
  }

  private nextCounter(): Buffer {
    if (this.options.reportsCounter) this.counter += 1;
    const out = Buffer.alloc(4);
    out.writeUInt32BE(this.options.reportsCounter ? this.counter : 0);
    return out;
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.options.origin, crossOrigin: false }),
    );
  }

  /** What `navigator.credentials.create()` returns, in the JSON form the browser helper sends. */
  register(creationOptions: { challenge: string }) {
    const clientDataJSON = this.clientData('webauthn.create', creationOptions.challenge);

    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Uint8Array.from(this.x)],
        [-3, Uint8Array.from(this.y)],
      ]),
    );
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length);

    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      this.nextCounter(),
      Buffer.alloc(16), // AAGUID: all zeros, as for an authenticator that does not identify itself
      credentialIdLength,
      this.credentialId,
      Buffer.from(coseKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', Uint8Array.from(authData)],
      ]) as Map<string, never>,
    );

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      authenticatorAttachment: this.options.attachment ?? ('platform' as const),
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** What `navigator.credentials.get()` returns, in the JSON form the browser helper sends. */
  assert(requestOptions: { challenge: string }) {
    const clientDataJSON = this.clientData('webauthn.get', requestOptions.challenge);
    const authenticatorData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags()]),
      this.nextCounter(),
    ]);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey,
    );

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      authenticatorAttachment: this.options.attachment ?? ('platform' as const),
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
      },
    };
  }
}
