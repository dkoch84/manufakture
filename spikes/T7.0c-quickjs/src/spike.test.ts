// Fast checks of the spike's harness: every variant loads from a compiled module, the ADR 0010
// globals are in place, limits fire, and the determinism script runs in QuickJS.

import { describe, expect, it } from 'vitest';
import { nodeEnv } from '../scripts/node-env';
import {
  determinismOutputs,
  globalSurface,
  measureInterrupts,
  measureLoad,
  measureMemoryLimits,
} from './bench';
import { differences } from './determinism';
import { VARIANT_NAMES } from './variants';

describe('T7.0c QuickJS spike', () => {
  it.each(VARIANT_NAMES)('%s loads from a compiled module and runs a script', async (name) => {
    const r = await measureLoad(nodeEnv, name);
    expect(r.memoryBytes).toBe(16 * 1024 * 1024);
  });

  it('removes Date and seeds Math.random', async () => {
    const a = (await globalSurface(nodeEnv, 'quickjs-sync')) as { date: string; random: number[] };
    const b = (await globalSurface(nodeEnv, 'ng-sync')) as { date: string; random: number[] };
    expect(a.date).toBe('undefined');
    expect(b.date).toBe('undefined');
    expect(a.random).toEqual(b.random);
  });

  it('interrupts an infinite loop', async () => {
    const cases = await measureInterrupts(nodeEnv, 'quickjs-sync', 20, ['empty for(;;)']);
    const loop = cases.find((c) => c.case === 'empty for(;;)')!;
    expect(loop.error).toMatch(/interrupted/);
    expect(loop.overshootMs).toBeLessThan(20);
  });

  it('stops at a Memory maximum', async () => {
    const cases = await measureMemoryLimits(nodeEnv, 'ng-sync', 'memory-maximum', 32);
    for (const c of cases) {
      expect(c.error).not.toMatch(/^finished/);
      expect(c.wasmMiB).toBeLessThanOrEqual(48);
    }
  });

  it('gives the same determinism output in both QuickJS builds', async () => {
    const out = await determinismOutputs(nodeEnv);
    expect(Object.keys(out.host!.math).length).toBeGreaterThan(20);
    // Bellard's QuickJS and QuickJS-ng share no guarantee; the spike records how far they differ.
    expect(differences(out['quickjs-sync']!, out['quickjs-sync']!)).toEqual([]);
  });
});
