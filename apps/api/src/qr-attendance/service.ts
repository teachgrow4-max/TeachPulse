import {
  QR_PAYLOAD_PREFIX,
  SCAN_REASON_MESSAGES,
  VERIFICATION_LAYERS,
  isScanReasonCode,
  type AttendanceStatus,
  type ConfirmScanRequest,
  type ConfirmScanResponse,
  type DetectedAction,
  type LiveState,
  type ListScansQuery,
  type Paginated,
  type QrResult,
  type RoleName,
  type ScanDisplayStatus,
  type ScanLogDto,
  type ScanReasonCode,
  type ScanRejectionDetails,
  type ScanRequest,
  type ScanResolution,
  type ScanTodayDto,
  type ScanVerifyBody,
  type VerifyResponse,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import { loadIdentityById, type Identity } from '../auth/identity.js';
import { withIdempotency, type Idempotent } from '../attendance/idempotency.js';
import type { Db, Queryable } from '../db/pool.js';
import type { EmployeeQrService } from '../employee-qr/service.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { RequestMeta } from '../lib/request-meta.js';
import { loadPolicyAt, requireActiveOffice } from '../office/repository.js';
import { requiredLayers, type VerificationService } from '../verification/service.js';

/**
 * The administrator-operated scanner: what an operator can do with an employee's QR code.
 *
 *   scan     read a code. Logs the scan, says who it belongs to and what would happen
 *            (check in, check out, nothing to do). Changes no attendance.
 *   verify   the operator proves THEY are at the office (the same location / network / device
 *            layers as a check-in, under the policy's admin-scan setting).
 *   confirm  the operator confirms what the scan showed. Records the attendance through the
 *            same engine as an employee's own check-in, marked ADMIN_QR.
 *
 * Nothing toggles by itself: scanning the same code twice never changes attendance twice, because
 * only `confirm` does, once per scan, and only for the action the scan showed.
 */

export const CONFIRM_ENDPOINT = 'POST /api/qr-attendance/scans/:id/confirm';

export interface QrAttendanceServiceDeps {
  db: Db;
  clock: Clock;
  qr: EmployeeQrService;
  verification: VerificationService;
}

/** What `private.qr_attendance_state` answers. */
interface AttendanceState {
  workDate: string;
  action: 'CHECK_IN' | 'CHECK_OUT' | 'ALREADY_CHECKED_OUT' | 'BLOCKED';
  blockedReason: string | null;
  record: {
    id: string;
    workDate: string;
    status: AttendanceStatus;
    liveState: LiveState;
    isLate: boolean;
    checkInAt: string | null;
    checkOutAt: string | null;
  } | null;
}

type ScanOutcome = { resolution: ScanResolution } | { rejected: AppError };

interface LogInput {
  scannedBy: string;
  scannedAt: Date;
  scanner: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
  employeeId: string | null;
  codeId: string | null;
  hash: Uint8Array | null;
  qrResult: QrResult;
  detected: DetectedAction;
  reason: string | null;
  status: 'PENDING' | 'NO_ACTION' | 'REJECTED';
  expiresAt: Date | null;
}

interface ScanRow {
  id: string;
  status: string;
  detected_action: string;
  expires_at: Date | string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value ? iso(value) : null;

/** The device in the operator's hands, as far as anyone can tell. Informational only. */
function describeScanner(
  scanner: ScanRequest['scanner'],
  meta: RequestMeta,
): Record<string, unknown> {
  return {
    kind: scanner.kind,
    ...(scanner.label ? { label: scanner.label } : {}),
    ...(scanner.camera ? { camera: scanner.camera } : {}),
    ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 200) } : {}),
  };
}

export class QrAttendanceService {
  constructor(private readonly deps: QrAttendanceServiceDeps) {}

  // -----------------------------------------------------------------------------------------
  // 1. Scan
  // -----------------------------------------------------------------------------------------

  async scan(
    operator: Identity,
    input: ScanRequest,
    ip: string | null,
    meta: RequestMeta,
  ): Promise<ScanResolution> {
    const { db, clock } = this.deps;

    // A refused scan must still be written down, so the transaction commits and hands the refusal
    // back as a value; it is thrown only after the log row is safe.
    const outcome = await db.withTransaction((tx) =>
      this.resolve(tx, operator, input, ip, meta, clock.now()),
    );
    if ('rejected' in outcome) throw outcome.rejected;
    return outcome.resolution;
  }

  private async resolve(
    tx: Queryable,
    operator: Identity,
    input: ScanRequest,
    ip: string | null,
    meta: RequestMeta,
    now: Date,
  ): Promise<ScanOutcome> {
    const { qr } = this.deps;
    const base = {
      scannedBy: operator.id,
      scannedAt: now,
      scanner: describeScanner(input.scanner, meta),
      ip,
      requestId: meta.requestId,
    };

    const found = await qr.lookup(tx, input.payload);

    // ---- not a code we issued ----------------------------------------------------------------
    if (found.result === 'MALFORMED' || found.result === 'UNKNOWN') {
      const scanId = await this.insertLog(tx, {
        ...base,
        employeeId: null,
        codeId: null,
        hash: found.result === 'UNKNOWN' ? found.hash : null,
        qrResult: found.result,
        detected: 'REJECTED',
        reason: 'EMPLOYEE_QR_INVALID',
        status: 'REJECTED',
        expiresAt: null,
      });
      const lobbyCode = input.payload.startsWith(`${QR_PAYLOAD_PREFIX}.`);
      return {
        rejected: new AppError(
          'EMPLOYEE_QR_INVALID',
          lobbyCode
            ? 'That is the office QR code shown on the lobby screen, not an employee ID code.'
            : undefined,
          { details: { scanId } satisfies ScanRejectionDetails },
        ),
      };
    }

    // ---- a code we issued: whose is it? --------------------------------------------------------
    const code = found.code;
    const person = await loadIdentityById(tx, code.employee_id);
    if (!person) throw new AppError('NOT_FOUND', 'That employee was not found.');
    const who = { employeeCode: person.employeeCode, fullName: person.fullName };

    const refuse = async (
      qrResult: QrResult,
      error: ConstructorParameters<typeof AppError>[0],
    ): Promise<ScanOutcome> => {
      const scanId = await this.insertLog(tx, {
        ...base,
        employeeId: person.id,
        codeId: code.id,
        hash: found.hash,
        qrResult,
        detected: 'REJECTED',
        reason: error,
        status: 'REJECTED',
        expiresAt: null,
      });
      return {
        rejected: new AppError(error, undefined, {
          details: { scanId, employee: who } satisfies ScanRejectionDetails,
        }),
      };
    };

    // Nobody records their own attendance with the scanner: it checks fewer things than a check-in
    // may require, so scanning yourself would be a way round the stricter policy. The attempt is
    // kept on record, as a refusal.
    if (person.id === operator.id) {
      return refuse(found.result === 'REVOKED' ? 'REVOKED' : 'VALID', 'SELF_SCAN_FORBIDDEN');
    }
    if (found.result === 'REVOKED') return refuse('REVOKED', 'EMPLOYEE_QR_REVOKED');
    if (!person.isActive) return refuse('VALID', 'EMPLOYEE_INACTIVE');
    if (!person.attendanceRequired || person.role === 'office_display') {
      return refuse('VALID', 'ATTENDANCE_NOT_TRACKED');
    }

    // ---- valid and trackable: what would happen if the operator confirmed? ---------------------
    const office = await requireActiveOffice(tx);
    const policy = await loadPolicyAt(tx, now, office.timezone);
    const state = await this.stateOf(tx, person.id, now);

    let detected: Exclude<DetectedAction, 'REJECTED'>;
    let reason: ScanReasonCode | null = null;
    if (state.blockedReason && isScanReasonCode(state.blockedReason)) {
      detected = 'BLOCKED';
      reason = state.blockedReason;
    } else if (state.action === 'ALREADY_CHECKED_OUT') {
      detected = 'ALREADY_CHECKED_OUT';
      reason = 'ALREADY_CHECKED_OUT';
    } else if (state.action === 'CHECK_IN' || state.action === 'CHECK_OUT') {
      detected = state.action;
    } else {
      // The database said BLOCKED without a reason we know. Refuse rather than guess.
      throw new AppError('INTERNAL');
    }

    const pending = detected === 'CHECK_IN' || detected === 'CHECK_OUT';
    const expiresAt = pending
      ? new Date(now.getTime() + policy.verificationTtlSeconds * 1000)
      : null;
    const scanId = await this.insertLog(tx, {
      ...base,
      employeeId: person.id,
      codeId: code.id,
      hash: found.hash,
      qrResult: 'VALID',
      detected,
      reason,
      status: pending ? 'PENDING' : 'NO_ACTION',
      expiresAt,
    });

    const layers = requiredLayers(policy, 'ADMIN_SCAN', input.scanner.kind);
    return {
      resolution: {
        scanId,
        scannedAt: now.toISOString(),
        expiresAt: (expiresAt ?? now).toISOString(),
        employee: {
          id: person.id,
          employeeCode: person.employeeCode,
          fullName: person.fullName,
          avatarUrl: person.avatarUrl,
          department: person.department?.name ?? null,
          designation: person.designation,
          accountStatus: 'ACTIVE',
        },
        today: todayOf(state),
        action: detected,
        reason: reason ? { code: reason, message: SCAN_REASON_MESSAGES[reason] } : null,
        requiredLayers: VERIFICATION_LAYERS.filter((layer) => layers.has(layer)),
      },
    };
  }

  private async stateOf(tx: Queryable, employeeId: string, now: Date): Promise<AttendanceState> {
    const { rows } = await tx.query<{ state: AttendanceState }>(
      'select private.qr_attendance_state($1::uuid, $2::timestamptz) as state',
      [employeeId, now],
    );
    return rows[0]!.state;
  }

  private async insertLog(tx: Queryable, v: LogInput): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.qr_scan_logs
         (scanned_by, employee_id, qr_code_id, token_hash, qr_result, detected_action, reason_code,
          status, scanned_at, expires_at, scanner, client_ip, request_id)
       values
         ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb, $12::inet, $13)
       returning id`,
      [
        v.scannedBy,
        v.employeeId,
        v.codeId,
        v.hash,
        v.qrResult,
        v.detected,
        v.reason,
        v.status,
        v.scannedAt,
        v.expiresAt,
        JSON.stringify(v.scanner),
        v.ip,
        v.requestId,
      ],
    );
    return rows[0]!.id;
  }

  // -----------------------------------------------------------------------------------------
  // 2. The operator proves they are at the office
  // -----------------------------------------------------------------------------------------

  async verify(
    operator: Identity,
    scanId: string,
    body: ScanVerifyBody,
    ip: string | null,
    meta: RequestMeta,
  ): Promise<VerifyResponse> {
    const { db, clock, verification } = this.deps;
    await this.requirePending(db, operator.id, scanId, clock.now());

    const outcome = await verification.verify({
      identity: operator,
      request: {
        purpose: 'ADMIN_SCAN',
        channel: body.channel,
        gps: body.gps,
        qr: body.qr,
        device: body.device,
      },
      ip,
      meta,
    });

    // Remember the latest attempt on the scan, pass or fail, so history shows why a scan did not
    // end in attendance. (A scan that has meanwhile been recorded is left alone.)
    await db.query(
      `update public.qr_scan_logs
       set office_verification_id = $2, office_verification_result = $3
       where id = $1 and status = 'PENDING'`,
      [
        scanId,
        outcome.verified ? outcome.response.verificationId : outcome.details.verificationId,
        outcome.verified ? 'VERIFIED' : 'REJECTED',
      ],
    );

    if (!outcome.verified) {
      throw new AppError(
        'VERIFICATION_FAILED',
        outcome.details.reasons.map((r) => r.message).join(' '),
        { details: outcome.details },
      );
    }
    return outcome.response;
  }

  /** The scan must be this operator's, still waiting, and not out of time. */
  private async requirePending(
    q: Queryable,
    operatorId: string,
    scanId: string,
    now: Date,
  ): Promise<ScanRow> {
    const { rows } = await q.query<ScanRow>(
      `select id, status, detected_action, expires_at
       from public.qr_scan_logs where id = $1 and scanned_by = $2`,
      [scanId, operatorId],
    );
    const scan = rows[0];
    // Somebody else's scan looks exactly like one that does not exist.
    if (!scan) throw new AppError('NOT_FOUND', 'That scan was not found.');
    if (scan.status === 'RECORDED') throw new AppError('SCAN_ALREADY_RECORDED');
    if (scan.status !== 'PENDING') throw new AppError('SCAN_NOT_ACTIONABLE');
    if (!scan.expires_at || new Date(scan.expires_at) <= now) throw new AppError('SCAN_EXPIRED');
    return scan;
  }

  // -----------------------------------------------------------------------------------------
  // 3. Confirm
  // -----------------------------------------------------------------------------------------

  async confirm(
    operator: Identity,
    scanId: string,
    body: ConfirmScanRequest,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<Idempotent<ConfirmScanResponse>> {
    const { db, clock } = this.deps;
    const now = clock.now();

    // The key, the attendance, the scan's new state and the audit entry commit together or not at
    // all. A failed attempt leaves nothing behind - not even its key - so it can be retried.
    return db.withTransaction((tx) =>
      withIdempotency<ConfirmScanResponse>(
        tx,
        {
          employeeId: operator.id,
          key: idempotencyKey,
          endpoint: CONFIRM_ENDPOINT,
          request: { scanId, action: body.action },
          now,
        },
        async () => {
          const { rows } = await tx.query<{
            result: { scanId: string; eventId: number | string; recordId: string };
          }>('select private.admin_qr_record($1::uuid, $2::uuid, $3, $4::timestamptz) as result', [
            scanId,
            operator.id,
            body.action,
            now,
          ]);
          const recorded = rows[0]!.result;
          const response = await this.confirmationOf(tx, scanId);

          await writeAudit(tx, {
            action: 'qr_attendance.recorded',
            actorId: operator.id,
            actorRole: operator.role,
            entityType: 'attendance_event',
            entityId: String(recorded.eventId),
            metadata: {
              scan_id: scanId,
              action: body.action,
              employee_id: response.employee.id,
              source: 'ADMIN_QR',
            },
            ...meta,
            at: now,
          });
          return { status: 200, body: response };
        },
      ),
    );
  }

  private async confirmationOf(tx: Queryable, scanId: string): Promise<ConfirmScanResponse> {
    const { rows } = await tx.query<{
      confirmed_at: Date | string;
      confirmed_action: 'CHECK_IN' | 'CHECK_OUT';
      employee_id: string;
      employee_code: string;
      full_name: string;
      work_date: string;
      status: AttendanceStatus;
      is_late: boolean;
      live_state: LiveState;
      check_in_at: Date | string | null;
      check_out_at: Date | string | null;
      net_work_seconds: number | null;
    }>(
      `select l.confirmed_at, l.confirmed_action, p.id as employee_id, p.employee_code, p.full_name,
              r.work_date, r.status, r.is_late, r.live_state, r.check_in_at, r.check_out_at,
              r.net_work_seconds
       from public.qr_scan_logs l
       join public.attendance_records r on r.id = l.attendance_record_id
       join public.profiles p on p.id = l.employee_id
       where l.id = $1`,
      [scanId],
    );
    const row = rows[0]!;
    return {
      scanId,
      action: row.confirmed_action,
      recordedAt: iso(row.confirmed_at),
      source: 'ADMIN_QR',
      employee: { id: row.employee_id, employeeCode: row.employee_code, fullName: row.full_name },
      attendance: {
        workDate: row.work_date,
        status: row.status,
        isLate: row.is_late,
        liveState: row.live_state,
        checkInAt: isoOrNull(row.check_in_at),
        checkOutAt: isoOrNull(row.check_out_at),
        netWorkSeconds: row.net_work_seconds,
      },
    };
  }

  // -----------------------------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------------------------

  /** The operator's own latest scans (the "recent scans" list next to the camera). */
  async recent(operator: Identity, limit: number): Promise<ScanLogDto[]> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const { rows } = await db.query<LogRow>(
      `select ${LOG_COLUMNS} ${LOG_FROM}
       where l.scanned_by = $2::uuid
       order by l.scanned_at desc, l.id
       limit $3::int`,
      [now, operator.id, limit],
    );
    return rows.map((row) => toLogDto(row, false));
  }

  /** Everything scanned, for administrators: filter by date, employee, operator and outcome. */
  async history(query: ListScansQuery): Promise<Paginated<ScanLogDto>> {
    const { db, clock } = this.deps;
    const now = clock.now();
    // $1 is always "now" (it tells an expired pending scan from a live one). The condition keeps the
    // placeholder in the count query too, where nothing else would mention it.
    const conditions: string[] = ['$1::timestamptz is not null'];
    const params: unknown[] = [now];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // Dates are calendar days at the office, not in UTC.
    const day = `(l.scanned_at at time zone coalesce(
        (select o.timezone from public.office_locations o where o.is_active limit 1), 'UTC'))::date`;
    if (query.from) conditions.push(`${day} >= ${bind(query.from)}::date`);
    if (query.to) conditions.push(`${day} <= ${bind(query.to)}::date`);
    if (query.employeeId) conditions.push(`l.employee_id = ${bind(query.employeeId)}::uuid`);
    if (query.scannedBy) conditions.push(`l.scanned_by = ${bind(query.scannedBy)}::uuid`);
    if (query.status === 'EXPIRED') {
      conditions.push(`(l.status = 'PENDING' and l.expires_at <= $1::timestamptz)`);
    } else if (query.status === 'PENDING') {
      conditions.push(`(l.status = 'PENDING' and l.expires_at > $1::timestamptz)`);
    } else if (query.status) {
      conditions.push(`l.status = ${bind(query.status)}`);
    }
    const where = `where ${conditions.join(' and ')}`;

    const count = await db.query<{ total: string }>(
      `select count(*)::text as total ${LOG_FROM} ${where}`,
      params,
    );
    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await db.query<LogRow>(
      `select ${LOG_COLUMNS} ${LOG_FROM} ${where}
       order by l.scanned_at desc, l.id
       limit ${limit}::int offset ${offset}::int`,
      params,
    );

    return {
      items: rows.map((row) => toLogDto(row, true)),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function todayOf(state: AttendanceState): ScanTodayDto {
  const record = state.record;
  return {
    workDate: record?.workDate ?? state.workDate,
    status: record?.status ?? null,
    liveState: record?.liveState ?? 'NONE',
    checkInAt: isoOrNull(record?.checkInAt),
    checkOutAt: isoOrNull(record?.checkOutAt),
    isLate: record?.isLate ?? false,
  };
}

/** `$1` is "now" (to tell an expired pending scan from a live one); callers bind the rest. */
const LOG_COLUMNS = `
  l.id, l.scanned_at, l.qr_result, l.detected_action, l.reason_code,
  case when l.status = 'PENDING' and l.expires_at <= $1::timestamptz then 'EXPIRED'
       else l.status end as display_status,
  l.employee_id, e.employee_code as employee_code, e.full_name as employee_name,
  l.scanned_by, s.employee_code as scanner_code, s.full_name as scanner_name, sr.name as scanner_role,
  l.confirmed_at, l.confirmed_action, l.office_verification_result, l.attendance_event_id::text as event_id,
  l.scanner, host(l.client_ip) as client_ip`;

const LOG_FROM = `
  from public.qr_scan_logs l
  join public.profiles s on s.id = l.scanned_by
  join public.roles sr on sr.id = s.role_id
  left join public.profiles e on e.id = l.employee_id`;

interface LogRow {
  id: string;
  scanned_at: Date | string;
  qr_result: QrResult;
  detected_action: DetectedAction;
  reason_code: string | null;
  display_status: ScanDisplayStatus;
  employee_id: string | null;
  employee_code: string | null;
  employee_name: string | null;
  scanned_by: string;
  scanner_code: string;
  scanner_name: string;
  scanner_role: RoleName;
  confirmed_at: Date | string | null;
  confirmed_action: 'CHECK_IN' | 'CHECK_OUT' | null;
  office_verification_result: 'VERIFIED' | 'REJECTED' | null;
  event_id: string | null;
  scanner: ScanLogDto['scanner'];
  client_ip: string | null;
}

function toLogDto(row: LogRow, includeAddress: boolean): ScanLogDto {
  return {
    id: row.id,
    scannedAt: iso(row.scanned_at),
    status: row.display_status,
    qrResult: row.qr_result,
    detectedAction: row.detected_action,
    reasonCode: row.reason_code,
    employee: row.employee_id
      ? {
          id: row.employee_id,
          employeeCode: row.employee_code ?? '',
          fullName: row.employee_name ?? '',
        }
      : null,
    scannedBy: {
      id: row.scanned_by,
      employeeCode: row.scanner_code,
      fullName: row.scanner_name,
      role: row.scanner_role,
    },
    confirmedAt: isoOrNull(row.confirmed_at),
    confirmedAction: row.confirmed_action,
    officeVerification: row.office_verification_result,
    attendanceEventId: row.event_id,
    scanner: row.scanner ?? {},
    clientIp: includeAddress ? row.client_ip : null,
  };
}
