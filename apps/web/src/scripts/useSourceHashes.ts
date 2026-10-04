// The SHA-256 of script sources, computed in the background (Web Crypto is asynchronous) and kept
// while the sources stay the same: what the banner compares with the allowed sources.

import { useEffect, useMemo, useState } from 'react';
import { sourceSha256 } from './policy';

/** The SHA-256 of each source in `sources`, keyed by the source; a source not hashed yet is absent. */
export function useSourceHashes(sources: readonly string[]): ReadonlyMap<string, string> {
  const [hashes, setHashes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const key = sources.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wanted = useMemo(() => [...new Set(sources)], [key]);
  useEffect(() => {
    const missing = wanted.filter((s) => !hashes.has(s));
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(missing.map(async (s) => [s, await sourceSha256(s)] as const)).then((done) => {
      if (!live) return;
      setHashes((before) => {
        const got = new Map(done);
        const next = new Map<string, string>();
        // Only the sources still wanted, so the map does not grow with every edit.
        for (const s of wanted) {
          const h = before.get(s) ?? got.get(s);
          if (h !== undefined) next.set(s, h);
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [wanted, hashes]);
  return hashes;
}
