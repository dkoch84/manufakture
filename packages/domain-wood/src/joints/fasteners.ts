// Joints held by hardware, between boards that touch without overlapping: dowels (a row of holes
// into both boards) and pocket screws (angled stepped holes in B). Each reports its hardware for
// the bill of materials; neither models the dowel or the screw itself.

import { refuse, type Built, type JointWarning, type Values } from './common';
import {
  LINEAR_TOL,
  contactOf,
  cylinderTool,
  mm,
  rowOf,
  thirdAxis,
  unitA,
  type AxisIndex,
  type Pair,
  type V3,
} from './geometry';
import type { DowelParams, PocketParams } from './params';

const IN = 25.4;
/** The most holes in one row. */
export const MAX_HOLES = 200;

// Dowels -----------------------------------------------------------------------------------------

/** Default dowel diameter, mm (a common metric dowel; 3/8" is the usual inch one). */
export const DEFAULT_DOWEL = 8;

/**
 * A row of dowel holes across the contact of two touching boards, along its longer side: into A
 * by `depthA`, into B by `depthB`, `edge` in from each end of the row, `count` of them or as many
 * as fit at `spacing`, on the contact's centre line moved by `offset`. The offset runs along the
 * A axis that is neither the row's axis nor the axis through the contact (the contact's shorter
 * side), positive toward A's high end of it; that axis is reported as `details.offsetAxis` (0
 * length, 1 width, 2 thickness). Defaults: 8 mm dowels, 1.5 diameters into A and 2.5 into B but at most two thirds of each
 * board's depth there, two diameters from each end, and spread evenly from end to end at most 12
 * diameters apart (at least two).
 */
export function dowelJoint(p: Pair, _params: DowelParams, v: Values): Built {
  const { a, b } = p;
  const found = contactOf(p, 'a dowel joint');
  if (!found.ok) {
    refuse(found.message, ['params', 'b']);
  }
  const { axis: e, aSide, at } = found.contact;
  const [q1, q2] = ([0, 1, 2] as AxisIndex[]).filter((i) => i !== e) as [AxisIndex, AxisIndex];
  const extent = (i: AxisIndex) => p.hi[i] - p.lo[i];
  const r = extent(q1) >= extent(q2) - LINEAR_TOL ? q1 : q2;
  const x = thirdAxis(e, r);

  const d = v.positive('diameter', DEFAULT_DOWEL);
  const aDepth = a.size[e];
  const bDepth = p.bHi[e] - p.bLo[e];
  const depthA = v.positive('depthA', Math.min(1.5 * d, (2 / 3) * aDepth));
  const depthB = v.positive('depthB', Math.min(2.5 * d, (2 / 3) * bDepth));
  if (!(depthA < aDepth - LINEAR_TOL)) {
    refuse(`a ${mm(depthA)} hole comes out through ${a.id}, ${mm(aDepth)} deep there`, [
      'expressions',
      'depthA',
    ]);
  }
  if (!(depthB < bDepth - LINEAR_TOL)) {
    refuse(`a ${mm(depthB)} hole comes out through ${b.id}, ${mm(bDepth)} deep there`, [
      'expressions',
      'depthB',
    ]);
  }
  v.oneOf('count', 'spacing');
  const count = v.count('count', 1, MAX_HOLES);
  const spacing = v.positive('spacing');
  const edge = v.nonNegative('edge', 2 * d);
  const row = rowOf(p.lo[r], p.hi[r], edge, {
    ...(count === undefined ? {} : { count }),
    ...(spacing === undefined ? {} : { spacing }),
    defaultSpacing: 12 * d,
    min: 2,
  });
  if (!row.ok) {
    refuse(`the dowels do not fit: ${row.message}`, [
      'expressions',
      v.has('count') ? 'count' : 'edge',
    ]);
  }
  if (row.at.length > MAX_HOLES) {
    refuse(`more than ${MAX_HOLES} dowels in one row`, ['expressions', 'spacing']);
  }
  if (row.at[0]! - d / 2 < p.lo[r] - LINEAR_TOL) {
    refuse(
      `the end dowels break out of the joint: the edge distance must be at least half the diameter`,
      ['expressions', 'edge'],
    );
  }
  const offset = v.any('offset', 0);
  const cx = (p.lo[x] + p.hi[x]) / 2 + offset;
  if (cx - d / 2 < p.lo[x] - LINEAR_TOL || cx + d / 2 > p.hi[x] + LINEAR_TOL) {
    refuse(
      `${mm(d)} dowels${offset === 0 ? '' : ` offset ${mm(offset)}`} do not fit across the joint, ${mm(extent(x))} wide`,
      ['expressions', v.has('offset') ? 'offset' : 'diameter'],
    );
  }

  const into = unitA(e, aSide);
  const out = unitA(e, aSide === 1 ? -1 : 1);
  const centres = row.at.map((s) => {
    const o: V3 = [0, 0, 0];
    o[e] = at;
    o[r] = s;
    o[x] = cx;
    return o;
  });
  const items = [
    ...centres.map((o, i) => cylinderTool(a, `a-hole-${i + 1}`, a.id, o, into, d / 2, depthA)),
    ...centres.map((o, i) => cylinderTool(a, `b-hole-${i + 1}`, b.id, o, out, d / 2, depthB)),
  ];
  const warnings: JointWarning[] = [];
  if (d > extent(x) / 2 + LINEAR_TOL) {
    warnings.push({
      code: 'rule-of-thumb',
      message: `Rule of thumb, not engineering: a ${mm(d)} dowel is more than half the ${mm(extent(x))} it is set in, which weakens the boards`,
    });
  }
  return {
    items,
    hardware: [{ item: 'dowel', diameter: d, length: depthA + depthB, quantity: centres.length }],
    warnings,
    details: { count: centres.length, diameter: d, depthA, depthB, offsetAxis: x },
  };
}

// Pocket screws -----------------------------------------------------------------------------------

/**
 * The standard pocket-hole jig (Kreg's): a 3/8" stepped bit with an 11/64" pilot, drilling at 15
 * degrees, set so the screw comes out at the middle of the board's thickness. Sources: McFeely's
 * pocket hole joinery page (https://www.mcfeelys.com/pocket_hole_joinery-1: "a 3/8 inch
 * counterbore bit with an 11/64 inch pilot to drill a 15 degree angle") and the Kreg Jig R3
 * owner's manual (https://www.kregtool.com/ ... /manuals/R3_NA.pdf: the 3/8" (9.5 mm) stepped
 * drill bit; the sliders set "so the screw exits at the center of the workpiece"; the screw
 * length chart below).
 */
export const POCKET_JIG = {
  angle: (15 * Math.PI) / 180,
  pocketDiameter: (3 / 8) * IN,
  pilotDiameter: (11 / 64) * IN,
} as const;

/**
 * Kreg's screw length by material thickness (R3 manual, "Screw Length Selection"), inches. The
 * 1-1/2" row (2-1/2" screws) is cut off in the copy checked; it matches Kreg's other charts.
 */
export const POCKET_SCREWS: readonly (readonly [thickness: number, screw: number])[] = [
  [1 / 2, 1],
  [5 / 8, 1],
  [3 / 4, 1.25],
  [7 / 8, 1.5],
  [1, 1.5],
  [1.125, 1.5],
  [1.25, 2],
  [1.375, 2],
  [1.5, 2.5],
];

/** The chart's screw length (mm) for a board thickness (mm), when the thickness is on the chart. */
export function pocketScrew(thickness: number): number | undefined {
  let best: readonly [number, number] | undefined;
  for (const row of POCKET_SCREWS) {
    const off = Math.abs(row[0] * IN - thickness);
    if (off <= IN / 16 && (best === undefined || off < Math.abs(best[0] * IN - thickness))) {
      best = row;
    }
  }
  return best === undefined ? undefined : best[1] * IN;
}

/** The thinnest board a pocket hole is drilled in, mm (1/2" stock, less a sixteenth). */
const MIN_POCKET_THICKNESS = IN / 2 - IN / 16;

/**
 * Pocket screws through B's end or edge into A's face: a row of angled stepped holes in B, each
 * along a line through the middle of B's thickness where it meets A, tilted by the jig angle
 * toward the pocket's face of B (`face`: the low or high end of B's thickness axis). The pocket
 * (the wide step) ends where half the screw's length is left before the contact, an approximation
 * of the jig's depth setting: the screw's other half goes into A. Defaults: the jig's angle and
 * bit, the chart's screw for B's thickness, 3/4" from each end of the row, spread evenly at most
 * 6" apart.
 */
export function pocketJoint(p: Pair, params: PocketParams, v: Values): Built {
  const { a, b } = p;
  const found = contactOf(p, 'a pocket screw joint');
  if (!found.ok) {
    refuse(found.message, ['params', 'b']);
  }
  const { axis: e, aSide, at } = found.contact;
  const kt = p.map[2].axis;
  if (kt === e) {
    refuse(
      `${b.id} lies with its face against ${a.id}: pocket screws go through ${b.id}'s end or edge`,
      ['params', 'b'],
    );
  }
  const r = thirdAxis(e, kt);
  const t = b.size[2];
  if (t < MIN_POCKET_THICKNESS) {
    refuse(`${b.id} is ${mm(t)} thick, too thin for a pocket hole (1/2" and up)`, ['params', 'b']);
  }
  const angle = v.positive('angle', POCKET_JIG.angle);
  if (!(angle >= Math.PI / 36 && angle <= Math.PI / 6)) {
    refuse('the pocket angle must be from 5° to 30°', ['expressions', 'angle']);
  }
  const screw = v.positive('screw') ?? pocketScrew(t);
  if (screw === undefined) {
    refuse(
      `${b.id} is ${mm(t)} thick, off the jig's screw chart (1/2" to 1-1/2"): give the screw length`,
      ['expressions', 'screw'],
    );
  }
  const ct = (p.bLo[kt] + p.bHi[kt]) / 2;
  if (ct < p.lo[kt] - LINEAR_TOL || ct > p.hi[kt] + LINEAR_TOL) {
    refuse(`the middle of ${b.id}'s thickness does not meet ${a.id}: the screws would miss it`, [
      'params',
      'b',
    ]);
  }
  const rs = POCKET_JIG.pocketDiameter / 2;
  const rp = POCKET_JIG.pilotDiameter / 2;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const h = t / 2;
  // Back from the exit point along the screw's axis: to where the axis leaves B's face, and on
  // until the whole pocket mouth is outside B, plus a millimetre. Forward: past B's end.
  const back = h / sin + rs / Math.tan(angle) + 1;
  const forward = rp * Math.tan(angle) + 1;
  const pilot = screw / 2;
  if (!(pilot < back - LINEAR_TOL)) {
    refuse(`a ${mm(screw)} screw is too long for ${b.id}'s ${mm(t)} thickness`, [
      'expressions',
      'screw',
    ]);
  }
  const bDepth = p.bHi[e] - p.bLo[e];
  if ((h / sin) * cos + rs > bDepth) {
    refuse(`${b.id} is too short (${mm(bDepth)}) for a pocket hole at this angle`, ['params', 'b']);
  }

  v.oneOf('count', 'spacing');
  const count = v.count('count', 1, MAX_HOLES);
  const spacing = v.positive('spacing');
  const edge = v.nonNegative('edge', (3 / 4) * IN);
  const row = rowOf(p.lo[r], p.hi[r], edge, {
    ...(count === undefined ? {} : { count }),
    ...(spacing === undefined ? {} : { spacing }),
    defaultSpacing: 6 * IN,
    min: 1,
  });
  if (!row.ok) {
    refuse(`the screws do not fit: ${row.message}`, [
      'expressions',
      v.has('count') ? 'count' : 'edge',
    ]);
  }
  if (row.at.length > MAX_HOLES) {
    refuse(`more than ${MAX_HOLES} screws in one row`, ['expressions', 'spacing']);
  }
  if (row.at[0]! - rs < p.bLo[r] - LINEAR_TOL || row.at.at(-1)! + rs > p.bHi[r] + LINEAR_TOL) {
    refuse(`the end pockets break out of ${b.id}'s side: move them in from the edge`, [
      'expressions',
      'edge',
    ]);
  }

  // The pocket face's outward normal and the direction into A, in A's coordinates.
  const outSign = ((params.face === 'high' ? 1 : -1) * p.map[2].sign) as 1 | -1;
  const into = unitA(e, aSide);
  const outward = unitA(kt, outSign);
  const u: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) u[i] = cos * into[i]! - sin * outward[i]!;
  // The screw: its head on the pocket's floor, `pilot` before the exit, so its tip lies the
  // other half of its length past the exit, in A. Warn when it comes out of A.
  const reach = screw - pilot;
  const tip: V3 = [0, 0, 0];
  tip[e] = at + u[e]! * reach;
  tip[kt] = ct + u[kt]! * reach;
  const warnings: JointWarning[] = [];
  if (tip[e] <= LINEAR_TOL || tip[e] >= a.size[e] - LINEAR_TOL) {
    warnings.push({
      code: 'breaks-out',
      message: `the ${mm(screw)} screws' tips come out of ${a.id}'s far face: ${a.id} is ${mm(a.size[e])} there and they reach ${mm(Math.abs(tip[e] - at))} into it; use shorter screws`,
    });
  }
  if (tip[kt] <= LINEAR_TOL || tip[kt] >= a.size[kt] - LINEAR_TOL) {
    warnings.push({
      code: 'breaks-out',
      message: `the ${mm(screw)} screws' tips come out of the side of ${a.id}: move ${b.id} in, turn the pockets to the other face or use shorter screws`,
    });
  }

  const items = row.at.map((s, i) => {
    const exit: V3 = [0, 0, 0];
    exit[e] = at;
    exit[kt] = ct;
    exit[r] = s;
    const start: V3 = [exit[0] - u[0] * back, exit[1] - u[1] * back, exit[2] - u[2] * back];
    return cylinderTool(a, `pocket-${i + 1}`, b.id, start, u, rp, back + forward, {
      step: { radius: rs, length: back - pilot },
    });
  });
  return {
    items,
    hardware: [{ item: 'pocket-screw', length: screw, quantity: items.length }],
    warnings,
    details: { count: items.length, angle, screw },
  };
}
