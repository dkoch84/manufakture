// The Node host of a session: the kernel service on the pinned libcascade build read from disk
// (`createNodeService`), the planegcs solver in this thread, the bundled fonts read from disk, and
// the domains the app's regen worker registers (apps/web/src/viewport/regen-worker.ts: stock,
// woodworking, construction), on a registry of the host's own instead of regen's process-wide
// default.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerConstruction } from '../../../packages/domain-construction/src/index';
import { registerWood } from '../../../packages/domain-wood/src/index';
import type { KernelService, KernelServiceConfig } from '../../../packages/kernel/src/index';
import { createNodeService } from '../../../packages/kernel/src/node';
import { ExtensionRegistry } from '../../../packages/regen/src/extensions';
import { createTextOutliner } from '../../../packages/regen/src/text-engine';
import type { TextOutliner } from '../../../packages/regen/src/text';
import { createSolverService, type SolverService } from '../../../packages/sketch/src/index';
import { registerStock } from '../../../packages/stock/src/index';

/**
 * Node's `fetch` cannot read `file:` URLs, and `@manufakture/text` finds its bundled fonts with
 * `new URL('../fonts/Inter-Bold.ttf', import.meta.url)`: the one asset fetch a session needs, and
 * injected here (`TextEngineOptions.fetchImpl`). Anything but a file URL is refused, so a crafted
 * document cannot make the host fetch from the network.
 */
export const readBundledFont = async (url: URL): Promise<Response> => {
  if (url.protocol !== 'file:') throw new Error(`refusing to fetch ${url.href}`);
  return new Response(readFileSync(fileURLToPath(url)));
};

export function nodeExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registerStock(registry);
  registerWood(registry);
  registerConstruction(registry);
  return registry;
}

export function nodeText(): TextOutliner {
  return createTextOutliner({ fetchImpl: readBundledFont });
}

export interface NodeHost {
  service: KernelService;
  solver: SolverService;
  text: TextOutliner;
  extensions: ExtensionRegistry;
  /** Creating the kernel service (the wasm compiled once per process, then instantiated). */
  serviceMs: number;
}

export async function nodeHost(config: KernelServiceConfig = {}): Promise<NodeHost> {
  const t = performance.now();
  const service = await createNodeService(config);
  const serviceMs = performance.now() - t;
  return {
    service,
    solver: createSolverService(),
    text: nodeText(),
    extensions: nodeExtensions(),
    serviceMs,
  };
}
