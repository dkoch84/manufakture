import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// The server as one Node ES module, dist/main.js: the workspace packages (core, sync) are bundled
// in; the npm dependencies (fastify, better-sqlite3 with its native module, zod) stay external and
// load from node_modules, so `pnpm install --prod` plus dist/ is a complete install.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    target: 'node22',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { entryFileNames: 'main.js' },
    },
  },
  ssr: {
    noExternal: [/^@manufakture\//],
  },
});
