import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_STATUSES,
  changePasswordRequestSchema,
  createEmployeeSchema,
  emailSchema,
  listEmployeesQuerySchema,
  loginRequestSchema,
  passwordSchema,
  updateEmployeeSchema,
  ERROR_STATUS,
  MANDATORY_CHECK_IN_LAYERS,
  VERIFICATION_LAYERS,
  idempotencyKeySchema,
  isErrorCode,
  isoDateSchema,
  paginationSchema,
  timeOfDaySchema,
} from './index.js';

describe('enums', () => {
  it('mandatory check-in layers are a subset of all layers', () => {
    for (const layer of MANDATORY_CHECK_IN_LAYERS) {
      expect(VERIFICATION_LAYERS).toContain(layer);
    }
  });

  it('late and present are separate classifications', () => {
    expect(ATTENDANCE_STATUSES).toContain('PRESENT');
    expect(ATTENDANCE_STATUSES).toContain('LATE');
  });
});

describe('error codes', () => {
  it('maps every code to a valid HTTP error status', () => {
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('recognises only known codes', () => {
    expect(isErrorCode('ALREADY_CHECKED_IN')).toBe(true);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('SOMETHING_ELSE')).toBe(false);
  });
});

describe('schemas', () => {
  it('accepts valid dates and rejects invalid ones', () => {
    expect(isoDateSchema.safeParse('2026-11-05').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-13-05').success).toBe(false);
    expect(isoDateSchema.safeParse('05/11/2026').success).toBe(false);
  });

  it('validates time of day at the boundaries', () => {
    expect(timeOfDaySchema.safeParse('10:20').success).toBe(true);
    expect(timeOfDaySchema.safeParse('10:19:59').success).toBe(true);
    expect(timeOfDaySchema.safeParse('24:00').success).toBe(false);
    expect(timeOfDaySchema.safeParse('9:5').success).toBe(false);
  });

  it('applies pagination defaults and bounds', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(paginationSchema.safeParse({ pageSize: 1000 }).success).toBe(false);
    expect(paginationSchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it('restricts idempotency keys to a safe alphabet', () => {
    expect(idempotencyKeySchema.safeParse('a1b2c3d4-e5f6').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse("bad key'; drop table").success).toBe(false);
  });
});

describe('authentication schemas', () => {
  it('enforces the password policy with a helpful message per rule', () => {
    expect(passwordSchema.safeParse('Str0ng-Passw0rd!').success).toBe(true);
    expect(passwordSchema.safeParse('Abcdefghi1').success).toBe(true); // exactly 10 characters
    const messages = (value: string) =>
      passwordSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages('Ab1')).toContain('Use at least 10 characters.');
    expect(messages('alllowercase1')).toContain('Include an uppercase letter.');
    expect(messages('ALLUPPERCASE1')).toContain('Include a lowercase letter.');
    expect(messages('NoDigitsHereAtAll')).toContain('Include a digit.');
    // Every failing rule is reported at once, not one per attempt.
    expect(messages('short')).toHaveLength(3);
  });

  it('rejects passwords that bcrypt would silently truncate (over 72 bytes)', () => {
    expect(passwordSchema.safeParse(`Aa1${'x'.repeat(69)}`).success).toBe(true); // 72 bytes
    expect(passwordSchema.safeParse(`Aa1${'x'.repeat(70)}`).success).toBe(false); // 73 bytes
    expect(passwordSchema.safeParse(`Aa1${'é'.repeat(36)}`).success).toBe(false); // 72 chars, 75 bytes
  });

  it('normalises and validates email addresses', () => {
    expect(emailSchema.parse('  Asha.Rao@TeachGrow.Test ')).toBe('asha.rao@teachgrow.test');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
  });

  it('parses a login request, defaulting to the web client and refusing unknown fields', () => {
    const parsed = loginRequestSchema.parse({ email: 'A@B.CO', password: 'x' });
    expect(parsed).toEqual({ email: 'a@b.co', password: 'x', client: 'web' });
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x', client: 'tv' }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x', role: 'admin' }).success,
    ).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(300) }).success,
    ).toBe(false);
  });

  it('does not hold an existing password to the new-password policy at sign-in', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'old' }).success).toBe(true);
  });

  it('requires a genuinely new password when changing it', () => {
    const base = { currentPassword: 'Old-Passw0rd!x', newPassword: 'New-Passw0rd!x' };
    expect(changePasswordRequestSchema.safeParse(base).success).toBe(true);
    const same = changePasswordRequestSchema.safeParse({
      ...base,
      newPassword: base.currentPassword,
    });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.path).toEqual(['newPassword']);
    expect(changePasswordRequestSchema.safeParse({ ...base, newPassword: 'weak' }).success).toBe(
      false,
    );
  });
});

describe('employee schemas', () => {
  const valid = {
    employeeCode: 'TG-001',
    fullName: '  Asha Rao ',
    email: 'Asha@TeachGrow.test',
    joiningDate: '2026-11-02',
  };

  it('parses a create request with sensible defaults', () => {
    const parsed = createEmployeeSchema.parse(valid);
    expect(parsed).toMatchObject({
      employeeCode: 'TG-001',
      fullName: 'Asha Rao',
      email: 'asha@teachgrow.test',
      role: 'employee',
    });
    expect(parsed.initialPassword).toBeUndefined();
  });

  it('refuses mass-assignment: fields a caller must not set are rejected, not ignored', () => {
    for (const extra of [
      { id: 'x' },
      { isActive: false },
      { createdBy: 'x' },
      { mustChangePassword: false },
    ]) {
      expect(createEmployeeSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it.each([
    ['an employee id with spaces', { employeeCode: 'TG 001' }],
    ['an employee id starting with a dash', { employeeCode: '-001' }],
    ['an employee id over 32 characters', { employeeCode: 'A'.repeat(33) }],
    ['an empty name', { fullName: '   ' }],
    ['an unknown role', { role: 'superuser' }],
    ['a malformed joining date', { joiningDate: '02-11-2026' }],
    ['a weak initial password', { initialPassword: 'password' }],
    ['a non-UUID department', { departmentId: '123' }],
    ['a nonsense phone number', { phone: 'call me' }],
  ])('rejects %s', (_label, patch) => {
    expect(createEmployeeSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('allows clearing optional fields with null on update, but not an empty update', () => {
    expect(updateEmployeeSchema.safeParse({ departmentId: null, phone: null }).success).toBe(true);
    expect(updateEmployeeSchema.safeParse({}).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ email: 'new@teachgrow.test' }).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ employeeCode: 'X' }).success).toBe(false);
  });

  it('coerces and bounds the list query', () => {
    expect(listEmployeesQuerySchema.parse({})).toEqual({ status: 'all', page: 1, pageSize: 50 });
    expect(
      listEmployeesQuerySchema.parse({ page: '3', pageSize: '25', search: '  ' }).search,
    ).toBeUndefined();
    expect(listEmployeesQuerySchema.parse({ search: ' asha ' }).search).toBe('asha');
    expect(listEmployeesQuerySchema.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(listEmployeesQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
    expect(listEmployeesQuerySchema.safeParse({ role: 'root' }).success).toBe(false);
  });
});
