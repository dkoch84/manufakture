// Reference import bodies (`import` features with `operation: 'reference'`) on the session's
// kernel. Regen does not build them: like the app (apps/web/src/persistence/imports.ts), the
// session reads each one again from the file its feature stores: a STEP file through the kernel's
// `importStep` op, an STL file parsed here as a mesh. They are read when the session opens, after
// every write that adds or replaces one, and again whenever the kernel was replaced (its shapes
// are gone then). `measure` reaches them by the import feature's id. Every kernel call here is
// under the session's deadline: a STEP read that runs over it is kept as that body's error.

import type { ImportFeature, ManufaktureDocument } from '@manufakture/core';
import { fromBase64, meshProperties, parseStl, type MeshProperties } from '@manufakture/io';
import type { ImportStepOp, ShapeId } from '@manufakture/kernel';
import { KernelTimeout, type EngineApi } from './engine';

export interface ReferenceBody {
  partId: string;
  featureId: string;
  name: string;
  format: 'step' | 'stl';
  sha256: string;
  /** STEP: the shape in the kernel instance `instance`. */
  shape?: ShapeId;
  instance?: number;
  /** STL: the welded mesh's properties. */
  mesh?: MeshProperties;
  /** Why the file could not be read again. */
  error?: string;
}

/** The reference imports of every part, with the part each is in, in document order. */
export function referenceImports(
  document: ManufaktureDocument,
): { partId: string; feature: ImportFeature }[] {
  return document.parts.flatMap((p) =>
    p.features
      .filter((f): f is ImportFeature => f.kind === 'import' && f.operation === 'reference')
      .map((feature) => ({ partId: p.id, feature })),
  );
}

const key = (partId: string, featureId: string) => `${partId}\u0000${featureId}`;

export class References {
  readonly #held = new Map<string, ReferenceBody>();

  /** Every reference body known, in no particular order. */
  list(): ReferenceBody[] {
    return [...this.#held.values()];
  }

  find(partId: string, featureId: string): ReferenceBody | undefined {
    return this.#held.get(key(partId, featureId));
  }

  /** The kernel was replaced: every shape is gone. */
  forget(): void {
    for (const r of this.#held.values()) {
      delete r.shape;
      delete r.instance;
    }
  }

  /**
   * Read the reference bodies of `document` that are not held (or were held in another kernel
   * instance), and release those it no longer has. Failures are kept per body, as data.
   */
  async sync(document: ManufaktureDocument, api: EngineApi, generation: number): Promise<void> {
    const wanted = referenceImports(document);
    const keep = new Set(wanted.map((w) => key(w.partId, w.feature.id)));
    const gone: ShapeId[] = [];
    for (const [k, r] of this.#held) {
      if (keep.has(k)) continue;
      if (r.shape !== undefined) gone.push(r.shape);
      this.#held.delete(k);
    }
    if (gone.length > 0) await api.release(gone).catch(() => undefined);
    if (wanted.length === 0) return;
    // The kernel instance now (an empty batch runs after any recycle that is pending).
    const now = (await api.run({ generation, ops: [] })).instance;
    for (const { partId, feature } of wanted) {
      const k = key(partId, feature.id);
      const held = this.#held.get(k);
      const { source } = feature;
      if (held !== undefined && held.sha256 === source.sha256) {
        if (held.format === 'stl' || held.error !== undefined || held.instance === now) continue;
      } else if (held?.shape !== undefined) {
        await api.release([held.shape]).catch(() => undefined);
      }
      const body: ReferenceBody = {
        partId,
        featureId: feature.id,
        name: feature.name,
        format: source.format,
        sha256: source.sha256,
      };
      this.#held.set(k, body);
      if (source.format === 'stl') {
        try {
          body.mesh = meshProperties(parseStl(fromBase64(source.data)).mesh);
        } catch (e) {
          body.error = e instanceof Error ? e.message : String(e);
        }
        continue;
      }
      const op: ImportStepOp = { op: 'importStep', data: source.data, featureId: feature.id };
      let reply: Awaited<ReturnType<EngineApi['run']>>;
      try {
        reply = await api.run({ generation, ops: [op] });
      } catch (e) {
        // Too long a read ended the kernel: kept as this body's error, so it is not read again
        // until its file changes (a hostile file would otherwise end every kernel).
        if (e instanceof KernelTimeout) {
          body.error = 'The STEP file took too long to read.';
        }
        throw e;
      }
      const result = reply.results[0];
      if (reply.status !== 'done' || result === undefined) {
        body.error = 'The STEP file could not be read (the kernel was busy); try again.';
      } else if (!result.ok) {
        body.error = result.error.message;
      } else {
        body.shape = (result.value as { shape: ShapeId }).shape;
        body.instance = reply.instance;
      }
    }
  }
}
