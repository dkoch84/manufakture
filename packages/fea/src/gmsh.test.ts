// The whole pipeline on kernel solids: the kernel writes STEP, our gmsh build meshes it, the
// solver solves. The spike's three benchmarks within 5 %, face identity across the hand-over on
// a multi-body (bonded) model, the early DOF refusal, and a run in a Node worker thread. Skipped
// when the mesher is not built (packages/fea/build/build-gmsh.sh writes packages/fea/wasm/).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@manufakture/kernel/node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { analyse } from './analyse';
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
import { createFeaRunner } from './client';
import { spawnNodeFeaWorker } from './node';
import type { FeaOutcome, FeaRequest, FeaResult } from './types';

const WASM = new URL('../wasm/gmsh.wasm', import.meta.url);
const built = existsSync(WASM);

type Kernel = Awaited<ReturnType<typeof createNodeKernel>>;
type Shape = Parameters<Kernel['exportStep']>[0][0]['shape'];

interface Solid {
  step: Uint8Array;
  /** Area-weighted centre of each kernel face, in kernel order. */
  centres: [number, number, number][];
}

function solid(k: Kernel, shape: Shape, name: string): Solid {
  const step = k.exportStep([{ shape, name }]);
  const surf = k.mesh(k.importStep(step), { linear: 0.005, angular: 0.05 });
  const centres: [number, number, number][] = [];
  for (let f = 0; f < surf.faceRanges.length / 2; f++) {
    const first = surf.faceRanges[2 * f]!,
      count = surf.faceRanges[2 * f + 1]!;
    const acc = [0, 0, 0];
    let total = 0;
    for (let t = first; t < first + count; t += 3) {
      const p = [0, 1, 2].map((q) =>
        [0, 1, 2].map((c) => surf.positions[3 * surf.indices[t + q]! + c]!),
      );
      const u = [0, 1, 2].map((c) => p[1]![c]! - p[0]![c]!),
        v = [0, 1, 2].map((c) => p[2]![c]! - p[0]![c]!);
      const area =
        0.5 *
        Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        );
      for (let c = 0; c < 3; c++) acc[c]! += (area * (p[0]![c]! + p[1]![c]! + p[2]![c]!)) / 3;
      total += area;
    }
    centres.push([acc[0]! / total, acc[1]! / total, acc[2]! / total]);
  }
  return { step, centres };
}

/** The one face whose centre passes `where`. */
function face(s: Solid, where: (c: [number, number, number]) => boolean): number {
  const hits = s.centres.flatMap((c, i) => (where(c) ? [i] : []));
  if (hits.length !== 1) throw new Error(`expected one face, found ${hits.length}`);
  return hits[0]!;
}

const ok = (o: FeaOutcome): FeaResult => {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.result;
};
const within = (metrics: Metric[], tol: number) => {
  for (const m of metrics) {
    expect(Math.abs(m.error), `${m.name}: ${m.fea} vs ${m.analytical}`).toBeLessThan(tol);
  }
};
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;
const log = (name: string, r: FeaResult, metrics: Metric[] = []) =>
  console.log(
    name,
    JSON.stringify({
      dof: r.summary.dof,
      estimated: r.summary.estimatedDof,
      iterations: r.summary.iterations,
      ms: Object.fromEntries(Object.entries(r.summary.timings).map(([k, v]) => [k, Math.round(v)])),
      mesherMiB: Math.round(r.summary.mesherBytes / 2 ** 20),
      solverMiB: Math.round(r.summary.solverBytes / 2 ** 20),
      quality: +r.summary.worstElementQuality.toFixed(3),
      metrics: metrics.map((m) => `${m.name}: ${(100 * m.error).toFixed(2)} %`),
    }),
  );

describe.skipIf(!built)('gmsh pipeline on kernel solids', () => {
  let solids: Record<'beam' | 'plate' | 'tube' | 'bracket' | 'base' | 'post', Solid>;

  beforeAll(async () => {
    const k = await createNodeKernel();
    const { L, b, h } = CANTILEVER;
    const { halfLength, halfWidth, halfThickness, r } = PLATE;
    const { ri, ro, length } = CYLINDER;
    const plate = k.boolean('cut', k.box(halfLength, halfWidth, halfThickness), [
      k.cylinder(r, 3 * halfThickness, [0, 0, -halfThickness]),
    ]).shape;
    const tube = k.boolean('cut', k.cylinder(ro, length), [
      k.cylinder(ri, length + 2, [0, 0, -1]),
    ]).shape;
    const quarter = k.boolean('common', tube, [k.box(ro + 5, ro + 5, length)]).shape;
    const bracket = k.boolean('cut', k.box(160, 40, 20), [
      k.cylinder(8, 40, [60, 20, -10]),
      k.cylinder(8, 40, [110, 20, -10]),
      k.box(20, 10, 40, [130, 15, -10]),
    ]).shape;
    solids = {
      beam: solid(k, k.box(L, b, h), 'beam'),
      plate: solid(k, plate, 'plate'),
      tube: solid(k, quarter, 'tube'),
      bracket: solid(k, bracket, 'bracket'),
      // Two bonded bodies: a post standing on a base, its foot inside the base's top face.
      base: solid(k, k.box(60, 60, 10), 'base'),
      post: solid(k, k.cylinder(8, 50, [30, 30, 10]), 'post'),
    };
  }, 60_000);

  test('the build has no Blossom in it', () => {
    const bytes = readFileSync(WASM);
    for (const marker of [
      'Blossom: %d internal %d closed',
      'blossoms have odd cardinality',
      'blossoms meet exactly one matching edge',
    ]) {
      expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
    const info = JSON.parse(
      readFileSync(new URL('../wasm/build-info.json', import.meta.url), 'utf8'),
    ) as {
      gmshConfig: string;
    };
    expect(info.gmshConfig).not.toMatch(/blossom/i);
  });

  test('the committed gmsh.wasm is the one build-info.json records', () => {
    const info = JSON.parse(
      readFileSync(new URL('../wasm/build-info.json', import.meta.url), 'utf8'),
    ) as { wasmSha256: string; wasmBytes: number };
    const bytes = readFileSync(WASM);
    expect(bytes.length).toBe(info.wasmBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(info.wasmSha256);
  });

  test('cantilever within 5 % of Timoshenko', async () => {
    const s = solids.beam;
    const r = ok(
      await analyse({
        bodies: [{ step: s.step, material: STEEL, faceCount: s.centres.length }],
        mesh: { size: 5 },
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: face(s, (c) => near(c[0], 0)) }] }],
        loads: [
          {
            kind: 'force',
            faces: [{ body: 0, face: face(s, (c) => near(c[0], CANTILEVER.L)) }],
            force: [0, 0, -CANTILEVER.P],
          },
        ],
      }),
    );
    const metrics = cantileverMetrics(r);
    log('cantilever', r, metrics);
    within(metrics, 0.05);
  });

  test('plate with a hole within 5 % of Peterson', async () => {
    const s = solids.plate;
    const hole = face(s, (c) => c[0] > 0 && c[0] < PLATE.r && c[1] > 0 && c[1] < PLATE.r);
    const r = ok(
      await analyse({
        bodies: [{ step: s.step, material: STEEL, faceCount: s.centres.length }],
        mesh: { size: 5, refine: [{ faces: [{ body: 0, face: hole }], size: 0.5 }] },
        fixtures: [
          {
            kind: 'fixed',
            faces: [{ body: 0, face: face(s, (c) => near(c[0], 0)) }],
            components: [true, false, false],
          },
          {
            kind: 'fixed',
            faces: [{ body: 0, face: face(s, (c) => near(c[1], 0)) }],
            components: [false, true, false],
          },
          {
            kind: 'fixed',
            faces: [{ body: 0, face: face(s, (c) => near(c[2], 0)) }],
            components: [false, false, true],
          },
        ],
        loads: [
          {
            kind: 'traction',
            faces: [{ body: 0, face: face(s, (c) => near(c[0], PLATE.halfLength)) }],
            traction: [PLATE.stress * 1e6, 0, 0],
          },
        ],
      }),
    );
    const metrics = plateMetrics(r);
    log('plate', r, metrics);
    within(metrics, 0.05);
  });

  test('thick-walled cylinder within 5 % of Lame', async () => {
    const s = solids.tube;
    const { ri, ro, length, p } = CYLINDER;
    const inner = face(s, (c) => Math.hypot(c[0], c[1]) < (ri + ro) / 2 && near(c[2], length / 2));
    const r = ok(
      await analyse({
        bodies: [{ step: s.step, material: STEEL, faceCount: s.centres.length }],
        mesh: { size: 1.5 },
        fixtures: [
          {
            kind: 'fixed',
            faces: [{ body: 0, face: face(s, (c) => near(c[1], 0)) }],
            components: [false, true, false],
          },
          {
            kind: 'fixed',
            faces: [{ body: 0, face: face(s, (c) => near(c[0], 0)) }],
            components: [true, false, false],
          },
          {
            kind: 'fixed',
            faces: [
              { body: 0, face: face(s, (c) => near(c[2], 0)) },
              { body: 0, face: face(s, (c) => near(c[2], length)) },
            ],
            components: [false, false, true],
          },
        ],
        loads: [{ kind: 'pressure', faces: [{ body: 0, face: inner }], pressure: p * 1e6 }],
      }),
    );
    const metrics = cylinderMetrics(r);
    log('cylinder', r, metrics);
    within(metrics, 0.05);
    expect(r.summary.appliedForce[0]).toBeCloseTo(p * ri * length, 0);
  });

  test('bonded bodies: every kernel face maps to its own mesh triangles', async () => {
    const { base, post } = solids;
    const bottom = face(base, (c) => near(c[2], 0));
    const top = face(post, (c) => near(c[2], 60));
    const r = ok(
      await analyse({
        bodies: [
          { step: base.step, material: STEEL, faceCount: base.centres.length },
          {
            step: post.step,
            material: { elasticModulus: 70e9, poissonRatio: 0.33 },
            faceCount: post.centres.length,
          },
        ],
        mesh: { size: 3 },
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: bottom }] }],
        loads: [{ kind: 'force', faces: [{ body: 1, face: top }], force: [500, 0, -2000] }],
      }),
    );
    log('bonded', r);
    // Each face's mesh triangles have the kernel face's centre of area (a face split where the
    // post stands on the base is still covered by its pieces).
    const sums = new Map<string, number[]>();
    const X = r.nodes;
    for (let t = 0; t < r.triangleFace.length / 2; t++) {
      const key = `${r.triangleFace[2 * t]}:${r.triangleFace[2 * t + 1]}`;
      const ids = [0, 1, 2].map((q) => r.triangles[6 * t + q]!);
      const p = ids.map((i) => [X[3 * i]!, X[3 * i + 1]!, X[3 * i + 2]!]);
      const u = [0, 1, 2].map((c) => p[1]![c]! - p[0]![c]!),
        v = [0, 1, 2].map((c) => p[2]![c]! - p[0]![c]!);
      const area =
        0.5 *
        Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        );
      const acc = sums.get(key) ?? [0, 0, 0, 0];
      for (let c = 0; c < 3; c++) acc[c]! += (area * (p[0]![c]! + p[1]![c]! + p[2]![c]!)) / 3;
      acc[3]! += area;
      sums.set(key, acc);
    }
    [base, post].forEach((s, b) =>
      s.centres.forEach((c, f) => {
        const acc = sums.get(`${b}:${f}`);
        expect(acc, `body ${b} face ${f} has triangles`).toBeDefined();
        const d = Math.hypot(
          acc![0]! / acc![3]! - c[0],
          acc![1]! / acc![3]! - c[1],
          acc![2]! / acc![3]! - c[2],
        );
        expect(d, `body ${b} face ${f}`).toBeLessThan(0.2);
      }),
    );
    expect(r.summary.appliedForce[0]).toBeCloseTo(500, 6);
    expect(r.summary.appliedForce[2]).toBeCloseTo(-2000, 6);
    // Both bodies carry elements, and the post bends: its top moves along +x.
    expect(new Set(r.elementBody).size).toBe(2);
    expect(r.summary.maxDisplacement.body).toBe(1);
  });

  test('a face count that differs from the kernel stops with face-mapping', async () => {
    const s = solids.beam;
    const out = await analyse({
      bodies: [{ step: s.step, material: STEEL, faceCount: s.centres.length + 1 }],
      mesh: { size: 20 },
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
      loads: [],
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'face-mapping', body: 0, found: 6, expected: 7 },
    });
  });

  test('a mesh far over the cap is refused from the estimate, before meshing', async () => {
    const s = solids.bracket;
    const t = performance.now();
    const out = await analyse({
      bodies: [{ step: s.step, material: STEEL }],
      mesh: { size: 0.3 },
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 0 }] }],
      loads: [],
    });
    expect(out).toMatchObject({ ok: false, error: { code: 'dof-limit', estimated: true } });
    expect(performance.now() - t).toBeLessThan(5_000);
  });

  test('a reference to a face the body does not have is invalid input', async () => {
    const s = solids.beam;
    const out = await analyse({
      bodies: [{ step: s.step, material: STEEL }],
      mesh: { size: 20 },
      fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: 6 }] }],
      loads: [],
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'invalid-input', path: 'fixtures[0].faces[0]' },
    });
  });

  describe('in a Node worker thread', () => {
    const runner = createFeaRunner(() => spawnNodeFeaWorker());
    afterAll(() => runner.dispose());

    const bracket = (size: number): FeaRequest => {
      const s = solids.bracket;
      return {
        bodies: [{ step: s.step, material: STEEL, faceCount: s.centres.length }],
        mesh: { size },
        fixtures: [{ kind: 'fixed', faces: [{ body: 0, face: face(s, (c) => near(c[0], 0)) }] }],
        loads: [
          {
            kind: 'force',
            faces: [{ body: 0, face: face(s, (c) => near(c[0], 160)) }],
            force: [0, 0, -2000],
          },
        ],
      };
    };

    test('meshes and solves the bracket, with progress through every phase', async () => {
      const phases = new Set<string>();
      const r = ok(await runner.run(bracket(4), { onProgress: (p) => phases.add(p.phase) }));
      log('bracket worker', r);
      expect([...phases]).toEqual(
        expect.arrayContaining([
          'load-mesher',
          'import',
          'mesh',
          'prepare',
          'assemble',
          'precondition',
          'solve',
          'stress',
        ]),
      );
      expect(r.summary.maxVonMises.value).toBeGreaterThan(0);
    });

    test('the default mesh aims at 150k to 200k DOF', async () => {
      const request = bracket(1);
      delete request.mesh.size;
      const r = ok(await runner.run(request));
      log('bracket default', r);
      expect(r.summary.dof).toBeGreaterThan(130_000);
      expect(r.summary.dof).toBeLessThan(220_000);
    }, 60_000);

    test("an analysis in a host process leaves the host's stdout empty", async () => {
      // The MCP server carries its protocol on stdout: run one analysis through the Node worker
      // runner in a child process and check that it printed nothing there.
      const s = solids.bracket;
      const dir = mkdtempSync(join(tmpdir(), 'fea-stdout-'));
      try {
        const stepPath = join(dir, 'bracket.step');
        writeFileSync(stepPath, s.step);
        const args = JSON.stringify({
          faceCount: s.centres.length,
          fixed: face(s, (c) => near(c[0], 0)),
          loaded: face(s, (c) => near(c[0], 160)),
          size: 8,
        });
        const child = (path: string) => fileURLToPath(new URL(path, import.meta.url));
        const { code, stdout, stderr } = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolve) => {
          const p = execFile(
            process.execPath,
            [
              '--import',
              child('./worker/node-hooks.ts'),
              child('./test-workers/stdout-probe.ts'),
              stepPath,
              args,
            ],
            { timeout: 60_000, encoding: 'utf8' },
            (_error, stdout, stderr) => resolve({ code: p.exitCode, stdout, stderr }),
          );
        });
        expect(stderr).toContain('"ok":true');
        expect(code).toBe(0);
        expect(stdout).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test('cancelling while gmsh meshes ends with cancelled', async () => {
      const controller = new AbortController();
      const out = await runner.run(bracket(2.5), {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'mesh') controller.abort();
        },
      });
      expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    });
  });
});
