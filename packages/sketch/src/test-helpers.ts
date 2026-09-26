// Sketch builders for the tests: the T0.4 spike's rectangle, rounded
// rectangle (tangent arc) and N-entity chain, in this package's data model.

import type {
  ArcEntity,
  CircleEntity,
  LineEntity,
  PointEntity,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchInput,
  StoredExpression,
  Vec2,
} from './model';
import { SKETCH_ORIGIN } from './model';

/** A millimetre expression (bare numbers in mm, angles in degrees). */
export function mm(source: string | number): StoredExpression {
  return { source: String(source), lengthUnit: 'mm', angleUnit: 'deg' };
}

/** An angle expression in degrees. */
export function deg(source: string | number): StoredExpression {
  return { source: String(source), lengthUnit: 'mm', angleUnit: 'deg' };
}

export function point(id: string, position: Vec2, construction = false): PointEntity {
  return { id, kind: 'point', construction, position };
}

export function line(id: string, start: Vec2, end: Vec2, construction = false): LineEntity {
  return { id, kind: 'line', construction, start, end };
}

export function circle(
  id: string,
  center: Vec2,
  radius: number,
  construction = false,
): CircleEntity {
  return { id, kind: 'circle', construction, center, radius };
}

export function arc(
  id: string,
  center: Vec2,
  start: Vec2,
  end: Vec2,
  construction = false,
): ArcEntity {
  return { id, kind: 'arc', construction, center, start, end };
}

export const start = (entity: string): PointRef => ({ entity, at: 'start' });
export const end = (entity: string): PointRef => ({ entity, at: 'end' });
export const center = (entity: string): PointRef => ({ entity, at: 'center' });
export const ORIGIN: PointRef = { entity: SKETCH_ORIGIN };

/**
 * Small deterministic offsets so the solver starts away from the answer
 * (a sketch that is already solved proves nothing). Seeded, not random.
 */
export function jitter(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2; // -1 .. 1
}

export type Stage = 'geometry' | 'coincident' | 'hv' | 'tangent' | 'dimensions' | 'anchor';
export const RECT_STAGES: Stage[] = ['geometry', 'coincident', 'hv', 'dimensions', 'anchor'];
export const ROUNDED_STAGES: Stage[] = [
  'geometry',
  'coincident',
  'hv',
  'tangent',
  'dimensions',
  'anchor',
];

/**
 * Axis-aligned rectangle: lines `bottom` (a to b), `right`, `top`, `left`,
 * running counter-clockwise; width and height as point distances; the
 * bottom-left corner anchored on the origin.
 */
export function rectangle(
  o: { width?: number; height?: number; stages?: Stage[]; perturb?: number; prefix?: string } = {},
): SketchInput {
  const { width: w = 40, height: h = 25, stages = RECT_STAGES, perturb = 0, prefix = '' } = o;
  const j = (n: number) => perturb * jitter(n);
  const id = (s: string) => `${prefix}${s}`;
  const has = (s: Stage) => stages.includes(s);
  const entities: SketchEntity[] = [
    line(id('bottom'), [j(1), j(2)], [w + j(3), j(4)]),
    line(id('right'), [w + j(5), j(6)], [w + j(7), h + j(8)]),
    line(id('top'), [w + j(9), h + j(10)], [j(11), h + j(12)]),
    line(id('left'), [j(13), h + j(14)], [j(15), j(16)]),
  ];
  const constraints: SketchConstraint[] = [];
  if (has('coincident')) {
    constraints.push(
      { id: id('co-b'), kind: 'coincident', a: end(id('bottom')), b: start(id('right')) },
      { id: id('co-c'), kind: 'coincident', a: end(id('right')), b: start(id('top')) },
      { id: id('co-d'), kind: 'coincident', a: end(id('top')), b: start(id('left')) },
      { id: id('co-a'), kind: 'coincident', a: end(id('left')), b: start(id('bottom')) },
    );
  }
  if (has('hv')) {
    constraints.push(
      { id: id('h-bottom'), kind: 'horizontal', line: id('bottom') },
      { id: id('h-top'), kind: 'horizontal', line: id('top') },
      { id: id('v-right'), kind: 'vertical', line: id('right') },
      { id: id('v-left'), kind: 'vertical', line: id('left') },
    );
  }
  if (has('dimensions')) {
    constraints.push(
      {
        id: id('width'),
        kind: 'distance',
        a: start(id('bottom')),
        b: end(id('bottom')),
        value: mm(w),
      },
      {
        id: id('height'),
        kind: 'distance',
        a: start(id('right')),
        b: end(id('right')),
        value: mm(h),
      },
    );
  }
  if (has('anchor')) {
    constraints.push({ id: id('anchor'), kind: 'coincident', a: start(id('bottom')), b: ORIGIN });
  }
  return { entities, constraints };
}

export interface UnitOptions {
  prefix: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  stages: Stage[];
  perturb?: number;
  seed?: number;
  /** The width expression (default the number). */
  widthExpression?: string;
}

/**
 * Rectangle whose top-right corner is a tangent arc: 4 lines and 1 arc
 * (5 entities, 25 unknowns, 21 DOF). Ids `<p>bottom`, `<p>right`, `<p>arc`,
 * `<p>top`, `<p>left`; the loop runs counter-clockwise.
 */
export function roundedUnit(o: UnitOptions): SketchInput {
  const { prefix: p, x, y, width: w, height: h, radius: r, stages, perturb = 0, seed = 0 } = o;
  const j = (n: number) => perturb * jitter(seed * 100 + n);
  const has = (s: Stage) => stages.includes(s);
  const id = (s: string) => `${p}${s}`;
  const entities: SketchEntity[] = [
    line(id('bottom'), [x + j(1), y + j(2)], [x + w + j(3), y + j(4)]),
    line(id('right'), [x + w + j(5), y + j(6)], [x + w + j(7), y + h - r + j(8)]),
    arc(
      id('arc'),
      [x + w - r + j(9), y + h - r + j(10)],
      [x + w + j(11), y + h - r + j(12)],
      [x + w - r + j(13), y + h + j(14)],
    ),
    line(id('top'), [x + w - r + j(15), y + h + j(16)], [x + j(17), y + h + j(18)]),
    line(id('left'), [x + j(19), y + h + j(20)], [x + j(21), y + j(22)]),
  ];
  const constraints: SketchConstraint[] = [];
  const tangent = has('tangent');
  if (has('coincident')) {
    constraints.push({
      id: id('co-b'),
      kind: 'coincident',
      a: end(id('bottom')),
      b: start(id('right')),
    });
    // With tangency, the tangent constraints make these two joints.
    if (!tangent) {
      constraints.push(
        { id: id('co-s'), kind: 'coincident', a: end(id('right')), b: start(id('arc')) },
        { id: id('co-e'), kind: 'coincident', a: end(id('arc')), b: start(id('top')) },
      );
    }
    constraints.push(
      { id: id('co-tl'), kind: 'coincident', a: end(id('top')), b: start(id('left')) },
      { id: id('co-a'), kind: 'coincident', a: end(id('left')), b: start(id('bottom')) },
    );
  }
  if (has('hv')) {
    constraints.push(
      { id: id('h-bottom'), kind: 'horizontal', line: id('bottom') },
      { id: id('h-top'), kind: 'horizontal', line: id('top') },
      { id: id('v-right'), kind: 'vertical', line: id('right') },
      { id: id('v-left'), kind: 'vertical', line: id('left') },
    );
  }
  if (tangent) {
    constraints.push(
      { id: id('t-right'), kind: 'tangent', a: id('right'), b: id('arc'), at: ['end', 'start'] },
      { id: id('t-top'), kind: 'tangent', a: id('arc'), b: id('top'), at: ['end', 'start'] },
    );
  }
  if (has('dimensions')) {
    constraints.push(
      {
        id: id('width'),
        kind: 'distance',
        a: start(id('bottom')),
        b: end(id('bottom')),
        value: mm(o.widthExpression ?? w),
      },
      {
        id: id('height'),
        kind: 'distance',
        a: end(id('left')),
        b: start(id('left')),
        value: mm(h),
      },
      { id: id('radius'), kind: 'radius', entity: id('arc'), value: mm(r) },
    );
  }
  return { entities, constraints };
}

/** One rounded rectangle anchored on the origin (40 x 25, radius 6). */
export function roundedRectangle(stages: Stage[] = ROUNDED_STAGES, perturb = 0): SketchInput {
  const unit = roundedUnit({
    prefix: '',
    x: 0,
    y: 0,
    width: 40,
    height: 25,
    radius: 6,
    stages,
    perturb,
  });
  if (stages.includes('anchor')) {
    unit.constraints = [
      ...unit.constraints,
      { id: 'anchor', kind: 'coincident', a: start('bottom'), b: ORIGIN },
    ];
  }
  return unit;
}

export const UNIT = { width: 40, height: 25, radius: 6, gap: 10 };

/**
 * A row of rounded units coupled into one system (planegcs splits decoupled
 * parts into separate subsystems, so coupling is what makes this one N-entity
 * solve): unit k's bottom-left corner is horizontally aligned with unit
 * k-1's bottom-right corner, and in `full` mode a gap distance away. `full`
 * has every dimension (DOF 0, unit 0's width is `#w0`); `free` has none.
 */
export function chain(o: {
  entities: number;
  mode: 'full' | 'free';
  perturb?: number;
}): SketchInput {
  if (o.entities % 5 !== 0) throw new Error('entities must be a multiple of 5');
  const units = o.entities / 5;
  const stages: Stage[] =
    o.mode === 'full'
      ? ['geometry', 'coincident', 'hv', 'tangent', 'dimensions']
      : ['geometry', 'coincident', 'hv', 'tangent'];
  const entities: SketchEntity[] = [];
  const constraints: SketchConstraint[] = [];
  for (let k = 0; k < units; k++) {
    const prefix = `u${k}.`;
    const unit = roundedUnit({
      prefix,
      x: k * (UNIT.width + UNIT.gap),
      y: 0,
      ...UNIT,
      stages,
      perturb: o.perturb ?? 0,
      seed: k,
      ...(o.mode === 'full' && k === 0 ? { widthExpression: '#w0' } : {}),
    });
    entities.push(...unit.entities);
    constraints.push(...unit.constraints);
    if (k === 0) {
      constraints.push({
        id: `${prefix}anchor`,
        kind: 'coincident',
        a: start(`${prefix}bottom`),
        b: ORIGIN,
      });
    } else {
      const prev = `u${k - 1}.bottom`;
      constraints.push({
        id: `${prefix}align`,
        kind: 'horizontal',
        a: end(prev),
        b: start(`${prefix}bottom`),
      });
      if (o.mode === 'full') {
        constraints.push({
          id: `${prefix}gap`,
          kind: 'distance',
          a: end(prev),
          b: start(`${prefix}bottom`),
          value: mm(UNIT.gap),
        });
      }
    }
  }
  return { entities, constraints };
}

/** Coordinates of a point reference in a solved entity list. */
export function pointAt(entities: readonly SketchEntity[], ref: PointRef): Vec2 {
  const e = entities.find((x) => x.id === ref.entity);
  if (!e) throw new Error(`No entity ${ref.entity}`);
  switch (e.kind) {
    case 'point':
      return e.position;
    case 'line':
      return ref.at === 'end' ? e.end : e.start;
    case 'circle':
      return e.center;
    case 'arc':
      return ref.at === 'start' ? e.start : ref.at === 'end' ? e.end : e.center;
  }
}

export function entity<K extends SketchEntity['kind']>(
  entities: readonly SketchEntity[],
  id: string,
  kind: K,
): Extract<SketchEntity, { kind: K }> {
  const e = entities.find((x) => x.id === id);
  if (!e || e.kind !== kind) throw new Error(`No ${kind} ${id}`);
  return e as Extract<SketchEntity, { kind: K }>;
}
