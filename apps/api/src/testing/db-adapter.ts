import type { Db, Queryable } from '../db/pool.js';
import type { TestDb } from './harness.js';

/**
 * Presents the single-connection test database as the API's `Db`.
 *
 * Every test already runs inside an outer transaction (rolled back afterwards), so:
 *   - `withTransaction` becomes a SAVEPOINT: commit = release, throw = roll back to it.
 *   - a lone `query` is wrapped in its own savepoint so a failing statement does not poison the
 *     rest of the test, mirroring autocommit on a real connection pool.
 */
export function dbFromTestDb(test: TestDb): Db {
  let counter = 0;

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    counter += 1;
    const name = `adapter_sp_${counter}`;
    await test.exec(`savepoint ${name}`);
    try {
      const result = await fn();
      await test.exec(`release savepoint ${name}`);
      return result;
    } catch (error) {
      await test.exec(`rollback to savepoint ${name}`);
      await test.exec(`release savepoint ${name}`);
      throw error;
    }
  };

  const raw: Queryable = {
    query: async <T extends object>(text: string, params?: readonly unknown[]) => {
      const rows = await test.query<T>(text, params as unknown[] | undefined);
      return { rows: rows as never[], rowCount: rows.length };
    },
  };

  return {
    query: (text, params) => guarded(() => raw.query(text, params)),
    withTransaction: (fn) => guarded(() => fn(raw)),
    ping: async () => {
      await test.query('select 1');
    },
    end: async () => {},
  };
}
