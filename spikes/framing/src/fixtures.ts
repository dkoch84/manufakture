// The two fixtures: the M6 acceptance shed and a 2,000 sq ft single-storey house. Each is a list
// of features (walls, floors, roofs), each feature a group of members, so a warm regen can
// re-frame one wall alone.

import {
  cutBy,
  findTees,
  frameFloor,
  frameWall,
  rafter,
  roofUnderside,
  WALL_HEIGHT,
  wallAxis,
  boxMember,
  type Floor,
  type Wall,
} from './generator.ts';
import { STOCK, toMillimetres, type Member } from './members.ts';
import type { Plane, Vec3 } from './geom.ts';

export type FixtureName = 'shed' | 'house';

export interface Fixture {
  name: FixtureName;
  /** Members per feature, in millimetres. */
  groups: Map<string, Member[]>;
  /** The wall whose opening the warm regen moves, and the opening. */
  dirty: { wall: string; opening: string; by: number };
  /** Re-frame the dirty wall with its opening moved (millimetres). */
  regenDirty(): Member[];
}

const PITCH = 6 / 12;
const SPACING = 16;

/** Rough openings (inches): width, head height, sill height. */
const DOOR = { width: 38, head: 82.5 };
const win = (width: number, height: number) => ({ width, head: 82.5, sill: 82.5 - height });

export function allMembers(f: Fixture): Member[] {
  return [...f.groups.values()].flat();
}

/** Exterior walls of a W x D rectangle (x along W), counter-clockwise from the origin. */
function exteriorWalls(W: number, D: number, stock: (typeof STOCK)['2x4'], base: number): Wall[] {
  const T = stock.depth;
  const common = { stock, base, spacing: SPACING };
  return [
    {
      ...common,
      openings: [],
      id: 'wall-s',
      start: [0, 0],
      dir: [1, 0],
      length: W,
      corners: { start: true, end: true },
    },
    {
      ...common,
      openings: [],
      id: 'wall-e',
      start: [W, T],
      dir: [0, 1],
      length: D - 2 * T,
      corners: { start: false, end: false },
    },
    {
      ...common,
      openings: [],
      id: 'wall-n',
      start: [W, D],
      dir: [-1, 0],
      length: W,
      corners: { start: true, end: true },
    },
    {
      ...common,
      openings: [],
      id: 'wall-w',
      start: [0, D - T],
      dir: [0, -1],
      length: D - 2 * T,
      corners: { start: false, end: false },
    },
  ];
}

function frameWalls(walls: readonly Wall[], groups: Map<string, Member[]>) {
  const tees = findTees(walls);
  for (const w of walls) groups.set(w.id, frameWall(w, tees.get(w.id) ?? []));
  return tees;
}

function moved(walls: readonly Wall[], dirty: Fixture['dirty']): Wall {
  const w = walls.find((x) => x.id === dirty.wall)!;
  return {
    ...w,
    openings: w.openings.map((o) => (o.id === dirty.opening ? { ...o, at: o.at + dirty.by } : o)),
  };
}

// The shed --------------------------------------------------------------------------------------

/**
 * 12' x 16' shed: three 4x6 skids, 2x6 floor joists at 16", 2x4 walls at 16" with a door in the
 * front gable wall and a window in each long wall, a 6/12 gable roof of 2x6 rafters at 16" on a
 * 2x8 ridge, rafter ties every third pair, gable studs cut to the roof.
 */
export function shed(): Fixture {
  const W = 192;
  const D = 144;
  const groups = new Map<string, Member[]>();
  const skid = STOCK['4x6'];
  const floor: Floor = {
    id: 'floor',
    base: skid.width,
    joist: STOCK['2x6'],
    spacing: SPACING,
    spans: [{ x0: 0, x1: W, y0: 0, y1: D }],
    rims: true,
    supports: {
      role: 'skid',
      stock: { ...skid, width: skid.depth, depth: skid.width },
      plies: 1,
      y: [6, D / 2, D - 6],
    },
    sillPlates: false,
  };
  groups.set('floor', frameFloor(floor));
  const base = skid.width + STOCK['2x6'].depth + 0.75;
  const stock = STOCK['2x4'];
  const T = stock.depth;
  const walls = exteriorWalls(W, D, stock, base);
  walls[0]!.openings.push({ id: 'opening#2', kind: 'window', at: 60, ...win(24, 36) });
  walls[2]!.openings.push({ id: 'opening#3', kind: 'window', at: 132, ...win(24, 36) });
  // Front gable wall (east, x = W): the door, centred.
  walls[1]!.openings.push({ id: 'opening#1', kind: 'door', at: (D - 2 * T) / 2, ...DOOR });
  const dirty = { wall: 'wall-s', opening: 'opening#2', by: 12 };
  frameWalls(walls, groups);

  const plate = base + WALL_HEIGHT;
  const roof = gableRoof(W, D, plate, T);
  groups.set('roof', roof.members);
  // Gable studs over the two end walls, cut to the underside of the roof.
  for (const w of [walls[1]!, walls[3]!]) {
    const gs: Member[] = [];
    const sw = stock.width;
    for (let k = 1; k * SPACING < w.length; k++) {
      const s0 = k * SPACING - sw / 2;
      const across = [-w.dir[1], w.dir[0]] as const;
      const p0 = [w.start[0] + s0 * w.dir[0], w.start[1] + s0 * w.dir[1]] as const;
      const p1 = [
        p0[0] + sw * w.dir[0] + T * across[0],
        p0[1] + sw * w.dir[1] + T * across[1],
      ] as const;
      const min: Vec3 = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), plate];
      const max: Vec3 = [Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]), plate + D * PITCH];
      const m = boxMember(`gable-${w.id}`, `g${k}`, 'gable-stud', stock, min, max, 2, wallAxis(w));
      if (roof.undersides.every((p) => cutBy(m, p)) && m.cuts.length > 0) gs.push(m);
    }
    groups.set(`gable-${w.id}`, gs);
  }
  return finish('shed', groups, walls, dirty);
}

function gableRoof(W: number, D: number, plate: number, seat: number) {
  const members: Member[] = [];
  const rafterStock = STOCK['2x6'];
  const ridge = STOCK['2x8'];
  const half = ridge.width / 2;
  const sides = [
    { start: 0, dir: [0, 1] as [number, number], top: { n: [0, 1, 0] as Vec3, k: D / 2 - half } },
    {
      start: D,
      dir: [0, -1] as [number, number],
      top: { n: [0, -1, 0] as Vec3, k: -(D / 2 + half) },
    },
  ];
  const xs: number[] = [rafterStock.width / 2];
  for (let k = 1; k * SPACING < W - rafterStock.width; k++) xs.push(k * SPACING);
  xs.push(W - rafterStock.width / 2);
  const undersides: Plane[] = [];
  sides.forEach((side, i) => {
    undersides.push(roofUnderside([0, side.start], side.dir, PITCH, plate, seat));
    xs.forEach((x, k) => {
      const m = rafter({
        group: 'roof',
        id: `r${i === 0 ? 's' : 'n'}${k}`,
        role: 'common-rafter',
        stock: rafterStock,
        start: [x, side.start],
        dir: side.dir,
        slope: PITCH,
        plate,
        seat,
        overhang: 12,
        reach: D / 2,
        top: [side.top],
      });
      if (m) members.push(m);
    });
  });
  // Ridge board: top flush with the rafters' top edge at the ridge face.
  const run = D / 2 - half;
  const rafterTop = plate + (run - seat) * PITCH + rafterStock.depth * Math.hypot(1, PITCH);
  members.push(
    boxMember(
      'roof',
      'ridge:1',
      'ridge',
      ridge,
      [0, D / 2 - half, rafterTop - ridge.depth],
      [W, D / 2 + half, rafterTop],
      0,
      1,
    ),
  );
  // Rafter ties every third pair, beside the rafter, ends cut to the roof.
  xs.forEach((x, k) => {
    if (k % 3 !== 0 || k === xs.length - 1) return;
    const tie = STOCK['2x4'];
    const m = boxMember(
      'roof',
      `tie${k}`,
      'rafter-tie',
      tie,
      [x + 0.75, 0, plate],
      [x + 0.75 + tie.width, D, plate + tie.depth],
      1,
      0,
    );
    if (undersides.every((p) => cutBy(m, p))) members.push(m);
  });
  return { members, undersides };
}

// The house -------------------------------------------------------------------------------------

/**
 * 40' x 50' single-storey house (2,000 sq ft) over a crawl space: 2x6 sill plates, a 3-ply 2x10
 * girder, 2x10 joists at 16" in two spans with blocking over the girder; 2x6 exterior walls,
 * 2x4 interior walls (a bearing wall down the middle and six partitions), two doors and eight
 * windows; 2x6 ceiling joists in two spans; a 6/12 hip roof of 2x8 commons and jacks, 2x10 hips
 * and ridge.
 */
export function house(): Fixture {
  const W = 600;
  const D = 480;
  const groups = new Map<string, Member[]>();
  const joist = STOCK['2x10'];
  const floor: Floor = {
    id: 'floor',
    base: 1.5,
    joist,
    spacing: SPACING,
    spans: [
      { x0: 0, x1: W, y0: 0, y1: D / 2 },
      { x0: 0, x1: W, y0: D / 2, y1: D },
    ],
    rims: true,
    supports: { role: 'beam', stock: joist, plies: 3, y: [D / 2] },
    sillPlates: true,
    blockingAt: D / 2,
  };
  groups.set('floor', frameFloor(floor));
  const base = 1.5 + joist.depth + 0.75;
  const ext = STOCK['2x6'];
  const T = ext.depth;
  const walls = exteriorWalls(W, D, ext, base);
  const [s, e, n, w] = walls as [Wall, Wall, Wall, Wall];
  s.openings.push(
    { id: 'opening#1', kind: 'door', at: 300, ...DOOR },
    { id: 'opening#2', kind: 'window', at: 120, ...win(48, 48) },
    { id: 'opening#3', kind: 'window', at: 480, ...win(48, 48) },
  );
  // The north wall runs from x = W to 0, so `at` is measured from the east end.
  n.openings.push(
    { id: 'opening#4', kind: 'door', at: W - 150, ...DOOR },
    { id: 'opening#5', kind: 'window', at: W - 300, ...win(36, 36) },
    { id: 'opening#6', kind: 'window', at: W - 420, ...win(36, 36) },
    { id: 'opening#7', kind: 'window', at: W - 540, ...win(36, 36) },
  );
  w.openings.push(
    { id: 'opening#8', kind: 'window', at: 120, ...win(60, 48) },
    { id: 'opening#9', kind: 'window', at: 340, ...win(60, 48) },
  );
  e.openings.push({ id: 'opening#10', kind: 'window', at: 230, ...win(72, 48) });
  const int = STOCK['2x4'];
  const ti = int.depth;
  const partition = (
    id: string,
    start: [number, number],
    dir: [number, number],
    length: number,
  ): Wall => ({
    id,
    start,
    dir,
    length,
    stock: int,
    base,
    openings: [],
    corners: { start: false, end: false },
    spacing: SPACING,
  });
  const mid = D / 2 - ti / 2;
  walls.push(
    partition('wall-i1', [T, mid], [1, 0], W - 2 * T),
    partition('wall-i2', [150 + ti, T], [0, 1], mid - T),
    partition('wall-i3', [420 + ti, T], [0, 1], mid - T),
    partition('wall-i4', [200, D - T], [0, -1], D - T - (mid + ti)),
    partition('wall-i5', [360, D - T], [0, -1], D - T - (mid + ti)),
    partition('wall-i6', [480, D - T], [0, -1], D - T - (mid + ti)),
    partition('wall-i7', [480 + ti, 360], [1, 0], W - T - 480 - ti),
  );
  const dirty = { wall: 'wall-s', opening: 'opening#2', by: 12 };
  frameWalls(walls, groups);

  const plate = base + WALL_HEIGHT;
  const roof = hipRoof(W, D, plate, T);
  groups.set('roof', roof.members);
  // Ceiling joists in two spans, bearing on the outside walls and the middle wall, cut to the roof.
  const cj: Member[] = [];
  const cs = STOCK['2x6'];
  const xs: number[] = [T];
  for (let k = 1; k * SPACING < W - T - cs.width; k++) xs.push(k * SPACING - cs.width / 2);
  xs.push(W - T - cs.width);
  for (const [i, [y0, y1]] of [
    [0, D / 2 + 1.75],
    [D / 2 - 1.75, D],
  ].entries())
    xs.forEach((x, k) => {
      const m = boxMember(
        'ceiling',
        `c${i + 1}:${k}`,
        'ceiling-joist',
        cs,
        // Beside the rafter on the same layout line; the second span laps the first.
        [x + (i + 1) * cs.width, y0!, plate],
        [x + (i + 2) * cs.width, y1!, plate + cs.depth],
        1,
        0,
      );
      if (roof.undersides.every((p) => cutBy(m, p))) cj.push(m);
    });
  groups.set('ceiling', cj);
  return finish('house', groups, walls, dirty);
}

function hipRoof(W: number, D: number, plate: number, seat: number) {
  const members: Member[] = [];
  const rs = STOCK['2x8'];
  const hs = STOCK['2x10'];
  const r2 = Math.SQRT2;
  const hh = hs.width / 2;
  const half = D / 2;
  const x0 = half;
  const x1 = W - half;
  const P = (n: Vec3, k: number): Plane => ({ n, k });
  const d = (a: number, b: number): Vec3 => [a / r2, b / r2, 0];
  // Planes of the hips' side faces and the ridge (removed side), per side and region.
  const sides = [
    {
      name: 's',
      start: (t: number): [number, number] => [t, 0],
      dir: [0, 1] as [number, number],
      len: W,
      top: (t: number) =>
        t < x0 ? P(d(-1, 1), -hh) : t > x1 ? P(d(1, 1), W / r2 - hh) : P([0, 1, 0], half - hh),
      reach: (t: number) => (t < x0 ? t : t > x1 ? W - t : half),
      commons: [x0, x1],
    },
    {
      name: 'n',
      start: (t: number): [number, number] => [t, D],
      dir: [0, -1] as [number, number],
      len: W,
      top: (t: number) =>
        t < x0
          ? P(d(-1, -1), -D / r2 - hh)
          : t > x1
            ? P(d(1, -1), (W - D) / r2 - hh)
            : P([0, -1, 0], -half - hh),
      reach: (t: number) => (t < x0 ? t : t > x1 ? W - t : half),
      commons: [x0, x1],
    },
    {
      name: 'w',
      start: (t: number): [number, number] => [0, t],
      dir: [1, 0] as [number, number],
      len: D,
      top: (t: number) =>
        t < half ? P(d(1, -1), -hh) : t > half ? P(d(1, 1), D / r2 - hh) : P([1, 0, 0], x0 - hh),
      reach: (t: number) => (t < half ? t : t > half ? D - t : x0),
      commons: [half],
    },
    {
      name: 'e',
      start: (t: number): [number, number] => [W, t],
      dir: [-1, 0] as [number, number],
      len: D,
      top: (t: number) =>
        t < half
          ? P(d(-1, -1), -W / r2 - hh)
          : t > half
            ? P(d(-1, 1), -(W - D) / r2 - hh)
            : P([-1, 0, 0], -x1 - hh),
      reach: (t: number) => (t < half ? t : t > half ? D - t : W - x1),
      commons: [half],
    },
  ];
  const undersides: Plane[] = [];
  for (const side of sides) {
    const at0 = side.start(0);
    undersides.push(roofUnderside(at0, side.dir, PITCH, plate, seat));
    const ts = new Set<number>(side.commons);
    for (let k = 1; k * SPACING < side.len; k++) ts.add(k * SPACING);
    for (const t of [...ts].sort((a, b) => a - b)) {
      const reach = side.reach(t);
      if (reach < 6) continue;
      const common = side.commons.length === 2 ? t >= x0 && t <= x1 : t === half;
      const m = rafter({
        group: 'roof',
        id: `${side.name}${t}`,
        role: common ? 'common-rafter' : 'jack-rafter',
        stock: rs,
        start: side.start(t),
        dir: side.dir,
        slope: PITCH,
        plate,
        seat,
        overhang: 12,
        reach: reach + 3,
        top: [side.top(t)],
      });
      if (m) members.push(m);
    }
  }
  // Hips from the corners to the ridge ends, a plumb cut at the top.
  const hips: Array<[string, [number, number], [number, number]]> = [
    ['hip-sw', [0, 0], [x0, half]],
    ['hip-se', [W, 0], [x1, half]],
    ['hip-ne', [W, D], [x1, half]],
    ['hip-nw', [0, D], [x0, half]],
  ];
  for (const [id, a, b] of hips) {
    const dir: [number, number] = [(b[0] - a[0]) / (half * r2), (b[1] - a[1]) / (half * r2)];
    const run = half * r2;
    const m = rafter({
      group: 'roof',
      id,
      role: 'hip-rafter',
      stock: hs,
      start: a,
      dir,
      slope: PITCH / r2,
      plate,
      seat: seat * r2,
      overhang: 12 * r2,
      reach: run + 2,
      top: [{ n: [dir[0], dir[1], 0], k: dir[0] * a[0] + dir[1] * a[1] + run - 1 }],
    });
    if (m) members.push(m);
  }
  const run = half - rs.width / 2;
  const top = plate + (run - seat) * PITCH + rs.depth * Math.hypot(1, PITCH);
  members.push(
    boxMember(
      'roof',
      'ridge:1',
      'ridge',
      hs,
      [x0 - hh, half - hh, top - hs.depth],
      [x1 + hh, half + hh, top],
      0,
      1,
    ),
  );
  return { members, undersides };
}

function finish(
  name: FixtureName,
  inches: Map<string, Member[]>,
  walls: readonly Wall[],
  dirty: Fixture['dirty'],
): Fixture {
  const groups = new Map<string, Member[]>();
  for (const [k, v] of inches) groups.set(k, toMillimetres(v));
  const tees = findTees(walls);
  return {
    name,
    groups,
    dirty,
    regenDirty: () => toMillimetres(frameWall(moved(walls, dirty), tees.get(dirty.wall) ?? [])),
  };
}

export function fixture(name: FixtureName): Fixture {
  return name === 'shed' ? shed() : house();
}
