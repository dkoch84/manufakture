# @manufakture/nesting

Cut plans for woodworking: **sheet layouts** (rectangular parts on plywood, MDF or other sheet
goods, cut with a saw) and **stick layouts** (lengths cut from lumber). Plain TypeScript, no
runtime dependencies, unit-agnostic (pass millimetres or inches, but the same unit everywhere).

**The results are good, not optimal.** Both packers are fast heuristics that try many rules and
keep the best result. They do not prove that fewer sheets are impossible, and a commercial
optimiser or an exact solver can beat them on some inputs. The benchmark below shows how close
they get to the area bound on a few cut lists.

## Sheet layouts

```ts
import { checkSheetLayout, cutSequence, layoutSheets } from '@manufakture/nesting';

const result = layoutSheets({
  parts: [{ id: 'side', length: 72, width: 11.25, quantity: 2, grainLocked: true }],
  stock: [{ id: 'ply', length: 96, width: 48, grain: 'length' }],
  settings: { kerf: 0.125, trims: 0.25, maxStages: 2, minOffcut: { length: 12, width: 4 } },
});
result.sheets; // placements, cut tree, offcuts, utilisation and waste per sheet
result.unplaced; // parts that could not be placed, and why
cutSequence(result.sheets[0]!); // the cuts in order: trims, rips, crosscuts
checkSheetLayout(input, result); // [] when the layout is valid
```

**Coordinates.** A sheet's x axis runs along its length, its y axis along its width. A part's
`length` is along its grain. A placement's `rotated` is false when the part's length runs along
the sheet's length.

**Inputs.**

| Input                    | Meaning                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| part `grainLocked`       | The part's length must run along the sheet's grain. On a sheet with `grain: 'none'` every part may turn.                                          |
| stock `quantity`         | Sheets available; absent means unlimited.                                                                                                         |
| stock `cost`             | Price per sheet; ranks results only when every stock has one.                                                                                     |
| `kerf`                   | Material a cut removes. Parts that touch a sheet edge need no cut there.                                                                          |
| `trims`                  | Per edge (`lengthStart`, `lengthEnd`, `widthStart`, `widthEnd`) or one number; measured to the usable area, so a trim cut's kerf falls inside it. |
| `maxStages`              | 1, 2, 3 or more, or `'unlimited'` (the default). See stages below.                                                                                |
| `minOffcut`              | A leftover whose longer side is at least `length` and shorter side at least `width` is an offcut; the rest is waste. Default 0 x 0.               |
| `seed`, `randomAttempts` | The random attempts (below). Defaults 1 and 30.                                                                                                   |

**Method.** A guillotine packer after Jylänki ("A Thousand Ways to Pack the Bin", 2010). Every
sheet keeps a tree of pieces whose leaves are free rectangles. A part goes into a free rectangle
at its corner; two cuts free it (one when it fills the rectangle's width or length), each cut
running edge to edge across its piece, with the kerf taken from the far side. So every layout is
a guillotine layout by construction. One attempt runs one combination of rules:

- **sort** (largest first): area, long side, short side, perimeter, length, width;
- **choice** of free rectangle over all open sheets: best area fit, best short side fit, best
  long side fit;
- **split**, which cut comes first: shorter leftover axis, longer leftover axis, larger
  leftover, crosscuts first, rips first;
- **stock order** for opening a new sheet (with more than one stock): input order, smallest
  first, largest first. A new sheet opens only when a part fits no open sheet.

All 90 combinations (270 with several stocks) run, then `randomAttempts` more that swap nearby
parts in the best attempt's order (seeded, so reproducible). The best result is the one with,
in order: fewest unplaced parts, lowest cost (when every stock is priced), fewest sheets, least
sheet area, then the best offcuts (the sum of squared offcut areas, which prefers one big
leftover to several small ones). Ties keep the earlier attempt. The same input always gives the
same output.

**Stages.** A stage is a set of parallel cuts: in a two-stage layout the sheet is cut into
strips and the strips into parts, and nothing else. A cut's stage is its parent cut's stage when
the two are parallel and one more when they cross; the first cut is stage 1. Every cut counts,
including one that only trims a part to size (so a two-stage strip holds parts of the strip's
own width). Trims of the factory edges are not counted. The limit is applied while splitting, so
a placement that would need a deeper cut is not made.

**Cut tree.** `sheet.cutTree` starts at the usable area. A cut node has an `axis` (`'x'`: a
crosscut at x = `at`; `'y'`: a rip at y = `at`), its `stage`, a `first` child below `at` and a
`second` child from `at + kerf` to the far edge (null when the kerf reaches the edge). Leaves are
parts (an index into `placements`), offcuts and waste. `cutSequence(sheet)` lists the cuts in an
order a saw can follow: trims (rips, then crosscuts), then stage 1, stage 2 and so on, each piece
cut before the pieces it makes.

**Results.** Per sheet: `placements`, `cutTree`, `offcuts`, `stages` (the highest used),
`sheetArea`, `partsArea`, `offcutArea`, `utilisation` (parts over sheet) and `wastePercent`
(area that is neither part nor offcut: trims, kerf and small leftovers). `totals` sums them over
the result; `stock` counts the sheets of each stock. `unplaced` lists parts by reason:
`invalid` (a size that is not a positive number), `does-not-fit` (no stock holds the part, after
trims, grain and the stage limit) or `out-of-stock` (it fits, but the limited stock ran out).
Invalid stock or settings, or duplicate ids, throw a `RangeError`.

**Checking.** `checkSheetLayout(input, result)` re-derives everything from the input and returns
a list of problems: sizes and orientations (grain locks), every part inside the usable area, no
two parts closer than the kerf, the cut tree replayed cut by cut (each cut across its whole
piece, children exactly either side of the kerf, stages consistent and within the limit, every
placement exactly one leaf), stock quantities and part counts.

## Stick layouts

```ts
import { layoutSticks } from '@manufakture/nesting';

layoutSticks({
  parts: [{ id: 'rail', length: 27, quantity: 3 }],
  stock: [
    { id: '1x2x8', length: 96 },
    { id: '1x2x10', length: 120 },
  ],
  settings: { kerf: 0.125, trims: { start: 0.5, end: 0.5 }, minOffcut: 12 },
});
```

Pieces are laid end to end from the start trim, a kerf apart; the leftover after the last piece
and its kerf is an offcut when at least `minOffcut` long. **Method**: first fit, best fit and
worst fit, each with pieces longest first and in input order, and each with stock opened longest
first, shortest that fits, or in input order; then the seeded perturbations of the best. After
each attempt every stick moves to the shortest available stock that still holds its pieces. The
best result has the fewest unplaced pieces, then the lowest cost (when every stock is priced),
then the least total stock length, then the fewest sticks, then the best offcuts.
`checkStickLayout` checks a result the same way as the sheet checker.

## Running in a worker

Both packers come in three forms: `layoutSheets` (synchronous), `layoutSheetsSteps` (a generator
that yields `{ attempt, total }` after each attempt and returns the result; stop iterating to
cancel) and `layoutSheetsAsync(input, { signal })`, which yields to the event loop between
attempts and rejects with `signal.reason` when aborted. The same for sticks. The progress
`total` counts the random attempts only when they run (more than one part copy to reorder), so
the last step always reports `attempt === total`. `checkStickLayout` checks each cut's `copy`
against its part's quantity, as the sheet checker does.

## Fixtures

`@manufakture/nesting/fixtures` exports hand-computed inputs, each with its calculation in a
comment, for this package's tests and for the cut list and bookshelf acceptance tests: four 24"
x 48" panels (one sheet without kerf, two with a 1/8" kerf), two bookshelves (one sheet in two
stages; one sheet without kerf and two with), a face frame of 1x2s, and three 32" pieces from a
96" stick.

## Benchmark

`benchmark.test.ts` compares the sheet packer with
[guillotine-packer](https://github.com/tyschroed/guillotine-packer) 1.0.2 (MIT, read from the
installed package's `LICENSE`; a development dependency only) on cases both can express: no
trims, all parts locked or all free, unlimited stages, 1/8" kerf on 48" x 96" sheets. Both
layouts are checked for kerf gaps. Run it with `pnpm --filter @manufakture/nesting bench`.

Measured on 2026-10-02 on an AMD Ryzen 5 7600X, Linux, Node 26.10.0 (median of 5 runs). Times
are estimates and vary by machine; waste here is 1 minus utilisation, offcuts included. The
area bound is the sheets the parts' area alone needs.

| Case                        | Parts | Area bound | Ours: sheets, waste, time | guillotine-packer: sheets, waste, time |
| --------------------------- | ----- | ---------- | ------------------------- | -------------------------------------- |
| bookshelf A (locked)        | 7     | 1          | 1, 29.4%, 0.6 ms          | 1, 29.4%, 2.0 ms                       |
| four base cabinets (locked) | 28    | 3          | 4, 28.4%, 2.7 ms          | 4, 28.4%, 6.4 ms                       |
| random 30 (free)            | 30    | 2          | 2, 14.5%, 4.4 ms          | 2, 14.5%, 11.7 ms                      |
| random 100 (free)           | 100   | 7          | 7, 8.7%, 22.5 ms          | 8, 20.1%, 37.6 ms                      |
| random 300 (free)           | 300   | 19         | 21, 9.5%, 142.5 ms        | 21, 9.5%, 143.1 ms                     |

Ours is never worse here and saves a sheet on the 100-part case, while also handling trims,
grain per part, stage limits and a cut tree, so guillotine-packer is not adopted.
