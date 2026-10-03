import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The house bench (house.bench.ts) on its own: not part of `vitest run`'s projects, since it
// spawns processes and takes minutes. `make bench-house` runs it.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['house.bench.ts'],
    environment: 'node',
    // One file, one measurement at a time.
    fileParallelism: false,
    testTimeout: 1_800_000,
  },
});
