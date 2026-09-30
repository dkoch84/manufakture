// The T2.3a benchmark: solve and drag times for trees of 10 to 500 instances, a four-bar, a
// slider-crank, 20 four-bar loops, and a 50-instance assembly with a few loops.
//
// Budgets (ADR 0008, the M2 plan): a 200-instance tree solves in under 2 ms; a drag step in a
// 50-instance assembly with a few loops takes under 8 ms. A miss is reported, not failed,
// because CI machines vary; the numbers go to the test output (`BENCH ...` lines; run with
// `--silent=false --reporter=verbose`) and to packages/assembly/build/benchmark.json
// (gitignored), which CI can print.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AssemblyInput, DragTarget, InstanceInput, MateInput, MateKind } from './model';
import { drag, solve } from './solver';
import { I, at, deg, fourBar, inst, mate, place, randomPose, rng } from './test-helpers';
import { transformPoint, type Pose, type Vec3 } from './transform';

const WARMUP = 10;
const RUNS = 60;

interface Result {
  name: string;
  instances: number;
  mates: number;
  operation: 'solve' | 'drag';
  median: number;
  p95: number;
  max: number;
  budget?: number;
  withinBudget?: boolean;
}

const results: Result[] = [];

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)]!;
  return { median: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
}

function record(
  name: string,
  inp: AssemblyInput,
  operation: 'solve' | 'drag',
  samples: number[],
  budget?: number,
) {
  const { median, p95, max } = stats(samples);
  const r: Result = {
    name,
    instances: inp.instances.length,
    mates: inp.mates.length,
    operation,
    median,
    p95,
    max,
  };
  let note = '';
  if (budget !== undefined) {
    r.budget = budget;
    r.withinBudget = median < budget;
    note = r.withinBudget ? ` (budget ${budget} ms: met)` : ` (budget ${budget} ms: MISSED)`;
  }
  results.push(r);
  console.log(
    `BENCH ${name} ${operation}: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, ` +
      `max ${max.toFixed(3)} ms${note}`,
  );
}

function timeSolve(inp: AssemblyInput): number[] {
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const t0 = performance.now();
    const r = solve(inp);
    const t = performance.now() - t0;
    expect(r.outcome).toBe('solved');
    if (i >= WARMUP) samples.push(t);
  }
  return samples;
}

/** A drag of `id`'s point along a path of targets, each result feeding the next move. */
function timeDrag(
  inp: AssemblyInput,
  id: string,
  point: Vec3,
  path: (i: number, start: Vec3) => Vec3,
): number[] {
  const samples: number[] = [];
  let current = inp;
  const startPose = inp.instances.find((i) => i.id === id)!.pose;
  const start = transformPoint(startPose, point);
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const target: DragTarget = { point, position: path(i, start) };
    const t0 = performance.now();
    const r = drag(current, id, target);
    const t = performance.now() - t0;
    expect(r.outcome).toBe('solved');
    if (i >= WARMUP) samples.push(t);
    current = {
      ...current,
      instances: current.instances.map((x) => ({ ...x, pose: r.poses[x.id] ?? x.pose })),
    };
  }
  return samples;
}

/** A small circle around the start: a pointer wiggling while it drags. */
const wiggle =
  (radius: number) =>
  (i: number, s: Vec3): Vec3 => {
    const a = (2 * Math.PI * i) / 30;
    return [s[0] + radius * (Math.cos(a) - 1), s[1] + radius * Math.sin(a), s[2]];
  };

/**
 * A random tree of `n` instances under one fixed root, poses consistent with the mates.
 * Kinds are the furniture and printing mix: mostly fastened, some revolutes and sliders.
 */
function tree(n: number, seed: number, prefix = 't', root?: InstanceInput) {
  const r = rng(seed);
  const kinds: MateKind[] = ['fastened', 'fastened', 'revolute', 'slider', 'planar', 'revolute'];
  const rootInst = root ?? inst(`${prefix}0`, I, true);
  const instances: InstanceInput[] = root ? [] : [rootInst];
  const ids = [rootInst.id];
  const poses: Pose[] = [rootInst.pose];
  const mates: MateInput[] = [];
  for (let i = 1; i < n; i++) {
    // Mostly shallow, some deep chains: attach to a recent instance.
    const p = Math.max(0, i - 1 - Math.floor(r() * Math.min(i, 8)));
    const kind = kinds[Math.floor(r() * kinds.length)]!;
    const m = mate(
      `${prefix}m${i}`,
      kind,
      [ids[p]!, randomPose(r, 40)],
      [`${prefix}${i}`, randomPose(r, 40)],
    );
    const q = [(r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2];
    const pose = place(poses[p]!, m, q);
    ids.push(`${prefix}${i}`);
    poses.push(pose);
    instances.push(inst(`${prefix}${i}`, pose));
    mates.push(m);
  }
  return { instances, mates, deepest: ids[ids.length - 1]! };
}

function sliderCrank(): AssemblyInput {
  const sx = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const;
  const theta = deg(40);
  const B: Vec3 = [2 * Math.cos(theta), 2 * Math.sin(theta), 0];
  const px = B[0] + Math.sqrt(36 - B[1] * B[1]);
  return {
    instances: [
      inst('g', I, true),
      inst('crank', at([0, 0, 0], [0, 0, Math.sin(theta / 2), Math.cos(theta / 2)])),
      inst(
        'rod',
        at(B, [
          0,
          0,
          Math.sin(Math.atan2(-B[1], px - B[0]) / 2),
          Math.cos(Math.atan2(-B[1], px - B[0]) / 2),
        ]),
      ),
      inst('piston', at([px, 0, 0])),
    ],
    mates: [
      mate('m1', 'revolute', ['g', I], ['crank', I]),
      mate('m2', 'revolute', ['crank', at([2, 0, 0])], ['rod', I]),
      mate('m3', 'slider', ['g', at([0, 0, 0], sx)], ['piston', at([0, 0, 0], sx)]),
      mate('m4', 'revolute', ['rod', at([6, 0, 0])], ['piston', I]),
    ],
  };
}

function loops(count: number): AssemblyInput {
  const instances: InstanceInput[] = [];
  const mates: MateInput[] = [];
  for (let k = 0; k < count; k++) {
    const fb = fourBar(deg(40 + k), undefined, `L${k}.`, at([20 * k, 0, 0]));
    instances.push(...fb.instances);
    mates.push(...fb.mates);
  }
  return { instances, mates };
}

/** 50 instances: three four-bars, and a tree of 38 hanging off the ground and the couplers. */
function mixed(): AssemblyInput {
  const base = loops(3);
  const instances = [...base.instances];
  const mates = [...base.mates];
  const coupler = (k: number) => instances.find((i) => i.id === `L${k}.coupler`)!;
  // Trees of 13, 13 and 12 instances under the three couplers: 38.
  for (let k = 0; k < 3; k++) {
    const t = tree(k === 2 ? 13 : 14, 100 + k, `c${k}.`, coupler(k));
    instances.push(...t.instances);
    mates.push(...t.mates);
  }
  return { instances, mates };
}

describe('benchmark', () => {
  for (const n of [10, 100, 200, 500]) {
    it(`a tree of ${n} instances`, () => {
      const t = tree(n, n);
      const inp: AssemblyInput = { instances: t.instances, mates: t.mates };
      record(`tree-${n}`, inp, 'solve', timeSolve(inp), n === 200 ? 2 : undefined);
      record(`tree-${n}`, inp, 'drag', timeDrag(inp, t.deepest, [0, 0, 0], wiggle(1)));
    });
  }

  it('a four-bar', () => {
    const fb = fourBar(deg(60));
    const inp: AssemblyInput = { instances: fb.instances, mates: fb.mates };
    record('four-bar', inp, 'solve', timeSolve(inp));
    const crank = (i: number): Vec3 => {
      const a = deg(60 + 3 * i);
      return [2 * Math.cos(a), 2 * Math.sin(a), 0];
    };
    record('four-bar', inp, 'drag', timeDrag(inp, 'crank', [2, 0, 0], crank));
  });

  it('a slider-crank', () => {
    const inp = sliderCrank();
    record('slider-crank', inp, 'solve', timeSolve(inp));
    const crank = (i: number): Vec3 => {
      const a = deg(40 + 3 * i);
      return [2 * Math.cos(a), 2 * Math.sin(a), 0];
    };
    record('slider-crank', inp, 'drag', timeDrag(inp, 'crank', [2, 0, 0], crank));
  });

  it('20 loops of 4', () => {
    const inp = loops(20);
    record('loops-20x4', inp, 'solve', timeSolve(inp));
    const crank = (i: number): Vec3 => {
      const a = deg(40 + 2 * i);
      return [2 * Math.cos(a), 2 * Math.sin(a), 0];
    };
    record('loops-20x4', inp, 'drag', timeDrag(inp, 'L0.crank', [2, 0, 0], crank));
  });

  it('50 instances with three loops', () => {
    const inp = mixed();
    expect(inp.instances).toHaveLength(50);
    record('mixed-50', inp, 'solve', timeSolve(inp));
    // A loop drag (the crank moves a loop and the tree on its coupler) and a tree drag.
    const crank = (i: number): Vec3 => {
      const a = deg(40 + 2 * i);
      return [20 + 2 * Math.cos(a), 2 * Math.sin(a), 0];
    };
    record('mixed-50 loop', inp, 'drag', timeDrag(inp, 'L1.crank', [2, 0, 0], crank), 8);
    const leaf = inp.instances[inp.instances.length - 1]!.id;
    record('mixed-50 tree', inp, 'drag', timeDrag(inp, leaf, [0, 0, 0], wiggle(1)), 8);
  });

  afterAll(() => {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'benchmark.json');
    mkdirSync(dirname(out), { recursive: true });
    const info = {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      warmup: WARMUP,
      runs: RUNS,
      unit: 'ms',
      results,
    };
    writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
    console.log(`BENCH results written to ${out}`);
  });
});
