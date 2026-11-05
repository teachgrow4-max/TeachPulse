import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { beginTest, openTestDb, rollbackTest, type TestDb } from './harness.js';

/**
 * Opens one database per test file and wraps every test in a transaction that is rolled back.
 * Usage:  const ctx = useTestDb();   ...   ctx.db.query(...)
 */
export function useTestDb(): { db: TestDb } {
  const ctx = {} as { db: TestDb };

  beforeAll(async () => {
    ctx.db = await openTestDb();
  }, 120_000);

  afterAll(async () => {
    await ctx.db?.close();
  });

  beforeEach(async () => {
    await beginTest(ctx.db);
  });

  afterEach(async () => {
    await rollbackTest(ctx.db);
  });

  return ctx;
}
