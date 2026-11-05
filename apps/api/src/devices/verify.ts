import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  formatReason,
  verificationProofMessage,
  type Channel,
  type DeviceEvidence,
  type VerificationPurpose,
  type VerificationReasonDto,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import type { Queryable } from '../db/pool.js';
import type { RequestMeta } from '../lib/request-meta.js';
import { consumeChallenge } from './challenges.js';
import { DeviceProofError, verifyAppSignature } from './proofs.js';
import { DEVICE_COLUMNS, type DeviceRow } from './repository.js';
import type { WebAuthnVerifier } from './webauthn.js';

/**
 * Layer 4: "is this the phone / browser the employee registered, and is it present right now?"
 *
 * Runs inside the verification transaction. Every failure is returned as a reason (never thrown)
 * so the attempt is recorded together with the spent challenge.
 */

export interface DeviceEvaluation {
  result: 'PASS' | 'FAIL';
  reasons: VerificationReasonDto[];
  /** The employee's own device the evidence named, even when it then failed. Null otherwise. */
  deviceId: string | null;
}

export interface DeviceEvaluationInput {
  employeeId: string;
  channel: Channel;
  purpose: VerificationPurpose;
  evidence: DeviceEvidence | undefined;
  now: Date;
  meta: RequestMeta;
}

const fail = (
  code: Parameters<typeof formatReason>[0],
  deviceId: string | null,
): DeviceEvaluation => ({ result: 'FAIL', reasons: [formatReason(code)], deviceId });

function toAuthenticationResponse(
  proof: Extract<NonNullable<DeviceEvidence['proof']>, { type: 'WEBAUTHN' }>['response'],
): AuthenticationResponseJSON {
  // Pick the known members; whatever else a client sent never reaches the library.
  return {
    id: proof.id,
    rawId: proof.rawId,
    type: proof.type,
    authenticatorAttachment: proof.authenticatorAttachment ?? undefined,
    clientExtensionResults: proof.clientExtensionResults,
    response: {
      clientDataJSON: proof.response.clientDataJSON,
      authenticatorData: proof.response.authenticatorData,
      signature: proof.response.signature,
      userHandle: proof.response.userHandle ?? undefined,
    },
  };
}

export async function evaluateDevice(
  tx: Queryable,
  webauthn: WebAuthnVerifier,
  input: DeviceEvaluationInput,
): Promise<DeviceEvaluation> {
  const { employeeId, channel, purpose, evidence, now, meta } = input;
  if (!evidence) return fail('DEVICE_MISSING', null);

  // Locked so two verifications cannot race on the same passkey counter.
  const { rows } = await tx.query<DeviceRow>(
    `select ${DEVICE_COLUMNS}
     from public.registered_devices d
     where d.id = $1 and d.employee_id = $2
     for update`,
    [evidence.deviceId, employeeId],
  );
  const device = rows[0];
  // Someone else's device is indistinguishable from one that does not exist.
  if (!device) return fail('DEVICE_NOT_REGISTERED', null);

  if (device.status === 'REVOKED') return fail('DEVICE_REVOKED', device.id);
  if (device.status === 'PENDING') return fail('DEVICE_PENDING', device.id);

  const native = device.platform !== 'WEB';
  if ((channel === 'WEB') === native) return fail('DEVICE_PLATFORM_MISMATCH', device.id);

  const spent = await consumeChallenge(tx, {
    id: evidence.challengeId,
    userId: employeeId,
    purpose,
    deviceId: device.id,
    now,
  });
  if (!spent.ok) {
    return fail(
      spent.reason === 'EXPIRED' ? 'DEVICE_CHALLENGE_EXPIRED' : 'DEVICE_CHALLENGE_INVALID',
      device.id,
    );
  }

  const proof = evidence.proof;
  if (!proof) return fail('DEVICE_PROOF_MISSING', device.id);

  if (native) {
    if (proof.type !== 'APP_KEY' || !device.public_key)
      return fail('DEVICE_PROOF_INVALID', device.id);
    const message = verificationProofMessage({
      challenge: spent.bytes.toString('base64url'),
      employeeId,
      deviceId: device.id,
      purpose,
    });
    if (!verifyAppSignature(device.public_key, message, proof.signature)) {
      return fail('DEVICE_PROOF_INVALID', device.id);
    }
    await tx.query(
      'update public.registered_devices set last_seen_at = $2::timestamptz where id = $1',
      [device.id, now],
    );
    return { result: 'PASS', reasons: [], deviceId: device.id };
  }

  if (proof.type !== 'WEBAUTHN' || !device.public_key || !device.credential_id) {
    return fail('DEVICE_PROOF_INVALID', device.id);
  }
  try {
    const verified = await webauthn.verifyAssertion({
      response: toAuthenticationResponse(proof.response),
      challenge: spent.bytes,
      credential: {
        id: device.credential_id,
        publicKey: device.public_key,
        counter: Number(device.attestation_counter ?? 0),
      },
    });
    await tx.query(
      `update public.registered_devices
       set last_seen_at = $2::timestamptz, attestation_counter = $3
       where id = $1`,
      [device.id, now, verified.newCounter],
    );
    return { result: 'PASS', reasons: [], deviceId: device.id };
  } catch (error) {
    if (!(error instanceof DeviceProofError)) throw error;
    if (error.kind === 'clone_suspected') {
      await writeAudit(tx, {
        action: 'device.clone_suspected',
        actorId: employeeId,
        entityType: 'device',
        entityId: device.id,
        metadata: { stored_counter: Number(device.attestation_counter ?? 0), purpose },
        ...meta,
        at: now,
      });
      return fail('DEVICE_CLONE_SUSPECTED', device.id);
    }
    return fail('DEVICE_PROOF_INVALID', device.id);
  }
}
