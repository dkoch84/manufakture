// Property tests on random inputs: whatever the packer returns must pass the independent
// checker (no overlap with kerf, inside the trimmed area, grain locks, a cut tree that replays
// as guillotine cuts within the stage limit, counts that add up), be reproducible, and leave
// unplaced only parts that really cannot be placed.

import { describe, expect, it } from 'vitest';
import { seededRandom } from './common';
import { layoutSheets, orientations, resolveTrims, usableRect } from './sheet';
import type { Grain, SheetInput, SheetPart, SheetStock } from './sheet';
import { checkSheetLayout } from './sheet-check';

const GRAINS: Grain[] = ['length', 'width', 'none'];
const STAGES = [1, 2, 3, 'unlimited'] as const;
const KERFS = [0, 0.125, 3.2];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** Sizes in quarter units, so exact fits (and exact misses by the kerf) happen often. */
function randomInput(seed: number): SheetInput {
  const random = seededRandom(seed);
  const size = (lo: number, hi: number) => Math.round((lo + random() * (hi - lo)) * 4) / 4;
  const stock: SheetStock[] = [];
  const nStock = 1 + Math.floor(random() * 2);
  for (let i = 0; i < nStock; i++) {
    const s: SheetStock = {
      id: `s${i}`,
      length: size(40, 100),
      width: size(20, 50),
      grain: pick(random, GRAINS),
    };
    if (random() < 0.3) s.quantity = 1 + Math.floor(random() * 3);
    if (random() < 0.3) s.cost = Math.round(random() * 100);
    stock.push(s);
  }
  const parts: SheetPart[] = [];
  const nParts = 1 + Math.floor(random() * 10);
  for (let i = 0; i < nParts; i++) {
    parts.push({
      id: `p${i}`,
      length: size(2, 60),
      width: size(2, 40),
      quantity: 1 + Math.floor(random() * 4),
      grainLocked: random() < 0.5,
    });
  }
  const trims = random() < 0.5 ? 0 : { lengthStart: size(0, 1), widthEnd: size(0, 1) };
  return {
    parts,
    stock,
    settings: {
      kerf: pick(random, KERFS),
      trims,
      maxStages: pick(random, STAGES),
      minOffcut: random() < 0.5 ? { length: 0, width: 0 } : { length: 12, width: 4 },
      randomAttempts: 3,
      seed,
    },
  };
}

describe('sheet layout properties', () => {
  it('every layout of 200 random inputs passes the checker', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seed);
      const result = layoutSheets(input);
      const problems = checkSheetLayout(input, result);
      if (problems.length > 0) {
        throw new Error(`seed ${seed}:\n${problems.join('\n')}\n${JSON.stringify(input)}`);
      }
    }
  });

  it('unplaced parts are out of stock or fit no empty sheet', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomInput(seed);
      const result = layoutSheets(input);
      const trims = resolveTrims(input.settings.trims);
      for (const u of result.unplaced) {
        const part = input.parts.find((p) => p.id === u.partId)!;
        // With a stage limit of 2 or more, a part that fits an empty usable area by size is
        // freed by at most two cuts, so 'does-not-fit' must mean it fits no stock by size.
        const fitsBySize = input.stock.some((s) => {
          const u = usableRect(s, trims);
          return orientations(part, s.grain).some(
            (o) => o.sizeX <= u.sizeX + 1e-9 && o.sizeY <= u.sizeY + 1e-9,
          );
        });
        if (u.reason === 'does-not-fit' && input.settings.maxStages !== 1) {
          expect(fitsBySize, `seed ${seed} part ${part.id}`).toBe(false);
        }
        if (u.reason === 'out-of-stock') {
          expect(input.stock.some((s) => s.quantity !== undefined)).toBe(true);
        }
      }
      // With unlimited stock nothing runs out.
      if (input.stock.every((s) => s.quantity === undefined)) {
        expect(result.unplaced.every((u) => u.reason !== 'out-of-stock')).toBe(true);
      }
    }
  });

  it('is reproducible: the same input gives the same result', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const input = randomInput(seed);
      expect(JSON.stringify(layoutSheets(input))).toBe(JSON.stringify(layoutSheets(input)));
    }
  });

  it('totals agree with the sheets', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomInput(seed);
      const r = layoutSheets(input);
      const parts = r.sheets.reduce((a, s) => a + s.partsArea, 0);
      const placed = r.sheets.flatMap((s) => s.placements);
      expect(parts).toBeCloseTo(
        placed.reduce((a, p) => a + p.sizeX * p.sizeY, 0),
        6,
      );
      expect(r.totals.sheets).toBe(r.sheets.length);
      for (const s of r.sheets) {
        expect(s.partsArea + s.offcutArea).toBeLessThanOrEqual(s.sheetArea + 1e-6);
      }
    }
  });
});
