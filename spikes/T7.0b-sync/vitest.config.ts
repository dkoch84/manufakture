import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'spike-sync',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
