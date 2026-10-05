import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { choosePrecache, type ManifestEntry } from './src/pwa/precache.ts';
import { checkViewerBundle, kib, type BuiltChunk } from './src/viewer/bundleCheck.ts';
import { headersFor } from './src/hosting/headers.ts';
import { readSourceInfo, wasmModule } from './src/source/build.ts';
import { NOTICES_FILE, notices } from '../../tools/licenses/index.ts';
import {
  KNOWN_WASM,
  SOURCE_CSS,
  SOURCE_PAGE,
  knownWasmFor,
  renderSourcePage,
  type WasmModule,
} from './src/source/offer.ts';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

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
    // The third-party notices (thirdPartyNotices below) by name, so the source page's link works
    // offline; no other text file is precached.
    globPatterns: ['**/*.{html,js,css,wasm,ttf,woff2,svg,png,webmanifest}', NOTICES_FILE],
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

// The source offer (T7.3c, ADR 0006; src/source/offer.ts): every build writes source.html, naming
// the commit it was built from and the package, version, license and upstream repository of every
// .wasm it ships. A .wasm with no entry in KNOWN_WASM fails the build, so nothing ships without
// its recipe on the page. The app and the viewer link to it ("Source"). It has a file extension,
// so the service worker's navigation rule never answers it with index.html (src/pwa/policy.ts);
// the dev server serves the same page, listing every known module.
function sourceOffer(): Plugin {
  const info = readSourceInfo(repoRoot);
  const page = (modules: WasmModule[]) => renderSourcePage(info, modules);
  return {
    name: 'manufakture:source-offer',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (path !== `/${SOURCE_PAGE}` && path !== '/source.css') return next();
        const css = path === '/source.css';
        const modules = KNOWN_WASM.flatMap((k) => {
          try {
            return [wasmModule(repoRoot, `${k.base}.wasm`, k)];
          } catch {
            return [];
          }
        });
        res.setHeader('Content-Type', css ? 'text/css' : 'text/html; charset=utf-8');
        res.end(css ? SOURCE_CSS : page(modules));
      });
    },
    generateBundle(_options, bundle) {
      if (!info.commit) this.warn('source offer: no commit known; source.html names none');
      if (!info.repository)
        this.warn('source offer: no repository known (set MANUFAKTURE_SOURCE_URL)');
      const modules: WasmModule[] = [];
      for (const fileName of Object.keys(bundle).sort()) {
        if (!fileName.endsWith('.wasm')) continue;
        const known = knownWasmFor(fileName);
        if (!known) {
          this.error(
            `${fileName} has no entry in KNOWN_WASM (src/source/offer.ts): every shipped .wasm ` +
              'must name its package and upstream source on the source page (ADR 0006)',
          );
        }
        modules.push(wasmModule(repoRoot, fileName, known));
      }
      this.emitFile({ type: 'asset', fileName: SOURCE_PAGE, source: page(modules) });
      this.emitFile({ type: 'asset', fileName: 'source.css', source: SOURCE_CSS });
    },
  };
}

// The third-party notices (ADR 0006 decision 5; tools/licenses): every build writes
// third-party-notices.txt, the name, version, license and full license texts of every package in
// the app's production dependency closure, of the components compiled into its .wasm modules and
// of its font. A dependency whose license is not on ADR 0006's allowlist, a shipped .wasm whose
// package is not in the notices, or a font file they do not cover fails the build. source.html
// links to it; the dev server serves the same file.
function thirdPartyNotices(): Plugin {
  return {
    name: 'manufakture:third-party-notices',
    configureServer(server) {
      // Walked once per server start, on the first request; restart the server after an install.
      let text: string | undefined;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${NOTICES_FILE}`) return next();
        text ??= notices(repoRoot, 'web').text;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text);
      });
    },
    generateBundle(_options, bundle) {
      const result = notices(repoRoot, 'web');
      const problems = [...result.problems];
      for (const fileName of Object.keys(bundle).sort()) {
        const base = fileName.split('/').pop()!;
        if (fileName.endsWith('.wasm')) {
          const known = knownWasmFor(fileName);
          if (known && !result.packages.has(known.package)) {
            problems.push(`${fileName}: its package ${known.package} is not in the notices`);
          }
        } else if (/\.(ttf|otf|woff2?)$/i.test(base)) {
          const name = base.replace(/-[A-Za-z0-9_-]{8}(\.[^.]+)$/, '$1');
          if (!result.fontFiles.has(name)) {
            problems.push(`${fileName}: no font entry in tools/licenses/policy.ts covers it`);
          }
        }
      }
      if (problems.length > 0) {
        this.error(`third-party notices (ADR 0006):\n${problems.join('\n')}`);
      }
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: result.text });
    },
  };
}

// `vite preview` sends the production security headers (src/hosting/headers.ts: the
// Content-Security-Policy and the rest of what deploy/Caddyfile sends). Most end-to-end specs bypass
// the policy (playwright.config.ts sets bypassCSP); e2e/csp.spec.ts turns it back on and runs under
// it. Cache-Control is left to preview's own server. The policy is widened for localhost only
// (http and ws), for local share hosts and a local sync server.
function previewSecurityHeaders(): Plugin {
  return {
    name: 'manufakture:preview-security-headers',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '/';
        for (const [name, value] of Object.entries(headersFor(path, { local: true }))) {
          if (name !== 'Cache-Control') res.setHeader(name, value);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    pwa,
    viewerBundleCheck(),
    sourceOffer(),
    thirdPartyNotices(),
    previewSecurityHeaders(),
  ],
  // COOP/COEP stay in dev and preview for parity with the spikes (ADR 0002); production sends COOP
  // only (deploy/Caddyfile), since nothing needs cross-origin isolation.
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
