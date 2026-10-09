// What a Node host gives the regen engine (ADR 0016 decision 2, T8.0a "Risks"): the bundled font
// read from disk, since Node's `fetch` refuses `file:` URLs; and a domain registry of its own
// with stock, woodworking and construction, as the app's regen worker registers them. Used both
// in this thread (`InProcessEngine`) and in a session's worker thread (`worker/entry.ts`).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerConstruction } from '@manufakture/domain-construction';
import { registerWood } from '@manufakture/domain-wood';
import type { WasmSource } from '@manufakture/kernel';
import { STDERR_OUTPUT } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  createRegenWorkerApi,
  createTextOutliner,
  type RegenWorkerApi,
} from '@manufakture/regen';
import { registerStock } from '@manufakture/stock';

/**
 * `fetch` for the bundled fonts (`@manufakture/text` finds them with `new URL(..., import.meta.url)`):
 * `file:` URLs only, so a crafted document can never make the host fetch from the network. The
 * text package checks the bytes against the font's pinned SHA-256.
 */
export async function readBundledFont(url: URL): Promise<Response> {
  if (url.protocol !== 'file:') throw new Error('Only bundled fonts are read.');
  return new Response(new Uint8Array(await readFile(fileURLToPath(url))));
}

/** A registry with the domains the app's regen worker registers. */
export function nodeExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registerStock(registry);
  registerWood(registry);
  registerConstruction(registry);
  return registry;
}

/**
 * The regen worker API (`createRegenWorkerApi`) for a session: its own kernel service on
 * `source`, the solver, the bundled fonts (user fonts are refused: they would be parsed with no
 * time limit), and the domains. Scripted features are not run (the API's policy denies all).
 * The kernel's text output (the STEP writer's statistics) goes to stderr: a host's stdout may
 * carry a protocol (apps/mcp).
 */
export function sessionEngineApi(source: WasmSource): RegenWorkerApi {
  return createRegenWorkerApi({
    source,
    loader: STDERR_OUTPUT,
    engine: {
      text: createTextOutliner({ fetchImpl: readBundledFont }),
      extensions: nodeExtensions(),
    },
  });
}
