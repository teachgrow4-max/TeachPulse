import type {
  CreateEmployeeInput,
  CreateEmployeeResponse,
  DepartmentDto,
  EmployeeDto,
  ListEmployeesQuery,
  Paginated,
  ResetPasswordResponse,
  RoleName,
  UpdateEmployeeInput,
  UpdateEmployeeResponse,
} from '@teachgrow/shared';
import { writeAudit } from '../audit/audit.js';
import { AuthGatewayError, type AuthGateway } from '../auth/gateway.js';
import {
  IDENTITY_COLUMNS,
  IDENTITY_FROM,
  loadIdentityById,
  toEmployeeDto,
  toIdentity,
  type Identity,
  type IdentityRow,
} from '../auth/identity.js';
import { generateTemporaryPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import type { Db, Queryable } from '../db/pool.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { RequestMeta } from '../lib/request-meta.js';

export interface Actor {
  id: string;
  role: RoleName;
}

export interface EmployeeServiceDeps {
  db: Db;
  gateway: AuthGateway;
  clock: Clock;
  logger: Logger;
}

export interface CreateOptions {
  /** Audit action name (the first-admin CLI uses `bootstrap.admin_created`). */
  auditAction?: string;
  /**
   * Extra precondition, run once before the auth user is created (fail fast) and again inside the
   * insert transaction (authoritative). The first-admin CLI uses it to insist no admin exists yet.
   */
  guard?: (q: Queryable) => Promise<void>;
}

const validation = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', undefined, { details: [{ path, message }] });

const conflict = (path: string, message: string): AppError =>
  new AppError('CONFLICT', message, { details: [{ path, message }] });

/** Escape LIKE wildcards so a search for "100%" does not match everything. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

function constraintOf(error: unknown): { code?: string; name?: string } {
  const e = (error ?? {}) as PgErrorLike;
  const fromMessage = /"([^"]+)"/.exec(e.message ?? '')?.[1];
  return { code: e.code, name: e.constraint ?? fromMessage };
}

/** Turns a unique/foreign-key violation from the insert into a precise 409/400. */
function mapProfileWriteError(error: unknown): unknown {
  const { code, name } = constraintOf(error);
  if (code === '23505' && name === 'profiles_email_key') {
    return conflict('email', 'An employee with this email already exists.');
  }
  if (code === '23505' && name === 'profiles_employee_code_key') {
    return conflict('employeeCode', 'An employee with this ID already exists.');
  }
  if (code === '23503' && name?.includes('department')) {
    return validation('departmentId', 'That department does not exist.');
  }
  return error;
}

const auditable = (identity: Identity) => ({
  fullName: identity.fullName,
  phone: identity.phone,
  departmentId: identity.department?.id ?? null,
  designation: identity.designation,
  joiningDate: identity.joiningDate,
  role: identity.role,
  attendanceRequired: identity.attendanceRequired,
  isActive: identity.isActive,
});

export class EmployeeService {
  constructor(private readonly deps: EmployeeServiceDeps) {}

  // -----------------------------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------------------------

  async create(
    input: CreateEmployeeInput,
    actor: Actor | null,
    meta: RequestMeta,
    options: CreateOptions = {},
  ): Promise<CreateEmployeeResponse> {
    const { db, gateway, clock, logger } = this.deps;

    const isDisplay = input.role === 'office_display';
    if (isDisplay && input.attendanceRequired === true) {
      throw validation(
        'attendanceRequired',
        'The office display account cannot be tracked for attendance.',
      );
    }
    const attendanceRequired = isDisplay
      ? false
      : (input.attendanceRequired ?? input.role === 'employee');
    const mustChangePassword = input.requirePasswordChange ?? !isDisplay;
    const generated = input.initialPassword === undefined;
    const password = input.initialPassword ?? generateTemporaryPassword();

    await options.guard?.(db);
    await this.assertAvailable(db, input.email, input.employeeCode, input.departmentId ?? null);

    let authUserId: string;
    try {
      ({ id: authUserId } = await gateway.createUser({
        email: input.email,
        password,
        fullName: input.fullName,
      }));
    } catch (error) {
      throw this.translateProvisioningError(error);
    }

    try {
      const employee = await db.withTransaction(async (tx) => {
        await options.guard?.(tx);
        await tx.query(
          `insert into public.profiles
             (id, employee_code, full_name, email, phone, department_id, designation,
              joining_date, role_id, attendance_required, must_change_password, created_by)
           values
             ($1, $2, $3, $4, $5, $6, $7, $8::date,
              (select id from public.roles where name = $9), $10, $11, $12)`,
          [
            authUserId,
            input.employeeCode,
            input.fullName,
            input.email,
            input.phone ?? null,
            input.departmentId ?? null,
            input.designation ?? null,
            input.joiningDate,
            input.role,
            attendanceRequired,
            mustChangePassword,
            actor?.id ?? null,
          ],
        );
        const created = (await loadIdentityById(tx, authUserId))!;
        await writeAudit(tx, {
          action: options.auditAction ?? 'employee.create',
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          entityType: 'profile',
          entityId: authUserId,
          after: {
            ...auditable(created),
            employeeCode: created.employeeCode,
            email: created.email,
            mustChangePassword,
          },
          ...meta,
          at: clock.now(),
        });
        return toEmployeeDto(created);
      });
      return { employee, ...(generated ? { temporaryPassword: password } : {}) };
    } catch (error) {
      // The auth user exists but no profile does: remove it so the email can be used again.
      await gateway.deleteUser(authUserId).catch((cleanupError: unknown) => {
        logger.error(
          { err: cleanupError, authUserId },
          'could not remove the orphaned auth user after a failed profile insert',
        );
      });
      throw mapProfileWriteError(error);
    }
  }

  private async assertAvailable(
    q: Queryable,
    email: string,
    employeeCode: string,
    departmentId: string | null,
  ): Promise<void> {
    const { rows } = await q.query<{
      email_taken: boolean;
      code_taken: boolean;
      department_ok: boolean;
    }>(
      `select
         exists (select 1 from public.profiles where email = $1) as email_taken,
         exists (select 1 from public.profiles where lower(employee_code) = lower($2)) as code_taken,
         ($3::uuid is null
            or exists (select 1 from public.departments where id = $3::uuid and is_active)) as department_ok`,
      [email, employeeCode, departmentId],
    );
    const row = rows[0]!;
    if (row.email_taken) throw conflict('email', 'An employee with this email already exists.');
    if (row.code_taken) throw conflict('employeeCode', 'An employee with this ID already exists.');
    if (!row.department_ok) throw validation('departmentId', 'That department does not exist.');
  }

  private translateProvisioningError(error: unknown): unknown {
    if (!(error instanceof AuthGatewayError)) return error;
    switch (error.kind) {
      case 'email_exists':
        return conflict('email', 'An account with this email already exists.');
      case 'weak_password':
        return validation('initialPassword', 'That password is too weak.');
      case 'unavailable':
        return new AppError('SERVICE_UNAVAILABLE', undefined, { cause: error });
      case 'rate_limited':
        return new AppError('RATE_LIMITED');
      default:
        return error;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------------------------

  async list(query: ListEmployeesQuery): Promise<Paginated<EmployeeDto>> {
    const { db } = this.deps;
    const conditions: string[] = [];
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
    if (query.role) conditions.push(`r.name = ${bind(query.role)}`);
    if (query.status === 'active') conditions.push('p.is_active');
    if (query.status === 'inactive') conditions.push('not p.is_active');

    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

    const count = await db.query<{ total: string }>(
      `select count(*)::text as total ${IDENTITY_FROM} ${where}`,
      params,
    );

    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const { rows } = await db.query<IdentityRow>(
      `select ${IDENTITY_COLUMNS} ${IDENTITY_FROM} ${where}
       order by lower(p.full_name), p.employee_code
       limit ${limit}::int offset ${offset}::int`,
      params,
    );

    return {
      items: rows.map((row) => toEmployeeDto(toIdentity(row))),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async get(id: string): Promise<EmployeeDto> {
    const identity = await loadIdentityById(this.deps.db, id);
    if (!identity) throw new AppError('NOT_FOUND');
    return toEmployeeDto(identity);
  }

  // -----------------------------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------------------------

  async update(
    id: string,
    patch: UpdateEmployeeInput,
    actor: Actor,
    meta: RequestMeta,
  ): Promise<UpdateEmployeeResponse> {
    const { db, gateway, clock, logger } = this.deps;
    const now = clock.now();

    const { employee, statusChanged } = await db.withTransaction(async (tx) => {
      const locked = await tx.query<IdentityRow>(
        `select ${IDENTITY_COLUMNS} ${IDENTITY_FROM} where p.id = $1 for update of p`,
        [id],
      );
      if (!locked.rows[0]) throw new AppError('NOT_FOUND');
      const current = toIdentity(locked.rows[0]);

      const isSelf = actor.id === id;
      if (isSelf && patch.role !== undefined && patch.role !== current.role) {
        throw new AppError('SELF_MODIFICATION_FORBIDDEN');
      }
      if (isSelf && patch.isActive === false) throw new AppError('SELF_MODIFICATION_FORBIDDEN');

      const nextRole = patch.role ?? current.role;
      if (
        nextRole !== current.role &&
        (nextRole === 'office_display' || current.role === 'office_display')
      ) {
        throw validation(
          'role',
          'The office display account type cannot be changed. Create a new account instead.',
        );
      }
      if (nextRole === 'office_display' && patch.attendanceRequired === true) {
        throw validation(
          'attendanceRequired',
          'The office display account cannot be tracked for attendance.',
        );
      }
      if (patch.departmentId) {
        const dept = await tx.query(
          'select 1 from public.departments where id = $1 and is_active',
          [patch.departmentId],
        );
        if (dept.rows.length === 0)
          throw validation('departmentId', 'That department does not exist.');
      }

      const sets: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown, cast = ''): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}${cast}`);
      };
      if (patch.fullName !== undefined) set('full_name', patch.fullName);
      if (patch.phone !== undefined) set('phone', patch.phone);
      if (patch.departmentId !== undefined) set('department_id', patch.departmentId, '::uuid');
      if (patch.designation !== undefined) set('designation', patch.designation);
      if (patch.joiningDate !== undefined) set('joining_date', patch.joiningDate, '::date');
      if (patch.attendanceRequired !== undefined)
        set('attendance_required', patch.attendanceRequired);
      if (patch.role !== undefined && patch.role !== current.role) {
        values.push(patch.role);
        sets.push(`role_id = (select id from public.roles where name = $${values.length})`);
      }
      const statusChanged = patch.isActive !== undefined && patch.isActive !== current.isActive;
      if (statusChanged && patch.isActive) {
        sets.push('is_active = true', 'deactivated_at = null', 'deactivated_by = null');
      } else if (statusChanged) {
        values.push(now, actor.id);
        sets.push(
          'is_active = false',
          `deactivated_at = $${values.length - 1}`,
          `deactivated_by = $${values.length}`,
        );
      }

      if (sets.length === 0) return { employee: toEmployeeDto(current), statusChanged: false };

      // The database trigger refuses to deactivate or demote the last active administrator.
      try {
        await tx.query(`update public.profiles set ${sets.join(', ')} where id = $1`, values);
      } catch (error) {
        throw mapProfileWriteError(error);
      }
      if (statusChanged && !patch.isActive) await revokeUserSessions(tx, id);

      const updated = (await loadIdentityById(tx, id))!;
      const before = auditable(current);
      const after = auditable(updated);
      const changedKeys = (Object.keys(after) as Array<keyof typeof after>).filter(
        (key) => before[key] !== after[key],
      );
      const pick = (source: typeof before, keys: Array<keyof typeof before>) =>
        Object.fromEntries(keys.map((key) => [key, source[key]]));
      const base = {
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'profile',
        entityId: id,
        ...meta,
        at: now,
      };

      if (statusChanged) {
        await writeAudit(tx, {
          ...base,
          action: updated.isActive ? 'employee.activate' : 'employee.deactivate',
          before: { isActive: current.isActive },
          after: { isActive: updated.isActive },
        });
      }
      if (updated.role !== current.role) {
        await writeAudit(tx, {
          ...base,
          action: 'employee.role_change',
          before: { role: current.role },
          after: { role: updated.role },
        });
      }
      const otherKeys = changedKeys.filter((key) => key !== 'isActive' && key !== 'role');
      if (otherKeys.length > 0) {
        await writeAudit(tx, {
          ...base,
          action: 'employee.update',
          before: pick(before, otherKeys),
          after: pick(after, otherKeys),
        });
      }
      return { employee: toEmployeeDto(updated), statusChanged };
    });

    const warnings: string[] = [];
    if (statusChanged) {
      // Keep the sign-in provider consistent: a deactivated person must not be able to sign in or
      // refresh there either. Our own tables already deny them, so a failure here is a warning.
      try {
        await gateway.setBanned(id, !employee.isActive);
      } catch (error) {
        logger.error(
          { err: error, employeeId: id },
          'could not sync account state to the auth provider',
        );
        warnings.push('AUTH_PROVIDER_SYNC_FAILED');
      }
    }
    return { employee, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  // -----------------------------------------------------------------------------------------
  // Password reset (administrator)
  // -----------------------------------------------------------------------------------------

  async resetPassword(id: string, actor: Actor, meta: RequestMeta): Promise<ResetPasswordResponse> {
    const { db, gateway, clock } = this.deps;
    if (actor.id === id) throw new AppError('SELF_MODIFICATION_FORBIDDEN');

    const temporaryPassword = generateTemporaryPassword();

    // Database first: if the provider call then fails, the worst outcome is that the person must
    // change their (unchanged) password at next sign-in, never a silently skipped forced reset.
    await db.withTransaction(async (tx) => {
      const found = await tx.query(
        'update public.profiles set must_change_password = true where id = $1 returning id',
        [id],
      );
      if (found.rows.length === 0) throw new AppError('NOT_FOUND');
      const revoked = await revokeUserSessions(tx, id);
      await writeAudit(tx, {
        action: 'employee.password_reset',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'profile',
        entityId: id,
        metadata: { sessions_revoked: revoked },
        ...meta,
        at: clock.now(),
      });
    });

    try {
      await gateway.updatePassword(id, temporaryPassword);
    } catch (error) {
      throw this.translateProvisioningError(error);
    }
    return { temporaryPassword };
  }

  // -----------------------------------------------------------------------------------------
  // Departments
  // -----------------------------------------------------------------------------------------

  async listDepartments(): Promise<DepartmentDto[]> {
    const { rows } = await this.deps.db.query<{ id: string; name: string; is_active: boolean }>(
      'select id, name, is_active from public.departments order by lower(name)',
    );
    return rows.map((row) => ({ id: row.id, name: row.name, isActive: row.is_active }));
  }

  async createDepartment(name: string, actor: Actor, meta: RequestMeta): Promise<DepartmentDto> {
    const { db, clock } = this.deps;
    return db.withTransaction(async (tx) => {
      let row: { id: string; name: string; is_active: boolean };
      try {
        const inserted = await tx.query<{ id: string; name: string; is_active: boolean }>(
          'insert into public.departments (name) values ($1) returning id, name, is_active',
          [name],
        );
        row = inserted.rows[0]!;
      } catch (error) {
        if (constraintOf(error).code === '23505') {
          throw conflict('name', 'A department with this name already exists.');
        }
        throw error;
      }
      await writeAudit(tx, {
        action: 'department.create',
        actorId: actor.id,
        actorRole: actor.role,
        entityType: 'department',
        entityId: row.id,
        after: { name: row.name },
        ...meta,
        at: clock.now(),
      });
      return { id: row.id, name: row.name, isActive: row.is_active };
    });
  }
}
