import { defineConfig } from 'vitest/config';

// Cross-origin isolation, as in apps/web. Besides matching the app, it gives
// the page 5 us performance.now() resolution instead of 100 us, which matters
// for sub-millisecond solve timings.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    name: 'spike-planegcs',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
