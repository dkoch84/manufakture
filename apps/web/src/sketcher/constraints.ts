// Geometric constraints applied from the selection (the constraint toolbar),
// and the glyphs that show them next to the geometry.

import {
  SKETCH_X_AXIS,
  SKETCH_Y_AXIS,
  type ConstraintKind,
  type PointRef,
  type SketchConstraint,
  type Vec2,
} from '@manufakture/sketch/model';
import type { DraftConstraint } from './draft';
import { curveAnchor, midpoint, pointPosition, type EntityIndex } from './geometry';
import type { SketchItem } from './items';

export type ConstraintToolKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'equal'
  | 'midpoint'
  | 'fix';

export interface ConstraintTool {
  kind: ConstraintToolKind;
  label: string;
  /** Glyph shown next to the geometry, and on the button. */
  symbol: string;
  /** Keyboard shortcut (lower case), if any. */
  key?: string;
  help: string;
}

export const CONSTRAINT_TOOLS: readonly ConstraintTool[] = [
  {
    kind: 'coincident',
    label: 'Coincident',
    symbol: '•',
    key: 'i',
    help: 'Two points, or a point and a curve',
  },
  { kind: 'horizontal', label: 'Horizontal', symbol: 'H', key: 'h', help: 'Lines, or two points' },
  { kind: 'vertical', label: 'Vertical', symbol: 'V', key: 'v', help: 'Lines, or two points' },
  { kind: 'parallel', label: 'Parallel', symbol: '//', help: 'Two lines' },
  { kind: 'perpendicular', label: 'Perpendicular', symbol: '⊥', help: 'Two lines' },
  {
    kind: 'tangent',
    label: 'Tangent',
    symbol: 'T',
    key: 't',
    help: 'A line and a circle or arc, or two circles or arcs',
  },
  {
    kind: 'equal',
    label: 'Equal',
    symbol: '=',
    key: 'e',
    help: 'Two lines, or two circles or arcs',
  },
  { kind: 'midpoint', label: 'Midpoint', symbol: 'M', help: 'A point and a line' },
  { kind: 'fix', label: 'Fix', symbol: 'F', help: 'Points' },
];

type Classified = { points: PointRef[]; lines: string[]; rounds: string[] };

function classify(items: readonly SketchItem[], index: EntityIndex): Classified {
  const out: Classified = { points: [], lines: [], rounds: [] };
  for (const item of items) {
    if (item.kind === 'point') out.points.push(item.ref);
    else if (item.kind === 'entity') {
      if (item.id === SKETCH_X_AXIS || item.id === SKETCH_Y_AXIS) {
        out.lines.push(item.id);
        continue;
      }
      const e = index.get(item.id);
      if (e?.kind === 'line') out.lines.push(e.id);
      else if (e?.kind === 'circle' || e?.kind === 'arc') out.rounds.push(e.id);
      else if (e?.kind === 'point') out.points.push({ entity: e.id });
    }
  }
  return out;
}

const count = (c: Classified) => c.points.length + c.lines.length + c.rounds.length;

/**
 * The constraints `kind` makes from the selected items, or an empty list when
 * the selection does not fit it. Constraints are never selected items.
 */
export function constraintsFromSelection(
  kind: ConstraintToolKind,
  items: readonly SketchItem[],
  index: EntityIndex,
): DraftConstraint[] {
  const c = classify(items, index);
  const n = count(c);
  const { points, lines, rounds } = c;
  const curves = [...lines, ...rounds];
  switch (kind) {
    case 'coincident':
      if (points.length === 2 && n === 2)
        return [{ kind: 'coincident', a: points[0]!, b: points[1]! }];
      if (points.length === 1 && curves.length === 1 && n === 2) {
        return [{ kind: 'pointOnObject', point: points[0]!, on: curves[0]! }];
      }
      return [];
    case 'horizontal':
    case 'vertical': {
      const own = lines.filter((l) => l !== SKETCH_X_AXIS && l !== SKETCH_Y_AXIS);
      const make = (fields: { line: string } | { a: PointRef; b: PointRef }): DraftConstraint =>
        kind === 'horizontal' ? { kind: 'horizontal', ...fields } : { kind: 'vertical', ...fields };
      if (own.length > 0 && own.length === n) return own.map((line) => make({ line }));
      if (points.length === 2 && n === 2) return [make({ a: points[0]!, b: points[1]! })];
      return [];
    }
    case 'parallel':
    case 'perpendicular':
      if (lines.length === 2 && n === 2) return [{ kind, a: lines[0]!, b: lines[1]! }];
      return [];
    case 'equal':
      if (n === 2 && (lines.length === 2 || rounds.length === 2)) {
        const [a, b] = lines.length === 2 ? lines : rounds;
        return [{ kind: 'equal', a: a!, b: b! }];
      }
      return [];
    case 'tangent':
      if (n === 2 && rounds.length >= 1 && curves.length === 2) {
        return [{ kind: 'tangent', a: curves[0]!, b: curves[1]! }];
      }
      return [];
    case 'midpoint':
      if (n === 2 && points.length === 1 && lines.length === 1) {
        return [{ kind: 'midpoint', point: points[0]!, line: lines[0]! }];
      }
      return [];
    case 'fix':
      if (points.length > 0 && points.length === n)
        return points.map((point) => ({ kind: 'fix', point }));
      return [];
  }
}

const SYMBOLS: Partial<Record<ConstraintKind, string>> = {
  ...Object.fromEntries(CONSTRAINT_TOOLS.map((t) => [t.kind, t.symbol])),
  pointOnObject: '∘',
  symmetric: 'S',
};

export const CONSTRAINT_NAMES: Record<ConstraintKind, string> = {
  coincident: 'Coincident',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  distance: 'Distance',
  horizontalDistance: 'Horizontal distance',
  verticalDistance: 'Vertical distance',
  angle: 'Angle',
  radius: 'Radius',
  diameter: 'Diameter',
  fix: 'Fix',
  midpoint: 'Midpoint',
  pointOnObject: 'Point on curve',
  symmetric: 'Symmetric',
};

export interface Glyph {
  /** The constraint it shows. A constraint on two curves has a glyph on each. */
  constraintId: string;
  kind: ConstraintKind;
  symbol: string;
  /** The geometry it belongs next to. */
  anchor: Vec2;
  /** Position among glyphs at the same anchor, for stacking. */
  slot: number;
}

/** Glyphs for every non-dimensional constraint, in constraint order. */
export function constraintGlyphs(
  constraints: readonly SketchConstraint[],
  index: EntityIndex,
): Glyph[] {
  const out: Glyph[] = [];
  const slots = new Map<string, number>();
  const at = (c: SketchConstraint, anchor: Vec2 | null) => {
    if (!anchor) return;
    const key = `${anchor[0].toFixed(6)},${anchor[1].toFixed(6)}`;
    const slot = slots.get(key) ?? 0;
    slots.set(key, slot + 1);
    out.push({ constraintId: c.id, kind: c.kind, symbol: SYMBOLS[c.kind] ?? '?', anchor, slot });
  };
  const curve = (id: string): Vec2 | null => {
    const e = index.get(id);
    return e ? curveAnchor(e) : null;
  };
  const point = (ref: PointRef) => pointPosition(index, ref);
  for (const c of constraints) {
    switch (c.kind) {
      case 'coincident':
        at(c, point(c.b) ?? point(c.a));
        break;
      case 'horizontal':
      case 'vertical':
        if ('line' in c) at(c, curve(c.line));
        else {
          const a = point(c.a);
          const b = point(c.b);
          at(c, a && b ? midpoint(a, b) : null);
        }
        break;
      case 'parallel':
      case 'perpendicular':
      case 'equal':
        at(c, curve(c.a));
        at(c, curve(c.b));
        break;
      case 'tangent':
        if (c.at) {
          const e = index.get(c.a);
          at(
            c,
            e && (e.kind === 'line' || e.kind === 'arc')
              ? c.at[0] === 'start'
                ? e.start
                : e.end
              : null,
          );
        } else {
          at(c, curve(c.a));
          at(c, curve(c.b));
        }
        break;
      case 'fix':
      case 'midpoint':
      case 'pointOnObject':
        at(c, point(c.point));
        break;
      case 'symmetric': {
        if ('center' in c) at(c, point(c.center));
        else at(c, curve(c.line));
        break;
      }
      default:
        break; // dimensions are drawn as dimensions
    }
  }
  return out;
}
