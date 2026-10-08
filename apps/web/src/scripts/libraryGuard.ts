// What is allowed to run is kept by document id (policy.ts), and a `.mfk` file keeps its
// document's id when this device has no document with it. So a file could arrive under the id of
// a document the user once allowed and then deleted, and run its scripts without asking. The app
// therefore forgets a document's grants when the document is deleted and when a file is imported
// under its id, before the imported document opens.

import type { DocumentLibrary } from '@manufakture/library';
import type { ScriptGrantsStore } from './policy';

/** `library`, forgetting a document's script grants on `remove` and on `importMfk`. */
export function forgettingScriptGrants(
  library: DocumentLibrary,
  grants: ScriptGrantsStore,
): DocumentLibrary {
  return new Proxy(library, {
    get(target, key) {
      if (key === 'importMfk') {
        return async (...args: Parameters<DocumentLibrary['importMfk']>) => {
          const r = await target.importMfk(...args);
          if (r.ok) grants.getState().forget(r.value.summary.id);
          return r;
        };
      }
      if (key === 'remove') {
        return async (...args: Parameters<DocumentLibrary['remove']>) => {
          const done = await target.remove(...args);
          grants.getState().forget(args[0]);
          return done;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
