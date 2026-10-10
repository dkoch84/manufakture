// The regen worker's results as viewport bodies, and the part bodies registered for measuring,
// exporting and picking (the scene loader's registry: viewport body id to kernel shape).
//
// The engine sends a body's mesh only when the body changed since the regen that last reported
// it, and every completed regen is applied here in the order the worker finished them, so the
// mesh kept per body is always the one the latest result means.
//
// A part can have several bodies; each has the viewport id `<part id>/<body id>` (`viewBodyId`),
// and is registered under the name it is exported with when nothing else is asked for.
//
// Pinned parts that assembly instances show, and parts of this document in another configuration
// row (`RegenResult.sources`), keep their meshes the same way, by source key. Every body an
// instance shows is registered under its instance view id
// (`<assembly id>/<instance id>/<body id>`) with its source body's shape, so a pick on an
// instance can be turned into a stored reference like a pick on a part (the shape is in the
// part's own coordinates, which is what references and connectors name).
//
// Framing members (ADR 0015 decision 5) go to the member store, if one is given, from every
// result applied here, in the same order: regen sends a member mesh or an unchanged set only once.

import type { ManufaktureDocument } from '@manufakture/core';
import type { BodyResult, RegenResult } from '@manufakture/regen';
import type { KernelBody } from '../io/exchange';
import type { MemberRegenResult } from '../viewport/memberStore';
import type { BodyInput } from '../viewport/bodies';
import { fillPlaceholderNames } from '../viewport/naming';
import { bodyName, instanceViewId, viewBodyId } from './bodies';
import type { ModelBody, PartModel, Regenerator, RegenView, SourceModel } from './model';

export { viewBodyId } from './bodies';

/** What the regenerator needs of the regen client. */
export interface RegenSource {
  regen(document: ManufaktureDocument, stored?: ManufaktureDocument): Promise<RegenResult | null>;
}

export interface KernelRegenerator extends Regenerator {
  /** Tell the listeners that the kernel lost every body. */
  invalidate(): void;
}

/** The registry key the instance bodies are tracked under (no part id looks like it). */
const ASSEMBLIES = '\u0000assemblies';

function byId(list: readonly BodyResult[]): Map<string, BodyResult> {
  return new Map(list.map((b) => [b.bodyId, b]));
}

/** Where the regenerator puts each applied result's framing members (the member store). */
export interface MemberSink {
  getState(): { applyRegen(result: MemberRegenResult): void };
}

export function kernelRegenerator(
  client: () => RegenSource | null,
  registry: Map<string, KernelBody>,
  members?: MemberSink,
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

  /** The bodies of one part or source as viewport bodies, keeping meshes of unchanged ones. */
  const views = (
    names: readonly string[],
    key: string,
    idOf: (bodyId: string) => string,
    list: readonly BodyResult[],
  ) => {
    const before = bodies.get(key) ?? new Map<string, BodyInput>();
    const after = new Map<string, BodyInput>();
    const out: ModelBody[] = [];
    for (const b of list) {
      const id = idOf(b.bodyId);
      let view = b.mesh
        ? {
            id,
            mesh: b.mesh,
            // Every slot of a regen body has a name; this only guards against a gap.
            names: fillPlaceholderNames(b.mesh, names),
            topology: b.topology,
          }
        : before.get(b.bodyId);
      if (view === undefined) continue;
      if (view.id !== id) view = { ...view, id };
      after.set(b.bodyId, view);
      out.push({ bodyId: b.bodyId, creator: b.creator, solids: b.solids, view });
    }
    bodies.set(key, after);
    return out;
  };
  const apply = (document: ManufaktureDocument, result: RegenResult): RegenView => {
    const parts: PartModel[] = [];
    for (const part of result.parts) {
      const docPart = document.parts.find((p) => p.id === part.partId);
      const partName = docPart?.name ?? part.partId;
      const ids = new Set<string>();
      part.bodies.forEach((b, i) => {
        const id = viewBodyId(part.partId, b.bodyId);
        ids.add(id);
        registry.set(id, {
          shape: b.shape,
          name:
            docPart?.bodies.find((p) => p.id === b.bodyId)?.name ??
            bodyName({ name: partName }, i, part.bodies.length),
          role: 'part',
        });
      });
      forget(part.partId, ids);
      registered.set(part.partId, ids);
      parts.push({
        partId: part.partId,
        features: part.features,
        bodies: views(
          result.names,
          part.partId,
          (bodyId) => viewBodyId(part.partId, bodyId),
          part.bodies,
        ),
      });
    }
    // Pinned parts (and parts in another configuration row) that instances show, kept by
    // source key like parts by part id.
    const sources: SourceModel[] = result.sources.map((src) => ({
      key: src.key,
      partId: src.partId,
      documentName: src.documentName,
      versionName: src.versionName,
      partName: src.partName,
      ...(src.row === undefined ? {} : { row: src.row }),
      ...(src.documentId === '' ? { local: true as const } : {}),
      bodies: views(result.names, src.key, (bodyId) => `${src.key}/${bodyId}`, src.bodies),
    }));
    // Parts and sources that are gone.
    const kept = new Set([...result.parts.map((p) => p.partId), ...sources.map((x) => x.key)]);
    for (const id of [...bodies.keys()]) {
      if (!kept.has(id)) {
        forget(id);
        registered.delete(id);
        bodies.delete(id);
      }
    }
    // The bodies instances show, by instance view id, with the shape of their source's body.
    const shapes = new Map<string, Map<string, BodyResult>>();
    for (const p of result.parts) shapes.set(`part:${p.partId}`, byId(p.bodies));
    for (const x of result.sources) shapes.set(`source:${x.key}`, byId(x.bodies));
    const instanceIds = new Set<string>();
    for (const assembly of result.assemblies) {
      const docAssembly = document.assemblies.find((a) => a.id === assembly.assemblyId);
      for (const inst of assembly.instances) {
        const from =
          'part' in inst.source
            ? shapes.get(`part:${inst.source.part}`)
            : shapes.get(`source:${inst.source.source}`);
        const name = docAssembly?.instances.find((x) => x.id === inst.instanceId)?.name;
        for (const bodyId of inst.bodies) {
          const b = from?.get(bodyId);
          if (!b) continue;
          const id = instanceViewId(assembly.assemblyId, inst.instanceId, bodyId);
          instanceIds.add(id);
          registry.set(id, {
            shape: b.shape,
            name: inst.bodies.length === 1 ? (name ?? id) : `${name ?? id} ${bodyId}`,
            role: 'part',
          });
        }
      }
    }
    forget(ASSEMBLIES, instanceIds);
    registered.set(ASSEMBLIES, instanceIds);
    return {
      generation: result.generation,
      parts,
      assemblies: result.assemblies,
      sources,
      ...(result.measurements === undefined ? {} : { measurements: result.measurements }),
      ...(result.evaluations === undefined ? {} : { evaluations: result.evaluations }),
      ms: result.ms,
    };
  };

  return {
    async regen(document, stored) {
      const c = client();
      if (c === null) return null;
      const result = await (stored === undefined ? c.regen(document) : c.regen(document, stored));
      if (result === null) return null;
      // Completed results arrive in the order the worker finished them, which is generation
      // order; an older one arriving late would carry meshes the newer one already reported.
      if (result.generation <= applied) return null;
      applied = result.generation;
      const view = apply(document, result);
      members?.getState().applyRegen(result);
      return view;
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
