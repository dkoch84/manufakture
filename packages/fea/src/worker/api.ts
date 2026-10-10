// The FEA worker's interface (ADR 0007 decision 2: one Comlink interface per worker, defined by
// the package that owns it). The same object runs in a browser module worker (`browser.ts`) and
// in a Node worker thread (`node.ts`).

import * as Comlink from 'comlink';
import { analyse, analyseMesh } from '../analyse';
import { MesherUnavailable, prepareGmsh } from '../gmsh';
import type { MeshedModel, SolveInput } from '../solve';
import type { FeaError, FeaLimits, FeaOutcome, FeaProgress, FeaRequest } from '../types';

export interface FeaWorkerApi {
  /**
   * Mesh and solve. `cancel` is a SharedArrayBuffer of at least 4 bytes whose first Int32 the host
   * sets to non-zero to cancel (null where SharedArrayBuffer is unavailable: the host then
   * terminates the worker instead). The result's arrays are transferred, not copied.
   */
  analyse(
    request: FeaRequest,
    cancel: SharedArrayBuffer | null,
    onProgress?: (p: FeaProgress) => void,
  ): Promise<FeaOutcome>;
  /** Solve a mesh that is already built (no mesher), under the same limits and protocol. */
  analyseMesh(
    model: MeshedModel,
    input: SolveInput & { limits?: Partial<FeaLimits> },
    cancel: SharedArrayBuffer | null,
    onProgress?: (p: FeaProgress) => void,
  ): Promise<FeaOutcome>;
  /** Download and compile the mesher ahead of the first analysis. */
  prepare(): Promise<{ ok: true } | { ok: false; error: FeaError }>;
}

const options = (cancel: SharedArrayBuffer | null, onProgress?: (p: FeaProgress) => void) => ({
  cancel: cancel ? new Int32Array(cancel, 0, 1) : null,
  // A proxied callback returns a promise; progress is fire and forget.
  ...(onProgress ? { onProgress: (p: FeaProgress) => void onProgress(p) } : {}),
});

function transferred(outcome: FeaOutcome): FeaOutcome {
  if (!outcome.ok) return outcome;
  const r = outcome.result;
  return Comlink.transfer(outcome, [
    r.nodes.buffer,
    r.elements.buffer,
    r.elementBody.buffer,
    r.triangles.buffer,
    r.triangleFace.buffer,
    r.displacement.buffer,
    r.stress.buffer,
    r.vonMises.buffer,
    r.principal.buffer,
  ] as ArrayBuffer[]);
}

/** Close a proxied progress callback's channel once the run is over. */
function release(onProgress: unknown): void {
  const proxy = onProgress as { [Comlink.releaseProxy]?: () => void } | undefined;
  if (typeof proxy?.[Comlink.releaseProxy] === 'function') proxy[Comlink.releaseProxy]();
}

export function feaWorkerApi(): FeaWorkerApi {
  return {
    async analyse(request, cancel, onProgress) {
      try {
        return transferred(await analyse(request, options(cancel, onProgress)));
      } finally {
        release(onProgress);
      }
    },
    async analyseMesh(model, input, cancel, onProgress) {
      try {
        return transferred(analyseMesh(model, input, options(cancel, onProgress)));
      } finally {
        release(onProgress);
      }
    },
    async prepare() {
      try {
        await prepareGmsh();
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error:
            error instanceof MesherUnavailable
              ? { code: 'mesher-unavailable', message }
              : { code: 'worker-failed', message },
        };
      }
    },
  };
}
