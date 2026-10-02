# @manufakture/takeoff

The generic quantity takeoff ([ADR 0013](../../docs/adr/0013-domain-packages.md), decision 8;
created by M4 plan T4.3a): rows of `{ item, stock, size, quantity, unit, extended, sources }` that
domain packages produce, with the merging, totals and display formatting they share. The
woodworking cut list (`@manufakture/domain-wood`) is the first producer; M6 adds framing and
sheathing producers to the same model without depending on `domain-wood`.

Plain TypeScript under GPL-3.0-or-later. Its only dependency is `@manufakture/units` (for display
formatting). A shared domain package: it imports no domain package (ADR 0013 decision 1).

## The model

```ts
import { buildTakeoff, formatRow, type TakeoffRow } from '@manufakture/takeoff';

const rows: TakeoffRow[] = [
  {
    key: 'board|us-1x12|pine|...', // equal keys merge
    item: 'Shelf',
    category: 'lumber', // the producer's section
    stock: 'us-1x12',
    material: 'pine',
    size: { length: 876.3, width: 285.75, thickness: 19.05 }, // one piece, mm
    quantity: 1,
    unit: 'board-foot',
    extended: 2.875, // the row's total in `unit`
    measures: [{ unit: 'length', value: 876.3 }], // totals in other units
    sources: [{ id: 'extension#3', part: 'part#1', quantity: 1 }],
    flags: [],
  },
];
const { rows: merged, totals } = buildTakeoff(rows);
formatRow(merged[0], { unit: 'in-fraction', denominator: 32 });
// { item: 'Shelf', size: '34-1/2" x 11-1/4" x 3/4"', quantity: '1', extended: '2.88 bd ft', ... }
```

| Field              | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `key`              | Rows with one key are the same thing; `mergeRows` adds them up. Rows of one key must share `unit`.     |
| `item`             | For people. Merging joins different items without repeats (`Shelf, Top`).                              |
| `category`         | The producer's section (`sheet`, `lumber`, `part`, `hardware` for wood); totals are per category.      |
| `size`             | One piece, mm: `length`, `width`, `thickness`, `diameter`, each optional.                              |
| `quantity`         | Pieces: the sum of the sources' quantities.                                                            |
| `unit`, `extended` | What the row adds up to, all pieces together.                                                          |
| `measures`         | The row's totals in other units (lumber's length next to its board feet).                              |
| `sources`          | What was counted: an id (a body, a joint, a wall), its part and instance, and how many pieces it gave. |
| `flags`            | Short notes the producer defines (`estimated`).                                                        |

**Units** (`TakeoffUnit`), all in internal units: `length` mm, `area` mm², `volume` mm³;
`board-foot`, `sheet` and `each` are counts.

## Functions

| Function                       | Does                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `mergeRows(rows)`              | Merge rows by key, in first-seen order; sources merged and sorted by part, instance and id. |
| `totals(rows, groupOf?)`       | Totals per group and unit, `extended` and `measures` both.                                  |
| `buildTakeoff(rows)`           | `mergeRows`, then `totals` per category.                                                    |
| `scaleRow(row, n)`             | Every quantity, value and source times `n`.                                                 |
| `boardFeet(t, w, l)`           | Board feet of a piece in mm: inches multiplied, over 144.                                   |
| `sizeKey(size)`, `lengthKey`   | Keys to the nanometre, so floating point noise groups and real differences do not.          |
| `compareIds(a, b)`             | Natural order (`extension#2` before `extension#10`).                                        |
| `formatSize(size, format)`     | `72" x 11-1/4" x 23/32"`, `Ø8 mm x 32 mm`, in the document's length format.                 |
| `formatMeasure(m, format)`     | `5.33 bd ft`; areas in sq ft or m², volumes in in³ or cm³ (by the format being imperial).   |
| `formatRow(row, format, name)` | A row's cells as text, for a table or CSV.                                                  |

## Tests

`src/takeoff.test.ts`: board feet (a 2x4x8 is 5.33), keys, merging and its refusal of mixed
units, totals, and formatting in fractions and millimetres.

```sh
./node_modules/.bin/vitest run --project packages packages/takeoff
```
