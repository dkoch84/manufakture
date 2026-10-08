// A plain object, so the config loads without resolving vitest from this folder: the spike has no
// package.json of its own (see README.md), and the root config does not include it.
//
// The M4 bookshelf and the M6 shed are the app's own e2e fixtures (apps/web/e2e), imported by
// path. Those modules import `@playwright/test` for their browser helpers, which the spike never
// calls, so that import is pointed at a stub.
const stub = new URL('./src/playwright-stub.ts', import.meta.url).pathname;

export default {
  resolve: { alias: { '@playwright/test': stub } },
  test: {
    name: 'spike-t8-0b-render',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One file at a time, so timings are not measured against each other.
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
};
