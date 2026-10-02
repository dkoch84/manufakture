import { defineConfig } from 'vitest/config';

// The measurement run (`pnpm --filter @manufakture/spike-clipper2 measure`): one long "test"
// that prints the tables and writes results/measure.json.
export default defineConfig({
  test: {
    name: 'spike-clipper2-measure',
    environment: 'node',
    include: ['scripts/measure.ts'],
    testTimeout: 1_800_000,
    silent: false,
    reporters: ['verbose'],
  },
});
