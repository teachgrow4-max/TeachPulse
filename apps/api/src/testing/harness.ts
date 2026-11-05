import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import pg from 'pg';

/**
 * Database test harness.
 *
 *   default                     -> embedded Postgres (PGlite), migrations applied from scratch.
 *   TEST_DATABASE_URL=postgres: -> a real Supabase database that already has the migrations
 *                                  (e.g. `supabase start` + `supabase db reset`).
 *
 * Every test runs inside a transaction that is rolled back, so tests never leak state.
 */

export interface DbError extends Error {
  code?: string;
  constraint?: string;
}

export interface TestDb {
  engine: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
const BOOTSTRAP_SQL = fileURLToPath(new URL('./bootstrap.sql', import.meta.url));

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function openPglite(): Promise<TestDb> {
  const db = new PGlite({
    extensions: { btree_gist },
    // Keep `date` as 'YYYY-MM-DD' text (matches the API's pg configuration) and big ints as text.
    parsers: {
      [pgliteTypes.DATE]: (value: string) => value,
      [pgliteTypes.INT8]: (value: string) => value,
    },
  });
  await db.waitReady;
  await db.exec(readFileSync(BOOTSTRAP_SQL, 'utf8'));
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8'));
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return {
    engine: 'pglite',
    query: async <T>(sql: string, params?: unknown[]) =>
      (await db.query<T>(sql, params)).rows as T[],
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

async function openPostgres(url: string): Promise<TestDb> {
  pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    engine: 'postgres',
    query: async <T>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)).rows as T[],
    exec: async (sql) => {
      await client.query(sql);
    },
    close: () => client.end(),
  };
}

export async function openTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  return url ? openPostgres(url) : openPglite();
}

/** Start a per-test transaction. Pair with `rollbackTest`. */
export async function beginTest(db: TestDb): Promise<void> {
  await db.exec('begin');
}

export async function rollbackTest(db: TestDb): Promise<void> {
  await db.exec('rollback');
}

/**
 * Runs a statement that is expected to fail without poisoning the surrounding transaction
 * (a failed statement otherwise aborts it). Returns the error, or null if it succeeded.
 */
export async function attempt(
  db: TestDb,
  sql: string,
  params?: unknown[],
): Promise<DbError | null> {
  await db.exec('savepoint attempt_sp');
  try {
    await db.query(sql, params);
    await db.exec('release savepoint attempt_sp');
    return null;
  } catch (error) {
    await db.exec('rollback to savepoint attempt_sp');
    return error as DbError;
  }
}

/**
 * Run `fn` as an end user so RLS and privileges apply. Everything done inside (including the
 * role switch and JWT claims) is undone afterwards via a savepoint rollback, so this is meant
 * for read and permission probes, not for setting up data.
 */
export async function asUser<T>(
  db: TestDb,
  userId: string,
  fn: () => Promise<T>,
  role: 'authenticated' | 'anon' = 'authenticated',
): Promise<T> {
  await db.exec('savepoint as_user_sp');
  try {
    await db.query(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify({ sub: userId, role }), userId],
    );
    await db.exec(`set local role ${role}`);
    return await fn();
  } finally {
    // Rolling back first also clears an aborted-transaction state left by a failed statement.
    await db.exec('rollback to savepoint as_user_sp');
    await db.exec('release savepoint as_user_sp');
  }
}
