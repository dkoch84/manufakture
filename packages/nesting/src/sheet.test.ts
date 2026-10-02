import { describe, expect, it } from 'vitest';
import {
  BOOKSHELF_A_PARTS_AREA,
  BOOKSHELF_B_PARTS_AREA,
  KERF_1_8,
  MDF_4X8,
  PLYWOOD_4X8,
  bookshelfA,
  bookshelfB,
  fourPanels,
} from './fixtures';
import { cutSequence, layoutSheets, layoutSheetsAsync, layoutSheetsSteps } from './sheet';
import type { CutTree, SheetCut, SheetInput, SheetLayoutResult } from './sheet';
import { checkSheetLayout } from './sheet-check';

function layout(input: SheetInput): SheetLayoutResult {
  const result = layoutSheets(input);
  expect(checkSheetLayout(input, result)).toEqual([]);
  return result;
}

function placedCount(result: SheetLayoutResult): number {
  return result.sheets.reduce((a, s) => a + s.placements.length, 0);
}

describe('hand-computed fixtures', () => {
  it('four 24" x 48" parts fill one 48" x 96" sheet exactly with no kerf', () => {
    const r = layout(fourPanels(0));
    expect(r.sheets).toHaveLength(1);
    expect(r.unplaced).toEqual([]);
    expect(r.totals.utilisation).toBeCloseTo(1, 12);
    expect(r.totals.wastePercent).toBeCloseTo(0, 12);
    expect(r.sheets[0]!.offcuts).toEqual([]);
  });

  it('with a 1/8" kerf only three fit a sheet, so four need two sheets', () => {
    const r = layout(fourPanels(KERF_1_8));
    expect(r.sheets).toHaveLength(2);
    expect(r.sheets.map((s) => s.placements.length)).toEqual([3, 1]);
    // 4608 / 9216, see fourPanels.
    expect(r.totals.utilisation).toBeCloseTo(0.5, 12);
  });

  it('bookshelf A: seven grain-locked parts on one sheet in two stages, as hand-computed', () => {
    const input = bookshelfA();
    const r = layout(input);
    expect(r.sheets).toHaveLength(1);
    expect(r.unplaced).toEqual([]);
    const sheet = r.sheets[0]!;
    expect(sheet.placements).toHaveLength(7);
    expect(sheet.placements.every((p) => !p.rotated)).toBe(true);
    expect(sheet.stages).toBeLessThanOrEqual(2);
    expect(sheet.partsArea).toBeCloseTo(BOOKSHELF_A_PARTS_AREA, 9);
    expect(sheet.utilisation).toBeCloseTo(3251.25 / 4608, 12);
    // Four 11 1/4" strips: every part's y is one of 0, 11.375, 22.75, 34.125.
    const strips = [...new Set(sheet.placements.map((p) => p.y))].sort((a, b) => a - b);
    expect(strips).toEqual([0, 11.375, 22.75, 34.125]);
  });

  it('bookshelf B: one sheet with no kerf, two with a 1/8" kerf', () => {
    const noKerf = layout(bookshelfB(0));
    expect(noKerf.sheets).toHaveLength(1);
    expect(noKerf.totals.utilisation).toBeCloseTo(BOOKSHELF_B_PARTS_AREA / 4608, 12);
    const kerf = layout(bookshelfB(KERF_1_8));
    expect(kerf.sheets).toHaveLength(2);
    expect(kerf.unplaced).toEqual([]);
    expect(kerf.totals.utilisation).toBeCloseTo(BOOKSHELF_B_PARTS_AREA / 9216, 12);
    // No sheet holds four strips: at most three distinct strip positions per sheet.
    for (const s of kerf.sheets) {
      expect(new Set(s.placements.map((p) => p.y)).size).toBeLessThanOrEqual(3);
    }
  });
});

describe('kerf, trims and offcuts', () => {
  it('places parts kerf apart and reports the leftover as an offcut', () => {
    // Two 40" x 20" parts on a 96" x 48" MDF sheet, kerf 1/4: side by side along the length
    // (40 + 1/4 + 40 = 80.25) or stacked across the width (20 + 1/4 + 20 = 40.25).
    const input: SheetInput = {
      parts: [{ id: 'p', length: 40, width: 20, quantity: 2, grainLocked: false }],
      stock: [MDF_4X8],
      settings: { kerf: 0.25, randomAttempts: 0 },
    };
    const r = layout(input);
    const sheet = r.sheets[0]!;
    expect(sheet.placements).toHaveLength(2);
    // Area check: 4608 = parts 1600 + offcuts + kerf.
    const kerfArea = sheet.sheetArea - sheet.partsArea - sheet.offcutArea;
    expect(kerfArea).toBeGreaterThan(0);
    expect(sheet.wastePercent).toBeCloseTo((100 * kerfArea) / 4608, 9);
  });

  it('keeps parts inside the trimmed area', () => {
    // 1/2" trims on every edge leave 95" x 47"; a 95" x 47" part fits exactly with no cuts.
    const input: SheetInput = {
      parts: [{ id: 'big', length: 95, width: 47, quantity: 1, grainLocked: true }],
      stock: [PLYWOOD_4X8],
      settings: { kerf: KERF_1_8, trims: 0.5 },
    };
    const r = layout(input);
    expect(r.sheets[0]!.placements[0]).toMatchObject({ x: 0.5, y: 0.5, sizeX: 95, sizeY: 47 });
    expect(r.sheets[0]!.cutTree.kind).toBe('part');
    // A part 1/16" larger than the trimmed area does not fit.
    const tooBig = layout({ ...input, parts: [{ ...input.parts[0]!, length: 95.0625 }] });
    expect(tooBig.sheets).toEqual([]);
    expect(tooBig.unplaced).toEqual([{ partId: 'big', quantity: 1, reason: 'does-not-fit' }]);
  });

  it('classifies leftovers by the minimum offcut size', () => {
    // One 90" x 40" part on 96" x 48": leftovers about 6" x 48" and 90" x 8" (less kerf).
    const base: SheetInput = {
      parts: [{ id: 'p', length: 90, width: 40, quantity: 1, grainLocked: true }],
      stock: [PLYWOOD_4X8],
      settings: { kerf: 0, randomAttempts: 0 },
    };
    const all = layout(base).sheets[0]!;
    expect(all.offcuts).toHaveLength(2);
    const big = layout({
      ...base,
      settings: { ...base.settings, minOffcut: { length: 50, width: 7 } },
    }).sheets[0]!;
    expect(big.offcuts).toHaveLength(1);
    expect(Math.max(big.offcuts[0]!.sizeX, big.offcuts[0]!.sizeY)).toBeGreaterThanOrEqual(50);
    expect(big.wastePercent).toBeGreaterThan(0);
  });
});

describe('grain', () => {
  it('never rotates a grain-locked part on a grained sheet', () => {
    // 40" x 30" grain-locked on a 48" x 96" sheet with grain along the length: the 40" must run
    // along x. Two fit side by side across x (40 + 40 + kerf <= 96), and only one 30" across y.
    const input: SheetInput = {
      parts: [{ id: 'door', length: 40, width: 30, quantity: 2, grainLocked: true }],
      stock: [PLYWOOD_4X8],
      settings: { kerf: KERF_1_8 },
    };
    const r = layout(input);
    for (const s of r.sheets) for (const p of s.placements) expect(p.rotated).toBe(false);
  });

  it('turns a grain-locked part on a sheet whose grain runs along its width', () => {
    const input: SheetInput = {
      parts: [{ id: 'p', length: 40, width: 30, quantity: 1, grainLocked: true }],
      stock: [{ ...PLYWOOD_4X8, grain: 'width' }],
      settings: { kerf: 0 },
    };
    const p = layout(input).sheets[0]!.placements[0]!;
    expect(p).toMatchObject({ rotated: true, sizeX: 30, sizeY: 40 });
  });

  it('a grain-locked part that only fits turned is not placed', () => {
    // 30" along the grain, 60" across it: on a 96" x 48" sheet with grain along the length the
    // 60" would have to run across the 48" width. Turned (60" along the length) it would fit,
    // but the grain lock forbids that. Unlocked, it fits turned.
    const part = { id: 'wide', length: 30, width: 60, quantity: 1, grainLocked: true };
    const locked = layout({ parts: [part], stock: [PLYWOOD_4X8], settings: { kerf: 0 } });
    expect(locked.unplaced).toEqual([{ partId: 'wide', quantity: 1, reason: 'does-not-fit' }]);
    const free = layout({
      parts: [{ ...part, grainLocked: false }],
      stock: [PLYWOOD_4X8],
      settings: { kerf: 0 },
    });
    expect(free.sheets[0]!.placements[0]).toMatchObject({ rotated: true, sizeX: 60, sizeY: 30 });
  });

  it('rotates unlocked parts when that saves a sheet', () => {
    // Three 46" x 30" parts on 96" x 48", kerf 0. Locked (46" along the 96" length): two fit
    // along (92), one across (30; 60 > 48), so 2 per sheet and 2 sheets. Unlocked, turned
    // (30" along, 46" across): three fit along (90) and one across (46 <= 48), so 1 sheet.
    const part = { id: 'p', length: 46, width: 30, quantity: 3, grainLocked: false };
    const free = layout({ parts: [part], stock: [PLYWOOD_4X8], settings: { kerf: 0 } });
    expect(free.sheets).toHaveLength(1);
    expect(free.sheets[0]!.placements.every((p) => p.rotated)).toBe(true);
    const locked = layout({
      parts: [{ ...part, grainLocked: true }],
      stock: [PLYWOOD_4X8],
      settings: { kerf: 0 },
    });
    expect(locked.sheets).toHaveLength(2);
  });
});

describe('stages', () => {
  function maxStage(tree: CutTree): number {
    if (tree.kind !== 'cut') return 0;
    return Math.max(tree.stage, maxStage(tree.first), tree.second ? maxStage(tree.second) : 0);
  }

  it('a two-stage limit keeps strips uniform; unlimited may use more stages', () => {
    // Parts of mixed widths: a two-stage layout cannot trim a narrow part out of a wide strip.
    const parts = [
      { id: 'a', length: 30, width: 20, quantity: 3, grainLocked: true },
      { id: 'b', length: 25, width: 14, quantity: 4, grainLocked: true },
      { id: 'c', length: 18, width: 9, quantity: 5, grainLocked: true },
    ];
    for (const maxStages of [1, 2, 3] as const) {
      const input: SheetInput = {
        parts,
        stock: [PLYWOOD_4X8],
        settings: { kerf: KERF_1_8, maxStages },
      };
      const r = layout(input);
      for (const s of r.sheets) expect(maxStage(s.cutTree)).toBeLessThanOrEqual(maxStages);
    }
  });

  it('a one-stage limit only takes parts that need a single set of parallel cuts', () => {
    // 48" wide parts span the whole width, so crosscuts alone free them: one stage.
    const input: SheetInput = {
      parts: [
        { id: 'full', length: 20, width: 48, quantity: 2, grainLocked: true },
        { id: 'half', length: 20, width: 24, quantity: 1, grainLocked: true },
      ],
      stock: [PLYWOOD_4X8],
      settings: { kerf: KERF_1_8, maxStages: 1 },
    };
    const r = layout(input);
    expect(placedCount(r)).toBe(2);
    expect(r.unplaced).toEqual([{ partId: 'half', quantity: 1, reason: 'does-not-fit' }]);
  });
});

describe('stock', () => {
  it('reports parts left over when limited stock runs out', () => {
    const input = fourPanels(KERF_1_8);
    const r = layout({ ...input, stock: [{ ...MDF_4X8, quantity: 1 }] });
    expect(r.sheets).toHaveLength(1);
    expect(r.unplaced).toEqual([{ partId: 'panel', quantity: 1, reason: 'out-of-stock' }]);
  });

  it('ranks by cost when every stock is priced', () => {
    // A 48" x 48" half sheet at 30 holds the single 40" x 40" part; a full sheet costs 50.
    const input: SheetInput = {
      parts: [{ id: 'p', length: 40, width: 40, quantity: 1, grainLocked: false }],
      stock: [
        { ...MDF_4X8, cost: 50 },
        { id: 'half', length: 48, width: 48, grain: 'none', cost: 30 },
      ],
      settings: { kerf: 0 },
    };
    const r = layout(input);
    expect(r.sheets.map((s) => s.stockId)).toEqual(['half']);
    expect(r.totals.cost).toBe(30);
    expect(r.stock).toEqual([{ stockId: 'half', count: 1, cost: 30 }]);
  });

  it('reports invalid parts and skips zero quantities', () => {
    const r = layout({
      parts: [
        { id: 'bad', length: -1, width: 10, quantity: 2, grainLocked: false },
        { id: 'none', length: 10, width: 10, quantity: 0, grainLocked: false },
      ],
      stock: [MDF_4X8],
      settings: { kerf: 0 },
    });
    expect(r.sheets).toEqual([]);
    expect(r.unplaced).toEqual([{ partId: 'bad', quantity: 2, reason: 'invalid' }]);
  });

  it('rejects invalid settings and stock', () => {
    const base = fourPanels(0);
    expect(() => layoutSheets({ ...base, settings: { kerf: -1 } })).toThrow(RangeError);
    expect(() => layoutSheets({ ...base, settings: { kerf: 0, trims: 50 } })).toThrow(RangeError);
    expect(() => layoutSheets({ ...base, settings: { kerf: 0, maxStages: 0 } })).toThrow(
      RangeError,
    );
    expect(() => layoutSheets({ ...base, stock: [{ ...MDF_4X8, width: 0 }] })).toThrow(RangeError);
    expect(() => layoutSheets({ ...base, parts: [...base.parts, ...base.parts] })).toThrow(
      RangeError,
    );
  });
});

describe('determinism and cancelling', () => {
  it('returns the same layout every time for the same input and seed', () => {
    const input = bookshelfB(KERF_1_8);
    expect(JSON.stringify(layoutSheets(input))).toBe(JSON.stringify(layoutSheets(input)));
  });

  it('reports progress per attempt and stops when the caller stops', () => {
    const steps = layoutSheetsSteps(bookshelfA());
    const first = steps.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.attempt).toBe(1);
      expect(first.value.total).toBeGreaterThan(1);
    }
    expect(steps.return(undefined as never).done).toBe(true);
  });

  it('the async form rejects when aborted and resolves like the sync form otherwise', async () => {
    const input = bookshelfA();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(layoutSheetsAsync(input, { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    const r = await layoutSheetsAsync({
      ...input,
      settings: { ...input.settings, randomAttempts: 2 },
    });
    expect(JSON.stringify(r)).toBe(
      JSON.stringify(
        layoutSheets({ ...input, settings: { ...input.settings, randomAttempts: 2 } }),
      ),
    );
  });
});

describe('cut sequence', () => {
  it('lists trims, then cuts by stage, a piece before the pieces it makes', () => {
    const input = { ...bookshelfA(), settings: { kerf: KERF_1_8, maxStages: 2, trims: 0.25 } };
    const r = layout(input);
    const seq = cutSequence(r.sheets[0]!);
    expect(seq.slice(0, 4).map((c) => c.kind)).toEqual(['trim', 'trim', 'trim', 'trim']);
    expect(seq.slice(0, 4).map((c) => c.axis)).toEqual(['y', 'y', 'x', 'x']);
    const rest = seq.slice(4);
    for (let i = 1; i < rest.length; i++) {
      expect(rest[i]!.stage).toBeGreaterThanOrEqual(rest[i - 1]!.stage);
    }
    expect(seq.map((c) => c.step)).toEqual(seq.map((_, i) => i + 1));
    // The first cut works on the whole usable area; every later cut works on a piece inside
    // the piece of some earlier cut, so no cut is listed before the cut that made its piece.
    expect(rest[0]!.piece).toEqual(r.sheets[0]!.usable);
    const inside = (a: SheetCut['piece'], b: SheetCut['piece']) =>
      a.x >= b.x && a.y >= b.y && a.x + a.sizeX <= b.x + b.sizeX && a.y + a.sizeY <= b.y + b.sizeY;
    for (let i = 1; i < rest.length; i++) {
      const piece = rest[i]!.piece;
      expect(rest.slice(0, i).some((c) => inside(piece, c.piece))).toBe(true);
    }
    // Two stages: rips (stage 1), then crosscuts (stage 2).
    expect(new Set(rest.filter((c) => c.stage === 1).map((c) => c.kind))).toEqual(new Set(['rip']));
    expect(new Set(rest.filter((c) => c.stage === 2).map((c) => c.kind))).toEqual(
      new Set(['crosscut']),
    );
  });
});

describe('the checker', () => {
  const input = bookshelfA();
  const good = layoutSheets(input);
  const clone = () => structuredClone(good);

  it('accepts the packer output', () => {
    expect(checkSheetLayout(input, good)).toEqual([]);
  });

  it('catches parts closer than the kerf', () => {
    const bad = clone();
    const sheet = bad.sheets[0]!;
    const p = sheet.placements[1]!;
    const q = sheet.placements[0]!;
    p.x = q.x;
    p.y = q.y + q.sizeY + 0.0625;
    expect(checkSheetLayout(input, bad).join('\n')).toMatch(/closer than the kerf/);
  });

  it('catches a rotated grain-locked part', () => {
    const bad = clone();
    const p = bad.sheets[0]!.placements[0]!;
    [p.sizeX, p.sizeY] = [p.sizeY, p.sizeX];
    p.rotated = true;
    expect(checkSheetLayout(input, bad).join('\n')).toMatch(/not an allowed orientation/);
  });

  it('catches a tree that does not replay and a missing part', () => {
    const bad = clone();
    const tree = bad.sheets[0]!.cutTree;
    if (tree.kind === 'cut') tree.at += 1;
    expect(checkSheetLayout(input, bad).length).toBeGreaterThan(0);
    const lost = clone();
    lost.sheets[0]!.placements.pop();
    expect(checkSheetLayout(input, lost).join('\n')).toMatch(/quantity/);
  });

  it('catches a stage over the limit', () => {
    const r = layoutSheets({ ...input, settings: { ...input.settings, maxStages: 'unlimited' } });
    const strict = { ...input, settings: { ...input.settings, maxStages: 1 } };
    const problems = checkSheetLayout(strict, r);
    expect(problems.some((p) => /stage 2 of 1/.test(p))).toBe(true);
  });
});
