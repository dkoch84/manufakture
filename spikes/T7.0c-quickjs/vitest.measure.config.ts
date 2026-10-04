import { defineConfig } from 'vitest/config';

// The measurement run (`pnpm --filter @manufakture/spike-t7-0c-quickjs measure`): one long
// "test" that measures in Node, builds the browser page, runs it in Chromium, Firefox and WebKit,
// prints the tables and writes results/*.json.
export default defineConfig({
  test: {
    name: 'spike-t7-0c-quickjs-measure',
    environment: 'node',
    include: ['scripts/measure.ts'],
    testTimeout: 1_800_000,
    silent: false,
    reporters: ['verbose'],
  },
});
