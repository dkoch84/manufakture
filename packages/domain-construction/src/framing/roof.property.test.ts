// Property tests on random roofs (seeded, so a failure reproduces): no two members overlap, cuts
// included; every rafter's seat lies on the plate line; every common meets the ridge board within
// tolerance; members stay inside the roof's envelope; ids are unique and parse; framing is
// deterministic.
//
// Members with cuts are not boxes, so overlap is checked on their real shapes: each member is the
// blank less its plane cuts (a convex solid) less its birdsmouth notch, which leaves the union of
// two convex pieces (outside the heel, or above the seat). Two members overlap when any of their
// pieces do, by the separating axis test on the pieces' vertices.

import { describe, expect, it } from 'vitest';
import { cross, dot, toWorld, zAxis, type Plane, type Vec3 } from '../geom';
import { memberFullId } from '../member-ids';
import type { Member } from '../members';
import { S2X10, S2X4, S2X6, S2X8, inch, seededRandom } from '../test-helpers';
import {
  formatRoofMemberId,
  frameRoof,
  parseRoofMemberId,
  type FrameRoofInput,
  type RoofTies,
} from './roof';

const TOL = 0.01; // mm

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A random roof; sizes on a 1/8" grid. */
function randomRoof(seed: number): FrameRoofInput {
  const random = seededRandom(seed);
  const eighth = (lo: number, hi: number) => inch(Math.round((lo + random() * (hi - lo)) * 8) / 8);
  const kind = random() < 0.5 ? 'gable' : 'hip';
  const rafter = pick(random, [S2X4, S2X6, S2X8]);
  const ridge = pick(random, [S2X6, S2X8, S2X10]);
  const width = eighth(72, 240);
  const length = kind === 'hip' ? width + (random() < 0.15 ? 0 : eighth(0, 200)) : eighth(48, 360);
  const wall = pick(random, [inch(3.5), inch(5.5)]);
  const tieStock = pick(random, [S2X4, S2X6]);
  const ties: RoofTies = pick(random, [
    { kind: 'none' },
    { kind: 'ceiling-joists', stock: tieStock, every: pick(random, [1, 2, 3]) },
    { kind: 'rafter-ties', stock: S2X4, every: pick(random, [1, 2]), height: eighth(0, 12) },
  ] as const);
  const plumb = random() < 0.75;
  return {
    roof: 'extension#4',
    kind,
    pitch: Math.atan(
      pick(random, [3, 4, 5, 6, 7, 8, 10, 12]) / 12 + (random() < 0.2 ? random() * 0.1 : 0),
    ),
    footprint: {
      origin: [eighth(-500, 500), eighth(-500, 500)],
      direction: random() * 2 * Math.PI,
      length,
      width,
      plate: eighth(0, 200),
      wallThickness: wall,
    },
    settings: {
      rafterStock: rafter,
      ridgeStock: ridge,
      ...(kind === 'hip' ? { hipStock: pick(random, [rafter, S2X8, S2X10]) } : {}),
      spacing: pick(random, [inch(12), inch(16), inch(19.2), inch(24)]),
      overhang: pick(random, [0, inch(6), inch(12), eighth(0, 24)]),
      rakeOverhang: random() < 0.4 ? eighth(2, 18) : 0,
      tail: plumb ? 'plumb' : 'square',
      ties,
      ...(kind === 'gable' && random() < 0.6
        ? {
            gableStuds: {
              stock: pick(random, [S2X4, S2X6]),
              spacing: pick(random, [inch(16), inch(24)]),
              origin: { e2: eighth(0, 24), e4: eighth(0, 24) },
            },
          }
        : {}),
      ...(plumb && random() < 0.5 ? { subFascia: S2X6 } : {}),
      ...(plumb && random() < 0.4 ? { fascia: pick(random, [S2X6, S2X8]) } : {}),
    },
  };
}

/**
 * Some random cases are refused on purpose (ties reaching the ridge, a 2x4 rafter on a 2x6 wall's
 * seat at a steep pitch); fall back to no ties and a 2x4 wall's seat for those.
 */
function frameable(seed: number): FrameRoofInput {
  const input = randomRoof(seed);
  try {
    frameRoof(input);
    return input;
  } catch {
    return {
      ...input,
      footprint: { ...input.footprint, wallThickness: inch(3.5) },
      settings: { ...input.settings, ties: { kind: 'none' } },
    };
  }
}

// Convex pieces -------------------------------------------------------------------------------

interface Piece {
  readonly vertices: Vec3[];
  readonly normals: Vec3[];
  readonly edges: Vec3[];
  readonly min: Vec3;
  readonly max: Vec3;
}

/** A member's kept solid as convex pieces in world coordinates. */
function pieces(m: Member): Piece[] {
  const { length: L } = m;
  const { width: w, depth: d } = m.stock;
  const box: Plane[] = [
    { n: [-1, 0, 0], k: 0 },
    { n: [1, 0, 0], k: L },
    { n: [0, -1, 0], k: 0 },
    { n: [0, 1, 0], k: w },
    { n: [0, 0, -1], k: 0 },
    { n: [0, 0, 1], k: d },
  ];
  // Kept: dot(n, p) <= k for the box; a plane cut removes dot(n, p) >= k, so keeps <= k too.
  const base = [...box];
  const notches: Array<[Plane, Plane]> = [];
  for (const c of m.cuts) {
    if (c.kind === 'plane') base.push({ n: c.n, k: c.k });
    else notches.push([c.a, c.b]);
  }
  const flip = (p: Plane): Plane => ({ n: [-p.n[0], -p.n[1], -p.n[2]], k: -p.k });
  let sets: Plane[][] = [base];
  for (const [a, b] of notches)
    sets = sets.flatMap((s) => [
      [...s, flip(a)],
      [...s, flip(b)],
    ]);
  return sets.map((s) => polytope(m, s)).filter((p): p is Piece => p !== undefined);
}

function polytope(m: Member, planes: Plane[]): Piece | undefined {
  const local: Vec3[] = [];
  const n = planes.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const p = solve(planes[i]!, planes[j]!, planes[k]!);
        if (!p) continue;
        if (planes.every((q) => dot(q.n, p) <= q.k + 1e-6)) local.push(p);
      }
  if (local.length < 4) return undefined;
  const z = zAxis(m.placement);
  const rot = (v: Vec3): Vec3 => [
    v[0] * m.placement.x[0] + v[1] * m.placement.y[0] + v[2] * z[0],
    v[0] * m.placement.x[1] + v[1] * m.placement.y[1] + v[2] * z[1],
    v[0] * m.placement.x[2] + v[1] * m.placement.y[2] + v[2] * z[2],
  ];
  const vertices = local.map((p) => toWorld(m.placement, p));
  const normals = planes.map((p) => rot(p.n));
  const edges: Vec3[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const on = local.filter(
        (p) =>
          Math.abs(dot(planes[i]!.n, p) - planes[i]!.k) < 1e-6 &&
          Math.abs(dot(planes[j]!.n, p) - planes[j]!.k) < 1e-6,
      );
      if (on.length >= 2) edges.push(rot(cross(planes[i]!.n, planes[j]!.n)));
    }
  const min: Vec3 = [0, 1, 2].map((a) =>
    Math.min(...vertices.map((v) => v[a]!)),
  ) as unknown as Vec3;
  const max: Vec3 = [0, 1, 2].map((a) =>
    Math.max(...vertices.map((v) => v[a]!)),
  ) as unknown as Vec3;
  return { vertices, normals, edges, min, max };
}

function solve(a: Plane, b: Plane, c: Plane): Vec3 | undefined {
  const det = dot(a.n, cross(b.n, c.n));
  if (Math.abs(det) < 1e-9) return undefined;
  const t1 = cross(b.n, c.n);
  const t2 = cross(c.n, a.n);
  const t3 = cross(a.n, b.n);
  return [0, 1, 2].map(
    (i) => (a.k * t1[i]! + b.k * t2[i]! + c.k * t3[i]!) / det,
  ) as unknown as Vec3;
}

/** How deep two convex pieces overlap: the least overlap over all separating axes (<= 0: apart). */
function overlapDepth(p: Piece, q: Piece): number {
  for (let a = 0; a < 3; a++)
    if (p.max[a]! <= q.min[a]! + TOL || q.max[a]! <= p.min[a]! + TOL) return 0;
  const axes: Vec3[] = [...p.normals, ...q.normals];
  for (const e of p.edges) for (const f of q.edges) axes.push(cross(e, f));
  let least = Infinity;
  for (const ax of axes) {
    const len = Math.hypot(ax[0], ax[1], ax[2]);
    if (len < 1e-9) continue;
    const u: Vec3 = [ax[0] / len, ax[1] / len, ax[2] / len];
    const pr = (vs: Vec3[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of vs) {
        const x = dot(u, v);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      return [lo, hi] as const;
    };
    const [a0, a1] = pr(p.vertices);
    const [b0, b1] = pr(q.vertices);
    const o = Math.min(a1 - b0, b1 - a0);
    if (o <= TOL) return 0;
    least = Math.min(least, o);
  }
  return least;
}

function overlaps(members: readonly Member[]): string[] {
  const ps = members.map(pieces);
  const out: string[] = [];
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const depth = Math.max(0, ...ps[i]!.flatMap((p) => ps[j]!.map((q) => overlapDepth(p, q))));
      if (depth > TOL) out.push(`${members[i]!.id} x ${members[j]!.id}: ${depth.toFixed(3)} mm`);
    }
  return out;
}

const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

describe('frameRoof properties', () => {
  it('the overlap check finds a moved copy, and the overlaps the cuts prevent', () => {
    const r = frameRoof(frameable(1));
    const m = r.members[0]!;
    const o = m.placement.origin;
    const moved = {
      ...m,
      id: 'copy',
      placement: { ...m.placement, origin: [o[0] + 5, o[1], o[2]] as Vec3 },
    };
    expect(overlaps([m, moved])).toHaveLength(1);
    // Without its cuts, a hip roof's common runs into the ridge board and a jack into its hip.
    const hip = frameRoof({
      roof: 'extension#4',
      kind: 'hip',
      pitch: Math.atan(6 / 12),
      footprint: {
        origin: [0, 0],
        length: inch(192),
        width: inch(144),
        plate: 0,
        wallThickness: inch(3.5),
      },
      settings: { rafterStock: S2X6, ridgeStock: S2X8, hipStock: S2X8 },
    });
    const byId = new Map(hip.members.map((x) => [x.id, x]));
    const uncut = (id: string) => ({ ...byId.get(id)!, cuts: [] });
    expect(overlaps([byId.get('ridge:1')!, byId.get('e1:c1')!])).toEqual([]);
    expect(overlaps([byId.get('ridge:1')!, uncut('e1:c1')])).toHaveLength(1);
    expect(overlaps([byId.get('hip1')!, byId.get('e1:ja1')!])).toEqual([]);
    expect(overlaps([byId.get('hip1')!, uncut('e1:ja1')])).toHaveLength(1);
  });

  it.each(SEEDS)('seed %i: no two members overlap', (seed) => {
    const r = frameRoof(frameable(seed));
    expect(r.members.length).toBeGreaterThan(0);
    expect(overlaps(r.members)).toEqual([]);
  });

  it.each(SEEDS)('seed %i: seats lie on the plate line and commons meet the ridge', (seed) => {
    const input = frameable(seed);
    const r = frameRoof(input);
    const f = input.footprint;
    const a = f.direction ?? 0;
    // Back to the roof's own frame.
    const plan = (p: Vec3): Vec3 => {
      const x = p[0] - f.origin[0];
      const y = p[1] - f.origin[1];
      return [Math.cos(a) * x + Math.sin(a) * y, -Math.sin(a) * x + Math.cos(a) * y, p[2]];
    };
    const seated = r.members.filter((m) => m.role === 'common-rafter' || m.role === 'jack-rafter');
    for (const m of seated) {
      const notch = m.cuts.find((c) => c.kind === 'notch');
      expect(notch, m.id).toBeDefined();
      if (notch?.kind !== 'notch') continue;
      // The seat is level at the plates' top; the bottom edge crosses that level at the seat's
      // inside edge, wallThickness in from the wall line, which the heel plane passes through.
      const zw = zAxis(m.placement);
      const world = (n: Vec3): Vec3 =>
        [0, 1, 2].map(
          (i) => n[0] * m.placement.x[i]! + n[1] * m.placement.y[i]! + n[2] * zw[i]!,
        ) as unknown as Vec3;
      expect(world(notch.b.n)[2], m.id).toBeCloseTo(-1, 9);
      const seatZ = -(notch.b.k + dot(world(notch.b.n), m.placement.origin));
      expect(seatZ).toBeCloseTo(f.plate, 6);
      // The bottom edge (local y = w / 2, z = 0) at the heel plane:
      const heelX = notch.a.k / notch.a.n[0];
      const sx = heelX + f.wallThickness / Math.cos(input.pitch);
      const seat = plan(toWorld(m.placement, [sx, m.stock.width / 2, 0]));
      expect(seat[2], m.id).toBeCloseTo(f.plate, 6);
      const heel = plan(toWorld(m.placement, [heelX, m.stock.width / 2, 0]));
      const edgeDistance = Math.min(heel[1], f.width - heel[1], heel[0], f.length - heel[0]);
      expect(Math.abs(edgeDistance), m.id).toBeLessThan(1e-6);
    }
    // Commons: the top of the ridge cut is at the ridge's face and top.
    for (const m of r.members.filter((x) => x.role === 'common-rafter')) {
      const tip = toWorld(m.placement, [m.length, 0, m.stock.depth]);
      expect(Math.abs(tip[2] - r.geometry.ridgeTop), m.id).toBeLessThan(TOL);
    }
    const ridges = r.members.filter((m) => m.role === 'ridge');
    expect(ridges.length).toBeGreaterThan(0);
    for (const m of ridges)
      expect(toWorld(m.placement, [0, 0, m.stock.depth])[2]).toBeCloseTo(r.geometry.ridgeTop, 6);
  });

  it.each(SEEDS)(
    'seed %i: members stay inside the envelope; ids unique, parse, deterministic',
    (seed) => {
      const input = frameable(seed);
      const r = frameRoof(input);
      const f = input.footprint;
      const st = input.settings;
      const reach =
        (st.overhang ?? inch(12)) + (st.subFascia?.width ?? 0) + (st.fascia?.width ?? 0);
      const rake = Math.max(st.rakeOverhang ?? 0, input.kind === 'hip' ? reach : 0);
      const a = f.direction ?? 0;
      for (const m of r.members)
        for (const piece of pieces(m))
          for (const p of piece.vertices) {
            const x = p[0] - f.origin[0];
            const y = p[1] - f.origin[1];
            const u = Math.cos(a) * x + Math.sin(a) * y;
            const v = -Math.sin(a) * x + Math.cos(a) * y;
            expect(u, m.id).toBeGreaterThan(-rake - TOL);
            expect(u, m.id).toBeLessThan(f.length + rake + TOL);
            expect(v, m.id).toBeGreaterThan(-reach - TOL);
            expect(v, m.id).toBeLessThan(f.width + reach + TOL);
            expect(p[2], m.id).toBeLessThan(r.geometry.ridgeTop + TOL);
            // Nothing hangs lower than a tail's bottom corner.
            expect(p[2], m.id).toBeGreaterThan(f.plate - inch(40));
          }
      const full = r.members.map(memberFullId);
      expect(new Set(full).size).toBe(full.length);
      for (const m of r.members) {
        const parsed = parseRoofMemberId(m.id);
        expect(parsed, m.id).toBeDefined();
        expect(formatRoofMemberId(parsed!)).toBe(m.id);
      }
      expect(frameRoof(input)).toEqual(r);
    },
  );
});
