// A quick, throwaway framing generator: enough real framing (layout slots, plates spliced to
// stock, corners, tees, openings with kings, jacks, headers, sills and cripples, joists, rafters
// with birdsmouths, hips and jacks with side cuts) that member counts and the share of cut
// members are realistic. It is not T6.2a's generator: no overrides, no warnings, no checks.
// Everything is in inches; `toMillimetres` converts at the end.

import { cross, dot, normalize, scale, type Placement, type Plane, type Vec3 } from './geom.ts';
import { pieces } from './clip.ts';
import { STOCK, localPlane, type Member, type Role, type Stock } from './members.ts';

/** Precut stud: one bottom plate and two top plates make a 97-1/8" wall. */
export const PRECUT_STUD = 92.625;
export const PLATE = 1.5;
export const WALL_HEIGHT = PLATE + PRECUT_STUD + 2 * PLATE;
/** Longest stock for plates, rims and ridges (16'). */
export const STOCK_LENGTH = 192;

const E: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * A member filling a world axis-aligned box. `lengthAxis` and `widthAxis` are the world axes of
 * the member's local x and y; the box's extent along the third axis is the stock's depth.
 */
export function boxMember(
  group: string,
  id: string,
  role: Role,
  stock: Stock,
  min: Vec3,
  max: Vec3,
  lengthAxis: 0 | 1 | 2,
  widthAxis: 0 | 1 | 2,
): Member {
  const x = E[lengthAxis]!;
  const y = E[widthAxis]!;
  const z = cross(x, y);
  const third = 3 - lengthAxis - widthAxis;
  const origin: Vec3 = [min[0], min[1], min[2]];
  if (z[third]! < 0) origin[third] = max[third]!;
  return {
    id,
    role,
    stock,
    length: max[lengthAxis]! - min[lengthAxis]!,
    placement: { origin, x, y },
    cuts: [],
    group,
  };
}

const EPS = 1e-6;

/**
 * Add a world plane cut if it removes part of the member as cut so far. Returns false when it
 * would remove the whole member (the caller drops it).
 */
export function cutBy(m: Member, world: Plane): boolean {
  const local = localPlane(m, world);
  const verts = pieces(m.length, m.stock.width, m.stock.depth, m.cuts).flat(2);
  const d = verts.map((v) => dot(local.n, v) - local.k);
  if (d.every((x) => x >= -EPS)) return false;
  if (d.some((x) => x > 1e-4)) {
    m.cuts.push({ kind: 'plane', plane: local });
    // Drop earlier plane cuts the new one makes redundant (a kernel tool must remove something).
    m.cuts = m.cuts.filter((c) => {
      if (c.kind !== 'plane' || c.plane === local) return true;
      const others = m.cuts.filter((o) => o !== c);
      const vs = pieces(m.length, m.stock.width, m.stock.depth, others).flat(2);
      return vs.some((v) => dot(c.plane.n, v) - c.plane.k > 1e-4);
    });
  }
  return true;
}

// Walls ----------------------------------------------------------------------------------------

export interface Opening {
  id: string;
  kind: 'door' | 'window';
  /** Centre along the wall, from the wall's start. */
  at: number;
  /** Rough opening width and head height (above the bottom of the bottom plate). */
  width: number;
  head: number;
  /** Rough sill height, windows only. */
  sill?: number;
}

export interface Wall {
  id: string;
  /** Start of the wall's reference face, in plan. */
  start: [number, number];
  /** Unit direction along the wall, axis-aligned. */
  dir: [number, number];
  length: number;
  stock: Stock;
  /** Bottom of the bottom plate. */
  base: number;
  openings: Opening[];
  /** Ends that are an outside corner get a corner nailer. */
  corners: { start: boolean; end: boolean };
  spacing: number;
}

/** Positions along a host wall where other walls meet it (two extra studs each). */
export type Tees = Map<string, number[]>;

function headerStock(width: number): Stock {
  if (width <= 36) return STOCK['2x6'];
  if (width <= 60) return STOCK['2x8'];
  if (width <= 96) return STOCK['2x10'];
  return STOCK['2x12'];
}

/** Pieces of [a, b] no longer than the stock, with splices starting at `offset`. */
function splice(a: number, b: number, offset: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = a;
  let next = a + offset;
  while (next <= s + 1) next += STOCK_LENGTH;
  while (b - s > STOCK_LENGTH) {
    const e = Math.min(next, s + STOCK_LENGTH);
    out.push([s, e]);
    s = e;
    next = e + STOCK_LENGTH;
  }
  out.push([s, b]);
  return out;
}

/** Subtract intervals from [a, b]. */
function without(a: number, b: number, holes: Array<[number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[a, b]];
  for (const [h0, h1] of holes) {
    parts = parts.flatMap(([p0, p1]) => {
      if (h1 <= p0 || h0 >= p1) return [[p0, p1] as [number, number]];
      const out: Array<[number, number]> = [];
      if (h0 > p0) out.push([p0, h0]);
      if (h1 < p1) out.push([h1, p1]);
      return out;
    });
  }
  return parts.filter(([p0, p1]) => p1 - p0 > 0.25);
}

export function wallAxis(w: Wall): 0 | 1 {
  return w.dir[0] !== 0 ? 0 : 1;
}

/** A box in wall coordinates (s along, t across the thickness, z up) as a world member. */
function wallMember(
  w: Wall,
  id: string,
  role: Role,
  stock: Stock,
  s: [number, number],
  t: [number, number],
  z: [number, number],
  kind: 'along-flat' | 'vertical' | 'along-edge',
): Member {
  const across: [number, number] = [-w.dir[1], w.dir[0]];
  const p = (si: number, ti: number): [number, number] => [
    w.start[0] + si * w.dir[0] + ti * across[0],
    w.start[1] + si * w.dir[1] + ti * across[1],
  ];
  const a = p(s[0], t[0]);
  const b = p(s[1], t[1]);
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z[0]];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), z[1]];
  const along = wallAxis(w);
  const acrossAxis = along === 0 ? 1 : 0;
  if (kind === 'vertical') return boxMember(w.id, id, role, stock, min, max, 2, along);
  if (kind === 'along-flat') return boxMember(w.id, id, role, stock, min, max, along, 2);
  return boxMember(w.id, id, role, stock, min, max, along, acrossAxis);
}

export function frameWall(w: Wall, tees: readonly number[] = []): Member[] {
  const out: Member[] = [];
  const T = w.stock.depth;
  const t: [number, number] = [0, T];
  const L = w.length;
  const z0 = w.base;
  const studBottom = z0 + PLATE;
  const studTop = studBottom + PRECUT_STUD;
  const sw = w.stock.width;

  // Plates: the bottom plate stops at door openings; top plates spliced, splices offset 96".
  const doors: Array<[number, number]> = w.openings
    .filter((o) => o.kind === 'door')
    .map((o) => [o.at - o.width / 2, o.at + o.width / 2]);
  let n = 0;
  for (const [a, b] of without(0, L, doors))
    for (const [p0, p1] of splice(a, b, STOCK_LENGTH))
      out.push(
        wallMember(
          w,
          `bottom:${++n}`,
          'bottom-plate',
          w.stock,
          [p0, p1],
          t,
          [z0, z0 + PLATE],
          'along-flat',
        ),
      );
  for (const [course, offset] of [
    [1, STOCK_LENGTH],
    [2, STOCK_LENGTH / 2],
  ] as const) {
    const z = studTop + (course - 1) * PLATE;
    splice(0, L, offset).forEach(([p0, p1], i) =>
      out.push(
        wallMember(
          w,
          `top${course}:${i + 1}`,
          'top-plate',
          w.stock,
          [p0, p1],
          t,
          [z, z + PLATE],
          'along-flat',
        ),
      ),
    );
  }

  // Opening framing zones: kings and jacks either side of the rough opening.
  const zones = w.openings.map((o) => {
    const a = o.at - o.width / 2;
    const b = o.at + o.width / 2;
    return { o, a, b, zone: [a - 2 * sw, b + 2 * sw] as [number, number] };
  });
  const blocked = (s0: number) => zones.some((z) => s0 + sw > z.zone[0] && s0 < z.zone[1]);

  // Layout slots: slot 0 flush at the start, slot k centred on k * spacing, the last flush at the end.
  const slots: Array<[number, number]> = [[0, 0]];
  for (let k = 1; k * w.spacing + sw / 2 < L - sw; k++) slots.push([k, k * w.spacing - sw / 2]);
  slots.push([slots.length, L - sw]);
  const placed: number[] = [];
  for (const [k, s0] of slots) {
    if (blocked(s0)) continue;
    placed.push(s0);
    out.push(
      wallMember(w, `s${k}`, 'stud', w.stock, [s0, s0 + sw], t, [studBottom, studTop], 'vertical'),
    );
  }
  if (w.corners.start)
    out.push(
      wallMember(
        w,
        'corner-a',
        'corner-stud',
        w.stock,
        [sw, 2 * sw],
        t,
        [studBottom, studTop],
        'vertical',
      ),
    );
  if (w.corners.end)
    out.push(
      wallMember(
        w,
        'corner-b',
        'corner-stud',
        w.stock,
        [L - 2 * sw, L - sw],
        t,
        [studBottom, studTop],
        'vertical',
      ),
    );
  tees.forEach((at, i) => {
    for (const [side, s0] of [
      ['a', at - 1.75 - sw],
      ['b', at + 1.75],
    ] as const) {
      // A tee stud where a layout stud already stands is that stud.
      if (s0 < sw || s0 > L - 2 * sw || blocked(s0) || placed.some((p) => Math.abs(p - s0) < sw))
        continue;
      out.push(
        wallMember(
          w,
          `tee${i + 1}${side}`,
          'tee-stud',
          w.stock,
          [s0, s0 + sw],
          t,
          [studBottom, studTop],
          'vertical',
        ),
      );
    }
  });

  for (const { o, a, b } of zones) {
    const id = o.id;
    const head = z0 + o.head;
    const hs = headerStock(o.width);
    const plies = Math.max(2, Math.round(T / 1.5) - 1);
    const vertical = (role: Role, name: string, s0: number, top: number) =>
      out.push(
        wallMember(
          w,
          `${id}:${name}`,
          role,
          w.stock,
          [s0, s0 + sw],
          t,
          [studBottom, top],
          'vertical',
        ),
      );
    vertical('king', 'king-l', a - 2 * sw, studTop);
    vertical('king', 'king-r', b + sw, studTop);
    vertical('jack', 'jack-l', a - sw, head);
    vertical('jack', 'jack-r', b, head);
    for (let p = 0; p < plies; p++) {
      const t0 = p * ((T - 1.5) / Math.max(1, plies - 1));
      out.push(
        wallMember(
          w,
          `${id}:header-${p + 1}`,
          'header',
          hs,
          [a - sw, b + sw],
          [t0, t0 + 1.5],
          [head, head + hs.depth],
          'along-edge',
        ),
      );
    }
    // Cripples on the layout slots that fall inside the opening.
    const inside = slots.filter(([, s0]) => s0 >= a && s0 + sw <= b);
    if (studTop - (head + hs.depth) >= 3)
      for (const [k, s0] of inside)
        out.push(
          wallMember(
            w,
            `${id}:cripple-a${k}`,
            'cripple',
            w.stock,
            [s0, s0 + sw],
            t,
            [head + hs.depth, studTop],
            'vertical',
          ),
        );
    if (o.kind === 'window' && o.sill !== undefined) {
      const sill = z0 + o.sill;
      out.push(
        wallMember(w, `${id}:sill`, 'sill', w.stock, [a, b], t, [sill - PLATE, sill], 'along-flat'),
      );
      for (const [k, s0] of inside)
        out.push(
          wallMember(
            w,
            `${id}:cripple-b${k}`,
            'cripple',
            w.stock,
            [s0, s0 + sw],
            t,
            [studBottom, sill - PLATE],
            'vertical',
          ),
        );
    }
  }
  return out;
}

/** Where wall ends meet other walls: an end on a host wall's thickness becomes a tee on it. */
export function findTees(walls: readonly Wall[]): Tees {
  const tees: Tees = new Map();
  for (const w of walls) {
    const across: [number, number] = [-w.dir[1], w.dir[0]];
    const T = w.stock.depth;
    for (const s of [0, w.length]) {
      // Centre of the wall's end, in plan.
      const e: [number, number] = [
        w.start[0] + s * w.dir[0] + (T / 2) * across[0],
        w.start[1] + s * w.dir[1] + (T / 2) * across[1],
      ];
      for (const h of walls) {
        if (h === w || wallAxis(h) === wallAxis(w)) continue;
        const ha: [number, number] = [-h.dir[1], h.dir[0]];
        const d: [number, number] = [e[0] - h.start[0], e[1] - h.start[1]];
        const hs = d[0] * h.dir[0] + d[1] * h.dir[1];
        const ht = d[0] * ha[0] + d[1] * ha[1];
        const reach = h.stock.depth + T / 2 + 0.5;
        if (hs > 6 && hs < h.length - 6 && ht >= -reach && ht <= reach) {
          tees.set(h.id, [...(tees.get(h.id) ?? []), hs]);
        }
      }
    }
  }
  return tees;
}

// Floors ---------------------------------------------------------------------------------------

export interface FloorSpan {
  /** Joists run along y from y0 to y1, laid out along x from x0 to x1. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Floor {
  id: string;
  /** Underside of the joists. */
  base: number;
  joist: Stock;
  spacing: number;
  spans: FloorSpan[];
  /** Rims along x at the outer ends of the spans (y = min and y = max). */
  rims: boolean;
  /** Members under the joists: skids or a girder, along x at the given y centres. */
  supports: { role: Role; stock: Stock; plies: number; y: number[] };
  /** Sill plates on the foundation, under the rims and the end joists. */
  sillPlates: boolean;
  /** A row of blocking between the joists over the support at this y. */
  blockingAt?: number;
}

export function frameFloor(f: Floor): Member[] {
  const out: Member[] = [];
  const j = f.joist;
  const top = f.base + j.depth;
  const xs = [...new Set(f.spans.flatMap((s) => [s.x0, s.x1]))];
  const X0 = Math.min(...xs);
  const X1 = Math.max(...xs);
  const Y0 = Math.min(...f.spans.map((s) => s.y0));
  const Y1 = Math.max(...f.spans.map((s) => s.y1));
  if (f.rims) {
    let n = 0;
    for (const [y0, y1] of [
      [Y0, Y0 + j.width],
      [Y1 - j.width, Y1],
    ] as const)
      for (const [a, b] of splice(X0, X1, STOCK_LENGTH))
        out.push(boxMember(f.id, `rim:${++n}`, 'rim', j, [a, y0, f.base], [b, y1, top], 0, 1));
  }
  f.spans.forEach((s, si) => {
    const y0 = f.rims && s.y0 === Y0 ? s.y0 + j.width : s.y0;
    const y1 = f.rims && s.y1 === Y1 ? s.y1 - j.width : s.y1;
    const positions: number[] = [s.x0];
    for (let k = 1; s.x0 + k * f.spacing + j.width / 2 < s.x1 - j.width; k++)
      positions.push(s.x0 + k * f.spacing - j.width / 2);
    positions.push(s.x1 - j.width);
    positions.forEach((x, k) => {
      const end = k === 0 || k === positions.length - 1;
      out.push(
        boxMember(
          f.id,
          `j${si + 1}:${k}`,
          end ? 'rim' : 'joist',
          j,
          [x, y0, f.base],
          [x + j.width, y1, top],
          1,
          0,
        ),
      );
      if (f.blockingAt !== undefined && si === 0 && k < positions.length - 1) {
        const next = positions[k + 1]!;
        out.push(
          boxMember(
            f.id,
            `block:${k}`,
            'blocking',
            j,
            [x + j.width, f.blockingAt - j.width / 2, f.base],
            [next, f.blockingAt + j.width / 2, top],
            0,
            1,
          ),
        );
      }
    });
  });
  const sup = f.supports;
  // A girder stops at the sill plates (it bears on the foundation there); skids run full length.
  const inset = f.sillPlates ? STOCK['2x6'].depth : 0;
  const sx0 = X0 + inset;
  const sx1 = X1 - inset;
  for (const [i, yc] of sup.y.entries()) {
    const w = sup.stock.width * sup.plies;
    for (let p = 0; p < sup.plies; p++) {
      const ya = yc - w / 2 + p * sup.stock.width;
      splice(sx0, sx1, STOCK_LENGTH * (p + 1) * 0.5).forEach(([a, b], k) =>
        out.push(
          boxMember(
            f.id,
            `${sup.role}${i + 1}-${p + 1}:${k + 1}`,
            sup.role,
            sup.stock,
            [a, ya, f.base - sup.stock.depth],
            [b, ya + sup.stock.width, f.base],
            0,
            1,
          ),
        ),
      );
    }
  }
  if (f.sillPlates) {
    const s = STOCK['2x6'];
    const z: [number, number] = [f.base - PLATE, f.base];
    let n = 0;
    for (const y of [Y0, Y1 - s.depth])
      for (const [a, b] of splice(X0, X1, STOCK_LENGTH))
        out.push(
          boxMember(
            f.id,
            `sill:${++n}`,
            'sill-plate',
            s,
            [a, y, z[0]],
            [b, y + s.depth, z[1]],
            0,
            2,
          ),
        );
    for (const x of [X0, X1 - s.depth])
      for (const [a, b] of splice(Y0 + s.depth, Y1 - s.depth, STOCK_LENGTH))
        out.push(
          boxMember(
            f.id,
            `sill:${++n}`,
            'sill-plate',
            s,
            [x, a, z[0]],
            [x + s.depth, b, z[1]],
            1,
            2,
          ),
        );
  }
  return out;
}

// Roofs ----------------------------------------------------------------------------------------

export interface RafterInput {
  group: string;
  id: string;
  role: Role;
  stock: Stock;
  /** Where the rafter's layout line crosses the outside face of the wall, in plan. */
  start: [number, number];
  /** Unit plan direction, up the slope. */
  dir: [number, number];
  /** Rise per unit of plan run along `dir`. */
  slope: number;
  /** Top of the top plate. */
  plate: number;
  /** Birdsmouth seat length in plan (the wall's thickness). */
  seat: number;
  /** Overhang in plan, beyond the wall's outside face. */
  overhang: number;
  /** Plan distance from `start` to just beyond the top cuts. */
  reach: number;
  /** World half-spaces removed at the top (plumb, side or cheek cuts). */
  top: Plane[];
}

/** The plane of a roof's rafters' bottom edges (removed above), for cutting studs and joists. */
export function roofUnderside(
  start: [number, number],
  dir: [number, number],
  slope: number,
  plate: number,
  seat: number,
): Plane {
  // z >= plate + (u.p - u.start - seat) * slope  <=>  z - slope u.p >= plate - slope (u.start + seat)
  const n: Vec3 = [-slope * dir[0], -slope * dir[1], 1];
  const len = Math.hypot(n[0], n[1], n[2]);
  const k = plate - slope * (dir[0] * start[0] + dir[1] * start[1] + seat);
  return { n: scale(n, 1 / len), k: k / len };
}

/** A rafter: tail plumb cut, birdsmouth (heel and seat), and its top cuts. */
export function rafter(r: RafterInput): Member | null {
  const len = Math.hypot(1, r.slope);
  const c = 1 / len;
  const s = r.slope / len;
  const u: Vec3 = [r.dir[0], r.dir[1], 0];
  const x: Vec3 = [r.dir[0] * c, r.dir[1] * c, s];
  const y: Vec3 = [-r.dir[1], r.dir[0], 0];
  const d = r.stock.depth;
  const w = r.stock.width;
  // Bottom edge: z(rr) = plate + (rr - seat) * slope at plan distance rr from the wall face.
  const r0 = -r.overhang;
  const z0 = r.plate + (r0 - r.seat) * r.slope;
  const origin: Vec3 = [
    r.start[0] + r0 * r.dir[0] - (w / 2) * y[0],
    r.start[1] + r0 * r.dir[1] - (w / 2) * y[1],
    z0,
  ];
  const length = (r.reach - r0) / c + d * r.slope + 2 * w;
  const placement: Placement = { origin, x, y };
  const m: Member = {
    id: r.id,
    role: r.role,
    stock: r.stock,
    length,
    placement,
    cuts: [],
    group: r.group,
  };
  const ustart = dot(u, [r.start[0], r.start[1], 0]);
  // Tail: plumb cut at the overhang.
  if (!cutBy(m, { n: scale(u, -1), k: -(ustart - r.overhang) })) return null;
  // Birdsmouth: heel (inward of the wall face) and seat (below the plate top).
  m.cuts.push({
    kind: 'notch',
    a: localPlane(m, { n: u, k: ustart }),
    b: localPlane(m, { n: [0, 0, -1], k: -r.plate }),
  });
  for (const p of r.top)
    if (!cutBy(m, { n: normalize(p.n), k: p.k / Math.hypot(...p.n) })) return null;
  return m;
}
