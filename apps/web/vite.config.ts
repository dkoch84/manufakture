import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { choosePrecache, type ManifestEntry } from './src/pwa/precache.ts';
import { checkViewerBundle, kib, type BuiltChunk } from './src/viewer/bundleCheck.ts';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

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

// The read-only viewer (viewer.html, src/viewer/; T7.3b) is a second page of the same build. Its
// chunks must hold no kernel, solver, regen or editor code and stay under a JavaScript budget:
// checked here on every build, so a change that breaks either fails `vite build` and names the
// module (src/viewer/bundleCheck.ts has the rules and the budget).
//
// The service worker precaches viewer.html and its chunks like the app's (the glob above takes
// every .html and .js), so a viewer opened once works offline on a picked file; it adds
// about 15 KB to what the app precaches anyway, since three.js and React are shared chunks.
// viewer.html has a file extension, so the navigation rule (src/pwa/policy.ts) never answers
// it with index.html; Workbox's precache route serves it, also as `/viewer`.
function viewerBundleCheck(): Plugin {
  return {
    name: 'manufakture:viewer-bundle-check',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: BuiltChunk[] = [];
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        chunks.push({
          fileName: file.fileName,
          facadeModuleId: file.facadeModuleId,
          imports: file.imports,
          dynamicImports: file.dynamicImports,
          modules: Object.entries(file.modules)
            .filter(([, m]) => m.renderedLength > 0)
            .map(([id]) => id),
          rawBytes: Buffer.byteLength(file.code),
          gzipBytes: gzipSync(file.code, { level: 9 }).length,
        });
      }
      const report = checkViewerBundle(chunks, appRoot);
      if (!report) return;
      if (report.problems.length > 0) this.error(report.problems.join('\n'));
      this.info(
        `viewer: ${report.files.length} JavaScript files, ${kib(report.rawBytes)} ` +
          `(${kib(report.gzipBytes)} gzip)`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), pwa, viewerBundleCheck()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  build: {
    rolldownOptions: {
      // Two pages: the app and the read-only viewer (T7.3b).
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('viewer.html', import.meta.url)),
      },
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
