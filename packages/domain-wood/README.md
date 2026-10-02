# @manufakture/domain-wood

The woodworking domain ([ADR 0013](../../docs/adr/0013-domain-packages.md), M4 plan T4.1c): the
**stock catalog** (lumber and sheet goods with nominal and actual sizes), the **board** feature
(`wood.board`, a body cut from real stock with a grain) and its translator to kernel inputs, and
the document data the domain owns (`domains.wood` settings, `domains.stock` overrides), and the
**joint** feature (`wood.joint`, T4.2b: six kinds of joint cut between two boards), and the **cut
list** (T4.3a: the woodworking producer of `@manufakture/takeoff`). Plain TypeScript under
GPL-3.0-or-later.

**Dependencies.** At run time only `@manufakture/core`, `@manufakture/units` and the shared
`@manufakture/takeoff` (ADR 0013 decision 8), so everything
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
namespaces it owns (`wood`, `stock`) and the types `wood.board` and `wood.joint`.

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

## The joint feature

A joint cuts two boards against each other. It makes no body, so it has no `operation`
(anything else is refused); it names the boards in `params.a` and `params.b`, depends on both
(`dependsOn`, so regen hands it their frames) and, when it has a `scope`, lists both there:

```ts
{
  kind: 'extension', extension: 'wood.joint', schemaVersion: 1,
  dependsOn: ['extension#1', 'extension#2'], scope: ['extension#1', 'extension#2'],
  references: [],
  params: { kind: 'dado', a: 'extension#1', b: 'extension#2', stopped: 'low' },
  expressions: { clearance: <length>, stop: <length> },  // all optional unless noted
}
```

`a` is the board that receives (the dado's, the mortise's, the one a screw goes into), `b` the
board that enters it. Both must be `wood.board` bodies, and B must be square to A: each of B's
frame axes parallel to one of A's. Boards at an odd angle (a splayed leg) are refused on
`params.b` with a message naming the angle ("extension#2 is not square to extension#1 (about 30°
off)"). Every joint is found from the two frames, not from faces, so it follows its boards when
their own params or sketches move or resize them. It sees only the frames the board features
report: a later feature that changes a board's body (a mirror, a pattern, a boolean) is not seen,
and the joint keeps cutting where the board was before it.

**Clearance** is the total play between the parts, the same for every kind that takes it: a
dado's groove, a mortise's section and depth, and a box joint's slot are each wider than what
they take by `clearance` (split evenly on both sides; for a rabbet all of it on the inner side,
since the other side is open).

**A board's blank includes its joinery.** For a dado, rabbet, tenon or box joint, draw B into A
by the joint's depth: the boards' blanks overlap, and the joint cuts that overlap. The depth of
a dado or a rabbet and the length of a tenon are how far B reaches into A, so the cut list,
which reads the blanks, gets the right lengths with no help from the joint. Dowels and pocket
screws join boards that touch without overlapping (an overlap is refused, and vice versa).

| `kind`          | Params                                   | Expressions (lengths unless noted; defaults)                                                                                                                                                                                                                            | What it cuts                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dado`          | `stopped`: `none`, `low`, `high`, `both` | `clearance` (0, split on both sides; refused when it leaves no lip at A's edge), `stop` (required when stopped; refused when not)                                                                                                                                       | `groove` in A: B's thickness plus the clearance, as deep as B enters, through A or stopped short of the low or high end of the A axis it runs along. Where B runs past a stop, `notch-low` / `notch-high` in B.                                                                                                                             |
| `rabbet`        | none                                     | `clearance` (0, on the inner side; refused when it reaches A's other edge)                                                                                                                                                                                              | `groove` in A along the edge B sits at, through. B at an edge is a rabbet, B inside a face a dado: the wrong kind is refused on `params.kind`.                                                                                                                                                                                              |
| `mortise-tenon` | `ends`: `square`, `rounded`              | `thickness` (a third of B's), `width` (B's width less two thirds of its thickness), `offset` (0, along B's thickness axis, positive toward its high face; none across B's width), `clearance` (0, added to the mortise's section and depth)                             | B's end must enter A. The tenon is centred across B's width; its shoulders are where B meets A's face (no shoulder depth of its own). In B: `cheek-0`, `cheek-1`, `shoulder-0`, `shoulder-1` (empty ones left out). In A: `mortise`, through A when the tenon is. Rounded: `mortise-end-0`, `-1` cylinders, and `round-0`, `-1` added to B. |
| `dowel`         | none                                     | `diameter` (8 mm), `depthA` (1.5 diameters, at most 2/3 of A there), `depthB` (2.5 diameters, at most 2/3 of B), `count` (number) or `spacing`, `edge` (2 diameters), `offset` (0, along the A axis across the row, positive toward A's high end; `details.offsetAxis`) | `a-hole-n` in A and `b-hole-n` in B: a row along the contact's longer side, on its centre line; by default spread evenly from end to end at most 12 diameters apart, at least two.                                                                                                                                                          |
| `pocket-screw`  | `face`: `low`, `high` (of B's thickness) | `count` (number) or `spacing`, `edge` (3/4"), `angle` (angle, 15°), `screw` (the jig chart's length for B's thickness)                                                                                                                                                  | `pocket-n` in B: an angled stepped cylinder (3/8" pocket, 11/64" pilot) coming out at the middle of B's thickness where B meets A. B's end or edge must touch A. Nothing is cut from A; the screw is not modelled, but a tip coming out of A is warned about.                                                                               |
| `box-joint`     | `start`: `a`, `b`                        | `finger` (the thinner board's thickness, rounded to fit) or `count` (number, 2 to 200), `clearance` (0, a slot wider than its finger by it)                                                                                                                             | `a-slot-n` in A and `b-slot-n` in B, `n` the finger the slot receives. B stands on A's end: A's end flush with B's outside face, B's end flush with A's outside face. One boolean per board however many fingers.                                                                                                                           |

**Names.** Every tool is placed in A's frame, so its face names are `extension#n:<tool>:<role>`
with the kernel's roles (`xmin` .. `zmax` for boxes at the low and high ends of A's length, width
and thickness axes; `start`, `wall`, `end`, `step`, `shoulder` for cylinders). They do not depend
on where the boards are: a dado's names stay the same when either board grows, and when the shelf
moves the dado moves with it under the same names.

**Pocket-hole jig.** The defaults follow the standard jig: a 3/8" stepped bit with an 11/64" pilot
at 15° ([McFeely's](https://www.mcfeelys.com/pocket_hole_joinery-1)), the screw coming out at the
middle of the board's thickness, and the screw length chart of the Kreg Jig R3 owner's manual (1/2"
stock: 1", 3/4": 1-1/4", 1-1/2": 2-1/2", and the rows between; `pocketScrew(thickness)`). Stock
off the chart needs `screw`; stock under 1/2" (less a sixteenth) is refused. The pocket's floor
is placed half a screw length back from where the screw comes out, an approximation of the jig's
depth setting.

**Metadata** (`readJointMetadata`): `{ kind, a, b, hardware, warnings, details }`. `hardware`
lists dowels (`{ item: 'dowel', diameter, length, quantity }`, `length` the two holes' depths
together) and pocket screws (`{ item: 'pocket-screw', length, quantity }`) for the bill of
materials. `warnings` are `{ code, message }`. Code `rule-of-thumb`, marked as such and not
engineering: a dado or rabbet deeper than half of A, a dowel more than half as thick as what it is
set in. Code `breaks-out`: a pocket screw's tip (half its length past where it leaves B) coming
out of A's far face or side; the joint still builds, since the screw is not modelled. Regen's
extension contract has no warnings of its own, so they ride in the metadata for the app to show.
`details` holds the joint's sizes as built (`depth`, `fingers`, `finger`, `count`, ...).

Joints that cannot be built are refused on the feature with the field at fault: a board that is
not a body or not a board the joint depends on, a value the kind does not read, a tenon that does
not fit B or a mortise breaking out of A, holes coming out through a board, a clearance that
takes a dado through A's edge or a rabbet across A, and boards that do
not meet the way the kind needs (with a message saying how they should).

## The cut list

`cutList(input)` (`src/cutlist/`) is pure: from the parts regen built, it gives the cut list,
the hardware (bill of materials) lines, totals and the inputs of sheet and stick layouts. Rows are
`@manufakture/takeoff` rows (`TakeoffRow`), so M6's producers add to the same model.

```ts
import { cutList, cutListPart, stockName } from '@manufakture/domain-wood';
import { formatRow } from '@manufakture/takeoff';

const list = cutList({
  parts: [cutListPart(doc.parts[0], result.parts[0], { orientedSizes })],
  stock, // readStockData(...).value: the document's overrides (domains.stock)
  settings, // woodSettings(...).value: the grain rule for layouts (domains.wood)
  // assembly: { instances }, configuration: { id, name }
});
list.rows; // boards and wood shapes; list.hardware: dowels and pocket screws
list.rows.map((r) => formatRow(r, { unit: 'in-fraction', denominator: 32 }, stockName));
list.sheets; // per sheet stock: sheet size (with overrides), grain, parts for layoutSheets
list.lumber; // per lumber stock: lengths sold, parts for layoutSticks
```

**Input.** `CutListPart` per part build: its bodies (`bodyId`, `creator`, optional name, material
and volume), its features' results (`featureId`, name, `metadata`), and the oriented sizes
(`{ bodyId, sizes }`, T4.3b's op called by the app in T4.3d) of bodies that are not boards.
`cutListPart(part, partResult, options)` builds it from a document part and regen's `PartResult`
(typed structurally; no regen import). A part built in a configuration row is its own
`CutListPart` with its own id (`part#1@cfg#2`), which instances name. `assembly.instances`
(`{ id, part, bodies?, suppressed? }`) counts through an assembly; without it, every body of every
part counts once.

**Rows.**

| Body                              | Category   | Size                                    | Unit, extended          | Flags           |
| --------------------------------- | ---------- | --------------------------------------- | ----------------------- | --------------- |
| Board of sheet stock              | `sheet`    | Blank: length (grain), width, thickness | `area`, mm²             |                 |
| Board of lumber                   | `lumber`   | Blank                                   | `board-foot`; `length`  | `actual-width`  |
| Board of a stock this build lacks | `part`     | Blank                                   | `each`                  | `stock-unknown` |
| Other body of a wood material     | `part`     | Oriented box, longest first             | `each`; `volume` if any | `estimated`     |
| Same, no oriented size given      | `part`     | None                                    | `each`; `volume` if any | `size-unknown`  |
| Joint hardware                    | `hardware` | Dowel: diameter, length; screw: length  | `each`                  |                 |

A board's size is its **blank**: the frame's sizes, the stock size before joinery. A tenon is cut
from its board, so the board's drawn length (into the mortise) is the blank's length. Rows group
pieces of one stock, material and blank size (to the nanometre, so floating point noise groups);
`item` joins the pieces' names (the body's own, else the creating feature's). A body's own
material (`Part.bodies`) wins over the board's stock material; a body that is not a board takes
its part's material, and is left out (`excluded`) unless that is a wood (`not-wood`,
`no-material`).

**Board feet** (`blankBoardFeet`) follow the stock's basis: `nominal` (softwood) counts nominal
thickness by nominal width by length, so a 2x4 8 ft long is 5.33; the nominal width applies only
to a blank as wide as the stock (with its override), and a ripped stick or a glued-up panel is
counted on its own width (flag `actual-width`). `rough` (hardwood) counts the rough thickness in
quarters by the actual width and length. Sheets count area instead.

**Counting.** Without an assembly, every body once and every joint once. Through an assembly,
each instance that is not suppressed counts the bodies it shows (`bodies`, or all), with the
instance in the row's sources; a joint's hardware counts as often as **both** its boards are
shown (the smaller count), so an assembly of per-board instances gives exactly the part studio's
list, and an instance showing only one board adds no dowels. Instances of parts or bodies the
input lacks are reported in `missing`.

**Order and totals.** Sheets, then lumber, then shapes; within them by catalog order of the stock,
then material, then thickest, longest, widest. `totals` are per category and unit, `stockTotals`
per stock. `configuration` echoes the row given.

## Tests

`catalog.test.ts` (every Table 3 size against an independently typed copy, exact millimetres,
unique ids, flags), `data.test.ts` (migrations, both namespaces' validation, overrides, round
trips), `board.test.ts` (params, and the translator in Node with no kernel: a 2x4 stick 8 ft long
is a 38.1 x 88.9 mm section extruded 2438.4 mm; a 3/4" plywood panel from a 600 x 300 mm region is
extruded 18.25625 mm; an override wins) and `regen.test.ts` (panel and stick through regen with the
real kernel and solver: exact volumes, frames, face names, a thickness override rebuilding only its
board, a price rebuilding nothing, a refused override failing every board). Joints:
`joints/joints.test.ts` (params, and every kind's tool primitives against hand-computed boxes and
cylinders, refusals with their fields) and `joints/regen.test.ts` (every kind through regen with
the real kernel: exact volumes, the kernel's interference check between the boards non-empty
before a dado, tenon or box joint and empty after, face names unchanged when a board grows, a dado
following its shelf, an odd angle refused on the joint while the boards still build). Cut list:
`cutlist/cutlist.test.ts` (a bookshelf by hand: two 3/4" plywood sides, four 1x12 shelves and a
1/4" back give 18 and 11.25 sq ft of plywood, 11.5 board feet and 138" of 1x12, 32 dowels and 6
pocket screws; grouping; a part inserted twice; per-board instances equal to the part studio;
configurations; shapes that are not boards; board feet by basis; layout inputs) and
`cutlist/regen.test.ts` (with the real kernel: blanks and dowels of a shelf on a side, a
configuration row deepening the shelf and nothing else, a tenon's length kept in its blank).

```sh
./node_modules/.bin/vitest run --project packages packages/domain-wood
```
