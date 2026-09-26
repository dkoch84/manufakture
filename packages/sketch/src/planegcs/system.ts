// A SketchSystem over planegcs's `GcsSystem`, not its `GcsWrapper` (which
// tags constraints by push position and cannot remove one). ADR 0003:
//
// - Each model constraint gets one numeric tag from a counter that starts at 1
//   and only increases while the system is loaded; tags 0 and -1 are never
//   used for model constraints (planegcs leaves both out of the diagnosis, and
//   -1 marks the temporary drag constraints). Conflict and redundancy lists
//   map straight back to model ids, and a constraint is removed with
//   `clear_by_id`. Tags are not persisted: a rebuild starts a new map.
// - Constraints are pushed in creation order, so the newest of equivalent
//   constraints is the one reported redundant.
// - Dimension values are fixed solver parameters, so an edit is a parameter
//   change. planegcs only re-diagnoses when a constraint is added or removed,
//   so a value edit while anything is redundant or conflicting rebuilds.
// - What a constraint takes from the geometry (the coordinates a `fix` pins,
//   0 or pi for an endpoint tangency, internal or external for two tangent
//   circles) is taken from the coordinates passed to each `update`, exactly as
//   a fresh system would take it. Every update recompiles the loaded
//   constraints against the incoming coordinates: a changed number is a
//   parameter change like a dimension edit, and a changed tangency kind
//   rebuilds. So a result depends only on the input, never on what was loaded
//   before. The choices still hold still while dragging, because a drag does
//   not recompile, and solved geometry satisfies them, so an update from the
//   last solve re-derives the same ones: a curve does not flip unless the
//   caller moved it across.
// - DogLeg by default, Levenberg-Marquardt as a retry. Never BFGS.
// - The status is not a conflict signal: the conflict list is.

import { Algorithm, SolveStatus, type GcsSystem } from '@salusoft89/planegcs';
import { analyzeRank, type RankAnalysis } from '../analysis';
import { equationsOf, type Equation } from '../equations';
import {
  buildLayout,
  packFromParams,
  pointIndex,
  readEntities,
  type Curve,
  type Layout,
  type PointIndex,
} from '../layout';
import type {
  Diagnosis,
  DragResult,
  EntityStatus,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchInput,
  SketchIssue,
  SolveResult,
  Vec2,
} from '../model';
import {
  arcRules,
  compileConstraint,
  constraintShape,
  type CompiledConstraint,
  type Op,
} from '../ops';
import type { SketchSystem, SolveOptions } from '../solver';
import {
  evaluateValues,
  isBuiltin,
  pointRefProblem,
  referencedEntities,
  validateSketch,
} from '../validate';
import { PlanegcsModule, SolverAbortedError, type PlanegcsLoadOptions } from './module';

/** Tag of temporary (drag) constraints: no DOF, never in the diagnosis. */
const TEMPORARY_TAG = -1;
/** Rebuild once this many parameters are orphaned by removed constraints. */
const MAX_ORPHANED_PARAMS = 256;

interface ConstraintRecord {
  constraint: SketchConstraint;
  tag: number;
  shape: string;
  compiled: CompiledConstraint;
  /** Per op, the fixed solver parameter it pushed (a value or an angle), if any. */
  opParams: (number | null)[];
  /** Solver parameters this constraint pushed (orphaned when it is removed). */
  pushedParams: number;
}

type Geometry = { delete: () => void };

function emptyDiagnosis(): Diagnosis {
  return { dof: null, conflicting: [], redundant: [], partiallyRedundant: [], entities: {} };
}

function copyEntities(entities: readonly SketchEntity[]): SketchEntity[] {
  return entities.map((e) => ({ ...e }));
}

function entityShape(entities: readonly SketchEntity[]): string {
  return entities.map((e) => `${e.id}:${e.kind}`).join('|');
}

/** The number an op pushes as a fixed solver parameter: a dimension, a pinned coordinate, an angle. */
function paramOf(op: Op): number | null {
  if ('value' in op) return op.value;
  if (op.op === 'angle_via_point') return op.angle;
  return null;
}

/** What an op is apart from its parameter: only a tangency's internal flag can differ. */
function kindOf(op: Op): string {
  return op.op === 'tangent_circumf' ? `${op.op}:${op.internal}` : op.op;
}

function converged(status: number): boolean {
  return status === SolveStatus.Success || status === SolveStatus.Converged;
}

export class PlanegcsSketchSystem implements SketchSystem {
  private gcs: GcsSystem | null;
  private layout: Layout | null = null;
  private shape = '';
  /** Current geometry parameters (layout indices), kept equal to the solver's. */
  private params = new Float64Array(0);
  private nextTag = 1;
  private readonly records = new Map<string, ConstraintRecord>();
  private readonly tagToId = new Map<number, string>();
  /** Tags of the internal arc_rules, to the arc id. */
  private readonly internalTags = new Map<number, string>();
  private arcOps: Op[] = [];
  private orphanedParams = 0;
  private dragParams: [number, number] | null = null;
  private dragPoint: PointIndex | null = null;
  private diagnosis: Diagnosis = emptyDiagnosis();
  private dead: string | null = null;
  private latestAnalysis: RankAnalysis | null = null;

  constructor(private readonly module: PlanegcsModule) {
    try {
      this.gcs = module.createSystem();
    } catch (e) {
      // A system made from a dead instance is dead too, and says so.
      if (!(e instanceof SolverAbortedError)) throw e;
      this.gcs = null;
      this.dead = e.message;
    }
  }

  get aborted(): string | null {
    return this.dead ?? this.module.aborted;
  }

  /** The last per-parameter analysis (for tests and debugging). */
  get lastAnalysis(): RankAnalysis | null {
    return this.latestAnalysis;
  }

  get dragging(): boolean {
    return this.dragPoint !== null;
  }

  /** The number of solver parameters, including dimension values and drag targets. */
  get solverParamCount(): number {
    return this.call(() => this.system().params_size());
  }

  update(sketch: SketchInput, options: SolveOptions = {}): SolveResult {
    const aborted = this.abortedResult(sketch.entities);
    if (aborted) return aborted;
    const structural = validateSketch(sketch);
    if (structural.length > 0) return this.invalid(sketch, structural);
    const { values, issues } = evaluateValues(sketch.constraints, options.variables);
    if (issues.length > 0) return this.invalid(sketch, issues);
    try {
      this.call(() => this.load(sketch, values));
      return this.call(() => this.solveAndReport(options.analyze ?? true));
    } catch (e) {
      return this.onError(e, sketch.entities);
    }
  }

  beginDrag(point: PointRef): void {
    const layout = this.layout;
    if (!layout) throw new Error('Nothing is loaded');
    const byId = new Map(layout.slots.map((s) => [s.entity.id, s.entity]));
    const problem = pointRefProblem(byId, point, false);
    if (problem !== null) throw new Error(`Cannot drag: ${problem}`);
    if (this.aborted) throw new SolverAbortedError(this.aborted);
    this.call(() => {
      const gcs = this.system();
      if (this.dragPoint) gcs.clear_by_id(TEMPORARY_TAG);
      const p = pointIndex(layout, point);
      this.dragParams ??= [this.pushParam(this.params[p[0]]!), this.pushParam(this.params[p[1]]!)];
      const [dx, dy] = this.dragParams;
      gcs.set_p_param(dx, this.params[p[0]]!, true);
      gcs.set_p_param(dy, this.params[p[1]]!, true);
      const gp = gcs.make_point(p[0], p[1]);
      try {
        gcs.add_constraint_coordinate_x(gp, dx, TEMPORARY_TAG, true, 1);
        gcs.add_constraint_coordinate_y(gp, dy, TEMPORARY_TAG, true, 1);
      } finally {
        gp.delete();
      }
      this.dragPoint = p;
    });
  }

  drag(target: Vec2): DragResult {
    if (!this.dragPoint || !this.dragParams || !this.layout) throw new Error('No drag in progress');
    const layout = this.layout;
    if (this.aborted) {
      return {
        status: 'aborted',
        coordinates: packFromParams(layout, this.params),
        message: this.abortMessage(),
      };
    }
    try {
      const ok = this.call(() => {
        const gcs = this.system();
        gcs.set_p_param(this.dragParams![0], target[0], true);
        gcs.set_p_param(this.dragParams![1], target[1], true);
        return this.solve().ok;
      });
      const coordinates = packFromParams(layout, this.params);
      return ok
        ? { status: 'solved', coordinates }
        : {
            status: 'failed',
            coordinates,
            message: 'The drag did not converge; the sketch stayed put',
          };
    } catch (e) {
      if (!(e instanceof SolverAbortedError)) throw e;
      this.dead = e.message;
      return {
        status: 'aborted',
        coordinates: packFromParams(layout, this.params),
        message: e.message,
      };
    }
  }

  endDrag(): SolveResult {
    const layout = this.layout;
    if (!layout) throw new Error('Nothing is loaded');
    const entities = readEntities(layout, this.params);
    const aborted = this.abortedResult(entities);
    if (aborted) return aborted;
    try {
      if (this.dragPoint) this.call(() => this.system().clear_by_id(TEMPORARY_TAG));
      this.dragPoint = null;
      return this.call(() => this.solveAndReport(true));
    } catch (e) {
      return this.onError(e, entities);
    }
  }

  dispose(): void {
    if (this.gcs) this.module.deleteSystem(this.gcs);
    this.gcs = null;
    this.layout = null;
  }

  // Loading ----------------------------------------------------------------

  private load(sketch: SketchInput, values: Map<string, number>): void {
    const gcs = this.system();
    if (this.dragPoint) {
      gcs.clear_by_id(TEMPORARY_TAG);
      this.dragPoint = null;
    }
    const layout = buildLayout(sketch.entities);
    const shape = entityShape(sketch.entities);
    if (!this.layout || shape !== this.shape || this.orphanedParams > MAX_ORPHANED_PARAMS) {
      this.rebuild(sketch, values, layout, shape);
      return;
    }

    // Recompile what is kept against the incoming coordinates and values.
    const incoming = new Map(sketch.constraints.map((c) => [c.id, c]));
    const removed: ConstraintRecord[] = [];
    const recompiled: [ConstraintRecord, CompiledConstraint][] = [];
    const changed: [param: number, value: number][] = [];
    for (const [id, rec] of this.records) {
      const c = incoming.get(id);
      if (!c || constraintShape(c) !== rec.shape) {
        removed.push(rec);
        continue;
      }
      const fresh = compileConstraint(c, layout, values, layout.values);
      for (let k = 0; k < fresh.ops.length; k++) {
        const before = rec.compiled.ops[k]!;
        const after = fresh.ops[k]!;
        if (kindOf(before) !== kindOf(after)) {
          // A tangency changed kind: not a parameter; start over.
          this.rebuild(sketch, values, layout, shape);
          return;
        }
        const v = paramOf(after);
        if (v !== null && v !== paramOf(before)) changed.push([rec.opParams[k]!, v]);
      }
      recompiled.push([rec, fresh]);
    }
    const stale =
      this.diagnosis.redundant.length +
        this.diagnosis.partiallyRedundant.length +
        this.diagnosis.conflicting.length >
      0;
    if (changed.length > 0 && stale) {
      this.rebuild(sketch, values, layout, shape);
      return;
    }

    // Start from the caller's coordinates.
    this.layout = layout;
    for (let i = layout.fixedCount; i < layout.values.length; i++) {
      const v = layout.values[i]!;
      if (v !== this.params[i]) {
        gcs.set_p_param(i, v, false);
        this.params[i] = v;
      }
    }
    for (const rec of removed) {
      gcs.clear_by_id(rec.tag);
      this.tagToId.delete(rec.tag);
      this.records.delete(rec.constraint.id);
      this.orphanedParams += rec.pushedParams;
    }
    for (const [param, value] of changed) gcs.set_p_param(param, value, true);
    for (const [rec, fresh] of recompiled) rec.compiled = fresh;
    for (const c of sketch.constraints) {
      const rec = this.records.get(c.id);
      if (rec) rec.constraint = c;
      else this.addConstraint(c, values);
    }
  }

  private rebuild(
    sketch: SketchInput,
    values: Map<string, number>,
    layout: Layout,
    shape: string,
  ): void {
    const gcs = this.system();
    gcs.clear_data();
    this.layout = layout;
    this.shape = shape;
    this.params = Float64Array.from(layout.values);
    layout.values.forEach((v, i) => gcs.push_p_param(v, i < layout.fixedCount));
    this.nextTag = 1;
    this.records.clear();
    this.tagToId.clear();
    this.internalTags.clear();
    this.orphanedParams = 0;
    this.dragParams = null;
    this.dragPoint = null;
    this.diagnosis = emptyDiagnosis();
    this.arcOps = [];
    for (const { id, op } of arcRules(layout)) {
      const tag = this.nextTag++;
      this.internalTags.set(tag, id);
      this.arcOps.push(op);
      this.pushOp(op, tag);
    }
    for (const c of sketch.constraints) this.addConstraint(c, values);
  }

  private addConstraint(c: SketchConstraint, values: Map<string, number>): void {
    const compiled = compileConstraint(c, this.layout!, values, this.params);
    const tag = this.nextTag++;
    const before = this.system().params_size();
    const opParams = compiled.ops.map((op) => this.pushOp(op, tag));
    this.records.set(c.id, {
      constraint: c,
      tag,
      shape: constraintShape(c),
      compiled,
      opParams,
      pushedParams: this.system().params_size() - before,
    });
    this.tagToId.set(tag, c.id);
  }

  private pushParam(value: number): number {
    const gcs = this.system();
    const i = gcs.params_size();
    gcs.push_p_param(value, true);
    return i;
  }

  /**
   * Push one op; returns the index of the fixed parameter it pushed for its
   * value or angle, if it has one (`paramOf` gives that number).
   */
  private pushOp(op: Op, tag: number): number | null {
    const gcs = this.system();
    const made: Geometry[] = [];
    const keep = <T extends Geometry>(g: T): T => {
      made.push(g);
      return g;
    };
    const point = (p: PointIndex) => keep(gcs.make_point(p[0], p[1]));
    const curve = (c: Curve) =>
      c.kind === 'line'
        ? keep(gcs.make_line(c.p1[0], c.p1[1], c.p2[0], c.p2[1]))
        : c.kind === 'circle'
          ? keep(gcs.make_circle(c.c[0], c.c[1], c.r))
          : keep(gcs.make_arc(c.c[0], c.c[1], c.s[0], c.s[1], c.e[0], c.e[1], c.a1, c.a2, c.r));
    const t = tag;
    try {
      switch (op.op) {
        case 'p2p_coincident':
          gcs.add_constraint_p2p_coincident(point(op.p1), point(op.p2), t, true, 1);
          return null;
        case 'horizontal_pp':
          gcs.add_constraint_horizontal_pp(point(op.p1), point(op.p2), t, true, 1);
          return null;
        case 'vertical_pp':
          gcs.add_constraint_vertical_pp(point(op.p1), point(op.p2), t, true, 1);
          return null;
        case 'parallel':
          gcs.add_constraint_parallel(curve(op.l1), curve(op.l2), t, true, 1);
          return null;
        case 'perpendicular_ll':
          gcs.add_constraint_perpendicular_ll(curve(op.l1), curve(op.l2), t, true, 1);
          return null;
        case 'angle_via_point': {
          const v = this.pushParam(op.angle);
          gcs.add_constraint_angle_via_point(
            curve(op.c1),
            curve(op.c2),
            point(op.p),
            v,
            t,
            true,
            1,
          );
          return v;
        }
        case 'tangent_lc':
          if (op.c.kind === 'circle')
            gcs.add_constraint_tangent_lc(curve(op.l), curve(op.c), t, true, 1);
          else gcs.add_constraint_tangent_la(curve(op.l), curve(op.c), t, true, 1);
          return null;
        case 'tangent_circumf':
          gcs.add_constraint_tangent_circumf(
            point(op.c1.c),
            point(op.c2.c),
            op.c1.r,
            op.c2.r,
            op.internal,
            t,
            true,
            1,
          );
          return null;
        case 'equal_length':
          gcs.add_constraint_equal_length(curve(op.l1), curve(op.l2), t, true, 1);
          return null;
        case 'equal_radius':
          gcs.add_constraint_equal(op.c1.r, op.c2.r, t, true, 0, 1);
          return null;
        case 'p2p_distance': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_p2p_distance(point(op.p1), point(op.p2), v, t, true, 1);
          return v;
        }
        case 'p2l_distance': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_p2l_distance(point(op.p), curve(op.l), v, t, true, 1);
          return v;
        }
        case 'difference': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_difference(op.i1, op.i2, v, t, true, 1);
          return v;
        }
        case 'l2l_angle_ll': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_l2l_angle_ll(curve(op.l1), curve(op.l2), v, t, true, 1);
          return v;
        }
        case 'radius': {
          const v = this.pushParam(op.value);
          if (op.c.kind === 'circle') gcs.add_constraint_circle_radius(curve(op.c), v, t, true, 1);
          else gcs.add_constraint_arc_radius(curve(op.c), v, t, true, 1);
          return v;
        }
        case 'diameter': {
          const v = this.pushParam(op.value);
          if (op.c.kind === 'circle')
            gcs.add_constraint_circle_diameter(curve(op.c), v, t, true, 1);
          else gcs.add_constraint_arc_diameter(curve(op.c), v, t, true, 1);
          return v;
        }
        case 'coordinate_x': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_coordinate_x(point(op.p), v, t, true, 1);
          return v;
        }
        case 'coordinate_y': {
          const v = this.pushParam(op.value);
          gcs.add_constraint_coordinate_y(point(op.p), v, t, true, 1);
          return v;
        }
        case 'p2p_symmetric_ppp':
          gcs.add_constraint_p2p_symmetric_ppp(point(op.p1), point(op.p2), point(op.p), t, true, 1);
          return null;
        case 'p2p_symmetric_ppl':
          gcs.add_constraint_p2p_symmetric_ppl(point(op.p1), point(op.p2), curve(op.l), t, true, 1);
          return null;
        case 'point_on_line':
          gcs.add_constraint_point_on_line_pl(point(op.p), curve(op.l), t, true, 1);
          return null;
        case 'point_on_round':
          if (op.c.kind === 'circle')
            gcs.add_constraint_point_on_circle(point(op.p), curve(op.c), t, true, 1);
          else gcs.add_constraint_point_on_arc(point(op.p), curve(op.c), t, true, 1);
          return null;
        case 'arc_rules':
          gcs.add_constraint_arc_rules(curve(op.a), t, true, 1);
          return null;
      }
      const unknown: never = op;
      throw new Error(`Unknown op ${JSON.stringify(unknown)}`);
    } finally {
      for (const g of made) g.delete();
    }
  }

  // Solving ----------------------------------------------------------------

  /**
   * DogLeg, then LM from the same start if DogLeg did not converge. The
   * geometry is only taken over when a solve converged without conflicts;
   * otherwise it is put back where it was.
   */
  private solve(): { ok: boolean; conflicting: number[]; redundant: number[]; partial: number[] } {
    const gcs = this.system();
    let status = gcs.solve_system(Algorithm.DogLeg);
    if (!converged(status)) {
      this.restore();
      status = gcs.solve_system(Algorithm.LevenbergMarquardt);
    }
    const conflicting = this.tags(gcs.get_conflicting());
    const redundant = this.tags(gcs.get_redundant());
    const partial = this.tags(gcs.get_partially_redundant());
    const ok = converged(status) && conflicting.length === 0;
    if (ok) {
      gcs.apply_solution();
      for (let i = this.layout!.fixedCount; i < this.params.length; i++)
        this.params[i] = gcs.get_p_param(i);
    } else {
      this.restore();
    }
    return { ok, conflicting, redundant, partial };
  }

  private restore(): void {
    const gcs = this.system();
    for (let i = this.layout!.fixedCount; i < this.params.length; i++)
      gcs.set_p_param(i, this.params[i]!, false);
  }

  private tags(vec: {
    size: () => number;
    get: (i: number) => number;
    delete: () => void;
  }): number[] {
    const out: number[] = [];
    for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
    vec.delete();
    return out;
  }

  private solveAndReport(analyze: boolean): SolveResult {
    const gcs = this.system();
    const layout = this.layout!;
    const result = this.solve();
    const ids = (tags: number[]) =>
      tags.flatMap((t) => (this.tagToId.has(t) ? [this.tagToId.get(t)!] : []));
    const conflicting = ids(result.conflicting);
    const redundant = ids(result.redundant);
    const partiallyRedundant = ids(result.partial);

    const over = new Set<string>();
    for (const t of [...result.conflicting, ...result.redundant, ...result.partial]) {
      const arc = this.internalTags.get(t);
      if (arc !== undefined) over.add(arc);
      const id = this.tagToId.get(t);
      if (id !== undefined) {
        for (const e of referencedEntities(this.records.get(id)!.constraint))
          if (!isBuiltin(e)) over.add(e);
      }
    }

    let entities: Record<string, EntityStatus> = this.diagnosis.entities;
    if (analyze) {
      const skip = new Set(result.redundant);
      const equations: Equation[] = this.arcOps.flatMap((op) => equationsOf(op, this.params));
      for (const rec of this.records.values()) {
        if (!skip.has(rec.tag))
          for (const op of rec.compiled.ops) equations.push(...equationsOf(op, this.params));
      }
      const analysis = analyzeRank(this.params, layout.fixedCount, equations);
      this.latestAnalysis = analysis;
      entities = {};
      for (const slot of layout.slots) {
        let fully = true;
        for (let i = slot.base; i < slot.base + slot.size; i++)
          if (!analysis.determined[i]) fully = false;
        entities[slot.entity.id] = over.has(slot.entity.id) ? 'over' : fully ? 'fully' : 'under';
      }
    } else {
      entities = Object.fromEntries(
        layout.slots.map((s) => [
          s.entity.id,
          over.has(s.entity.id) ? 'over' : (entities[s.entity.id] ?? 'under'),
        ]),
      );
    }

    const dof = conflicting.length > 0 ? null : gcs.dof();
    this.diagnosis = {
      dof: dof !== null && dof >= 0 ? dof : null,
      conflicting,
      redundant,
      partiallyRedundant,
      entities,
    };
    const base = {
      entities: readEntities(layout, this.params),
      diagnosis: this.diagnosis,
      issues: [] as SketchIssue[],
    };
    if (conflicting.length > 0) {
      return {
        ...base,
        status: 'conflicting',
        message: `Conflicting constraints: ${conflicting.join(', ')}`,
      };
    }
    if (!result.ok) return { ...base, status: 'failed', message: 'The sketch did not converge' };
    return { ...base, status: 'solved' };
  }

  // Plumbing ---------------------------------------------------------------

  private system(): GcsSystem {
    if (!this.gcs) throw new Error('The sketch system was disposed');
    return this.gcs;
  }

  private call<T>(fn: () => T): T {
    return this.module.call(fn);
  }

  private abortMessage(): string {
    return new SolverAbortedError(this.aborted ?? 'unknown').message;
  }

  private abortedResult(entities: readonly SketchEntity[]): SolveResult | null {
    if (!this.aborted) return null;
    return {
      status: 'aborted',
      entities: copyEntities(entities),
      diagnosis: emptyDiagnosis(),
      issues: [],
      message: this.dead ?? this.abortMessage(),
    };
  }

  private onError(e: unknown, entities: readonly SketchEntity[]): SolveResult {
    if (!(e instanceof SolverAbortedError)) throw e;
    this.dead = e.message;
    this.layout = null;
    this.dragPoint = null;
    return this.abortedResult(entities)!;
  }

  private invalid(sketch: SketchInput, issues: SketchIssue[]): SolveResult {
    return {
      status: 'invalid',
      entities: copyEntities(sketch.entities),
      diagnosis: emptyDiagnosis(),
      issues,
      message: issues.map((i) => i.message).join('; '),
    };
  }
}

/** A backend that makes planegcs systems from one module instance. */
export class PlanegcsBackend {
  constructor(readonly module: PlanegcsModule) {}

  get aborted(): string | null {
    return this.module.aborted;
  }

  createSystem(): PlanegcsSketchSystem {
    return new PlanegcsSketchSystem(this.module);
  }
}

/** Load a planegcs instance and wrap it as a backend. */
export async function loadPlanegcsBackend(
  options: PlanegcsLoadOptions = {},
): Promise<PlanegcsBackend> {
  return new PlanegcsBackend(await PlanegcsModule.load(options));
}
