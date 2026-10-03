// Test parts for the simulation (T5.3c): the M1 bracket's plate (40 x 20 x 6 mm, the corner at
// (40, 0) rounded to 2 mm; `packages/core/src/fixtures/v14-bracket.json`) in machine coordinates
// with its top at Z 0, as a profile loop and as a mesh, optionally with a rectangular pocket in
// its top. Its 6 mm hole is left out: these jobs do not drill it.

import type { Loop2, Mesh, Vec2 } from '../types';

export const BRACKET = { width: 40, depth: 20, thickness: 6, corner: 2 } as const;

/**
 * The bracket's outline, counter-clockwise, from (0, 0) to (40, 20); `inset` mm smaller all round
 * (the rounded corner keeps its centre) to stand for a wrong offset.
 */
export function bracketOutline(inset = 0): Loop2 {
  const { width: w, depth: d, corner: r } = BRACKET;
  const i = inset;
  return {
    segments: [
      { kind: 'line', start: [i, i], end: [w - r, i] },
      { kind: 'arc', start: [w - r, i], end: [w - i, r], center: [w - r, r], ccw: true },
      { kind: 'line', start: [w - i, r], end: [w - i, d - i] },
      { kind: 'line', start: [w - i, d - i], end: [i, d - i] },
      { kind: 'line', start: [i, d - i], end: [i, i] },
    ],
  };
}

/** The outline as a polygon, the arc in `n` chords (inscribed, so never outside the part). */
export function bracketPolygon(n = 16): Vec2[] {
  const { width: w, depth: d, corner: r } = BRACKET;
  const pts: Vec2[] = [[0, 0]];
  for (let k = 0; k <= n; k++) {
    const a = -Math.PI / 2 + ((Math.PI / 2) * k) / n;
    pts.push([w - r + r * Math.cos(a), r + r * Math.sin(a)]);
  }
  pts.push([w, d], [0, d]);
  return pts;
}

export interface PocketBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Floor Z (below 0). */
  readonly floor: number;
}

/**
 * The bracket as a closed mesh, top at Z 0 and bottom at -6, with `pocket` sunk into its top. The
 * top is fanned from a point inside, so a pocket must lie in the plain rectangle x 0 to 38.
 */
export function bracketMesh(pocket?: PocketBox): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  const ring = bracketPolygon();
  const bottom = -BRACKET.thickness;
  // Walls and bottom of the outline.
  const top = ring.map(([x, y]) => v(x, y, 0));
  const low = ring.map(([x, y]) => v(x, y, bottom));
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    quad(low[i]!, low[j]!, top[j]!, top[i]!);
  }
  const cb = v(BRACKET.width / 2, BRACKET.depth / 2, bottom);
  for (let i = 0; i < ring.length; i++) idx.push(cb, low[(i + 1) % ring.length]!, low[i]!);
  if (!pocket) {
    const ct = v(BRACKET.width / 2, BRACKET.depth / 2, 0);
    for (let i = 0; i < ring.length; i++) idx.push(ct, top[i]!, top[(i + 1) % ring.length]!);
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  }
  const { x0, y0, x1, y1, floor } = pocket;
  // The top: the rounded right part fanned from its own centre, the rest as rectangles around
  // the pocket.
  const right = ring.filter(([x]) => x >= x1 - 1e-9);
  const rightPts = [[x1, 0] as Vec2, ...right.filter(([x]) => x > x1), [x1, BRACKET.depth] as Vec2];
  const rc = v((x1 + BRACKET.width) / 2, BRACKET.depth / 2, 0);
  const rv = rightPts.map(([x, y]) => v(x, y, 0));
  for (let i = 0; i + 1 < rv.length; i++) idx.push(rc, rv[i]!, rv[i + 1]!);
  idx.push(rc, rv[rv.length - 1]!, rv[0]!);
  const rect = (ax: number, ay: number, bx: number, by: number, z: number): void => {
    if (bx - ax < 1e-9 || by - ay < 1e-9) return;
    quad(v(ax, ay, z), v(bx, ay, z), v(bx, by, z), v(ax, by, z));
  };
  rect(0, 0, x0, BRACKET.depth, 0);
  rect(x0, 0, x1, y0, 0);
  rect(x0, y1, x1, BRACKET.depth, 0);
  rect(x0, y0, x1, y1, floor);
  // The pocket's walls (vertical: invisible from above, there for a closed mesh).
  const c = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i]!;
    const [bx, by] = c[(i + 1) % 4]!;
    quad(v(ax, ay, floor), v(ax, ay, 0), v(bx, by, 0), v(bx, by, floor));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/**
 * A square plate `size` mm across from (0, 0), top at Z 0 and `thickness` thick, with a round
 * through hole of `radius` about its centre, the hole in `n` chords (vertices on the circle, so the
 * chords stand into the hole by up to radius * (1 - cos(pi / n))). `n` a multiple of 8, so that
 * the plate's corners are among the outer ring's points. A closed mesh, wound outward.
 */
export function plateWithHole(size: number, radius: number, thickness: number, n: number): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, z: number): number => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number): void => {
    idx.push(a, b, c, a, c, d);
  };
  const c = size / 2;
  const inner: Vec2[] = [];
  const outer: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    inner.push([c + radius * dx, c + radius * dy]);
    // Where the ray from the centre leaves the square.
    const t = c / Math.max(Math.abs(dx), Math.abs(dy));
    outer.push([c + t * dx, c + t * dy]);
  }
  const z0 = -thickness;
  const it = inner.map(([x, y]) => v(x, y, 0));
  const ot = outer.map(([x, y]) => v(x, y, 0));
  const ib = inner.map(([x, y]) => v(x, y, z0));
  const ob = outer.map(([x, y]) => v(x, y, z0));
  for (let k = 0; k < n; k++) {
    const m = (k + 1) % n;
    quad(it[k]!, ot[k]!, ot[m]!, it[m]!); // top, facing up
    quad(ib[m]!, ob[m]!, ob[k]!, ib[k]!); // bottom, facing down
    quad(ob[k]!, ob[m]!, ot[m]!, ot[k]!); // outer wall
    quad(ib[m]!, ib[k]!, it[k]!, it[m]!); // the hole's wall
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
