// Golden tests for modelled threads (M3 plan, T3.2e), through the `thread` feature:
//
// - an M6 external thread, 10 mm, whose major and minor diameters and pitch are measured on
//   sections of the exact B-rep (and the flank angle), and whose volume matches a reference
//   computed from the profile (below);
// - internal M6 in a block and external M6 on a shaft, both with clearance: the distance between
//   the two solids is the clearance, and they do not interfere;
// - an internal M5 cut into a hole at the minor diameter: which of its `:thread:` faces OCCT
//   reports as cylinders, which T3.1c's thread rule relies on;
// - hand, ends and chamfers, a crest trim, names that are unique and survive a length change;
// - the time of an M6 x 20 mm thread in a block, against a budget set by measurement.
//
// Volume reference. A thread cut along its whole length (both ends open) is helically
// symmetric, so every cross-section square to the axis has the same area, and by Cavalieri the
// volume is the length times that area. The area equals the mean over one pitch of the area of
// the axial profile revolved, so V = (L / P) * integral over one pitch of pi rho(z)^2 dz, where
// rho(z) is the profile's radius at height z (the root radius in the groove's bottom, rising
// along the 30 degree flanks, the cylinder's radius on the crest). The integral is evaluated
// numerically with 200,000 midpoint samples, far below the 0.5% tolerance.

import type { TopoDS_Shape } from 'libcascade/single/init';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeature,
  type FeatureBody,
  type FeatureOutcome,
  type ThreadInput,
} from '../src/features';
import { XY, circle, profile, rectangle } from '../src/fixtures/parts';
import type { Kernel } from '../src/kernel';
import { createNodeKernel } from '../src/node';
import { mapShapes, withScope } from '../src/occt';
import { threadProfile, threadSize } from '../src/threads';
import type { ShapeId, Vec3 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const M6 = threadSize('iso-metric', 'M6')!;
const M5 = threadSize('iso-metric', 'M5')!;
const Z = { origin: [0, 0, 0] as Vec3, direction: [0, 0, 1] as Vec3 };

function raw(shape: ShapeId): TopoDS_Shape {
  return (k as unknown as { get(id: ShapeId, op: string): TopoDS_Shape }).get(shape, 'test');
}

/** A shaft of `radius` along z from z0 to z1. */
function shaft(radius: number, z0: number, z1: number): FeatureBody[] {
  const out = applyFeature(k, [], {
    kind: 'extrude',
    id: 'extrude#1',
    mode: 'new',
    profile: profile({ ...XY, origin: [0, 0, z0] }, circle([0, 0], radius)),
    extent: { type: 'blind', distance: z1 - z0 },
  });
  expect(out.errors).toEqual([]);
  return out.bodies.map((b) => ({ id: b.id, shape: b.shape }));
}

/** A square block 2w across with a hole of `radius` along z, from z0 to z1. */
function block(w: number, radius: number, z0: number, z1: number, id = 'extrude#1'): FeatureBody[] {
  const out = applyFeature(k, [], {
    kind: 'extrude',
    id,
    mode: 'new',
    profile: profile(
      { ...XY, origin: [0, 0, z0] },
      rectangle(-w, -w, w, w),
      circle([0, 0], radius, 'h1'),
    ),
    extent: { type: 'blind', distance: z1 - z0 },
  });
  expect(out.errors).toEqual([]);
  return out.bodies.map((b) => ({ id: b.id, shape: b.shape }));
}

function thread(
  bodies: FeatureBody[],
  input: Omit<ThreadInput, 'kind' | 'id' | 'axis'> & { id?: string },
): FeatureOutcome {
  const out = applyFeature(k, bodies, { kind: 'thread', id: 'thread#2', axis: Z, ...input });
  expect(out.errors).toEqual([]);
  expect(out.ok).toBe(true);
  return out;
}

function only(out: FeatureOutcome) {
  expect(out.bodies).toHaveLength(1);
  const b = out.bodies[0]!;
  return { shape: b.shape, names: b.names!, topology: k.topology(b.shape) };
}

/** The volume of the exact B-rep, integrated to a relative error of 1e-9. */
function exactVolume(shape: ShapeId): number {
  return withScope(k.oc, (s) => {
    const props = s.own(new k.oc.GProp_GProps());
    k.oc.BRepGProp.VolumeProperties(raw(shape), props, 1e-9, false, false);
    return props.Mass();
  });
}

/** Points along every edge of the section of `shape` by a plane. */
function section(shape: ShapeId, origin: Vec3, normal: Vec3): Vec3[][] {
  return withScope(k.oc, (s) => {
    const oc = k.oc;
    const pln = s.own(
      new oc.gp_Pln(s.own(new oc.gp_Pnt(...origin)), s.own(new oc.gp_Dir(...normal))),
    );
    const cut = s.own(new oc.BRepAlgoAPI_Section(raw(shape), pln, true));
    const edges = mapShapes(oc, s, s.own(cut.Shape()), 'edge');
    const out: Vec3[][] = [];
    for (let i = 1; i <= edges.Extent(); i++) {
      const curve = s.own(new oc.BRepAdaptor_Curve(s.own(oc.TopoDS.Edge(s.own(edges.FindKey(i))))));
      const a = curve.FirstParameter();
      const b = curve.LastParameter();
      const pts: Vec3[] = [];
      for (let j = 0; j <= 64; j++) {
        const p = s.own(curve.Value(a + ((b - a) * j) / 64));
        pts.push([p.X(), p.Y(), p.Z()]);
      }
      out.push(pts);
    }
    return out;
  });
}

/** The smallest and largest distance from the z axis of the section at height z. */
function radii(shape: ShapeId, z: number): { min: number; max: number } {
  const r = section(shape, [0, 0, z], [0, 0, 1])
    .flat()
    .map((p) => Math.hypot(p[0], p[1]));
  return { min: Math.min(...r), max: Math.max(...r) };
}

/** Reference volume of a threaded rod of length L (see the header). */
function rodVolume(radius: number, root: number, rootWidth: number, pitch: number, length: number) {
  const tan30 = Math.tan(Math.PI / 6);
  const n = 200_000;
  let integral = 0;
  for (let i = 0; i < n; i++) {
    const z = ((i + 0.5) / n) * pitch;
    const d = Math.min(z, pitch - z); // distance from the groove's centre line
    const rho = d < rootWidth / 2 ? root : Math.min(radius, root + (d - rootWidth / 2) / tan30);
    integral += (Math.PI * rho * rho * pitch) / n;
  }
  return (length / pitch) * integral;
}

/** Distance between two shapes (BRepExtrema_DistShapeShape, as `measure` uses). */
function distance(a: ShapeId, b: ShapeId): number {
  return withScope(k.oc, (s) => {
    const d = s.own(new k.oc.BRepExtrema_DistShapeShape(raw(a), raw(b)));
    expect(d.IsDone()).toBe(true);
    return d.Value();
  });
}

function threadFaces(body: ReturnType<typeof only>) {
  return body.names.faces
    .map((f, i) => ({ name: f.name, lineage: f.lineage, face: body.topology.faces[i]! }))
    .filter((f) => f.name.includes(':thread:'));
}

describe('an M6 external thread', () => {
  it('has the table diameters and pitch on sections, 60 degree flanks and the reference volume', () => {
    const out = thread(shaft(M6.major / 2, 0, 10), {
      side: 'external',
      radius: M6.major / 2,
      major: M6.major,
      pitch: M6.pitch,
      length: 10,
      start: 'open',
      end: 'open',
    });
    const body = only(out);
    expect(k.isValid(body.shape)).toBe(true);

    // Diameters: square to the axis, half way along.
    const { min, max } = radii(body.shape, 5.37);
    expect(Math.abs(2 * max - M6.major)).toBeLessThan(0.01);
    expect(Math.abs(2 * min - M6.minor)).toBeLessThan(0.01);

    // Pitch: the crest lines on the axial section, on the +x side.
    const axial = section(body.shape, [0, 0, 0], [0, 1, 0]).filter((pts) =>
      pts.every((p) => p[0] > 0),
    );
    const onCrest = axial.filter((pts) => pts.every((p) => Math.abs(p[0] - 3) < 1e-6));
    const crests = onCrest.map((pts) => (pts[0]![2] + pts.at(-1)![2]) / 2).sort((a, b) => a - b);
    expect(crests.length).toBeGreaterThanOrEqual(9);
    const gaps = crests.slice(1).map((z, i) => z - crests[i]!);
    for (const gap of gaps) expect(Math.abs(gap - M6.pitch)).toBeLessThan(0.01);
    // A crest is the flat of P/8 the basic profile leaves at the major diameter.
    for (const pts of onCrest.slice(1, -1)) {
      expect(Math.abs(pts.at(-1)![2] - pts[0]![2])).toBeCloseTo(M6.pitch / 8, 3);
    }
    // Flanks: from root to crest at 30 degrees to the radial, 60 degrees included.
    const flanks = axial.filter((pts) => Math.abs(pts[0]![0] - pts.at(-1)![0]) > 0.4);
    expect(flanks.length).toBeGreaterThanOrEqual(18);
    for (const pts of flanks) {
      const [a, b] = [pts[0]!, pts.at(-1)!];
      const angle = (Math.atan2(Math.abs(b[2] - a[2]), Math.abs(b[0] - a[0])) * 180) / Math.PI;
      expect(angle).toBeCloseTo(30, 2);
    }

    const p = threadProfile({
      side: 'external',
      axis: Z,
      radius: 3,
      major: 6,
      pitch: 1,
      length: 10,
    });
    const reference = rodVolume(3, p.root, p.rootWidth, 1, 10);
    const volume = exactVolume(body.shape);
    expect(Math.abs(volume / reference - 1)).toBeLessThan(0.005);
    // Measured: within 1e-6 of the reference (the helices are approximated to 1e-7).
    expect(Math.abs(volume / reference - 1)).toBeLessThan(1e-5);
  }, 60_000);

  it('a left-hand thread winds the other way', () => {
    const p = threadProfile({
      side: 'external',
      axis: Z,
      radius: 3,
      major: 6,
      pitch: 1,
      length: 6,
    });
    const mid = (p.root + 3) / 2;
    // The groove's centre line is at angle 2 pi t (right hand) or -2 pi t (left) at height t P,
    // starting at world X: a quarter turn up, on +y, is in the groove only for a right hand.
    const state = (shape: ShapeId, point: Vec3) =>
      withScope(k.oc, (s) => {
        const c = s.own(
          new k.oc.BRepClass3d_SolidClassifier(raw(shape), s.own(new k.oc.gp_Pnt(...point)), 1e-7),
        );
        return c.State();
      });
    const IN = k.oc.TopAbs_State.TopAbs_IN;
    const OUT = k.oc.TopAbs_State.TopAbs_OUT;
    for (const hand of ['right', 'left'] as const) {
      const body = only(
        thread(shaft(3, 0, 6), {
          side: 'external',
          radius: 3,
          major: 6,
          pitch: 1,
          length: 6,
          hand,
          start: 'open',
          end: 'open',
        }),
      );
      expect(k.isValid(body.shape)).toBe(true);
      expect(state(body.shape, [0, mid, 2.25])).toBe(hand === 'right' ? OUT : IN);
      expect(state(body.shape, [0, -mid, 2.25])).toBe(hand === 'right' ? IN : OUT);
    }
  }, 60_000);
});

describe('internal and external M6 with clearance', () => {
  it('fit: the solids are the clearance apart and do not interfere', () => {
    const c = 0.15;
    // The shaft at the nominal diameter (its crest is trimmed to the major diameter minus the
    // clearance), the hole at the minor diameter.
    const bolt = only(
      thread(shaft(3, 0, 10), {
        side: 'external',
        radius: 3,
        major: 6,
        pitch: 1,
        length: 10,
        clearance: c,
        start: 'open',
        end: 'open',
      }),
    );
    const nut = only(
      thread(block(6, M6.minor / 2, 0, 10), {
        side: 'internal',
        radius: M6.minor / 2,
        major: 6,
        pitch: 1,
        length: 10,
        clearance: c,
        start: 'open',
        end: 'open',
      }),
    );
    expect(k.isValid(bolt.shape)).toBe(true);
    expect(k.isValid(nut.shape)).toBe(true);
    // The crest trim leaves a cylinder of its own at 3 - c, split by OCCT at its seam into one
    // piece per turn (`crest#k`, numbered by position).
    const crest = threadFaces(bolt).filter((f) => f.lineage.includes('thread#2:thread:crest'));
    expect(crest.length).toBeGreaterThanOrEqual(10);
    for (const f of crest) {
      expect(f.face.surface).toBe('cylinder');
      expect(f.face.radius).toBeCloseTo(3 - c, 9);
    }
    // Crests and roots are 2 c apart. The flanks are c apart in the axial section (2 c sin 30),
    // and in space a little less, since a helical flank leans with the helix: the normal of
    // z = k theta - (r - r0) tan 30 has an axial part 1 / sqrt(1 + tan^2 30 + (k / r)^2), so the
    // gap is c / sqrt(1 + 3/4 (k / r)^2), least at the smallest radius the flanks share (the
    // nut's crest). Measured 0.149782 for c = 0.15; the formula at r = 2.534 gives 0.149779.
    const lead = 1 / (2 * Math.PI);
    const r = M6.minor / 2;
    const flank = c / Math.sqrt(1 + 0.75 * (lead / r) ** 2);
    const gap = distance(bolt.shape, nut.shape);
    expect(gap).toBeGreaterThanOrEqual(flank - 1e-5);
    expect(gap).toBeLessThanOrEqual(c);
    const clash = k.interference([{ shapes: [bolt.shape] }, { shapes: [nut.shape] }]);
    expect(clash.pairs).toEqual([]);
    expect(clash.failures).toEqual([]);
  }, 60_000);

  it('without clearance the same threads touch', () => {
    const bolt = only(
      thread(shaft(3, 0, 6), {
        side: 'external',
        radius: 3,
        major: 6,
        pitch: 1,
        length: 6,
        start: 'open',
        end: 'open',
      }),
    );
    const nut = only(
      thread(block(6, M6.minor / 2, 0, 6), {
        side: 'internal',
        radius: M6.minor / 2,
        major: 6,
        pitch: 1,
        length: 6,
        start: 'open',
        end: 'open',
      }),
    );
    expect(distance(bolt.shape, nut.shape)).toBeLessThan(1e-4);
  }, 60_000);
});

describe('an internal M5 cut into a hole at the minor diameter', () => {
  it('records which thread faces OCCT reports as cylinders: the root of every turn', () => {
    const out = thread(block(5, M5.minor / 2, 0, 8, 'hole#3'), {
      side: 'internal',
      radius: M5.minor / 2,
      major: M5.major,
      pitch: M5.pitch,
      length: 8,
    });
    const body = only(out);
    expect(k.isValid(body.shape)).toBe(true);
    const faces = threadFaces(body);
    const cylinders = faces.filter((f) => f.face.surface === 'cylinder');
    // Golden: with the default ends (chamfered start, closed end) the cylindrical thread faces
    // are the root of every turn, 0 (the run-in, whose end reaches past the start plane) to 10,
    // each a cylinder at the major radius on the hole's axis. The flanks are B-spline surfaces,
    // the chamfer a cone, the closed end a plane.
    expect(cylinders.map((f) => f.name).sort()).toEqual(
      Array.from({ length: 11 }, (_, i) => `thread#2:thread:root:${i}`).sort(),
    );
    for (const f of cylinders) {
      expect(f.face.radius).toBeCloseTo(M5.major / 2, 9);
      expect(Math.abs(f.face.axis![2])).toBeCloseTo(1, 12);
    }
    const kinds = new Map<string, Set<string>>();
    for (const f of faces) {
      const part = f.name.split(':')[2]!.replace(/#\d+$/, '');
      kinds.set(part, (kinds.get(part) ?? new Set()).add(f.face.surface));
    }
    expect(Object.fromEntries([...kinds].map(([p, s]) => [p, [...s].sort()]))).toEqual({
      root: ['cylinder'],
      'flank-a': ['bsplinesurface'],
      'flank-b': ['bsplinesurface'],
      end: ['plane'],
      'chamfer-start': ['cone'],
    });
    // The crest strips left of the hole keep the hole's names: cylinders at the minor radius.
    const strips = body.names.faces
      .map((f, i) => ({ name: f.name, face: body.topology.faces[i]! }))
      .filter((f) => f.name.startsWith('hole#3:side:h1'));
    expect(strips.length).toBeGreaterThan(0);
    for (const f of strips) {
      expect(f.face.surface).toBe('cylinder');
      expect(f.face.radius).toBeCloseTo(M5.minor / 2, 9);
    }
  }, 60_000);
});

describe('the facts T3.1c reads from a threaded hole', () => {
  it('the cylindrical thread faces share the line of the crest strips, which are holes', () => {
    // T3.1c's thread rule: a hole group whose axis coincides, as a line, with the axis of a
    // cylindrical `:thread:` face is a threaded hole. Golden: every root turn and every crest
    // strip of an internal M5 lies on the hole's axis (x = y = 0) to 1e-9 mm, the strips are
    // holes, and so is each root (material outside it).
    const body = only(
      thread(block(5, M5.minor / 2, 0, 8, 'hole#3'), {
        side: 'internal',
        radius: M5.minor / 2,
        major: M5.major,
        pitch: M5.pitch,
        length: 8,
      }),
    );
    const named = body.names.faces.map((f, i) => ({ name: f.name, face: body.topology.faces[i]! }));
    const roots = named.filter((f) => f.name.includes(':thread:') && f.face.surface === 'cylinder');
    const strips = named.filter((f) => f.name.startsWith('hole#3:side:h1'));
    expect(roots.length).toBeGreaterThan(0);
    expect(strips.length).toBeGreaterThan(0);
    for (const f of [...roots, ...strips]) {
      const o = f.face.axisOrigin!;
      const d = f.face.axis!;
      // Distance of the origin from the z axis, and the axis direction along z (either sign).
      expect(Math.hypot(o[0], o[1])).toBeLessThan(1e-9);
      expect(Math.hypot(d[0], d[1])).toBeLessThan(1e-12);
      expect(f.face.hole).toBe(true);
    }
  }, 60_000);
});

describe('ends, trim and names', () => {
  it('closed ends stop inside the cylinder; chamfers cut both ends', () => {
    const closed = only(
      thread(shaft(3, -3, 13), {
        side: 'external',
        radius: 3,
        major: 6,
        pitch: 1,
        length: 10,
        start: 'closed',
        end: 'closed',
      }),
    );
    expect(k.isValid(closed.shape)).toBe(true);
    const names = closed.names.faces.map((f) => f.name);
    expect(names).toContain('thread#2:thread:start');
    expect(names).toContain('thread#2:thread:end');
    // The shaft's side survives round the thread.
    expect(names.some((n) => n.startsWith('extrude#1:side:c1'))).toBe(true);
    const box = k.properties(closed.shape).boundingBox!;
    expect(box.min[2]).toBeCloseTo(-3, 3);
    expect(box.max[2]).toBeCloseTo(13, 3);

    const chamfered = only(
      thread(shaft(3, 0, 10), {
        side: 'external',
        radius: 3,
        major: 6,
        pitch: 1,
        length: 10,
        start: 'chamfer',
        end: 'chamfer',
      }),
    );
    expect(k.isValid(chamfered.shape)).toBe(true);
    // Each cone is cut by the groove's run-out into a piece or two (`chamfer-start#k`).
    const cones = threadFaces(chamfered).filter((f) => f.face.surface === 'cone');
    expect(new Set(cones.map((f) => f.lineage.at(-1)))).toEqual(
      new Set(['thread#2:thread:chamfer-end', 'thread#2:thread:chamfer-start']),
    );
    // A 45 degree chamfer from the root: at the end faces only the root circle is left.
    for (const z of [1e-4, 10 - 1e-4]) {
      expect(radii(chamfered.shape, z).max).toBeLessThan(
        threadProfile({ side: 'external', axis: Z, radius: 3, major: 6, pitch: 1, length: 10 })
          .root + 1e-3,
      );
    }
  }, 60_000);

  it('a hole smaller than the minor diameter is opened up by the crest trim', () => {
    const nut = only(
      thread(block(6, 2.3, 0, 6), {
        side: 'internal',
        radius: 2.3,
        major: 6,
        pitch: 1,
        length: 6,
        clearance: 0.1,
        start: 'open',
        end: 'open',
      }),
    );
    expect(k.isValid(nut.shape)).toBe(true);
    const crest = threadFaces(nut).filter((f) => f.lineage.includes('thread#2:thread:crest'));
    expect(crest.length).toBeGreaterThan(0);
    for (const f of crest) {
      expect(f.face.surface).toBe('cylinder');
      expect(f.face.radius).toBeCloseTo(M6.minor / 2 + 0.1, 9);
    }
    expect(radii(nut.shape, 3.3).min).toBeCloseTo(M6.minor / 2 + 0.1, 6);
  }, 60_000);

  it('names are unique, never fragile, and survive a length change', () => {
    const at = (length: number) =>
      only(
        thread(shaft(3, 0, 20), {
          side: 'external',
          radius: 3,
          major: 6,
          pitch: 1,
          length,
          end: 'closed',
        }),
      ).names.faces;
    const short = at(8);
    const long = at(11.5);
    for (const faces of [short, long]) {
      const names = faces.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      // The groove's faces are named by construction; only faces OCCT split (the chamfer's
      // cone, cut by the run-out) are numbered by position.
      const own = faces.filter((f) => /^thread#2:thread:(root|flank-a|flank-b|end):?/.test(f.name));
      expect(own.length).toBeGreaterThan(20);
      for (const f of own) expect(f.fragile, f.name).toBe(false);
      for (const n of names) expect(n).not.toMatch(/opening|outer|back|\?/);
    }
    // Every turn but the last of the shorter thread is there under the same name.
    const turnOf = (n: string) => Number(/:(\d+)$/.exec(n)?.[1] ?? -1);
    const kept = short
      .map((f) => f.name)
      .filter((n) => n.startsWith('thread#2:') && turnOf(n) >= 0 && turnOf(n) < 8);
    expect(kept.length).toBeGreaterThan(20);
    const longNames = new Set(long.map((f) => f.name));
    for (const n of kept) expect(longNames).toContain(n);
  }, 60_000);

  it('fails cleanly: a cylinder out of range, and a thread that misses the body', () => {
    const bodies = shaft(3, 0, 10);
    const wrong = applyFeature(k, bodies, {
      kind: 'thread',
      id: 'thread#2',
      axis: Z,
      side: 'external',
      radius: 2,
      major: 6,
      pitch: 1,
      length: 10,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors[0]!.code).toBe('invalid');
    expect(wrong.errors[0]!.message).toMatch(
      /needs a cylinder 5\.\d+ to 8 mm across; this one is 4/,
    );
    expect(wrong.bodies.map((b) => b.shape)).toEqual(bodies.map((b) => b.shape));
    const away = applyFeature(k, bodies, {
      kind: 'thread',
      id: 'thread#2',
      axis: { origin: [20, 0, 0], direction: [0, 0, 1] },
      side: 'external',
      radius: 3,
      major: 6,
      pitch: 1,
      length: 10,
    });
    expect(away.ok).toBe(false);
    expect(away.errors[0]!.message).toMatch(/does not touch the body/);
    const before = k.shapeCount;
    applyFeature(k, bodies, {
      kind: 'thread',
      id: 'thread#2',
      axis: Z,
      side: 'external',
      radius: 3,
      major: 6,
      pitch: 1,
      length: 10,
      scope: ['nope'],
    });
    expect(k.shapeCount).toBe(before);
  }, 60_000);
});

describe('time', () => {
  // Measured on the development machine (Node 26, single-threaded wasm): about 1 s for the
  // tools and the cut together; the tools alone about 0.2 s. The budget leaves room for slower
  // CI runners.
  const BUDGET_MS = 4000;

  it(`an M6 x 20 mm internal thread in a block takes under ${BUDGET_MS} ms`, () => {
    const bodies = block(8, M6.minor / 2, 0, 20);
    const t0 = performance.now();
    const out = thread(bodies, {
      side: 'internal',
      radius: M6.minor / 2,
      major: 6,
      pitch: 1,
      length: 20,
      start: 'chamfer',
      end: 'chamfer',
    });
    const ms = performance.now() - t0;
    expect(k.isValid(only(out).shape)).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);
});
