// The T4.3c benchmark: our guillotine packer against guillotine-packer 1.0.2 (MIT, a
// development dependency only) on fixture cut lists: sheets used, waste and time. It prints
// `BENCH ...` lines, which Vitest shows only with `--silent=false --reporter=verbose`
// (`pnpm --filter @manufakture/nesting bench`). Numbers are reported, not asserted, except
// that our layouts must be valid; the README carries a table of one run.
//
// guillotine-packer has no trims, grain or stage limit, and rotation is all or nothing, so the
// cases use what both can express: no trims, every part locked (rotation off) or every part
// free (rotation on), unlimited stages. Its layouts are checked for kerf gaps here too.

import { packer } from 'guillotine-packer';
import { describe, expect, it } from 'vitest';
import { seededRandom } from './common';
import { bookshelfA, KERF_1_8, PLYWOOD_4X8, MDF_4X8 } from './fixtures';
import { layoutSheets, type SheetInput, type SheetPart } from './sheet';
import { checkSheetLayout } from './sheet-check';

const RUNS = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Four base cabinets, 34 1/2" tall, 23 1/4" deep, in 3/4" plywood (grain-locked). */
function cabinets(): SheetInput {
  const parts: SheetPart[] = [];
  const widths = [12, 18, 24, 30];
  widths.forEach((w, i) => {
    const inner = w - 1.5;
    parts.push(
      { id: `c${i}-side`, length: 34.5, width: 23.25, quantity: 2, grainLocked: true },
      { id: `c${i}-bottom`, length: inner, width: 23.25, quantity: 1, grainLocked: true },
      { id: `c${i}-stretcher`, length: inner, width: 4, quantity: 2, grainLocked: true },
      { id: `c${i}-shelf`, length: inner - 0.0625, width: 22, quantity: 1, grainLocked: true },
      { id: `c${i}-back`, length: inner, width: 33.75, quantity: 1, grainLocked: true },
    );
  });
  return { parts, stock: [PLYWOOD_4X8], settings: { kerf: KERF_1_8 } };
}

/** Random free (rotatable) parts on MDF, sizes in 1/8" steps. */
function randomParts(n: number, seed: number): SheetInput {
  const random = seededRandom(seed);
  const q = (lo: number, hi: number) => Math.round((lo + random() * (hi - lo)) * 8) / 8;
  const parts: SheetPart[] = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    length: q(4, 40),
    width: q(3, 24),
    quantity: 1,
    grainLocked: false,
  }));
  return { parts, stock: [MDF_4X8], settings: { kerf: KERF_1_8 } };
}

interface Row {
  name: string;
  parts: number;
  /** Sheets the parts' area alone needs: no packer can use fewer. */
  bound: number;
  ours: { sheets: number; waste: number; ms: number };
  theirs: { sheets: number; waste: number; ms: number; valid: boolean };
}

function runTheirs(input: SheetInput) {
  const stock = input.stock[0]!;
  const rotate = input.parts.some((p) => !p.grainLocked);
  const items = input.parts.flatMap((p) =>
    Array.from({ length: p.quantity }, () => ({ name: p.id, width: p.length, height: p.width })),
  );
  const run = () =>
    packer(
      { binWidth: stock.length, binHeight: stock.width, items },
      { kerfSize: input.settings.kerf, allowRotation: rotate },
    );
  const times: number[] = [];
  let result = run();
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    result = run();
    times.push(performance.now() - t0);
  }
  const bins = result ?? [];
  const area = bins.flat().reduce((a, p) => a + p.width * p.height, 0);
  const sheetArea = bins.length * stock.length * stock.width;
  // Kerf gaps and bounds of their layout.
  const k = input.settings.kerf;
  let valid = result !== null;
  for (const bin of bins) {
    for (const p of bin) {
      if (p.x < -1e-6 || p.y < -1e-6) valid = false;
      if (p.x + p.width > stock.length + 1e-6 || p.y + p.height > stock.width + 1e-6) valid = false;
    }
    for (let i = 0; i < bin.length; i++) {
      for (let j = i + 1; j < bin.length; j++) {
        const a = bin[i]!;
        const b = bin[j]!;
        const apart =
          a.x + a.width + k <= b.x + 1e-6 ||
          b.x + b.width + k <= a.x + 1e-6 ||
          a.y + a.height + k <= b.y + 1e-6 ||
          b.y + b.height + k <= a.y + 1e-6;
        if (!apart) valid = false;
      }
    }
  }
  return {
    sheets: bins.length,
    waste: sheetArea > 0 ? 100 * (1 - area / sheetArea) : 0,
    ms: median(times),
    valid,
  };
}

function runOurs(input: SheetInput) {
  const times: number[] = [];
  let result = layoutSheets(input);
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    result = layoutSheets(input);
    times.push(performance.now() - t0);
  }
  expect(checkSheetLayout(input, result)).toEqual([]);
  expect(result.unplaced).toEqual([]);
  return {
    sheets: result.sheets.length,
    waste: 100 * (1 - result.totals.utilisation),
    ms: median(times),
  };
}

describe('benchmark against guillotine-packer 1.0.2', () => {
  it('reports sheets, waste and time on the fixture cut lists', () => {
    const cases: [string, SheetInput][] = [
      ['bookshelf A (locked)', bookshelfA()],
      ['four base cabinets (locked)', cabinets()],
      ['random 30 (free)', randomParts(30, 7)],
      ['random 100 (free)', randomParts(100, 11)],
      ['random 300 (free)', randomParts(300, 13)],
    ];
    const rows: Row[] = [];
    for (const [name, input] of cases) {
      // Unlimited stages for both: guillotine-packer has no stage limit.
      const unlimited = {
        ...input,
        settings: { ...input.settings, maxStages: 'unlimited' as const },
      };
      const parts = input.parts.reduce((a, p) => a + p.quantity, 0);
      const stock = input.stock[0]!;
      const area = input.parts.reduce((a, p) => a + p.length * p.width * p.quantity, 0);
      const bound = Math.ceil(area / (stock.length * stock.width));
      rows.push({ name, parts, bound, ours: runOurs(unlimited), theirs: runTheirs(unlimited) });
    }
    for (const r of rows) {
      console.log(
        `BENCH ${r.name} (${r.parts} parts, area bound ${r.bound} sheets): ours ${r.ours.sheets} sheets, ` +
          `${r.ours.waste.toFixed(1)}% waste, ${r.ours.ms.toFixed(1)} ms; ` +
          `guillotine-packer ${r.theirs.sheets} sheets, ${r.theirs.waste.toFixed(1)}% waste, ` +
          `${r.theirs.ms.toFixed(1)} ms${r.theirs.valid ? '' : ' (INVALID: kerf or bounds)'}`,
      );
    }
  }, 60_000);
});
