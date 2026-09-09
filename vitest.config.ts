import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests need a real database; npm run test:integration.
    exclude: ['test/integration/**'],
    restoreMocks: true,
  },
});
