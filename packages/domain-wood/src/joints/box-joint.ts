// Box joints (finger joints): two boards' ends at a square corner, each end flush with the other
// board's outside face, so their blanks overlap in a block the boards' thicknesses by their common
// width. The block is cut into fingers across the width, alternately A's and B's; each board loses
// a slot (a box) where the other's fingers go. All of a board's slots are one run of the `tools`
// input, so each board takes one boolean however many fingers there are.

import { refuse, type Built, type Values } from './common';
import { AXES, LINEAR_TOL, boxTool, mm, type Pair, type V3 } from './geometry';
import type { BoxJointParams } from './params';

/** The most fingers a box joint may have. */
export const MAX_FINGERS = 200;

export function boxJoint(p: Pair, params: BoxJointParams, v: Values): Built {
  const { a, b } = p;
  const corner = `a box joint joins two boards' ends at a square corner, with B's length along A's thickness and B's thickness along A's length`;
  if (p.map[0].axis !== 2 || p.map[2].axis !== 0) {
    refuse(`${b.id} does not stand on the end of ${a.id}: ${corner}`, ['params', 'b']);
  }
  if (AXES.some((i) => p.hi[i] - p.lo[i] <= LINEAR_TOL)) {
    refuse(`${b.id} does not overlap ${a.id}'s end: ${corner}, drawn through each other`, [
      'params',
      'b',
    ]);
  }
  const flush = (x: number, y: number) => Math.abs(x - y) <= LINEAR_TOL;
  // A's end lies at B's outside face, and B lies within A's length.
  const endLow = flush(p.bLo[0], 0) && p.bHi[0] < a.size[0] - LINEAR_TOL;
  const endHigh = flush(p.bHi[0], a.size[0]) && p.bLo[0] > LINEAR_TOL;
  if (!endLow && !endHigh) {
    refuse(`${b.id}'s outside face must be flush with the end of ${a.id}: ${corner}`, [
      'params',
      'b',
    ]);
  }
  // B's end lies at A's outside face, and B runs on past A's other face.
  const bEnd =
    (flush(p.bLo[2], 0) && p.bHi[2] > a.size[2] + LINEAR_TOL) ||
    (flush(p.bHi[2], a.size[2]) && p.bLo[2] < -LINEAR_TOL);
  if (!bEnd) {
    refuse(`${b.id}'s end must be flush with the outside face of ${a.id}: ${corner}`, [
      'params',
      'b',
    ]);
  }

  const lo = p.lo[1];
  const width = p.hi[1] - lo;
  v.oneOf('count', 'finger');
  const count = v.count('count', 2, MAX_FINGERS);
  const finger = v.positive('finger', Math.min(a.size[2], b.size[2]));
  const n = count ?? Math.max(2, Math.round(width / finger));
  if (n > MAX_FINGERS) {
    refuse(`${mm(finger)} fingers across ${mm(width)} make ${n}, more than ${MAX_FINGERS}`, [
      'expressions',
      'finger',
    ]);
  }
  const w = width / n;
  const c = v.nonNegative('clearance', 0);
  if (!(c < w))
    refuse(`the clearance must be less than the ${mm(w)} finger width`, [
      'expressions',
      'clearance',
    ]);

  const slots = { a: [] as ReturnType<typeof boxTool>[], b: [] as ReturnType<typeof boxTool>[] };
  for (let i = 0; i < n; i++) {
    const owner = i % 2 === 0 ? params.start : params.start === 'a' ? 'b' : 'a';
    const other = owner === 'a' ? 'b' : 'a';
    const s0 = Math.max(lo, lo + i * w - c / 2);
    const s1 = Math.min(lo + width, lo + (i + 1) * w + c / 2);
    const from: V3 = [p.lo[0], s0, p.lo[2]];
    const to: V3 = [p.hi[0], s1, p.hi[2]];
    const body = other === 'a' ? a.id : b.id;
    slots[other].push(boxTool(a, `${other}-slot-${i + 1}`, body, from, to));
  }
  return {
    items: [...slots.a, ...slots.b],
    hardware: [],
    warnings: [],
    details: { fingers: n, finger: w },
  };
}
