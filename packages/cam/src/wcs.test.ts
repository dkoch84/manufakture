import { describe, expect, it } from 'vitest';
import { angleAbout, arcSweep } from './arc';
import { stockFromBounds } from './stock';
import type { ArcSegment2, Box3, Loop2, Stock, UpAxis, Vec2, Vec3, Wcs, WcsFrame } from './types';
import { cross } from './vec';
import {
  boundsInSetup,
  drillPointToMachine,
  planarLoopsToMachine,
  pointsBoundsInSetup,
  setupRotation,
  toMachine,
  toModel,
  toSetup,
  wcsFrame,
} from './wcs';

const BODY: Box3 = { min: [0, 0, 0], max: [100, 50, 20] };
const P: Vec3 = [10, 20, 5];

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
}

function rotationOf(up: UpAxis) {
  const r = setupRotation({ kind: 'axis', axis: up });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function stockFor(up: UpAxis, margins = 0): Stock {
  const bounds = boundsInSetup(rotationOf(up), BODY);
  const s = stockFromBounds(bounds, {
    xMin: margins,
    xMax: margins,
    yMin: margins,
    yMax: margins,
    top: margins,
    bottom: margins,
  });
  if (!s.ok) throw new Error(s.error.message);
  return s.value;
}

function frameFor(up: UpAxis, origin: Wcs['origin'], stock = stockFor(up)): WcsFrame {
  const f = wcsFrame({ up: { kind: 'axis', axis: up }, origin }, stock);
  if (!f.ok) throw new Error(f.error.message);
  return f.value;
}

describe('setupRotation', () => {
  // Machine X, Y, Z in model coordinates, as the table in wcs.ts states.
  const table: Record<UpAxis, [Vec3, Vec3, Vec3]> = {
    '+z': [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    '-z': [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    '+y': [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    '-y': [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    '+x': [
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    '-x': [
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ],
  };

  for (const [up, [x, y, z]] of Object.entries(table) as [UpAxis, [Vec3, Vec3, Vec3]][]) {
    it(`up ${up} gives the tabled axes, right-handed`, () => {
      const r = rotationOf(up);
      expectVec(r.xAxis, x);
      expectVec(r.yAxis, y);
      expectVec(r.zAxis, z);
      expectVec(cross(r.xAxis, r.yAxis), r.zAxis);
    });
  }

  it('a face up uses its normal and an explicit X direction', () => {
    const r = setupRotation({ kind: 'face', normal: [0, 0, 2], xDir: [0, 1, 0.5] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectVec(r.value.xAxis, [0, 1, 0]); // projected onto the plane and normalised
    expectVec(r.value.yAxis, [-1, 0, 0]);
    expectVec(r.value.zAxis, [0, 0, 1]);
  });

  it('a tilted face up without X takes the smallest rotation', () => {
    const s = Math.SQRT1_2;
    const r = setupRotation({ kind: 'face', normal: [0, -1, 1] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectVec(r.value.xAxis, [1, 0, 0]); // rotation about X keeps X
    expectVec(r.value.yAxis, [0, s, s]);
    expectVec(r.value.zAxis, [0, -s, s]);
  });

  it('rejects a zero normal and an X direction along the normal', () => {
    const zero = setupRotation({ kind: 'face', normal: [0, 0, 0] });
    expect(zero.ok ? undefined : zero.error.code).toBe('invalid-input');
    const along = setupRotation({ kind: 'face', normal: [0, 0, 1], xDir: [0, 0, 3] });
    expect(along.ok ? undefined : along.error.code).toBe('invalid-input');
    const nan = setupRotation({ kind: 'face', normal: [0, Number.NaN, 1] });
    expect(nan.ok).toBe(false);
  });
});

describe('boundsInSetup', () => {
  // The model box 100 x 50 x 20 from the origin, turned per up axis (hand-computed).
  const expected: Record<UpAxis, Box3> = {
    '+z': { min: [0, 0, 0], max: [100, 50, 20] },
    '-z': { min: [0, -50, -20], max: [100, 0, 0] },
    '+y': { min: [0, -20, 0], max: [100, 0, 50] },
    '-y': { min: [0, 0, -50], max: [100, 20, 0] },
    '+x': { min: [-20, 0, 0], max: [0, 50, 100] },
    '-x': { min: [0, 0, -100], max: [20, 50, 0] },
  };
  for (const [up, box] of Object.entries(expected) as [UpAxis, Box3][]) {
    it(`up ${up}`, () => {
      const b = boundsInSetup(rotationOf(up), BODY);
      expectVec(b.min, box.min);
      expectVec(b.max, box.max);
    });
  }

  it('points give tight bounds where the box corners would be loose', () => {
    const r = setupRotation({ kind: 'face', normal: [0, -1, 1] });
    if (!r.ok) throw new Error();
    // Two points on the model Y axis: the tilted box of their bounds is no bigger than they are.
    const tight = pointsBoundsInSetup(r.value, new Float32Array([0, 0, 0, 0, 10, 0]));
    const s = Math.SQRT1_2;
    expectVec(tight.min, [0, 0, -10 * s]);
    expectVec(tight.max, [0, 10 * s, 0]);
  });
});

describe('wcsFrame and toMachine: each up axis and origin, against hand-computed points', () => {
  // Model point (10, 20, 5) on the 100 x 50 x 20 body, stock with no margins.
  const cases: [UpAxis, Wcs['origin'], Vec3][] = [
    ['+z', { xy: 'front-left', z: 'top' }, [10, 20, -15]],
    ['+z', { xy: 'back-right', z: 'bottom' }, [-90, -30, 5]],
    ['+z', { xy: 'centre', z: 'top' }, [-40, -5, -15]],
    ['-z', { xy: 'front-left', z: 'top' }, [10, 30, -5]],
    ['-z', { xy: 'back-right', z: 'bottom' }, [-90, -20, 15]],
    ['-z', { xy: 'centre', z: 'top' }, [-40, 5, -5]],
    ['+y', { xy: 'front-left', z: 'top' }, [10, 15, -30]],
    ['+y', { xy: 'back-right', z: 'bottom' }, [-90, -5, 20]],
    ['+y', { xy: 'centre', z: 'top' }, [-40, 5, -30]],
    ['-y', { xy: 'front-left', z: 'top' }, [10, 5, -20]],
    ['-y', { xy: 'back-right', z: 'bottom' }, [-90, -15, 30]],
    ['-y', { xy: 'centre', z: 'top' }, [-40, -5, -20]],
    ['+x', { xy: 'front-left', z: 'top' }, [15, 20, -90]],
    ['+x', { xy: 'back-right', z: 'bottom' }, [-5, -30, 10]],
    ['+x', { xy: 'centre', z: 'top' }, [5, -5, -90]],
    ['-x', { xy: 'front-left', z: 'top' }, [5, 20, -10]],
    ['-x', { xy: 'back-right', z: 'bottom' }, [-15, -30, 90]],
    ['-x', { xy: 'centre', z: 'top' }, [-5, -5, -10]],
  ];
  for (const [up, origin, machine] of cases) {
    it(`up ${up}, origin ${origin.xy} ${origin.z}`, () => {
      const frame = frameFor(up, origin);
      expectVec(toMachine(frame, P), machine);
      expectVec(toModel(frame, machine), P);
    });
  }

  it('every corner with margins (up +z)', () => {
    // Margins of 5 on every side: stock -5..105, -5..55, -5..25.
    const stock = stockFor('+z', 5);
    const at = (xy: Wcs['origin']['xy'], z: 'top' | 'bottom') =>
      toMachine(frameFor('+z', { xy, z }, stock), P);
    expectVec(at('front-left', 'top'), [15, 25, -20]);
    expectVec(at('front-right', 'top'), [-95, 25, -20]);
    expectVec(at('back-left', 'bottom'), [15, -35, 10]);
    expectVec(at('back-right', 'top'), [-95, -35, -20]);
    expectVec(at('centre', 'bottom'), [-40, -5, 10]);
  });

  it('the stock corner at the origin is machine zero', () => {
    const stock = stockFor('+y', 2);
    const frame = frameFor('+y', { xy: 'front-left', z: 'bottom' }, stock);
    const r = rotationOf('+y');
    // Setup-frame corner (min x, min y, min z) back in model coordinates.
    const corner = toModel(frame, [0, 0, 0]);
    expectVec(toSetup(r, corner), stock.min);
  });
});

describe('planarLoopsToMachine', () => {
  const frame = frameFor('+z', { xy: 'front-left', z: 'top' }); // origin at model (0, 0, 20)
  const semicircle: Loop2 = {
    segments: [
      { kind: 'line', start: [0, 0], end: [10, 0], source: { kind: 'edge', edge: 'e1' } },
      { kind: 'arc', start: [10, 0], end: [0, 0], center: [5, 0], ccw: true },
    ],
  };

  it('maps a face on top to machine Z 0, keeping segments and tags', () => {
    const r = planarLoopsToMachine(frame, {
      origin: [20, 10, 20],
      xDir: [1, 0, 0],
      normal: [0, 0, 1],
      loops: [semicircle],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.z).toBeCloseTo(0, 12);
    const [line, arc] = r.value.loops[0]!.segments;
    expect(line).toMatchObject({ kind: 'line', source: { kind: 'edge', edge: 'e1' } });
    expectVec(line!.start, [20, 10]);
    expectVec(line!.end, [30, 10]);
    expect(arc).toMatchObject({ kind: 'arc', ccw: true });
    expectVec((arc as ArcSegment2).center, [25, 10]);
    expect(signedArea(r.value.loops[0]!)).toBeGreaterThan(0);
  });

  it('reverses loops on a face pointing down, so outer loops stay counter-clockwise', () => {
    // The bottom face of the body, seen from its outside (-Z): v runs along model -Y.
    const r = planarLoopsToMachine(frame, {
      origin: [0, 0, 0],
      xDir: [1, 0, 0],
      normal: [0, 0, -1],
      loops: [semicircle],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.z).toBeCloseTo(-20, 12);
    const loop = r.value.loops[0]!;
    expect(signedArea(loop)).toBeGreaterThan(0);
    // The arc bulged to +v, which is model -Y: its midpoint is (5, -5) after reversal too.
    const arc = loop.segments.find((s) => s.kind === 'arc') as ArcSegment2;
    expectVec(arcMid(arc), [5, -5]);
    expectVec(arc.start, [0, 0]);
    expectVec(arc.end, [10, 0]);
  });

  it('refuses a plane that is not parallel to the setup XY plane', () => {
    const r = planarLoopsToMachine(frame, {
      origin: [0, 0, 0],
      xDir: [1, 0, 0],
      normal: [0, Math.sin(0.001), Math.cos(0.001)],
      loops: [semicircle],
    });
    expect(r.ok ? undefined : r.error.code).toBe('not-parallel');
    const side = planarLoopsToMachine(frame, {
      origin: [0, 0, 0],
      xDir: [1, 0, 0],
      normal: [0, 1, 0],
      loops: [semicircle],
    });
    expect(side.ok ? undefined : side.error.code).toBe('not-parallel');
  });

  it('works through a turned setup (up +y)', () => {
    const f = frameFor('+y', { xy: 'front-left', z: 'top' }); // top is model y = 50
    const r = planarLoopsToMachine(f, {
      origin: [0, 50, 0],
      xDir: [1, 0, 0],
      normal: [0, 1, 0],
      loops: [semicircle],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.z).toBeCloseTo(0, 12);
    expect(signedArea(r.value.loops[0]!)).toBeGreaterThan(0);
  });
});

describe('drillPointToMachine', () => {
  const frame = frameFor('+z', { xy: 'front-left', z: 'top' });

  it('gives XY, top and bottom in machine coordinates', () => {
    const r = drillPointToMachine(frame, {
      position: [10, 20, 20],
      axis: [0, 0, -1],
      diameter: 5,
      depth: 8,
      through: false,
      source: { kind: 'hole', feature: 'hole#1' },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        at: [10, 20],
        depth: { top: 0, bottom: -8 },
        diameter: 5,
        through: false,
        source: { kind: 'hole', feature: 'hole#1' },
      },
    });
  });

  it('refuses an axis that does not point down the setup Z', () => {
    const base = { position: [10, 20, 20] as Vec3, diameter: 5, depth: 8 };
    const up = drillPointToMachine(frame, { ...base, axis: [0, 0, 1] });
    expect(up.ok ? undefined : up.error.code).toBe('not-parallel');
    const tilted = drillPointToMachine(frame, {
      ...base,
      axis: [Math.sin(0.01), 0, -Math.cos(0.01)],
    });
    expect(tilted.ok ? undefined : tilted.error.code).toBe('not-parallel');
  });

  it('refuses a zero diameter or depth', () => {
    const base = { position: [10, 20, 20] as Vec3, axis: [0, 0, -1] as Vec3 };
    expect(drillPointToMachine(frame, { ...base, diameter: 0, depth: 8 }).ok).toBe(false);
    expect(drillPointToMachine(frame, { ...base, diameter: 5, depth: -1 }).ok).toBe(false);
  });
});

/** Signed area of a loop, arcs included exactly (positive: counter-clockwise). */
function signedArea(loop: Loop2): number {
  let area = 0;
  for (const s of loop.segments) {
    area += (s.start[0] * s.end[1] - s.end[0] * s.start[1]) / 2;
    if (s.kind === 'arc') {
      // Add the circular segment between the chord and the arc.
      const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
      const sweep = arcSweep({
        start: [...s.start, 0],
        end: [...s.end, 0],
        center: s.center,
        direction: s.ccw ? 'ccw' : 'cw',
        fullCircle: s.fullCircle ?? false,
      });
      const seg = (r * r * (sweep - Math.sin(sweep))) / 2;
      area += s.ccw ? seg : -seg;
    }
  }
  return area;
}

function arcMid(s: ArcSegment2): Vec2 {
  const sweep = arcSweep({
    start: [...s.start, 0],
    end: [...s.end, 0],
    center: s.center,
    direction: s.ccw ? 'ccw' : 'cw',
    fullCircle: false,
  });
  const a = angleAbout(s.center, s.start) + ((s.ccw ? 1 : -1) * sweep) / 2;
  const r = Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
  return [s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)];
}
