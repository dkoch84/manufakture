import { describe, expect, it } from 'vitest';
import { seededRandom } from './common';
import { FACE_FRAME, KERF_1_8, threeThirds } from './fixtures';
import {
  checkStickLayout,
  layoutSticks,
  layoutSticksAsync,
  type StickInput,
  type StickLayoutResult,
} from './stick';

function layout(input: StickInput): StickLayoutResult {
  const r = layoutSticks(input);
  expect(checkStickLayout(input, r)).toEqual([]);
  return r;
}

describe('hand-computed stick fixtures', () => {
  it('three 32" pieces: one 96" stick with no kerf, two with a 1/8" kerf', () => {
    const exact = layout(threeThirds(0));
    expect(exact.sticks).toHaveLength(1);
    expect(exact.sticks[0]!.cuts.map((c) => c.start)).toEqual([0, 32, 64]);
    expect(exact.sticks[0]!.offcut).toBeNull();
    expect(exact.totals.utilisation).toBe(1);

    const kerf = layout(threeThirds(KERF_1_8));
    expect(kerf.sticks).toHaveLength(2);
    expect(kerf.sticks.map((s) => s.cuts.length).sort()).toEqual([1, 2]);
    // Two pieces: 32 + 1/8 + 32, offcut from 64.25 to 96.
    const two = kerf.sticks.find((s) => s.cuts.length === 2)!;
    expect(two.cuts.map((c) => c.start)).toEqual([0, 32.125]);
    expect(two.offcut).toEqual({ start: 64.25, length: 31.75 });
  });

  it("the face frame takes three 8' sticks", () => {
    const r = layout(FACE_FRAME);
    expect(r.sticks).toHaveLength(3);
    expect(r.totals.stockLength).toBe(288);
    expect(r.totals.partsLength).toBe(225);
    expect(r.totals.utilisation).toBeCloseTo(225 / 288, 12);
    const rails = r.sticks.find((s) => s.cuts.every((c) => c.partId === 'rail'))!;
    expect(rails.cuts.map((c) => c.start)).toEqual([0, 27.125, 54.25]);
    // 96 - (3 x 27 + 2 x 1/8) - 1/8 = 14.625
    expect(rails.offcut).toEqual({ start: 81.375, length: 14.625 });
    const stiles = r.sticks.filter((s) => s.cuts.some((c) => c.partId === 'stile'));
    expect(stiles).toHaveLength(2);
    for (const s of stiles) expect(s.offcut?.length).toBe(23.875);
  });

  it('end trims shorten the usable length', () => {
    // Two 47" pieces from 96": no trims, 47 + 1/8 + 47 = 94.125 <= 96, one stick. With 1"
    // trims at each end the usable 94" is too short for both, so two sticks.
    const input: StickInput = {
      parts: [{ id: 'p', length: 47, quantity: 2 }],
      stock: [{ id: '8ft', length: 96 }],
      settings: { kerf: KERF_1_8 },
    };
    expect(layout(input).sticks).toHaveLength(1);
    const trimmed = layout({ ...input, settings: { kerf: KERF_1_8, trims: 1 } });
    expect(trimmed.sticks).toHaveLength(2);
    expect(trimmed.sticks[0]!.cuts[0]!.start).toBe(1);
    expect(trimmed.sticks[0]!.usableEnd).toBe(95);
  });

  it('picks the stock lengths that use the least lumber', () => {
    // Four 59" pieces, 8' and 10' stock, kerf 1/8: a 96" stick holds one (two need 118.125),
    // a 120" stick holds two. 2 x 120 = 240" beats 4 x 96 = 384".
    const r = layout({
      parts: [{ id: 'p', length: 59, quantity: 4 }],
      stock: [
        { id: '8ft', length: 96 },
        { id: '10ft', length: 120 },
      ],
      settings: { kerf: KERF_1_8 },
    });
    expect(r.sticks.map((s) => s.stockId)).toEqual(['10ft', '10ft']);
    expect(r.totals.stockLength).toBe(240);
  });

  it('uses one long stick when that takes less lumber than two shorter ones', () => {
    // 100" and 20" pieces from 8', 10' and 12' stock: the 100" needs a 10' (120"), with the 20"
    // beside it (100 + 1/8 + 20 = 120.125 > 120, so not) or on its own 8'. Best total: 120 + 96
    // = 216, or one 12' (144) holding both (120.125 <= 144): 144 wins.
    const r = layout({
      parts: [
        { id: 'long', length: 100, quantity: 1 },
        { id: 'short', length: 20, quantity: 1 },
      ],
      stock: [
        { id: '8ft', length: 96 },
        { id: '10ft', length: 120 },
        { id: '12ft', length: 144 },
      ],
      settings: { kerf: KERF_1_8 },
    });
    expect(r.totals.stockLength).toBe(144);
    expect(r.sticks.map((s) => s.stockId)).toEqual(['12ft']);
  });

  it('reports pieces that fit no stock and pieces left when stock runs out', () => {
    const r = layout({
      parts: [
        { id: 'huge', length: 200, quantity: 1 },
        { id: 'p', length: 50, quantity: 3 },
        { id: 'bad', length: Number.NaN, quantity: 1 },
      ],
      stock: [{ id: '8ft', length: 96, quantity: 1 }],
      settings: { kerf: 0 },
    });
    expect(r.sticks).toHaveLength(1);
    expect(r.unplaced).toEqual([
      { partId: 'bad', quantity: 1, reason: 'invalid' },
      { partId: 'huge', quantity: 1, reason: 'does-not-fit' },
      { partId: 'p', quantity: 2, reason: 'out-of-stock' },
    ]);
  });

  it('classifies the leftover by the minimum offcut length', () => {
    const r = layout({ ...threeThirds(KERF_1_8), settings: { kerf: KERF_1_8, minOffcut: 40 } });
    // Leftovers 31.75 and 63.875: only the second is an offcut.
    const offcuts = r.sticks.map((s) => s.offcut?.length ?? null).sort();
    expect(offcuts).toEqual([63.875, null]);
  });

  it('ranks by cost when every stock is priced', () => {
    // Two 50" pieces: one 10' at 20 or two 8' at 8 each (16). Cost wins over length.
    const r = layout({
      parts: [{ id: 'p', length: 50, quantity: 2 }],
      stock: [
        { id: '8ft', length: 96, cost: 8 },
        { id: '10ft', length: 120, cost: 20 },
      ],
      settings: { kerf: KERF_1_8 },
    });
    expect(r.totals.cost).toBe(16);
    expect(r.stock).toEqual([{ stockId: '8ft', count: 2, cost: 16 }]);
  });

  it('rejects invalid settings', () => {
    expect(() => layoutSticks({ ...FACE_FRAME, settings: { kerf: -1 } })).toThrow(RangeError);
    expect(() => layoutSticks({ ...FACE_FRAME, settings: { kerf: 0, trims: 48 } })).toThrow(
      RangeError,
    );
  });
});

describe('stick properties', () => {
  it('random inputs pass the checker and are reproducible', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seededRandom(seed);
      const q = (lo: number, hi: number) => Math.round((lo + random() * (hi - lo)) * 8) / 8;
      const input: StickInput = {
        parts: Array.from({ length: 1 + Math.floor(random() * 8) }, (_, i) => ({
          id: `p${i}`,
          length: q(2, 130),
          quantity: 1 + Math.floor(random() * 5),
        })),
        stock: [
          { id: 'a', length: 96 },
          ...(random() < 0.5 ? [{ id: 'b', length: 144, quantity: 2 }] : []),
        ],
        settings: {
          kerf: random() < 0.5 ? 0 : 0.125,
          trims: random() < 0.5 ? 0 : { start: q(0, 2), end: q(0, 2) },
          minOffcut: random() < 0.5 ? 0 : 12,
          randomAttempts: 5,
          seed,
        },
      };
      const r = layoutSticks(input);
      const problems = checkStickLayout(input, r);
      if (problems.length) throw new Error(`seed ${seed}: ${problems.join('\n')}`);
      expect(JSON.stringify(layoutSticks(input))).toBe(JSON.stringify(r));
      // Lower bound: the stock used holds at least the parts.
      expect(r.totals.stockLength).toBeGreaterThanOrEqual(r.totals.partsLength);
    }
  });

  it('the async form rejects when aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(layoutSticksAsync(FACE_FRAME, { signal: controller.signal })).rejects.toThrow(
      'stop',
    );
    expect(JSON.stringify(await layoutSticksAsync(FACE_FRAME))).toBe(
      JSON.stringify(layoutSticks(FACE_FRAME)),
    );
  });
});

describe('the stick checker', () => {
  it('catches pieces closer than the kerf and missing pieces', () => {
    const r = layoutSticks(threeThirds(KERF_1_8));
    const bad = structuredClone(r);
    const two = bad.sticks.find((s) => s.cuts.length === 2)!;
    two.cuts[1]!.start = 32.0625;
    expect(checkStickLayout(threeThirds(KERF_1_8), bad).join('\n')).toMatch(/kerf/);
    const lost = structuredClone(r);
    lost.sticks.pop();
    expect(checkStickLayout(threeThirds(KERF_1_8), lost).join('\n')).toMatch(/quantity/);
  });
});
