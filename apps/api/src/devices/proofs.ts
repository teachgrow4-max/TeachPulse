import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Device proofs for the native apps.
 *
 * A phone proves it is the registered phone by signing a server challenge with a private key that
 * was generated on the device and never leaves it. The server stores only the public half.
 *
 *   key        ECDSA P-256, SubjectPublicKeyInfo (DER), base64url
 *   signature  ES256 in IEEE P1363 form (`r || s`, 64 bytes), base64url
 *   message    built by the helpers in @teachgrow/shared so the app and the server cannot disagree
 *
 * Browsers use WebAuthn instead (see webauthn.ts).
 */

export type DeviceProofFailure = 'malformed_key' | 'invalid_proof' | 'clone_suspected';

export class DeviceProofError extends Error {
  constructor(
    readonly kind: DeviceProofFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'DeviceProofError';
  }
}

export interface ParsedAppKey {
  key: KeyObject;
  /** Re-encoded from the parsed key, so one key has exactly one stored spelling. */
  canonical: string;
}

/** Accepts only a P-256 public key in SPKI form. */
export function parseAppPublicKey(spkiBase64Url: string): ParsedAppKey {
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(spkiBase64Url, 'base64url'),
      format: 'der',
      type: 'spki',
    });
  } catch (cause) {
    throw new DeviceProofError('malformed_key', 'The device key is not a valid public key.', {
      cause,
    });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new DeviceProofError('malformed_key', 'The device key must be an ECDSA P-256 key.');
  }
  const canonical = key.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { key, canonical };
}

/** True only for a valid ES256 signature over exactly `message`. Never throws on bad input. */
export function verifyAppSignature(
  spkiBase64Url: string,
  message: string,
  signatureBase64Url: string,
): boolean {
  try {
    const { key } = parseAppPublicKey(spkiBase64Url);
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    if (signature.length !== 64) return false;
    return verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    return false;
  }
}
