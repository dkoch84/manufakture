// Input checks and expression evaluation. Everything here is pure and
// solver-independent; the solver refuses to run while any issue exists.

import { evaluate, type VariableLookup } from '@manufakture/units';
import { sketchIdProblem } from './ids';
import {
  SKETCH_ORIGIN,
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  isDimensional,
  valueKind,
  type EntityKind,
  type PointRef,
  type SketchConstraint,
  type SketchEntity,
  type SketchInput,
  type SketchIssue,
  type Vec2,
} from './model';

/** Kind of an entity id, including the built-in origin (a point) and axes (lines). */
export function kindOf(entities: ReadonlyMap<string, SketchEntity>, id: string): EntityKind | null {
  if (id === SKETCH_ORIGIN) return 'point';
  if (id === SKETCH_X_AXIS || id === SKETCH_Y_AXIS) return 'line';
  return entities.get(id)?.kind ?? null;
}

export function isBuiltin(id: string): boolean {
  return id === SKETCH_ORIGIN || id === SKETCH_X_AXIS || id === SKETCH_Y_AXIS;
}

const POSITIONS: Record<EntityKind, readonly (string | undefined)[]> = {
  point: [undefined],
  line: ['start', 'end'],
  circle: ['center'],
  arc: ['start', 'end', 'center'],
};

/** A key identifying a point reference: `e1`, `e2.start`. */
export function pointKey(ref: PointRef): string {
  return ref.at === undefined ? ref.entity : `${ref.entity}.${ref.at}`;
}

/** Entity ids a constraint references, in field order. */
export function referencedEntities(c: SketchConstraint): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object' && 'entity' in v) out.push((v as PointRef).entity);
  };
  for (const key of ['a', 'b', 'line', 'point', 'on', 'center', 'entity'] as const) {
    if (key in c) add((c as unknown as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Why `ref` does not name a point of `entities`, or `null` when it does.
 * The built-in origin is accepted when `allowOrigin` is set.
 */
export function pointRefProblem(
  entities: ReadonlyMap<string, SketchEntity>,
  ref: PointRef,
  allowOrigin = true,
): string | null {
  if (!ref || typeof ref !== 'object' || typeof ref.entity !== 'string') {
    return 'missing point reference';
  }
  const kind = kindOf(entities, ref.entity);
  if (kind === null) return `unknown entity '${ref.entity}'`;
  if (
    isBuiltin(ref.entity) &&
    (ref.entity !== SKETCH_ORIGIN || !allowOrigin || ref.at !== undefined)
  ) {
    return `'${pointKey(ref)}' cannot be used as a point here`;
  }
  if (!POSITIONS[kind].includes(ref.at)) {
    const allowed = POSITIONS[kind].map((p) => p ?? '(none)').join(', ');
    return `'${pointKey(ref)}': a ${kind} has points ${allowed}`;
  }
  return null;
}

function finite2(v: Vec2): boolean {
  return Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

const MIN_SIZE = 1e-9;

function geometryProblem(e: SketchEntity): string | null {
  switch (e.kind) {
    case 'point':
      return finite2(e.position) ? null : 'Point coordinates must be finite';
    case 'line':
      if (!finite2(e.start) || !finite2(e.end)) return 'Line coordinates must be finite';
      return Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1]) > MIN_SIZE
        ? null
        : 'Line has zero length';
    case 'circle':
      if (!finite2(e.center) || !Number.isFinite(e.radius)) return 'Circle must be finite';
      return e.radius > MIN_SIZE ? null : 'Circle radius must be positive';
    case 'arc': {
      if (!finite2(e.center) || !finite2(e.start) || !finite2(e.end)) return 'Arc must be finite';
      const r = Math.hypot(e.start[0] - e.center[0], e.start[1] - e.center[1]);
      return r > MIN_SIZE ? null : 'Arc radius must be positive';
    }
  }
}

type Want = EntityKind | 'curve' | 'round' | 'lineOrRound';

function accepts(want: Want, kind: EntityKind): boolean {
  switch (want) {
    case 'curve':
      return kind === 'line' || kind === 'arc';
    case 'round':
      return kind === 'circle' || kind === 'arc';
    case 'lineOrRound':
      return kind !== 'point';
    default:
      return kind === want;
  }
}

const WANT_TEXT: Record<Want, string> = {
  point: 'a point',
  line: 'a line',
  circle: 'a circle',
  arc: 'an arc',
  curve: 'a line or an arc',
  round: 'a circle or an arc',
  lineOrRound: 'a line, circle or arc',
};

/** Structural problems: ids, references, geometry. Does not evaluate expressions. */
export function validateSketch(sketch: SketchInput): SketchIssue[] {
  const issues: SketchIssue[] = [];
  const entities = new Map<string, SketchEntity>();
  for (const e of sketch.entities) {
    const problem = sketchIdProblem(e.id);
    if (problem !== null) {
      issues.push({ code: 'invalid-id', message: problem, entityId: e.id });
      continue;
    }
    if (entities.has(e.id)) {
      issues.push({
        code: 'duplicate-id',
        message: `Entity id '${e.id}' is used twice`,
        entityId: e.id,
      });
      continue;
    }
    entities.set(e.id, e);
    const geometry = geometryProblem(e);
    if (geometry !== null) {
      issues.push({ code: 'invalid-geometry', message: `${e.id}: ${geometry}`, entityId: e.id });
    }
  }

  const constraintIds = new Set<string>();
  for (const c of sketch.constraints) {
    const problem = sketchIdProblem(c.id);
    if (problem !== null) {
      issues.push({ code: 'invalid-id', message: problem, constraintId: c.id });
      continue;
    }
    if (constraintIds.has(c.id)) {
      issues.push({
        code: 'duplicate-id',
        message: `Constraint id '${c.id}' is used twice`,
        constraintId: c.id,
      });
      continue;
    }
    constraintIds.add(c.id);
    issues.push(...checkConstraint(c, entities));
  }
  return issues;
}

function checkConstraint(c: SketchConstraint, entities: Map<string, SketchEntity>): SketchIssue[] {
  const issues: SketchIssue[] = [];
  const fail = (code: SketchIssue['code'], message: string) =>
    issues.push({ code, message: `${c.id} (${c.kind}): ${message}`, constraintId: c.id });

  const entity = (id: unknown, want: Want, allowBuiltin = true): EntityKind | null => {
    if (typeof id !== 'string') {
      fail('invalid-reference', 'missing entity reference');
      return null;
    }
    const kind = kindOf(entities, id);
    if (kind === null) {
      fail('unknown-entity', `unknown entity '${id}'`);
      return null;
    }
    if (!allowBuiltin && isBuiltin(id)) {
      fail('invalid-reference', `'${id}' cannot be used here`);
      return null;
    }
    if (!accepts(want, kind)) {
      fail('invalid-reference', `'${id}' is ${WANT_TEXT[kind]}, expected ${WANT_TEXT[want]}`);
      return null;
    }
    return kind;
  };

  const point = (ref: unknown, allowBuiltin = true): boolean => {
    const problem = pointRefProblem(entities, ref as PointRef, allowBuiltin);
    if (problem === null) return true;
    const unknown = problem.startsWith('unknown entity');
    fail(unknown ? 'unknown-entity' : 'invalid-reference', problem);
    return false;
  };

  const distinctPoints = (a: PointRef, b: PointRef) => {
    if (point(a) && point(b) && pointKey(a) === pointKey(b)) {
      fail('invalid-reference', `both points are '${pointKey(a)}'`);
    }
  };
  const distinct = (a: string, b: string) => {
    if (a === b) fail('invalid-reference', `both sides are '${a}'`);
  };

  switch (c.kind) {
    case 'coincident':
      distinctPoints(c.a, c.b);
      break;
    case 'horizontal':
    case 'vertical':
      if ('line' in c) entity(c.line, 'line', false);
      else distinctPoints(c.a, c.b);
      break;
    case 'parallel':
    case 'perpendicular':
    case 'angle':
      entity(c.a, 'line');
      entity(c.b, 'line');
      distinct(c.a, c.b);
      break;
    case 'tangent': {
      if (c.at !== undefined) {
        const ends = ['start', 'end'];
        if (!Array.isArray(c.at) || c.at.length !== 2 || !c.at.every((p) => ends.includes(p))) {
          fail('invalid-reference', "'at' must be two of 'start' and 'end'");
        }
        entity(c.a, 'curve', false);
        entity(c.b, 'curve', false);
      } else {
        const ka = entity(c.a, 'lineOrRound');
        const kb = entity(c.b, 'lineOrRound');
        if (ka === 'line' && kb === 'line') {
          fail('invalid-reference', 'two lines cannot be edge-tangent; use parallel, or give `at`');
        }
      }
      distinct(c.a, c.b);
      break;
    }
    case 'equal': {
      const ka = entity(c.a, 'lineOrRound', false);
      const kb = entity(c.b, 'lineOrRound', false);
      if (ka && kb && (ka === 'line') !== (kb === 'line')) {
        fail('invalid-reference', 'equal needs two lines, or two circles or arcs');
      }
      distinct(c.a, c.b);
      break;
    }
    case 'distance':
      if ('line' in c) {
        point(c.point);
        entity(c.line, 'line');
      } else {
        distinctPoints(c.a, c.b);
      }
      break;
    case 'horizontalDistance':
    case 'verticalDistance':
      distinctPoints(c.a, c.b);
      break;
    case 'radius':
    case 'diameter':
      entity(c.entity, 'round');
      break;
    case 'fix':
      point(c.point, false);
      break;
    case 'midpoint':
      point(c.point);
      entity(c.line, 'line', false);
      break;
    case 'pointOnObject':
      point(c.point);
      entity(c.on, 'lineOrRound');
      break;
    case 'symmetric':
      distinctPoints(c.a, c.b);
      if ('line' in c) entity(c.line, 'line');
      else if (point(c.center) && [c.a, c.b].some((p) => pointKey(p) === pointKey(c.center))) {
        fail('invalid-reference', 'the centre must differ from both points');
      }
      break;
    default: {
      const kind: string = (c as { kind: string }).kind;
      fail('invalid-reference', `unknown constraint kind '${kind}'`);
      return issues;
    }
  }
  if (issues.length === 0 && referencedEntities(c).every(isBuiltin)) {
    fail('invalid-reference', 'references only the fixed origin and axes');
  }
  return issues;
}

export interface EvaluatedValues {
  /** Constraint id to value in millimetres or radians. */
  values: Map<string, number>;
  issues: SketchIssue[];
}

/**
 * Evaluate every dimensional constraint's expression with `packages/units`,
 * using the bare-number units stored with it and the caller's variables.
 * Distances, radii and diameters must be positive; horizontal and vertical
 * distances are signed.
 */
export function evaluateValues(
  constraints: readonly SketchConstraint[],
  variables?: VariableLookup,
): EvaluatedValues {
  const values = new Map<string, number>();
  const issues: SketchIssue[] = [];
  for (const c of constraints) {
    if (!isDimensional(c)) continue;
    const v = c.value as unknown;
    if (!v || typeof v !== 'object' || typeof (v as { source?: unknown }).source !== 'string') {
      issues.push({
        code: 'invalid-value',
        message: `${c.id} (${c.kind}): missing value expression`,
        constraintId: c.id,
      });
      continue;
    }
    const expected = valueKind(c);
    const result = evaluate(c.value.source, {
      expected,
      lengthUnit: c.value.lengthUnit,
      angleUnit: c.value.angleUnit,
      ...(variables ? { variables } : {}),
    });
    if (!result.ok) {
      issues.push({
        code: 'expression',
        message: `${c.id} (${c.kind}): ${result.error.message}`,
        constraintId: c.id,
        error: result.error,
      });
      continue;
    }
    const positive = c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter';
    if (positive && !(result.value > 0)) {
      issues.push({
        code: 'invalid-value',
        message: `${c.id} (${c.kind}): must be greater than zero`,
        constraintId: c.id,
      });
      continue;
    }
    values.set(c.id, result.value);
  }
  return { values, issues };
}
