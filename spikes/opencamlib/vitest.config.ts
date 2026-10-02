// A plain object, so the config loads without resolving vitest from this folder: the spike has no
// package.json of its own (see README.md), and the root config does not include it.
export default {
  test: {
    name: 'spike-opencamlib',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One file at a time, so timings are not measured against each other.
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 300_000,
    // Lets the memory probe force a collection before reading the JS heap.
    execArgv: ['--expose-gc'],
  },
};
