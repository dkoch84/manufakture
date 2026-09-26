// Sketch builders for the planegcs spike. Every line owns its two endpoints and
// connectivity is expressed with p2p_coincident, which is how a sketcher data
// model stores it (and how FreeCAD's Sketcher feeds planegcs).

import type { SketchParam, SketchPrimitive } from '@salusoft89/planegcs';

export type Item = SketchPrimitive | SketchParam;

/** Constraint kinds, in the order the tests add them to a sketch. */
export type Stage = 'geometry' | 'coincident' | 'hv' | 'tangent' | 'dimensions' | 'anchor';

const ORIGIN = 'origin';

function point(id: string, x: number, y: number, fixed = false): SketchPrimitive {
  return { id, type: 'point', x, y, fixed };
}

function line(id: string, p1: string, p2: string): SketchPrimitive {
  return { id, type: 'line', p1_id: p1, p2_id: p2 };
}

/**
 * Small deterministic offsets so the solver starts away from the answer
 * (a sketch that is already solved proves nothing). Seeded, not random.
 */
function jitter(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2; // -1 .. 1 mm
}

export interface RectOptions {
  width: number;
  height: number;
  /** Include these constraint kinds; geometry is always included. */
  stages: Stage[];
  /** Start coordinates are offset by up to this many mm. */
  perturb?: number;
}

/**
 * Axis-aligned rectangle: 4 lines, 8 points (16 unknowns). Ids:
 * points `r:a1 r:b1` (bottom), `r:b2 r:c2` (right), `r:c3 r:d3` (top),
 * `r:d4 r:a4` (left); lines `r:bottom r:right r:top r:left`.
 */
export function rectangle({ width: w, height: h, stages, perturb = 0 }: RectOptions): Item[] {
  const j = (n: number) => perturb * jitter(n);
  const has = (s: Stage) => stages.includes(s);
  const items: Item[] = [
    point(ORIGIN, 0, 0, true),
    point('r:a1', 0 + j(1), 0 + j(2)),
    point('r:b1', w + j(3), 0 + j(4)),
    point('r:b2', w + j(5), 0 + j(6)),
    point('r:c2', w + j(7), h + j(8)),
    point('r:c3', w + j(9), h + j(10)),
    point('r:d3', 0 + j(11), h + j(12)),
    point('r:d4', 0 + j(13), h + j(14)),
    point('r:a4', 0 + j(15), 0 + j(16)),
    line('r:bottom', 'r:a1', 'r:b1'),
    line('r:right', 'r:b2', 'r:c2'),
    line('r:top', 'r:c3', 'r:d3'),
    line('r:left', 'r:d4', 'r:a4'),
  ];
  if (has('coincident')) {
    items.push(
      { id: 'r:co-b', type: 'p2p_coincident', p1_id: 'r:b1', p2_id: 'r:b2' },
      { id: 'r:co-c', type: 'p2p_coincident', p1_id: 'r:c2', p2_id: 'r:c3' },
      { id: 'r:co-d', type: 'p2p_coincident', p1_id: 'r:d3', p2_id: 'r:d4' },
      { id: 'r:co-a', type: 'p2p_coincident', p1_id: 'r:a4', p2_id: 'r:a1' },
    );
  }
  if (has('hv')) {
    items.push(
      { id: 'r:h-bottom', type: 'horizontal_l', l_id: 'r:bottom' },
      { id: 'r:h-top', type: 'horizontal_l', l_id: 'r:top' },
      { id: 'r:v-right', type: 'vertical_l', l_id: 'r:right' },
      { id: 'r:v-left', type: 'vertical_l', l_id: 'r:left' },
    );
  }
  if (has('dimensions')) {
    items.push(
      { id: 'r:width', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:b1', distance: w },
      { id: 'r:height', type: 'p2p_distance', p1_id: 'r:b2', p2_id: 'r:c2', distance: h },
    );
  }
  if (has('anchor')) {
    items.push({ id: 'r:anchor', type: 'p2p_coincident', p1_id: 'r:a1', p2_id: ORIGIN });
  }
  return items;
}

export interface UnitOptions {
  /** Id prefix, e.g. `u0`. */
  prefix: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  stages: Stage[];
  perturb?: number;
  /** Seed offset for the perturbation, so units differ. */
  seed?: number;
  /**
   * Dimension values: numbers, or names of sketch params (which the drag
   * benchmarks change between solves).
   */
  widthParam?: string;
  /**
   * How the line/arc joints are made tangent. `endpoint` (default) is
   * FreeCAD's endpoint-to-endpoint tangency: the coincident plus
   * angle_via_point with angle 0 at the shared point. `edge` is tangent_la
   * (distance from the arc centre to the line equals the radius) on top of the
   * coincident; the spike shows it degenerates at the solution.
   */
  tangency?: Tangency;
}

export type Tangency = 'endpoint' | 'edge';

/** Point ids of a rounded unit, for callers that attach constraints to it. */
export function unitIds(prefix: string) {
  const p = (n: string) => `${prefix}:${n}`;
  return {
    bottomLeft: p('a1'),
    bottomRight: p('b1'),
    topLeft: p('e3'),
    arcCenter: p('o'),
    arc: p('arc'),
    bottom: p('bottom'),
    right: p('right'),
    top: p('top'),
    left: p('left'),
  };
}

/**
 * Rectangle whose top-right corner is a tangent arc: 4 lines + 1 arc
 * (5 entities), 11 points and 3 arc parameters (25 unknowns).
 *
 *   e3 ---- top ---- d3  e
 *   |                    ) arc (center o, from s at 0 rad to e at pi/2)
 *   left               s c2
 *   |                    |
 *   a4/a1 -- bottom -- b1/b2 (right goes b2 up to c2)
 */
export function roundedUnit(o: UnitOptions): Item[] {
  const { prefix, x, y, width: w, height: h, radius: r, stages, perturb = 0, seed = 0 } = o;
  const p = (n: string) => `${prefix}:${n}`;
  const j = (n: number) => perturb * jitter(seed * 100 + n);
  const has = (s: Stage) => stages.includes(s);
  const items: Item[] = [
    point(p('a1'), x + j(1), y + j(2)),
    point(p('b1'), x + w + j(3), y + j(4)),
    point(p('b2'), x + w + j(5), y + j(6)),
    point(p('c2'), x + w + j(7), y + h - r + j(8)),
    point(p('o'), x + w - r + j(9), y + h - r + j(10)),
    point(p('s'), x + w + j(11), y + h - r + j(12)),
    point(p('e'), x + w - r + j(13), y + h + j(14)),
    point(p('d3'), x + w - r + j(15), y + h + j(16)),
    point(p('e3'), x + j(17), y + h + j(18)),
    point(p('e4'), x + j(19), y + h + j(20)),
    point(p('a4'), x + j(21), y + j(22)),
    line(p('bottom'), p('a1'), p('b1')),
    line(p('right'), p('b2'), p('c2')),
    {
      id: p('arc'),
      type: 'arc',
      c_id: p('o'),
      start_id: p('s'),
      end_id: p('e'),
      radius: r + j(23) * 0.2,
      start_angle: 0 + j(24) * 0.02,
      end_angle: Math.PI / 2 + j(25) * 0.02,
    },
    // arc_rules ties the start/end points to centre, radius and angles.
    // It is a real constraint (4 equations) and part of the geometry.
    { id: p('arc-rules'), type: 'arc_rules', a_id: p('arc') },
    line(p('top'), p('d3'), p('e3')),
    line(p('left'), p('e4'), p('a4')),
  ];
  if (has('coincident')) {
    items.push(
      { id: p('co-b'), type: 'p2p_coincident', p1_id: p('b1'), p2_id: p('b2') },
      { id: p('co-s'), type: 'p2p_coincident', p1_id: p('c2'), p2_id: p('s') },
      { id: p('co-e'), type: 'p2p_coincident', p1_id: p('e'), p2_id: p('d3') },
      { id: p('co-tl'), type: 'p2p_coincident', p1_id: p('e3'), p2_id: p('e4') },
      { id: p('co-a'), type: 'p2p_coincident', p1_id: p('a4'), p2_id: p('a1') },
    );
  }
  if (has('hv')) {
    items.push(
      { id: p('h-bottom'), type: 'horizontal_l', l_id: p('bottom') },
      { id: p('h-top'), type: 'horizontal_l', l_id: p('top') },
      { id: p('v-right'), type: 'vertical_l', l_id: p('right') },
      { id: p('v-left'), type: 'vertical_l', l_id: p('left') },
    );
  }
  if (has('tangent')) {
    if ((o.tangency ?? 'endpoint') === 'edge') {
      items.push(
        { id: p('t-right'), type: 'tangent_la', l_id: p('right'), a_id: p('arc') },
        { id: p('t-top'), type: 'tangent_la', l_id: p('top'), a_id: p('arc') },
      );
    } else {
      // Angle between the curves' tangent directions at the joint. Both lines
      // run the same way as the (counter-clockwise) arc there, so it is 0.
      items.push(
        {
          id: p('t-right'),
          type: 'angle_via_point',
          crv1_id: p('right'),
          crv2_id: p('arc'),
          p_id: p('s'),
          angle: 0,
        },
        {
          id: p('t-top'),
          type: 'angle_via_point',
          crv1_id: p('arc'),
          crv2_id: p('top'),
          p_id: p('e'),
          angle: 0,
        },
      );
    }
  }
  if (has('dimensions')) {
    items.push(
      {
        id: p('width'),
        type: 'p2p_distance',
        p1_id: p('a1'),
        p2_id: p('b1'),
        distance: o.widthParam ?? w,
      },
      { id: p('height'), type: 'p2p_distance', p1_id: p('a4'), p2_id: p('e4'), distance: h },
      { id: p('radius'), type: 'arc_radius', a_id: p('arc'), radius: r },
    );
  }
  return items;
}

/** A single rounded rectangle anchored to a fixed origin point (the step 3 test). */
export function roundedRectangle(
  stages: Stage[],
  perturb = 0,
  tangency: Tangency = 'endpoint',
): Item[] {
  const items: Item[] = [point(ORIGIN, 0, 0, true)];
  items.push(
    ...roundedUnit({
      prefix: 'u0',
      x: 0,
      y: 0,
      width: 40,
      height: 25,
      radius: 6,
      stages,
      perturb,
      tangency,
    }),
  );
  if (stages.includes('anchor')) {
    items.push({ id: 'u0:anchor', type: 'p2p_coincident', p1_id: 'u0:a1', p2_id: ORIGIN });
  }
  return items;
}

export const ENTITIES_PER_UNIT = 5;
export const UNIT = { width: 40, height: 25, radius: 6, gap: 10 };

export interface ChainOptions {
  /** Geometric entities (lines + arcs); must be a multiple of 5. */
  entities: number;
  /**
   * `full`: every unit dimensioned and chained with a gap distance; unit 0's
   * width is the sketch param `w0`. DOF 0.
   * `free`: coincident, H/V and tangency only, units chained by a horizontal
   * alignment; under-constrained, as a sketch is while being drawn.
   */
  mode: 'full' | 'free';
  perturb?: number;
}

/**
 * A row of rounded units, coupled into one connected system: unit k's
 * bottom-left corner is horizontally aligned with unit k-1's bottom-right
 * corner (and, in `full` mode, a gap distance away from it). planegcs splits
 * decoupled parts into separate subsystems, so coupling is what makes this a
 * single N-entity solve rather than N/5 small ones.
 */
export function chain({ entities, mode, perturb = 0 }: ChainOptions): Item[] {
  if (entities % ENTITIES_PER_UNIT !== 0) throw new Error('entities must be a multiple of 5');
  const units = entities / ENTITIES_PER_UNIT;
  const stages: Stage[] =
    mode === 'full'
      ? ['geometry', 'coincident', 'hv', 'tangent', 'dimensions']
      : ['geometry', 'coincident', 'hv', 'tangent'];
  const items: Item[] = [];
  if (mode === 'full') items.push({ type: 'param', name: 'w0', value: UNIT.width });
  items.push(point(ORIGIN, 0, 0, true));
  for (let k = 0; k < units; k++) {
    const prefix = `u${k}`;
    items.push(
      ...roundedUnit({
        prefix,
        x: k * (UNIT.width + UNIT.gap),
        y: 0,
        width: UNIT.width,
        height: UNIT.height,
        radius: UNIT.radius,
        stages,
        perturb,
        seed: k,
        ...(mode === 'full' && k === 0 ? { widthParam: 'w0' } : {}),
      }),
    );
    const ids = unitIds(prefix);
    if (k === 0) {
      items.push({
        id: `${prefix}:anchor`,
        type: 'p2p_coincident',
        p1_id: ids.bottomLeft,
        p2_id: ORIGIN,
      });
    } else {
      const prev = unitIds(`u${k - 1}`);
      items.push({
        id: `${prefix}:align`,
        type: 'horizontal_pp',
        p1_id: prev.bottomRight,
        p2_id: ids.bottomLeft,
      });
      if (mode === 'full') {
        items.push({
          id: `${prefix}:gap`,
          type: 'p2p_distance',
          p1_id: prev.bottomRight,
          p2_id: ids.bottomLeft,
          distance: UNIT.gap,
        });
      }
    }
  }
  return items;
}
