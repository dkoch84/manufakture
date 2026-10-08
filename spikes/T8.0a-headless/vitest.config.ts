// A plain object, so the config loads without resolving vitest from this folder: the spike has no
// package.json of its own (see README.md), and the root config does not include it.
export default {
  test: {
    name: 'spike-t8-0a-headless',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One file at a time, so timings and resident memory are not measured against each other.
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 300_000,
    // Lets the memory probes force a collection before reading the heap.
    execArgv: ['--expose-gc'],
  },
};
