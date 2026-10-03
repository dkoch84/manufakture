// Shared by the tests: stock in inches, a wall builder, and member extents in wall coordinates.

import { MM_PER_INCH } from '@manufakture/units';
import type { FrameWallInput, HeaderSpec, WallSegment, WallSettingsInput } from './framing/wall';
import { memberCorners, type StockRef, type Member } from './members';

export const IN = MM_PER_INCH;
export const inch = (v: number) => v * IN;

/** PS 20 dressed sizes, as the catalog has them (mm). */
export const S2X4: StockRef = { id: 'us-2x4', name: '2x4', width: inch(1.5), depth: inch(3.5) };
export const S2X6: StockRef = { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) };
export const S2X8: StockRef = {
  id: 'us-2x8',
  name: '2x8',
  width: inch(1.5),
  depth: inch(7.25),
};
export const S2X10: StockRef = {
  id: 'us-2x10',
  name: '2x10',
  width: inch(1.5),
  depth: inch(9.25),
};
/** 1/2" plywood, as a header spacer. */
export const PLY_HALF: StockRef = {
  id: 'us-ply-15-32',
  name: '1/2" plywood',
  width: inch(0.5),
  depth: inch(48),
};

/** A doubled 2x8 with a 1/2" spacer and one jack each side. */
export const DOUBLE_2X8: HeaderSpec = { stock: S2X8, plies: 2, spacer: PLY_HALF, jacks: 1 };

/** One bottom plate, 92-5/8" precut studs, two top plates. */
export const PRECUT_WALL_HEIGHT = inch(1.5 + 92.625 + 3);

export function straightWall(
  lengthIn: number,
  segment: Partial<WallSegment> = {},
  settings: Partial<WallSettingsInput> = {},
  rest: Partial<FrameWallInput> = {},
): FrameWallInput {
  return {
    wall: 'extension#3',
    segments: [
      {
        start: [0, 0],
        end: [inch(lengthIn), 0],
        height: PRECUT_WALL_HEIGHT,
        thickness: inch(3.5),
        justification: 'left',
        ...segment,
      },
    ],
    settings: { studStock: S2X4, defaultHeader: DOUBLE_2X8, ...settings },
    ...rest,
  };
}

export interface Extent {
  /** Along the wall, across it, above the base: [min, max] each. */
  s: [number, number];
  t: [number, number];
  z: [number, number];
}

/** A member's box in a straight segment's coordinates (members are axis aligned there). */
export function extentIn(segment: WallSegment, m: Member): Extent {
  const dx = segment.end[0] - segment.start[0];
  const dy = segment.end[1] - segment.start[1];
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  const base = segment.base ?? 0;
  const e: Extent = {
    s: [Infinity, -Infinity],
    t: [Infinity, -Infinity],
    z: [Infinity, -Infinity],
  };
  for (const p of memberCorners(m)) {
    const rx = p[0] - segment.start[0];
    const ry = p[1] - segment.start[1];
    const v = { s: rx * ux + ry * uy, t: -rx * uy + ry * ux, z: p[2] - base };
    for (const k of ['s', 't', 'z'] as const) {
      e[k][0] = Math.min(e[k][0], v[k]);
      e[k][1] = Math.max(e[k][1], v[k]);
    }
  }
  return e;
}

/** The same extent in inches, rounded to 1/1000", for readable fixtures. */
export function extentInches(segment: WallSegment, m: Member): Extent {
  const e = extentIn(segment, m);
  const r = (v: number) => Math.round((v / IN) * 1000) / 1000;
  return {
    s: [r(e.s[0]), r(e.s[1])],
    t: [r(e.t[0]), r(e.t[1])],
    z: [r(e.z[0]), r(e.z[1])],
  };
}

/** Inches, rounded to 1/1000". */
export const toInches = (mm: number) => Math.round((mm / IN) * 1000) / 1000;

/** A small seeded generator (mulberry32), so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
