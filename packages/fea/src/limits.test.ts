// Input validation: every size, count and number is checked before anything is allocated or
// meshed (resource limits as denial of service in shared documents, ADR 0017 decision 16).

import { describe, expect, test } from 'vitest';
import { analyse, MESHER_MIN_BYTES, mesherMemory } from './analyse';
import { STEEL } from './benchmarks';
import {
  DEFAULT_LIMITS,
  estimateDof,
  HARD_LIMITS,
  REQUEST_LIMITS,
  resolveLimits,
  sizeForDof,
  validateMeshInput,
  validateRequest,
} from './limits';
import type { MeshedModel } from './solve';
import { structuredBlock } from './structured';
import type { FeaRequest } from './types';

const step = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n');
const base = (): FeaRequest => ({
  bodies: [{ step, material: { ...STEEL } }],
  mesh: { size: 5 },
  fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
  loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -1000] }],
});

const pathOf = (r: FeaRequest) => {
  const e = validateRequest(r);
  return e && e.code === 'invalid-input' ? e.path : null;
};

describe('validateRequest', () => {
  test('a well-formed request passes', () => {
    expect(validateRequest(base())).toBeNull();
  });

  test('the element size may be left to the default', () => {
    const r = base();
    delete r.mesh.size;
    r.mesh.refine = [{ faces: [{ body: 0, face: 0 }], size: 0.5 }];
    expect(validateRequest(r)).toBeNull();
  });

  const bad: [string, (r: FeaRequest) => void, string][] = [
    ['no bodies', (r) => (r.bodies = []), 'bodies'],
    [
      'too many bodies',
      (r) => (r.bodies = Array.from({ length: 17 }, () => r.bodies[0]!)),
      'bodies',
    ],
    ['not STEP', (r) => (r.bodies[0]!.step = new Uint8Array([0, 1, 2])), 'bodies[0].step'],
    ['empty STEP', (r) => (r.bodies[0]!.step = new Uint8Array(0)), 'bodies[0].step'],
    [
      'STEP as a string',
      (r) => ((r.bodies[0] as unknown as { step: string }).step = 'ISO-10303-21;'),
      'bodies[0].step',
    ],
    [
      'NaN modulus',
      (r) => (r.bodies[0]!.material.elasticModulus = NaN),
      'bodies[0].material.elasticModulus',
    ],
    [
      'infinite modulus',
      (r) => (r.bodies[0]!.material.elasticModulus = Infinity),
      'bodies[0].material.elasticModulus',
    ],
    [
      'negative modulus',
      (r) => (r.bodies[0]!.material.elasticModulus = -1),
      'bodies[0].material.elasticModulus',
    ],
    [
      'Poisson 0.5',
      (r) => (r.bodies[0]!.material.poissonRatio = 0.5),
      'bodies[0].material.poissonRatio',
    ],
    [
      'Poisson NaN',
      (r) => (r.bodies[0]!.material.poissonRatio = NaN),
      'bodies[0].material.poissonRatio',
    ],
    ['bad face count', (r) => (r.bodies[0]!.faceCount = 0.5), 'bodies[0].faceCount'],
    ['size 0', (r) => (r.mesh.size = 0), 'mesh.size'],
    ['size NaN', (r) => (r.mesh.size = NaN), 'mesh.size'],
    ['size Infinity', (r) => (r.mesh.size = Infinity), 'mesh.size'],
    ['size tiny', (r) => (r.mesh.size = 1e-9), 'mesh.size'],
    ['sizeMin above size', (r) => (r.mesh.sizeMin = 6), 'mesh.sizeMin'],
    ['sizeMin far below size', (r) => (r.mesh.sizeMin = 5 / 1000), 'mesh.sizeMin'],
    ['curvature negative', (r) => (r.mesh.curvature = -1), 'mesh.curvature'],
    ['curvature huge', (r) => (r.mesh.curvature = 1e6), 'mesh.curvature'],
    [
      'unknown algorithm',
      (r) => ((r.mesh as { algorithm: string }).algorithm = 'netgen'),
      'mesh.algorithm',
    ],
    [
      'refinement below the floor',
      (r) => (r.mesh.refine = [{ faces: [{ body: 0, face: 0 }], size: 0.01 }]),
      'mesh.refine[0].size',
    ],
    [
      'refinement NaN',
      (r) => (r.mesh.refine = [{ faces: [{ body: 0, face: 0 }], size: NaN }]),
      'mesh.refine[0].size',
    ],
    [
      'too many refinements',
      (r) =>
        (r.mesh.refine = Array.from({ length: 1001 }, () => ({
          faces: [{ body: 0, face: 0 }],
          size: 1,
        }))),
      'mesh.refine',
    ],
    ['no fixtures', (r) => (r.fixtures = []), 'fixtures'],
    [
      'fixture holds nothing',
      (r) => (r.fixtures[0]!.components = [false, false, false]),
      'fixtures[0].components',
    ],
    [
      'fixture on a missing body',
      (r) => (r.fixtures[0]!.faces = [{ body: 1, face: 0 }]),
      'fixtures[0].faces[0].body',
    ],
    [
      'negative face',
      (r) => (r.fixtures[0]!.faces = [{ body: 0, face: -1 }]),
      'fixtures[0].faces[0].face',
    ],
    [
      'fractional face',
      (r) => (r.fixtures[0]!.faces = [{ body: 0, face: 1.5 }]),
      'fixtures[0].faces[0].face',
    ],
    ['no faces', (r) => (r.fixtures[0]!.faces = []), 'fixtures[0].faces'],
    [
      'too many faces',
      (r) =>
        (r.fixtures[0]!.faces = Array.from({ length: REQUEST_LIMITS.facesPerItem + 1 }, () => ({
          body: 0,
          face: 0,
        }))),
      'fixtures[0].faces',
    ],
    [
      'NaN force',
      (r) => (r.loads = [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, NaN, 0] }]),
      'loads[0].force[1]',
    ],
    [
      'huge force',
      (r) => (r.loads = [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [1e20, 0, 0] }]),
      'loads[0].force[0]',
    ],
    [
      'short force',
      (r) => (r.loads = [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [1, 2] as never }]),
      'loads[0].force',
    ],
    [
      'infinite pressure',
      (r) => (r.loads = [{ kind: 'pressure', faces: [{ body: 0, face: 1 }], pressure: -Infinity }]),
      'loads[0].pressure',
    ],
    [
      'unknown load',
      (r) => (r.loads = [{ kind: 'torque', faces: [{ body: 0, face: 1 }] } as never]),
      'loads[0].kind',
    ],
    ['tolerance 0', (r) => (r.tolerance = 0), 'tolerance'],
  ];
  test.each(bad)('%s', (_name, mutate, path) => {
    const r = base();
    mutate(r);
    expect(pathOf(r)).toBe(path);
  });

  test('face references across fixtures and loads are capped in total', () => {
    const r = base();
    const faces = (from: number) =>
      Array.from({ length: 4_000 }, (_, i) => ({ body: 0, face: from + i }));
    r.fixtures = [
      { kind: 'fixed', faces: faces(0) },
      { kind: 'fixed', faces: faces(4_000) },
    ];
    expect(validateRequest(r)).toBeNull();
    r.loads = [{ kind: 'pressure', faces: faces(8_000), pressure: 1 }];
    expect(validateRequest(r)).toMatchObject({
      code: 'invalid-input',
      path: 'loads[0].faces',
      message: expect.stringContaining(`${REQUEST_LIMITS.faceRefs}`),
    });
  });

  test('a face named twice in one item is refused, in two items it is not', () => {
    const r = base();
    r.loads = [
      {
        kind: 'force',
        faces: [
          { body: 0, face: 1 },
          { body: 0, face: 2 },
          { body: 0, face: 1 },
        ],
        force: [0, 0, -1],
      },
    ];
    expect(pathOf(r)).toBe('loads[0].faces[2]');
    r.loads = [
      { kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -1] },
      { kind: 'pressure', faces: [{ body: 0, face: 1 }], pressure: 1 },
    ];
    expect(validateRequest(r)).toBeNull();
    r.fixtures[0]!.faces = [
      { body: 0, face: 0 },
      { body: 0, face: 0 },
    ];
    expect(pathOf(r)).toBe('fixtures[0].faces[1]');
  });

  test('STEP over the per-body limit', () => {
    const r = base();
    const big = new Uint8Array(REQUEST_LIMITS.stepBytesPerBody + 1);
    big.set(step);
    r.bodies[0]!.step = big;
    expect(pathOf(r)).toBe('bodies[0].step');
  });
});

describe('limits', () => {
  test('defaults: cap 500k DOF, warn above 200k', () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.maxDof).toBe(500_000);
    expect(DEFAULT_LIMITS.warnDof).toBe(200_000);
    expect(HARD_LIMITS.maxDof).toBe(500_000);
  });

  test('may be lowered, never raised past the hard caps', () => {
    expect(resolveLimits({ maxDof: 100_000 })).toMatchObject({ maxDof: 100_000, warnDof: 100_000 });
    for (const key of ['maxDof', 'memoryBytes', 'timeMs'] as const) {
      expect(resolveLimits({ [key]: HARD_LIMITS[key] * 2 })).toMatchObject({
        code: 'invalid-input',
        path: `limits.${key}`,
      });
      expect(resolveLimits({ [key]: NaN })).toMatchObject({ code: 'invalid-input' });
      expect(resolveLimits({ [key]: -1 })).toMatchObject({ code: 'invalid-input' });
      expect(resolveLimits({ [key]: Infinity })).toMatchObject({ code: 'invalid-input' });
    }
  });

  test("gmsh's memory stays within the budget, and a budget too small to mesh is refused", async () => {
    for (const memoryBytes of [256 * 1024 ** 2, 1024 ** 3, HARD_LIMITS.memoryBytes]) {
      const limits = { ...DEFAULT_LIMITS, memoryBytes };
      expect(mesherMemory(limits)).toBeLessThanOrEqual(memoryBytes / 2);
      expect(mesherMemory(limits)).toBeGreaterThanOrEqual(MESHER_MIN_BYTES);
    }
    const r = base();
    r.limits = { memoryBytes: 200 * 1024 ** 2 };
    expect(await analyse(r)).toMatchObject({
      ok: false,
      error: { code: 'memory-limit', bytes: 2 * MESHER_MIN_BYTES, limit: 200 * 1024 ** 2 },
    });
  });

  test('the DOF estimate and the default size are inverses', () => {
    const volume = 160 * 40 * 20,
      surface = 2 * (160 * 40 + 160 * 20 + 40 * 20);
    const size = sizeForDof(volume, surface, 175_000);
    expect(estimateDof(volume, size, [], surface)).toBeGreaterThanOrEqual(175_000);
    expect(estimateDof(volume, size, [], surface)).toBeLessThan(176_000);
    expect(estimateDof(volume, 5, [{ area: 100, size: 1 }])).toBeGreaterThan(
      estimateDof(volume, 5),
    );
  });
});

describe('validateMeshInput', () => {
  const model = () => structuredBlock({ cells: [2, 1, 1], map: (u, v, w) => [10 * u, v, w] });
  const input = () => ({
    materials: [{ ...STEEL }],
    fixtures: [{ kind: 'fixed' as const, faces: [{ body: 0, face: 0 }] }],
    loads: [] as FeaRequest['loads'],
  });
  test('a structured mesh passes', () => {
    expect(validateMeshInput(model(), input(), 500_000)).toBeNull();
  });
  test.each([
    ['a NaN coordinate', (m: MeshedModel) => (m.mesh.nodes[4] = NaN), 'model.mesh.nodes'],
    ['an element past the nodes', (m: MeshedModel) => (m.mesh.tets[3] = 1e6), 'model.mesh.tets'],
    ['a body with no material', (m: MeshedModel) => (m.mesh.tetBody[0] = 3), 'model.mesh.tetBody'],
    [
      'a triangle past the nodes',
      (m: MeshedModel) => (m.faces[0]!.corners[0] = 1e6),
      'model.faces[0].corners',
    ],
    [
      'a node no element uses',
      (m: MeshedModel) => {
        const nodes = new Float64Array(m.mesh.nodes.length + 3);
        nodes.set(m.mesh.nodes);
        m.mesh.nodes = nodes;
      },
      'model.mesh.nodes',
    ],
    [
      'far more elements than nodes',
      (m: MeshedModel) => {
        const ne = (REQUEST_LIMITS.elementsPerNode * m.mesh.nodes.length) / 3 + 1;
        const tets = new Uint32Array(10 * ne);
        for (let e = 0; e < ne; e++) tets.set(m.mesh.tets.subarray(0, 10), 10 * e);
        m.mesh.tets = tets;
        m.mesh.tetBody = new Uint16Array(ne);
      },
      'model.mesh.tets',
    ],
    [
      'more faces than the bodies may have',
      (m: MeshedModel) =>
        (m.faces = Array.from({ length: REQUEST_LIMITS.facesPerBody + 1 }, (_, face) => ({
          body: 0,
          face,
          corners: new Uint32Array(0),
        }))),
      'model.faces',
    ],
    [
      'more triangles than the elements have faces',
      (m: MeshedModel) =>
        (m.faces[0]!.corners = new Uint32Array(3 * (4 * (m.mesh.tets.length / 10) + 1))),
      'model.faces[0].corners',
    ],
  ])('%s', (_name, mutate, path) => {
    const m = model();
    mutate(m);
    expect(validateMeshInput(m, input(), 500_000)).toMatchObject({ code: 'invalid-input', path });
  });
  test('the DOF cap applies before anything else', () => {
    expect(validateMeshInput(model(), input(), 30)).toMatchObject({ code: 'dof-limit' });
  });
  test('materials and loads are checked as for a request', () => {
    const i = input();
    i.materials[0]!.poissonRatio = 0.5;
    expect(validateMeshInput(model(), i, 500_000)).toMatchObject({
      path: 'materials[0].poissonRatio',
    });
    const j = input();
    j.loads = [{ kind: 'pressure', faces: [{ body: 0, face: 1 }], pressure: NaN }];
    expect(validateMeshInput(model(), j, 500_000)).toMatchObject({ path: 'loads[0].pressure' });
  });
});
