// A solver that starts its worker on first use, so opening the app costs
// nothing until the user starts a sketch.

import type { SketchSolverApi } from '@manufakture/sketch';
import type { SolverHandle } from './solver';

export interface LazySolver extends SketchSolverApi {
  /** Stop the worker, if it was started. Later calls start a new one. */
  dispose(): void;
}

export function lazySolver(spawn: () => Promise<SolverHandle>): LazySolver {
  let handle: Promise<SolverHandle> | null = null;
  const get = () => (handle ??= spawn()).then((h) => h.api);
  return {
    solve: (...args) => get().then((s) => s.solve(...args)),
    update: (...args) => get().then((s) => s.update(...args)),
    dragStart: (...args) => get().then((s) => s.dragStart(...args)),
    dragMove: (...args) => get().then((s) => s.dragMove(...args)),
    dragEnd: (...args) => get().then((s) => s.dragEnd(...args)),
    close: (...args) => get().then((s) => s.close(...args)),
    dispose() {
      const h = handle;
      handle = null;
      void h?.then((x) => x.terminate()).catch(() => undefined);
    },
  };
}

/** The solver worker, loaded as a separate chunk the first time it is needed. */
export async function spawnDefaultSolver(): Promise<SolverHandle> {
  const { spawnSolverWorker } = await import('./solver');
  return spawnSolverWorker();
}
