import {
  EMPLOYEE_QR_PREFIX,
  QR_PAYLOAD_PREFIX,
  isErrorCode,
  looksLikeDailyQr,
  type AttendanceStatus,
  type DetectedAction,
  type ErrorCode,
  type ListScansQuery,
  type LiveState,
  type Paginated,
  type QrResult,
  type RoleName,
  type ScanDisplayStatus,
  type ScanLogDto,
  type ScanRecorded,
  type ScanRefusalDetails,
  type ScanRequest,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import { loadIdentityById, type Identity } from '../auth/identity.js';
import type { Db, Queryable } from '../db/pool.js';
import { hashDailyPayload } from '../daily-qr/token.js';
import type { Clock } from '../lib/clock.js';
import { AppError, fromDbError } from '../lib/errors.js';
import type { RequestMeta } from '../lib/request-meta.js';

/**
 * The administrator-operated scanner.
 *
 * An administrator (or attendance operator) scans the QR code on an employee's screen. The server
 * finds the code by its hash, validates it and records the attendance in ONE step, through the
 * same engine core as a self check-in, marked ADMIN_QR.
 *
 * The scanner's own location and network are never consulted: the employee proved they were at the
 * office when they generated the code, and the code is short lived, single use and bound to the
 * employee, the day and the action. Everything is decided here from the stored code, never from
 * anything the client sends beyond the scanned text.
 *
 * Every scan is written to `qr_scan_logs`, refused ones included, so the dashboard can warn about
 * duplicate, expired and unrecognised codes.
 */

export interface QrAttendanceServiceDeps {
  db: Db;
  clock: Clock;
}

type ScanOutcome = { recorded: ScanRecorded } | { rejected: AppError };

interface LogInput {
  scannedBy: string;
  scannedAt: Date;
  scanner: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
  employeeId: string | null;
  dailyQrId: string | null;
  hash: Uint8Array | null;
  qrResult: QrResult;
  detected: DetectedAction;
  reason: string;
  status: 'NO_ACTION' | 'REJECTED';
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

/** Reasons that mean "valid code, but today holds nothing to record" rather than "bad code". */
const NOTHING_TO_RECORD = new Set<string>([
  'ALREADY_CHECKED_OUT',
  'HOLIDAY',
  'WEEKLY_OFF',
  'ON_LEAVE',
  'ACTIVE_BREAK',
  'ALREADY_CHECKED_IN',
]);

interface TokenRow {
  id: string;
  employee_id: string;
  status: 'ACTIVE' | 'USED' | 'SUPERSEDED';
  used_at: Date | string | null;
}

export class QrAttendanceService {
  constructor(private readonly deps: QrAttendanceServiceDeps) {}

  async scan(
    operator: Identity,
    input: ScanRequest,
    ip: string | null,
    meta: RequestMeta,
  ): Promise<ScanRecorded> {
    const { db, clock } = this.deps;

    // A refused scan must still be written down, so the transaction commits and hands the refusal
    // back as a value; it is thrown only after the log row is safe.
    const outcome = await db.withTransaction((tx) =>
      this.attempt(tx, operator, input, ip, meta, clock.now()),
    );
    if ('rejected' in outcome) throw outcome.rejected;
    return outcome.recorded;
  }

  private async attempt(
    tx: Queryable,
    operator: Identity,
    input: ScanRequest,
    ip: string | null,
    meta: RequestMeta,
    now: Date,
  ): Promise<ScanOutcome> {
    const base = {
      scannedBy: operator.id,
      scannedAt: now,
      scanner: describeScanner(input.scanner, meta),
      ip,
      requestId: meta.requestId,
    };

    // ---- not a code we could have issued ---------------------------------------------------
    if (!looksLikeDailyQr(input.payload)) {
      const scanId = await this.insertLog(tx, {
        ...base,
        employeeId: null,
        dailyQrId: null,
        hash: null,
        qrResult: 'MALFORMED',
        detected: 'REJECTED',
        reason: 'EMPLOYEE_QR_INVALID',
        status: 'REJECTED',
      });
      let message: string | undefined;
      if (input.payload.startsWith(`${QR_PAYLOAD_PREFIX}.`)) {
        message =
          'That is the office QR code shown on the lobby screen, not an employee’s attendance code.';
      } else if (input.payload.startsWith(`${EMPLOYEE_QR_PREFIX}.`)) {
        message =
          'ID-card codes no longer record attendance. Ask the employee to generate their attendance QR code in the TeachGrow app.';
      }
      return { rejected: this.refusal('EMPLOYEE_QR_INVALID', { scanId }, message) };
    }

    const hash = hashDailyPayload(input.payload);
    const found = (
      await tx.query<TokenRow>(
        'select id, employee_id, status, used_at from public.attendance_qr_tokens where token_hash = $1',
        [hash],
      )
    ).rows[0];
    if (!found) {
      const scanId = await this.insertLog(tx, {
        ...base,
        employeeId: null,
        dailyQrId: null,
        hash,
        qrResult: 'UNKNOWN',
        detected: 'REJECTED',
        reason: 'EMPLOYEE_QR_INVALID',
        status: 'REJECTED',
      });
      return { rejected: this.refusal('EMPLOYEE_QR_INVALID', { scanId }) };
    }

    const person = await loadIdentityById(tx, found.employee_id);
    if (!person) throw new AppError('NOT_FOUND', 'That employee was not found.');
    const who = { employeeCode: person.employeeCode, fullName: person.fullName };

    // ---- let the database decide, atomically -------------------------------------------------
    // The function re-checks everything against the stored code under a row lock, so two scanners
    // racing on one code cannot both record it. A refusal must not roll back the log row, hence
    // the savepoint.
    await tx.query('savepoint daily_qr_record');
    try {
      const { rows } = await tx.query<{
        r: { scanId: string; eventId: number | string; recordId: string; action: string };
      }>(
        `select private.daily_qr_record($1::uuid, $2::uuid, $3::jsonb, $4::inet, $5, $6::timestamptz) as r`,
        [found.id, operator.id, JSON.stringify(base.scanner), ip, meta.requestId, now],
      );
      await tx.query('release savepoint daily_qr_record');
      const r = rows[0]!.r;
      // Names the scan and the event, never the code.
      await writeAudit(tx, {
        action: 'qr_attendance.recorded',
        actorId: operator.id,
        actorRole: operator.role,
        entityType: 'attendance_event',
        entityId: String(r.eventId),
        metadata: {
          scan_id: r.scanId,
          employee_id: person.id,
          action: r.action,
          source: 'ADMIN_QR',
        },
        ...meta,
        at: now,
      });
      return { recorded: await this.recordedOf(tx, r.scanId, person) };
    } catch (error) {
      const domain = fromDbError(error);
      if (!domain) throw error;
      await tx.query('rollback to savepoint daily_qr_record');
      await tx.query('release savepoint daily_qr_record');

      const code = domain.code;
      const qrResult: QrResult =
        code === 'QR_EXPIRED'
          ? 'EXPIRED'
          : code === 'QR_ALREADY_USED'
            ? 'USED'
            : code === 'QR_SUPERSEDED'
              ? 'SUPERSEDED'
              : 'VALID';
      const nothing = NOTHING_TO_RECORD.has(code);
      const scanId = await this.insertLog(tx, {
        ...base,
        employeeId: person.id,
        dailyQrId: found.id,
        hash,
        qrResult,
        detected: nothing
          ? code === 'ALREADY_CHECKED_OUT'
            ? 'ALREADY_CHECKED_OUT'
            : 'BLOCKED'
          : 'REJECTED',
        reason: code,
        status: nothing ? 'NO_ACTION' : 'REJECTED',
      });
      return {
        rejected: this.refusal(code, {
          scanId,
          employee: who,
          ...(code === 'QR_ALREADY_USED' && found.used_at
            ? { firstRecordedAt: iso(found.used_at) }
            : {}),
        }),
      };
    }
  }

  private refusal(code: ErrorCode, details: ScanRefusalDetails, message?: string): AppError {
    return new AppError(isErrorCode(code) ? code : 'INTERNAL', message, { details });
  }

  private async recordedOf(tx: Queryable, scanId: string, person: Identity): Promise<ScanRecorded> {
    const { rows } = await tx.query<{
      confirmed_at: Date | string;
      confirmed_action: 'CHECK_IN' | 'CHECK_OUT';
      work_date: string;
      status: AttendanceStatus;
      is_late: boolean;
      live_state: LiveState;
      check_in_at: Date | string | null;
      check_out_at: Date | string | null;
      net_work_seconds: number | null;
    }>(
      `select l.confirmed_at, l.confirmed_action, r.work_date::text as work_date, r.status, r.is_late,
              r.live_state, r.check_in_at, r.check_out_at, r.net_work_seconds
       from public.qr_scan_logs l
       join public.attendance_records r on r.id = l.attendance_record_id
       where l.id = $1`,
      [scanId],
    );
    const row = rows[0]!;
    return {
      scanId,
      action: row.confirmed_action,
      recordedAt: iso(row.confirmed_at),
      source: 'ADMIN_QR',
      employee: {
        id: person.id,
        employeeCode: person.employeeCode,
        fullName: person.fullName,
        department: person.department?.name ?? null,
        designation: person.designation,
        avatarUrl: person.avatarUrl,
      },
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

  private async insertLog(tx: Queryable, v: LogInput): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.qr_scan_logs
         (scanned_by, employee_id, daily_qr_id, token_hash, qr_result, detected_action, reason_code,
          status, scanned_at, scanner, client_ip, request_id)
       values
         ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb, $11::inet, $12)
       returning id`,
      [
        v.scannedBy,
        v.employeeId,
        v.dailyQrId,
        v.hash,
        v.qrResult,
        v.detected,
        v.reason,
        v.status,
        v.scannedAt,
        JSON.stringify(v.scanner),
        v.ip,
        v.requestId,
      ],
    );
    return rows[0]!.id;
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

/** `$1` is "now" (to tell an expired pending scan from a live one); callers bind the rest. */
const LOG_COLUMNS = `
  l.id, l.scanned_at, l.qr_result, l.detected_action, l.reason_code,
  case when l.status = 'PENDING' and l.expires_at <= $1::timestamptz then 'EXPIRED'
       else l.status end as display_status,
  l.employee_id, e.employee_code as employee_code, e.full_name as employee_name,
  e.avatar_url as employee_avatar,
  l.scanned_by, s.employee_code as scanner_code, s.full_name as scanner_name, sr.name as scanner_role,
  s.avatar_url as scanner_avatar,
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
  employee_avatar: string | null;
  scanned_by: string;
  scanner_code: string;
  scanner_name: string;
  scanner_role: RoleName;
  scanner_avatar: string | null;
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
          avatarUrl: row.employee_avatar,
        }
      : null,
    scannedBy: {
      id: row.scanned_by,
      employeeCode: row.scanner_code,
      fullName: row.scanner_name,
      avatarUrl: row.scanner_avatar,
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
