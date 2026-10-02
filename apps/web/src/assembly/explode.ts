// The assembly workspace's exploded views (M4 plan, T4.5a), free of React: the commands the
// Explode panel makes (a new view, steps added, edited, reordered and deleted), the rows it lists,
// the display offsets the viewport adds to the solved poses, trail lines, and the drag that adds
// a step by pulling instances along an axis.
//
// Offsets are never computed here: `@manufakture/regen/explode` owns them (the drawing stage calls
// the same function), and regen resolves each step's direction and distance into
// `AssemblyResult.explodedViews`. What the panel shows (which view, how far the slider is) is not
// document state.

import {
  bareUnits,
  EXPLODED_VIEW_COUNTER,
  EXPLODE_STEP_COUNTER,
  previewIds,
  type Assembly,
  type Command,
  type DisplayUnits,
  type ExplodeDirection,
  type ExplodeStep,
  type ExplodedView,
  type Pose,
  type StoredExpression,
} from '@manufakture/core';
import type { Vec3 } from '@manufakture/kernel';
import type { AssemblyResult } from '@manufakture/regen';
import {
  explodeTrails,
  explodedOffsets,
  type ExplodeTrail,
  type ExplodedViewResult,
} from '@manufakture/regen/explode';
import { fromMillimetres } from '@manufakture/units';
import type { GeometryRef } from '../state/selection';
import { transformPoint, type BodyInput } from '../viewport/bodies';
import type { CanvasPoint, ObjectDrag } from '../viewport/engine';
import type { ViewportApi } from '../viewport/Viewport';
import { instanceOf } from './assembly';

/** The axes a step can be added along, in the assembly's frame. */
export type ExplodeAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export const EXPLODE_AXES: readonly ExplodeAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

export function axisVector(axis: ExplodeAxis): Vec3 {
  const sign = axis[0] === '-' ? -1 : 1;
  const i = 'xyz'.indexOf(axis[1]!);
  return [i === 0 ? sign : 0, i === 1 ? sign : 0, i === 2 ? sign : 0];
}

/** The name a new exploded view gets: "Exploded view n", after its id `explode#n`. */
export function newExplodedViewName(id: string): string {
  const n = /#(\d+)$/.exec(id)?.[1];
  return n ? `Exploded view ${n}` : 'Exploded view';
}

/** The command that adds an exploded view with no steps yet, last. */
export function addExplodedViewCommand(assembly: Assembly): {
  command: Command;
  label: string;
  id: string;
} {
  const [id] = previewIds(assembly.nextIds, EXPLODED_VIEW_COUNTER);
  const name = newExplodedViewName(id!);
  return {
    command: {
      type: 'addExplodedView',
      assemblyId: assembly.id,
      explodedView: { id: id!, name, steps: [] },
    },
    label: `Add ${name}`,
    id: id!,
  };
}

/** The command that adds a step moving `instances` along `direction` by `distance`, last. */
export function addStepCommand(
  assembly: Assembly,
  view: ExplodedView,
  instances: readonly string[],
  direction: ExplodeDirection,
  distance: StoredExpression,
): { command: Command; label: string; step: ExplodeStep } {
  const [id] = previewIds(assembly.nextIds, EXPLODE_STEP_COUNTER);
  const step: ExplodeStep = { id: id!, instances: [...instances], direction, distance };
  return {
    command: {
      type: 'addExplodeStep',
      assemblyId: assembly.id,
      explodedViewId: view.id,
      step,
    },
    label: `Add step ${view.steps.length + 1} to ${view.name}`,
    step,
  };
}

/** The command that sets a step's distance. */
export function stepDistanceCommand(
  assembly: Assembly,
  view: ExplodedView,
  step: ExplodeStep,
  distance: StoredExpression,
): { command: Command; label: string } {
  const index = view.steps.findIndex((s) => s.id === step.id);
  return {
    command: {
      type: 'editExplodeStep',
      assemblyId: assembly.id,
      explodedViewId: view.id,
      step: { ...step, distance },
    },
    label: `Edit step ${index + 1} of ${view.name}`,
  };
}

/** The command that moves a step one place earlier (-1) or later (+1); null at an end. */
export function moveStepCommand(
  assembly: Assembly,
  view: ExplodedView,
  stepId: string,
  by: -1 | 1,
): { command: Command; label: string } | null {
  const i = view.steps.findIndex((s) => s.id === stepId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= view.steps.length) return null;
  const steps = [...view.steps];
  [steps[i], steps[j]] = [steps[j]!, steps[i]!];
  return {
    command: {
      type: 'editExplodedView',
      assemblyId: assembly.id,
      explodedView: { ...view, steps },
    },
    label: `Move step ${i + 1} of ${view.name} ${by < 0 ? 'up' : 'down'}`,
  };
}

/** The command that deletes a step. */
export function deleteStepCommand(
  assembly: Assembly,
  view: ExplodedView,
  stepId: string,
): { command: Command; label: string } {
  const i = view.steps.findIndex((s) => s.id === stepId);
  return {
    command: {
      type: 'deleteExplodeStep',
      assemblyId: assembly.id,
      explodedViewId: view.id,
      stepId,
    },
    label: `Delete step ${i + 1} of ${view.name}`,
  };
}

/** A direction in words: an axis, a vector, or the edge or face of an instance it is read from. */
export function directionLabel(direction: ExplodeDirection, assembly: Assembly): string {
  if ('vector' in direction) {
    const v = direction.vector;
    const nonZero = v.flatMap((c, i) => (c === 0 ? [] : [i]));
    if (nonZero.length === 1) {
      const i = nonZero[0]!;
      return `${v[i]! < 0 ? '-' : '+'}${'XYZ'[i]}`;
    }
    return `(${v.map((c) => String(Math.round(c * 1000) / 1000)).join(', ')})`;
  }
  const name =
    assembly.instances.find((x) => x.id === direction.instance)?.name ?? direction.instance;
  const what = 'edge' in direction ? 'edge' : 'face';
  return `${direction.flip ? 'against ' : 'along '}${what} of ${name}`;
}

/** A row of the Explode panel's steps list. */
export interface StepRow {
  step: ExplodeStep;
  index: number;
  /** The names of the instances it moves, in its order. */
  names: string[];
  direction: string;
  /** What regen said about it; empty until there is a result. */
  warnings: string[];
}

export function stepRows(
  assembly: Assembly,
  view: ExplodedView,
  resolved: ExplodedViewResult | undefined,
): StepRow[] {
  return view.steps.map((step, index) => ({
    step,
    index,
    names: step.instances.map((id) => assembly.instances.find((x) => x.id === id)?.name ?? id),
    direction: directionLabel(step.direction, assembly),
    warnings: (resolved?.steps.find((s) => s.stepId === step.id)?.warnings ?? []).map(
      (w) => w.message,
    ),
  }));
}

/** The exploded view the panel shows: `viewId` while the assembly has it, else its first one. */
export function shownExplodedView(
  assembly: Assembly | undefined,
  viewId: string | null,
): ExplodedView | null {
  const views = assembly?.explodedViews ?? [];
  return views.find((v) => v.id === viewId) ?? views[0] ?? null;
}

/** Regen's resolution of exploded view `viewId`, when the result has it. */
export function resolvedView(
  result: AssemblyResult | undefined,
  viewId: string | null,
): ExplodedViewResult | undefined {
  if (viewId === null) return undefined;
  return result?.explodedViews?.find((v) => v.explodedViewId === viewId);
}

/**
 * The display offsets the viewport adds to the solved poses: exploded view `viewId` at `progress`
 * (0 assembled, 1 exploded), plus the move of a step being dragged, if any.
 */
export function displayOffsets(
  result: AssemblyResult | undefined,
  viewId: string | null,
  progress: number,
  dragged: DraggedStep | null = null,
): Map<string, Vec3> {
  const view = resolvedView(result, viewId);
  const out = view ? explodedOffsets(view, progress) : new Map<string, Vec3>();
  if (dragged !== null) {
    for (const id of dragged.instances) {
      const at = out.get(id) ?? [0, 0, 0];
      out.set(id, [at[0] + dragged.move[0], at[1] + dragged.move[1], at[2] + dragged.move[2]]);
    }
  }
  return out;
}

/**
 * The middle of each instance's bounding box, in the instance's own coordinates: where its trail
 * lines start. From the shown bodies' meshes of assembly `assemblyId`.
 */
export function instanceCentres(
  bodies: readonly BodyInput[],
  assemblyId: string,
): Map<string, Vec3> {
  const boxes = new Map<string, { min: number[]; max: number[] }>();
  for (const b of bodies) {
    const id = instanceOf(b.id, assemblyId);
    if (id === null) continue;
    const box = boxes.get(id) ?? {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    const p = b.mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        box.min[k] = Math.min(box.min[k]!, p[i + k]!);
        box.max[k] = Math.max(box.max[k]!, p[i + k]!);
      }
    }
    boxes.set(id, box);
  }
  const out = new Map<string, Vec3>();
  for (const [id, { min, max }] of boxes) {
    if (min[0]! > max[0]!) continue;
    out.set(id, [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2]);
  }
  return out;
}

/** A trail line in world coordinates: one step's move of one instance. */
export interface WorldTrail extends ExplodeTrail {
  start: Vec3;
  end: Vec3;
}

/**
 * The trail lines of exploded view `viewId` at `progress`: from each instance's centre where the
 * step starts to where it has reached, at the solved poses in `poses`.
 */
export function worldTrails(
  result: AssemblyResult | undefined,
  viewId: string | null,
  progress: number,
  poses: ReadonlyMap<string, Pose>,
  centres: ReadonlyMap<string, Vec3>,
): WorldTrail[] {
  const view = resolvedView(result, viewId);
  if (!view) return [];
  return explodeTrails(view, progress).flatMap((t) => {
    const pose = poses.get(t.instanceId);
    const centre = centres.get(t.instanceId);
    if (!pose || !centre) return [];
    const c = transformPoint(pose, centre);
    return [
      {
        ...t,
        start: [c[0] + t.from[0], c[1] + t.from[1], c[2] + t.from[2]],
        end: [c[0] + t.to[0], c[1] + t.to[1], c[2] + t.to[2]],
      },
    ];
  });
}

// Dragging a new step -------------------------------------------------------------------------

/** A step being dragged: the instances it moves and how far so far (world). */
export interface DraggedStep {
  instances: readonly string[];
  move: Vec3;
}

/** How far a cursor point `p` is along `axis` (unit) from `from`. */
export function alongAxis(from: Vec3, axis: Vec3, p: Vec3): number {
  return (p[0] - from[0]) * axis[0] + (p[1] - from[1]) * axis[1] + (p[2] - from[2]) * axis[2];
}

/**
 * The plane a drag along `axis` moves the cursor on: through the grabbed point, containing the
 * axis, and facing the viewer as much as it can. Null when the axis points at the viewer.
 */
export function dragPlaneNormal(axis: Vec3, view: Vec3): Vec3 | null {
  // n = axis x (view x axis): the view direction with its part along the axis removed.
  const d = alongAxis([0, 0, 0], axis, view);
  const n: Vec3 = [view[0] - d * axis[0], view[1] - d * axis[1], view[2] - d * axis[2]];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len < 1e-6 ? null : [n[0] / len, n[1] / len, n[2] / len];
}

/** A distance in mm as an expression in the document's length unit. */
export function distanceExpression(mm: number, units: DisplayUnits): StoredExpression {
  const bare = bareUnits(units);
  const v = fromMillimetres(mm, bare.lengthUnit);
  return { source: String(Math.round(v * 1000) / 1000), ...bare };
}

/** Round a dragged distance to what a person would type: 1 mm, or 0.1 mm under 10 mm. */
export function roundDistance(mm: number): number {
  const step = Math.abs(mm) < 10 ? 0.1 : 1;
  return Math.round(mm / step) * step;
}

export interface ExplodeDragHost {
  viewport: Pick<ViewportApi, 'surfacePoint' | 'viewDirection' | 'canvasToPlane'>;
  /** The assembly shown, or null when none is. */
  assemblyId(): string | null;
  /** The axis the panel adds steps along. */
  axis(): ExplodeAxis;
  /** The instances the panel would move (checked); empty: the instance grabbed. */
  instances(): readonly string[];
  /** Where an instance is shown now (exploded so far), to grab it. */
  transformOf(instanceId: string): Pose | undefined;
  /** Show the step being dragged (null: none). */
  show(dragged: DraggedStep | null): void;
  /** The drag ended: add a step of `distance` mm along the axis (null: nothing to add). */
  done(instances: readonly string[], distance: number | null): void;
  refuse(message: string): void;
}

/**
 * The viewport's object drag while the Explode panel is open: a left-button drag on an instance
 * moves the checked instances (or the one grabbed) along the panel's axis, and the release adds
 * the step, its distance rounded. The poses are never touched.
 */
export function explodeDrag(host: ExplodeDragHost): ObjectDrag {
  let grab: {
    instances: readonly string[];
    world: Vec3;
    normal: Vec3;
    axis: Vec3;
    distance: number;
  } | null = null;
  return {
    start(ref: GeometryRef | null, p: CanvasPoint): boolean {
      const assemblyId = host.assemblyId();
      if (ref === null || assemblyId === null) return false;
      const instanceId = instanceOf(ref.bodyId, assemblyId);
      if (instanceId === null) return false;
      const world = host.viewport.surfacePoint(p.x, p.y);
      if (world === null || host.transformOf(instanceId) === undefined) return false;
      const axis = axisVector(host.axis());
      const normal = dragPlaneNormal(axis, host.viewport.viewDirection());
      if (normal === null) {
        host.refuse(
          `The view looks along ${host.axis().slice(1).toUpperCase()}: turn it to drag along that axis.`,
        );
        return false;
      }
      const checked = host.instances();
      const instances = checked.length > 0 ? checked : [instanceId];
      grab = { instances, world, normal, axis, distance: 0 };
      return true;
    },
    move(p: CanvasPoint): void {
      const g = grab;
      if (!g) return;
      const at = host.viewport.canvasToPlane(p.x, p.y, g.world, g.normal);
      if (at === null) return;
      g.distance = roundDistance(alongAxis(g.world, g.axis, at));
      host.show({ instances: g.instances, move: scaled(g.axis, g.distance) });
    },
    end(p: CanvasPoint | null): void {
      const g = grab;
      grab = null;
      if (!g) return;
      host.show(null);
      host.done(g.instances, p === null || g.distance === 0 ? null : g.distance);
    },
  };
}

/** `v * k`, with no negative zeros (an axis's zero components times a negative distance). */
function scaled(v: Vec3, k: number): Vec3 {
  return [v[0] * k + 0, v[1] * k + 0, v[2] * k + 0];
}
