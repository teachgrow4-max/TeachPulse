import { beforeEach, describe, expect, it, vi } from 'vitest';

// Replace node-postgres so we can observe exactly which statements the wrapper issues.
const calls: string[] = [];
const client = {
  query: vi.fn(async (sql: string) => {
    calls.push(sql);
    return { rows: [], rowCount: 0 };
  }),
  release: vi.fn(() => {
    calls.push('RELEASE');
  }),
};
const pool = {
  connect: vi.fn(async () => client),
  query: vi.fn(async () => ({ rows: [] })),
  on: vi.fn(),
  end: vi.fn(async () => {}),
};

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => pool),
    types: { setTypeParser: vi.fn(), builtins: { DATE: 1082, INT8: 20 } },
  },
}));

const { createDb } = await import('./pool.js');
const { createLogger } = await import('../lib/logger.js');

const db = createDb(
  { DATABASE_URL: 'postgresql://x', DB_SSL: false, DB_POOL_MAX: 5 },
  createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
);

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('withTransaction', () => {
  it('commits and releases the client on success', async () => {
    const result = await db.withTransaction(async (c) => {
      await c.query('SELECT 1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toEqual(['BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE']);
  });

  it('rolls back, releases, and rethrows the original error on failure', async () => {
    const boom = new Error('constraint violated');
    await expect(
      db.withTransaction(async (c) => {
        await c.query('UPDATE t SET x = 1');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual(['BEGIN', 'UPDATE t SET x = 1', 'ROLLBACK', 'RELEASE']);
    expect(calls).not.toContain('COMMIT');
  });

  it('still releases the client and surfaces the original error if ROLLBACK itself fails', async () => {
    const boom = new Error('original');
    client.query.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    });
    await expect(
      db.withTransaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls.at(-1)).toBe('RELEASE');
  });
});

describe('ping', () => {
  it('issues a trivial query', async () => {
    await db.ping();
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });
});
