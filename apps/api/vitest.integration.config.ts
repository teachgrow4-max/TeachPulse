import { defineConfig } from 'vitest/config';

/** Integration tests need the local Supabase stack running (`npm run db:start`). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
