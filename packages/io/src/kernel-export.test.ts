// Real kernel meshes through the export path: every body the kernel makes
// welds into a watertight mesh (seams, poles and apexes included) at every
// tolerance preset, its volume approaches the exact B-rep volume as the
// tolerance tightens, and the STL and 3MF written from it read back intact,
// for an assembly too (each body meshed once, instances placed).

import { applyFeature, type FeatureInput, type Kernel, type ShapeId } from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXPORT_TOLERANCES,
  deflectionOf,
  export3mf,
  export3mfAssembly,
  exportMesh,
  exportStl,
  exportStlAssembly,
  type ExportAssembly,
  type ExportTolerancePreset,
} from './export';
import { checkManifold } from './manifold';
import { meshProperties } from './mesh';
import { parseStl } from './stl';
import { buildMeshes, validate3mf } from './threemf';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } as const;
const Y_AXIS = { origin: [0, 0, 0], direction: [0, 1, 0] } as const;

function feature(input: FeatureInput): ShapeId {
  const out = applyFeature(k, [], input);
  expect(out.errors).toEqual([]);
  expect(out.bodies).toHaveLength(1);
  return out.bodies[0]!.shape;
}

/** The app's demo part: a 60 x 40 x 20 block, every edge filleted at 3, a through hole of radius 8. */
function demoPart(): ShapeId {
  const box = k.box(60, 40, 20, [-30, -20, 0]);
  const filleted = k.fillet(box, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3).shape;
  const tool = k.cylinder(8, 30, [0, 0, -5]);
  const cut = k.boolean('cut', filleted, [tool]).shape;
  for (const id of [box, filleted, tool]) k.release(id);
  return cut;
}

const shapes: Record<string, () => ShapeId> = {
  'the demo part': demoPart,
  // A sphere of radius 5: two poles where triangles meet at a point.
  'a sphere': () =>
    feature({
      kind: 'revolve',
      id: 'revolve#1',
      profile: {
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'arc', id: 'a1', center: [0, 0], start: [0, -5], end: [0, 5] },
              { kind: 'line', id: 'l1', start: [0, 5], end: [0, -5] },
            ],
          },
        ],
      },
      axis: Y_AXIS,
      angle: 2 * Math.PI,
      mode: 'new',
    }),
  // A cone of radius 5 and height 10: an apex, and a seam.
  'a cone': () =>
    feature({
      kind: 'revolve',
      id: 'revolve#1',
      profile: {
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'line', id: 'l1', start: [0, 0], end: [5, 0] },
              { kind: 'line', id: 'l2', start: [5, 0], end: [0, 10] },
              { kind: 'line', id: 'l3', start: [0, 10], end: [0, 0] },
            ],
          },
        ],
      },
      axis: Y_AXIS,
      angle: 2 * Math.PI,
      mode: 'new',
    }),
  // A torus: a doubly periodic face with two seams.
  'a torus': () =>
    feature({
      kind: 'revolve',
      id: 'revolve#1',
      profile: {
        frame: XY,
        loops: [{ entities: [{ kind: 'circle', id: 'c1', center: [10, 0], radius: 3 }] }],
      },
      axis: Y_AXIS,
      angle: 2 * Math.PI,
      mode: 'new',
    }),
};

describe('kernel meshes export watertight', () => {
  const presets = Object.keys(EXPORT_TOLERANCES) as ExportTolerancePreset[];

  it.each(Object.keys(shapes))('%s, at every tolerance preset', (label) => {
    const shape = shapes[label]!();
    const exact = k.properties(shape).volume;
    const errors: number[] = [];
    for (const preset of presets) {
      const tolerance = EXPORT_TOLERANCES[preset];
      const kernelMesh = k.mesh(shape, deflectionOf(tolerance));
      const { mesh } = exportMesh({ name: label, mesh: kernelMesh });
      const report = checkManifold(mesh);
      expect(report.problems, `${label} at ${preset}`).toEqual([]);
      expect(report.ok).toBe(true);
      const volume = meshProperties(mesh).volume;
      errors.push(Math.abs(volume - exact) / exact);
    }
    // Inscribed facets lose a little volume, less the finer the tolerance.
    expect(errors.at(-1)!).toBeLessThan(0.01);
    expect(errors.at(-1)!).toBeLessThanOrEqual(errors[0]! + 1e-9);
    k.release(shape);
  });
});

describe('STL and 3MF from kernel bodies', () => {
  it('STL: merged and per body, each read back watertight with the right volume', () => {
    const part = demoPart();
    const pin = k.cylinder(4, 10, [50, 0, 0]);
    const deflection = deflectionOf(EXPORT_TOLERANCES.fine);
    const bodies = [
      { name: 'Demo part', mesh: k.mesh(part, deflection) },
      { name: 'Pin', mesh: k.mesh(pin, deflection) },
    ];
    const merged = exportStl(bodies);
    expect(merged.map((f) => f.name)).toEqual(['bodies.stl']);
    const back = parseStl(merged[0]!.bytes);
    expect(checkManifold(back.mesh).ok).toBe(true);
    const total = k.properties(part).volume + k.properties(pin).volume;
    expect(meshProperties(back.mesh).volume / total).toBeCloseTo(1, 2);

    const each = exportStl(bodies, { merge: false });
    expect(each.map((f) => f.name)).toEqual(['Demo part.stl', 'Pin.stl']);
    for (const f of each) expect(checkManifold(parseStl(f.bytes).mesh).ok).toBe(true);
    k.release(part);
    k.release(pin);
  });

  it('3MF: one named object per body, millimetres, every object watertight and outward', () => {
    const part = demoPart();
    const pin = k.cylinder(4, 10, [50, 0, 0]);
    const deflection = deflectionOf(EXPORT_TOLERANCES.normal);
    const bytes = export3mf([
      { name: 'Demo part', mesh: k.mesh(part, deflection) },
      { name: 'Pin', mesh: k.mesh(pin, deflection) },
    ]);
    const r = validate3mf(bytes);
    expect(r.problems).toEqual([]);
    expect(r.parsed!.unit).toBe('millimeter');
    expect(r.parsed!.objects.map((o) => o.name)).toEqual(['Demo part', 'Pin']);
    expect(r.objects.every((o) => o.manifold.volume > 0)).toBe(true);
    k.release(part);
    k.release(pin);
  });

  it('a STEP round trip still meshes watertight', () => {
    const part = demoPart();
    const back = k.importStep(k.exportStep([{ shape: part, name: 'Demo part' }]));
    const { mesh } = exportMesh({ name: 'reimported', mesh: k.mesh(back) });
    expect(checkManifold(mesh).ok).toBe(true);
    k.release(part);
    k.release(back);
  });

  it('refuses to export a mesh that is not watertight', () => {
    const box = k.box(10, 10, 10);
    const m = k.mesh(box);
    const open = { positions: m.positions, indices: m.indices.slice(3) };
    expect(() => exportMesh({ name: 'Open box', mesh: open })).toThrow(
      /Open box is not watertight/,
    );
    expect(() => deflectionOf({ chordal: 0, angular: 0.1 })).toThrow(RangeError);
    k.release(box);
  });
});

describe('an assembly from kernel bodies', () => {
  it('3MF and STL: the demo part meshed once, placed twice, watertight, at the placements', () => {
    const part = demoPart();
    const deflection = deflectionOf(EXPORT_TOLERANCES.normal);
    const assembly: ExportAssembly = {
      bodies: [{ name: 'Demo part', mesh: k.mesh(part, deflection) }],
      parts: [{ name: 'Demo part', bodies: [0] }],
      instances: [
        { part: 0, name: 'Left', placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
        {
          part: 0,
          name: 'Right',
          // A quarter turn about z, then 100 mm along x.
          placement: { translation: [100, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        },
      ],
    };
    const exact = k.properties(part).volume;
    const r = validate3mf(export3mfAssembly(assembly));
    expect(r.problems).toEqual([]);
    expect(r.parsed!.objects).toHaveLength(1);
    expect(r.parsed!.items).toHaveLength(2);
    const built = buildMeshes(r.parsed!);
    const right = meshProperties(built[1]!.mesh);
    expect(right.volume / exact).toBeCloseTo(1, 2);
    // The block is 60 x 40 about the origin; turned, 40 x 60 about (100, 0).
    right.boundingBox!.min.forEach((v, i) => expect(v).toBeCloseTo([80, -30, 0][i]!, 3));
    right.boundingBox!.max.forEach((v, i) => expect(v).toBeCloseTo([120, 30, 20][i]!, 3));

    const stl = parseStl(exportStlAssembly(assembly).bytes);
    expect(meshProperties(stl.mesh).volume / (2 * exact)).toBeCloseTo(1, 2);
    k.release(part);
  });
});
