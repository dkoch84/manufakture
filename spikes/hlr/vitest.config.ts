// A plain object, so the config loads without resolving vitest from this folder: the spike has no
// package.json of its own (see README.md), and the root config does not include it.
export default {
  test: {
    name: 'spike-hlr',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One file at a time, so timings are not measured against each other.
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
};
