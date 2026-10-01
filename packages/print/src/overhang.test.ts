import { describe, expect, it } from 'vitest';
import {
  ANGLE_TOLERANCE,
  DEFAULT_OVERHANG_THRESHOLD,
  DEFAULT_WARNING_BAND,
  OVERHANG_CLASSES,
  angleFromVertical,
  classifyAngle,
  classifyOverhangs,
  overhangToSupportThreshold,
  supportThresholdToOverhang,
  type OverhangClass,
  type OverhangResult,
} from './overhang';
import { orientationPlacement } from './orientation';
import {
  boxFaces,
  deg,
  meshFromFaces,
  placeFaces,
  prismFaces,
  type TestFace,
} from './test-helpers';
import type { Vec3 } from './geometry';

const cls = (r: OverhangResult, triangle: number): OverhangClass =>
  OVERHANG_CLASSES[r.classes[triangle]!]!;

/** The classes of every triangle of a face (1-based). */
function faceClasses(r: OverhangResult, triangleFaces: Uint32Array, face: number): OverhangClass[] {
  const out: OverhangClass[] = [];
  triangleFaces.forEach((f, k) => {
    if (f === face) out.push(cls(r, k));
  });
  return out;
}

/** A single triangle facing `normal`, its normal stored at float32 precision. */
function triangleFacing(normal: Vec3, z = 10): TestFace {
  // Any triangle will do; the class comes from the stored vertex normals.
  return {
    normal,
    points: [
      [0, 0, z],
      [1, 0, z + 1],
      [0, 1, z + 2],
    ],
  };
}

describe('angle conventions', () => {
  it('measures from vertical: walls 0, a 45 degree underside pi/4, a ceiling pi/2, up negative', () => {
    expect(angleFromVertical(1, 0, 0)).toBe(0);
    expect(angleFromVertical(Math.SQRT1_2, 0, -Math.SQRT1_2)).toBeCloseTo(Math.PI / 4, 15);
    expect(angleFromVertical(0, 0, -1)).toBe(Math.PI / 2);
    expect(angleFromVertical(0, 0, 1)).toBe(-Math.PI / 2);
  });

  it("converts OrcaSlicer's support_threshold_angle (from horizontal) both ways", () => {
    expect(supportThresholdToOverhang(deg(30))).toBeCloseTo(deg(60), 15);
    expect(overhangToSupportThreshold(deg(60))).toBeCloseTo(deg(30), 15);
    expect(DEFAULT_OVERHANG_THRESHOLD).toBeCloseTo(supportThresholdToOverhang(deg(30)), 15);
    expect(DEFAULT_WARNING_BAND).toBeCloseTo(deg(10), 15);
    expect(ANGLE_TOLERANCE).toBe(1e-6);
  });

  it('classifies angles at and around the boundaries', () => {
    expect(classifyAngle(deg(-90))).toBe('ok');
    expect(classifyAngle(0)).toBe('ok');
    expect(classifyAngle(deg(49))).toBe('ok');
    expect(classifyAngle(deg(50))).toBe('ok'); // the lower edge of the band is not steep
    expect(classifyAngle(deg(50) + 2e-6)).toBe('steep');
    expect(classifyAngle(deg(55))).toBe('steep');
    expect(classifyAngle(deg(60))).toBe('steep'); // exactly at the threshold
    expect(classifyAngle(deg(60) + 0.9e-6)).toBe('steep'); // within the tolerance
    expect(classifyAngle(deg(60) + 1.1e-6)).toBe('overhang');
    expect(classifyAngle(deg(61))).toBe('overhang');
    expect(classifyAngle(deg(89.9))).toBe('overhang');
    expect(classifyAngle(Math.PI / 2 - 0.9e-6)).toBe('downwardFlat');
    expect(classifyAngle(Math.PI / 2)).toBe('downwardFlat');
  });

  it('takes a custom threshold and band', () => {
    expect(classifyAngle(deg(45), deg(45), deg(5))).toBe('steep');
    expect(classifyAngle(deg(46), deg(45), deg(5))).toBe('overhang');
    expect(classifyAngle(deg(40), deg(45), deg(5))).toBe('ok');
    expect(classifyAngle(deg(55), deg(70), 0)).toBe('ok');
  });
});

describe('classifyOverhangs', () => {
  it('a cube is all ok on its sides and top, all onBed at the bottom', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 10]));
    const r = classifyOverhangs(mesh);
    expect(r.bedZ).toBe(0);
    expect(r.faces).toHaveLength(6);
    expect(faceClasses(r, mesh.triangleFaces, 1)).toEqual(['onBed', 'onBed']);
    for (let f = 2; f <= 6; f++) {
      expect(faceClasses(r, mesh.triangleFaces, f)).toEqual(['ok', 'ok']);
      expect(r.faces[f - 1]!.worst).toBe('ok');
      expect(r.faces[f - 1]!.areas.ok).toBeCloseTo(100, 9);
    }
    expect(r.faces[0]).toEqual({
      face: 1,
      worst: 'onBed',
      areas: { ok: 0, steep: 0, overhang: 0, downwardFlat: 0, onBed: 100 },
      maxAngle: Math.PI / 2,
      triangles: 2,
    });
  });

  it('a cube floating above the bed has a downward-flat bottom when the bed is given', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 5], [10, 10, 15]));
    expect(classifyOverhangs(mesh).faces[0]!.worst).toBe('onBed'); // its own lowest z
    const r = classifyOverhangs(mesh, { bedZ: 0 });
    expect(r.bedZ).toBe(0);
    expect(r.faces[0]!.worst).toBe('downwardFlat');
    expect(r.faces[0]!.areas.downwardFlat).toBeCloseTo(100, 9);
  });

  it('a 45 degree chamfer below a ledge is exactly 45 degrees, ok, and the ledge is downward-flat', () => {
    // Profile in x-z: a column with a shelf sticking out to the right at z 10 to 20; the
    // underside of the shelf is a 45 degree chamfer from (10, 10) to (15, 15), then a flat
    // downward ledge from (15, 15) to (20, 15).
    const profile: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [15, 15],
      [20, 15],
      [20, 20],
      [0, 20],
    ];
    const mesh = meshFromFaces(prismFaces(profile, 8));
    const r = classifyOverhangs(mesh);
    const chamfer = r.faces[2]!; // edge (10, 10) -> (15, 15)
    expect(Math.abs(chamfer.maxAngle - Math.PI / 4)).toBeLessThan(1e-7);
    expect(chamfer.worst).toBe('ok');
    expect(chamfer.areas.ok).toBeCloseTo(5 * Math.SQRT2 * 8, 4);
    const ledge = r.faces[3]!; // edge (15, 15) -> (20, 15)
    expect(ledge.worst).toBe('downwardFlat');
    expect(ledge.maxAngle).toBe(Math.PI / 2);
    expect(ledge.areas.downwardFlat).toBeCloseTo(40, 6);
    expect(r.faces[0]!.worst).toBe('onBed');
    expect(r.faces[5]!.worst).toBe('ok'); // the top
    expect(r.faces[7]!.worst).toBe('ok'); // caps
    expect(r.faces[8]!.worst).toBe('ok');
  });

  it('with a 40 degree threshold the same chamfer is an overhang', () => {
    const profile: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [15, 15],
      [15, 20],
      [0, 20],
    ];
    const r = classifyOverhangs(meshFromFaces(prismFaces(profile, 8)), {
      threshold: deg(40),
    });
    expect(r.faces[2]!.worst).toBe('overhang');
  });

  it('a face at exactly 60 degrees from vertical, normals rounded to float32, is steep; 61 is overhang', () => {
    // Underside slopes rising to the right at 30 degrees (60 from vertical) and at 29 (61).
    const shelf = (fromVertical: number) => {
      const slope = Math.PI / 2 - fromVertical;
      const run = 10 * Math.cos(slope);
      const rise = 10 * Math.sin(slope);
      const profile: [number, number][] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [10 + run, 10 + rise],
        [10 + run, 30],
        [0, 30],
      ];
      return meshFromFaces(prismFaces(profile, 5));
    };
    const at60 = shelf(deg(60));
    const n = at60.normals;
    // The stored normal really is float32 and really is off the exact value.
    const sloped = at60.faceRanges[4]!; // face 3's first index
    const v = at60.indices[sloped]!;
    expect(n[3 * v]).not.toBe(Math.cos(deg(60)));
    const r60 = classifyOverhangs(at60);
    expect(Math.abs(r60.faces[2]!.maxAngle - deg(60))).toBeLessThan(1e-6);
    expect(r60.faces[2]!.worst).toBe('steep');

    const r61 = classifyOverhangs(shelf(deg(61)));
    expect(r61.faces[2]!.worst).toBe('overhang');
    expect(r61.faces[2]!.maxAngle).toBeCloseTo(deg(61), 6);
  });

  it('a 60 degree normal in every direction, rounded to float32, is steep; 1e-9 rad would not cover it', () => {
    let worstError = 0;
    const faces: TestFace[] = [];
    for (let i = 0; i < 360; i++) {
      const phi = deg(i);
      const a = deg(60);
      faces.push(
        triangleFacing([Math.cos(a) * Math.cos(phi), Math.cos(a) * Math.sin(phi), -Math.sin(a)]),
      );
    }
    const mesh = meshFromFaces(faces);
    const r = classifyOverhangs(mesh, { bedZ: -100 });
    for (let k = 0; k < r.angles.length; k++) {
      expect(cls(r, k)).toBe('steep');
      worstError = Math.max(worstError, r.angles[k]! - deg(60));
    }
    // Float32 rounding pushes some of them past the threshold by more than 1e-9 rad, but not
    // past the documented tolerance.
    expect(worstError).toBeGreaterThan(1e-9);
    expect(worstError).toBeLessThan(ANGLE_TOLERANCE);
  });

  it('lay-flat on a slanted face puts that face on the bed facing down', () => {
    // A wedge with a slanted top, then tilted arbitrarily so the slanted face's normal has
    // x, y and z components.
    const wedge = prismFaces(
      [
        [0, 0],
        [20, 0],
        [0, 10],
      ],
      6,
    );
    const tilt = orientationPlacement({ kind: 'rotate', x: 0.3, y: -0.7, z: 1.1 }, []);
    const faces = placeFaces(wedge, tilt);
    const slanted = faces[1]!; // edge (20, 0) -> (0, 10)
    expect(Math.abs(slanted.normal[0]) > 0.05 && Math.abs(slanted.normal[1]) > 0.05).toBe(true);
    const mesh = meshFromFaces(faces);

    for (const turn of [0, 0.8]) {
      const placement = orientationPlacement(
        { kind: 'layFlat', normal: slanted.normal, turn },
        mesh.positions,
      );
      const r = classifyOverhangs(mesh, { placement });
      expect(r.bedZ).toBeCloseTo(0, 5);
      expect(r.faces[1]!.worst).toBe('onBed');
      expect(r.faces[1]!.areas.onBed).toBeCloseTo(Math.hypot(20, 10) * 6, 3);
      expect(r.faces[1]!.maxAngle).toBeCloseTo(Math.PI / 2, 6);
      // The former bottom now stands at the slope's angle; nothing else is on the bed.
      expect(r.faces.filter((f) => f.worst === 'onBed')).toHaveLength(1);
    }
  });

  it('applies a placement to normals: a cube turned upside down still rests on a face', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [10, 10, 10]));
    const placement = orientationPlacement(
      { kind: 'rotate', x: Math.PI, y: 0, z: 0 },
      mesh.positions,
    );
    const r = classifyOverhangs(mesh, { placement });
    expect(r.faces[1]!.worst).toBe('onBed'); // the old top
    expect(r.faces[0]!.worst).toBe('ok'); // the old bottom faces up
  });

  it('works without face data and falls back to the winding when vertex normals cancel', () => {
    const mesh = meshFromFaces([triangleFacing([0, 0, -1])]);
    const bare = { positions: mesh.positions, normals: new Float32Array(9), indices: mesh.indices };
    const r = classifyOverhangs(bare, { bedZ: -1 });
    expect(r.faces).toEqual([]);
    // Winding of (0,0,10), (1,0,11), (0,1,12) gives normal (-1, -2, 1): it faces up.
    expect(r.angles[0]!).toBeCloseTo(-Math.asin(1 / Math.sqrt(6)), 12);
    expect(cls(r, 0)).toBe('ok');
  });

  it('an empty mesh gives empty results', () => {
    const r = classifyOverhangs({
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      triangleFaces: new Uint32Array(0),
      faceRanges: new Uint32Array(0),
    });
    expect(r.classes).toHaveLength(0);
    expect(r.faces).toEqual([]);
    expect(r.bedZ).toBe(0);
  });

  it('reports the worst class and the area per class of a mixed face', () => {
    // One "face" made of a steep triangle and an overhanging one (as a curved face would be).
    const a = deg(55);
    const b = deg(70);
    const mesh = meshFromFaces([
      triangleFacing([Math.cos(a), 0, -Math.sin(a)]),
      triangleFacing([Math.cos(b), 0, -Math.sin(b)]),
    ]);
    const triangleFaces = new Uint32Array([1, 1]);
    const r = classifyOverhangs(
      { ...mesh, triangleFaces, faceRanges: new Uint32Array([0, 6]) },
      { bedZ: 0 },
    );
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0]!.worst).toBe('overhang');
    const area = Math.sqrt(6) / 2;
    expect(r.faces[0]!.areas.steep).toBeCloseTo(area, 9);
    expect(r.faces[0]!.areas.overhang).toBeCloseTo(area, 9);
    expect(r.faces[0]!.maxAngle).toBeCloseTo(b, 6);
  });
});
