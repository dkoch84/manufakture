// A plain object, so the config loads without resolving vitest from this folder: the spike has no
// package.json of its own (see README.md), and the root config does not include it.
export default {
  test: {
    name: 'spike-t9-0b-sim',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
  },
};
