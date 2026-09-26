// Topological id survival: the T0.5 scenarios (`spikes/topo-naming`), ported
// to the production feature operations. A block is extruded from a sketched
// rectangle; an open slot and a through hole are cut into it, both sketched
// on the block's top cap (found by name); one vertical edge is filleted by
// name. The sketch is then edited (resized, an edge split, features
// reordered, an edge deleted) and every regen checks where the fillet
// actually landed: its geometry, not just that nothing crashed.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeature,
  sketchFrame,
  type ExtrudeInput,
  type FeatureInput,
  type FeatureOutcome,
} from './features';
import {
  XY,
  circle,
  edgeAt,
  faceIndex,
  faceNames,
  near,
  neighbours,
  polygon,
  profile,
  type NamedBody,
} from './fixtures/parts';
import type { Kernel } from './kernel';
import { describeFailure, pickEdge, resolveEdge, resolveFace, type EdgeRef } from './naming';
import { createNodeKernel } from './node';
import type { Frame, ShapeId, Vec2 } from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const H = 20;
const R = 3;
const TOP = 'extrude#1:cap:end';
const BOTTOM = 'extrude#1:cap:start';
const side = (id: string) => `extrude#1:side:${id}`;

/** A feature built against the body as it is when its turn comes (sketches on faces). */
type Step = FeatureInput | ((body: NamedBody | null) => FeatureInput | { error: string });

interface Regen {
  body: NamedBody;
  outcomes: FeatureOutcome[];
  errors: FeatureOutcome['errors'];
  warnings: FeatureOutcome['warnings'];
  resolved: FeatureOutcome['resolved'];
  planeErrors: string[];
}

/** Replay steps like the regen engine: a failing feature is skipped, the rest go on. */
function regen(steps: readonly Step[]): Regen {
  let shape: ShapeId | null = null;
  const outcomes: FeatureOutcome[] = [];
  const planeErrors: string[] = [];
  const mark = k.checkpoint();
  for (const step of steps) {
    const current: NamedBody | null = shape === null ? null : { shape, ...k.named(shape)! };
    const input = typeof step === 'function' ? step(current) : step;
    if ('error' in input) {
      planeErrors.push(input.error);
      continue;
    }
    const out = applyFeature(k, shape, input);
    outcomes.push(out);
    // Only the last body is kept: earlier ones are released as the regen goes.
    if (out.created && shape !== null) k.release(shape);
    shape = out.shape;
  }
  expect(shape).not.toBeNull();
  // Everything but the final body was released.
  expect(
    k
      .liveShapes()
      .filter((s) => s.id >= mark)
      .map((s) => s.id),
  ).toEqual([shape]);
  return {
    body: { shape: shape!, ...k.named(shape!)! },
    outcomes,
    errors: outcomes.flatMap((o) => o.errors),
    warnings: outcomes.flatMap((o) => o.warnings),
    resolved: outcomes.flatMap((o) => o.resolved),
    planeErrors,
  };
}

/** A sketch on a face of the body, found by name; an unresolved face skips the feature. */
function onFace(
  face: string,
  make: (frame: Frame) => FeatureInput,
): (body: NamedBody | null) => FeatureInput | { error: string } {
  return (body) => {
    if (body === null) return { error: `no body for ${face}` };
    const r = sketchFrame(k, body.shape, { face });
    if (!r.ok) return { error: 'message' in r ? r.message : describeFailure(face, r) };
    return make(r.frame);
  };
}

function block(points: Vec2[], ids: string[]): ExtrudeInput {
  return {
    kind: 'extrude',
    id: 'extrude#1',
    profile: profile(XY, polygon(points, ids)),
    extent: { type: 'blind', distance: H },
    mode: 'new',
  };
}

const rectangle = (w: number, d: number) =>
  block(
    [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
    ],
    ['e1', 'e2', 'e3', 'e4'],
  );

/** An open slot through the front face (e1), 5 deep, sketched on the top. */
const slot = onFace(TOP, (frame) => ({
  kind: 'extrude',
  id: 'extrude#4',
  profile: profile(
    frame,
    polygon(
      [
        [15, -1],
        [25, -1],
        [25, 5],
        [15, 5],
      ],
      ['s1', 's2', 's3', 's4'],
    ),
  ),
  extent: { type: 'blind', distance: 5 },
  reverse: true,
  mode: 'subtract',
}));

/** A through hole that breaks through the slot's back wall (s3). */
const holeAt = (center: Vec2) =>
  onFace(TOP, (frame) => ({
    kind: 'extrude',
    id: 'extrude#2',
    profile: profile(frame, circle(center, 4)),
    extent: { type: 'throughAll' },
    reverse: true,
    mode: 'subtract',
  }));
const hole = holeAt([20, 7]);

const fillet = (ref: EdgeRef, id = 'fillet#3', radius = R): FeatureInput => ({
  kind: 'fillet',
  id,
  radius,
  edges: [{ id: 'r1', ref }],
});

/** The corner edge a user clicks on in the first model: vertical, at (x, y). */
function pickCorner(b: NamedBody, x: number, y: number): EdgeRef {
  return pickEdge(b.names, edgeAt(b, [x, y, H / 2]))!;
}

/**
 * The fillet face exists, is a vertical cylinder of the fillet radius sitting
 * in the corner at (x, y), and touches exactly the two side faces and both caps.
 */
function expectFilletAt(r: Regen, corner: Vec2, sides: [string, string]): NamedBody {
  expect(r.errors).toEqual([]);
  const b = r.body;
  expect(k.isValid(b.shape)).toBe(true);
  const index = faceIndex(b, 'fillet#3:round:r1');
  const face = b.topology.faces[index - 1]!;
  expect(face.surface).toBe('cylinder');
  expect(face.radius).toBeCloseTo(R, 9);
  expect(Math.abs(face.axis![2])).toBeCloseTo(1, 9);
  const [cx, cy, cz] = face.centroid;
  expect(Math.hypot(cx - corner[0], cy - corner[1])).toBeLessThan(R);
  expect(cz).toBeCloseTo(H / 2, 6);
  expect(neighbours(b, index)).toEqual([...sides, BOTTOM, TOP].sort());
  // The sharp edge between the two sides is gone.
  expect(b.names.edges.map((e) => e.name)).not.toContain([...sides].sort().join('|'));
  return b;
}

const volume = (shape: ShapeId) => k.properties(shape).volume;

describe('names at birth and through booleans', () => {
  it('names every face of the block, the slot and the hole from its feature and sketch entity', () => {
    const r = regen([rectangle(40, 30), slot, hole]);
    expect(r.errors).toEqual([]);
    expect(r.planeErrors).toEqual([]);
    expect(faceNames(r.body).sort()).toEqual(
      [
        BOTTOM,
        TOP,
        side('e1'),
        side('e2'),
        side('e3'),
        side('e4'),
        // The slot: s1 lay outside the block, so it is gone; its start cap too.
        'extrude#4:cap:end',
        'extrude#4:side:s2',
        'extrude#4:side:s4',
        // The hole broke through s3: one wall became two pieces.
        'extrude#4:side:s3#1',
        'extrude#4:side:s3#2',
        'extrude#2:side:c1',
      ].sort(),
    );
    const b = r.body;
    const fragile = b.names.faces.filter((f) => f.fragile).map((f) => f.name);
    expect(fragile.sort()).toEqual(['extrude#4:side:s3#1', 'extrude#4:side:s3#2']);
    const s31 = b.topology.faces[faceIndex(b, 'extrude#4:side:s3#1') - 1]!;
    const s32 = b.topology.faces[faceIndex(b, 'extrude#4:side:s3#2') - 1]!;
    expect(s31.centroid[0]).toBeLessThan(s32.centroid[0]);
  });

  it('names every edge by its adjacent faces, and only adds more when that is not unique', () => {
    const b = regen([rectangle(40, 30), slot, hole]).body;
    const names = b.names.edges.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(`${side('e1')}|${side('e2')}`);
    expect(names).toContain('extrude#2:side:c1|extrude#2:side:c1');
    expect(names.filter((n) => n.startsWith(`${TOP}|${side('e1')}`)).sort()).toEqual([
      `${TOP}|${side('e1')}[${side('e2')},extrude#4:side:s2]`,
      `${TOP}|${side('e1')}[${side('e4')},extrude#4:side:s4]`,
    ]);
    expect(b.names.edges.filter((e) => e.ordinal > 0)).toEqual([]);
  });

  it('stores a click on an edge as the names of its two faces', () => {
    const b = regen([rectangle(40, 30), slot, hole]).body;
    expect(pickCorner(b, 40, 0)).toEqual({ faces: [side('e1'), side('e2')] });
  });
});

describe('the fillet follows its edge through edits', () => {
  let ref: EdgeRef;

  beforeAll(() => {
    ref = pickCorner(regen([rectangle(40, 30), slot, hole]).body, 40, 0);
  });

  it('fillets the picked corner', () => {
    const before = regen([rectangle(40, 30), slot, hole]);
    const beforeVolume = volume(before.body.shape);
    k.release(before.body.shape);
    const r = regen([rectangle(40, 30), slot, hole, fillet(ref)]);
    const b = expectFilletAt(r, [40, 0], [side('e1'), side('e2')]);
    expect(r.resolved.at(-1)).toMatchObject({ ref: 'r1', via: 'exact', fragile: false });
    expect(r.warnings).toEqual([]);
    expect(beforeVolume - volume(b.shape)).toBeCloseTo((R * R - (Math.PI * R * R) / 4) * H, 6);
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

  it('after a vertex splits one of the corner edges (e2 becomes e2#a, e2#b): descendant, warned', () => {
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
    expectFilletAt(r, [40, 0], [side('e1'), side('e2#a')]);
    expect(r.resolved.at(-1)?.via).toBe('descendant');
    expect(r.warnings).toMatchObject([
      { featureId: 'fillet#3', ref: 'r1', via: 'descendant', fragile: false },
    ]);
  });

  it('a sketch region piece (e2#1) at the corner resolves as a descendant, and is fragile', () => {
    // What the sketcher's regions produce when another line meets e2.
    const r = regen([
      block(
        [
          [0, 0],
          [40, 0],
          [40, 12],
          [40, 30],
          [0, 30],
        ],
        ['e1', 'e2#1', 'e2#2', 'e3', 'e4'],
      ),
      slot,
      hole,
      fillet(ref),
    ]);
    expectFilletAt(r, [40, 0], [side('e1'), side('e2#1')]);
    expect(r.warnings).toMatchObject([{ via: 'descendant', fragile: false }]);
    // A reference stored on the piece itself is positional: fragile, even when exact.
    const exact = resolveEdge(r.body.names, r.body.topology, {
      faces: [side('e2#1'), BOTTOM].sort(),
    });
    expect(exact).toMatchObject({ ok: true, via: 'exact', fragile: true });
  });

  it('after reordering: the hole before the slot gives the same names and the same fillet', () => {
    const a = regen([rectangle(40, 30), slot, hole, fillet(ref)]);
    const b = regen([rectangle(40, 30), hole, slot, fillet(ref)]);
    const ba = expectFilletAt(a, [40, 0], [side('e1'), side('e2')]);
    const bb = expectFilletAt(b, [40, 0], [side('e1'), side('e2')]);
    expect(volume(bb.shape)).toBeCloseTo(volume(ba.shape), 6);
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

  it('a stored edge index survives simple edits, then silently picks another edge; the name does not', () => {
    const first = regen([rectangle(40, 30), slot, hole]).body;
    const index = edgeAt(first, [40, 0, H / 2]);
    const at = (b: NamedBody, i: number) => b.topology.edges[i - 1]!.midpoint;
    for (const edited of [
      [rectangle(60, 45), slot, hole],
      [rectangle(40, 30), hole, slot],
    ]) {
      expect(at(regen(edited).body, index)[1]).toBe(0);
    }
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
    for (const edit of [splitE1, rotated]) {
      const b = regen([edit, slot, hole]).body;
      expect(near(at(b, index), [40, 0, H / 2], 1e-3), 'index still on the corner').toBe(false);
      const byName = resolveEdge(b.names, b.topology, ref);
      expect(byName.ok && at(b, byName.index)).toEqual([40, 0, H / 2]);
    }
    expectFilletAt(regen([splitE1, slot, hole, fillet(ref)]), [40, 0], [side('e1#b'), side('e2')]);
  });

  it('a chamfer on the same reference follows the corner through a resize', () => {
    const r = regen([
      rectangle(60, 45),
      slot,
      hole,
      {
        kind: 'chamfer',
        id: 'chamfer#3',
        size: { kind: 'distance', distance: 2 },
        edges: [{ id: 'r1', ref }],
      },
    ]);
    expect(r.errors).toEqual([]);
    const bevel = r.body.topology.faces[faceIndex(r.body, 'chamfer#3:bevel:r1') - 1]!;
    expect(bevel.surface).toBe('plane');
    expect(near(bevel.centroid, [59, 1, H / 2], 1e-6)).toBe(true);
  });
});

describe('lost and ambiguous references are errors, never guesses', () => {
  let ref: EdgeRef;

  beforeAll(() => {
    ref = pickCorner(regen([rectangle(40, 30), slot, hole]).body, 40, 0);
  });

  it('deleting the sketch edge behind the filleted edge reports the reference lost', () => {
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
        featureId: 'fillet#3',
        code: 'lost',
        message: `${side('e1')}|${side('e2')} is lost: ${side('e2')} no longer exists`,
        ref: 'r1',
        target: `${side('e1')}|${side('e2')}`,
        missing: [side('e2')],
      },
    ]);
    expect(k.isValid(r.body.shape)).toBe(true);
    expect(faceNames(r.body).filter((n) => n.startsWith('fillet#3'))).toEqual([]);
    // A sharp edge still sits at (40, 0): the one a proximity match would have filleted.
    const sharp = r.body.topology.edges.find((e) => near(e.midpoint, [40, 0, H / 2], 1e-6));
    expect(sharp && r.body.names.edges[sharp.index - 1]!.name).toBe(`${side('e1')}|${side('e3')}`);
  });

  it('deleting a feature reports every reference into it lost, and keeps the rest', () => {
    const all0 = regen([rectangle(40, 30), slot, hole]).body;
    const holeBottom = pickEdge(all0.names, edgeAt(all0, [16, 7, 0]))!;
    expect(holeBottom).toEqual({ faces: [BOTTOM, 'extrude#2:side:c1'].sort() });
    const rim = fillet(holeBottom, 'fillet#5', 1);
    const onFloor = onFace('extrude#4:cap:end', (frame) => ({
      kind: 'extrude',
      id: 'extrude#7',
      profile: profile(frame, circle([30, 10], 1)),
      extent: { type: 'blind', distance: 2 },
      reverse: true,
      mode: 'subtract',
    }));
    const all = regen([rectangle(40, 30), slot, hole, fillet(ref), rim]);
    expect(all.errors).toEqual([]);
    expect(all.body.topology.faces[faceIndex(all.body, 'fillet#5:round:r1') - 1]!.surface).toBe(
      'torus',
    );

    const noHole = regen([rectangle(40, 30), slot, fillet(ref), rim]);
    expect(noHole.errors).toMatchObject([
      { featureId: 'fillet#5', code: 'lost', ref: 'r1', missing: ['extrude#2:side:c1'] },
    ]);
    expectFilletAt({ ...noHole, errors: [] }, [40, 0], [side('e1'), side('e2')]);

    const noSlot = regen([rectangle(40, 30), hole, onFloor]);
    expect(noSlot.planeErrors).toEqual([
      'extrude#4:cap:end is lost: extrude#4:cap:end no longer exists',
    ]);
  });

  it('a reference matching several edges or faces is ambiguous, with the candidates listed', () => {
    const b = regen([rectangle(40, 30), slot, hole]).body;
    expect(resolveEdge(b.names, b.topology, { faces: [TOP, side('e1')] })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: [
        `${TOP}|${side('e1')}[${side('e2')},extrude#4:side:s2]`,
        `${TOP}|${side('e1')}[${side('e4')},extrude#4:side:s4]`,
      ],
    });
    expect(resolveFace(b.names, { face: 'extrude#4:side:s3' })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: ['extrude#4:side:s3#1', 'extrude#4:side:s3#2'],
    });
    expect(resolveFace(b.names, { face: 'extrude#4:side:s3#2' })).toMatchObject({
      ok: true,
      via: 'exact',
      fragile: true,
    });
    // The feature holding such a reference fails with the candidates, and the body passes.
    const out = applyFeature(k, b.shape, fillet({ faces: [TOP, side('e1')] }));
    expect(out.errors).toMatchObject([{ code: 'ambiguous', ref: 'r1' }]);
    expect(out.errors[0]!.candidates).toHaveLength(2);
  });

  it('a lost edge whose faces still exist says they no longer meet', () => {
    const b = regen([rectangle(40, 30), slot, hole]).body;
    const failure = resolveEdge(b.names, b.topology, { faces: [side('e1'), side('e3')] });
    expect(failure).toEqual({ ok: false, status: 'lost', missing: [] });
    expect(!failure.ok && describeFailure('x', failure)).toBe(
      'x is lost: its faces all still exist but no longer share an edge',
    );
  });

  it('a reference to a split piece is reported fragile when an edit reorients the split', () => {
    const notch = onFace(TOP, (frame) => ({
      kind: 'extrude',
      id: 'extrude#8',
      profile: profile(
        frame,
        polygon(
          [
            [18, 3],
            [22, 3],
            [22, 8],
            [18, 8],
          ],
          ['n1', 'n2', 'n3', 'n4'],
        ),
      ),
      extent: { type: 'throughAll' },
      reverse: true,
      mode: 'subtract',
    }));
    const vertical = regen([rectangle(40, 30), slot, notch]).body;
    const right = vertical.topology.faces[faceIndex(vertical, 'extrude#4:side:s3#2') - 1]!;
    expect(right.centroid[0]).toBeCloseTo(23.5, 6);
    const picked = pickEdge(vertical.names, edgeAt(vertical, [23.5, 5, H]))!;
    expect(picked).toEqual({ faces: [TOP, 'extrude#4:side:s3#2'] });
    expect(resolveEdge(vertical.names, vertical.topology, picked)).toMatchObject({
      ok: true,
      via: 'exact',
      fragile: true,
    });

    // The notch becomes a full-width horizontal groove: s3 now splits into a
    // bottom (#1) and a top (#2) piece.
    const groove: FeatureInput = {
      kind: 'extrude',
      id: 'extrude#8',
      profile: profile(
        { origin: [10, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
        polygon(
          [
            [3, 16.5],
            [8, 16.5],
            [8, 18.5],
            [3, 18.5],
          ],
          ['n1', 'n2', 'n3', 'n4'],
        ),
      ),
      extent: { type: 'blind', distance: 20 },
      mode: 'subtract',
    };
    const horizontal = regen([rectangle(40, 30), slot, groove]).body;
    const top = horizontal.topology.faces[faceIndex(horizontal, 'extrude#4:side:s3#2') - 1]!;
    expect(top.centroid[2]).toBeGreaterThan(18.5);
    const after = resolveEdge(horizontal.names, horizontal.topology, picked);
    expect(after).toMatchObject({ ok: true, via: 'exact', fragile: true });
    expect(after.ok && horizontal.topology.edges[after.index - 1]!.midpoint).toEqual([20, 5, H]);

    // The feature holding it resolves and warns: never silent.
    const r = regen([rectangle(40, 30), slot, groove, fillet(picked, 'fillet#9', 0.5)]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toMatchObject([
      { featureId: 'fillet#9', ref: 'r1', via: 'exact', fragile: true },
    ]);
  });

  it('a reference to a kernel-split piece falls back to the whole face once the split is gone', () => {
    const split = regen([rectangle(40, 30), slot, hole]).body;
    const leftTop = split.names.edges.findIndex((e) => e.name === `${TOP}|extrude#4:side:s3#1`) + 1;
    expect(split.topology.edges[leftTop - 1]!.midpoint[0]).toBeLessThan(17);
    const left = pickEdge(split.names, leftTop)!;
    const whole = regen([rectangle(40, 30), slot, holeAt([20, 14])]).body;
    expect(faceNames(whole)).toContain('extrude#4:side:s3');
    expect(resolveFace(whole.names, { face: 'extrude#4:side:s3#1' })).toMatchObject({
      ok: true,
      via: 'ancestor',
      fragile: true,
    });
    const edge = resolveEdge(whole.names, whole.topology, left);
    expect(edge).toMatchObject({ ok: true, via: 'ancestor' });
    expect(edge.ok && whole.topology.edges[edge.index - 1]!.midpoint).toEqual([20, 5, H]);
  });

  it('end faces pick between same-pair edges, and survive a fillet at one end (warned as ends)', () => {
    const b = regen([rectangle(40, 30), slot, hole]).body;
    const right = pickEdge(b.names, edgeAt(b, [32.5, 0, H]))!;
    expect(right).toEqual({
      faces: [TOP, side('e1')],
      ends: [side('e2'), 'extrude#4:side:s2'],
    });
    const resized = regen([rectangle(60, 45), slot, hole]).body;
    const inResized = resolveEdge(resized.names, resized.topology, right);
    expect(inResized).toMatchObject({ ok: true, via: 'exact', fragile: false });
    expect(inResized.ok && resized.topology.edges[inResized.index - 1]!.midpoint).toEqual([
      42.5,
      0,
      H,
    ]);

    // After the corner fillet the edge ends at the fillet face instead of e2.
    const r = regen([rectangle(40, 30), slot, hole, fillet(ref), fillet(right, 'fillet#6', 1)]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toMatchObject([
      { featureId: 'fillet#6', ref: 'r1', via: 'ends', fragile: false },
    ]);
    const round = r.body.topology.faces[faceIndex(r.body, 'fillet#6:round:r1') - 1]!;
    expect(round.centroid[0]).toBeGreaterThan(25);
    expect(round.centroid[1]).toBeLessThan(1);
    expect(round.centroid[2]).toBeGreaterThan(H - 1);
  });

  it('falls back to a positional ordinal only when faces and ends tie, and flags it fragile', () => {
    const trough: FeatureInput = {
      kind: 'extrude',
      id: 'extrude#6',
      profile: profile(
        { origin: [10, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
        circle([15, H + 2], 4),
      ),
      extent: { type: 'blind', distance: 20 },
      mode: 'subtract',
    };
    const b = regen([rectangle(40, 30), trough]).body;
    const lines = b.names.edges.filter((e) => e.ordinal > 0);
    expect(lines.map((e) => e.name).sort()).toEqual([
      `${TOP}|extrude#6:side:c1[extrude#6:cap:end,extrude#6:cap:start]#1`,
      `${TOP}|extrude#6:side:c1[extrude#6:cap:end,extrude#6:cap:start]#2`,
    ]);
    expect(lines.every((e) => e.fragile)).toBe(true);
    const second = lines.find((e) => e.ordinal === 2)!;
    const picked = pickEdge(b.names, b.names.edges.indexOf(second) + 1)!;
    expect(picked.ordinal).toBe(2);
    expect(resolveEdge(b.names, b.topology, picked)).toMatchObject({
      ok: true,
      via: 'ordinal',
      fragile: true,
    });
    const r = regen([rectangle(40, 30), trough, fillet(picked, 'fillet#7', 0.5)]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toMatchObject([{ via: 'ordinal', fragile: true }]);
  });
});
