// The member data shape (M6 plan, Part 2, decision 4) as the spike uses it, and the rule that
// decides which members share one mesh.

import { planeToLocal, type Placement, type Plane, type Vec3 } from './geom.ts';

export type Role =
  | 'bottom-plate'
  | 'top-plate'
  | 'stud'
  | 'corner-stud'
  | 'tee-stud'
  | 'king'
  | 'jack'
  | 'header'
  | 'sill'
  | 'cripple'
  | 'gable-stud'
  | 'skid'
  | 'sill-plate'
  | 'rim'
  | 'joist'
  | 'beam'
  | 'blocking'
  | 'ceiling-joist'
  | 'rafter-tie'
  | 'common-rafter'
  | 'jack-rafter'
  | 'hip-rafter'
  | 'ridge';

/** Dressed lumber: `width` is the thin face (1-1/2" for 2x stock), `depth` the wide one. */
export interface Stock {
  name: string;
  width: number;
  depth: number;
}

/**
 * Material removed from a member, in the member's local frame.
 * - `plane`: the half-space `dot(n, p) >= k` (a plumb, seat, bevel or side cut).
 * - `notch`: the intersection of two such half-spaces (a birdsmouth: heel and seat).
 */
export type Cut = { kind: 'plane'; plane: Plane } | { kind: 'notch'; a: Plane; b: Plane };

export interface Member {
  /** Stable within its group: layout slot (`s12`), plate course and splice (`top1:2`), opening role. */
  id: string;
  role: Role;
  stock: Stock;
  /** Blank length along local x, before cuts. */
  length: number;
  placement: Placement;
  cuts: Cut[];
  /** The wall, floor or roof (feature) the member belongs to. */
  group: string;
}

/** Dressed sizes in inches (PS 20). */
export const STOCK = {
  '2x4': { name: '2x4', width: 1.5, depth: 3.5 },
  '2x6': { name: '2x6', width: 1.5, depth: 5.5 },
  '2x8': { name: '2x8', width: 1.5, depth: 7.25 },
  '2x10': { name: '2x10', width: 1.5, depth: 9.25 },
  '2x12': { name: '2x12', width: 1.5, depth: 11.25 },
  '4x6': { name: '4x6', width: 3.5, depth: 5.5 },
} satisfies Record<string, Stock>;

export const INCH = 25.4;

/** The world cut planes of a member, back from local (for checks and the B-rep path). */
export function worldPlane(p: Placement, local: Plane): Plane {
  const z: Vec3 = [
    p.x[1] * p.y[2] - p.x[2] * p.y[1],
    p.x[2] * p.y[0] - p.x[0] * p.y[2],
    p.x[0] * p.y[1] - p.x[1] * p.y[0],
  ];
  const n: Vec3 = [
    local.n[0] * p.x[0] + local.n[1] * p.y[0] + local.n[2] * z[0],
    local.n[0] * p.x[1] + local.n[1] * p.y[1] + local.n[2] * z[1],
    local.n[0] * p.x[2] + local.n[1] * p.y[2] + local.n[2] * z[2],
  ];
  return { n, k: local.k + n[0] * p.origin[0] + n[1] * p.origin[1] + n[2] * p.origin[2] };
}

/** A world plane as a local cut of the member. */
export function localPlane(m: { placement: Placement }, world: Plane): Plane {
  return planeToLocal(m.placement, world);
}

const r = (v: number, digits: number) => {
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

const planeKey = (p: Plane) => `${r(p.n[0], 5)},${r(p.n[1], 5)},${r(p.n[2], 5)},${r(p.k, 3)}`;

/**
 * Members with equal keys have the same local geometry, so they share one mesh: same stock, same
 * blank length (to 0.001 of the unit) and the same cuts in their own frame. Placement is not part
 * of the key; it becomes the instance transform.
 */
export function shapeKey(m: Pick<Member, 'stock' | 'length' | 'cuts'>): string {
  const cuts = m.cuts
    .map((c) =>
      c.kind === 'plane' ? `p${planeKey(c.plane)}` : `n${planeKey(c.a)};${planeKey(c.b)}`,
    )
    .sort()
    .join('|');
  return `${m.stock.name}:${r(m.length, 3)}:${cuts}`;
}

/** The same members in millimetres (the kernel's and the app's unit). */
export function toMillimetres(members: readonly Member[]): Member[] {
  const s = (v: Vec3): Vec3 => [v[0] * INCH, v[1] * INCH, v[2] * INCH];
  const plane = (p: Plane): Plane => ({ n: p.n, k: p.k * INCH });
  return members.map((m) => ({
    ...m,
    stock: { name: m.stock.name, width: m.stock.width * INCH, depth: m.stock.depth * INCH },
    length: m.length * INCH,
    placement: { origin: s(m.placement.origin), x: m.placement.x, y: m.placement.y },
    cuts: m.cuts.map((c) =>
      c.kind === 'plane'
        ? { kind: 'plane', plane: plane(c.plane) }
        : { kind: 'notch', a: plane(c.a), b: plane(c.b) },
    ),
  }));
}

/** Members per role, sorted by role name. */
export function countByRole(members: readonly Member[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) out[m.role] = (out[m.role] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
