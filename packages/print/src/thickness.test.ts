import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle } from './geometry';
import { boxFaces, meshFromFaces, prismFaces, type TestMesh } from './test-helpers';
import {
  LENGTH_TOLERANCE,
  THICKNESS_FLAGS,
  analyzeThickness,
  type ThicknessIssue,
  type ThicknessResult,
} from './thickness';
import { printThresholds } from './thresholds';

/** Issues as `kind body:face`, sorted, for compact comparisons. */
const summary = (r: ThicknessResult) => r.issues.map((i) => `${i.kind} ${i.body}:${i.face}`).sort();

/** The issue of a kind on a face. */
function issue(r: ThicknessResult, kind: ThicknessIssue['kind'], body: number, face: number) {
  const found = r.issues.find((i) => i.kind === kind && i.body === body && i.face === face);
  expect(found, `${kind} on ${body}:${face}`).toBeDefined();
  return found!;
}

/** Per-triangle values of one face. */
function faceValues(mesh: TestMesh, values: Float32Array, face: number): number[] {
  return [...values].filter((_, t) => mesh.triangleFaces[t] === face);
}

describe('thresholds', () => {
  it('default from the nozzle: 25% feature, two line widths, 0.2 gap, two nozzles, 3 mm', () => {
    const t = printThresholds(0.4);
    expect(t.minFeature).toBeCloseTo(0.1, 12);
    expect(t.minWall).toBeCloseTo(0.84, 12);
    expect(t.minGap).toBe(0.2);
    expect(t.minHole).toBeCloseTo(0.8, 12);
    expect(t.teardrop).toBe(3);
    expect(printThresholds(0.6).minWall).toBeCloseTo(1.24, 12);
    expect(printThresholds(0.4, { minWall: 1.2, teardrop: 4 })).toMatchObject({
      minWall: 1.2,
      teardrop: 4,
      minGap: 0.2,
    });
  });
});

describe('wall thickness', () => {
  it('a 1 mm wall measures 1.000 mm and is not thin', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [20, 20, 1]));
    const r = analyzeThickness([{ mesh }]);
    // Faces 1 and 2 are the bottom and the top: the wall is measured between them.
    for (const face of [1, 2]) {
      for (const v of faceValues(mesh, r.bodies[0]!.thickness, face)) {
        expect(Math.abs(v - 1)).toBeLessThan(1e-4);
      }
      expect(r.bodies[0]!.faces[face - 1]!.minThickness).toBeCloseTo(1, 4);
    }
    // The sides see 20 mm of material, beyond the 10 mm range.
    expect(faceValues(mesh, r.bodies[0]!.thickness, 3).every((v) => v === Infinity)).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.bodies[0]!.flags.every((f) => f === 0)).toBe(true);
  });

  it('measures the same after a placement: thickness does not depend on orientation', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [20, 20, 1]));
    const placement = {
      rotation: quatFromAxisAngle([1, 1, 0], 0.7),
      translation: [3, -4, 5] as const,
    };
    const r = analyzeThickness([{ mesh, placement }]);
    for (const v of faceValues(mesh, r.bodies[0]!.thickness, 2)) {
      expect(Math.abs(v - 1)).toBeLessThan(1e-4);
    }
  });

  it('a 0.3 mm fin is below the minimum wall, and only the fin', () => {
    // A 10 x 5 base with a fin 0.3 wide and 5 high on top, 10 deep. Faces 4 and 6 are the
    // fin's sides.
    const mesh = meshFromFaces(
      prismFaces(
        [
          [0, 0],
          [10, 0],
          [10, 5],
          [5.15, 5],
          [5.15, 10],
          [4.85, 10],
          [4.85, 5],
          [0, 5],
        ],
        10,
      ),
    );
    const r = analyzeThickness([{ mesh }]);
    expect(summary(r)).toEqual(['thinWall 0:4', 'thinWall 0:6']);
    for (const face of [4, 6]) {
      const i = issue(r, 'thinWall', 0, face);
      expect(i.value).toBeCloseTo(0.3, 5);
      expect(i.area).toBeCloseTo(5 * 10, 6); // the whole side
    }
    // Flags per triangle: the fin sides are thin, nothing is below the minimum feature.
    mesh.triangleFaces.forEach((f, t) => {
      expect(r.bodies[0]!.flags[t]).toBe(f === 4 || f === 6 ? THICKNESS_FLAGS.thinWall : 0);
    });
  });

  it('a wall exactly at the minimum is not thin; one 1 um under it is', () => {
    const t = printThresholds(0.4);
    const at = analyzeThickness([{ mesh: meshFromFaces(boxFaces([0, 0, 0], [5, 5, t.minWall])) }]);
    expect(at.issues).toEqual([]);
    const under = analyzeThickness([
      { mesh: meshFromFaces(boxFaces([0, 0, 0], [5, 5, t.minWall - 1e-3])) },
    ]);
    expect(summary(under)).toEqual(['thinWall 0:1', 'thinWall 0:2']);
    // The tolerance covers float32 positions and no more.
    expect(LENGTH_TOLERANCE).toBeLessThan(1e-3);
  });

  it('a 0.05 mm sheet is below the minimum feature: not printed at all', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [5, 5, 0.05]));
    const r = analyzeThickness([{ mesh }]);
    expect(summary(r)).toEqual(['belowMinFeature 0:1', 'belowMinFeature 0:2']);
    expect(issue(r, 'belowMinFeature', 0, 2).value).toBeCloseTo(0.05, 5);
    expect(issue(r, 'belowMinFeature', 0, 2).area).toBeCloseTo(25, 6);
  });

  it('samples large triangles several times, each standing for its share of the area', () => {
    // A 2-triangle top face of 20 x 20: longest edge 28.3, so 8 x 8 pieces per triangle.
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [20, 20, 0.5]));
    const r = analyzeThickness([{ mesh }]);
    expect(issue(r, 'thinWall', 0, 2).area).toBeCloseTo(400, 6);
    expect(r.bodies[0]!.samples).toBeGreaterThan(12 * 8);
    const coarse = analyzeThickness([{ mesh }], { maxSplit: 1 });
    expect(coarse.bodies[0]!.samples).toBe(12);
    expect(issue(coarse, 'thinWall', 0, 2).area).toBeCloseTo(400, 6);
  });
});

describe('gaps', () => {
  it('a 0.1 mm slot between two blocks (two bodies) is a narrow gap on both sides', () => {
    const a = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 10]));
    const b = meshFromFaces(boxFaces([10.1, 0, 0], [20.1, 10, 10]));
    const r = analyzeThickness([{ mesh: a }, { mesh: b }]);
    // Face 6 is +x of the first block, face 5 is -x of the second.
    expect(summary(r)).toEqual(['narrowGap 0:6', 'narrowGap 1:5']);
    expect(issue(r, 'narrowGap', 0, 6).value).toBeCloseTo(0.1, 5);
    expect(issue(r, 'narrowGap', 1, 5).area).toBeCloseTo(100, 6);
  });

  it('the same gap between bodies placed next to each other', () => {
    const a = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 10]));
    const r = analyzeThickness([
      { mesh: a },
      { mesh: a, placement: { rotation: [0, 0, 0, 1], translation: [10.1, 0, 0] } },
    ]);
    expect(summary(r)).toEqual(['narrowGap 0:6', 'narrowGap 1:5']);
  });

  it('a 0.1 mm slot in one body is a narrow gap between its walls', () => {
    // Two blocks joined at the bottom, with a slot 0.1 wide from z = 2 up. Faces 4 and 6 are the
    // slot's walls, face 5 its floor.
    const mesh = meshFromFaces(
      prismFaces(
        [
          [0, 0],
          [20.1, 0],
          [20.1, 10],
          [10.1, 10],
          [10.1, 2],
          [10, 2],
          [10, 10],
          [0, 10],
        ],
        10,
      ),
    );
    const r = analyzeThickness([{ mesh }]);
    expect(summary(r)).toEqual(['narrowGap 0:4', 'narrowGap 0:6']);
    expect(issue(r, 'narrowGap', 0, 4).value).toBeCloseTo(0.1, 5);
    expect(issue(r, 'narrowGap', 0, 6).area).toBeCloseTo(8 * 10, 6);
  });

  it('a gap exactly at the minimum is not narrow; bodies that touch have no gap', () => {
    const a = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 10]));
    const at = meshFromFaces(boxFaces([10.2, 0, 0], [20.2, 10, 10]));
    expect(analyzeThickness([{ mesh: a }, { mesh: at }]).issues).toEqual([]);
    const touching = meshFromFaces(boxFaces([10, 0, 0], [20, 10, 10]));
    expect(analyzeThickness([{ mesh: a }, { mesh: touching }]).issues).toEqual([]);
  });

  it('a mesh without face ids reports per body (face 0)', () => {
    const { positions, normals, indices } = meshFromFaces(boxFaces([0, 0, 0], [5, 5, 0.5]));
    const r = analyzeThickness([{ mesh: { positions, normals, indices } }]);
    expect(r.bodies[0]!.faces).toEqual([]);
    expect(summary(r)).toEqual(['thinWall 0:0']);
    expect(r.issues[0]!.area).toBeCloseTo(50, 6);
    expect(r.issues[0]!.value).toBeCloseTo(0.5, 5);
  });

  it('refuses a triangle naming a vertex the mesh does not have', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [1, 1, 1]));
    const bad = { ...mesh, indices: Uint32Array.from([...mesh.indices, 0, 1, 999]) };
    expect(() => analyzeThickness([{ mesh: bad }])).toThrow(/vertex 999/);
  });
});
