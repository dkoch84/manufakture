# @manufakture/stock

The shared **stock catalog** and the **`stock` namespace** of document data ([ADR
0013](../../docs/adr/0013-domain-packages.md) decisions 1 and 3, [ADR
0015](../../docs/adr/0015-construction-domain.md) decision 1): lumber and sheet goods with nominal
and actual sizes, the document's stock overrides (`domains.stock`: schema, migrations, reader,
writer, `resolveStock`), the data-only regen registration that owns `stock`, and the small readers
every domain uses for its versioned JSON (`migrate`, `Read`, `readConstantLength`, ...). Plain
TypeScript under GPL-3.0-or-later.

T6.1a moved all of this here from `packages/domain-wood`, which re-exports it unchanged so no
caller broke, and added the construction entries (precut studs, gypsum board). The namespace
name stays `stock`, so no document changed.

**Dependencies.** At run time only `@manufakture/core` and `@manufakture/units`; it imports no
domain package (ADR 0013 decision 1). `@manufakture/regen` is a type-only devDependency for the
registration's types (the tests load its registry).

## Registering

```ts
import { defaultExtensions } from '@manufakture/regen/extensions';
import { registerStock } from '@manufakture/stock';

registerStock(defaultExtensions); // the app's regen worker entry, next to the domains
```

`stockDomain` is a data-only domain: namespace `stock`, the reader of `domains.stock`, no extension
types. Domains that read stock (`wood`, `construction`) declare `reads: ['stock']`.
`registerStock` does nothing when some domain already owns `stock`, and `registerWood` and
`registerConstruction` call it, so any registry with a domain reading stock has its reader.

## The catalog

`STOCK` lists every entry; `findStock(id)` looks one up; `stockByRegion(region)` gives a region's
lumber and sheets in picker order; `defaultRegion(lengthFormat)` picks the region a picker opens
on from the document's display units (`us` for `in`, `ft`, `ft-in` and `in-fraction`, `metric`
otherwise).

| Field                        | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | Permanent, stored in boards and overrides (`us-2x4`, `us-ply-23-32`, `mm-ply-18`). Never removed or reused.                |
| `name`, `actualLabel`        | As sold (`3/4" plywood`) and the real size in the entry's own units (`23/32"`).                                            |
| `region`, `kind`, `category` | `us` or `metric`; `lumber` or `sheet`; `softwood`, `hardwood`, `plywood`, `osb`, `mdf`, `stud` (precut), `gypsum`.         |
| `nominal`, `actual`          | `{ thickness, width? }` in mm. Lumber without a `width` is sold in random widths (hardwood).                               |
| `lengths`, `sheet`           | Lengths sold (lumber) and the sheet size, length by width (sheets), mm.                                                    |
| `boardFeetBasis`             | `nominal` (surfaced softwood), `rough` (hardwood quarters), `none` (sheets). Read by the cut list.                         |
| `material`, `grain`          | The core `MaterialId` a board of it gets, and whether it has a grain (plywood and solid wood yes; MDF and OSB no).         |
| `source`, `verified`         | Where the actual size and the sold sizes come from, and whether each was checked against that source. Unverified is shown. |

Sizes are exact: computed from the source's inch fraction (`23/32"` is `(23 / 32) x 25.4` mm) or
millimetre figure, never a rounded decimal.

| Group                         | Entries                                                                          | Source                                                               | Verified            |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| US softwood boards, dimension | Every Table 3 board (3/4 to 1-1/2 thick) and dimension size (2 to 4-1/2 thick)   | PS 20-25 Table 3, minimum dressed dry sizes (`PS20_*` rows exported) | yes                 |
| US hardwood                   | 4/4, 5/4, 6/4, 8/4: rough thickness and the usual S2S thickness                  | NHLA quarters; S2S from a rules card and a retailer summary          | no                  |
| US plywood, OSB, MDF          | Plywood 1/4 to 3/4 by Performance Category (3/4" is 23/32"), OSB, MDF; 4 x 8 ft  | Secondary summaries of PS 1 and PS 2; maker data                     | no                  |
| US precut studs (T6.1a)       | 2x4 and 2x6 at 92-5/8" and 104-5/8" (`us-2x4-precut-92-5-8`), category `stud`    | PS 20-25 for the section; lengths from M6 plan Part 1 summaries      | size yes; length no |
| US gypsum board (T6.1a)       | 1/2" and 5/8", 4 x 8 ft and 4 x 12 ft (`us-gyp-1-2-8ft`), category `gypsum`      | Maker data; ASTM C1396 not read                                      | no                  |
| Metric                        | 38 x 63, 38 x 89, 38 x 140 mm lumber; 12, 15, 18 mm plywood and MDF, 2440 x 1220 | CLS and UK regularised sizes; maker data                             | no                  |

Retail lengths are common practice, not from a standard (`verified.sold` false). Not in the
catalog yet: timbers (5" nominal and up, partly unverified in the plan), green sizes, hardwood
plywood (HP-1). Core has no OSB or gypsum material, so OSB gets `plywood` and gypsum board `mdf`
(the nearest densities). 7/16" OSB wall sheathing (`us-osb-7-16`) was already in the M4 catalog.

## `domains.stock`

Settings, not model (ADR 0013 decision 3): lengths are `StoredExpression`s that must be constants
(`18.2mm`, `23/32"`), and one that names a variable is refused. `readStockData` migrates in memory
to the current version, then validates; `writeStockData` gives the entry to pass to core's
`setDomainData` at the current version, or `undefined` to remove the namespace. Keys are looked
up with `Object.hasOwn`, so stored keys like `__proto__` are only ever data.

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

## Readers and migrations

`migrations.ts`: `Versioned` (`what`, `migrations`, where `migrations[i]` takes version `i + 1` to
`i + 2`), `currentVersion`, `migrate`. `read.ts`: `Read<T>`, `ok`, `fail`, `isObject`, `own`,
`onlyKeys`, `readEnum`, `readId`, `readStoredExpression`, `constantLength` and
`readConstantLength` (with `positive`, or `signed` for an elevation below the datum). Every
reader returns a `Read` with the path of the field at fault instead of throwing.

## Tests

`catalog.test.ts` covers the entries T6.1a added and pins ids (extend the list, never shorten
it); `domain.test.ts` the registration. The full catalog and `domains.stock` tests are
`domain-wood`'s `catalog.test.ts` and `data.test.ts`, which run against this package through the
re-exports and stay unchanged.
