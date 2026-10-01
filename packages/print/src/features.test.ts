import type { EdgeInfo, FaceInfo, Topology, Vec3, VertexInfo } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import {
  analyzeHoles,
  isThreadFace,
  lineAngle,
  pointLineDistance,
  type FaceNameSource,
  type HoleReport,
} from './features';
import { quatFromAxisAngle } from './geometry';
import { deg } from './test-helpers';

const X: Vec3 = [1, 0, 0];
const Z: Vec3 = [0, 0, 1];

/** A cylindrical face as `topology()` reports it. */
function cyl(index: number, diameter: number, axis: Vec3, axisOrigin: Vec3, hole = true): FaceInfo {
  return {
    index,
    surface: 'cylinder',
    centroid: axisOrigin,
    area: 1,
    normal: null,
    axis,
    radius: diameter / 2,
    axisOrigin,
    hole,
  };
}

function plane(index: number): FaceInfo {
  return {
    index,
    surface: 'plane',
    centroid: [0, 0, 0],
    area: 1,
    normal: Z,
    axis: null,
    radius: null,
    axisOrigin: null,
    hole: null,
  };
}

/** Faces numbered in order from 1: pass the builders without their index. */
function topo(...faces: ((index: number) => FaceInfo)[]): Pick<Topology, 'faces'> {
  return { faces: faces.map((f, i) => f(i + 1)) };
}

const hole =
  (d: number, axis: Vec3 = Z, origin: Vec3 = [0, 0, 0]) =>
  (i: number) =>
    cyl(i, d, axis, origin);
const pin =
  (d: number, axis: Vec3 = Z, origin: Vec3 = [0, 0, 0]) =>
  (i: number) =>
    cyl(i, d, axis, origin, false);

/** The kernel's `UNNAMED` slot value. */
const UNNAMED = 0xffffffff;

const issues = (r: HoleReport) => r.issues.map((i) => `${i.kind} ${i.faces.join(',')}`);

describe('helpers', () => {
  it('compares axes as lines', () => {
    expect(lineAngle([0, 0, 1], [0, 0, -1])).toBe(0);
    expect(lineAngle([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 15);
    // Accurate near zero, where acos(|dot|) would round to 0.
    expect(lineAngle([1, 0, 0], [1, 1e-12, 0])).toBeCloseTo(1e-12, 20);
    expect(pointLineDistance([3, 4, 7], [0, 0, 0], [0, 0, 5])).toBeCloseTo(5, 12);
  });

  it('a thread face is any name with the :thread: segment, under any prefix', () => {
    expect(isThreadFace('thread#5:thread:root')).toBe(true);
    expect(isThreadFace('thread#5:thread:root:3')).toBe(true);
    expect(isThreadFace('pattern#6:i2/thread#5:thread:root')).toBe(true);
    expect(isThreadFace('hole#3:side:h1')).toBe(false);
    expect(isThreadFace(null)).toBe(false);
  });
});

describe('small holes, at a 0.4 mm nozzle (minimum 0.8 mm)', () => {
  it('flags 0.6, not 0.8 (exactly the minimum), 0.8 minus 1e-7 or 3', () => {
    const r = analyzeHoles(
      topo(
        hole(0.6, Z, [0, 0, 0]),
        hole(0.8, Z, [10, 0, 0]),
        hole(0.8 - 1e-7, Z, [20, 0, 0]),
        hole(3, Z, [30, 0, 0]),
        plane,
      ),
    );
    expect(r.groups.map((g) => g.faces)).toEqual([[1], [2], [3], [4]]);
    expect(issues(r)).toEqual(['smallHole 1']);
    expect(r.issues[0]).toMatchObject({ diameter: 0.6 });
    expect((r.issues[0] as { minimum: number }).minimum).toBeCloseTo(0.8, 12);
  });

  it('pins are reported as groups but never flagged as holes', () => {
    const r = analyzeHoles(topo(pin(0.5)));
    expect(r.groups).toMatchObject([{ side: 'pin', faces: [1], diameter: 0.5 }]);
    expect(r.issues).toEqual([]);
  });
});

describe('horizontal holes (teardrop above 3 mm)', () => {
  it('flags a horizontal 3.2 mm hole only', () => {
    const tilted: Vec3 = [Math.cos(deg(5)), 0, Math.sin(deg(5))];
    const r = analyzeHoles(
      topo(
        hole(3.2, X, [0, 0, 0]),
        hole(3, X, [0, 10, 0]),
        hole(3 + 1e-7, X, [0, 20, 0]),
        hole(5, Z, [0, 30, 0]),
        hole(4, tilted, [0, 40, 0]),
      ),
    );
    expect(issues(r)).toEqual(['teardrop 1']);
    expect(r.groups.map((g) => g.horizontal)).toEqual([true, true, true, false, false]);
  });

  it('horizontal is judged after the orientation: a vertical hole laid on its side', () => {
    const report = analyzeHoles(topo(hole(5, Z)), {
      placement: { rotation: quatFromAxisAngle(X, Math.PI / 2), translation: [0, 0, 0] },
    });
    expect(issues(report)).toEqual(['teardrop 1']);
    // Within a degree of the bed plane counts as horizontal, two degrees does not.
    const nearly = (a: number) =>
      analyzeHoles(topo(hole(5, Z)), {
        placement: { rotation: quatFromAxisAngle(X, Math.PI / 2 - deg(a)), translation: [0, 0, 0] },
      }).issues.length;
    expect(nearly(0.9)).toBe(1);
    expect(nearly(2)).toBe(0);
  });

  it('thresholds come from the caller', () => {
    const r = analyzeHoles(topo(hole(3.2, X), hole(0.9, Z, [9, 9, 0])), {
      thresholds: { minHole: 1, teardrop: 4 },
    });
    expect(issues(r)).toEqual(['smallHole 2']);
  });
});

describe('grouping', () => {
  it('a horizontal 4.2 mm hole split by a slot is one hole with one flag listing its faces', () => {
    // Three pieces of one bore along x, the middle one stored with its axis the other way and
    // its origin elsewhere on the line, with planes in between.
    const r = analyzeHoles(
      topo(
        hole(4.2, [1, 0, 0], [0, 5, 5]),
        plane,
        hole(4.2, [-1, 0, 0], [7, 5, 5]),
        plane,
        hole(4.2, [1, 0, 0], [-3, 5, 5]),
      ),
    );
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ side: 'hole', faces: [1, 3, 5], horizontal: true });
    expect(issues(r)).toEqual(['teardrop 1,3,5']);
  });

  it('two faces of the same radius on parallel axes 1 mm apart are two holes', () => {
    const r = analyzeHoles(topo(hole(4.2, X, [0, 0, 0]), hole(4.2, X, [0, 1, 0])));
    expect(r.groups.map((g) => g.faces)).toEqual([[1], [2]]);
    expect(issues(r)).toEqual(['teardrop 1', 'teardrop 2']);
  });

  it('a hole and a pin of the same axis and radius are not grouped', () => {
    const r = analyzeHoles(topo(hole(4.2, X), pin(4.2, X, [5, 0, 0])));
    expect(r.groups.map((g) => `${g.side} ${g.faces}`)).toEqual(['hole 1', 'pin 2']);
  });

  it('different radii on one axis are different holes (a counterbore and its hole)', () => {
    const r = analyzeHoles(topo(hole(4.5, Z), hole(8, Z, [0, 0, 3])));
    expect(r.groups.map((g) => g.faces)).toEqual([[1], [2]]);
  });

  it('two separate bores in line with the same radius are one hole (documented)', () => {
    // Two holes on either side of a 20 mm gap, on one line: grouping cannot tell them apart.
    const r = analyzeHoles(topo(hole(2, Z, [0, 0, 0]), hole(2, Z, [0, 0, 30])));
    expect(r.groups.map((g) => g.faces)).toEqual([[1, 2]]);
  });

  it('axes a hair off the line or the angle tolerance are not the same axis', () => {
    const r = analyzeHoles(
      topo(hole(2, Z, [0, 0, 0]), hole(2, Z, [1e-5, 0, 0]), hole(2, [1e-7, 0, 1], [0, 0, 0])),
    );
    expect(r.groups.map((g) => g.faces)).toEqual([[1], [2], [3]]);
  });

  it('faces without the T3.1c fields (an old topology) are skipped', () => {
    const old: FaceInfo = { ...cyl(1, 2, Z, [0, 0, 0]) };
    delete old.axisOrigin;
    delete old.hole;
    expect(analyzeHoles({ faces: [old] }).groups).toEqual([]);
  });
});

describe('the thread rule', () => {
  // A hand-built fixture: a topology plus the mesh's face name slots and a name table. Faces 1
  // and 2: a horizontal 4.13 mm hole on the x axis named after hole#3 (crest strips of a
  // modelled M5 thread), face 3 the thread's root, a cylinder of 5 mm on the same axis, face 4 a
  // flank (not a cylinder), faces 5 and 6 another 4.13 mm hole of hole#4 on a parallel axis 10 mm
  // away, face 7 a plane with no name.
  const names = (thread: string): FaceNameSource => ({
    names: [
      'hole#3:side:h1',
      'hole#3:side:h1#2',
      thread,
      'thread#5:thread:flank-a',
      'hole#4:side:h1',
      'hole#4:side:h1#2',
    ],
    faceNames: Uint32Array.from([0, 1, 2, 3, 4, 5, UNNAMED]),
  });
  const fixture = topo(
    hole(4.13, X, [0, 0, 5]),
    hole(4.13, [-1, 0, 0], [4, 0, 5]),
    hole(5, X, [2, 0, 5]),
    (i) => ({ ...plane(i), surface: 'bsplinesurface', normal: null }),
    hole(4.13, X, [0, 10, 5]),
    hole(4.13, X, [6, 10, 5]),
    plane,
  );

  for (const thread of ['thread#5:thread:root', 'pattern#6:i2/thread#5:thread:root']) {
    it(`skips the hole coaxial with ${thread}, reports the other one`, () => {
      const r = analyzeHoles(fixture, { names: names(thread) });
      expect(r.threaded.map((g) => g.faces)).toEqual([[1, 2]]);
      expect(r.groups.map((g) => g.faces)).toEqual([[5, 6]]);
      // The thread face is never a hole itself; the other hole gets its teardrop flag.
      expect(issues(r)).toEqual(['teardrop 5,6']);
    });
  }

  it('without names both holes and the root are holes', () => {
    const r = analyzeHoles(fixture);
    expect(r.threaded).toEqual([]);
    expect(r.groups.map((g) => g.faces)).toEqual([[1, 2], [3], [5, 6]]);
    expect(issues(r)).toEqual(['teardrop 1,2', 'teardrop 3', 'teardrop 5,6']);
  });
});

describe('partial cylinders (from edges and vertices)', () => {
  /**
   * Faces of radius 2 about the z axis, 0 to 10 high, each given as its angular span in degrees
   * [from, to]; a span of 360 is a whole face with a seam. Every face gets its two arc edges
   * (midpoints half way round the span) and, unless whole, its two straight edges.
   */
  function spans(...list: [number, number][]): Pick<Topology, 'faces' | 'edges' | 'vertices'> {
    const r = 2;
    const at = (deg: number, z: number): Vec3 => [
      r * Math.cos((deg * Math.PI) / 180),
      r * Math.sin((deg * Math.PI) / 180),
      z,
    ];
    const faces: FaceInfo[] = [];
    const edges: EdgeInfo[] = [];
    const vertices: VertexInfo[] = [];
    const vertex = (p: Vec3, face: number) => {
      vertices.push({ index: vertices.length + 1, point: p, faces: [face] });
      return vertices.length;
    };
    const edge = (face: number, midpoint: Vec3, ends: number[], seam = false) =>
      edges.push({
        index: edges.length + 1,
        faces: [face],
        seam,
        curve: seam ? 'line' : 'circle',
        midpoint,
        length: 1,
        vertices: ends,
      });
    list.forEach(([from, to], i) => {
      const f = i + 1;
      faces.push(cyl(f, 2 * r, Z, [0, 0, 0]));
      const mid = (from + to) / 2;
      if (to - from >= 360) {
        const v0 = vertex(at(from, 0), f);
        const v1 = vertex(at(from, 10), f);
        edge(f, at(mid, 0), [v0]);
        edge(f, at(mid, 10), [v1]);
        edge(f, at(from, 5), [v0, v1], true);
        return;
      }
      const corners = [at(from, 0), at(to, 0), at(to, 10), at(from, 10)].map((p) => vertex(p, f));
      edge(f, at(mid, 0), [corners[0]!, corners[1]!]);
      edge(f, at(mid, 10), [corners[3]!, corners[2]!]);
      edge(f, at(from, 5), [corners[0]!, corners[3]!]);
      edge(f, at(to, 5), [corners[1]!, corners[2]!]);
    });
    return { faces, edges, vertices };
  }

  it('a whole face (with a seam) is a hole', () => {
    const r = analyzeHoles(spans([0, 360]));
    expect(r.groups.map((g) => g.faces)).toEqual([[1]]);
    expect(r.partial).toEqual([]);
  });

  it('a quarter (a fillet round) and a half (a slot end) are partial', () => {
    expect(analyzeHoles(spans([0, 90])).partial.map((g) => g.faces)).toEqual([[1]]);
    expect(analyzeHoles(spans([30, 210])).partial.map((g) => g.faces)).toEqual([[1]]);
    expect(analyzeHoles(spans([0, 90])).groups).toEqual([]);
  });

  it('a bore split by slots, its seam cut away, is still one hole', () => {
    const r = analyzeHoles(spans([10, 160], [190, 340]));
    expect(r.groups.map((g) => g.faces)).toEqual([[1, 2]]);
    expect(r.partial).toEqual([]);
  });
});
