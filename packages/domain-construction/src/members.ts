// The member data shape (ADR 0015 decision 4, from the T6.5a spike): a framing member is data,
// not a body. It has a stock, a blank length, a placement and at most a few planar
// cuts in its own frame. Lengths are millimetres (ADR 0005).

import { toWorld, type Placement, type Plane, type Vec3 } from './geom';

/**
 * What a member does. Wall roles are T6.2a's; the floor and roof generators (T6.2b, T6.2c) add
 * theirs to this union.
 */
export type Role =
  | 'bottom-plate'
  | 'top-plate'
  | 'stud'
  | 'king'
  | 'jack'
  | 'header'
  | 'header-spacer'
  | 'rough-sill'
  | 'cripple'
  | 'blocking'
  | 'corner'
  | 'backing'
  // Floors (T6.2b); floor blocking uses `blocking`.
  | 'joist'
  | 'rim'
  | 'skid'
  // Roofs (T6.2c); gable studs belong to the roof.
  | 'common-rafter'
  | 'jack-rafter'
  | 'hip-rafter'
  | 'fly-rafter'
  | 'ridge'
  | 'ceiling-joist'
  | 'rafter-tie'
  | 'gable-stud'
  | 'sub-fascia'
  | 'fascia';

/**
 * The most members one generator call may make: regen's `MAX_GROUP_MEMBERS` (one wall, floor or
 * roof is one member group). This package may not load regen at run time (ADR 0015 decision 1),
 * so the number is repeated here and `members.test.ts` pins the two equal. The generators count
 * against it as they build and refuse with a `FramingInputError` the moment it is passed, so a
 * hostile document fails fast instead of building millions of members for regen to throw away.
 */
export const MEMBER_BUDGET = 50_000;

/**
 * The stock a member is cut from: a catalog entry (with overrides), dressed sizes in mm. `width`
 * is the thin face (38.1 for 2x stock), `depth` the wide one. `id` is the stock catalog id
 * (`us-2x4`), so the takeoff can price it; `name` is the nominal name (`2x4`).
 */
export interface StockRef {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly depth: number;
}

/**
 * Material removed from a member, in the member's local frame (T6.5a: so equal members share a
 * mesh wherever they are placed).
 * - `plane`: the half-space `dot(n, p) >= k` (plumb, seat, bevel or side cut).
 * - `notch`: the intersection of two half-spaces (a birdsmouth: heel and seat).
 */
export type Cut =
  | { readonly kind: 'plane'; readonly n: Vec3; readonly k: number }
  | { readonly kind: 'notch'; readonly a: Plane; readonly b: Plane };

export interface Member {
  /**
   * Local to its owner, stable by role and layout (ADR 0015 decision 6): `s12`, `top1:2`,
   * `king-l`. See `member-ids.ts` for every form. Fragile by design: changing a wall's spacing
   * renumbers its slots (an override that records its member's position, `at`, follows it,
   * #1215). The full id is `<owner>:<id>` (`memberFullId`).
   */
  readonly id: string;
  /** The feature that owns the member: a wall, an opening, a floor or a roof. */
  readonly owner: string;
  readonly role: Role;
  readonly stock: StockRef;
  /** The blank length along local x, mm: what is cut from stock, before any cut. */
  readonly length: number;
  readonly placement: Placement;
  /** Cuts in the member's own frame. Wall members have none. */
  readonly cuts: readonly Cut[];
}

/** The eight corners of a member's blank, in world coordinates. */
export function memberCorners(m: Pick<Member, 'length' | 'stock' | 'placement'>): Vec3[] {
  const out: Vec3[] = [];
  for (const a of [0, m.length])
    for (const b of [0, m.stock.width])
      for (const c of [0, m.stock.depth]) out.push(toWorld(m.placement, [a, b, c]));
  return out;
}

const r = (v: number, digits: number) => {
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

const planeKey = (p: Plane) => `${r(p.n[0], 5)},${r(p.n[1], 5)},${r(p.n[2], 5)},${r(p.k, 3)}`;

/**
 * Members with equal keys have the same local geometry, so they share one mesh (T6.5a, "Mesh
 * sharing rules"): the same stock, the same blank length to 0.001 mm and the same cuts in their
 * own frame. Placement is never part of the key; it becomes the instance transform.
 */
export function shapeKey(m: Pick<Member, 'stock' | 'length' | 'cuts'>): string {
  const cuts = m.cuts
    .map((c) => (c.kind === 'plane' ? `p${planeKey(c)}` : `n${planeKey(c.a)};${planeKey(c.b)}`))
    .sort()
    .join('|');
  return `${m.stock.id}:${r(m.stock.width, 3)}x${r(m.stock.depth, 3)}:${r(m.length, 3)}:${cuts}`;
}

/** Members per role, sorted by role name. */
export function countByRole(members: readonly Member[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) out[m.role] = (out[m.role] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
