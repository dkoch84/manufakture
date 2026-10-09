// Lets Node load the workspace's TypeScript sources directly: a session's worker threads, and
// apps/mcp, which runs from sources (its start script passes this file to `--import`, and its
// session workers load it again). A host bundled ahead of time would pass its built worker entry
// instead and never load this. Node strips types itself, but the packages use extensionless
// imports (bundler resolution) and a few constructs type stripping refuses (parameter
// properties), so this resolves `./x` to `./x.ts` or `./x/index.ts` and transpiles `.ts` files
// with TypeScript.
// Erasable syntax only, so Node runs this file as it is (`--import`).

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const TS = /\.(?:ts|mts)$/;

/**
 * Packages whose ES module build is only in their `module` field (and no `exports`), as bundlers
 * read it: `opentype.js`, whose `main` is a UMD build Node cannot take named imports from. Not
 * every package's `module` build runs in Node (sucrase's has extensionless imports), so only these.
 */
const MODULE_FIELD = new Set(['opentype.js']);

function moduleField(specifier: string, url: string): string | null {
  const name = specifier;
  if (!MODULE_FIELD.has(name)) return null;
  const marker = `/node_modules/${name}/`;
  const at = url.lastIndexOf(marker);
  if (at < 0) return null;
  const root = url.slice(0, at + marker.length);
  let pkg: { module?: unknown; exports?: unknown };
  try {
    pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as typeof pkg;
  } catch {
    return null;
  }
  if (pkg.exports !== undefined || typeof pkg.module !== 'string') return null;
  return new URL(pkg.module, root).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      const resolved = nextResolve(specifier, context);
      const esm = moduleField(specifier, resolved.url);
      return esm === null ? resolved : { url: esm, format: 'module', shortCircuit: true };
    } catch (error) {
      const relative = specifier.startsWith('.') || specifier.startsWith('/');
      const code = (error as { code?: string }).code;
      if (!relative || (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNSUPPORTED_DIR_IMPORT')) {
        throw error;
      }
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // try the next form
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !TS.test(new URL(url).pathname)) {
      return nextLoad(url, context);
    }
    const loaded = nextLoad(url, { ...context, format: 'module-typescript' });
    const source = String(loaded.source);
    const out = ts.transpileModule(source, {
      fileName: new URL(url).pathname,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        sourceMap: false,
      },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});
