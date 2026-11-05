import type { EmployeeDto } from '@teachgrow/shared';
import { createEmployeeSchema, type CreateEmployeeInput } from '@teachgrow/shared';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { NO_META } from '../lib/request-meta.js';
import type { EmployeeService } from './service.js';

/**
 * Creates the FIRST administrator, the one account that cannot be made through the API because
 * the API requires an administrator. It refuses to run if any administrator already exists,
 * and the check is repeated inside the insert transaction under an advisory lock, so two
 * simultaneous runs cannot both succeed.
 */

export interface BootstrapInput {
  employeeCode: string;
  fullName: string;
  email: string;
  password: string;
  joiningDate: string;
  /** Does this administrator also mark their own attendance? */
  tracksAttendance: boolean;
  /** Force a password change at first sign-in even though the operator chose the password. */
  requirePasswordChange: boolean;
}

export const ADMIN_EXISTS_MESSAGE =
  'An administrator already exists. Sign in as that administrator to create more accounts.';

async function assertNoAdministrator(q: Queryable): Promise<void> {
  await q.query(`select pg_advisory_xact_lock(hashtext('teachgrow.bootstrap_admin'))`);
  const { rows } = await q.query<{ n: string }>(
    `select count(*)::text as n
     from public.profiles p join public.roles r on r.id = p.role_id
     where r.name = 'admin'`,
  );
  if (Number(rows[0]?.n ?? 0) > 0) throw new AppError('CONFLICT', ADMIN_EXISTS_MESSAGE);
}

export async function bootstrapFirstAdmin(
  employees: EmployeeService,
  input: BootstrapInput,
): Promise<EmployeeDto> {
  const parsed: CreateEmployeeInput = createEmployeeSchema.parse({
    employeeCode: input.employeeCode,
    fullName: input.fullName,
    email: input.email,
    joiningDate: input.joiningDate,
    role: 'admin',
    attendanceRequired: input.tracksAttendance,
    initialPassword: input.password,
    requirePasswordChange: input.requirePasswordChange,
  });

  const { employee } = await employees.create(parsed, null, NO_META, {
    auditAction: 'bootstrap.admin_created',
    guard: assertNoAdministrator,
  });
  return employee;
}
