import {
  ERROR_MESSAGES,
  isErrorCode,
  type DailyQrIssued,
  type DailyQrVerified,
  type DailyQrVerifyRequest,
  type DailyQrProgress,
  type DailyQrToday,
  type ScanAction,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import type { Identity } from '../auth/identity.js';
import type { Db } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { RequestMeta } from '../lib/request-meta.js';
import { loadPolicyAt, requireActiveOffice } from '../office/repository.js';
import type { VerificationService } from '../verification/service.js';
import { newDailyPayload } from './token.js';

/**
 * The employee's side of QR attendance: find out what a code would be for, generate one, and
 * watch whether the scanner has used it.
 *
 * Proving presence (GPS inside the geofence, the office network) is an ordinary verification, made
 * by `verify` below under the policy's `daily_qr_layers`; `generate` SPENDS that proof to mint the
 * code. Administrators are exempt from the location and network check, everywhere, so they
 * generate without one.
 */

export interface DailyQrServiceDeps {
  db: Db;
  clock: Clock;
  verification: VerificationService;
}

interface StateJson {
  workDate: string;
  action: 'CHECK_IN' | 'CHECK_OUT' | 'ALREADY_CHECKED_OUT' | 'BLOCKED';
  blockedReason: string | null;
  record: {
    status: DailyQrToday['attendance']['status'];
    liveState: DailyQrToday['attendance']['liveState'];
    checkInAt: string | null;
    checkOutAt: string | null;
    isLate: boolean;
  } | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value ? iso(value) : null;

/** Administrators are never asked where they are. */
export const needsOfficeProof = (identity: Identity): boolean => identity.role !== 'admin';

/** Why nothing can be generated, in the employee's own words. */
function blockedMessage(code: string): string {
  // The engine's wording for this one is about checking in; here it means the day is stuck open.
  if (code === 'ALREADY_CHECKED_IN') {
    return 'Your day was closed without a check-out. An administrator has to correct it.';
  }
  return isErrorCode(code) ? ERROR_MESSAGES[code] : 'Attendance cannot be recorded right now.';
}

export class DailyQrService {
  constructor(private readonly deps: DailyQrServiceDeps) {}

  /** What a code generated right now would be for, and the state of today's codes. */
  async today(identity: Identity): Promise<DailyQrToday> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const office = await requireActiveOffice(db);
    const policy = await loadPolicyAt(db, now, office.timezone);

    const state = (
      await db.query<{ state: StateJson }>(
        'select private.qr_attendance_state($1::uuid, $2::timestamptz) as state',
        [identity.id, now],
      )
    ).rows[0]!.state;

    const day = (
      await db.query<{ d: string }>('select private.local_date($1::timestamptz, $2)::text as d', [
        now,
        office.timezone,
      ])
    ).rows[0]!.d;

    const live = (
      await db.query<{ action: ScanAction; expires_at: Date | string }>(
        `select action, expires_at from public.attendance_qr_tokens
         where employee_id = $1 and status = 'ACTIVE' and expires_at > $2::timestamptz`,
        [identity.id, now],
      )
    ).rows[0];

    const generated = (
      await db.query<{ n: string }>(
        `select count(*)::text as n from public.attendance_qr_tokens
         where employee_id = $1 and work_date = $2::date`,
        [identity.id, day],
      )
    ).rows[0]!.n;

    const reason = state.blockedReason;
    return {
      workDate: day,
      next: reason ? 'BLOCKED' : state.action === 'BLOCKED' ? 'BLOCKED' : state.action,
      blockedReason: reason ? { code: reason, message: blockedMessage(reason) } : null,
      verificationRequired: needsOfficeProof(identity),
      live: live ? { expiresAt: iso(live.expires_at), action: live.action } : null,
      generatedToday: Number(generated),
      maxPerDay: policy.dailyQrMaxPerDay,
      ttlSeconds: policy.dailyQrTtlSeconds,
      attendance: {
        status: state.record?.status ?? null,
        liveState: state.record?.liveState ?? 'NONE',
        checkInAt: state.record?.checkInAt ?? null,
        checkOutAt: state.record?.checkOutAt ?? null,
        isLate: state.record?.isLate ?? false,
      },
    };
  }

  /**
   * The employee proves they are at the office. What the code will be for is decided here, from the
   * attendance engine's own state, and the evidence is stored as an ordinary verification.
   */
  async verify(
    identity: Identity,
    body: DailyQrVerifyRequest,
    ip: string | null,
    meta: RequestMeta,
  ): Promise<DailyQrVerified> {
    const { db, clock, verification } = this.deps;
    if (!needsOfficeProof(identity)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Administrators are not asked to verify their location.',
      );
    }
    const state = (
      await db.query<{ state: StateJson }>(
        'select private.qr_attendance_state($1::uuid, $2::timestamptz) as state',
        [identity.id, clock.now()],
      )
    ).rows[0]!.state;
    // Nothing to generate today: say so before writing any evidence.
    const refusal =
      state.blockedReason ?? (state.action === 'ALREADY_CHECKED_OUT' ? state.action : null);
    if (refusal) {
      throw new AppError(isErrorCode(refusal) ? refusal : 'INTERNAL', blockedMessage(refusal));
    }
    if (state.action !== 'CHECK_IN' && state.action !== 'CHECK_OUT') throw new AppError('INTERNAL');

    const outcome = await verification.verify({
      identity,
      request: { purpose: state.action, channel: 'WEB', gps: body.gps },
      mode: 'daily_qr',
      ip,
      meta,
    });
    if (!outcome.verified) {
      throw new AppError(
        'VERIFICATION_FAILED',
        outcome.details.reasons.map((r) => r.message).join(' '),
        {
          details: outcome.details,
        },
      );
    }
    return { ...outcome.response, action: state.action };
  }

  /** Spends the employee's passed verification and issues a code. The code text is returned once. */
  async generate(
    identity: Identity,
    verificationId: string | undefined,
    meta: RequestMeta,
  ): Promise<DailyQrIssued> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const { payload, hash } = newDailyPayload();

    return db.withTransaction(async (tx) => {
      // One generation at a time per person: two requests cannot both spend the same proof.
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `daily-qr:${identity.id}`,
      ]);
      const { rows } = await tx.query<{
        r: {
          id: string;
          action: ScanAction;
          workDate: string;
          issuedAt: string;
          expiresAt: string;
          generatedToday: number;
          maxPerDay: number;
        };
      }>('select private.issue_daily_qr($1::uuid, $2::uuid, $3::bytea, $4::timestamptz) as r', [
        identity.id,
        needsOfficeProof(identity) ? (verificationId ?? null) : null,
        hash,
        now,
      ]);
      const issued = rows[0]!.r;

      // The audit entry names the code by id and never contains it.
      await writeAudit(tx, {
        action: 'daily_qr.generated',
        actorId: identity.id,
        actorRole: identity.role,
        entityType: 'attendance_qr_token',
        entityId: issued.id,
        metadata: {
          action: issued.action,
          work_date: issued.workDate,
          generated_today: issued.generatedToday,
          verification_waived: !needsOfficeProof(identity),
        },
        ...meta,
        at: now,
      });

      return {
        id: issued.id,
        payload,
        action: issued.action,
        workDate: issued.workDate,
        issuedAt: iso(issued.issuedAt),
        expiresAt: iso(issued.expiresAt),
        generatedToday: issued.generatedToday,
        maxPerDay: issued.maxPerDay,
      };
    });
  }

  /** Has the owner's code been scanned yet? Only the owner can ask. */
  async progress(identity: Identity, id: string): Promise<DailyQrProgress> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const { rows } = await db.query<{
      id: string;
      status: 'ACTIVE' | 'USED' | 'SUPERSEDED';
      action: ScanAction;
      expires_at: Date | string;
      used_at: Date | string | null;
    }>(
      `select id, status, action, expires_at, used_at from public.attendance_qr_tokens
       where id = $1 and employee_id = $2`,
      [id, identity.id],
    );
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'That QR code was not found.');
    return {
      id: row.id,
      status: row.status === 'ACTIVE' && new Date(row.expires_at) <= now ? 'EXPIRED' : row.status,
      action: row.action,
      expiresAt: iso(row.expires_at),
      usedAt: isoOrNull(row.used_at),
    };
  }
}
