// The sketch data model: plain, JSON-serializable data with no solver code, so
// the document (packages/core) can hold sketches without loading planegcs.
// Import it on its own as `@manufakture/sketch/model`.
//
// Units are millimetres and radians (ADR 0005). Coordinates are in the sketch
// plane (see placement.ts). Entities carry their last solved coordinates:
// they are the solver's starting point and decide which solution a sketch
// settles into (ADR 0004, decision 1); the constraints are what define it.

import type { AngleUnit, LengthUnit, UnitsError } from '@manufakture/units';

export type { SketchPlacement } from './placement';

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/**
 * A number as the user typed it, with the bare-number units in force when it
 * was entered (ADR 0004, decision 7). Evaluated with `packages/units`.
 */
export interface StoredExpression {
  source: string;
  lengthUnit: LengthUnit;
  angleUnit: AngleUnit;
}

// Entities ------------------------------------------------------------------

interface EntityBase {
  /** Permanent, never reused; see ids.ts for the syntax. */
  id: string;
  /** Construction geometry is solved like any other but never becomes a profile edge. */
  construction: boolean;
}

export interface PointEntity extends EntityBase {
  kind: 'point';
  position: Vec2;
}

/** A line segment that owns its two endpoints (FreeCAD's model). */
export interface LineEntity extends EntityBase {
  kind: 'line';
  start: Vec2;
  end: Vec2;
}

export interface CircleEntity extends EntityBase {
  kind: 'circle';
  center: Vec2;
  radius: number;
}

/**
 * A circular arc running counter-clockwise from `start` to `end` around
 * `center`. Radius and angles are derived: the solver keeps `start` and `end`
 * on the circle.
 */
export interface ArcEntity extends EntityBase {
  kind: 'arc';
  center: Vec2;
  start: Vec2;
  end: Vec2;
}

export type SketchEntity = PointEntity | LineEntity | CircleEntity | ArcEntity;
export type EntityKind = SketchEntity['kind'];

// References ----------------------------------------------------------------

/**
 * Built-in fixed geometry every sketch can reference: the sketch origin and
 * its two axes. Their ids start with `@`, which entity ids cannot.
 */
export const SKETCH_ORIGIN = '@origin';
export const SKETCH_X_AXIS = '@x-axis';
export const SKETCH_Y_AXIS = '@y-axis';
export const BUILTIN_IDS: readonly string[] = [SKETCH_ORIGIN, SKETCH_X_AXIS, SKETCH_Y_AXIS];

export type PointPosition = 'start' | 'end' | 'center';
export type EndPosition = 'start' | 'end';

/**
 * A point of the sketch: a point entity (no `at`), or a vertex of a line
 * (`start`, `end`), circle (`center`) or arc (`start`, `end`, `center`).
 */
export interface PointRef {
  entity: string;
  at?: PointPosition;
}

// Constraints ---------------------------------------------------------------

interface ConstraintBase {
  /** Permanent, never reused. Constraints are listed in creation order. */
  id: string;
}

/** Two points at the same place. */
export interface CoincidentConstraint extends ConstraintBase {
  kind: 'coincident';
  a: PointRef;
  b: PointRef;
}

/** A line, or the segment between two points, parallel to the sketch x axis. */
export type HorizontalConstraint = ConstraintBase & { kind: 'horizontal' } & LineOrPoints;
/** A line, or the segment between two points, parallel to the sketch y axis. */
export type VerticalConstraint = ConstraintBase & { kind: 'vertical' } & LineOrPoints;
export type LineOrPoints = { line: string } | { a: PointRef; b: PointRef };

/** Two lines parallel. */
export interface ParallelConstraint extends ConstraintBase {
  kind: 'parallel';
  a: string;
  b: string;
}

/** Two lines perpendicular. */
export interface PerpendicularConstraint extends ConstraintBase {
  kind: 'perpendicular';
  a: string;
  b: string;
}

/**
 * Two curves tangent. With `at`, an endpoint-to-endpoint tangency between
 * lines and arcs: the given ends are joined (the constraint includes the
 * coincidence) and the curves meet smoothly, FreeCAD's model. Without `at`,
 * an edge tangency between a line and a circle or arc, or two circles/arcs.
 */
export interface TangentConstraint extends ConstraintBase {
  kind: 'tangent';
  a: string;
  b: string;
  at?: readonly [EndPosition, EndPosition];
}

/** Two lines of equal length, or two circles/arcs of equal radius. */
export interface EqualConstraint extends ConstraintBase {
  kind: 'equal';
  a: string;
  b: string;
}

/** Distance between two points, or from a point to a line (its infinite extension). Length. */
export type DistanceConstraint = ConstraintBase & { kind: 'distance'; value: StoredExpression } & (
    { a: PointRef; b: PointRef } | { point: PointRef; line: string }
  );

/** Signed: `b.x - a.x = value`. Length. */
export interface HorizontalDistanceConstraint extends ConstraintBase {
  kind: 'horizontalDistance';
  a: PointRef;
  b: PointRef;
  value: StoredExpression;
}

/** Signed: `b.y - a.y = value`. Length. */
export interface VerticalDistanceConstraint extends ConstraintBase {
  kind: 'verticalDistance';
  a: PointRef;
  b: PointRef;
  value: StoredExpression;
}

/**
 * Angle from line `a` to line `b`, counter-clockwise, measured between their
 * directions (start to end). Use `SKETCH_X_AXIS` for an angle to the x axis.
 */
export interface AngleConstraint extends ConstraintBase {
  kind: 'angle';
  a: string;
  b: string;
  value: StoredExpression;
}

/** Radius of a circle or arc. Length. */
export interface RadiusConstraint extends ConstraintBase {
  kind: 'radius';
  entity: string;
  value: StoredExpression;
}

/** Diameter of a circle or arc. Length. */
export interface DiameterConstraint extends ConstraintBase {
  kind: 'diameter';
  entity: string;
  value: StoredExpression;
}

/** Pins a point where it is (its stored coordinates). */
export interface FixConstraint extends ConstraintBase {
  kind: 'fix';
  point: PointRef;
}

/** `point` at the middle of line `line`. */
export interface MidpointConstraint extends ConstraintBase {
  kind: 'midpoint';
  point: PointRef;
  line: string;
}

/** `point` on a line (its infinite extension), a circle, or an arc's circle. */
export interface PointOnObjectConstraint extends ConstraintBase {
  kind: 'pointOnObject';
  point: PointRef;
  on: string;
}

/** `a` and `b` mirror images across a line, or about a centre point. */
export type SymmetricConstraint = ConstraintBase & {
  kind: 'symmetric';
  a: PointRef;
  b: PointRef;
} & ({ line: string } | { center: PointRef });

export type SketchConstraint =
  | CoincidentConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | TangentConstraint
  | EqualConstraint
  | DistanceConstraint
  | HorizontalDistanceConstraint
  | VerticalDistanceConstraint
  | AngleConstraint
  | RadiusConstraint
  | DiameterConstraint
  | FixConstraint
  | MidpointConstraint
  | PointOnObjectConstraint
  | SymmetricConstraint;

export type ConstraintKind = SketchConstraint['kind'];

/** Constraints whose value is a length or an angle expression. */
export type DimensionalConstraint = Extract<SketchConstraint, { value: StoredExpression }>;

export const DIMENSIONAL_KINDS = [
  'distance',
  'horizontalDistance',
  'verticalDistance',
  'angle',
  'radius',
  'diameter',
] as const satisfies readonly DimensionalConstraint['kind'][];

export function isDimensional(c: SketchConstraint): c is DimensionalConstraint {
  return (DIMENSIONAL_KINDS as readonly string[]).includes(c.kind);
}

/** What a constraint's value must evaluate to. */
export function valueKind(c: DimensionalConstraint): 'length' | 'angle' {
  return c.kind === 'angle' ? 'angle' : 'length';
}

// Sketch --------------------------------------------------------------------

/** What the solver needs: entities with their last coordinates, constraints in creation order. */
export interface SketchInput {
  entities: readonly SketchEntity[];
  constraints: readonly SketchConstraint[];
}

// Solver results (plain data, so they cross a worker boundary) --------------

export type EntityStatus = 'under' | 'fully' | 'over';

export type SketchIssueCode =
  | 'invalid-id'
  | 'duplicate-id'
  | 'unknown-entity'
  | 'invalid-reference'
  | 'invalid-geometry'
  | 'expression'
  | 'invalid-value';

/** Something wrong with the input; the sketch is not solved while any exist. */
export interface SketchIssue {
  code: SketchIssueCode;
  message: string;
  entityId?: string;
  constraintId?: string;
  /** For `expression`: the units error, with its range in the expression source. */
  error?: UnitsError;
}

export interface Diagnosis {
  /** Remaining degrees of freedom; `null` while constraints conflict (the count is undefined then). */
  dof: number | null;
  /** Every constraint taking part in a conflict, in creation order (one flat list). */
  conflicting: string[];
  /** Constraints implied by others; the solver ignores them. The newest is blamed. */
  redundant: string[];
  partiallyRedundant: string[];
  /**
   * Per entity: `over` when it takes part in a conflicting or redundant
   * constraint, `fully` when none of its coordinates can move, else `under`.
   */
  entities: Record<string, EntityStatus>;
}

/**
 * `solved`: converged (redundant constraints may still be listed).
 * `conflicting`: constraints contradict each other; geometry left as it was.
 * `failed`: no convergence without a detected conflict; geometry left as it was.
 * `invalid`: the input has issues (bad ids, references, expressions); not solved.
 * `aborted`: the solver instance died (out of memory); see `message`.
 */
export type SolveStatus = 'solved' | 'conflicting' | 'failed' | 'invalid' | 'aborted';

export interface SolveResult {
  status: SolveStatus;
  /** The input entities with solved coordinates (unchanged unless `solved`). */
  entities: SketchEntity[];
  diagnosis: Diagnosis;
  issues: SketchIssue[];
  /** A readable summary for non-`solved` results. */
  message?: string;
}

export interface DragResult {
  status: 'solved' | 'failed' | 'aborted';
  /** Entity coordinates packed in entity order; see `packCoordinates`. Transferable. */
  coordinates: Float64Array;
  message?: string;
}

/** Numbers per entity in `DragResult.coordinates`: point 2, line 4, circle 3, arc 6. */
export function coordinateCount(kind: EntityKind): number {
  switch (kind) {
    case 'point':
      return 2;
    case 'line':
      return 4;
    case 'circle':
      return 3;
    case 'arc':
      return 6;
  }
}

/**
 * Pack entity coordinates: point `x y`; line `sx sy ex ey`; circle `cx cy r`;
 * arc `cx cy sx sy ex ey`.
 */
export function packCoordinates(entities: readonly SketchEntity[]): Float64Array {
  const out = new Float64Array(entities.reduce((n, e) => n + coordinateCount(e.kind), 0));
  let i = 0;
  for (const e of entities) {
    const values =
      e.kind === 'point'
        ? e.position
        : e.kind === 'line'
          ? [...e.start, ...e.end]
          : e.kind === 'circle'
            ? [...e.center, e.radius]
            : [...e.center, ...e.start, ...e.end];
    out.set(values, i);
    i += values.length;
  }
  return out;
}

/** The entities with coordinates taken from `coordinates` (as made by `packCoordinates`). */
export function applyCoordinates(
  entities: readonly SketchEntity[],
  coordinates: Float64Array,
): SketchEntity[] {
  const expected = entities.reduce((n, e) => n + coordinateCount(e.kind), 0);
  if (coordinates.length !== expected) {
    throw new Error(`Expected ${expected} coordinates, got ${coordinates.length}`);
  }
  let i = 0;
  const v = (): Vec2 => {
    const p: Vec2 = [coordinates[i]!, coordinates[i + 1]!];
    i += 2;
    return p;
  };
  return entities.map((e): SketchEntity => {
    switch (e.kind) {
      case 'point':
        return { ...e, position: v() };
      case 'line': {
        const start = v();
        return { ...e, start, end: v() };
      }
      case 'circle': {
        const center = v();
        return { ...e, center, radius: coordinates[i++]! };
      }
      case 'arc': {
        const center = v();
        const start = v();
        return { ...e, center, start, end: v() };
      }
    }
  });
}
