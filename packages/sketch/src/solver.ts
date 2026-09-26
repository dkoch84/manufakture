// The solver-neutral interface. Callers (the solver service, tests, later the
// regen engine) only see these types and the plain data in model.ts; nothing
// from planegcs leaves the package, so the solver can be replaced (ADR 0003,
// decision 2).

import type { VariableLookup } from '@manufakture/units';
import type { DragResult, PointRef, SketchInput, SolveResult, Vec2 } from './model';

export interface SolveOptions {
  /** Variables for the constraint expressions (names without '#'). */
  variables?: VariableLookup;
  /**
   * Compute the per-entity status (default true). It costs a Jacobian
   * analysis; skip it for rapid value edits where only coordinates matter.
   * Skipped, the previous statuses are returned.
   */
  analyze?: boolean;
}

/** One loaded sketch, kept between calls so edits and drags are incremental. */
export interface SketchSystem {
  /**
   * Load or update the sketch and solve it. Only what changed is pushed:
   * value edits set parameters, added and removed constraints are added and
   * removed, anything else rebuilds. The input's coordinates are the starting
   * point. Input issues give `invalid` and leave the loaded state unchanged.
   */
  update(sketch: SketchInput, options?: SolveOptions): SolveResult;
  /**
   * Start dragging a point: it follows the pointer as a soft target
   * (temporary constraints that use no DOF and never conflict).
   * Throws if nothing is loaded or the reference is invalid.
   */
  beginDrag(point: PointRef): void;
  /** Move the drag target and re-solve. */
  drag(target: Vec2): DragResult;
  /** Remove the drag target; the sketch stays where the drag left it. */
  endDrag(): SolveResult;
  /** Whether a drag is in progress. */
  readonly dragging: boolean;
  /** Set when the underlying instance died; every later call reports `aborted`. */
  readonly aborted: string | null;
  dispose(): void;
}

export interface SketchSolverBackend {
  createSystem(): SketchSystem;
  /** Set when the instance died; discard the backend and load a new one. */
  readonly aborted: string | null;
}
