import { createHash } from 'node:crypto';
import {
  registrationProofMessage,
  type AdminDeviceDto,
  type AdminDevicesQuery,
  type ChallengeResponse,
  type DeviceDto,
  type DevicePlatform,
  type DeviceStatus,
  type Paginated,
  type RegisterDeviceInput,
  type VerificationPurpose,
} from '@teachgrow/shared';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { writeAudit } from '../audit/audit.js';
import type { Identity } from '../auth/identity.js';
import { constraintOf } from '../db/errors.js';
import type { Db, Queryable } from '../db/pool.js';
import type { Actor } from '../employees/service.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { RequestMeta } from '../lib/request-meta.js';
import { loadActiveOffice, loadPolicyAt } from '../office/repository.js';
import type { AttestationVerifier } from './attestation.js';
import {
  REGISTER_CHALLENGE_TTL_SECONDS,
  VERIFY_CHALLENGE_TTL_SECONDS,
  consumeChallenge,
  issueChallenge,
  retireDeviceChallenges,
} from './challenges.js';
import { DeviceProofError, parseAppPublicKey, verifyAppSignature } from './proofs.js';
import { DEVICE_COLUMNS, toDeviceDto, type DeviceRow } from './repository.js';
import type { WebAuthnVerifier } from './webauthn.js';

/** What the device service needs from the auth layer: a fresh proof that the person knows their password. */
export interface PasswordConfirmer {
  confirmPassword(
    identity: Identity,
    password: string,
    meta: RequestMeta,
    purpose: 'device_registration',
  ): Promise<void>;
}

export interface DeviceServiceDeps {
  db: Db;
  clock: Clock;
  passwords: PasswordConfirmer;
  webauthn: WebAuthnVerifier;
  attestation: AttestationVerifier;
}

/** Stored in place of the raw identifier: enough to enforce "one live person per device". */
const hashedIdentifier = (namespace: 'app' | 'web', value: string): string =>
  `${namespace}:${createHash('sha256').update(`tg-device-v1\n${namespace}\n${value}`).digest('base64url')}`;

/** Everything proven about a device at registration, ready to store. */
interface ProvenDevice {
  identifier: string;
  publicKey: string;
  credentialId: string | null;
  counter: number | null;
  provider: string;
  attestedAt: Date | null;
  /** Facts worth keeping in the audit trail. */
  facts: Record<string, unknown>;
}

function toRegistrationResponse(
  input: NonNullable<RegisterDeviceInput['webauthn']>,
): RegistrationResponseJSON {
  // Pick the known members; whatever else a client sent never reaches the library.
  return {
    id: input.id,
    rawId: input.rawId,
    type: input.type,
    authenticatorAttachment: input.authenticatorAttachment ?? undefined,
    clientExtensionResults: input.clientExtensionResults,
    response: {
      clientDataJSON: input.response.clientDataJSON,
      attestationObject: input.response.attestationObject,
      transports: input.response.transports as RegistrationResponseJSON['response']['transports'],
    },
  };
}

export class DeviceService {
  constructor(private readonly deps: DeviceServiceDeps) {}

  // ---------------------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------------------

  /** Step 1: a one-time challenge (and, for browsers, the passkey creation options). */
  async registerOptions(
    identity: Identity,
    input: { platform: DevicePlatform },
  ): Promise<ChallengeResponse> {
    const { db, clock, webauthn } = this.deps;
    const now = clock.now();

    // Say so before the person is asked to unlock anything, not after.
    await this.assertRoomForAnotherDevice(db, identity.id, now);

    const challenge = await issueChallenge(db, {
      userId: identity.id,
      purpose: 'REGISTER',
      platform: input.platform,
      now,
      ttlSeconds: REGISTER_CHALLENGE_TTL_SECONDS,
    });

    const response: ChallengeResponse = {
      challengeId: challenge.id,
      challenge: challenge.bytes.toString('base64url'),
      expiresAt: challenge.expiresAt.toISOString(),
    };

    if (input.platform === 'WEB') {
      const { rows } = await db.query<{ credential_id: string }>(
        `select credential_id from public.registered_devices
         where employee_id = $1 and credential_id is not null and status <> 'REVOKED'`,
        [identity.id],
      );
      response.webauthn = await webauthn.registrationOptions({
        userId: identity.id,
        userName: identity.email,
        userDisplayName: identity.fullName,
        challenge: challenge.bytes,
        excludeCredentialIds: rows.map((r) => r.credential_id),
      });
    }
    return response;
  }

  /**
   * Step 2: enrol the device. It starts PENDING; an administrator approves it before it counts.
   *
   * Three things must hold: the person re-enters their password (a stolen access token is not
   * enough), the challenge is one this server just issued to them, and the device proves it holds
   * the private key it is registering.
   */
  async register(
    identity: Identity,
    input: RegisterDeviceInput,
    meta: RequestMeta,
  ): Promise<DeviceDto> {
    const { db, clock, passwords } = this.deps;
    const now = clock.now();

    await passwords.confirmPassword(identity, input.currentPassword, meta, 'device_registration');

    // Spent now, in its own commit: a wrong proof must not leave the challenge reusable, and two
    // simultaneous requests must not both get to use it.
    const spent = await db.withTransaction((tx) =>
      consumeChallenge(tx, {
        id: input.challengeId,
        userId: identity.id,
        purpose: 'REGISTER',
        platform: input.platform,
        now,
      }),
    );
    if (!spent.ok) {
      throw new AppError(spent.reason === 'EXPIRED' ? 'CHALLENGE_EXPIRED' : 'CHALLENGE_INVALID');
    }

    const proven = await this.proveRegistration(identity, input, spent.bytes, now);

    let row: DeviceRow;
    try {
      row = await db.withTransaction(async (tx) => {
        // One enrolment at a time per person, so two tabs cannot both take the last slot.
        await tx.query('select 1 from public.profiles where id = $1 for update', [identity.id]);
        await this.assertRoomForAnotherDevice(tx, identity.id, now);

        const inserted = await tx.query<DeviceRow>(
          `insert into public.registered_devices as d
             (employee_id, device_identifier, platform, device_name, status, public_key,
              credential_id, attestation_provider, attestation_verified_at, attestation_counter,
              registered_at)
           values ($1, $2, $3::public.device_platform, $4, 'PENDING', $5, $6, $7, $8::timestamptz,
                   $9, $10::timestamptz)
           returning ${DEVICE_COLUMNS}`,
          [
            identity.id,
            proven.identifier,
            input.platform,
            input.deviceName ?? null,
            proven.publicKey,
            proven.credentialId,
            proven.provider,
            proven.attestedAt,
            proven.counter,
            now,
          ],
        );
        const device = inserted.rows[0]!;
        await writeAudit(tx, {
          action: 'device.register',
          actorId: identity.id,
          actorRole: identity.role,
          entityType: 'device',
          entityId: device.id,
          after: { status: 'PENDING' },
          metadata: {
            platform: input.platform,
            name: input.deviceName ?? null,
            attestation: proven.provider,
            ...proven.facts,
          },
          ...meta,
          at: now,
        });
        return device;
      });
    } catch (error) {
      const { code } = constraintOf(error);
      if (code === '23505') {
        // The same physical device, or the same passkey, is already live (here or for a colleague).
        throw new AppError('DEVICE_ALREADY_REGISTERED', undefined, { cause: error });
      }
      throw error;
    }
    return toDeviceDto(row);
  }

  private async proveRegistration(
    identity: Identity,
    input: RegisterDeviceInput,
    challenge: Buffer,
    now: Date,
  ): Promise<ProvenDevice> {
    const challengeText = challenge.toString('base64url');

    if (input.platform === 'WEB') {
      const registration = input.webauthn;
      if (!registration) throw new AppError('DEVICE_PROOF_INVALID');
      if (registration.authenticatorAttachment === 'cross-platform') {
        throw new AppError(
          'DEVICE_PROOF_INVALID',
          'Use this computer’s own passkey (Windows Hello, Touch ID, or the screen lock), not a separate security key or another phone.',
        );
      }
      try {
        const verified = await this.deps.webauthn.verifyRegistration({
          response: toRegistrationResponse(registration),
          challenge,
        });
        return {
          identifier: hashedIdentifier('web', verified.credentialId),
          publicKey: verified.publicKey,
          credentialId: verified.credentialId,
          counter: verified.counter,
          provider: 'WEBAUTHN',
          attestedAt: now,
          // A passkey the platform syncs between a person's devices is not bound to one machine.
          // (Key names avoid "pass"/"credential": the audit writer redacts anything that looks
          // like a secret, and these are facts for administrators to read.)
          facts: {
            synced_across_devices: verified.deviceType === 'multiDevice',
            backed_up: verified.backedUp,
          },
        };
      } catch (error) {
        if (error instanceof DeviceProofError) {
          throw new AppError('DEVICE_PROOF_INVALID', undefined, { cause: error });
        }
        throw error;
      }
    }

    const { appKey, deviceIdentifier } = input;
    if (!appKey || !deviceIdentifier) throw new AppError('DEVICE_PROOF_INVALID');

    let canonicalKey: string;
    try {
      canonicalKey = parseAppPublicKey(appKey.publicKey).canonical;
    } catch (error) {
      if (error instanceof DeviceProofError) {
        throw new AppError('DEVICE_PROOF_INVALID', error.message, { cause: error });
      }
      throw error;
    }
    const message = registrationProofMessage({
      challenge: challengeText,
      employeeId: identity.id,
      platform: input.platform,
      deviceIdentifier,
    });
    if (!verifyAppSignature(canonicalKey, message, appKey.signature)) {
      throw new AppError('DEVICE_PROOF_INVALID');
    }

    const attested = await this.deps.attestation.verifyNative(
      { platform: input.platform, publicKey: canonicalKey, challenge: challengeText },
      now,
    );
    return {
      identifier: hashedIdentifier('app', deviceIdentifier),
      publicKey: canonicalKey,
      credentialId: null,
      counter: null,
      provider: attested.provider,
      attestedAt: attested.verifiedAt,
      facts: {},
    };
  }

  private async assertRoomForAnotherDevice(
    q: Queryable,
    employeeId: string,
    now: Date,
  ): Promise<void> {
    const office = await loadActiveOffice(q);
    const policy = await loadPolicyAt(q, now, office?.timezone ?? 'UTC');
    const { rows } = await q.query<{ n: number }>(
      `select count(*)::int as n from public.registered_devices
       where employee_id = $1 and status <> 'REVOKED'`,
      [employeeId],
    );
    const max = policy.maxDevicesPerEmployee;
    if ((rows[0]?.n ?? 0) >= max) {
      throw new AppError(
        'DEVICE_LIMIT_REACHED',
        `You can have up to ${max} registered device${max === 1 ? '' : 's'}. Remove one before adding another.`,
      );
    }
  }

  // ---------------------------------------------------------------------------------------
  // An employee's own devices
  // ---------------------------------------------------------------------------------------

  async listMine(employeeId: string): Promise<DeviceDto[]> {
    const { rows } = await this.deps.db.query<DeviceRow>(
      `select ${DEVICE_COLUMNS} from public.registered_devices d
       where d.employee_id = $1
       order by (d.status = 'REVOKED'), d.registered_at desc`,
      [employeeId],
    );
    return rows.map(toDeviceDto);
  }

  /** People may always remove their own devices (a lost phone must not stay trusted). */
  async removeMine(identity: Identity, deviceId: string, meta: RequestMeta): Promise<DeviceDto> {
    const actor: Actor = { id: identity.id, role: identity.role };
    const row = await this.revokeInternal(deviceId, actor, 'Removed by the employee.', meta, {
      ownedBy: identity.id,
    });
    return toDeviceDto(row);
  }

  /** A one-time challenge for proving a registered device during a check-in or check-out. */
  async issueVerificationChallenge(
    identity: Identity,
    input: { deviceId: string; purpose: VerificationPurpose },
  ): Promise<ChallengeResponse> {
    const { db, clock, webauthn } = this.deps;
    const now = clock.now();

    const { rows } = await db.query<DeviceRow>(
      `select ${DEVICE_COLUMNS} from public.registered_devices d
       where d.id = $1 and d.employee_id = $2 and d.status <> 'REVOKED'`,
      [input.deviceId, identity.id],
    );
    const device = rows[0];
    if (!device) throw new AppError('NOT_FOUND', 'That device is not registered to your account.');

    const challenge = await issueChallenge(db, {
      userId: identity.id,
      purpose: input.purpose,
      deviceId: device.id,
      now,
      ttlSeconds: VERIFY_CHALLENGE_TTL_SECONDS,
    });
    const response: ChallengeResponse = {
      challengeId: challenge.id,
      challenge: challenge.bytes.toString('base64url'),
      expiresAt: challenge.expiresAt.toISOString(),
    };
    if (device.platform === 'WEB' && device.credential_id) {
      response.webauthn = await webauthn.authenticationOptions({
        credentialId: device.credential_id,
        challenge: challenge.bytes,
      });
    }
    return response;
  }

  // ---------------------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------------------

  async adminList(query: AdminDevicesQuery): Promise<Paginated<AdminDeviceDto>> {
    const { db } = this.deps;
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.employeeId) conditions.push(`d.employee_id = ${bind(query.employeeId)}::uuid`);
    if (query.status) conditions.push(`d.status = ${bind(query.status)}::public.device_status`);
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

    const count = await db.query<{ total: string }>(
      `select count(*)::text as total from public.registered_devices d ${where}`,
      params,
    );
    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await db.query<AdminDeviceRow>(
      `select ${DEVICE_COLUMNS}, p.full_name, p.employee_code
       from public.registered_devices d
       join public.profiles p on p.id = d.employee_id
       ${where}
       order by (d.status = 'PENDING') desc, d.registered_at desc, d.id
       limit ${limit}::int offset ${offset}::int`,
      params,
    );
    return {
      items: rows.map(toAdminDeviceDto),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async approve(actor: Actor, deviceId: string, meta: RequestMeta): Promise<AdminDeviceDto> {
    const { db, clock } = this.deps;
    const now = clock.now();

    await db.withTransaction(async (tx) => {
      const current = await tx.query<{ status: DeviceStatus; employee_id: string }>(
        'select status::text as status, employee_id from public.registered_devices where id = $1 for update',
        [deviceId],
      );
      const device = current.rows[0];
      if (!device) throw new AppError('NOT_FOUND', 'That device does not exist.');
      if (device.status !== 'PENDING') {
        throw new AppError(
          'CONFLICT',
          device.status === 'ACTIVE'
            ? 'This device is already approved.'
            : 'A removed device cannot be approved. Ask the employee to register it again.',
        );
      }
      await tx.query(
        `update public.registered_devices
         set status = 'ACTIVE', approved_by = $2, approved_at = $3::timestamptz
         where id = $1`,
        [deviceId, actor.id, now],
      );
      await writeAudit(tx, {
        action: 'device.approve',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'device',
        entityId: deviceId,
        before: { status: 'PENDING' },
        after: { status: 'ACTIVE' },
        metadata: { employee_id: device.employee_id },
        ...meta,
        at: now,
      });
    });
    return this.getForAdmin(deviceId);
  }

  async revoke(
    actor: Actor,
    deviceId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminDeviceDto> {
    await this.revokeInternal(deviceId, actor, reason, meta, {});
    return this.getForAdmin(deviceId);
  }

  private async revokeInternal(
    deviceId: string,
    actor: Actor,
    reason: string,
    meta: RequestMeta,
    scope: { ownedBy?: string },
  ): Promise<DeviceRow> {
    const { db, clock } = this.deps;
    const now = clock.now();

    return db.withTransaction(async (tx) => {
      const current = await tx.query<{ status: DeviceStatus; employee_id: string }>(
        `select status::text as status, employee_id from public.registered_devices
         where id = $1 and ($2::uuid is null or employee_id = $2::uuid)
         for update`,
        [deviceId, scope.ownedBy ?? null],
      );
      const device = current.rows[0];
      // Somebody else's device is indistinguishable from one that does not exist.
      if (!device) throw new AppError('NOT_FOUND', 'That device does not exist.');
      if (device.status === 'REVOKED') {
        throw new AppError('CONFLICT', 'This device has already been removed.');
      }
      const updated = await tx.query<DeviceRow>(
        `update public.registered_devices as d
         set status = 'REVOKED', revoked_at = $2::timestamptz, revoked_by = $3, revoked_reason = $4
         where d.id = $1
         returning ${DEVICE_COLUMNS}`,
        [deviceId, now, actor.id, reason],
      );
      // Anything it was about to prove is void.
      await retireDeviceChallenges(tx, deviceId, now);
      await writeAudit(tx, {
        action: 'device.revoke',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'device',
        entityId: deviceId,
        before: { status: device.status },
        after: { status: 'REVOKED' },
        metadata: { employee_id: device.employee_id, reason },
        ...meta,
        at: now,
      });
      return updated.rows[0]!;
    });
  }

  private async getForAdmin(deviceId: string): Promise<AdminDeviceDto> {
    const { rows } = await this.deps.db.query<AdminDeviceRow>(
      `select ${DEVICE_COLUMNS}, p.full_name, p.employee_code
       from public.registered_devices d
       join public.profiles p on p.id = d.employee_id
       where d.id = $1`,
      [deviceId],
    );
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'That device does not exist.');
    return toAdminDeviceDto(row);
  }
}

interface AdminDeviceRow extends DeviceRow {
  full_name: string;
  employee_code: string;
}

function toAdminDeviceDto(row: AdminDeviceRow): AdminDeviceDto {
  return {
    ...toDeviceDto(row),
    employee: { id: row.employee_id, fullName: row.full_name, employeeCode: row.employee_code },
    revokedReason: row.revoked_reason,
  };
}
