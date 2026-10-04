import { defineConfig } from 'vite';

// The browser page for scripts/browser.ts: built into dist/page/ (git-ignored) and served to
// Playwright through a route, so no port is opened.
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist/page', emptyOutDir: true },
});
