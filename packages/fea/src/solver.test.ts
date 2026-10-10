// The solver against the analytical benchmarks on structured meshes (no mesher needed), so the
// 5 % acceptance runs on every test run. gmsh's meshes of kernel solids are in gmsh.test.ts.

import { describe, expect, test } from 'vitest';
import { analyseMesh } from './analyse';
import {
  CANTILEVER,
  cantileverMetrics,
  CYLINDER,
  cylinderMetrics,
  type Metric,
  PLATE,
  plateMetrics,
  STEEL,
} from './benchmarks';
import { structuredBlock } from './structured';
import type { FeaOutcome, FeaResult } from './types';

const ok = (o: FeaOutcome): FeaResult => {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.result;
};

const within = (metrics: Metric[], tol: number) => {
  for (const m of metrics)
    expect(Math.abs(m.error), `${m.name}: ${m.fea} vs ${m.analytical}`).toBeLessThan(tol);
};

const cantilever = (cells: [number, number, number]) =>
  structuredBlock({
    cells,
    map: (u, v, w) => [CANTILEVER.L * u, CANTILEVER.b * v, CANTILEVER.h * w],
  });

describe('analytical benchmarks on structured meshes (5 %)', () => {
  test('cantilever: Timoshenko tip deflection and M c / I', () => {
    const r = ok(
      analyseMesh(cantilever([40, 4, 4]), {
        materials: [STEEL],
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
        loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -CANTILEVER.P] }],
      }),
    );
    within(cantileverMetrics(r), 0.05);
    expect(r.summary.appliedForce[2]).toBeCloseTo(-1000, 6);
    expect(r.summary.iterations).toBeLessThan(60);
    expect(r.summary.relativeResidual).toBeLessThan(1e-8);
  });

  test('plate with a hole: Peterson Kt', () => {
    const { halfLength: L, halfWidth: W, r: a, halfThickness: t } = PLATE;
    // Rays from the hole to the outer boundary: x = L for v <= 1/2, y = W beyond; graded radially.
    const outer = (v: number): [number, number] =>
      v <= 0.5 ? [L, W * (2 * v)] : [L * (2 - 2 * v), W];
    const grade = (u: number) => (Math.exp(3.5 * u) - 1) / (Math.exp(3.5) - 1);
    const model = structuredBlock({
      cells: [16, 32, 2],
      map: (u, v, w) => {
        const th = (Math.PI / 2) * v;
        const [ox, oy] = outer(v);
        const ix = a * Math.cos(th),
          iy = a * Math.sin(th);
        const g = grade(u);
        return [ix + g * (ox - ix), iy + g * (oy - iy), t * w];
      },
      // 0: x = 0 (v = 1), 1: y = 0 (v = 0), 2: z = 0, 3: the loaded end x = L.
      faces: 4,
      faceOf: (c) =>
        c.every((p) => p[1] === 1)
          ? 0
          : c.every((p) => p[1] === 0)
            ? 1
            : c.every((p) => p[2] === 0)
              ? 2
              : c.every((p) => p[0] === 1 && p[1] <= 0.5)
                ? 3
                : -1,
    });
    const r = ok(
      analyseMesh(model, {
        materials: [STEEL],
        fixtures: [
          { kind: 'fixed', faces: [{ body: 0, face: 0 }], components: [true, false, false] },
          { kind: 'fixed', faces: [{ body: 0, face: 1 }], components: [false, true, false] },
          { kind: 'fixed', faces: [{ body: 0, face: 2 }], components: [false, false, true] },
        ],
        loads: [
          { kind: 'traction', faces: [{ body: 0, face: 3 }], traction: [PLATE.stress * 1e6, 0, 0] },
        ],
      }),
    );
    within(plateMetrics(r), 0.05);
    expect(r.summary.appliedForce[0]).toBeCloseTo(PLATE.stress * W * t, 6);
  });

  test('thick-walled cylinder: Lame', () => {
    const { ri, ro, length, p } = CYLINDER;
    const model = structuredBlock({
      cells: [8, 16, 2],
      map: (u, v, w) => {
        const rad = ri + (ro - ri) * u,
          th = (Math.PI / 2) * v;
        return [rad * Math.cos(th), rad * Math.sin(th), length * w];
      },
    });
    const r = ok(
      analyseMesh(model, {
        materials: [STEEL],
        fixtures: [
          { kind: 'fixed', faces: [{ body: 0, face: 2 }], components: [false, true, false] },
          { kind: 'fixed', faces: [{ body: 0, face: 3 }], components: [true, false, false] },
          {
            kind: 'fixed',
            faces: [
              { body: 0, face: 4 },
              { body: 0, face: 5 },
            ],
            components: [false, false, true],
          },
        ],
        loads: [{ kind: 'pressure', faces: [{ body: 0, face: 0 }], pressure: p * 1e6 }],
      }),
    );
    within(cylinderMetrics(r), 0.05);
    // The pressure follows the curved face: 100 MPa on a quarter of r 10, 10 long is 10 kN per axis.
    expect(r.summary.appliedForce[0]).toBeCloseTo(p * ri * length, 3);
    expect(r.summary.appliedForce[1]).toBeCloseTo(p * ri * length, 3);
  });
});

describe('results', () => {
  test('von Mises and principal stresses are consistent with the stress tensor', () => {
    const r = ok(
      analyseMesh(cantilever([10, 2, 2]), {
        materials: [STEEL],
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
        loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 100, -1000] }],
      }),
    );
    const n = r.nodes.length / 3;
    for (let i = 0; i < n; i += 7) {
      const [s1, s2, s3] = [r.principal[3 * i]!, r.principal[3 * i + 1]!, r.principal[3 * i + 2]!];
      expect(s1).toBeGreaterThanOrEqual(s2 - 1e-6);
      expect(s2).toBeGreaterThanOrEqual(s3 - 1e-6);
      const s = r.stress.subarray(6 * i, 6 * i + 6);
      // Invariants: trace and von Mises from the principal values.
      expect(s1 + s2 + s3).toBeCloseTo(s[0]! + s[1]! + s[2]!, -1);
      const vm = Math.sqrt(0.5 * ((s1 - s2) ** 2 + (s2 - s3) ** 2 + (s3 - s1) ** 2));
      expect(Math.abs(vm - r.vonMises[i]!)).toBeLessThan(1e-6 * Math.max(1, r.vonMises[i]!));
    }
    expect(r.summary.maxVonMises.value).toBe(Math.max(...r.vonMises));
    // Peak bending stress is at the clamp.
    expect(r.summary.maxVonMises.at[0]).toBeLessThan(25);
    expect(r.summary.maxDisplacement.at[0]).toBeCloseTo(CANTILEVER.L, 6);
    expect(r.triangles.length / 6).toBe(r.triangleFace.length / 2);
  });

  test('two materials: a stiffer body deflects less', () => {
    const run = (E: number) =>
      ok(
        analyseMesh(cantilever([10, 2, 2]), {
          materials: [{ elasticModulus: E, poissonRatio: 0.3 }],
          fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
          loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -1000] }],
        }),
      ).summary.maxDisplacement.value;
    expect(run(70e9) / run(210e9)).toBeCloseTo(3, 6);
  });
});

describe('typed errors from the solver', () => {
  test('an unheld body is unconstrained, not a hang', () => {
    const o = analyseMesh(cantilever([4, 1, 1]), {
      materials: [STEEL],
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }], components: [true, true, false] }],
      loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -10] }],
    });
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error).toMatchObject({ code: 'unconstrained', bodies: [0] });
  });

  test('the DOF cap refuses before assembly', () => {
    const o = analyseMesh(cantilever([10, 2, 2]), {
      materials: [STEEL],
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
      loads: [],
      limits: { maxDof: 1000 },
    });
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error).toMatchObject({ code: 'dof-limit', estimated: false, limit: 1000 });
  });

  test('the memory limit refuses before allocating', () => {
    const o = analyseMesh(cantilever([10, 2, 2]), {
      materials: [STEEL],
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
      loads: [],
      limits: { memoryBytes: 1024 * 1024 },
    });
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error.code).toBe('memory-limit');
  });

  test('a cancelled run stops with a typed error', () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(flag, 0, 1);
    const o = analyseMesh(
      cantilever([10, 2, 2]),
      {
        materials: [STEEL],
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
        loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -10] }],
      },
      { cancel: flag },
    );
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error.code).toBe('cancelled');
  });

  test('a face the body does not have is invalid input', () => {
    const o = analyseMesh(cantilever([4, 1, 1]), {
      materials: [STEEL],
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 9 }] }],
      loads: [],
    });
    expect(o.ok).toBe(false);
    if (!o.ok)
      expect(o.error).toMatchObject({ code: 'invalid-input', path: 'fixtures[0].faces[0]' });
  });

  test('progress reports every phase in order', () => {
    const phases: string[] = [];
    let iterations = 0;
    ok(
      analyseMesh(
        cantilever([10, 2, 2]),
        {
          materials: [STEEL],
          fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
          loads: [{ kind: 'force', faces: [{ body: 0, face: 1 }], force: [0, 0, -10] }],
        },
        {
          onProgress: (p) => {
            if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
            if (p.iteration !== undefined) iterations = Math.max(iterations, p.iteration);
          },
        },
      ),
    );
    expect(phases).toEqual(['prepare', 'assemble', 'precondition', 'solve', 'stress']);
  });
});
