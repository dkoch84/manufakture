import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The kernel memory bench (memory.bench.ts) on its own: not part of `vitest run`'s projects, since
// it spawns processes and takes minutes. `make bench-memory` runs it.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['memory.bench.ts'],
    environment: 'node',
    // One file, one measurement at a time.
    fileParallelism: false,
    testTimeout: 3_600_000,
  },
});
