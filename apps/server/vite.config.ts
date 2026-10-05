import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { NOTICES_FILE, notices } from '../../tools/licenses/index.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// dist/third-party-notices.txt (ADR 0006 decision 5; tools/licenses): the license texts of every
// npm package the deploy installs beside dist/ and of SQLite inside better-sqlite3. It ships with
// dist/ (package.json "files"), so the image has it at /app/dist. A dependency whose license is not
// on ADR 0006's allowlist fails the build.
function thirdPartyNotices(): Plugin {
  return {
    name: 'manufakture:third-party-notices',
    apply: 'build',
    generateBundle() {
      const result = notices(repoRoot, 'server');
      if (result.problems.length > 0) {
        this.error(`third-party notices (ADR 0006):\n${result.problems.join('\n')}`);
      }
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: result.text });
    },
  };
}

// The server as one Node ES module, dist/main.js: the workspace packages (core, sync) are bundled
// in; the npm dependencies (fastify, better-sqlite3 with its native module, zod) stay external and
// load from node_modules, so `pnpm install --prod` plus dist/ is a complete install.
export default defineConfig({
  plugins: [thirdPartyNotices()],
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
