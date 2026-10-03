import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Cross-origin isolation is required for SharedArrayBuffer, which the
// WASM geometry kernel running in Web Workers will depend on.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  build: {
    rolldownOptions: {
      output: {
        // three.js is most of the app's JavaScript and changes far less often
        // than the app, so it gets chunks of its own that cache separately.
        // Split along three's own seam (the renderer-independent core and the
        // WebGL renderer) so no chunk exceeds the size warning.
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /[\\/]node_modules[\\/]three[\\/]build[\\/]three\.core/ },
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  // The kernel worker is started with { type: 'module' } (packages/kernel README).
  worker: { format: 'es' },
  // Manifold's glue (loaded lazily by the regen worker for framing members with cuts) finds its
  // .wasm with `new URL('manifold.wasm', import.meta.url)`. The production build emits that file
  // as its own asset; the dev server's dependency pre-bundling would move the glue away from it,
  // so the dev server serves the package as it is.
  optimizeDeps: { exclude: ['manifold-3d'] },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Playwright specs in e2e/ run in a real browser, never in the unit run.
    include: ['src/**/*.test.{ts,tsx}'],
    // Some component tests run real work in process (the CAM simulation of the toolpath preview,
    // archive inflation in persistence) and take a few seconds alone; under a full parallel run
    // they can pass vitest's 5 s default without anything being wrong. A hang still fails.
    testTimeout: 30_000,
  },
});
