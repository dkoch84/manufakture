// The resistance modes of a load case (ADR 0017 decision 10, plan "The domain model"): the force
// the machine sets at the cable as a law of cable extension and speed. They are what the rep
// simulation (T9.4b) asks of the controller and what the control specification (T9.9d) turns into
// firmware requirements, so each law is stated here once, in SI, and evaluated by one function.
//
// Conventions: `x` is the cable extension in metres from where the rep starts (the docked or
// shortest position), `v` the cable speed in m/s, positive while the cable pays out (the pull),
// negative while it winds back in (the return). Forces are newtons of cable tension, never below
// zero. The load case's `force` is the setting: the base force for the constant, eccentric, band,
// chains, isokinetic and isometric laws, and the most the damper, rowing and table laws may give
// (their curves are clipped to it). The take-up tension that keeps a slack cable wound is the
// drivetrain's and is not part of any law.
//
//   constant     F
//   eccentric    F on the pull, F * factor on the return (factor at least 1)
//   band         F + rate * x
//   chains       F + rate * max(0, x - from): links leave the floor once the cable passes `from`
//   isokinetic   F at the speed limit, none below it; the machine lets the cable go no faster
//   damper       min(c * v, F) on the pull, none on the return (c in N*s/m)
//   rowing       min(c * v^2, F) on the pull, none on the return (c in N*s^2/m^2, a fan)
//   isometric    F, held at one position for `duration`
//   table        the table's force at x (by position) or at v (by speed), linear between points,
//                held flat beyond the ends, clipped to F

import type { LoadCase, ResistanceMode, StoredExpression } from '@manufakture/core';
import { makeDimension, type VariableLookup } from '@manufakture/units';
import { FieldReader, type ItemProblem } from './values';

export type ResistanceModeKind = ResistanceMode['kind'];

/** Every mode, in the order the editor lists them. */
export const RESISTANCE_MODES: readonly ResistanceModeKind[] = [
  'constant',
  'eccentric',
  'band',
  'chains',
  'isokinetic',
  'damper',
  'rowing',
  'isometric',
  'table',
];

/** A mode's name and its law in words, for the editor and the specifications. */
export const RESISTANCE_MODE_TEXT: Readonly<
  Record<ResistanceModeKind, { name: string; law: string }>
> = {
  constant: { name: 'Constant', law: 'the same force out and back' },
  eccentric: {
    name: 'Eccentric',
    law: 'the force on the pull, the force times the factor on the return',
  },
  band: { name: 'Band', law: 'the force plus the rate times the extension' },
  chains: {
    name: 'Chains',
    law: 'the force, plus the rate times the extension beyond where the chains leave the floor',
  },
  isokinetic: {
    name: 'Isokinetic',
    law: 'the force at the speed limit and none below it; the cable goes no faster than the limit',
  },
  damper: { name: 'Damper', law: 'the coefficient times the speed on the pull, up to the force' },
  rowing: {
    name: 'Rowing',
    law: 'the coefficient times the speed squared on the pull, up to the force',
  },
  isometric: { name: 'Isometric', law: 'the force, held at one position for the duration' },
  table: { name: 'Table', law: 'your force curve by position or by speed, up to the force' },
};

/** A damper's coefficient: force per speed. */
export const DAMPER_DIMENSION = {
  dimension: makeDimension({ mass: 1, time: -1 }),
  unit: 'a force per speed, N*s/m',
};
/** A rowing (fan) coefficient: force per speed squared. */
export const ROWING_DIMENSION = {
  dimension: makeDimension({ mass: 1, length: -1 }),
  unit: 'a force per speed squared, N*s^2/m^2',
};

/** Above this the laws refuse a value: well past any machine M9 designs for. */
const MAX_FORCE = 1e6;
const MAX_FACTOR = 10;

/** A resistance mode with every value in SI. */
export type ForceLaw =
  | { kind: 'constant'; force: number }
  | { kind: 'eccentric'; force: number; factor: number }
  | { kind: 'band'; force: number; rate: number }
  | { kind: 'chains'; force: number; rate: number; from: number }
  | { kind: 'isokinetic'; force: number; speed: number }
  | { kind: 'damper'; force: number; coefficient: number }
  | { kind: 'rowing'; force: number; coefficient: number }
  | { kind: 'isometric'; force: number; duration: number }
  | {
      kind: 'table';
      force: number;
      by: 'position' | 'speed';
      points: readonly (readonly [number, number])[];
    };

/** Relative tolerance for "at the speed limit". */
const AT_LIMIT = 1e-9;

/** Linear interpolation in sorted points, held flat beyond the ends. */
export function interpolate(points: readonly (readonly [number, number])[], at: number): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (at <= first[0]) return first[1];
  if (at >= last[0]) return last[1];
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= at) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = points[lo]!;
  const [x1, y1] = points[hi]!;
  return y0 + ((y1 - y0) * (at - x0)) / (x1 - x0);
}

/** The cable force (N) a law sets at extension `x` (m) and speed `v` (m/s, + paying out). */
export function forceAt(law: ForceLaw, x: number, v: number): number {
  const F = law.force;
  switch (law.kind) {
    case 'constant':
    case 'isometric':
      return F;
    case 'eccentric':
      return v < 0 ? F * law.factor : F;
    case 'band':
      return F + law.rate * Math.max(0, x);
    case 'chains':
      return F + law.rate * Math.max(0, x - law.from);
    case 'isokinetic':
      return Math.abs(v) >= law.speed * (1 - AT_LIMIT) ? F : 0;
    case 'damper':
      return v > 0 ? Math.min(law.coefficient * v, F) : 0;
    case 'rowing':
      return v > 0 ? Math.min(law.coefficient * v * v, F) : 0;
    case 'table':
      return Math.min(Math.max(0, interpolate(law.points, law.by === 'position' ? x : v)), F);
  }
}

/** The speed the cable may move at under a law: the isokinetic limit caps it. */
export function limitSpeed(law: ForceLaw, v: number): number {
  if (law.kind !== 'isokinetic') return v;
  return Math.sign(v) * Math.min(Math.abs(v), law.speed);
}

type Dynamic = NonNullable<LoadCase['dynamic']>;

/**
 * A load case's force law in SI, or every problem with the field's path from the load case
 * (`['dynamic', 'mode', 'factor']`). The setting must be above zero; a factor at least 1 and at
 * most 10; rates and `from` not below zero; a speed limit, coefficient and duration above zero; a
 * table's keys strictly increasing and its forces not below zero.
 */
export function resolveForceLaw(
  dynamic: Dynamic,
  variables: VariableLookup,
  reader: FieldReader = new FieldReader(variables),
): { ok: true; law: ForceLaw } | { ok: false; problems: ItemProblem[] } {
  const at = (...p: (string | number)[]) => ['dynamic', 'mode', ...p];
  const force = reader.read(['dynamic', 'force'], dynamic.force, 'force', {
    above: 0,
    max: MAX_FORCE,
    what: 'the force',
  });
  const m = dynamic.mode;
  const num = (
    key: string,
    expr: StoredExpression,
    kind: 'number' | 'stiffness' | 'length' | 'speed' | 'time',
    range: Parameters<FieldReader['read']>[3],
  ) => reader.read(at(key), expr, kind, range);
  let law: ForceLaw;
  switch (m.kind) {
    case 'constant':
      law = { kind: 'constant', force };
      break;
    case 'eccentric':
      law = {
        kind: 'eccentric',
        force,
        factor: num('factor', m.factor, 'number', { min: 1, max: MAX_FACTOR, what: 'the factor' }),
      };
      break;
    case 'band':
      law = {
        kind: 'band',
        force,
        rate: num('rate', m.rate, 'stiffness', { min: 0, what: 'the rate' }),
      };
      break;
    case 'chains':
      law = {
        kind: 'chains',
        force,
        rate: num('rate', m.rate, 'stiffness', { min: 0, what: 'the rate' }),
        from: num('from', m.from, 'length', { min: 0, what: 'where the chains leave the floor' }),
      };
      break;
    case 'isokinetic':
      law = {
        kind: 'isokinetic',
        force,
        speed: num('speed', m.speed, 'speed', { above: 0, what: 'the speed limit' }),
      };
      break;
    case 'damper':
    case 'rowing':
      law = {
        kind: m.kind,
        force,
        coefficient: reader.read(
          at('coefficient'),
          m.coefficient,
          'any',
          { above: 0, what: 'the coefficient' },
          m.kind === 'damper' ? DAMPER_DIMENSION : ROWING_DIMENSION,
        ),
      };
      break;
    case 'isometric':
      law = {
        kind: 'isometric',
        force,
        duration: num('duration', m.duration, 'time', { above: 0, what: 'the duration' }),
      };
      break;
    case 'table': {
      m.points.forEach(([k, f], i) => {
        if (i > 0 && !(k > m.points[i - 1]![0])) {
          reader.problem(
            at('points', i),
            `the ${m.by === 'position' ? 'positions' : 'speeds'} must increase from one point to the next`,
          );
        }
        if (f < 0) reader.problem(at('points', i), 'a force must not be below zero');
      });
      law = { kind: 'table', force, by: m.by, points: m.points.map(([k, f]) => [k, f] as const) };
      break;
    }
  }
  if (reader.problems.length > 0) return { ok: false, problems: [...reader.problems] };
  return { ok: true, law };
}

/** A point of a plotted curve: the abscissa (m or m/s) and the force (N). */
export type CurvePoint = readonly [number, number];

/** A law's force against position and against speed, for the editor's plot. */
export interface ForceCurves {
  /** Force against extension, pulling at `pullSpeed` and returning at `returnSpeed`. */
  byPosition: { pull: CurvePoint[]; return: CurvePoint[]; from: number; to: number };
  /** Force against speed (negative: the return) at extension `at`. */
  bySpeed: { points: CurvePoint[]; at: number; from: number; to: number };
  pullSpeed: number;
  returnSpeed: number;
}

/** The plot's ranges, from the motion where there is one (stroke and speeds). */
export interface CurveRange {
  stroke?: number;
  pullSpeed?: number;
  returnSpeed?: number;
}

const SAMPLES = 120;

function sampled(from: number, to: number, extra: readonly number[]): number[] {
  const out = new Set<number>();
  for (let i = 0; i <= SAMPLES; i++) out.add(from + ((to - from) * i) / SAMPLES);
  for (const e of extra) if (e >= from && e <= to) out.add(e);
  return [...out].sort((a, b) => a - b);
}

/**
 * The law's force against position (over the stroke, or a range that shows its shape) and against
 * speed (from the fastest return to the fastest pull, at mid-stroke). Breakpoints (the chains'
 * `from`, the isokinetic limit, table points) are sampled on both sides so steps and kinks show.
 */
export function forceCurves(law: ForceLaw, range: CurveRange = {}): ForceCurves {
  const pullSpeed = range.pullSpeed ?? (law.kind === 'isokinetic' ? law.speed : 1);
  const returnSpeed = range.returnSpeed ?? pullSpeed;
  let xMax = range.stroke ?? 1;
  if (law.kind === 'chains') xMax = Math.max(xMax, law.from * 1.5);
  if (law.kind === 'table' && law.by === 'position') xMax = Math.max(xMax, law.points.at(-1)![0]);
  if (!(xMax > 0)) xMax = 1;
  let vMax = Math.max(pullSpeed, returnSpeed) * 1.25;
  if (law.kind === 'isokinetic') vMax = Math.max(vMax, law.speed * 1.25);
  if (law.kind === 'table' && law.by === 'speed') {
    vMax = Math.max(vMax, ...law.points.map(([k]) => Math.abs(k)));
  }
  if (!(vMax > 0)) vMax = 1;
  const xBreaks: number[] = [];
  const vBreaks: number[] = [0, -Number.EPSILON, Number.EPSILON];
  if (law.kind === 'chains') xBreaks.push(law.from);
  if (law.kind === 'table')
    (law.by === 'position' ? xBreaks : vBreaks).push(...law.points.map(([k]) => k));
  if (law.kind === 'isokinetic') {
    const below = law.speed * (1 - 1e-6);
    vBreaks.push(law.speed, -law.speed, below, -below);
  }
  if (law.kind === 'damper' || law.kind === 'rowing') {
    // Where the curve meets the setting.
    const knee =
      law.kind === 'damper' ? law.force / law.coefficient : Math.sqrt(law.force / law.coefficient);
    vBreaks.push(knee);
  }
  // Under the isokinetic law the force against extension is plotted at the slower of the motion's
  // speed and the limit, the speed the cable can reach: the force where that is the limit, none
  // where the motion stays below it.
  const vPull = law.kind === 'isokinetic' ? Math.min(pullSpeed, law.speed) : pullSpeed;
  const vRet = law.kind === 'isokinetic' ? Math.min(returnSpeed, law.speed) : returnSpeed;
  const xs = sampled(0, xMax, xBreaks);
  const at = (range.stroke ?? xMax) / 2;
  return {
    byPosition: {
      pull: xs.map((x) => [x, forceAt(law, x, vPull)] as const),
      return: xs.map((x) => [x, forceAt(law, x, -vRet)] as const),
      from: 0,
      to: xMax,
    },
    bySpeed: {
      points: sampled(-vMax, vMax, vBreaks).map((v) => [v, forceAt(law, at, v)] as const),
      at,
      from: -vMax,
      to: vMax,
    },
    pullSpeed: vPull,
    returnSpeed: vRet,
  };
}
