import 'dotenv/config';
import { createApp } from './app.js';
import { EnvError, loadEnv } from './config/env.js';
import { createDb } from './db/pool.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    // The logger needs a valid env, so a config failure is reported on stderr and we exit.
    process.stderr.write(`${error instanceof EnvError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const logger = createLogger(env);
  const db = createDb(env, logger);
  const app = createApp({ env, logger, db, clock: systemClock });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close(() => {
      db.end()
        .catch((error: unknown) => logger.error({ err: error }, 'error closing database pool'))
        .finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

main();
