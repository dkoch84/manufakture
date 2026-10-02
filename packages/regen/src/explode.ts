// Exploded views (M4 plan, decision 9 and T4.5a): the one place exploded offsets are computed.
// An exploded view is named, ordered steps, each moving some instances of an assembly along a
// direction by a distance. Steps are applied on top of the solved poses (T2.3c) and never change
// them: the result is a display offset per instance, which the assembly viewport and the drawing
// stage (T4.4e) both add to the solved pose through `explodedOffsets` and `explodedPose`.
//
// Resolving a view (`resolveExplodedView`) evaluates each step's distance and finds its
// direction: a vector as written, or the direction of an instance's named edge or face (a mate
// connector frame's z, from the kernel's `connector` op, turned by that instance's solved pose).
// Whatever does not resolve is a warning on its step, never a failure: a step whose distance or
// direction fails moves nothing, and an instance a step names that the assembly no longer has is
// left out of it. Suppressed instances are not placed, so steps skip them without a warning.
//
// Everything here is pure and synchronous, and imports nothing that needs a worker: the web app
// imports it through the `@manufakture/regen/explode` subpath.

import type { ExplodeStep, ExplodedView, Pose, Vec3 } from '@manufakture/core';
import type { ConnectorReport, Via } from '@manufakture/kernel';
import type { RegenError } from './types';
import { evaluateField, type VariableValues } from './values';

/** Something about a step that did not resolve in full; the rest of the view still applies. */
export type ExplodeWarning =
  /** Instances the step names that the assembly does not have (deleted): left out of it. */
  | { code: 'missing-instance'; message: string; instances: string[] }
  /** The distance does not evaluate: the step moves nothing. */
  | { code: 'expression'; message: string; error: RegenError }
  /** The direction's edge or face does not resolve: the step moves nothing. */
  | {
      code: 'direction';
      message: string;
      reason: 'missing-instance' | 'lost' | 'ambiguous' | 'unsuitable' | 'no-body';
    }
  /** The direction's edge or face resolved, but not exactly by name. */
  | { code: 'reference'; message: string; via: Via; fragile: boolean };

/** One step as resolved: what it moves, which way and how far. */
export interface ExplodeStepResult {
  stepId: string;
  /** The instances it moves: those the step names that are placed, in the step's order. */
  instances: string[];
  /** A unit vector in the assembly's frame; null when the direction does not resolve. */
  direction: Vec3 | null;
  /** In mm; null when it does not evaluate. */
  distance: number | null;
  warnings: ExplodeWarning[];
}

/** An exploded view of an assembly, resolved at the solved poses of one regen. */
export interface ExplodedViewResult {
  explodedViewId: string;
  name: string;
  /** In the view's order. */
  steps: ExplodeStepResult[];
}

export interface ExplodeContext {
  variables: VariableValues;
  /** Every instance id of the assembly, placed or not. */
  instances: ReadonlySet<string>;
  /** Solved poses of the instances that are placed (not suppressed). */
  poses: ReadonlyMap<string, Pose>;
  /**
   * The connector report for a step's direction reference, in its instance's coordinates (a
   * `midpoint` on the edge, a `centroid` on the face); undefined when there is none.
   */
  direction?: (step: ExplodeStep) => ConnectorReport | undefined;
}

/** The kernel connector inference whose frame's z is a step's reference direction. */
export function directionInference(step: ExplodeStep): 'midpoint' | 'centroid' | null {
  const d = step.direction;
  if ('edge' in d) return 'midpoint';
  if ('face' in d) return 'centroid';
  return null;
}

/** Resolve every step of `view` at the solved poses in `context`. */
export function resolveExplodedView(
  view: ExplodedView,
  context: ExplodeContext,
): ExplodedViewResult {
  return {
    explodedViewId: view.id,
    name: view.name,
    steps: view.steps.map((step, i) => resolveStep(step, i, context)),
  };
}

function resolveStep(step: ExplodeStep, index: number, context: ExplodeContext): ExplodeStepResult {
  const warnings: ExplodeWarning[] = [];
  const missing = step.instances.filter((id) => !context.instances.has(id));
  if (missing.length > 0) {
    warnings.push({
      code: 'missing-instance',
      instances: missing,
      message: `Step ${index + 1} moves ${missing.join(', ')}, which the assembly no longer has: ${missing.length === 1 ? 'it is' : 'they are'} left out`,
    });
  }
  const instances = step.instances.filter((id) => context.poses.has(id));

  let distance: number | null = null;
  const r = evaluateField(step.distance, 'length', ['steps', index, 'distance'], context.variables);
  if (r.ok) distance = r.value;
  else {
    warnings.push({
      code: 'expression',
      error: r.error,
      message: `Step ${index + 1}: the distance does not evaluate (${r.error.message}), so the step moves nothing`,
    });
  }

  let direction: Vec3 | null = null;
  const d = step.direction;
  if ('vector' in d) {
    direction = unit(d.vector);
  } else {
    const where = `Step ${index + 1}: the direction's ${'edge' in d ? 'edge' : 'face'} on ${d.instance}`;
    const pose = context.poses.get(d.instance);
    if (pose === undefined) {
      warnings.push({
        code: 'direction',
        reason: 'missing-instance',
        message: `${where} is not placed (${context.instances.has(d.instance) ? 'suppressed' : 'deleted'}), so the step moves nothing`,
      });
    } else {
      const report = context.direction?.(step);
      if (report === undefined || !report.ok) {
        const reason = report === undefined ? 'no-body' : report.status;
        warnings.push({
          code: 'direction',
          reason,
          message: `${where} ${report === undefined ? 'has no body to sit on' : `does not resolve: ${report.message}`}, so the step moves nothing: re-pick it`,
        });
      } else {
        const z = rotate(pose.rotation, unit(report.frame.normal));
        direction = d.flip ? [-z[0], -z[1], -z[2]] : z;
        if (report.via !== 'exact' || report.fragile) {
          warnings.push({
            code: 'reference',
            via: report.via,
            fragile: report.fragile,
            message: `${where} resolved ${report.fragile ? 'by position' : `by ${report.via}`}: check it still points the intended way`,
          });
        }
      }
    }
  }
  return { stepId: step.id, instances, direction, distance, warnings };
}

/**
 * How far step `index` of `count` has gone at `progress` (0 assembled, 1 exploded): the steps
 * play one after another, each over an equal share of the way.
 */
export function stepFraction(progress: number, count: number, index: number): number {
  if (count <= 0) return 0;
  const p = Math.min(1, Math.max(0, progress));
  return Math.min(1, Math.max(0, p * count - index));
}

/** The move of one step at full extent; null when the step moves nothing. */
export function stepMove(step: ExplodeStepResult): Vec3 | null {
  if (step.direction === null || step.distance === null || step.instances.length === 0) {
    return null;
  }
  return scale(step.direction, step.distance);
}

/**
 * Each moved instance's display offset at `progress` (default 1, fully exploded), in the
 * assembly's frame. Steps add up in order. Instances no step moves are not in the map.
 */
export function explodedOffsets(view: ExplodedViewResult, progress = 1): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  view.steps.forEach((step, i) => {
    const move = stepMove(step);
    const f = stepFraction(progress, view.steps.length, i);
    if (move === null || f === 0) return;
    for (const id of step.instances) {
      out.set(id, add(out.get(id) ?? [0, 0, 0], scale(move, f)));
    }
  });
  return out;
}

/** A solved pose moved by an exploded offset; the pose itself when there is none. */
export function explodedPose(pose: Pose, offset: Vec3 | undefined): Pose {
  if (offset === undefined) return pose;
  return { translation: add(pose.translation, offset), rotation: pose.rotation };
}

/** Where each step moves each instance: offsets before and after the step, at `progress`. */
export interface ExplodeTrail {
  stepId: string;
  instanceId: string;
  from: Vec3;
  to: Vec3;
}

/**
 * The trail lines of a view at `progress`: per step that has started, per instance it moves, the
 * offset before the step and the offset it has reached. Add a point of the instance (at its
 * solved pose) to both ends to draw it.
 */
export function explodeTrails(view: ExplodedViewResult, progress = 1): ExplodeTrail[] {
  const at = new Map<string, Vec3>();
  const out: ExplodeTrail[] = [];
  view.steps.forEach((step, i) => {
    const move = stepMove(step);
    const f = stepFraction(progress, view.steps.length, i);
    if (move === null || f === 0) return;
    for (const id of step.instances) {
      const from = at.get(id) ?? [0, 0, 0];
      const to = add(from, scale(move, f));
      at.set(id, to);
      out.push({ stepId: step.stepId, instanceId: id, from, to });
    }
  });
  return out;
}

/** Every warning of a view's steps, with the step each is on. */
export function explodeWarnings(
  view: ExplodedViewResult,
): { stepId: string; warning: ExplodeWarning }[] {
  return view.steps.flatMap((s) => s.warnings.map((warning) => ({ stepId: s.stepId, warning })));
}

// Small vectors ------------------------------------------------------------------------------

function unit(v: readonly number[]): Vec3 {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}

function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** `v` turned by the unit quaternion `q` ([x, y, z, w]). */
function rotate(q: Pose['rotation'], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz x v; v' = v + w t + q.xyz x t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
