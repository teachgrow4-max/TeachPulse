import { z } from 'zod';
import type { RoleName } from './enums.js';

/**
 * Authentication contracts shared by the API, web and mobile apps.
 *
 * The password policy lives here so forms can give instant feedback, but the API enforces it
 * independently: never rely on a client having run these checks.
 */

export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt (used by Supabase Auth) silently ignores everything past 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;

export const CLIENT_KINDS = ['web', 'mobile'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .refine(
    (value) => new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES,
    `Use at most ${PASSWORD_MAX_BYTES} bytes.`,
  )
  .refine((value) => /[a-z]/.test(value), 'Include a lowercase letter.')
  .refine((value) => /[A-Z]/.test(value), 'Include an uppercase letter.')
  .refine((value) => /[0-9]/.test(value), 'Include a digit.');

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  // Not checked against the password policy: an existing password must always be able to sign in.
  password: z.string().min(1).max(256),
  client: z.enum(CLIENT_KINDS).default('web'),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

/**
 * Refresh and logout read the refresh token from the HttpOnly cookie (web). The mobile app has
 * no cookie jar and sends it in the body instead.
 */
export const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(8).max(2048).optional(),
});

export const logoutRequestSchema = z.strictObject({
  refreshToken: z.string().min(8).max(2048).optional(),
  allDevices: z.boolean().default(false),
});

export const changePasswordRequestSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from your current one.',
  });
export type ChangePasswordRequest = z.input<typeof changePasswordRequestSchema>;

export interface DepartmentRef {
  id: string;
  name: string;
}

/** What the signed-in user may know about themselves. */
export interface AuthUserDto {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: RoleName;
  department: DepartmentRef | null;
  designation: string | null;
  /** `YYYY-MM-DD` */
  joiningDate: string;
  avatarUrl: string | null;
  attendanceRequired: boolean;
  isActive: boolean;
  /** While true the API refuses everything except /auth/me, /auth/logout and /auth/change-password. */
  mustChangePassword: boolean;
}

export interface SessionResponse {
  accessToken: string;
  tokenType: 'bearer';
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Unix seconds. */
  expiresAt: number;
  /** Only present for `client: "mobile"`; the web app receives it as an HttpOnly cookie instead. */
  refreshToken?: string;
  user: AuthUserDto;
}

/** Header every cookie-authenticated browser request must send (CSRF defence, see docs/AUTH.md). */
export const CSRF_HEADER_NAME = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'teachgrow-web';
