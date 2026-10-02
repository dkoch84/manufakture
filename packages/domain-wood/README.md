# @manufakture/domain-wood

The woodworking domain ([ADR 0013](../../docs/adr/0013-domain-packages.md), M4 plan T4.1c): the
**stock catalog** (lumber and sheet goods with nominal and actual sizes), the **board** feature
(`wood.board`, a body cut from real stock with a grain) and its translator to kernel inputs, and
the document data the domain owns (`domains.wood` settings, `domains.stock` overrides). Plain
TypeScript under GPL-3.0-or-later.

**Dependencies.** At run time only `@manufakture/core` and `@manufakture/units`, so everything
here runs in Node with no `.wasm`. `@manufakture/regen` (the translator contract) and
`@manufakture/kernel` (the `FeatureInput` types) are type-only imports, and devDependencies, as
`packages/print` does with kernel types; `@manufakture/sketch` is a devDependency for the solver of
the real-kernel tests. Regen imports no domain package.

## Registering the domain

```ts
import { defaultExtensions } from '@manufakture/regen';
import { registerWood } from '@manufakture/domain-wood';

const unregister = registerWood(defaultExtensions); // the app's regen worker entry, at start-up
```

`woodDomain` is the definition it registers: namespace `wood`, implementation version
`WOOD_IMPLEMENTATION` (bump it with any change that can alter a translator's output, so regen's
cache never serves results of older domain code), `reads: ['stock']`, the readers of the two
namespaces it owns (`wood`, `stock`) and the type `wood.board`.

## The stock catalog

`STOCK` lists every entry; `findStock(id)` looks one up; `stockByRegion(region)` gives a region's
lumber and sheets in picker order; `defaultRegion(lengthFormat)` picks the region a picker opens
on from the document's display units (`us` for `in`, `ft`, `ft-in` and `in-fraction`, `metric`
otherwise).

| Field                        | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | Permanent, stored in boards and overrides (`us-2x4`, `us-ply-23-32`, `mm-ply-18`). Never removed or reused.                |
| `name`, `actualLabel`        | As sold (`3/4" plywood`) and the real size in the entry's own units (`23/32"`).                                            |
| `region`, `kind`, `category` | `us` or `metric`; `lumber` or `sheet`; `softwood`, `hardwood`, `plywood`, `osb`, `mdf`.                                    |
| `nominal`, `actual`          | `{ thickness, width? }` in mm. Lumber without a `width` is sold in random widths (hardwood).                               |
| `lengths`, `sheet`           | Lengths sold (lumber) and the sheet size, length by width (sheets), mm.                                                    |
| `boardFeetBasis`             | `nominal` (surfaced softwood), `rough` (hardwood quarters), `none` (sheets). Read by the cut list.                         |
| `material`, `grain`          | The core `MaterialId` a board of it gets, and whether it has a grain (plywood and solid wood yes; MDF and OSB no).         |
| `source`, `verified`         | Where the actual size and the sold sizes come from, and whether each was checked against that source. Unverified is shown. |

Sizes are exact: computed from the source's inch fraction (`23/32"` is `(23 / 32) x 25.4` mm) or
millimetre figure, never a rounded decimal.

| Group                         | Entries                                                                          | Source                                                               | Verified |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| US softwood boards, dimension | Every Table 3 board (3/4 to 1-1/2 thick) and dimension size (2 to 4-1/2 thick)   | PS 20-25 Table 3, minimum dressed dry sizes (`PS20_*` rows exported) | yes      |
| US hardwood                   | 4/4, 5/4, 6/4, 8/4: rough thickness and the usual S2S thickness                  | NHLA quarters; S2S from a rules card and a retailer summary          | no       |
| US plywood, OSB, MDF          | Plywood 1/4 to 3/4 by Performance Category (3/4" is 23/32"), OSB, MDF; 4 x 8 ft  | Secondary summaries of PS 1 and PS 2; maker data                     | no       |
| Metric                        | 38 x 63, 38 x 89, 38 x 140 mm lumber; 12, 15, 18 mm plywood and MDF, 2440 x 1220 | CLS and UK regularised sizes; maker data                             | no       |

Retail lengths are common practice, not from a standard (`verified.sold` false). Not in the
catalog yet: timbers (5" nominal and up, partly unverified in the plan), green sizes, hardwood
plywood (HP-1). Core has no OSB material, so OSB boards get `plywood` (the nearest density).

## Document data

Both namespaces are settings, not model (ADR 0013 decision 3): lengths are `StoredExpression`s that
must be constants (`18.2mm`, `23/32"`), and one that names a variable is refused. Each has a reader
(`readStockData`, `readWoodData`: migrate in memory to the current version, then validate) and a
writer for the app (`writeStockData`, `writeWoodData`: the entry to pass to core's `setDomainData`
at the current version, or `undefined` to remove the namespace). Keys are looked up with
`Object.hasOwn`, so stored keys like `__proto__` are only ever data.

**`domains.stock`** (version 1), the document's stock overrides by catalog id:

```json
{
  "overrides": {
    "us-ply-23-32": {
      "thickness": { "source": "18.2mm", "lengthUnit": "mm", "angleUnit": "deg" },
      "sheet": {
        "length": { "source": "97", "lengthUnit": "in", "angleUnit": "deg" },
        "width": { "source": "49", "lengthUnit": "in", "angleUnit": "deg" }
      },
      "price": { "amount": 62.5, "per": "sheet", "currency": "USD" }
    },
    "us-2x4": { "width": { "source": "3-9/16", "lengthUnit": "in", "angleUnit": "deg" } }
  }
}
```

`thickness` and `width` are the measured actual sizes, `sheet` the sheet size in stock, `price` an
amount `per` `piece`, `sheet`, `board-foot`, `metre` or `foot`. `resolveStock(id, data)` gives the
catalog entry with the override applied (`thickness`, `width`, `sheet`, `price`, and which of them
were `overridden`). An override for an id this build does not know is kept and ignored.

**`domains.wood`** (version 1), the cut list and layout settings, named after
`@manufakture/nesting`'s settings: `kerf`, `sheetTrims` (`lengthStart`, `lengthEnd`, `widthStart`,
`widthEnd`), `lumberTrims` (`start`, `end`), `maxStages` (an integer from 1, or `'unlimited'`),
`grain` (`'respect'` or `'ignore'`). `woodSettings(entry)` fills in `DEFAULT_WOOD_SETTINGS`: a
1/8" kerf (a common full-kerf blade, a typical value), no trims, no stage limit, grain respected.
No board reads them, so changing them rebuilds no body.

## The board feature

A board is an extension feature with `operation: 'new'` (anything else is refused on `operation`)
and the sketch it uses in `dependsOn`:

```ts
{
  kind: 'extension', extension: 'wood.board', schemaVersion: 1, operation: 'new',
  dependsOn: ['sketch#1'], references: [],
  params: { form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1',
            justify: { thickness: 'centre', width: 'positive' } },
  expressions: { rotation: <angle>, length: <length> },  // both optional
}
```

| Form    | Params                                                                                                                             | Expressions                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `panel` | `stock`, `sketch`, `entities?` (the region's bounding entities; absent: the sketch's region), `grain?`, `flip?`                    | `grainAngle` (angle) with `grain: { type: 'angle' }`                         |
| `stick` | `stock`, `sketch`, `line` (a sketch line), `justify?` (`thickness`, `width`: `centre`, `negative` or `positive`; default `centre`) | `rotation` (angle), `length` (default the line's), `width` (default stock's) |

- **Panel**: the one region extruded by the stock's actual thickness along the sketch normal
  (against it with `flip`). The grain runs along the region's longest straight side by default
  (`{ type: 'longest' }`, pointing along +x, or +y when vertical; ties go to the first side), along
  a sketch line (`{ type: 'line', entity }`), or at `grainAngle` from the sketch x axis
  (`{ type: 'angle' }`). A selection with several regions is refused.
- **Stick**: the stock's section, thickness by width, extruded from the line's start along it. At no
  `rotation` the thickness lies in the sketch plane to the left of the line and the width along the
  sketch normal; `rotation` turns the section right-handed about the line. `justify` puts the line
  at the section's centre or on its `negative` or `positive` side per axis (`positive`: the board
  lies on the positive side of the line). Each axis is the section's own: `justify.thickness` is
  measured along the thickness axis (in the sketch plane, to the left of the line, before rotation),
  which is also `frame.axes.thickness`; `justify.width` is measured along the section's width axis
  (the sketch normal before rotation), which points opposite to `frame.axes.width`. So
  `width: 'positive'` puts the board on the sketch normal's side of the line; in the board frame the
  board then runs from the line toward lower width, so the line lies along its `w1` face (the high
  end of `frame.axes.width`). Stock sold in random widths needs `width`. A stick is cut from
  lumber: sheet stock is refused (draw a panel instead). A panel may use either kind; from lumber it
  takes the stock's thickness and the region sets the width (a glue-up), unchecked against the
  board's.

`readBoardParams(params, schemaVersion)` migrates and validates params (regen's params check);
unknown fields, an unknown stock id and expressions the form does not read are refused with the
field at fault. Migrations are per type (`BOARD_PARAMS`) and per namespace (`STOCK_DATA`,
`WOOD_DATA`): `migrations[i]` takes version `i + 1` to `i + 2` (`migrate`, `currentVersion`), and
every migration shipped is kept.

**What it builds.** One kernel `extrude` making a `new` body under the feature's id. The stock's
sizes (catalog plus override) are numbers in that input, so regen's cache key covers them: a
thickness override rebuilds exactly the boards of that stock, and a price rebuilds nothing. Face
names follow the extrude rules, and one rule places them in the board frame: `x0` is the face at
the low end of a frame axis, `x1` the face at the high end. A stick's sides are
`extension#n:side:t0` and `t1` (along `frame.axes.thickness`) and `w0`, `w1` (along
`frame.axes.width`); its caps `extension#n:cap:start` and `cap:end` are the low and high ends of
`frame.axes.length`. A panel's caps follow the same rule along `frame.axes.thickness` (`cap:start`
on the sketch plane, `cap:end` a thickness along the extrusion, with or without `flip`). A panel's
sides are `extension#n:side:<sketch edge id>`: named by the sketch, not by the frame, so no
low/high rule applies to them.

**The board frame** is the translator's metadata (`FeatureResult.metadata`, recomputed on every
regen, never stored), read back with `readBoardMetadata`:

```ts
{
  form, stock, material, grain,   // grain: whether the stock has one
  frame: {
    origin: [x, y, z],            // the blank's corner
    axes: { length, width, thickness }, // unit vectors, length along the grain, right-handed
    size: { length, width, thickness }, // mm: the blank before joinery
  },
  overridden: { thickness, width }, // sizes from domains.stock (or a stick's width expression)
}
```

The blank is `origin + [0, length] * axes.length + [0, width] * axes.width + [0, thickness] *
axes.thickness`. Panel extents are exact for lines and arcs and sampled for Bezier curves.

## Tests

`catalog.test.ts` (every Table 3 size against an independently typed copy, exact millimetres,
unique ids, flags), `data.test.ts` (migrations, both namespaces' validation, overrides, round
trips), `board.test.ts` (params, and the translator in Node with no kernel: a 2x4 stick 8 ft long
is a 38.1 x 88.9 mm section extruded 2438.4 mm; a 3/4" plywood panel from a 600 x 300 mm region is
extruded 18.25625 mm; an override wins) and `regen.test.ts` (panel and stick through regen with the
real kernel and solver: exact volumes, frames, face names, a thickness override rebuilding only its
board, a price rebuilding nothing, a refused override failing every board).

```sh
./node_modules/.bin/vitest run --project packages packages/domain-wood
```
