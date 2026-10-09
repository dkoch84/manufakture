// Moving an assembly along one mate's coordinate (an interference sweep over a slider's or a
// revolute's travel), and reading a mate's coordinate at poses a caller gives.
//
// `solveAtCoordinate` holds one revolute's or slider's coordinate at a value by solving with that
// mate's limits pinned to it (min = max = value): the solver clamps a tree mate's coordinate to
// its limits (ADR 0008), so the instances on the mate's far side go where the value puts them and
// every other mate keeps its job. Inside a loop of mates limits are not enforced, so there the
// value may not be reached; `reached` says so.

import {
  coordinateCount,
  extractCoordinates,
  jointTransform,
  limitViolation,
  wrapAngle,
  type LimitViolation,
} from './mates';
import type { AssemblyInput, MateInput, MateKind, SolveReport } from './model';
import { solve } from './solver';
import { POSE, compose, invert, mulInv, packPose, unpackPose, type Pose } from './transform';

/** A solve with one mate's coordinate held at a value. */
export interface CoordinateSolve {
  report: SolveReport;
  /** The mate's coordinate after the solve; null when the mate did not solve. */
  coordinate: number | null;
  /** The coordinate is the value asked for (within rounding). */
  reached: boolean;
}

/**
 * Solve `input` with the coordinate of revolute or slider `mateId` held at `value` (radians or
 * mm), the other mates as they are. Throws for a mate that is missing or of another kind.
 */
export function solveAtCoordinate(
  input: AssemblyInput,
  mateId: string,
  value: number,
): CoordinateSolve {
  const mate = input.mates.find((m) => m.id === mateId);
  if (mate === undefined) throw new Error(`There is no mate ${mateId} in the input.`);
  if (mate.kind !== 'slider' && mate.kind !== 'revolute') {
    throw new Error(`Mate ${mateId} is a ${mate.kind}: only a slider or a revolute is swept.`);
  }
  const mates = input.mates.map((m): MateInput =>
    m.id === mateId ? { ...m, limits: { min: value, max: value } } : m,
  );
  const report = solve({ instances: input.instances, mates });
  const solved = report.mates[mateId];
  const coordinate =
    solved !== undefined && solved.status !== 'suppressed' && solved.coordinates.length === 1
      ? solved.coordinates[0]!
      : null;
  const reached = coordinate !== null && coordinateDistance(mate.kind, coordinate, value) <= 1e-6;
  return { report, coordinate, reached };
}

function coordinateDistance(kind: MateKind, a: number, b: number): number {
  return kind === 'revolute' ? Math.abs(wrapAngle(a - b)) : Math.abs(a - b);
}

/** A mate's coordinates read from instance poses, and how far the poses are from obeying it. */
export interface PosedMate {
  /** The free coordinates nearest the poses (`MateReport.coordinates` order). */
  coordinates: number[];
  /** How far connector b is from where the mate at those coordinates would hold it. */
  residual: { position: number; angle: number };
  /** A revolute's or slider's coordinate past one of its limits, else null. */
  outsideLimits: LimitViolation | null;
}

/**
 * The coordinates of `mate` with its instances at `poses` (instance coordinates to world), and
 * whether the poses keep the mate (`residual`) and its limits: what a caller that places
 * instances by hand checks before trusting the placement. A revolute's angle is taken at the turn
 * nearest its limits.
 */
export function posedMate(mate: MateInput, poseA: Pose, poseB: Pose): PosedMate {
  // rel = (W_a C_a O)^-1 (W_b C_b): connector b's frame in connector a's after the offset.
  let a = compose(poseA, mate.a.frame);
  if (mate.offset !== undefined) a = compose(a, mate.offset);
  const rel = compose(invert(a), compose(poseB, mate.b.frame));
  const t = new Float64Array(POSE * 2);
  packPose(t, 0, rel);
  const n = coordinateCount(mate.kind);
  const q = new Float64Array(Math.max(n, 1));
  extractCoordinates(mate.kind, t, 0, q, 0);
  const coordinates = Array.from(q.subarray(0, n));
  // The residual: J(q)^-1 rel, what the mate at those coordinates leaves over.
  jointTransform(mate.kind, q, 0, t, POSE);
  mulInv(t, POSE, t, POSE, t, 0);
  const r = unpackPose(t, POSE);
  const residual = {
    position: Math.hypot(...r.translation),
    angle: 2 * Math.acos(Math.min(1, Math.abs(r.rotation[3]))),
  };
  let outsideLimits: LimitViolation | null = null;
  if ((mate.kind === 'slider' || mate.kind === 'revolute') && mate.limits !== undefined) {
    let v = coordinates[0]!;
    if (mate.kind === 'revolute') v = nearestTurnOf(v, mate.limits.min, mate.limits.max);
    coordinates[0] = v;
    outsideLimits = limitViolation(v, mate.limits, mate.kind === 'revolute' ? 1e-9 : 1e-6);
  }
  return { coordinates, residual, outsideLimits };
}

/** The angle a + 2 pi k inside [min, max], or the one nearest to it (a bound left out: none). */
function nearestTurnOf(a: number, min: number | undefined, max: number | undefined): number {
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  let best = a;
  let bestDist = Infinity;
  for (let k = -3; k <= 3; k++) {
    const v = a + 2 * Math.PI * k;
    const dist = v < lo ? lo - v : v > hi ? v - hi : 0;
    if (dist < bestDist - 1e-12) {
      best = v;
      bestDist = dist;
    }
  }
  return best;
}

/** Most values one sweep checks: 100 steps and both ends. */
export const MAX_SWEEP_VALUES = 101;

/**
 * The values of a sweep from `from` to `to` (either way round) `step` apart, both ends included:
 * the last step is shorter when the range is not a whole number of steps. Null when that is more
 * than `max` values or the step is not a positive number.
 */
export function sweepValues(
  from: number,
  to: number,
  step: number,
  max = MAX_SWEEP_VALUES,
): number[] | null {
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  const span = Math.abs(to - from);
  // Rounding must not add a sliver of a step: 18 / 0.9 is 20 steps, not 21.
  const steps = Math.max(0, Math.ceil(span / step - 1e-9));
  if (steps + 1 > max) return null;
  const sign = to >= from ? 1 : -1;
  const values: number[] = [];
  for (let i = 0; i < steps; i++) values.push(from + sign * step * i);
  values.push(to);
  return values;
}
