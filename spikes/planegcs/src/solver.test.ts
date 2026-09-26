// Proof for T0.4 steps 2 to 4: DOF counting, a tangent arc with a radius, and
// how planegcs reports redundant and conflicting constraints. Also pins down
// the behaviours the spike doc relies on (tangency modelling, drag, memory).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DragSession } from './bench.ts';
import { chain, rectangle, roundedRectangle, type Item, type Stage } from './sketch.ts';
import {
  ALGORITHMS,
  Algorithm,
  analyze,
  createWrapper,
  loadModule,
  pointXY,
  statusName,
} from './solver.ts';
import { memoryLimits, withMemoryPages } from './wasm-memory.ts';

const wasmPath = createRequire(import.meta.url).resolve(
  '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm',
);
const stockBytes = () => new Uint8Array(readFileSync(wasmPath));

let w: GcsWrapper;
beforeAll(async () => {
  w = createWrapper(await loadModule());
});

/** DOF after each cumulative stage, starting from geometry alone. */
function dofByStage(build: (stages: Stage[]) => Item[], stages: Stage[]): number[] {
  return stages.map((_, i) => analyze(w, build(stages.slice(0, i + 1))).dof);
}

const RECT_STAGES: Stage[] = ['geometry', 'coincident', 'hv', 'dimensions', 'anchor'];
const fullRect = () => rectangle({ width: 40, height: 25, stages: RECT_STAGES, perturb: 2 });

describe('step 2: rectangle', () => {
  it('reports dof -1 until the first solve (the diagnosis runs inside solve)', () => {
    w.clear_data();
    w.push_primitives_and_params(fullRect());
    expect(w.gcs.dof()).toBe(-1);
    w.solve();
    expect(w.gcs.dof()).toBe(0);
  });

  it('goes 16 -> 8 -> 4 -> 2 -> 0 DOF as constraints are added', () => {
    const dofs = dofByStage(
      (stages) => rectangle({ width: 40, height: 25, stages, perturb: 2 }),
      RECT_STAGES,
    );
    // 8 points; 4 coincident (2 eq each); 2 horizontal + 2 vertical; width and
    // height; the corner made coincident with a fixed origin point.
    expect(dofs).toEqual([16, 8, 4, 2, 0]);
  });

  it('solves a perturbed start to the exact rectangle with every algorithm', () => {
    for (const a of ALGORITHMS) {
      const r = analyze(w, fullRect(), Algorithm[a]);
      expect(r, a).toMatchObject({ status: 'Success', dof: 0, conflicting: [], redundant: [] });
      expect(pointXY(w, 'r:a1')[0]).toBeCloseTo(0, 9);
      expect(pointXY(w, 'r:c2')[0]).toBeCloseTo(40, 9);
      expect(pointXY(w, 'r:c2')[1]).toBeCloseTo(25, 9);
    }
  });
});

describe('step 3: tangent arc and radius', () => {
  const STAGES: Stage[] = ['geometry', 'coincident', 'hv', 'tangent', 'dimensions', 'anchor'];

  it('goes 21 -> 11 -> 7 -> 5 -> 2 -> 0 DOF', () => {
    // 11 points and 3 arc parameters (25 unknowns) minus arc_rules (4 eq);
    // 5 coincident; 2 H + 2 V; 2 tangencies; width, height, radius; anchor.
    expect(dofByStage((s) => roundedRectangle(s, 1), STAGES)).toEqual([21, 11, 7, 5, 2, 0]);
  });

  it('places the arc: centre (34, 19), radius 6, tangent at both joints', () => {
    const r = analyze(w, roundedRectangle(STAGES, 1));
    expect(r).toMatchObject({ status: 'Success', dof: 0, conflicting: [], redundant: [] });
    const [cx, cy] = pointXY(w, 'u0:o');
    expect(cx).toBeCloseTo(34, 9);
    expect(cy).toBeCloseTo(19, 9);
    const arc = w.sketch_index.get_sketch_arc('u0:arc');
    expect(arc.radius).toBeCloseTo(6, 9);
    expect(arc.start_angle).toBeCloseTo(0, 9);
    expect(arc.end_angle).toBeCloseTo(Math.PI / 2, 9);
    expect(pointXY(w, 'u0:s')).toEqual([expect.closeTo(40, 9), expect.closeTo(19, 9)]);
    expect(pointXY(w, 'u0:e')).toEqual([expect.closeTo(34, 9), expect.closeTo(25, 9)]);
  });

  it('endpoint tangency (angle_via_point) stays regular at the exact solution', () => {
    // No perturbation: the start geometry already satisfies every constraint.
    const r = analyze(w, roundedRectangle(STAGES, 0, 'endpoint'));
    expect(r).toMatchObject({ dof: 0, redundant: [], conflicting: [] });
  });

  it('edge tangency (tangent_la + coincident) degenerates at the exact solution', () => {
    // Where the line touches the arc at the shared endpoint, the tangency
    // equation's gradient depends on the coincident's, so the diagnosis
    // drops both tangencies as redundant and the DOF count is wrong.
    const exact = analyze(w, roundedRectangle(STAGES, 0, 'edge'));
    expect(exact).toMatchObject({ dof: 2, redundant: ['u0:t-right', 'u0:t-top'] });
    // From a perturbed start the same sketch diagnoses as DOF 0.
    expect(analyze(w, roundedRectangle(STAGES, 1, 'edge'))).toMatchObject({
      dof: 0,
      redundant: [],
    });
  });
});

describe('step 4: redundant and conflicting constraints', () => {
  const extra = (c: Item) => [...fullRect(), c];

  it('a consistent duplicate is redundant: status Converged, DOF still 0', () => {
    const r = analyze(
      w,
      extra({ id: 'x', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:b1', distance: 40 }),
    );
    expect(r).toEqual({
      status: 'Converged',
      dof: 0,
      conflicting: [],
      redundant: ['x'],
      partiallyRedundant: [],
    });
  });

  it('blames the newest of equivalent constraints (push order decides)', () => {
    const items = fullRect();
    const at = items.findIndex((i) => 'id' in i && i.id === 'r:width');
    const dup: Item = { id: 'x', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:b1', distance: 40 };
    const earlier = [...items.slice(0, at), dup, ...items.slice(at)];
    expect(analyze(w, earlier).redundant).toEqual(['r:width']);
  });

  it('a horizontal on an already horizontal line is redundant', () => {
    const r = analyze(w, extra({ id: 'x', type: 'horizontal_pp', p1_id: 'r:a1', p2_id: 'r:b1' }));
    expect(r).toMatchObject({ status: 'Converged', redundant: ['x'], conflicting: [] });
  });

  it('a contradicting distance is conflicting, with the whole group listed', () => {
    const c: Item = { id: 'x', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:b1', distance: 50 };
    for (const a of ALGORITHMS) {
      const r = analyze(w, extra(c), Algorithm[a]);
      expect(r.conflicting, a).toEqual(['r:width', 'x']);
      expect(r.redundant, a).toEqual([]);
      // dof() is -1 whenever there are conflicts.
      expect(r.dof, a).toBe(-1);
      // DogLeg and LM report Failed; BFGS reports Converged. Status alone is
      // not a conflict signal.
      expect(r.status, a).toBe(a === 'BFGS' ? 'Converged' : 'Failed');
    }
  });

  it('lists every constraint that takes part in the conflict, not just the new one', () => {
    const vertical = analyze(w, extra({ id: 'x', type: 'vertical_l', l_id: 'r:bottom' }));
    expect(vertical.conflicting).toEqual(['r:h-bottom', 'r:width', 'x']);
    const diagonal = analyze(
      w,
      extra({ id: 'x', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:c2', distance: 10 }),
    );
    expect(diagonal.conflicting).toEqual([
      'r:co-b',
      'r:h-bottom',
      'r:v-right',
      'r:width',
      'r:height',
      'x',
    ]);
    // The same diagonal at its true length is merely redundant.
    const consistent = analyze(
      w,
      extra({
        id: 'x',
        type: 'p2p_distance',
        p1_id: 'r:a1',
        p2_id: 'r:c2',
        distance: Math.hypot(40, 25),
      }),
    );
    expect(consistent).toMatchObject({ redundant: ['x'], conflicting: [], dof: 0 });
  });
});

describe('diagnosis lifetime', () => {
  it('is cached across value edits: a redundant constraint made false is not reported', () => {
    const items: Item[] = [
      { type: 'param', name: 'diag', value: Math.hypot(40, 25) },
      ...fullRect(),
      { id: 'x', type: 'p2p_distance', p1_id: 'r:a1', p2_id: 'r:c2', distance: 'diag' },
    ];
    w.clear_data();
    w.push_primitives_and_params(items);
    w.solve();
    expect(w.get_gcs_redundant_constraints()).toEqual(['x']);
    // Now the diagonal contradicts width and height, but only adding or
    // removing a constraint re-runs the diagnosis. Redundant constraints are
    // left out of the solve, so it "converges" and nothing is flagged.
    w.set_sketch_param('diag', 10);
    expect(statusName(w.solve())).toBe('Converged');
    expect(w.get_gcs_conflicting_constraints()).toEqual([]);
    expect(w.get_gcs_redundant_constraints()).toEqual(['x']);
    // Rebuilding the system (a fresh diagnosis) reports the conflict.
    w.clear_data();
    w.push_primitives_and_params(items.map((i) => (i.type === 'param' ? { ...i, value: 10 } : i)));
    w.solve();
    expect(w.get_gcs_conflicting_constraints()).toEqual([
      'r:co-b',
      'r:h-bottom',
      'r:v-right',
      'r:width',
      'r:height',
      'x',
    ]);
  });
});

describe('drag (step 5 scenarios, checked for correctness)', () => {
  it('temporary constraints move the point without counting as DOF', () => {
    const s = new DragSession(w, { entities: 10, scenario: 'drag', algorithm: 'DogLeg' });
    const setup = s.setup();
    expect(setup).toMatchObject({ dof: 7, dragDof: 7 });
    for (let i = 1; i <= 30; i++) expect(s.move(i).errorMm).toBeLessThan(1e-9);
  });

  it('driving drag constraints take 2 DOF and follow the pointer too', () => {
    const s = new DragSession(w, { entities: 10, scenario: 'pin', algorithm: 'DogLeg' });
    expect(s.setup()).toMatchObject({ dof: 7, dragDof: 5 });
    for (let i = 1; i <= 30; i++) expect(s.move(i).errorMm).toBeLessThan(1e-9);
  });

  it('a dimension change re-solves the fully constrained chain exactly', () => {
    for (const a of ['DogLeg', 'LevenbergMarquardt'] as const) {
      const s = new DragSession(w, { entities: 10, scenario: 'scrub', algorithm: a });
      expect(s.setup().dof).toBe(0);
      for (let i = 1; i <= 30; i++) {
        const r = s.move(i);
        expect(r.status, a).toBe('Success');
        expect(r.errorMm, a).toBeLessThan(1e-6);
      }
    }
  });

  it('BFGS does not converge on the 50-entity dimension change', () => {
    const s = new DragSession(w, { entities: 50, scenario: 'scrub', algorithm: 'BFGS' });
    s.setup();
    expect(s.move(1).status).toBe('Failed');
  });
});

describe('wasm memory', () => {
  it('the published build has a fixed 16 MiB memory', () => {
    expect(memoryLimits(stockBytes())).toEqual({ minPages: 256, maxPages: 256 });
    expect(memoryLimits(withMemoryPages(stockBytes(), 1024))).toEqual({
      minPages: 1024,
      maxPages: 1024,
    });
  });

  it('aborts with OOM at 150 entities; 64 MiB solves 200', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const stock = createWrapper(await loadModule());
      expect(() => analyze(stock, chain({ entities: 150, mode: 'full', perturb: 0.5 }))).toThrow(
        /OOM/,
      );
    } finally {
      console.error = quiet;
    }
    const big = createWrapper(await loadModule({ wasmBytes: stockBytes(), memoryPages: 1024 }));
    expect(analyze(big, chain({ entities: 200, mode: 'full', perturb: 0.5 }))).toMatchObject({
      status: 'Success',
      dof: 0,
    });
  });
});
