// The regen worker's results as viewport bodies, and the part bodies registered for measuring,
// exporting and picking (the scene loader's registry: viewport body id to kernel shape).
//
// The engine sends a body's mesh only when the body changed since the regen that last reported
// it, and every completed regen is applied here in the order the worker finished them, so the
// mesh kept per body is always the one the latest result means.
//
// A part can have several bodies. Until the app shows bodies as such (M2 plan, T2.1d), the
// part's first body (in creator order) keeps the part id as its viewport id, which is what the
// one body of a part was before, and every other body is `<part id>/<body id>`.

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

/** The viewport id of a part's body: the part id for its first body, `<part id>/<body id>` otherwise. */
export function viewBodyId(partId: string, bodyId: string, first: boolean): string {
  return first ? partId : `${partId}/${bodyId}`;
}

export function kernelRegenerator(
  client: () => RegenSource | null,
  registry: Map<string, KernelBody>,
): KernelRegenerator {
  // The last mesh of every body, by part and regen body id (a body keeps its mesh while the
  // engine reports it unchanged, whatever its viewport id is now).
  const bodies = new Map<string, Map<string, BodyInput>>();
  // The viewport ids registered per part, to unregister the ones that are gone.
  const registered = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  let applied = 0;

  const forget = (partId: string, keep: ReadonlySet<string> = new Set()) => {
    for (const id of registered.get(partId) ?? []) if (!keep.has(id)) registry.delete(id);
  };

  const apply = (document: ManufaktureDocument, result: RegenResult): RegenView => {
    const parts: PartModel[] = [];
    for (const part of result.parts) {
      const name = document.parts.find((p) => p.id === part.partId)?.name ?? part.partId;
      const before = bodies.get(part.partId) ?? new Map<string, BodyInput>();
      const after = new Map<string, BodyInput>();
      const ids = new Set<string>();
      const views: BodyInput[] = [];
      part.bodies.forEach((b, i) => {
        const id = viewBodyId(part.partId, b.bodyId, i === 0);
        ids.add(id);
        registry.set(id, {
          shape: b.shape,
          name: i === 0 ? name : `${name} ${b.bodyId}`,
          role: 'part',
        });
        let view = b.mesh
          ? {
              id,
              mesh: b.mesh,
              // Every slot of a regen body has a name; this only guards against a gap.
              names: fillPlaceholderNames(b.mesh, result.names),
              topology: b.topology,
            }
          : before.get(b.bodyId);
        if (view === undefined) return;
        if (view.id !== id) view = { ...view, id };
        after.set(b.bodyId, view);
        views.push(view);
      });
      forget(part.partId, ids);
      registered.set(part.partId, ids);
      bodies.set(part.partId, after);
      parts.push({
        partId: part.partId,
        features: part.features,
        body: views[0] ?? null,
        bodies: views,
      });
    }
    // Parts that are gone from the document.
    for (const id of [...bodies.keys()]) {
      if (!result.parts.some((p) => p.partId === id)) {
        forget(id);
        registered.delete(id);
        bodies.delete(id);
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
