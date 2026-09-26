// Acceptance: solving 50 entities stays under the 16 ms frame target. Measured
// in Node on one coupled 50-entity system (the T0.4 chain: 10 rounded
// rectangles joined in a row, 250 unknowns), with a tolerant bound so a slow
// CI machine does not flake: the spike measured 1.7 to 3.1 ms here.
//
// The numbers are printed (`LATENCY ...`) for the task report.

import { lengthQuantity } from '@manufakture/units';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyCoordinates } from './model';
import { loadPlanegcsBackend, type PlanegcsBackend } from './planegcs/system';
import { UNIT, chain, pointAt, start } from './test-helpers';

const FRAME_MS = 16;
const WARMUP = 5;
const MOVES = 60;

let backend: PlanegcsBackend;
beforeAll(async () => {
  backend = await loadPlanegcsBackend();
});

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return { median: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

function report(name: string, samples: number[]) {
  const { median, p95, max } = stats(samples);
  console.log(
    `LATENCY ${name}: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
  );
  return { median, p95 };
}

describe('50 entities in one coupled system', () => {
  it('a FreeCAD-style drag re-solves within a frame', () => {
    const system = backend.createSystem();
    const sketch = chain({ entities: 50, mode: 'free' });
    const loaded = system.update(sketch);
    expect(loaded.status).toBe('solved');
    const dragged = start('u5.left');
    const from = pointAt(loaded.entities, dragged);
    system.beginDrag(dragged);
    const samples: number[] = [];
    let maxError = 0;
    for (let i = 1; i <= WARMUP + MOVES; i++) {
      const a = (2 * Math.PI * i) / MOVES;
      const target = [from[0] + 10 * (Math.cos(a) - 1), from[1] + 10 * Math.sin(a)] as const;
      const t0 = performance.now();
      const r = system.drag(target);
      const t = performance.now() - t0;
      expect(r.status).toBe('solved');
      if (i > WARMUP) samples.push(t);
      const at = pointAt(applyCoordinates(sketch.entities, r.coordinates), dragged);
      maxError = Math.max(maxError, Math.hypot(at[0] - target[0], at[1] - target[1]));
    }
    system.endDrag();
    expect(maxError).toBeLessThan(1e-6);
    const { median } = report(
      'drag (50 entities, under-constrained, per move incl. read-back)',
      samples,
    );
    expect(median).toBeLessThan(FRAME_MS);
  });

  it('a dimension scrub on a fully constrained sketch re-solves within a frame', () => {
    const system = backend.createSystem();
    const sketch = chain({ entities: 50, mode: 'full', perturb: 0.5 });
    const vars = (w: number) => (n: string) => (n === 'w0' ? lengthQuantity(w) : undefined);
    const first = system.update(sketch, { variables: vars(UNIT.width) });
    expect(first.diagnosis.dof).toBe(0);
    const samples: number[] = [];
    let current = first.entities;
    for (let i = 1; i <= WARMUP + MOVES; i++) {
      const w = UNIT.width + 10 * Math.sin((2 * Math.PI * i) / MOVES);
      const t0 = performance.now();
      const r = system.update(
        { entities: current, constraints: sketch.constraints },
        { variables: vars(w), analyze: false },
      );
      const t = performance.now() - t0;
      expect(r.status).toBe('solved');
      current = r.entities;
      if (i > WARMUP) samples.push(t);
      // The last unit shifts by exactly the width change.
      expect(pointAt(r.entities, start('u9.bottom'))[0]).toBeCloseTo(
        w + UNIT.gap + 8 * (UNIT.width + UNIT.gap),
        6,
      );
    }
    const { median } = report('dimension edit (50 entities, DOF 0, full update call)', samples);
    expect(median).toBeLessThan(FRAME_MS);
  });

  it('a topology change (load, solve, diagnosis and per-entity analysis) is measured', () => {
    const sketch = chain({ entities: 50, mode: 'full', perturb: 0.5 });
    const variables = (n: string) => (n === 'w0' ? lengthQuantity(UNIT.width) : undefined);
    const samples: number[] = [];
    const system = backend.createSystem();
    for (let i = 0; i < 12; i++) {
      // A new entity order each time forces a rebuild, as adding geometry does.
      const entities = i % 2 === 0 ? sketch.entities : [...sketch.entities].reverse();
      const t0 = performance.now();
      const r = system.update({ entities, constraints: sketch.constraints }, { variables });
      samples.push(performance.now() - t0);
      expect(r.diagnosis.dof).toBe(0);
      expect(system.lastAnalysis?.dof).toBe(0);
      expect(system.lastAnalysis?.unknowns).toBe(250);
      expect(Object.values(r.diagnosis.entities).every((s) => s === 'fully')).toBe(true);
    }
    const { median } = report(
      'rebuild + solve + diagnose + analysis (50 entities)',
      samples.slice(2),
    );
    // Not held to one frame (T0.4 measured the first solve alone at a few ms),
    // but it must stay interactive.
    expect(median).toBeLessThan(100);
  });
});
