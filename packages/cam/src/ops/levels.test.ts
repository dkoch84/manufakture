import { describe, expect, it } from 'vitest';
import { rect } from '../offset/test-shapes';
import type { Setup, Tool } from '../types';
import type { OperationContext } from '../worker/registry';
import { generateFacing, type FacingOperation } from './facing';
import { generatePocket, type PocketOperation } from './pocket';
import { MAX_DEPTH_LEVELS, generateProfile, levels, type ProfileOperation } from './profile';

const tool: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const feeds = { spindle: 18000, cut: 1000, plunge: 300 };

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [0, 0, -12], max: [100, 60, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};

const context: OperationContext = {
  generation: 1,
  cancelled: false,
  setup,
  checkpoint: () => Promise.resolve(),
};

describe('levels', () => {
  it('steps down evenly to the bottom', () => {
    expect(levels(0, -6, 2)).toEqual({ ok: true, value: [-2, -4, -6] });
    expect(levels(0, -5, 2)).toEqual({ ok: true, value: [-5 / 3, -10 / 3, -5] });
    // A step deeper than the cut, and a cut with no depth: one level at the bottom.
    expect(levels(0, -1, 5)).toEqual({ ok: true, value: [-1] });
    expect(levels(-1, -1, 1)).toEqual({ ok: true, value: [-1] });
  });

  it('allows MAX_DEPTH_LEVELS levels and refuses one more', () => {
    const at = levels(0, -MAX_DEPTH_LEVELS * 0.05, 0.05);
    expect(at.ok && at.value.length).toBe(MAX_DEPTH_LEVELS);
    const over = levels(0, -(MAX_DEPTH_LEVELS + 1) * 0.05, 0.05);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.message).toMatch(/at most 1000/);
  });

  it('refuses a step that is tiny, zero, negative or not a number, without running out of memory', () => {
    for (const step of [1e-12, Number.MIN_VALUE, 0, -1, NaN, Infinity]) {
      const r = levels(0, -10, step);
      expect(r.ok, `step ${step}`).toBe(false);
    }
    expect(levels(NaN, -10, 1).ok).toBe(false);
    expect(levels(0, -Infinity, 1).ok).toBe(false);
  });
});

describe('levels: callers surface the error', () => {
  const tiny = 1e-7;

  it('profile', async () => {
    const op: ProfileOperation = {
      kind: 'profile',
      id: 'profile#1',
      name: 'Outline',
      tool,
      feeds,
      loops: [rect(10, 10, 40, 20)],
      side: 'outside',
      depth: { top: 0, bottom: -6 },
      stepdown: tiny,
      finishAllowance: 0,
      entry: { kind: 'plunge' },
      leadIn: { kind: 'none' },
      leadOut: { kind: 'none' },
      climb: true,
    };
    const r = await generateProfile(op, context);
    expect(!r.ok && r.error.message).toMatch(/^profile#1: A stepdown of 1e-7 mm/);
    // The finishing stepdown is checked too.
    const f = await generateProfile(
      { ...op, stepdown: 3, finishAllowance: 0.5, finishStepdown: tiny } as ProfileOperation,
      context,
    );
    expect(!f.ok && f.error.code).toBe('invalid-input');
  });

  it('pocket', async () => {
    const op: PocketOperation = {
      kind: 'pocket',
      id: 'pocket#1',
      name: 'Recess',
      tool,
      feeds,
      loops: [rect(10, 10, 40, 30)],
      depth: { top: 0, bottom: -4 },
      stepdown: tiny,
      stepover: 0.5,
      finishAllowance: 0,
      entry: { kind: 'plunge' },
      climb: true,
    };
    const r = await generatePocket(op, context);
    expect(!r.ok && r.error.message).toMatch(/^pocket#1: A stepdown/);
    const f = await generatePocket(
      { ...op, stepdown: 2, finishAllowance: 0.5, finishStepdown: tiny } as PocketOperation,
      context,
    );
    expect(!f.ok && f.error.code).toBe('invalid-input');
  });

  it('facing', async () => {
    const op: FacingOperation = {
      kind: 'facing',
      id: 'facing#1',
      name: 'Face',
      tool,
      feeds,
      loops: [rect(0, 0, 100, 60)],
      depth: { top: 0, bottom: -1 },
      stepdown: tiny,
      stepover: 0.5,
      angle: 0,
    };
    const r = await generateFacing(op, context);
    expect(!r.ok && r.error.message).toMatch(/^facing#1: A stepdown/);
  });
});
