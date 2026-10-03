// Framing fixtures for the kernel-free `?scene=framing` scene, unit tests and the e2e checks of
// member drawing, picking and export, until the construction workspace (T6.1d) feeds real member
// sets from regen. A 12' x 16' shed (four 2x4 walls on 16" centres, a door and a window, OSB
// sheathing as layer bodies) and a two-storey 40' x 30' house (walls, floor joists, rafters),
// laid out roughly as a framer would; not the construction domain's generator, which the app
// does not ship yet. Members are uncut boxes, meshed and listed with regen's own helpers
// (`boxMesh`, `memberInstances`), so the data is shaped exactly as a regen sends it.

import type { Vec3 } from '@manufakture/kernel';
import {
  boxMesh,
  memberInstances,
  memberShapeKey,
  type MemberData,
  type MemberMeshData,
  type MemberStock,
  type MemberVec3,
} from '@manufakture/regen';
import type { BodyInput } from './bodies';
import type { MemberSetView, MemberView } from './members';
import { boxBody } from './testMeshes';

const IN = 25.4;
const FT = 12 * IN;

export const STOCK_2X4: MemberStock = { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 };
export const STOCK_2X6: MemberStock = { id: 'us-2x6', name: '2x6', width: 38.1, depth: 139.7 };
export const STOCK_2X8: MemberStock = { id: 'us-2x8', name: '2x8', width: 38.1, depth: 184.15 };
export const STOCK_2X10: MemberStock = { id: 'us-2x10', name: '2x10', width: 38.1, depth: 234.95 };

/** Precut stud for an 8' wall (ADR 0015 decision 9 matches studs to it by length). */
export const PRECUT_STUD = 92.625 * IN;
const PLATE = STOCK_2X4.width;
/** Bottom plate, stud and two top plates. */
export const WALL_HEIGHT = PLATE + PRECUT_STUD + 2 * PLATE;
const SHEATHING = (7 / 16) * IN;

const UP: MemberVec3 = [0, 0, 1];
const add = (a: MemberVec3, ...rest: MemberVec3[]): MemberVec3 =>
  rest.reduce<MemberVec3>((s, b) => [s[0] + b[0], s[1] + b[1], s[2] + b[2]], a);
const mul = (a: MemberVec3, k: number): MemberVec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: MemberVec3, b: MemberVec3): MemberVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

interface Opening {
  id: string;
  /** From the wall's start to the rough opening's near side, and its width. */
  at: number;
  width: number;
  /** Rough opening height above the bottom of the wall, and sill height (0 for a door). */
  top: number;
  sill: number;
  header: MemberStock;
}

interface WallSpec {
  id: string;
  /** Outside corner where the wall starts, its direction (unit, horizontal) and length. */
  start: MemberVec3;
  dir: MemberVec3;
  length: number;
  openings?: Opening[];
}

/**
 * Positions of members `thick` wide on 16" centres along `length`, the first flush with the
 * start and one flush with the end; a layout one that would overlap the end one is left out.
 */
export function onCentres(length: number, thick: number): number[] {
  const end = length - thick;
  const out: number[] = [];
  for (let a = 0; a + thick <= end; a += 16 * IN) out.push(a);
  if (end >= 0) out.push(end);
  return out;
}

/** Members of one wall (owner: the wall) and its openings (owner: each opening). */
export function frameWall(w: WallSpec): MemberData[] {
  const u = w.dir;
  // Inside is to the left of the direction, the loops running counter-clockwise.
  const n = cross(UP, u);
  const out: MemberData[] = [];
  const base = w.start;
  const flat = (owner: string, id: string, role: string, a: number, len: number, z: number) =>
    out.push({
      id,
      owner,
      role,
      stock: STOCK_2X4,
      length: len,
      // x along the wall, the thin face up, the wide face across the wall.
      placement: { origin: add(base, mul(u, a), mul(n, STOCK_2X4.depth), mul(UP, z)), x: u, y: UP },
      cuts: [],
    });
  const upright = (owner: string, id: string, role: string, a: number, z: number, len: number) =>
    out.push({
      id,
      owner,
      role,
      stock: STOCK_2X4,
      length: len,
      placement: { origin: add(base, mul(u, a), mul(UP, z)), x: UP, y: u },
      cuts: [],
    });
  const openings = w.openings ?? [];
  // Bottom plates stop at doors.
  let from = 0;
  let piece = 1;
  for (const o of [...openings].sort((a, b) => a.at - b.at)) {
    if (o.sill > 0) continue;
    flat(w.id, `bottom${piece++}`, 'bottom-plate', from, o.at - from, 0);
    from = o.at + o.width;
  }
  flat(w.id, `bottom${piece}`, 'bottom-plate', from, w.length - from, 0);
  flat(w.id, 'top1', 'top-plate', 0, w.length, PLATE + PRECUT_STUD);
  flat(w.id, 'top2', 'top-plate', 0, w.length, PLATE + PRECUT_STUD + PLATE);

  // Openings: kings and jacks each side, a header of two plies, a sill under a window, cripples
  // on the layout above the header and under the sill.
  const busy: [number, number][] = [];
  for (const o of openings) {
    const left = o.at - 2 * PLATE;
    const right = o.at + o.width + PLATE;
    busy.push([left, right + PLATE]);
    upright(o.id, 'king-l', 'king', left, PLATE, PRECUT_STUD);
    upright(o.id, 'king-r', 'king', right, PLATE, PRECUT_STUD);
    upright(o.id, 'jack-l', 'jack', left + PLATE, PLATE, o.top - PLATE);
    upright(o.id, 'jack-r', 'jack', right - PLATE, PLATE, o.top - PLATE);
    const span = o.width + 2 * PLATE;
    for (let ply = 0; ply < 2; ply++) {
      out.push({
        id: `header:${ply + 1}`,
        owner: o.id,
        role: 'header',
        stock: o.header,
        length: span,
        // On edge: the thin face across the wall, the wide face up.
        placement: {
          origin: add(base, mul(u, o.at - PLATE), mul(n, ply * PLATE), mul(UP, o.top)),
          x: u,
          y: n,
        },
        cuts: [],
      });
    }
    const headerTop = o.top + o.header.depth;
    if (o.sill > 0) {
      out.push({
        id: 'sill',
        owner: o.id,
        role: 'rough-sill',
        stock: STOCK_2X4,
        length: o.width,
        placement: {
          origin: add(base, mul(u, o.at), mul(n, STOCK_2X4.depth), mul(UP, o.sill - PLATE)),
          x: u,
          y: UP,
        },
        cuts: [],
      });
    }
    let c = 1;
    for (let a = 0; a < w.length; a += 16 * IN) {
      if (a < o.at || a + PLATE > o.at + o.width) continue;
      const topLen = PLATE + PRECUT_STUD - headerTop;
      if (topLen > 1) upright(o.id, `cripple${c++}`, 'cripple', a, headerTop, topLen);
      if (o.sill > 0) upright(o.id, `cripple${c++}`, 'cripple', a, PLATE, o.sill - 2 * PLATE);
    }
  }
  // Layout studs on 16" centres from the start, one at the end, none where an opening frames.
  let s = 1;
  for (const a of onCentres(w.length, PLATE)) {
    if (busy.some(([lo, hi]) => a + PLATE > lo && a < hi)) continue;
    upright(w.id, `s${s++}`, 'stud', a, PLATE, PRECUT_STUD);
  }
  return out;
}

/** A layer body along a wall's outside face: sheathing, `<part>/<wall>:layer/sheathing`. */
function sheathingBody(partId: string, w: WallSpec, z: number): BodyInput {
  const u = w.dir;
  const n = cross(UP, u);
  const a = add(w.start, mul(n, -SHEATHING), mul(UP, z));
  const b = add(w.start, mul(u, w.length), mul(UP, z + WALL_HEIGHT));
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  return boxBody({
    id: `${partId}/${w.id}:layer/sheathing`,
    min,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    named: false,
  });
}

/** Four walls around a rectangle, south and north running full length (they hold the corners). */
function rectangleWalls(
  prefix: string,
  width: number,
  depth: number,
  z: number,
  openings: Record<'s' | 'e' | 'n' | 'w', Opening[]>,
): WallSpec[] {
  const t = STOCK_2X4.depth;
  return [
    { id: `${prefix}s`, start: [0, 0, z], dir: [1, 0, 0], length: width, openings: openings.s },
    {
      id: `${prefix}e`,
      start: [width, t, z],
      dir: [0, 1, 0],
      length: depth - 2 * t,
      openings: openings.e,
    },
    {
      id: `${prefix}n`,
      start: [width, depth, z],
      dir: [-1, 0, 0],
      length: width,
      openings: openings.n,
    },
    {
      id: `${prefix}w`,
      start: [0, depth - t, z],
      dir: [0, -1, 0],
      length: depth - 2 * t,
      openings: openings.w,
    },
  ];
}

/** Members grouped as regen groups them: a set per framing group, with its instance lists. */
export function memberView(groups: { group: string; members: MemberData[] }[]): MemberView {
  const meshes = new Map<string, MemberMeshData>();
  const sets: MemberSetView[] = groups.map(({ group, members }) => {
    for (const m of members) {
      const key = memberShapeKey(m);
      if (!meshes.has(key)) meshes.set(key, boxMesh(m.length, m.stock.width, m.stock.depth));
    }
    return {
      group,
      namespace: 'construction',
      features: [...new Set(members.map((m) => m.owner))],
      members,
      instances: memberInstances(members),
    };
  });
  return { meshes, sets };
}

export interface MemberFixture {
  /** The part id the layer bodies and members belong to. */
  partId: string;
  view: MemberView;
  bodies: BodyInput[];
  /** Level elevations, mm. */
  levels: number[];
}

export type MemberFixtureName = 'shed' | 'house';

/** A 12' x 16' shed: four 2x4 walls, a 36" door in the south wall, a 24" window in the east. */
export function shedFixture(partId = 'shed'): MemberFixture {
  const walls = rectangleWalls('wall-', 16 * FT, 12 * FT, 0, {
    s: [{ id: 'door-1', at: 6 * FT, width: 38 * IN, top: 82.5 * IN, sill: 0, header: STOCK_2X8 }],
    e: [
      {
        id: 'window-1',
        at: 4 * FT,
        width: 26 * IN,
        top: 82.5 * IN,
        sill: 46.5 * IN,
        header: STOCK_2X6,
      },
    ],
    n: [],
    w: [],
  });
  return {
    partId,
    view: memberView(walls.map((w) => ({ group: w.id, members: frameWall(w) }))),
    bodies: walls.map((w) => sheathingBody(partId, w, 0)),
    levels: [0],
  };
}

/** Floor joists of an upper level: 2x10 on 16" centres across the depth, with rims. */
function floorFraming(id: string, width: number, depth: number, z: number): MemberData[] {
  const out: MemberData[] = [];
  const j = STOCK_2X10;
  // On edge, running in y: x = +y, y (thin) = +x, z = up.
  const joist = (mid: string, role: string, x: number, len: number) =>
    out.push({
      id: mid,
      owner: id,
      role,
      stock: j,
      length: len,
      placement: { origin: [x + j.width, j.width, z], x: [0, 1, 0], y: [-1, 0, 0] },
      cuts: [],
    });
  onCentres(width, j.width).forEach((x, k) => joist(`j${k + 1}`, 'joist', x, depth - 2 * j.width));
  for (const [rid, y] of [
    ['rim-s', 0],
    ['rim-n', depth - j.width],
  ] as const) {
    out.push({
      id: rid,
      owner: id,
      role: 'rim',
      stock: j,
      length: width,
      placement: { origin: [0, y, z], x: [1, 0, 0], y: [0, 1, 0] },
      cuts: [],
    });
  }
  return out;
}

/** Common rafters of a gable roof spanning the depth, on 16" centres, and a ridge board. */
function gableRafters(
  id: string,
  width: number,
  depth: number,
  z: number,
  pitch: number,
): MemberData[] {
  const out: MemberData[] = [];
  const r = STOCK_2X8;
  // Each rafter stops at the ridge board's face.
  const run = depth / 2 + 12 * IN - STOCK_2X10.width / 2;
  const angle = Math.atan(pitch / 12);
  const len = run / Math.cos(angle);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let k = 1;
  for (let x = 0; x + r.width <= width; x += 16 * IN) {
    // South slope rising towards +y, north slope towards -y; the thin face along the ridge.
    out.push({
      id: `r${k}s`,
      owner: id,
      role: 'common-rafter',
      stock: r,
      length: len,
      placement: { origin: [x, -12 * IN, z], x: [0, c, s], y: [1, 0, 0] },
      cuts: [],
    });
    out.push({
      id: `r${k}n`,
      owner: id,
      role: 'common-rafter',
      stock: r,
      length: len,
      placement: { origin: [x + r.width, depth + 12 * IN, z], x: [0, -c, s], y: [-1, 0, 0] },
      cuts: [],
    });
    k++;
  }
  out.push({
    id: 'ridge',
    owner: id,
    role: 'ridge',
    stock: STOCK_2X10,
    length: width,
    placement: {
      origin: [0, depth / 2 - STOCK_2X10.width / 2, z + run * Math.tan(angle) - STOCK_2X10.depth],
      x: [1, 0, 0],
      y: [0, 1, 0],
    },
    cuts: [],
  });
  return out;
}

/** A two-storey 40' x 30' house: walls on two levels, the floor between them, a 6/12 gable roof. */
export function houseFixture(partId = 'house'): MemberFixture {
  const W = 40 * FT;
  const D = 30 * FT;
  const window = (id: string, at: number): Opening => ({
    id,
    at,
    width: 38 * IN,
    top: 82.5 * IN,
    sill: 40.5 * IN,
    header: STOCK_2X8,
  });
  const level2 = WALL_HEIGHT + STOCK_2X10.depth;
  const groups: { group: string; members: MemberData[] }[] = [];
  const bodies: BodyInput[] = [];
  for (const [prefix, z] of [
    ['l1-', 0],
    ['l2-', level2],
  ] as const) {
    const ground = prefix === 'l1-';
    const walls = rectangleWalls(prefix, W, D, z, {
      s: [
        ground
          ? {
              id: `${prefix}door`,
              at: 18 * FT,
              width: 38 * IN,
              top: 82.5 * IN,
              sill: 0,
              header: STOCK_2X10,
            }
          : window(`${prefix}win-s3`, 18 * FT),
        window(`${prefix}win-s1`, 4 * FT),
        window(`${prefix}win-s2`, 30 * FT),
      ],
      e: [window(`${prefix}win-e1`, 8 * FT), window(`${prefix}win-e2`, 20 * FT)],
      n: [window(`${prefix}win-n1`, 6 * FT), window(`${prefix}win-n2`, 26 * FT)],
      w: [window(`${prefix}win-w1`, 12 * FT)],
    });
    for (const w of walls) {
      groups.push({ group: w.id, members: frameWall(w) });
      bodies.push(sheathingBody(partId, w, z));
    }
    // Two interior walls per level.
    for (const [id, x] of [
      [`${prefix}int-1`, 14 * FT],
      [`${prefix}int-2`, 27 * FT],
    ] as const) {
      const wall: WallSpec = {
        id,
        start: [x, STOCK_2X4.depth, z],
        dir: [0, 1, 0],
        length: D - 2 * STOCK_2X4.depth,
        openings: [
          {
            id: `${id}-door`,
            at: 6 * FT,
            width: 32 * IN,
            top: 82.5 * IN,
            sill: 0,
            header: STOCK_2X6,
          },
        ],
      };
      groups.push({ group: id, members: frameWall(wall) });
    }
  }
  groups.push({ group: 'floor-2', members: floorFraming('floor-2', W, D, WALL_HEIGHT) });
  groups.push({ group: 'roof', members: gableRafters('roof', W, D, level2 + WALL_HEIGHT, 6) });
  return { partId, view: memberView(groups), bodies, levels: [0, level2] };
}

export function memberFixture(name: MemberFixtureName, partId?: string): MemberFixture {
  return name === 'house' ? houseFixture(partId) : shedFixture(partId);
}
