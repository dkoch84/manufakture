// Mortise and tenon: a tenon on B's end, a mortise in A to match. B is drawn into A by the tenon's
// length (a board's blank includes its tenons, as the cut list reads it), so the joint cuts B's
// cheeks and shoulders where B lies inside A, two to four boxes, and the mortise from A: the
// tenon's section plus the clearance, as deep as the tenon plus the clearance (or through A).
//
// Rounded ends (a mortise cut with a router) are a box and two half-round ends, cylinders along
// the mortise's depth; the tenon's edges are rounded to match: its shoulders are cut back by half
// its thickness and two cylinders are added in their place.

import { refuse, type Built, type Values } from './common';
import {
  LINEAR_TOL,
  boxTool,
  cylinderTool,
  entryOf,
  fromFace,
  mm,
  solid,
  unitA,
  type AxisIndex,
  type Pair,
  type V3,
} from './geometry';
import type { TenonParams } from './params';

export function tenonJoint(p: Pair, params: TenonParams, v: Values): Built {
  const { a, b } = p;
  const found = entryOf(p, 'a mortise and tenon');
  if (!found.ok) refuse(found.message, ['params', 'b']);
  const { axis: e, side, depth, through } = found.entry;
  if (p.map[0].axis !== e) {
    refuse(
      `${b.id} enters ${a.id} with its ${p.map[1].axis === e ? 'edge' : 'face'}: a tenon is cut on ${b.id}'s end, so ${b.id}'s length must run into ${a.id}`,
      ['params', 'b'],
    );
  }
  const kt = p.map[2].axis;
  const kw = p.map[1].axis;
  const bt = b.size[2];
  const bw = b.size[1];
  const t = v.positive('thickness', bt / 3);
  const w = v.positive('width', bw - (2 * bt) / 3);
  if (!(w > 0))
    refuse(`${b.id} is too narrow for the default tenon width: give a width`, [
      'expressions',
      'width',
    ]);
  const offset = v.any('offset', 0);
  const c = v.nonNegative('clearance', 0);
  const rounded = params.ends === 'rounded';
  if (rounded && !(w > t + LINEAR_TOL)) {
    refuse('a tenon with rounded ends must be wider than it is thick', ['expressions', 'width']);
  }

  // The tenon's section in A, centred on B's (moved by the offset along B's thickness axis).
  const mid = (i: AxisIndex) => (p.bLo[i] + p.bHi[i]) / 2;
  const ct = mid(kt) + p.map[2].sign * offset;
  const cw = mid(kw);
  const tt: [number, number] = [ct - t / 2, ct + t / 2];
  const tw: [number, number] = [cw - w / 2, cw + w / 2];
  if (tt[0] < p.bLo[kt] - LINEAR_TOL || tt[1] > p.bHi[kt] + LINEAR_TOL) {
    refuse(
      `a ${mm(t)} tenon${offset === 0 ? '' : ` offset ${mm(offset)}`} does not fit in ${b.id}'s ${mm(bt)} thickness`,
      ['expressions', v.has('offset') ? 'offset' : 'thickness'],
    );
  }
  if (tw[0] < p.bLo[kw] - LINEAR_TOL || tw[1] > p.bHi[kw] + LINEAR_TOL) {
    refuse(`a ${mm(w)} wide tenon does not fit in ${b.id}'s ${mm(bw)} width`, [
      'expressions',
      'width',
    ]);
  }
  const mt: [number, number] = [tt[0] - c / 2, tt[1] + c / 2];
  const mw: [number, number] = [tw[0] - c / 2, tw[1] + c / 2];
  for (const [k, r] of [
    [kt, mt],
    [kw, mw],
  ] as const) {
    if (r[0] < -LINEAR_TOL || r[1] > a.size[k] + LINEAR_TOL) {
      refuse(`the mortise breaks out of the side of ${a.id}: move the tenon or make it smaller`, [
        'params',
        'b',
      ]);
    }
  }
  const mortiseDepth = through ? a.size[e] : Math.min(depth + c, a.size[e]);
  const me = fromFace(p, found.entry, mortiseDepth);
  const face = side === 1 ? a.size[e] : 0;
  const inward = unitA(e, side === 1 ? -1 : 1);

  const box = (re: readonly number[], rt: readonly number[], rw: readonly number[]) => {
    const lo: V3 = [0, 0, 0];
    const hi: V3 = [0, 0, 0];
    [lo[e], hi[e]] = [re[0]!, re[1]!];
    [lo[kt], hi[kt]] = [rt[0]!, rt[1]!];
    [lo[kw], hi[kw]] = [rw[0]!, rw[1]!];
    return { lo, hi };
  };
  /** A point on A's entry face at a section position. */
  const onFace = (st: number, sw: number) => {
    const o: V3 = [0, 0, 0];
    o[e] = face;
    o[kt] = st;
    o[kw] = sw;
    return o;
  };

  const items = [];
  // The mortise, in A.
  const rm = (t + c) / 2;
  const mBox = box(me, mt, rounded ? [mw[0] + rm, mw[1] - rm] : mw);
  items.push(boxTool(a, 'mortise', a.id, mBox.lo, mBox.hi));
  if (rounded) {
    items.push(
      cylinderTool(a, 'mortise-end-0', a.id, onFace(ct, mw[0] + rm), inward, rm, mortiseDepth),
    );
    items.push(
      cylinderTool(a, 'mortise-end-1', a.id, onFace(ct, mw[1] - rm), inward, rm, mortiseDepth),
    );
  }

  // The tenon, on B: everything of B inside A but the tenon's section.
  const re: [number, number] = [p.lo[e], p.hi[e]];
  const ot: [number, number] = [p.lo[kt], p.hi[kt]];
  const ow: [number, number] = [p.lo[kw], p.hi[kw]];
  const rt = rounded ? t / 2 : 0;
  const waste = [
    { id: 'cheek-0', ...box(re, [ot[0], tt[0]], ow) },
    { id: 'cheek-1', ...box(re, [tt[1], ot[1]], ow) },
    { id: 'shoulder-0', ...box(re, tt, [ow[0], tw[0] + rt]) },
    { id: 'shoulder-1', ...box(re, tt, [tw[1] - rt, ow[1]]) },
  ];
  for (const piece of waste) {
    if (solid(piece.lo, piece.hi)) items.push(boxTool(a, piece.id, b.id, piece.lo, piece.hi));
  }
  if (rounded) {
    for (const [id, sw] of [
      ['round-0', tw[0] + rt],
      ['round-1', tw[1] - rt],
    ] as const) {
      items.push(cylinderTool(a, id, b.id, onFace(ct, sw), inward, rt, depth, { mode: 'add' }));
    }
  }
  return {
    items,
    hardware: [],
    warnings: [],
    details: { length: depth, thickness: t, width: w, mortiseDepth },
  };
}
