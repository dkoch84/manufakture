// The T0.5 scenarios. A block is extruded from a sketched rectangle; an open
// slot and a through hole are cut into it, both sketched on the block's top
// cap (found by name); one vertical edge is filleted by name. The sketch is
// then edited (resized, an edge split, features reordered, an edge deleted)
// and every regen is checked for where the fillet actually landed.

import { createInstance } from 'libcascade/single/init';
import { beforeAll, describe, expect, it } from 'vitest';
import { Kernel, type Vec3 } from './kernel.ts';
import { type Body, type Feature, type Regen, faceNames, regenerate } from './model.ts';
import type { Topology } from './kernel.ts';
import {
  type EdgeRef,
  describeFailure,
  nameShape,
  pickEdge,
  propagateFaces,
  resolveEdge,
  resolveFace,
} from './naming.ts';
import {
  BOTTOM,
  FILLET,
  H,
  type Point,
  TOP,
  block,
  fillet,
  hole,
  rectangle,
  side,
  slot,
} from './part.ts';

let kernel: Kernel;

beforeAll(async () => {
  kernel = new Kernel(await createInstance());
});

function regen(features: Feature[]): Regen {
  const r = regenerate(kernel, features);
  for (const step of r.steps)
    expect(step.unnamed, `${step.feature} left faces unnamed`).toEqual([]);
  return r;
}

function body(r: Regen): Body {
  expect(r.body).not.toBeNull();
  return r.body!;
}

function near(a: Vec3, b: Vec3, tol = 1e-6): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= tol);
}

function edgeAt(b: Body, midpoint: Vec3): number {
  const found = b.topology.edges.filter((e) => near(e.midpoint, midpoint, 1e-6));
  expect(found, `edge at ${midpoint.join(',')}`).toHaveLength(1);
  return found[0]!.index;
}

function faceIndex(b: Body, name: string): number {
  const i = b.names.faces.findIndex((f) => f.name === name);
  expect(i, `face ${name} in ${faceNames(b).join(', ')}`).toBeGreaterThanOrEqual(0);
  return i + 1;
}

/** Names of the faces sharing an edge with face `index`. */
function neighbours(b: Body, index: number): string[] {
  const out = new Set<string>();
  for (const e of b.topology.edges) {
    if (!e.faces.includes(index)) continue;
    for (const f of e.faces) if (f !== index) out.add(b.names.faces[f - 1]!.name);
  }
  return [...out].sort();
}

/** The corner edge a user clicks on in the first model: vertical, at (x, y). */
function pickCorner(b: Body, x: number, y: number): EdgeRef {
  return pickEdge(b.names, edgeAt(b, [x, y, H / 2]));
}

/**
 * The fillet face exists, is a vertical cylinder of the fillet radius sitting
 * in the corner at (x, y), and touches exactly the two side faces and both caps.
 */
function expectFilletAt(r: Regen, corner: Point, sides: [string, string]): Body {
  expect(r.errors).toEqual([]);
  const b = body(r);
  expect(kernel.isValid(b.shape)).toBe(true);
  const index = faceIndex(b, 'fillet#3:round:r1');
  const face = b.topology.faces[index - 1]!;
  expect(face.surface).toBe('cylinder');
  expect(face.radius).toBeCloseTo(FILLET, 9);
  expect(Math.abs(face.axis![2])).toBeCloseTo(1, 9);
  const [cx, cy, cz] = face.centroid;
  expect(Math.hypot(cx - corner[0], cy - corner[1])).toBeLessThan(FILLET);
  expect(cz).toBeCloseTo(H / 2, 6);
  expect(neighbours(b, index)).toEqual([...sides, BOTTOM, TOP].sort());
  // The sharp edge between the two sides is gone.
  expect(b.names.edges.map((e) => e.name)).not.toContain([...sides].sort().join('|'));
  return b;
}

describe('names at birth and through booleans', () => {
  it('names every face of the block, the slot and the hole from its feature and sketch entity', () => {
    const r = regen([rectangle(40, 30), slot, hole]);
    expect(r.errors).toEqual([]);
    // Both sketches found the top cap by name.
    expect(r.resolved.map((x) => [x.feature, x.ref, x.via])).toEqual([
      ['cut#4', 'plane', 'exact'],
      ['cut#2', 'plane', 'exact'],
    ]);
    expect(faceNames(body(r)).sort()).toEqual(
      [
        BOTTOM,
        TOP,
        side('e1'),
        side('e2'),
        side('e3'),
        side('e4'),
        // The slot: s1 lay outside the block, so it is gone; its start cap too.
        'cut#4:cap:end',
        'cut#4:side:s2',
        'cut#4:side:s4',
        // The hole broke through s3: one wall became two pieces.
        'cut#4:side:s3#1',
        'cut#4:side:s3#2',
        'cut#2:side:c1',
      ].sort(),
    );
    const b = body(r);
    const fragile = b.names.faces.filter((f) => f.fragile).map((f) => f.name);
    expect(fragile.sort()).toEqual(['cut#4:side:s3#1', 'cut#4:side:s3#2']);
    // Kernel-split pieces are ordered by position: #1 is the one at smaller x.
    const s31 = b.topology.faces[faceIndex(b, 'cut#4:side:s3#1') - 1]!;
    const s32 = b.topology.faces[faceIndex(b, 'cut#4:side:s3#2') - 1]!;
    expect(s31.centroid[0]).toBeLessThan(s32.centroid[0]);
  });

  it('names every edge by its adjacent faces, and only adds more when that is not unique', () => {
    const b = body(regen([rectangle(40, 30), slot, hole]));
    const names = b.names.edges.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(`${side('e1')}|${side('e2')}`);
    // The hole's seam is the one edge between its wall and itself.
    expect(names).toContain('cut#2:side:c1|cut#2:side:c1');
    // The slot cuts the top front edge in two: same two faces, told apart by their ends.
    expect(names.filter((n) => n.startsWith(`${TOP}|${side('e1')}`)).sort()).toEqual([
      `${TOP}|${side('e1')}[cut#4:side:s2,${side('e2')}]`,
      `${TOP}|${side('e1')}[cut#4:side:s4,${side('e4')}]`,
    ]);
    expect(b.names.edges.filter((e) => e.ordinal > 0)).toEqual([]);
  });

  it('stores a click on an edge as the names of its two faces', () => {
    const b = body(regen([rectangle(40, 30), slot, hole]));
    expect(pickCorner(b, 40, 0)).toEqual({ faces: [side('e1'), side('e2')] });
  });
});

describe('the fillet follows its edge through edits', () => {
  let ref: EdgeRef;

  beforeAll(() => {
    ref = pickCorner(body(regen([rectangle(40, 30), slot, hole])), 40, 0);
  });

  it('fillets the picked corner', () => {
    const before = body(regen([rectangle(40, 30), slot, hole]));
    const r = regen([rectangle(40, 30), slot, hole, fillet(ref)]);
    const b = expectFilletAt(r, [40, 0], [side('e1'), side('e2')]);
    expect(r.resolved.at(-1)).toMatchObject({ feature: 'fillet#3', via: 'exact', fragile: false });
    // Exactly one quarter-round of material is removed from one vertical edge.
    const removed = kernel.volume(before.shape) - kernel.volume(b.shape);
    expect(removed).toBeCloseTo((FILLET * FILLET - (Math.PI * FILLET * FILLET) / 4) * H, 6);
  });

  it('after resizing the rectangle', () => {
    const r = regen([rectangle(60, 45), slot, hole, fillet(ref)]);
    expectFilletAt(r, [60, 0], [side('e1'), side('e2')]);
    expect(r.resolved.at(-1)?.via).toBe('exact');
  });

  it('after a vertex splits an edge away from the corner (e3 becomes e3#a, e3#b)', () => {
    const r = regen([
      block(
        [
          [0, 0],
          [40, 0],
          [40, 30],
          [20, 40],
          [0, 30],
        ],
        ['e1', 'e2', 'e3#a', 'e3#b', 'e4'],
      ),
      slot,
      hole,
      fillet(ref),
    ]);
    const b = expectFilletAt(r, [40, 0], [side('e1'), side('e2')]);
    expect(faceNames(b)).toEqual(expect.arrayContaining([side('e3#a'), side('e3#b')]));
    expect(faceNames(b)).not.toContain(side('e3'));
    expect(r.resolved.at(-1)?.via).toBe('exact');
  });

  it('after a vertex splits one of the corner edges (e2 becomes e2#a, e2#b)', () => {
    const r = regen([
      block(
        [
          [0, 0],
          [40, 0],
          [50, 15],
          [40, 30],
          [0, 30],
        ],
        ['e1', 'e2#a', 'e2#b', 'e3', 'e4'],
      ),
      slot,
      hole,
      fillet(ref),
    ]);
    // Only one edge lies between e1 and a descendant of e2, so the reference still resolves.
    expectFilletAt(r, [40, 0], [side('e1'), side('e2#a')]);
    expect(r.resolved.at(-1)?.via).toBe('descendant');
  });

  it('after reordering: the hole before the slot gives the same names and the same fillet', () => {
    const a = regen([rectangle(40, 30), slot, hole, fillet(ref)]);
    const b = regen([rectangle(40, 30), hole, slot, fillet(ref)]);
    const ba = expectFilletAt(a, [40, 0], [side('e1'), side('e2')]);
    const bb = expectFilletAt(b, [40, 0], [side('e1'), side('e2')]);
    expect(kernel.volume(bb.shape)).toBeCloseTo(kernel.volume(ba.shape), 6);
    // Different history, same names: faces and edges.
    expect(faceNames(bb).sort()).toEqual(faceNames(ba).sort());
    expect(bb.names.edges.map((e) => e.name).sort()).toEqual(
      ba.names.edges.map((e) => e.name).sort(),
    );
  });

  it('after all of it at once: resized, a corner edge split, and reordered', () => {
    const r = regen([
      block(
        [
          [0, 0],
          [60, 0],
          [70, 22.5],
          [60, 45],
          [0, 45],
        ],
        ['e1', 'e2#a', 'e2#b', 'e3', 'e4'],
      ),
      hole,
      slot,
      fillet(ref),
    ]);
    expectFilletAt(r, [60, 0], [side('e1'), side('e2#a')]);
  });

  it('a stored edge index survives simple edits, then silently picks another edge', () => {
    const first = body(regen([rectangle(40, 30), slot, hole]));
    const index = edgeAt(first, [40, 0, H / 2]);
    const named = pickCorner(first, 40, 0);
    const at = (b: Body, i: number) => b.topology.edges[i - 1]!.midpoint;

    // Resize, reorder and a split away from the corner leave MapShapes order
    // alone, which is what makes index references look safe in testing.
    for (const edited of [
      [rectangle(60, 45), slot, hole],
      [rectangle(40, 30), hole, slot],
    ]) {
      const b = body(regen(edited));
      expect(at(b, index)[1]).toBe(0);
    }

    // Splitting e1 (e1#a, e1#b), or a sketcher that emits the same rectangle
    // starting from another corner, moves the index onto a different edge.
    const splitE1 = block(
      [
        [0, 0],
        [30, -5],
        [40, 0],
        [40, 30],
        [0, 30],
      ],
      ['e1#a', 'e1#b', 'e2', 'e3', 'e4'],
    );
    const rotated = block(
      [
        [40, 30],
        [0, 30],
        [0, 0],
        [40, 0],
      ],
      ['e3', 'e4', 'e1', 'e2'],
    );
    for (const [edit, corner] of [
      [splitE1, [40, 0, H / 2]],
      [rotated, [40, 0, H / 2]],
    ] as const) {
      const b = body(regen([edit, slot, hole]));
      expect(near(at(b, index), corner, 1e-3), 'index still on the corner').toBe(false);
      const byName = resolveEdge(b.names, b.topology, named);
      expect(byName.ok && at(b, byName.index)).toEqual(corner);
    }
    expectFilletAt(
      regen([splitE1, slot, hole, fillet(named)]),
      [40, 0],
      [side('e1#b'), side('e2')],
    );
  });
});

describe('lost and ambiguous references are errors, never guesses', () => {
  let ref: EdgeRef;

  beforeAll(() => {
    ref = pickCorner(body(regen([rectangle(40, 30), slot, hole])), 40, 0);
  });

  it('deleting the sketch edge behind the filleted edge reports the reference lost', () => {
    // e2 is deleted and the loop closed from (40, 0) straight to (0, 30).
    const triangle = block(
      [
        [0, 0],
        [40, 0],
        [0, 30],
      ],
      ['e1', 'e3', 'e4'],
    );
    const r = regen([triangle, slot, hole, fillet(ref)]);
    expect(r.errors).toEqual([
      {
        feature: 'fillet#3',
        ref: 'r1',
        target: `${side('e1')}|${side('e2')}`,
        failure: { ok: false, status: 'lost', missing: [side('e2')] },
      },
    ]);
    const b = body(r);
    expect(kernel.isValid(b.shape)).toBe(true);
    expect(faceNames(b).filter((n) => n.startsWith('fillet#3'))).toEqual([]);
    // There is still a sharp vertical edge at (40, 0): the one a proximity
    // match would silently have filleted.
    const sharp = b.topology.edges.find((e) => near(e.midpoint, [40, 0, H / 2], 1e-6));
    expect(sharp && b.names.edges[sharp.index - 1]!.name).toBe(`${side('e1')}|${side('e3')}`);
  });

  it('deleting a feature reports every reference into it lost, and keeps the rest', () => {
    const holeBottom: EdgeRef = pickEdge(
      body(regen([rectangle(40, 30), slot, hole])).names,
      edgeAt(body(regen([rectangle(40, 30), slot, hole])), [16, 7, 0]),
    );
    expect(holeBottom).toEqual({ faces: ['cut#2:side:c1', BOTTOM] });
    const rim: Feature = {
      kind: 'fillet',
      id: 'fillet#5',
      radius: 1,
      edges: [{ id: 'r1', ref: holeBottom }],
    };
    const onFloor: Feature = {
      kind: 'extrude',
      id: 'cut#7',
      plane: { kind: 'face', face: { face: 'cut#4:cap:end' } },
      loop: { kind: 'circle', center: [30, 10], radius: 1, id: 'c1' },
      from: 0,
      to: -2,
      operation: 'cut',
    };
    const all = regen([rectangle(40, 30), slot, hole, fillet(ref), rim]);
    expect(all.errors).toEqual([]);
    const rimFace = body(all).topology.faces[faceIndex(body(all), 'fillet#5:round:r1') - 1]!;
    expect(rimFace.surface).toBe('torus');

    const noHole = regen([rectangle(40, 30), slot, fillet(ref), rim]);
    expect(noHole.errors).toEqual([
      {
        feature: 'fillet#5',
        ref: 'r1',
        target: `cut#2:side:c1|${BOTTOM}`,
        failure: { ok: false, status: 'lost', missing: ['cut#2:side:c1'] },
      },
    ]);
    expectFilletAt({ ...noHole, errors: [] }, [40, 0], [side('e1'), side('e2')]);

    const noSlot = regen([rectangle(40, 30), hole, onFloor]);
    expect(noSlot.errors).toEqual([
      {
        feature: 'cut#7',
        ref: 'plane',
        target: 'cut#4:cap:end',
        failure: { ok: false, status: 'lost', missing: ['cut#4:cap:end'] },
      },
    ]);
  });

  it('a reference matching several edges or faces is ambiguous, with the candidates listed', () => {
    const b = body(regen([rectangle(40, 30), slot, hole]));
    expect(resolveEdge(b.names, b.topology, { faces: [TOP, side('e1')] })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: [
        `${TOP}|${side('e1')}[cut#4:side:s2,${side('e2')}]`,
        `${TOP}|${side('e1')}[cut#4:side:s4,${side('e4')}]`,
      ],
    });
    expect(resolveFace(b.names, { face: 'cut#4:side:s3' })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: ['cut#4:side:s3#1', 'cut#4:side:s3#2'],
    });
    // A split piece resolves by exact name, but its name is positional: fragile.
    expect(resolveFace(b.names, { face: 'cut#4:side:s3#2' })).toMatchObject({
      ok: true,
      via: 'exact',
      fragile: true,
    });
  });

  it('a lost edge whose faces still exist says they no longer meet', () => {
    const b = body(regen([rectangle(40, 30), slot, hole]));
    const ref: EdgeRef = { faces: [side('e1'), side('e3')] };
    const failure = resolveEdge(b.names, b.topology, ref);
    expect(failure).toEqual({ ok: false, status: 'lost', missing: [] });
    expect(!failure.ok && describeFailure(`${side('e1')}|${side('e3')}`, failure)).toBe(
      `${side('e1')}|${side('e3')} is lost: its faces all still exist but no longer share an edge`,
    );
    const gone = resolveEdge(b.names, b.topology, { faces: [side('e1'), side('e9')] });
    expect(!gone.ok && describeFailure('x', gone)).toBe(
      `x is lost: ${side('e9')} no longer exists`,
    );
  });

  it('a reference to a split piece is reported fragile when an edit reorients the split', () => {
    // A through notch in the slot's back wall splits s3 into a left (#1) and
    // a right (#2) piece.
    const notch: Feature = {
      kind: 'extrude',
      id: 'cut#8',
      plane: { kind: 'face', face: { face: TOP } },
      loop: {
        kind: 'polygon',
        points: [
          [18, 3],
          [22, 3],
          [22, 8],
          [18, 8],
        ],
        ids: ['n1', 'n2', 'n3', 'n4'],
      },
      from: 1000,
      to: -1000,
      operation: 'cut',
    };
    const vertical = body(regen([rectangle(40, 30), slot, notch]));
    const right = vertical.topology.faces[faceIndex(vertical, 'cut#4:side:s3#2') - 1]!;
    expect(right.centroid[0]).toBeCloseTo(23.5, 6);
    const picked = pickEdge(vertical.names, edgeAt(vertical, [23.5, 5, H]));
    expect(picked).toEqual({ faces: ['cut#4:side:s3#2', TOP] });
    // Even on the unchanged model the positional name is reported.
    expect(resolveEdge(vertical.names, vertical.topology, picked)).toMatchObject({
      ok: true,
      via: 'exact',
      fragile: true,
    });

    // Edit the notch into a horizontal groove across the full width of the
    // wall: s3 now splits into a bottom (#1) and a top (#2) piece.
    const groove: Feature = {
      ...notch,
      plane: { kind: 'frame', frame: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } },
      loop: {
        kind: 'polygon',
        points: [
          [3, 16.5],
          [8, 16.5],
          [8, 18.5],
          [3, 18.5],
        ],
        ids: ['n1', 'n2', 'n3', 'n4'],
      },
      from: 10,
      to: 30,
    };
    const horizontal = body(regen([rectangle(40, 30), slot, groove]));
    const top = horizontal.topology.faces[faceIndex(horizontal, 'cut#4:side:s3#2') - 1]!;
    expect(top.centroid[2]).toBeGreaterThan(18.5);
    // Same name, a different piece: the edge is now the full-width top edge
    // at x = 20. It still resolves by exact name, and it is never silent.
    const after = resolveEdge(horizontal.names, horizontal.topology, picked);
    expect(after).toMatchObject({ ok: true, via: 'exact', fragile: true });
    expect(after.ok && horizontal.topology.edges[after.index - 1]!.midpoint).toEqual([20, 5, H]);

    // The regen engine records it too, for the feature that holds the reference.
    const r = regen([
      rectangle(40, 30),
      slot,
      groove,
      { kind: 'fillet', id: 'fillet#9', radius: 0.5, edges: [{ id: 'r1', ref: picked }] },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.resolved.at(-1)).toMatchObject({
      feature: 'fillet#9',
      ref: 'r1',
      via: 'exact',
      fragile: true,
    });
  });

  it('a reference to a kernel-split piece falls back to the whole face once the split is gone', () => {
    const split = body(regen([rectangle(40, 30), slot, hole]));
    const leftTop = split.names.edges.findIndex((e) => e.name === `cut#4:side:s3#1|${TOP}`) + 1;
    expect(split.topology.edges[leftTop - 1]!.midpoint[0]).toBeLessThan(17);
    const left = pickEdge(split.names, leftTop);
    expect(left).toEqual({ faces: ['cut#4:side:s3#1', TOP] });
    // Move the hole off the slot wall: s3 is one face again.
    const moved: Feature = {
      ...hole,
      loop: { kind: 'circle', center: [20, 14], radius: 4, id: 'c1' },
    };
    const whole = body(regen([rectangle(40, 30), slot, moved]));
    expect(faceNames(whole)).toContain('cut#4:side:s3');
    expect(resolveFace(whole.names, { face: 'cut#4:side:s3#1' })).toMatchObject({
      ok: true,
      via: 'ancestor',
    });
    const edge = resolveEdge(whole.names, whole.topology, left);
    expect(edge).toMatchObject({ ok: true, via: 'ancestor' });
    expect(edge.ok && whole.topology.edges[edge.index - 1]!.midpoint).toEqual([20, 5, H]);
  });

  it('end faces pick between same-pair edges, and survive a fillet at one end', () => {
    const b = body(regen([rectangle(40, 30), slot, hole]));
    const right = pickEdge(b.names, edgeAt(b, [32.5, 0, H]));
    expect(right).toEqual({ faces: [TOP, side('e1')], ends: ['cut#4:side:s2', side('e2')] });

    const resized = body(regen([rectangle(60, 45), slot, hole]));
    const inResized = resolveEdge(resized.names, resized.topology, right);
    // The end faces are unchanged, so the edge's full name matches: exact.
    expect(inResized).toMatchObject({ ok: true, via: 'exact', fragile: false });
    expect(inResized.ok && resized.topology.edges[inResized.index - 1]!.midpoint).toEqual([
      42.5,
      0,
      H,
    ]);

    // After the corner fillet the edge ends at the fillet face instead of e2:
    // one of the two end faces still matches, and that is enough to choose.
    const filleted = body(regen([rectangle(40, 30), slot, hole, fillet(ref)]));
    const after = resolveEdge(filleted.names, filleted.topology, right);
    expect(after).toMatchObject({ ok: true, via: 'ends', fragile: false });
    const mid = after.ok ? filleted.topology.edges[after.index - 1]!.midpoint : [0, 0, 0];
    expect(mid[0]).toBeGreaterThan(25);
    expect(mid[2]).toBeCloseTo(H, 9);
  });

  it('falls back to a positional ordinal only when faces and ends tie, and flags it fragile', () => {
    // A blind horizontal trough: its round wall meets the top twice, and
    // both lines run between the same two end walls.
    const trough: Feature = {
      kind: 'extrude',
      id: 'cut#6',
      plane: { kind: 'frame', frame: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } },
      loop: { kind: 'circle', center: [15, H + 2], radius: 4, id: 'c1' },
      from: 10,
      to: 30,
      operation: 'cut',
    };
    const b = body(regen([rectangle(40, 30), trough]));
    const lines = b.names.edges.filter((e) => e.ordinal > 0);
    expect(lines.map((e) => e.name).sort()).toEqual([
      `cut#6:side:c1|${TOP}[cut#6:cap:end,cut#6:cap:start]#1`,
      `cut#6:side:c1|${TOP}[cut#6:cap:end,cut#6:cap:start]#2`,
    ]);
    expect(lines.every((e) => e.fragile)).toBe(true);
    const bare = resolveEdge(b.names, b.topology, { faces: ['cut#6:side:c1', TOP] });
    expect(bare).toMatchObject({ ok: false, status: 'ambiguous' });
    const withEnds = resolveEdge(b.names, b.topology, {
      faces: ['cut#6:side:c1', TOP],
      ends: ['cut#6:cap:end', 'cut#6:cap:start'],
    });
    expect(withEnds).toMatchObject({ ok: false, status: 'ambiguous' });
    const second = lines.find((e) => e.ordinal === 2)!;
    const picked = pickEdge(b.names, b.names.edges.indexOf(second) + 1);
    expect(picked.ordinal).toBe(2);
    expect(resolveEdge(b.names, b.topology, picked)).toMatchObject({
      ok: true,
      via: 'ordinal',
      fragile: true,
    });
  });
});

describe('merges', () => {
  const half = (
    id: string,
    x0: number,
    ids: string[],
    operation: 'new' | 'fuse',
    simplify: boolean,
  ): Feature => ({
    kind: 'extrude',
    id,
    plane: { kind: 'xy' },
    loop: {
      kind: 'polygon',
      points: [
        [x0, 0],
        [x0 + 20, 0],
        [x0 + 20, 30],
        [x0, 30],
      ],
      ids,
    },
    from: 0,
    to: H,
    operation,
    simplify,
  });

  it('names a face merged by SimplifyResult after all its sources, and resolves each source to it', () => {
    const features = (simplify: boolean) => [
      half('extrude#1', 0, ['a1', 'a2', 'a3', 'a4'], 'new', false),
      half('extrude#2', 20, ['b1', 'b2', 'b3', 'b4'], 'fuse', simplify),
    ];
    const merged = body(regen(features(true)));
    expect(faceNames(merged).sort()).toEqual(
      [
        '(extrude#1:cap:end+extrude#2:cap:end)',
        '(extrude#1:cap:start+extrude#2:cap:start)',
        '(extrude#1:side:a1+extrude#2:side:b1)',
        '(extrude#1:side:a3+extrude#2:side:b3)',
        'extrude#1:side:a4',
        'extrude#2:side:b2',
      ].sort(),
    );
    expect(resolveFace(merged.names, { face: 'extrude#1:cap:end' })).toMatchObject({
      ok: true,
      via: 'descendant',
    });
    // Without SimplifyResult nothing merges: the shared wall is gone and the tops stay two faces.
    const separate = body(regen(features(false)));
    expect(faceNames(separate)).toEqual(
      expect.arrayContaining(['extrude#1:cap:end', 'extrude#2:cap:end']),
    );
    expect(faceNames(separate)).not.toContain('extrude#1:side:a2');
  });
});

describe('faces generated from one input', () => {
  // Pure naming, no kernel: one input edge generates two faces, and the
  // kernel happens to list the one at larger x first.
  const face = (index: number, x: number) => ({
    index,
    surface: 'plane',
    centroid: [x, 0, 0] as const,
    area: 1,
    normal: null,
    axis: null,
    radius: null,
  });
  const topology: Topology = { faces: [face(1, 5), face(2, 1)], edges: [], vertices: [] };
  const history = [
    {
      operand: 0,
      input: { kind: 'edge' as const, index: 7 },
      kept: 0,
      modified: [],
      generated: [
        { kind: 'face' as const, index: 1 },
        { kind: 'face' as const, index: 2 },
      ],
      deleted: true,
    },
  ];

  it('numbers the pieces by position, not index order, and marks them fragile', () => {
    const { faces, unnamed } = propagateFaces([[]], history, topology, () => 'fillet#3:round:r1');
    expect(unnamed).toEqual([]);
    expect(faces).toEqual([
      {
        name: 'fillet#3:round:r1#2',
        lineage: ['fillet#3:round:r1#2', 'fillet#3:round:r1'],
        fragile: true,
      },
      {
        name: 'fillet#3:round:r1#1',
        lineage: ['fillet#3:round:r1#1', 'fillet#3:round:r1'],
        fragile: true,
      },
    ]);
    const names = nameShape(faces, topology);
    expect(resolveFace(names, { face: 'fillet#3:round:r1' })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: ['fillet#3:round:r1#1', 'fillet#3:round:r1#2'],
    });
    expect(resolveFace(names, { face: 'fillet#3:round:r1#1' })).toEqual({
      ok: true,
      index: 2,
      via: 'exact',
      fragile: true,
    });
  });
});

describe('what edge history alone would give', () => {
  it('misses the edges a fillet creates, and OCCT fillet IsDeleted is wrong for kept edges', () => {
    const ref = pickCorner(body(regen([rectangle(40, 30), slot, hole])), 40, 0);
    const r = regen([rectangle(40, 30), slot, hole, fillet(ref)]);
    const step = r.steps.find((s) => s.feature === 'fillet#3')!;
    const b = body(r);
    const edgeEntries = step.history.filter((h) => h.input.kind === 'edge');
    const reached = new Set<number>();
    for (const h of edgeEntries) {
      if (h.kept) reached.add(h.kept);
      for (const m of h.modified) if (m.kind === 'edge') reached.add(m.index);
    }
    const total = b.topology.edges.length;
    // The four boundary edges of the fillet face have no input edge.
    expect(total - reached.size).toBe(4);
    const unreached = b.topology.edges.filter((e) => !reached.has(e.index));
    const round = faceIndex(b, 'fillet#3:round:r1');
    expect(unreached.every((e) => e.faces.includes(round))).toBe(true);
    // Face-pair naming names all of them.
    expect(b.names.edges.every((e) => !e.name.includes('?'))).toBe(true);

    // Where edge history does reach, it agrees with face-pair naming on the
    // faces. The `ends` suffix can change: the top front edge now ends at the
    // fillet face instead of e2, which is why ends are matched by score.
    const input = step.operands[0]!.names;
    const endsChanged: string[] = [];
    for (const h of edgeEntries) {
      const out = h.kept
        ? [h.kept]
        : h.modified.filter((m) => m.kind === 'edge').map((m) => m.index);
      for (const o of out) {
        const before = input.edges[h.input.index - 1]!;
        const after = b.names.edges[o - 1]!;
        expect(after.faces).toEqual(before.faces);
        if (after.name !== before.name) endsChanged.push(after.name);
      }
    }
    expect(endsChanged).toEqual([`${TOP}|${side('e1')}[cut#4:side:s2,fillet#3:round:r1]`]);
    // BRepFilletAPI_MakeFillet reports IsDeleted for edges that are still there.
    expect(edgeEntries.filter((h) => h.kept > 0 && h.deleted).length).toBeGreaterThan(0);
    // Booleans do not.
    for (const s of r.steps.filter((x) => x.operation === 'cut')) {
      expect(s.history.filter((h) => h.kept > 0 && h.deleted)).toEqual([]);
    }
  });

  it('boolean section edges come from Generated(face), and their generators are their face names', () => {
    const r = regen([rectangle(40, 30), slot, hole]);
    const step = r.steps.find((s) => s.feature === 'cut#2')!;
    const b = body(r);
    const generators = new Map<number, string[]>();
    for (const h of step.history) {
      if (h.input.kind !== 'face') continue;
      const name = step.operands[h.operand]!.names.faces[h.input.index - 1]!.name;
      for (const g of h.generated) {
        if (g.kind === 'edge') generators.set(g.index, [...(generators.get(g.index) ?? []), name]);
      }
    }
    expect(generators.size).toBeGreaterThan(0);
    for (const [edge, names] of generators) {
      const lineage = b.topology.edges[edge - 1]!.faces.flatMap(
        (f) => b.names.faces[f - 1]!.lineage,
      );
      for (const n of names) expect(lineage).toContain(n);
    }
  });
});

describe('meshes carry face names', () => {
  it('lines up mesh face ranges with face names, so a picked triangle gives a name', () => {
    const ref = pickCorner(body(regen([rectangle(40, 30), slot, hole])), 40, 0);
    const b = body(regen([rectangle(40, 30), slot, hole, fillet(ref)]));
    const mesh = kernel.mesh(b.shape, 0.1, 0.5);
    expect(mesh.faceRanges.length / 2).toBe(b.names.faces.length);
    const round = faceIndex(b, 'fillet#3:round:r1') - 1;
    const first = mesh.faceRanges[round * 2]!;
    const count = mesh.faceRanges[round * 2 + 1]!;
    expect(count).toBeGreaterThan(0);
    for (let i = first; i < first + count; i++) {
      const v = mesh.indices[i]!;
      const x = mesh.positions[v * 3]!;
      const y = mesh.positions[v * 3 + 1]!;
      expect(Math.hypot(x - 40, y)).toBeLessThanOrEqual(FILLET * Math.SQRT2 + 1e-4);
    }
  });
});
