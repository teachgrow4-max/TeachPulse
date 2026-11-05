import 'dotenv/config';
import { SupabaseAuthGateway } from '../auth/gateway.js';
import { EnvError, loadEnv } from '../config/env.js';
import { createDb } from '../db/pool.js';
import { EmployeeService } from '../employees/service.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import { EXIT, HELP, runBootstrap } from './bootstrap-admin.js';
import { createPrompter } from './prompt.js';

/** Entry point for `npm run bootstrap:admin`. The logic lives in bootstrap-admin.ts. */
async function main(): Promise<void> {
  // Help needs no configuration: print it before the environment is even read.
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(HELP);
    process.exit(EXIT.ok);
  }

  let env;
  try {
    env = loadEnv();
  } catch (error) {
    process.stderr.write(`${error instanceof EnvError ? error.message : String(error)}\n`);
    process.exit(EXIT.invalid);
  }

  const logger = createLogger(env);
  const db = createDb(env, logger);
  const gateway = new SupabaseAuthGateway({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const employees = new EmployeeService({ db, gateway, clock: systemClock, logger });

  let code: number = EXIT.failed;
  try {
    code = await runBootstrap(
      process.argv.slice(2),
      process.env,
      {
        prompter: createPrompter(),
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
        today: () => new Date().toISOString().slice(0, 10),
      },
      employees,
    );
  } catch (error) {
    process.stderr.write(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    await db.end();
  }
  process.exit(code);
}

void main();
