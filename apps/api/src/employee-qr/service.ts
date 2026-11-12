import type {
  AdminEmployeeQrDetail,
  AdminEmployeeQrRow,
  BackfillQrResponse,
  EmployeeQrCodeRecordDto,
  EmployeeQrDto,
  EmployeeQrHolder,
  EmployeeQrState,
  ListEmployeeQrQuery,
  Paginated,
  QrResult,
  RoleName,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import { loadIdentityById, type Identity } from '../auth/identity.js';
import type { Db, Queryable } from '../db/pool.js';
import { escapeLike, type Actor, type EmployeeQrIssuer } from '../employees/service.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { RequestMeta } from '../lib/request-meta.js';
import {
  derivePayload,
  deriveEmployeeQrKey,
  hashPayload,
  isWellFormed,
  newNonce,
} from './token.js';

/**
 * Looks after employees' personal QR codes: issuing, showing, revoking and regenerating them, and
 * recognising one that is presented at a scanner. The code format and what is (and is not) stored
 * are explained in ./token.ts.
 *
 * Rules the rest of the system relies on:
 *   - at most ONE live (ACTIVE) code per person (a unique index in the database enforces it);
 *   - a person who has ever had a code is never given one silently again: a revoked code stays
 *     revoked until an administrator regenerates it on purpose;
 *   - regenerating invalidates every earlier code at once (a new nonce means a new code);
 *   - every issue / regenerate / revoke / view of a code is audited, never with the code itself.
 */

export interface EmployeeQrServiceDeps {
  db: Db;
  clock: Clock;
  /** EMPLOYEE_QR_SECRET */
  secret: string;
}

interface CodeRow {
  id: string;
  employee_id: string;
  token_hash: Uint8Array;
  token_nonce: Uint8Array;
  status: 'ACTIVE' | 'REVOKED';
  generated_at: Date | string;
  generated_by: string | null;
  generated_by_name: string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
}

const CODE_COLUMNS = `
  c.id, c.employee_id, c.token_hash, c.token_nonce, c.status, c.generated_at, c.generated_by,
  g.full_name as generated_by_name, c.revoked_at, c.revoked_by, v.full_name as revoked_by_name,
  c.revoke_reason`;

const CODE_FROM = `
  from public.employee_qr_codes c
  left join public.profiles g on g.id = c.generated_by
  left join public.profiles v on v.id = c.revoked_by`;

const iso = (value: Date | string): string => new Date(value).toISOString();

export type QrLookup =
  | { result: Extract<QrResult, 'MALFORMED'> }
  | { result: Extract<QrResult, 'UNKNOWN'>; hash: Buffer }
  | { result: Extract<QrResult, 'VALID' | 'REVOKED'>; hash: Buffer; code: CodeRow };

const holderOf = (identity: Identity): EmployeeQrHolder => ({
  employeeCode: identity.employeeCode,
  fullName: identity.fullName,
  department: identity.department?.name ?? null,
  designation: identity.designation,
  avatarUrl: identity.avatarUrl,
});

export class EmployeeQrService implements EmployeeQrIssuer {
  private readonly key: Buffer;

  constructor(private readonly deps: EmployeeQrServiceDeps) {
    this.key = deriveEmployeeQrKey(deps.secret);
  }

  // -----------------------------------------------------------------------------------------
  // Recognising a code at the scanner
  // -----------------------------------------------------------------------------------------

  /** Finds the code whose hash matches the exact text that was scanned. Never decodes it. */
  async lookup(q: Queryable, payload: string): Promise<QrLookup> {
    if (!isWellFormed(payload)) return { result: 'MALFORMED' };
    const hash = hashPayload(payload);
    const { rows } = await q.query<CodeRow>(
      `select ${CODE_COLUMNS} ${CODE_FROM} where c.token_hash = $1`,
      [hash],
    );
    const code = rows[0];
    if (!code) return { result: 'UNKNOWN', hash };
    return { result: code.status === 'ACTIVE' ? 'VALID' : 'REVOKED', hash, code };
  }

  // -----------------------------------------------------------------------------------------
  // Issuing
  // -----------------------------------------------------------------------------------------

  /**
   * Gives somebody their first code. Does nothing if they have ever had one (so a revoked code is
   * not quietly replaced). Runs inside the caller's transaction, which is how a new account and
   * its code are created together or not at all. Returns whether a code was created.
   */
  async issueFirstCode(
    tx: Queryable,
    employeeId: string,
    actor: Actor | null,
    meta: RequestMeta,
    at: Date,
  ): Promise<boolean> {
    await this.lock(tx, employeeId);
    const existing = await tx.query(
      'select 1 from public.employee_qr_codes where employee_id = $1 limit 1',
      [employeeId],
    );
    if (existing.rows.length > 0) return false;

    const code = await this.insertCode(tx, employeeId, actor?.id ?? null, at);
    await writeAudit(tx, {
      action: 'employee_qr.issued',
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      entityType: 'profile',
      entityId: employeeId,
      after: { code_id: code.id, status: 'ACTIVE' },
      metadata: { reason: 'first_code' },
      ...meta,
      at,
    });
    return true;
  }

  /** Issues a first code to everybody who has none (accounts that predate this feature). */
  async backfill(actor: Actor, meta: RequestMeta): Promise<BackfillQrResponse> {
    const { db, clock } = this.deps;
    const batch = 100;
    let issued = 0;
    for (;;) {
      const at = clock.now();
      const created = await db.withTransaction(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `select p.id
           from public.profiles p
           join public.roles r on r.id = p.role_id
           where r.name <> 'office_display'
             and not exists (select 1 from public.employee_qr_codes c where c.employee_id = p.id)
           order by p.created_at, p.id
           limit ${batch}`,
        );
        let n = 0;
        for (const row of rows) {
          if (await this.issueFirstCode(tx, row.id, actor, meta, at)) n += 1;
        }
        return n;
      });
      issued += created;
      if (created < batch) break;
    }
    await writeAudit(this.deps.db, {
      action: 'employee_qr.backfilled',
      actorId: actor.id,
      actorRole: actor.role,
      metadata: { issued },
      ...meta,
      at: clock.now(),
    });
    return { issued };
  }

  // -----------------------------------------------------------------------------------------
  // Showing a code
  // -----------------------------------------------------------------------------------------

  /** The signed-in person's own code (issuing the first one if they somehow have none yet). */
  async getMine(identity: Identity, meta: RequestMeta): Promise<EmployeeQrDto> {
    const { db, clock } = this.deps;
    return db.withTransaction(async (tx) => {
      await this.issueFirstCode(
        tx,
        identity.id,
        { id: identity.id, role: identity.role },
        meta,
        clock.now(),
      );
      return this.toDto(holderOf(identity), await this.currentCode(tx, identity.id));
    });
  }

  /** An administrator looking at somebody's code: the code, and every code they have ever had. */
  async getForAdmin(
    employeeId: string,
    actor: Actor,
    meta: RequestMeta,
  ): Promise<AdminEmployeeQrDetail> {
    const { db, clock } = this.deps;
    return db.withTransaction(async (tx) => {
      const person = await this.requireCardHolder(tx, employeeId);
      const at = clock.now();
      await this.issueFirstCode(tx, employeeId, actor, meta, at);
      const current = await this.currentCode(tx, employeeId);
      const dto = this.toDto(holderOf(person), current);

      const { rows } = await tx.query<CodeRow>(
        `select ${CODE_COLUMNS} ${CODE_FROM}
         where c.employee_id = $1
         order by c.generated_at desc, (c.status = 'ACTIVE') desc, c.id`,
        [employeeId],
      );
      // Showing a code is itself a sensitive act: it is recorded who looked, never what they saw.
      await writeAudit(tx, {
        action: 'employee_qr.viewed',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'profile',
        entityId: employeeId,
        metadata: { code_id: current?.id ?? null },
        ...meta,
        at,
      });
      return { ...dto, employeeId, history: rows.map(toRecord) };
    });
  }

  // -----------------------------------------------------------------------------------------
  // Changing a code
  // -----------------------------------------------------------------------------------------

  /** Retires the live code (if any) and issues a new one. Every earlier code stops working. */
  async regenerate(
    employeeId: string,
    actor: Actor,
    reason: string | undefined,
    meta: RequestMeta,
  ): Promise<EmployeeQrDto> {
    const { db, clock } = this.deps;
    return db.withTransaction(async (tx) => {
      await this.lock(tx, employeeId);
      const person = await this.requireCardHolder(tx, employeeId);
      const at = clock.now();

      const live = await this.liveCode(tx, employeeId);
      if (live) {
        await this.retire(tx, live.id, actor.id, reason ?? 'Regenerated by an administrator.', at);
      }
      const fresh = await this.insertCode(tx, employeeId, actor.id, at);

      await writeAudit(tx, {
        action: 'employee_qr.regenerated',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'profile',
        entityId: employeeId,
        before: live ? { code_id: live.id, status: 'ACTIVE' } : null,
        after: { code_id: fresh.id, status: 'ACTIVE' },
        metadata: { reason: reason ?? null },
        ...meta,
        at,
      });
      return this.toDto(holderOf(person), fresh);
    });
  }

  /** Withdraws the live code (say, an ID card was lost). The person has no code until regenerated. */
  async revoke(
    employeeId: string,
    actor: Actor,
    reason: string,
    meta: RequestMeta,
  ): Promise<EmployeeQrDto> {
    const { db, clock } = this.deps;
    return db.withTransaction(async (tx) => {
      await this.lock(tx, employeeId);
      const person = await this.requireCardHolder(tx, employeeId);
      const at = clock.now();

      const live = await this.liveCode(tx, employeeId);
      if (!live) {
        throw new AppError('CONFLICT', 'This employee has no live QR code to revoke.');
      }
      await this.retire(tx, live.id, actor.id, reason, at);

      await writeAudit(tx, {
        action: 'employee_qr.revoked',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'profile',
        entityId: employeeId,
        before: { code_id: live.id, status: 'ACTIVE' },
        after: { code_id: live.id, status: 'REVOKED' },
        metadata: { reason },
        ...meta,
        at,
      });
      return this.toDto(holderOf(person), await this.currentCode(tx, employeeId));
    });
  }

  // -----------------------------------------------------------------------------------------
  // The administrator's list
  // -----------------------------------------------------------------------------------------

  async list(query: ListEmployeeQrQuery): Promise<Paginated<AdminEmployeeQrRow>> {
    const { db } = this.deps;
    const conditions: string[] = [`r.name <> 'office_display'`];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.search) {
      const pattern = bind(`%${escapeLike(query.search)}%`);
      conditions.push(
        `(p.full_name ilike ${pattern} escape '\\'
          or p.email ilike ${pattern} escape '\\'
          or p.employee_code ilike ${pattern} escape '\\')`,
      );
    }
    if (query.departmentId) conditions.push(`p.department_id = ${bind(query.departmentId)}::uuid`);
    if (query.qrStatus === 'ACTIVE') conditions.push(`q.status = 'ACTIVE'`);
    if (query.qrStatus === 'REVOKED') conditions.push(`q.status = 'REVOKED'`);
    if (query.qrStatus === 'NONE') conditions.push('q.status is null');

    const from = `
      from public.profiles p
      join public.roles r on r.id = p.role_id
      left join public.departments d on d.id = p.department_id
      left join lateral (
        select c.status, c.generated_at, c.revoked_at
        from public.employee_qr_codes c
        where c.employee_id = p.id
        order by (c.status = 'ACTIVE') desc, c.generated_at desc
        limit 1
      ) q on true
      where ${conditions.join(' and ')}`;

    const count = await db.query<{ total: string }>(
      `select count(*)::text as total ${from}`,
      params,
    );

    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await db.query<{
      id: string;
      employee_code: string;
      full_name: string;
      email: string;
      role: RoleName;
      department_name: string | null;
      designation: string | null;
      is_active: boolean;
      qr_status: 'ACTIVE' | 'REVOKED' | null;
      generated_at: Date | string | null;
      revoked_at: Date | string | null;
      issued: string;
      last_scan_at: Date | string | null;
    }>(
      `select p.id, p.employee_code, p.full_name, p.email, r.name as role,
              d.name as department_name, p.designation, p.is_active,
              q.status as qr_status, q.generated_at, q.revoked_at,
              (select count(*)::text from public.employee_qr_codes c where c.employee_id = p.id) as issued,
              (select max(s.scanned_at) from public.qr_scan_logs s where s.employee_id = p.id) as last_scan_at
       ${from}
       order by lower(p.full_name), p.employee_code
       limit ${limit}::int offset ${offset}::int`,
      params,
    );

    return {
      items: rows.map((row) => ({
        employee: {
          id: row.id,
          employeeCode: row.employee_code,
          fullName: row.full_name,
          email: row.email,
          role: row.role,
          department: row.department_name,
          designation: row.designation,
          isActive: row.is_active,
        },
        qr: {
          status: (row.qr_status ?? 'NONE') as EmployeeQrState,
          generatedAt: row.generated_at ? iso(row.generated_at) : null,
          revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
          issued: Number(row.issued),
        },
        lastScanAt: row.last_scan_at ? iso(row.last_scan_at) : null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  /** One change to a person's codes at a time (two administrators clicking "regenerate"). */
  private async lock(tx: Queryable, employeeId: string): Promise<void> {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `employee-qr:${employeeId}`,
    ]);
  }

  private async requireCardHolder(tx: Queryable, employeeId: string): Promise<Identity> {
    const person = await loadIdentityById(tx, employeeId);
    if (!person) throw new AppError('NOT_FOUND', 'That employee was not found.');
    if (person.role === 'office_display') {
      throw new AppError(
        'VALIDATION_FAILED',
        'The office display account does not have a personal QR code.',
      );
    }
    return person;
  }

  private async insertCode(
    tx: Queryable,
    employeeId: string,
    generatedBy: string | null,
    at: Date,
  ): Promise<CodeRow> {
    const nonce = newNonce();
    const hash = hashPayload(derivePayload(this.key, employeeId, nonce));
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.employee_qr_codes (employee_id, token_hash, token_nonce, generated_at, generated_by)
       values ($1, $2, $3, $4::timestamptz, $5)
       returning id`,
      [employeeId, hash, nonce, at, generatedBy],
    );
    const inserted = await tx.query<CodeRow>(
      `select ${CODE_COLUMNS} ${CODE_FROM} where c.id = $1`,
      [rows[0]!.id],
    );
    return inserted.rows[0]!;
  }

  private async retire(
    tx: Queryable,
    codeId: string,
    revokedBy: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `update public.employee_qr_codes
       set status = 'REVOKED', revoked_at = $2::timestamptz, revoked_by = $3, revoke_reason = $4
       where id = $1 and status = 'ACTIVE'`,
      [codeId, at, revokedBy, reason.slice(0, 500)],
    );
  }

  private async liveCode(tx: Queryable, employeeId: string): Promise<CodeRow | null> {
    const { rows } = await tx.query<CodeRow>(
      `select ${CODE_COLUMNS} ${CODE_FROM} where c.employee_id = $1 and c.status = 'ACTIVE'`,
      [employeeId],
    );
    return rows[0] ?? null;
  }

  /** The live code, or failing that the most recently revoked one, or null if there never was one. */
  private async currentCode(q: Queryable, employeeId: string): Promise<CodeRow | null> {
    const { rows } = await q.query<CodeRow>(
      `select ${CODE_COLUMNS} ${CODE_FROM}
       where c.employee_id = $1
       order by (c.status = 'ACTIVE') desc, c.generated_at desc, c.id
       limit 1`,
      [employeeId],
    );
    return rows[0] ?? null;
  }

  private toDto(holder: EmployeeQrHolder, code: CodeRow | null): EmployeeQrDto {
    return {
      status: code ? code.status : 'NONE',
      payload: code?.status === 'ACTIVE' ? this.payloadOf(code) : null,
      generatedAt: code ? iso(code.generated_at) : null,
      revokedAt: code?.revoked_at ? iso(code.revoked_at) : null,
      holder,
    };
  }

  /**
   * Re-derives the code to show, and checks it against the stored hash. If they differ the secret
   * has changed since the code was issued; showing a code that no scanner would accept would be
   * worse than saying so.
   */
  private payloadOf(code: CodeRow): string {
    const payload = derivePayload(this.key, code.employee_id, Buffer.from(code.token_nonce));
    if (!hashPayload(payload).equals(Buffer.from(code.token_hash))) {
      throw new AppError(
        'CONFLICT',
        'This QR code was issued under a different server secret and has to be regenerated.',
      );
    }
    return payload;
  }
}

function toRecord(row: CodeRow): EmployeeQrCodeRecordDto {
  return {
    id: row.id,
    status: row.status,
    generatedAt: iso(row.generated_at),
    generatedBy: row.generated_by
      ? { id: row.generated_by, fullName: row.generated_by_name ?? '' }
      : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    revokedBy: row.revoked_by ? { id: row.revoked_by, fullName: row.revoked_by_name ?? '' } : null,
    revokeReason: row.revoke_reason,
  };
}
