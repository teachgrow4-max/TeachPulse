import pg from 'pg';
import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';

const { Pool, types } = pg;

// `date` columns are calendar dates in the office timezone. Returning them as
// 'YYYY-MM-DD' strings stops node-postgres turning them into a JS Date at local midnight,
// which silently shifts the day when the host timezone differs from Asia/Kolkata.
types.setTypeParser(types.builtins.DATE, (value: string) => value);
// bigint identity ids exceed Number.MAX_SAFE_INTEGER only in theory, but strings are
// JSON-safe and avoid precision surprises.
types.setTypeParser(types.builtins.INT8, (value: string) => value);

/**
 * The minimal query surface services depend on. Both the pool and a transaction client satisfy
 * it, which is what lets the same service code run inside or outside a transaction (and against
 * the embedded test database).
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a single transaction. Commits on success, rolls back on any throw. */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Cheap connectivity check for readiness probes. */
  ping(): Promise<void>;
  end(): Promise<void>;
}

export function createDb(
  env: Pick<Env, 'DATABASE_URL' | 'DB_SSL' | 'DB_POOL_MAX'>,
  logger: Logger,
): Db {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Bound how long any single statement / idle transaction can hold locks.
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: 'teachgrow-api',
    ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
  });

  // An idle client erroring (e.g. the DB restarted) must not crash the process.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'unexpected error on idle database client');
  });

  return {
    query: (text, params) => pool.query(text, params as unknown[] | undefined),

    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          query: (text, params) =>
            client.query(text, params as unknown[] | undefined) as Promise<{
              rows: never[];
              rowCount: number | null;
            }>,
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'rollback failed');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    end: () => pool.end(),
  };
}
