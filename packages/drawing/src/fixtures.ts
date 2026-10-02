// Fixture data in the shape the kernel's `project` op returns (T4.4b), so the package is tested
// without the kernel: the M1 bracket's front, top and right views, written out by hand from the
// views the T4.4a spike checked edge by edge against HLR (spikes/hlr/src/expected.test.ts),
// including the hidden edges HLR also returns under visible ones.
//
// The bracket, t = 6: an L in XZ (foot 50 x 6, upright 6 x 40), 30 wide in Y (-15 to 15), a
// fillet R 4 in the inside corner (centre X 10, Z 10), two M4 counterbored holes at X = 25 and
// 40 (4.5 through, counterbore 8 x 4.4 from the top, so its floor is at Z = 1.6). Third angle
// views of a Z-up model: front (x = X, y = Z), top (x = X, y = Y), right (x = Y, y = Z).

import type { Curve2, Vec2 } from './geometry';
import type { EdgeClass, ViewEdge } from './hidden';

const HOLE_D = 4.5;
const CB_R = 4;
const FLOOR = 6 - 4.4;

const line = (a: Vec2, b: Vec2): Curve2 => ({ kind: 'line', a, b });
const circle = (center: Vec2, radius: number): Curve2 => ({
  kind: 'arc',
  center,
  radius,
  start: 0,
  end: 2 * Math.PI,
});
const edge = (curve: Curve2, visible: boolean, cls: EdgeClass = 'sharp'): ViewEdge => ({
  item: 0,
  cls,
  visible,
  curve,
});

/** The five hidden lines of a counterbored hole seen across, centred at `c` along x. */
function holeAcross(c: number): ViewEdge[] {
  const r = HOLE_D / 2;
  return [
    line([c - r, 0], [c - r, FLOOR]),
    line([c + r, 0], [c + r, FLOOR]),
    line([c - CB_R, FLOOR], [c - CB_R, 6]),
    line([c + CB_R, FLOOR], [c + CB_R, 6]),
    line([c - CB_R, FLOOR], [c + CB_R, FLOOR]),
  ].map((l) => edge(l, false, l.kind === 'line' && l.a[0] === l.b[0] ? 'outline' : 'sharp'));
}

/** The hole's circles seen edge on that lie under the outline: at Z = 0 and Z = 6. */
function holeUnderOutline(c: number): ViewEdge[] {
  const r = HOLE_D / 2;
  return [
    edge(line([c - r, 0], [c + r, 0]), false),
    edge(line([c - CB_R, 6], [c + CB_R, 6]), false),
  ];
}

export const BRACKET_FRONT: readonly ViewEdge[] = [
  edge(line([0, 0], [50, 0]), true),
  edge(line([50, 0], [50, 6]), true),
  edge(line([50, 6], [10, 6]), true),
  edge({ kind: 'arc', center: [10, 10], radius: 4, start: Math.PI, end: 1.5 * Math.PI }, true),
  edge(line([6, 10], [6, 40]), true),
  edge(line([6, 40], [0, 40]), true),
  edge(line([0, 40], [0, 0]), true),
  ...holeAcross(25),
  ...holeAcross(40),
  ...holeUnderOutline(25),
  ...holeUnderOutline(40),
];

export const BRACKET_TOP: readonly ViewEdge[] = [
  edge(line([0, -15], [50, -15]), true),
  edge(line([50, -15], [50, 15]), true),
  edge(line([50, 15], [0, 15]), true),
  edge(line([0, 15], [0, -15]), true),
  edge(line([6, -15], [6, 15]), true),
  edge(line([10, -15], [10, 15]), true, 'smooth'),
  ...[25, 40].flatMap((c) => [
    edge(circle([c, 0], CB_R), true),
    edge(circle([c, 0], HOLE_D / 2), true),
    // The through hole's bottom circle, under its top circle at the floor.
    edge(circle([c, 0], HOLE_D / 2), false),
  ]),
  // The foot's bottom edges along X, under the top outline.
  edge(line([0, -15], [50, -15]), false),
  edge(line([0, 15], [50, 15]), false),
];

export const BRACKET_RIGHT: readonly ViewEdge[] = [
  edge(line([-15, 0], [15, 0]), true),
  edge(line([15, 0], [15, 40]), true),
  edge(line([15, 40], [-15, 40]), true),
  edge(line([-15, 40], [-15, 0]), true),
  edge(line([-15, 6], [15, 6]), true),
  edge(line([-15, 10], [15, 10]), true, 'smooth'),
  // Both holes project onto the same lines.
  ...holeAcross(0),
  ...holeAcross(0),
  ...holeUnderOutline(0),
];
