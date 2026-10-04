import { defineConfig } from 'vitest/config';

// The spike's checks (`pnpm --filter @manufakture/spike-t7-0c-quickjs test`), a few seconds.
// Not part of the root test run, like the other spikes.
export default defineConfig({
  test: {
    name: 'spike-t7-0c-quickjs',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
