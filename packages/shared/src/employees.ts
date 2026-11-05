import { z } from 'zod';
import type { AuthUserDto } from './auth.js';
import { emailSchema, passwordSchema } from './auth.js';
import { ROLE_NAMES } from './enums.js';
import { isoDateSchema, uuidSchema } from './schemas.js';

/** Letters, digits, dot, dash, underscore; 1-32 chars. Mirrors the database constraint. */
export const employeeCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/,
    'Use letters, digits, dot, dash or underscore (max 32 characters).',
  );

const fullNameSchema = z.string().trim().min(1).max(150);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+()\-\s]{5,32}$/, 'Enter a valid phone number.');
const designationSchema = z.string().trim().min(1).max(100);

export const createEmployeeSchema = z.strictObject({
  employeeCode: employeeCodeSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  phone: phoneSchema.nullable().optional(),
  departmentId: uuidSchema.nullable().optional(),
  designation: designationSchema.nullable().optional(),
  joiningDate: isoDateSchema,
  role: z.enum(ROLE_NAMES).default('employee'),
  /** Defaults to true for employees, false for admins and the office display. */
  attendanceRequired: z.boolean().optional(),
  /** Leave out to have a strong temporary password generated and returned once. */
  initialPassword: passwordSchema.optional(),
  /** Defaults to true (false for the office display account). */
  requirePasswordChange: z.boolean().optional(),
});
export type CreateEmployeeInput = z.output<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z
  .strictObject({
    fullName: fullNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    departmentId: uuidSchema.nullable().optional(),
    designation: designationSchema.nullable().optional(),
    joiningDate: isoDateSchema.optional(),
    role: z.enum(ROLE_NAMES).optional(),
    attendanceRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change.');
export type UpdateEmployeeInput = z.output<typeof updateEmployeeSchema>;

export const EMPLOYEE_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

export const listEmployeesQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : undefined)),
  departmentId: uuidSchema.optional(),
  role: z.enum(ROLE_NAMES).optional(),
  status: z.enum(EMPLOYEE_STATUS_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListEmployeesQuery = z.output<typeof listEmployeesQuerySchema>;

export const createDepartmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

export interface DepartmentDto {
  id: string;
  name: string;
  isActive: boolean;
}

export interface EmployeeDto extends AuthUserDto {
  createdAt: string;
  deactivatedAt: string | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateEmployeeResponse {
  employee: EmployeeDto;
  /** Present only when the server generated the password. Shown once, never stored or logged. */
  temporaryPassword?: string;
}

export interface UpdateEmployeeResponse {
  employee: EmployeeDto;
  /** e.g. `AUTH_PROVIDER_SYNC_FAILED` if the sign-in provider could not be updated. */
  warnings?: string[];
}

export interface ResetPasswordResponse {
  temporaryPassword: string;
}
