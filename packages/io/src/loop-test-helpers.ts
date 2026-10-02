// Test-only loops for the DXF and SVG loop writers (T5.6a), and the comparison both tests use:
// a file read back into pieces, consecutive arc pieces about one centre merged (writers split full
// circles and long arcs), checked against the input loops to the written precision. Not exported
// from the package.

import { expect } from 'vitest';
import type { Loop2, LoopLayer2, LoopSegment2, Vec2 } from './path2';

const TAU = 2 * Math.PI;

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const polar = (c: Vec2, r: number, a: number): Vec2 => [
  c[0] + r * Math.cos(a),
  c[1] + r * Math.sin(a),
];

/** Odd decimals, so every writer has to round (seven places in, six out). */
const O: Vec2 = [3.1234567, 2.7654321];

/** A 120 x 80 rectangle with 6.35 mm corner radii, counter-clockwise (an outer loop). */
export function roundedRectangle(id?: string): Loop2 {
  const r = 6.35;
  const [w, h] = [120, 80];
  const c = (x: number, y: number): Vec2 => add(O, [x, y]);
  const corner = (cx: number, cy: number, a0: number): LoopSegment2 => ({
    kind: 'arc',
    center: c(cx, cy),
    start: polar(c(cx, cy), r, a0),
    end: polar(c(cx, cy), r, a0 + Math.PI / 2),
    ccw: true,
  });
  const segs: LoopSegment2[] = [
    { kind: 'line', start: c(r, 0), end: c(w - r, 0) },
    corner(w - r, r, -Math.PI / 2),
    { kind: 'line', start: c(w, r), end: c(w, h - r) },
    corner(w - r, h - r, 0),
    { kind: 'line', start: c(w - r, h), end: c(r, h) },
    corner(r, h - r, Math.PI / 2),
    { kind: 'line', start: c(0, h - r), end: c(0, r) },
    corner(r, r, Math.PI),
  ];
  // Make the lines meet the arcs' computed ends exactly.
  const fixed = segs.map((s, i) => {
    const prev = segs[(i + segs.length - 1) % segs.length]!;
    return s.kind === 'line'
      ? { ...s, start: prev.end, end: segs[(i + 1) % segs.length]!.start }
      : s;
  });
  return id === undefined ? { segments: fixed } : { segments: fixed, id };
}

/** A clockwise full circle (a hole). */
export const HOLE: Loop2 = {
  id: 'hole#1',
  segments: [
    {
      kind: 'arc',
      center: add(O, [30.5, 40.25]),
      start: add(O, [34.7, 40.25]),
      end: add(O, [34.7, 40.25]),
      ccw: false,
      fullCircle: true,
    },
  ],
};

/** A clockwise slot: two half circles and two lines (a hole). */
export function slot(): Loop2 {
  const r = 3.175;
  const a = add(O, [60, 40]);
  const b = add(O, [90, 40]);
  return {
    segments: [
      { kind: 'line', start: [a[0], a[1] + r], end: [b[0], b[1] + r] },
      { kind: 'arc', center: b, start: [b[0], b[1] + r], end: [b[0], b[1] - r], ccw: false },
      { kind: 'line', start: [b[0], b[1] - r], end: [a[0], a[1] - r] },
      { kind: 'arc', center: a, start: [a[0], a[1] - r], end: [a[0], a[1] + r], ccw: false },
    ],
  };
}

/** A 72-gon, clockwise: flattened segments, as from a spline (a hole). */
export function flattened(): Loop2 {
  const c = add(O, [100, 20]);
  const pts = Array.from({ length: 72 }, (_, i) =>
    polar(c, 8 + 0.5 * Math.sin(5 * i), -i * (TAU / 72)),
  );
  return {
    segments: pts.map((p, i) => ({
      kind: 'line' as const,
      start: p,
      end: pts[(i + 1) % pts.length]!,
    })),
  };
}

/** A 270 degree counter-clockwise arc closed by its chord: one arc command past half a turn. */
export function keyhole(): Loop2 {
  const c = add(O, [20, 20]);
  const s = polar(c, 7.5, -Math.PI / 4);
  const e = polar(c, 7.5, (5 * Math.PI) / 4);
  return {
    id: 'keyhole',
    segments: [
      { kind: 'arc', center: c, start: s, end: e, ccw: true },
      { kind: 'line', start: e, end: s },
    ],
  };
}

/** Two layers, as a laser export of a part's outline and its engraving. */
export function loopLayers(): LoopLayer2[] {
  return [
    {
      name: 'outside',
      color: '#ff0000',
      loops: [roundedRectangle('outline'), HOLE, slot(), flattened()],
    },
    { name: 'engrave', color: '#0000ff', weight: 0.1, loops: [keyhole()] },
  ];
}

/** A piece read back from a file, in millimetres with y up. */
export type ReadPiece =
  | { readonly kind: 'line'; readonly start: Vec2; readonly end: Vec2 }
  | {
      readonly kind: 'arc';
      readonly start: Vec2;
      readonly end: Vec2;
      readonly center: Vec2;
      /** Signed: positive counter-clockwise. */
      readonly sweep: number;
    }
  /** A DXF CIRCLE: no start and no direction. */
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number };

/** Arc centre from its ends and DXF bulge (positive counter-clockwise). */
export function bulgeArc(start: Vec2, end: Vec2, bulge: number): ReadPiece {
  const sweep = 4 * Math.atan(bulge);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const c = Math.hypot(dx, dy);
  const k = c / 2 / Math.tan(sweep / 2) / c;
  const center: Vec2 = [(start[0] + end[0]) / 2 - dy * k, (start[1] + end[1]) / 2 + dx * k];
  return { kind: 'arc', start, end, center, sweep };
}

/** Arc centre from its ends, radius and SVG flags, with y up (`ccw` from the sweep flag). */
export function endpointArc(
  start: Vec2,
  end: Vec2,
  r: number,
  large: boolean,
  ccw: boolean,
): ReadPiece {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const c = Math.hypot(dx, dy);
  const h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2));
  const side = ccw !== large ? 1 : -1;
  const center: Vec2 = [
    (start[0] + end[0]) / 2 - (side * h * dy) / c,
    (start[1] + end[1]) / 2 + (side * h * dx) / c,
  ];
  return { kind: 'arc', start, end, center, sweep: arcSweep(center, start, end, ccw) };
}

/** The sweep from `start` to `end` about `center` in the given direction, in (0, 2 pi]. */
export function arcSweep(center: Vec2, start: Vec2, end: Vec2, ccw: boolean): number {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let s = a1 - a0;
  if (ccw) while (s <= 1e-12) s += TAU;
  else while (s >= -1e-12) s -= TAU;
  return s;
}

const near = (a: Vec2, b: Vec2, tol: number): boolean =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** Consecutive arcs about one centre in one direction joined into one arc. */
export function mergeArcs(pieces: readonly ReadPiece[]): ReadPiece[] {
  const out: ReadPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (
      p.kind === 'arc' &&
      last?.kind === 'arc' &&
      near(last.center, p.center, 1e-5) &&
      Math.sign(last.sweep) === Math.sign(p.sweep)
    )
      out[out.length - 1] = { ...last, end: p.end, sweep: last.sweep + p.sweep };
    else out.push(p);
  }
  return out;
}

/** Points are written to six decimals: read back, they are within half a unit of the input. */
export const POINT_TOL = 5e-7 + 1e-9;
/** Centres rebuilt from rounded ends (and a bulge or radius) move by a few roundings. */
export const CENTER_TOL = 2e-6;

/**
 * Checks pieces read from one loop's entity against the loop. A DXF CIRCLE stands for a loop of
 * one full circle (centre and radius only).
 */
export function expectLoop(read: readonly ReadPiece[], loop: Loop2, label: string): void {
  const pieces = mergeArcs(read);
  const segs = loop.segments;
  expect(pieces.length, `${label}: pieces`).toBe(segs.length);
  segs.forEach((seg, i) => {
    const p = pieces[i]!;
    const at = `${label}, segment ${i}`;
    if (p.kind === 'circle') {
      expect(seg.kind === 'arc' && seg.fullCircle, at).toBe(true);
      if (seg.kind !== 'arc') return;
      expect(near(p.center, seg.center, POINT_TOL), `${at}: centre`).toBe(true);
      const r = Math.hypot(seg.start[0] - seg.center[0], seg.start[1] - seg.center[1]);
      expect(Math.abs(p.radius - r), `${at}: radius`).toBeLessThanOrEqual(POINT_TOL);
      return;
    }
    expect(p.kind, at).toBe(seg.kind);
    expect(near(p.start, seg.start, POINT_TOL), `${at}: start ${p.start} vs ${seg.start}`).toBe(
      true,
    );
    expect(near(p.end, seg.end, POINT_TOL), `${at}: end ${p.end} vs ${seg.end}`).toBe(true);
    if (p.kind === 'arc' && seg.kind === 'arc') {
      expect(near(p.center, seg.center, CENTER_TOL), `${at}: centre ${p.center}`).toBe(true);
      const sweep = seg.fullCircle
        ? seg.ccw
          ? TAU
          : -TAU
        : arcSweep(seg.center, seg.start, seg.end, seg.ccw);
      expect(Math.abs(p.sweep - sweep), `${at}: sweep ${p.sweep} vs ${sweep}`).toBeLessThan(1e-6);
    }
  });
}
