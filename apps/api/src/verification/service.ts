import {
  MANDATORY_CHECK_IN_LAYERS,
  VERIFICATION_LAYERS,
  type LayerResult,
  type VerificationLayer,
  type VerificationLayers,
  type VerificationReasonDto,
  type VerificationRequest,
  type VerifyFailureDetails,
  type VerifyResponse,
} from '@teachgrow/shared';
import type { Identity } from '../auth/identity.js';
import type { Db, Queryable } from '../db/pool.js';
import { evaluateDevice, type DeviceEvaluation } from '../devices/verify.js';
import type { WebAuthnVerifier } from '../devices/webauthn.js';
import type { Clock } from '../lib/clock.js';
import type { RequestMeta } from '../lib/request-meta.js';
import {
  loadPolicyAt,
  requireActiveOffice,
  type OfficeRow,
  type PolicyRow,
} from '../office/repository.js';
import { evaluateGps, type GpsEvaluation } from './gps.js';
import { evaluateNetwork, type NetworkEvaluation } from './network.js';
import type { QrEvaluation, QrService } from './qr-service.js';

/**
 * The one place that decides whether somebody is physically at the office.
 *
 * The client sends EVIDENCE (a location fix, the scanned code, a device proof). This module turns
 * it into a verdict using only things the server knows: its own clock, the office configuration,
 * the address the request really came from, its own record of which codes it issued and which
 * devices it approved. The result is written to `attendance_verifications`, and the check-in /
 * check-out functions in the database accept nothing else.
 *
 * Every layer is evaluated, so a person who fails two layers is told about both at once instead of
 * discovering them one retry at a time.
 */

export interface VerificationServiceDeps {
  db: Db;
  clock: Clock;
  qr: QrService;
  webauthn: WebAuthnVerifier;
}

export interface VerifyInput {
  /**
   * Whose presence is being proved. For CHECK_IN / CHECK_OUT an employee whose attendance is
   * tracked; for ADMIN_SCAN the administrator or operator holding the QR scanner. The route
   * guarantees whichever applies.
   */
  identity: Identity;
  request: VerificationRequest;
  /**
   * Which set of layers applies. 'daily_qr' is the proof an employee makes before generating an
   * attendance QR code (policy.dailyQrLayers); the default is the ordinary check-in / check-out policy.
   */
  mode?: 'standard' | 'daily_qr';
  /** The caller's address as Express resolved it (`req.ip`), already normalised. */
  ip: string | null;
  meta: RequestMeta;
}

export type VerifyOutcome =
  { verified: true; response: VerifyResponse } | { verified: false; details: VerifyFailureDetails };

/** GPS and the office network are never optional, for check-in or check-out (decision D3). */
const ALWAYS_REQUIRED: readonly VerificationLayer[] = MANDATORY_CHECK_IN_LAYERS;

export function requiredLayers(
  policy: PolicyRow,
  purpose: VerificationRequest['purpose'],
  channel: VerificationRequest['channel'],
  mode: 'standard' | 'daily_qr' = 'standard',
): Set<VerificationLayer> {
  const configured =
    mode === 'daily_qr'
      ? policy.dailyQrLayers
      : purpose === 'ADMIN_SCAN'
        ? policy.adminScanLayers
        : purpose === 'CHECK_OUT'
          ? policy.checkOutLayers
          : channel === 'WEB'
            ? policy.checkInLayersWeb
            : policy.checkInLayersMobile;
  return new Set<VerificationLayer>([...configured, ...ALWAYS_REQUIRED]);
}

interface LayerReport {
  result: LayerResult;
  reasons: VerificationReasonDto[];
}

const notRequired: LayerReport = { result: 'NOT_REQUIRED', reasons: [] };

const roundTo = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export class VerificationService {
  constructor(private readonly deps: VerificationServiceDeps) {}

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    const { db, clock } = this.deps;
    const now = clock.now();

    // Everything below commits together - including a REJECTED verdict, which is recorded evidence
    // and which spends whatever it consumed (a challenge, a passkey counter).
    return db.withTransaction(async (tx) => {
      // One verification at a time per person: two requests cannot both spend the same QR code or
      // the same device challenge.
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `verify:${input.identity.id}`,
      ]);

      const office = await requireActiveOffice(tx);
      const policy = await loadPolicyAt(tx, now, office.timezone);
      return this.decide(tx, input, office, policy, now);
    });
  }

  private async decide(
    tx: Queryable,
    input: VerifyInput,
    office: OfficeRow,
    policy: PolicyRow,
    now: Date,
  ): Promise<VerifyOutcome> {
    const { qr, webauthn } = this.deps;
    const { identity, request, ip, meta } = input;
    const required = requiredLayers(policy, request.purpose, request.channel, input.mode);

    // ---- the four layers ---------------------------------------------------------------------
    let gps: GpsEvaluation | null = null;
    if (required.has('GPS')) {
      gps = evaluateGps(
        request.gps,
        {
          latitude: office.latitude,
          longitude: office.longitude,
          radiusM: office.geofenceRadiusM,
          maxAccuracyM: office.maxGpsAccuracyM,
          maxFixAgeSeconds: office.maxFixAgeSeconds,
        },
        now,
      );
    }

    let network: NetworkEvaluation | null = null;
    if (required.has('NETWORK')) network = await evaluateNetwork(tx, office.id, ip);

    let qrCheck: QrEvaluation | null = null;
    if (required.has('QR')) {
      qrCheck = await qr.evaluate(tx, office, identity.id, request.qr?.payload, now);
    }

    let device: DeviceEvaluation | null = null;
    if (required.has('DEVICE')) {
      device = await evaluateDevice(tx, webauthn, {
        employeeId: identity.id,
        channel: request.channel,
        purpose: request.purpose,
        evidence: request.device,
        now,
        meta,
      });
    }

    const reports: Record<VerificationLayer, LayerReport> = {
      GPS: gps ?? notRequired,
      NETWORK: network ?? notRequired,
      QR: qrCheck ?? notRequired,
      DEVICE: device ?? notRequired,
    };
    const layers = Object.fromEntries(
      VERIFICATION_LAYERS.map((layer) => [layer, reports[layer].result]),
    ) as VerificationLayers;
    const reasons = VERIFICATION_LAYERS.flatMap((layer) => reports[layer].reasons);
    const verified = reasons.length === 0 && VERIFICATION_LAYERS.every((l) => layers[l] !== 'FAIL');

    // ---- the record --------------------------------------------------------------------------
    const expiresAt = verified
      ? new Date(now.getTime() + policy.verificationTtlSeconds * 1000)
      : null;
    const fix = request.gps;
    const inserted = await tx.query<{ id: string }>(
      `insert into public.attendance_verifications
         (employee_id, purpose, channel, device_id,
          gps_result, network_result, qr_result, device_result, final_result, failure_reasons,
          distance_m, gps_accuracy_m, latitude, longitude, fix_time, location_mocked,
          client_ip, matched_network_id, qr_token_id, requested_at, expires_at)
       values
         ($1, $2::public.verification_purpose, $3::public.client_channel, $4,
          $5::public.verification_layer_result, $6::public.verification_layer_result,
          $7::public.verification_layer_result, $8::public.verification_layer_result,
          $9::public.verification_result, $10::text[],
          $11, $12, $13, $14, $15::timestamptz, $16,
          $17::inet, $18, $19, $20::timestamptz, $21::timestamptz)
       returning id`,
      [
        identity.id,
        request.purpose,
        request.channel,
        device?.deviceId ?? null,
        layers.GPS,
        layers.NETWORK,
        layers.QR,
        layers.DEVICE,
        verified ? 'VERIFIED' : 'REJECTED',
        reasons.map((r) => r.code),
        gps?.distanceM == null ? null : roundTo(gps.distanceM, 2),
        gps?.accuracyM == null ? null : roundTo(gps.accuracyM, 2),
        // The raw fix is kept only when it was usable; the retention job nulls it after 90 days.
        gps?.distanceM == null || !fix ? null : fix.latitude,
        gps?.distanceM == null || !fix ? null : fix.longitude,
        gps?.fixTime ?? null,
        gps?.distanceM == null ? null : (fix?.mocked ?? null),
        ip,
        network?.matched?.id ?? null,
        qrCheck?.tokenId ?? null,
        now,
        expiresAt,
      ],
    );
    const verificationId = inserted.rows[0]!.id;

    // A scan is only SPENT when the whole verification succeeded; otherwise the code stays usable
    // for another try within its window.
    if (qrCheck?.scanned) {
      await qr.recordScan(tx, {
        tokenId: qrCheck.tokenId,
        employeeId: identity.id,
        deviceId: device?.deviceId ?? null,
        verificationId,
        outcome: verified && qrCheck.result === 'PASS' ? 'ACCEPTED' : qrCheck.outcome,
        ip,
        now,
      });
    }

    const summary = {
      distanceMeters: gps?.distanceM == null ? null : Math.round(gps.distanceM),
      accuracyMeters: gps?.accuracyM == null ? null : Math.round(gps.accuracyM),
    };

    if (verified && expiresAt) {
      return {
        verified: true,
        response: {
          result: 'VERIFIED',
          verificationId,
          expiresAt: expiresAt.toISOString(),
          layers,
          gps: summary,
        },
      };
    }
    return {
      verified: false,
      details: { result: 'REJECTED', verificationId, layers, reasons, gps: summary },
    };
  }
}
