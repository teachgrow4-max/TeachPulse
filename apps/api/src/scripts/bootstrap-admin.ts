import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { AuthGatewayError } from '../auth/gateway.js';
import { bootstrapFirstAdmin, ADMIN_EXISTS_MESSAGE } from '../employees/bootstrap.js';
import type { EmployeeService } from '../employees/service.js';
import { AppError } from '../lib/errors.js';
import type { Prompter } from './prompt.js';

/**
 * One-time setup: create the first administrator.
 *
 *   npm run bootstrap:admin -w @teachgrow/api
 *   npm run bootstrap:admin -w @teachgrow/api -- --email hr@example.com --name "Asha Rao" --code TG-001
 *
 * Anything not given as a flag or BOOTSTRAP_ADMIN_* variable is asked for. The password is read
 * with no echo (or from BOOTSTRAP_ADMIN_PASSWORD for automation) and is never printed.
 */

export const EXIT = { ok: 0, invalid: 1, adminExists: 2, failed: 3 } as const;

export const HELP = `Create the first TeachGrow Attendance administrator.

Options (or the matching BOOTSTRAP_ADMIN_* environment variable):
  --email <address>            BOOTSTRAP_ADMIN_EMAIL
  --name <full name>           BOOTSTRAP_ADMIN_NAME
  --code <employee id>         BOOTSTRAP_ADMIN_CODE
  --joining-date <YYYY-MM-DD>  BOOTSTRAP_ADMIN_JOINING_DATE (default: today)
  --tracks-attendance          this administrator also marks their own attendance
  --require-password-change    force a new password at first sign-in
  (password)                   BOOTSTRAP_ADMIN_PASSWORD, otherwise prompted without echo

Refuses to run if an administrator already exists.
`;

export interface CliIo {
  prompter: Prompter;
  out(text: string): void;
  err(text: string): void;
  today(): string;
}

export async function runBootstrap(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  employees: EmployeeService,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        code: { type: 'string' },
        'joining-date': { type: 'string' },
        'tracks-attendance': { type: 'boolean', default: false },
        'require-password-change': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return EXIT.invalid;
  }

  if (values.help) {
    io.out(HELP);
    return EXIT.ok;
  }

  const need = async (
    flag: string | undefined,
    envName: string,
    question: string,
    fallback?: string,
  ): Promise<string | undefined> => {
    const given = flag ?? env[envName];
    if (given !== undefined && given !== '') return given;
    if (fallback !== undefined) return fallback;
    return io.prompter.interactive ? (await io.prompter.ask(question)).trim() : undefined;
  };

  try {
    const email = await need(values.email, 'BOOTSTRAP_ADMIN_EMAIL', 'Administrator email: ');
    const fullName = await need(values.name, 'BOOTSTRAP_ADMIN_NAME', 'Full name: ');
    const employeeCode = await need(values.code, 'BOOTSTRAP_ADMIN_CODE', 'Employee ID: ');
    const joiningDate = await need(
      values['joining-date'],
      'BOOTSTRAP_ADMIN_JOINING_DATE',
      'Joining date (YYYY-MM-DD): ',
      io.today(),
    );

    let password: string | undefined = env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!password && io.prompter.interactive) {
      password = await io.prompter.askSecret('Password (min 10 chars, upper+lower+digit): ');
      const confirm = await io.prompter.askSecret('Repeat password: ');
      if (password !== confirm) {
        io.err('The passwords do not match.\n');
        return EXIT.invalid;
      }
    }

    const missing = Object.entries({ email, name: fullName, code: employeeCode, password })
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      io.err(
        `Missing: ${missing.join(', ')}. Provide flags / BOOTSTRAP_ADMIN_* variables, or run in a terminal.\n`,
      );
      return EXIT.invalid;
    }

    const admin = await bootstrapFirstAdmin(employees, {
      employeeCode: employeeCode!,
      fullName: fullName!,
      email: email!,
      password: password!,
      joiningDate: joiningDate!,
      tracksAttendance: values['tracks-attendance'],
      requirePasswordChange: values['require-password-change'],
    });

    io.out(
      `Administrator created: ${admin.fullName} <${admin.email}> (employee ID ${admin.employeeCode}).\n` +
        'Sign in with the web app; this account can now create every other account.\n',
    );
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ZodError) {
      io.err(
        'Invalid input:\n' +
          error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n') +
          '\n',
      );
      return EXIT.invalid;
    }
    if (error instanceof AppError && error.code === 'CONFLICT') {
      io.err(`${error.message}\n`);
      return error.message === ADMIN_EXISTS_MESSAGE ? EXIT.adminExists : EXIT.invalid;
    }
    if (error instanceof AppError && error.code === 'VALIDATION_FAILED') {
      io.err(`Invalid input: ${JSON.stringify(error.details)}\n`);
      return EXIT.invalid;
    }
    if (error instanceof AuthGatewayError || error instanceof AppError) {
      io.err(`Could not create the administrator: ${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
}
