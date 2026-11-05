import {
  formatReason,
  type QrCheckFailureDetails,
  type QrCheckResponse,
  type QrCurrentResponse,
  type QrWindowDto,
  type VerificationReasonDto,
} from '@teachgrow/shared';
import type { Db, Queryable } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { requireActiveOffice, type OfficeRow } from '../office/repository.js';
import { checkQrPayload, currentQr, type QrWindow } from './qr.js';

/**
 * Layer 3 with persistence: the lobby display, the pre-check, and the helpers the verification
 * engine runs inside its own transaction.
 *
 * Scan outcomes recorded in `qr_scan_events`:
 *   ACCEPTED  genuine, in time, first use by this employee, and the whole verification succeeded
 *   VALID     genuine and in time, but the verification failed elsewhere (not consumed)
 *   EXPIRED   genuine but too old
 *   UNKNOWN   not a code this office issued (malformed, forged, wrong office, or not yet valid)
 *   REPLAYED  genuine, but this employee already consumed it
 *
 * Single use is PER EMPLOYEE (decision D1): one displayed code serves everyone arriving at once,
 * but nobody can use the same code twice. The database enforces it with a unique index.
 */

export type ScanOutcome = 'ACCEPTED' | 'VALID' | 'EXPIRED' | 'UNKNOWN' | 'REPLAYED';

export interface QrEvaluation {
  result: 'PASS' | 'FAIL';
  reasons: VerificationReasonDto[];
  /** Set whenever the code was authentic, even if expired or replayed. */
  tokenId: string | null;
  /** The code's window; set whenever the code was authentic. */
  window: QrWindow | null;
  /** What to record if nothing else changes the story. */
  outcome: Exclude<ScanOutcome, 'ACCEPTED'>;
  /** False when no code was supplied at all: there is nothing to record. */
  scanned: boolean;
}

export interface QrServiceDeps {
  db: Db;
  clock: Clock;
  /** QR_SIGNING_SECRET */
  secret: string;
}

const windowDto = (w: QrWindow): QrWindowDto => ({
  index: w.index,
  validFrom: w.validFrom.toISOString(),
  expiresAt: w.expiresAt.toISOString(),
  acceptUntil: w.acceptUntil.toISOString(),
});

export class QrService {
  constructor(private readonly deps: QrServiceDeps) {}

  private qrOffice(office: OfficeRow) {
    return { id: office.id, rotationSeconds: office.qrRotationSeconds };
  }

  /** What the lobby screen shows right now (and the next code, in case a request is late). */
  async current(): Promise<QrCurrentResponse> {
    const { db, clock, secret } = this.deps;
    const now = clock.now();
    const office = await requireActiveOffice(db);
    const display = currentQr(secret, this.qrOffice(office), now);
    return {
      payload: display.payload,
      window: windowDto(display.window),
      next: { payload: display.next.payload, window: windowDto(display.next.window) },
      rotationSeconds: office.qrRotationSeconds,
      serverTime: now.toISOString(),
    };
  }

  /**
   * Judge a scanned payload for one employee. Reads and (for authentic codes) upserts the token
   * row, but does NOT record a scan or consume anything: the caller decides the final outcome.
   */
  async evaluate(
    tx: Queryable,
    office: OfficeRow,
    employeeId: string,
    payload: string | undefined,
    now: Date,
  ): Promise<QrEvaluation> {
    if (payload === undefined) {
      return {
        result: 'FAIL',
        reasons: [formatReason('QR_MISSING')],
        tokenId: null,
        window: null,
        outcome: 'UNKNOWN',
        scanned: false,
      };
    }

    const check = checkQrPayload(this.deps.secret, this.qrOffice(office), payload, now);
    if (check.status === 'INVALID') {
      return {
        result: 'FAIL',
        reasons: [formatReason('QR_INVALID')],
        tokenId: null,
        window: null,
        outcome: 'UNKNOWN',
        scanned: true,
      };
    }

    // Only the SHA-256 of the code is stored; the code itself is recomputable, never kept.
    const upserted = await tx.query<{ id: string }>(
      `insert into public.qr_tokens (office_id, token_hash, valid_from, expires_at, accept_until)
       values ($1, decode($2, 'hex'), $3::timestamptz, $4::timestamptz, $5::timestamptz)
       on conflict (token_hash) do update set token_hash = excluded.token_hash
       returning id`,
      [
        office.id,
        check.codeHash.toString('hex'),
        check.window.validFrom,
        check.window.expiresAt,
        check.window.acceptUntil,
      ],
    );
    const tokenId = upserted.rows[0]!.id;

    if (check.status === 'EXPIRED') {
      return {
        result: 'FAIL',
        reasons: [formatReason('QR_EXPIRED')],
        tokenId,
        window: check.window,
        outcome: 'EXPIRED',
        scanned: true,
      };
    }

    const used = await tx.query(
      `select 1 from public.qr_scan_events
       where qr_token_id = $1 and employee_id = $2 and outcome = 'ACCEPTED'
       limit 1`,
      [tokenId, employeeId],
    );
    if (used.rows.length > 0) {
      return {
        result: 'FAIL',
        reasons: [formatReason('QR_REPLAYED')],
        tokenId,
        window: check.window,
        outcome: 'REPLAYED',
        scanned: true,
      };
    }

    return {
      result: 'PASS',
      reasons: [],
      tokenId,
      window: check.window,
      outcome: 'VALID',
      scanned: true,
    };
  }

  async recordScan(
    tx: Queryable,
    scan: {
      tokenId: string | null;
      employeeId: string;
      deviceId: string | null;
      verificationId: string | null;
      outcome: ScanOutcome;
      ip: string | null;
      now: Date;
    },
  ): Promise<void> {
    await tx.query(
      `insert into public.qr_scan_events
         (qr_token_id, employee_id, device_id, verification_id, outcome, client_ip, scanned_at)
       values ($1, $2, $3, $4, $5, $6::inet, $7::timestamptz)`,
      [
        scan.tokenId,
        scan.employeeId,
        scan.deviceId,
        scan.verificationId,
        scan.outcome,
        scan.ip,
        scan.now,
      ],
    );
  }

  /**
   * "Is this code any good?" - for instant feedback right after scanning, before the person is
   * asked to share a location. Never consumes the code.
   */
  async precheck(employeeId: string, payload: string, ip: string | null): Promise<QrCheckResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();

    const evaluation = await db.withTransaction(async (tx) => {
      const office = await requireActiveOffice(tx);
      const result = await this.evaluate(tx, office, employeeId, payload, now);
      await this.recordScan(tx, {
        tokenId: result.tokenId,
        employeeId,
        deviceId: null,
        verificationId: null,
        outcome: result.outcome,
        ip,
        now,
      });
      return result;
    });

    if (evaluation.result === 'FAIL' || !evaluation.window) {
      const details: QrCheckFailureDetails = { reasons: evaluation.reasons };
      throw new AppError(
        'VERIFICATION_FAILED',
        evaluation.reasons.map((r) => r.message).join(' '),
        { details },
      );
    }
    return { valid: true, acceptUntil: evaluation.window.acceptUntil.toISOString() };
  }
}
