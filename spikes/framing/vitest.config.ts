import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'spike-framing',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
