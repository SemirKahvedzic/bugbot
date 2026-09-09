import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres, so they run serially: they
 * share one database and would otherwise trip over each other's rows.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
