import type { AuthUserDto, EmployeeDto, RoleName } from '@teachgrow/shared';
import type { Queryable } from '../db/pool.js';

/**
 * The server-side view of a signed-in person, loaded from the database on EVERY request.
 * Role, active flag and forced-password-change state are never taken from the JWT, so a
 * deactivation or role change takes effect on the very next call.
 */
export interface Identity {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  phone: string | null;
  designation: string | null;
  joiningDate: string;
  avatarUrl: string | null;
  role: RoleName;
  department: { id: string; name: string } | null;
  attendanceRequired: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface IdentityRow {
  id: string;
  employee_code: string;
  full_name: string;
  email: string;
  phone: string | null;
  designation: string | null;
  joining_date: string;
  avatar_url: string | null;
  role: RoleName;
  department_id: string | null;
  department_name: string | null;
  attendance_required: boolean;
  is_active: boolean;
  must_change_password: boolean;
  created_at: Date | string;
  deactivated_at: Date | string | null;
}

/** Columns selected for an identity; keep in sync with {@link IdentityRow}. */
export const IDENTITY_COLUMNS = `
  p.id, p.employee_code, p.full_name, p.email, p.phone, p.designation,
  p.joining_date, p.avatar_url, r.name as role,
  d.id as department_id, d.name as department_name,
  p.attendance_required, p.is_active, p.must_change_password,
  p.created_at, p.deactivated_at`;

export const IDENTITY_FROM = `
  from public.profiles p
  join public.roles r on r.id = p.role_id
  left join public.departments d on d.id = p.department_id`;

const iso = (value: Date | string): string => new Date(value).toISOString();

export function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    designation: row.designation,
    joiningDate: row.joining_date,
    avatarUrl: row.avatar_url,
    role: row.role,
    department: row.department_id
      ? { id: row.department_id, name: row.department_name ?? '' }
      : null,
    attendanceRequired: row.attendance_required,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    createdAt: iso(row.created_at),
    deactivatedAt: row.deactivated_at ? iso(row.deactivated_at) : null,
  };
}

export function toAuthUserDto(identity: Identity): AuthUserDto {
  return {
    id: identity.id,
    employeeCode: identity.employeeCode,
    fullName: identity.fullName,
    email: identity.email,
    phone: identity.phone,
    role: identity.role,
    department: identity.department,
    designation: identity.designation,
    joiningDate: identity.joiningDate,
    avatarUrl: identity.avatarUrl,
    attendanceRequired: identity.attendanceRequired,
    isActive: identity.isActive,
    mustChangePassword: identity.mustChangePassword,
  };
}

export function toEmployeeDto(identity: Identity): EmployeeDto {
  return {
    ...toAuthUserDto(identity),
    createdAt: identity.createdAt,
    deactivatedAt: identity.deactivatedAt,
  };
}

export interface LoadedIdentity {
  /** null when the auth user has no profile (never provisioned by an administrator). */
  identity: Identity | null;
  /** true only while GoTrue still has this session; false after logout / revocation / expiry. */
  sessionActive: boolean;
}

/**
 * One round trip for both questions the auth layer must answer on every request:
 * "who is this, as far as our records go?" and "is this session still alive?".
 */
export async function loadIdentity(
  db: Queryable,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<LoadedIdentity> {
  const { rows } = await db.query<IdentityRow & { session_active: boolean }>(
    `select ${IDENTITY_COLUMNS},
            exists (
              select 1 from auth.sessions s
              where s.id = $2 and s.user_id = p.id
                and (s.not_after is null or s.not_after > $3::timestamptz)
            ) as session_active
     ${IDENTITY_FROM}
     where p.id = $1`,
    [userId, sessionId, now],
  );
  const row = rows[0];
  if (row) return { identity: toIdentity(row), sessionActive: row.session_active };

  // No profile: still report whether the session exists so the caller can revoke it.
  const session = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from auth.sessions s
       where s.id = $1 and s.user_id = $2
         and (s.not_after is null or s.not_after > $3::timestamptz)
     ) as ok`,
    [sessionId, userId, now],
  );
  return { identity: null, sessionActive: session.rows[0]?.ok ?? false };
}

export async function loadIdentityById(db: Queryable, userId: string): Promise<Identity | null> {
  const { rows } = await db.query<IdentityRow>(
    `select ${IDENTITY_COLUMNS} ${IDENTITY_FROM} where p.id = $1`,
    [userId],
  );
  return rows[0] ? toIdentity(rows[0]) : null;
}
