import { defineConfig } from 'vitest/config';

// Same cross-origin isolation headers as apps/web: the multi-threaded OCCT build
// needs SharedArrayBuffer, which browsers only expose to isolated pages.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  // The page starts the worker with { type: 'module' }. Not required for the
  // pthread workers (measured: the default format also works, because the
  // Emscripten glue is copied verbatim and spawns its own module workers).
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    name: 'spike-occt-worker',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
