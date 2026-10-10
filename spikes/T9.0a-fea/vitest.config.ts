// A plain object, so the config loads without resolving vitest from this folder (see README.md).
export default {
  test: {
    name: 'spike-t9-0a-fea',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One file at a time, so timings and memory are not measured against each other.
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    execArgv: ['--expose-gc', '--max-old-space-size=8192'],
  },
};
