// Drag benchmark shared by Node, the page's main thread and the worker. One
// DragSession owns a loaded sketch; move(i) is what a pointermove handler would
// do: update the target, re-solve, and read the solution back for rendering.

import type { GcsWrapper } from '@salusoft89/planegcs';
import { chain, unitIds, UNIT } from './sketch.ts';
import {
  Algorithm,
  readParams,
  statusName,
  type AlgorithmName,
  type StatusName,
} from './solver.ts';

/**
 * `drag`: under-constrained sketch (no dimensions), a corner dragged the way
 * FreeCAD's Sketcher does it: two temporary coordinate constraints pin the
 * point to the pointer. Temporary constraints make planegcs solve that
 * component with its SQP routine, whatever algorithm is requested, so this
 * scenario is run once and labelled SQP.
 *
 * `pin`: the same sketch and pointer path, but the pointer is held by two
 * ordinary (driving) coordinate constraints. Adding them re-runs the
 * diagnosis once at drag start; each move then uses the requested algorithm.
 * It only works while the dragged point still has free DOF.
 *
 * `scrub`: fully constrained sketch (DOF 0) whose first width is a sketch
 * param; each move sets a new value, as when a dimension is dragged or typed.
 */
export type Scenario = 'drag' | 'pin' | 'scrub';

export interface DragSpec {
  entities: number;
  scenario: Scenario;
  algorithm: AlgorithmName;
}

export interface SetupResult {
  /** clear_data() + pushing every primitive into the system. */
  loadMs: number;
  /** First solve: includes the QR diagnosis (DOF, conflicts, redundancy). */
  firstSolveMs: number;
  /** Adding the drag constraints and solving once (drag and pin). */
  dragStartMs: number;
  dof: number;
  /** DOF once the drag constraints are in (temporary ones do not count). */
  dragDof: number;
  params: number;
  constraints: number;
  status: StatusName;
  /**
   * Median of 5 solves with nothing changed: the fixed cost of one
   * solve_system call, which re-partitions the system every time.
   */
  idleSolveMs: number;
}

export interface MoveResult {
  status: StatusName;
  /** set params + solve_system + apply_solution. */
  solveMs: number;
  /** solveMs plus reading every parameter back into a Float64Array. */
  moveMs: number;
  /**
   * How far the result is from the exact answer, in mm: the dragged point's
   * distance from the pointer (drag, pin), or the last unit's x offset error
   * (scrub, where it must shift by exactly the width change).
   */
  errorMm: number;
  params: Float64Array;
}

/** Pointer path for `drag`: a circle of this radius, this many steps per turn. */
export const DRAG_RADIUS = 10;
export const STEPS_PER_TURN = 60;
/** Width swing for `scrub`, around UNIT.width. */
export const SCRUB_AMPLITUDE = 10;

export class DragSession {
  private wrapper: GcsWrapper;
  private algorithm: Algorithm;
  private scenario: Scenario;
  private start: [number, number] = [0, 0];
  private buffer: Float64Array | undefined;
  private spec: DragSpec;
  private probe: { id: string; expectedX?: (w0: number) => number };
  readonly dragPoint: string;

  constructor(wrapper: GcsWrapper, spec: DragSpec) {
    this.wrapper = wrapper;
    this.spec = spec;
    this.algorithm = Algorithm[spec.algorithm];
    this.scenario = spec.scenario;
    const units = spec.entities / 5;
    this.dragPoint = unitIds(`u${Math.floor(units / 2)}`).topLeft;
    const last = units - 1;
    this.probe =
      spec.scenario === 'scrub'
        ? {
            id: unitIds(`u${last}`).bottomLeft,
            expectedX: (w0) => w0 + UNIT.gap + (last - 1) * (UNIT.width + UNIT.gap),
          }
        : { id: this.dragPoint };
  }

  setup(): SetupResult {
    const w = this.wrapper;
    const items = chain({
      entities: this.spec.entities,
      mode: this.scenario === 'scrub' ? 'full' : 'free',
      // An under-constrained sketch has many solutions, and each algorithm
      // would settle a perturbed start on a different one. Starting from exact
      // geometry makes the drag start state identical for every algorithm.
      perturb: this.scenario === 'scrub' ? 0.5 : 0,
    });
    const t0 = performance.now();
    w.clear_data();
    w.push_primitives_and_params(items);
    const t1 = performance.now();
    const status = w.solve(this.algorithm);
    w.gcs.apply_solution();
    const t2 = performance.now();
    const dof = w.gcs.dof();
    let dragStartMs = 0;
    let dragDof = dof;
    if (this.scenario !== 'scrub') {
      const temporary = this.scenario === 'drag';
      // Start from the solved position, as a drag starts on the drawn sketch.
      w.apply_solution();
      const p = w.sketch_index.get_sketch_point(this.dragPoint);
      this.start = [p.x, p.y];
      const t3 = performance.now();
      w.push_sketch_param('drag_x', p.x);
      w.push_sketch_param('drag_y', p.y);
      w.push_primitive({
        id: 'drag:x',
        type: 'coordinate_x',
        p_id: this.dragPoint,
        x: 'drag_x',
        temporary,
      });
      w.push_primitive({
        id: 'drag:y',
        type: 'coordinate_y',
        p_id: this.dragPoint,
        y: 'drag_y',
        temporary,
      });
      w.solve(this.algorithm);
      w.gcs.apply_solution();
      dragStartMs = performance.now() - t3;
      dragDof = w.gcs.dof();
    }
    const idle: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      w.solve(this.algorithm);
      w.gcs.apply_solution();
      idle.push(performance.now() - t);
    }
    return {
      loadMs: t1 - t0,
      firstSolveMs: t2 - t1,
      dragStartMs,
      dof,
      dragDof,
      params: w.gcs.params_size(),
      constraints: items.filter((i) => i.type !== 'param' && !isGeometry(i.type)).length,
      status: statusName(status),
      idleSolveMs: idle.sort((a, b) => a - b)[2]!,
    };
  }

  /** Where the pointer (or the width) is at step i. */
  target(i: number): [number, number] {
    const a = (2 * Math.PI * i) / STEPS_PER_TURN;
    if (this.scenario !== 'scrub') {
      return [
        this.start[0] + DRAG_RADIUS * (Math.cos(a) - 1),
        this.start[1] + DRAG_RADIUS * Math.sin(a),
      ];
    }
    return [UNIT.width + SCRUB_AMPLITUDE * Math.sin(a), 0];
  }

  move(i: number): MoveResult {
    const w = this.wrapper;
    const [x, y] = this.target(i);
    const t0 = performance.now();
    if (this.scenario !== 'scrub') {
      w.set_sketch_param('drag_x', x);
      w.set_sketch_param('drag_y', y);
    } else {
      w.set_sketch_param('w0', x);
    }
    const status = w.solve(this.algorithm);
    w.gcs.apply_solution();
    const t1 = performance.now();
    this.buffer = readParams(w, this.buffer);
    const t2 = performance.now();
    const at = w.p_param_index.get(this.probe.id)!;
    const px = this.buffer[at]!;
    const py = this.buffer[at + 1]!;
    const errorMm = this.probe.expectedX
      ? Math.abs(px - this.probe.expectedX(x))
      : Math.hypot(px - x, py - y);
    return {
      status: statusName(status),
      solveMs: t1 - t0,
      moveMs: t2 - t0,
      errorMm,
      params: this.buffer,
    };
  }
}

const GEOMETRY = new Set(['point', 'line', 'circle', 'arc']);
function isGeometry(type: string) {
  return GEOMETRY.has(type);
}

export interface RunOptions {
  warmup: number;
  moves: number;
}

export interface RunResult {
  spec: DragSpec;
  setup: SetupResult;
  solveMs: number[];
  moveMs: number[];
  failed: number;
  maxErrorMm: number;
}

/** Run a whole benchmark in-process (Node, or the page's main thread). */
export function runInProcess(wrapper: GcsWrapper, spec: DragSpec, o: RunOptions): RunResult {
  const session = new DragSession(wrapper, spec);
  const setup = session.setup();
  const solveMs: number[] = [];
  const moveMs: number[] = [];
  let failed = 0;
  let maxErrorMm = 0;
  for (let i = 1; i <= o.warmup + o.moves; i++) {
    const r = session.move(i);
    if (i <= o.warmup) continue;
    solveMs.push(r.solveMs);
    moveMs.push(r.moveMs);
    if (r.status === 'Failed') failed++;
    maxErrorMm = Math.max(maxErrorMm, r.errorMm);
  }
  return { spec, setup, solveMs, moveMs, failed, maxErrorMm };
}
