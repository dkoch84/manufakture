// The regen worker's results as viewport bodies, and the part bodies registered for measuring,
// exporting and picking (the scene loader's registry: viewport body id to kernel shape).
//
// The engine sends a part's mesh only when its body changed since the regen that last reported
// it, and every completed regen is applied here in the order the worker finished them, so the
// body kept per part is always the one the latest result means.

import type { ManufaktureDocument } from '@manufakture/core';
import type { RegenResult } from '@manufakture/regen';
import type { KernelBody } from '../io/exchange';
import type { BodyInput } from '../viewport/bodies';
import { fillPlaceholderNames } from '../viewport/naming';
import type { PartModel, Regenerator, RegenView } from './model';

/** What the regenerator needs of the regen client. */
export interface RegenSource {
  regen(document: ManufaktureDocument): Promise<RegenResult | null>;
}

export interface KernelRegenerator extends Regenerator {
  /** Tell the listeners that the kernel lost every body. */
  invalidate(): void;
}

export function kernelRegenerator(
  client: () => RegenSource | null,
  registry: Map<string, KernelBody>,
): KernelRegenerator {
  const bodies = new Map<string, BodyInput>();
  const listeners = new Set<() => void>();
  let applied = 0;

  const apply = (document: ManufaktureDocument, result: RegenResult): RegenView => {
    const parts: PartModel[] = [];
    for (const part of result.parts) {
      const name = document.parts.find((p) => p.id === part.partId)?.name ?? part.partId;
      if (part.shape === null) {
        bodies.delete(part.partId);
        registry.delete(part.partId);
      } else {
        registry.set(part.partId, { shape: part.shape, name, role: 'part' });
        if (part.mesh) {
          bodies.set(part.partId, {
            id: part.partId,
            mesh: part.mesh,
            // Every slot of a regen body has a name; this only guards against a gap.
            names: fillPlaceholderNames(part.mesh, result.names),
            topology: part.topology,
          });
        }
      }
      parts.push({
        partId: part.partId,
        features: part.features,
        body: part.shape === null ? null : (bodies.get(part.partId) ?? null),
      });
    }
    // Parts that are gone from the document.
    for (const id of [...bodies.keys()]) {
      if (!result.parts.some((p) => p.partId === id)) {
        bodies.delete(id);
        registry.delete(id);
      }
    }
    return { generation: result.generation, parts, ms: result.ms };
  };

  return {
    async regen(document) {
      const c = client();
      if (c === null) return null;
      const result = await c.regen(document);
      if (result === null) return null;
      // Completed results arrive in the order the worker finished them, which is generation
      // order; an older one arriving late would carry meshes the newer one already reported.
      if (result.generation <= applied) return null;
      applied = result.generation;
      return apply(document, result);
    },
    onInvalidated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate() {
      for (const l of listeners) l();
    },
  };
}
