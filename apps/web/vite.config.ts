import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { choosePrecache, type ManifestEntry } from './src/pwa/precache.ts';

// Cross-origin isolation is required for SharedArrayBuffer, which the
// WASM geometry kernel running in Web Workers will depend on.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// The service worker (T7.4a; src/pwa/sw/sw.ts, docs/hosting.md). vite-plugin-pwa builds it from
// our source (`injectManifest`) and only in `vite build`; `devOptions` stays off, so `vite dev`
// has no worker. Registration is ours (src/pwa/register.ts) and the manifest is the static
// public/manifest.webmanifest, so the plugin injects neither.
const pwa = VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src/pwa/sw',
  filename: 'sw.ts',
  injectRegister: false,
  manifest: false,
  devOptions: { enabled: false },
  injectManifest: {
    globPatterns: ['**/*.{html,js,css,wasm,ttf,woff2,svg,png,webmanifest}'],
    // Hashed assets are fetched as they are (their name is their revision); everything else
    // (index.html, the manifest, icons) gets a revision from its content.
    dontCacheBustURLsMatching: /^assets\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/,
    // The size rule (2 MiB, except the kernel's .wasm) is applied in choosePrecache, per file;
    // Workbox's own limit is one number for all of them, so it only has to let the kernel through.
    maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
    manifestTransforms: [
      (entries) => {
        const { manifest, warnings } = choosePrecache(entries as ManifestEntry[]);
        return { manifest: manifest as unknown as typeof entries, warnings };
      },
    ],
  },
});

export default defineConfig({
  plugins: [react(), pwa],
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
