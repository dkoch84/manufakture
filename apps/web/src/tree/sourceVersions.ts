// The version lists of the source documents of a part's derived parts, for the feature tree's
// Update available. Read once per set of source documents (and again when `refresh` moves), one
// short library call per document, so the open document's autosave never waits long behind them.

import { useEffect, useState } from 'react';
import type { PinLibrary } from '../features/derived';
import type { Version } from '@manufakture/library';

const NONE: ReadonlyMap<string, Version[] | null> = new Map();

/** The version lists of `documentIds` (null for one that cannot be listed), by document id. */
export function useSourceVersions(
  library: PinLibrary | null,
  documentIds: readonly string[],
  refresh: number,
): ReadonlyMap<string, Version[] | null> {
  const key = [...new Set(documentIds)].sort().join('\n');
  const [read, setRead] = useState<{ key: string; lists: ReadonlyMap<string, Version[] | null> }>({
    key: '',
    lists: NONE,
  });
  useEffect(() => {
    if (!library || key === '') return;
    let cancelled = false;
    void Promise.all(
      key.split('\n').map(async (id): Promise<[string, Version[] | null]> => {
        try {
          const r = await library.listVersions(id);
          return [id, r.ok ? r.value : null];
        } catch {
          return [id, null];
        }
      }),
    ).then((entries) => {
      if (!cancelled) setRead({ key, lists: new Map(entries) });
    });
    return () => {
      cancelled = true;
    };
  }, [library, key, refresh]);
  // Lists read for another set of documents say nothing about these.
  return library && read.key === key ? read.lists : NONE;
}
