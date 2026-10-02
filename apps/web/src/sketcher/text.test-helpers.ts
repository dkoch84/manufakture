// A real text outliner for tests: regen's in-process outliner on the bundled font, read from
// the repository, as a `Texter` (the app's interface to the regen worker's text worker).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTextOutliner } from '@manufakture/regen';
import type { Texter } from './text';

// Found from the working directory (the repository root, or apps/web): under jsdom
// `import.meta.url` is not a file URL.
const FONT = ['.', '..', '../..']
  .map((up) => resolve(process.cwd(), up, 'packages/text/fonts/Inter-Bold.ttf'))
  .find((path) => existsSync(path))!;

/** The bundled font's bytes. */
export function interBold(): Uint8Array {
  return new Uint8Array(readFileSync(FONT));
}

/** A texter that lays text out in this thread (bundled font only), counting its calls. */
export function localTexter(): Texter & { calls: number } {
  const outliner = createTextOutliner({
    fetchImpl: async () => new Response(interBold().slice().buffer),
  });
  const texter = {
    calls: 0,
    outline(request: Parameters<Texter['outline']>[0]) {
      texter.calls++;
      return outliner.outline(request);
    },
    readFont: async () => ({ ok: false as const, message: 'not in tests' }),
  };
  return texter;
}
