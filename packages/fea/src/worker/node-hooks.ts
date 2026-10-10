// Lets a Node worker thread load this package's TypeScript sources directly (development, tests
// and a session run from sources): resolves the extensionless relative imports the packages use
// (bundler resolution) to `.ts` files. Node strips the types itself; the package is written in
// erasable syntax only (tsconfig `erasableSyntaxOnly`), so no transpiler is needed. A host bundled
// ahead of time passes its built worker entry and never loads this.

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
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
});
