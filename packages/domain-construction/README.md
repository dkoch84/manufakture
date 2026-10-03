# @manufakture/domain-construction

The construction domain (M6 plan, [`docs/plans/m6.md`](../../docs/plans/m6.md);
[ADR 0015](../../docs/adr/0015-construction-domain.md)): framing
generators that turn a wall (and, with T6.2b and T6.2c, a floor and a roof) into **member data**,
the member data shape and its ids, and the short "not an engineering tool" text. Plain TypeScript
under GPL-3.0-or-later.

**Not an engineering tool.** The generator lays framing out by geometric rules the user chooses
(spacing, plate counts, header sizes, corner style). It computes no loads, checks no spans, sizes
no members and checks nothing against a building code. Its warnings are layout warnings, and the
ones that come from framing practice are labelled as rules of thumb. See [Disclaimer](#disclaimer).

**Dependencies.** At run time `@manufakture/units` (for `MM_PER_INCH` in the defaults) and the
shared `@manufakture/stock` (the catalog, the `stock` namespace and the JSON readers), with
`@manufakture/core` for types, so everything runs in Node with no `.wasm`. ADR 0015 decision 1
also allows `takeoff` and `nesting` at run time, and `regen` and `kernel` as types only (both are
devDependencies, for the registration's and the translators' types); never the kernel, regen,
Manifold, the app or another domain. Tests may also load regen and the kernel, as `domain-wood`'s
do, to run the features through regen with the real kernel. `src/boundary.test.ts` enforces that
allowlist. The generators' input is this
package's own type: the feature layer (T6.1b) evaluates the wall feature's expressions, resolves
the wall graph and the construction domain data (below), and passes plain numbers in. Stock is
passed to the generators as a `StockRef` (catalog id, nominal name, dressed sizes); `stockRef(id,
stockData)` makes one from the catalog with the document's overrides applied.

**Units.** Millimetres everywhere inside (ADR 0005). The tests write their fixtures in inches
and convert.

## Disclaimer

`DISCLAIMER_SHORT` (`src/disclaimer.ts`, exported from the package root) is the short "not an
engineering tool" text, one string for the construction tools in the app (T6.1d), every drawing
title block (T6.4a), every takeoff export (T6.3b) and the IFC header (T6.6a); each of those tasks
tests that it is shown (ADR 0015 decision 8). The long form opens
[`docs/user/construction.md`](../../docs/user/construction.md); change the two together. Neither,
nor any warning message, may call anything "safe", "compliant" or "OK"; `wall.test.ts` checks the
constant and the warnings for those words.

## Domain data: `domains.construction`

The document-level construction settings (ADR 0015 decision 2, T6.1a), version 1, read by
`readConstructionData(data, schemaVersion)` (migrate in memory, validate, evaluate lengths; gives
`{ stored, settings }`: as typed for editors, and in mm) and written by
`writeConstructionData(stored)` (validated first; `undefined` when there is nothing to store, so
the app removes the namespace). Settings, not model (ADR 0013 decision 3): every length is a
`StoredExpression` that must be a constant (`8'`, `2.4m`), and one naming a variable is refused
with the same message as a stock override's ("domain settings hold constants only: #h is a
variable; type the measured value instead"). Stock is named by catalog id. Every field is
optional; absent lists are empty.

```ts
{
  levels: [{ id, name, elevation, height }],    // elevation may be negative; height is the default wall height
  wallTypes: [{ id, name, layers: [              // exterior to interior
    { id, kind: 'siding' | 'sheathing', stock?, thickness? },
    { id, kind: 'framing', stock, spacing?, bottomPlates?, topPlates?,
      header: { stock, plies, jacks, spacer? } }, // the wall type's default header
    { id, kind: 'drywall', stock?, thickness? },
  ] }],
  floorTypes: [{ id, name, joistStock, rimStock?, spacing?, subfloor? }],
  roofTypes: [{ id, name, rafterStock, ridgeStock, hipStock?, spacing?, overhang?, rakeOverhang?,
                tail?, subFascia?, fascia?, sheathing? }],
  framing: { spacing?, layoutOrigin?, layoutFrom?, bottomPlates?, topPlates?, kings?,
             cornerStyle?, blocking?, spliceOffset?, plateStockLengths?, precutLengths?,
             ladderSpacing? },              // blocking: { kind: 'none' | 'mid-height' } or
                                            //   { kind: 'heights', heights: [...] }
  headerRules: [{ maxWidth, header: { stock, plies, jacks, spacer? } }],
}
```

- **Levels** (`levels.ts`) are constants in M6 (ADR 0015 decision 2): a variable in an elevation
  is refused. Variables reach construction geometry through the features' own expressions.
- **Wall types** are layer stacks: siding, sheathing, exactly one framing layer, drywall, in that
  order (several of a sheet kind are allowed, in order). A sheet layer needs a sheet `stock` or a
  `thickness` (which wins). `wallTypeThickness(type, stockData)` sums the layers: a framing layer
  is as thick as its stud is wide, a sheet layer as its sheet is thick, both with the document's
  stock overrides; 2x4 plus 7/16" OSB plus 1/2" drywall is 4-7/16".
- **Framing settings** are document defaults (T6.2a's `WallSettings`) that a wall type's framing
  layer and a wall may override; absent ones use `DEFAULT_WALL_SETTINGS`. Every `WallSettings`
  field is here except `studStock` and `defaultHeader` (the wall type's framing layer holds them)
  and `headerRules` (the document's own table, below). `layoutOrigin` may be negative (the
  generator keeps only its remainder by the spacing). `blocking` is `{ kind: 'none' }`,
  `{ kind: 'mid-height' }` or `{ kind: 'heights', heights }`: one to 20 heights above the wall's
  base, each greater than zero.
- **Header rules** are the user's table, `opening width up to maxWidth: header, jack studs`. A new
  document has none, and nothing here offers template rows or code values (ADR 0015 decision 7,
  the project owner's decision). Two rules for the same width are refused. **A new wall type asks
  for its default header**: `newWallType({ id, name, studStock, header, sheathing?, drywall? })`
  takes it as a required argument.
- **Defaults.** `defaultConstructionSettings(region)` is what a new document starts with: one
  level, `Level 1` at `0`, 97-1/8" high (92-5/8" precut studs on one bottom and two top plates, a
  layout default from common practice) in US documents and 2400 mm otherwise; no types, no framing
  overrides, no header rules.
- **Stock kinds.** A known stock must be of the right kind (studs, headers, joists, rafters from
  lumber; layers, subfloor and roof sheathing from sheets). An id this build's catalog lacks is
  kept (it may come from a newer build) and fails only where it is resolved (`layerThickness`).
- **Bounds.** At most 100 levels, 100 of each type, 100 header rules, 8 layers per wall type and
  20 lengths per list; ids are lower case, digits and hyphens, up to 64 characters, unique per list.
  So that a crafted document cannot make the generators lay out without end, every length is at
  most 100 m (`MAX_SETTING_LENGTH`; a level's elevation and height too), layout spacings
  (`spacing`, `ladderSpacing`) at least 50 mm (`MIN_SPACING`) and plate stock lengths at least
  300 mm (`MIN_PLATE_STOCK`). These are far outside framing practice, not sizings.

**Registration.** `constructionDomain`: namespace `construction`, `reads: ['stock']`, the reader
of `domains.construction`, the `construction.wall` and `construction.opening` types and the
member stage (see [Walls and openings](#walls-and-openings-constructionwall-constructionopening)). The
app's regen worker entry calls `registerConstruction(defaultExtensions)`, which also registers the
shared stock reader unless it is already there. Unknown versions are regen's: a newer
`schemaVersion` fails the readers of the namespace as `unsupported` while the document still loads.

**Construction stock** lives in the shared catalog (`@manufakture/stock`, ADR 0015 decision 1):
dimensional lumber 2x4 to 2x12 and 4x4, 4x6 (PS 20-25, verified), precut studs 2x4 and 2x6 at
92-5/8" and 104-5/8" (`us-2x4-precut-92-5-8`; lengths unverified), 7/16" OSB (`us-osb-7-16`),
plywood, and 1/2" and 5/8" gypsum board in 4 x 8 and 4 x 12 ft (`us-gyp-1-2-8ft`; unverified).
Prices come from the stock overrides (`domains.stock`).

## Walls and openings: `construction.wall`, `construction.opening`

Two extension types (T6.1b, ADR 0015 decisions 2, 3, 5 and 6) in `src/features/`, each with
`schemaVersion` 1 and an empty migrations list (`WALL_PARAMS`, `OPENING_PARAMS`), registered by
`constructionDomain` with regen's member stage.

**Wall** (`wall.ts`). Params: `level` and `wallType` (ids in `domains.construction`: data, not
model ids), `points` (2 to 64; the coordinates are the length expressions `x1`, `y1` .. `xn`,
`yn`, in plan), `closed`, `justification` (`left`, the default, puts the framing left of the path,
so the path is the framing's exterior face; the exterior is always right of the path), `joins`
(`start`, `end`: `auto` or `free`), `framing` (`layoutFrom`, `bottomPlates`, `topPlates`,
`kings`, `cornerStyle`, `blocking`: `none` or `mid-height`) and `overrides` (`{ id, delete?,
stock? }` keyed by local member id). Expressions: `height` (default the level's), `spacing`,
`layoutOrigin`, and `move_<n>`, the nudge of the n-th override. Settings resolve wall over wall
type over `domains.construction` framing over `DEFAULT_WALL_SETTINGS`; the header rules are the
document's. Operation `new` makes the layer bodies; a wall with no operation makes none (framing
only). Bounds: 64 points, segments up to 100 m, coordinates within 500 m (half of regen's 1 km
member bound, so a wall near the limit is refused with a clear message rather than as a malformed
member), height up to 30 m, stock sizes 1 mm to 2 m (with overrides), 500 overrides, and
`MEMBER_BUDGET` (50,000, regen's `MAX_GROUP_MEMBERS`) members per wall.

- **Layer bodies.** Each siding, sheathing and drywall layer is one body
  `<wall id>:layer/<layer id>`: its outline in plan (the band it occupies across the path, mitred
  at every corner of the path, a ring with a hole for a closed path) extruded from the level's
  elevation up the wall's height. Faces: `<id>:side:<layer>.ext<i>` and `.int<i>` along segment
  i, `.start` and `.end` at an open wall's ends, and `<id>:cap.<layer>:start` (bottom) and `:end`
  (top), through the kernel's `capRole`, so names stay unique across the wall's bodies. They keep
  their names when the wall lengthens. Separate walls that meet are neither mitred nor butted in
  their layers: each wall's layers stop square at its own path ends, so at an L they leave a
  notch on one face and overlap on the other, and at a tee the meeting wall's layers overlap the
  other wall's. Only the framing joins (below). Draw connected walls as one path to mitre them;
  joining the layers of separate walls is follow-up task #1172.
- **Metadata** (`WallMetadata`): level, base, height, path, justification, the framing
  thickness, each layer's extent across the path and body, the resolved settings and overrides.

**Opening** (`opening.ts`). Its host is the one `construction.wall` in its `dependsOn`. Params:
`kind` (`door`, `window`, `opening`), `segment` (default 1), `from` (`start` or `end` of the
segment), `sizing` (`rough`, or `unit` with the `allowance` expression added to width and
height), `header` (`auto`: the narrowest header rule covering the width, else the wall type's
default; `default`; `explicit` with `stock`, `plies`, `jacks`, `spacer?`), `kings`, `jacks`,
`swing` and `hand` (doors, for drawings) and `overrides`. Expressions: `position` (to the centre
line), `width`, `height` (the rough opening), `sill` (0 for a door, required for a window) and
`move_<n>`. It has no operation: one `tools` input cuts a box through the whole wall at the rough
opening from every layer body (faces `<opening id>:<layer>:<role>`); with a `scope`, every body it
cuts must be listed there. It is refused when it does not fit its segment or its wall's height.

**Member stage** (`stage.ts`, `graph.ts`). A group per wall: the wall, every built opening it
hosts, and the walls it meets or crosses (they decide its ends, so they are in its cache key;
moving an opening re-frames only its wall). `wallGraph` works out, per level, the joins:

- inside one wall, segment i runs through at its end and segment i + 1 butts (a closed path is a
  pinwheel);
- two open wall ends at one point (0.5 mm) make an L: the wall with the lower feature number runs
  through, the other butts (by number, so reordering features changes nothing);
- an open end on the inside of another wall's segment makes a tee in that segment;
- three or more ends at a point, or an end on another wall's corner, stay free with a
  `join-unresolved` layout warning; ends set `free` never join;
- walls crossing away from their ends are refused (an error on both);
- at most 5,000 wall segments per part (`MAX_GRAPH_SEGMENTS`).

Running through means the framing reaches the far side of the other wall's framing; butting
means it stops at the near side, both measured on the framing's centre line, at any angle.
`framedWall` turns that into `frameWall`'s segments (moved ends, `L` and `T` joins, tees), and
each opening's position is moved by its segment's shift. `frameWall`'s warnings go on the wall,
or on the opening they name, with their code; rule-of-thumb ones start with "Rule of thumb:".
The group's metadata lists each opening's header and where it came from (`rule`, `default`, or
`opening` when explicit) and each override as `applied` or `lost`.

## Members

A framing member is data, not a body (ADR 0015 decision 4, as the T6.5a spike measured it):

```ts
interface Member {
  id: string; // local to its owner, by role and layout: `s12`, `top1:2`, `king-l`
  owner: string; // the feature that owns it: a wall, an opening, a floor or a roof
  role: Role; // bottom-plate, top-plate, stud, king, jack, header, header-spacer, rough-sill,
  //             cripple, blocking, corner, backing (floors and roofs add theirs)
  stock: StockRef; // { id: 'us-2x4', name: '2x4', width: 38.1, depth: 88.9 }, mm
  length: number; // the blank along local x, mm: what is cut from stock
  placement: { origin: Vec3; x: Vec3; y: Vec3 }; // right-handed, z = x cross y; no mirroring
  cuts: Cut[]; // in the member's own frame; wall members have none
}
type Cut =
  | { kind: 'plane'; n: Vec3; k: number } // removes dot(n, p) >= k
  | { kind: 'notch'; a: Plane; b: Plane }; // removes the intersection of two half-spaces
```

The blank is `origin + a x + b y + c z` for `a` in `[0, length]`, `b` in `[0, stock.width]` and
`c` in `[0, stock.depth]`. `shapeKey(member)` is T6.5a's mesh sharing key (stock and its sizes,
length to 0.001 mm, sorted local cuts; never the placement), `memberCorners` the blank's eight
world corners, `placementMatrix` the column-major instance matrix, `countByRole` a summary.

Wall members are placed in the segment's frame: along the wall `s`, across it `t` (towards the
left of the reference line looking from start to end), up `z`. Studs, kings, jacks, cripples and
corner studs run up with their thin face along the wall; plates, rough sills, blocking and
backing run along the wall lying flat; header plies and the spacer run along the wall on edge.

## Member ids

A member's id is local to the feature that owns it; its **full id** is
`<owner feature id>:<local id>` (ADR 0015 decision 6), so every full id holds exactly one
feature id, at its front. Layout members belong to the wall (`extension#3:s12`); an opening's
members belong to the opening, not its host wall (`extension#7:king-l`). Local ids are stable by
role and layout, and fragile by design: lengthening a wall adds slots at the end and keeps the
others; an opening hides the layout members in its way, moving it brings them back under their
old ids, and its own members keep theirs; changing the spacing, layout origin or direction
renumbers the slots. Nothing in the document refers to a member except per-member overrides,
which report `lost` when their member is gone.

Wall members (owned by the wall):

| Form                          | Example                        | Meaning                                                                                                                                    |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `s<k>`                        | `s12`                          | Layout slot k: `s0` flush with the end layout starts from, `s<k>` centred on `layoutOrigin + k x spacing`, the last flush with the far end |
| `bottom<c>:<n>`, `top<c>:<n>` | `top1:2`                       | Plate course c (1 is nearest the studs), piece n along the wall                                                                            |
| `block<r>:<n>`                | `block1:4`                     | Blocking row r (from the bottom), block n along the wall                                                                                   |
| `start:<m>`, `end:<m>`        | `start:corner`, `end:backing2` | Corner framing where the wall runs through an L corner: `corner`, `corner-2`, `backing<r>`                                                 |
| `t<i>:<m>`                    | `t1:corner-l`                  | Framing where the i-th tee meets the wall: `corner-l`, `corner-r`, `corner-c`, `backing<r>`                                                |
| `seg<n>/<id>`                 | `seg2/s0`                      | Any wall form in the n-th segment (n >= 2) of a wall with several segments                                                                 |

Opening members (owned by the opening): `king-l`, `king-l2`, `king-r`, `jack-l`, `jack-r2`
(nearest the opening first), `header`, `header-2` (plies), `spacer`, `sill`, `cripple-a<n>`
(above the header) and `cripple-b<n>` (below the rough sill), numbered along the wall.

Every member has one spelling: the first king is `king-l`, never `king-l1`; the first ply is
`header`, never `header-1`; numbers have no leading zeros. `parseWallMemberId` and
`parseOpeningMemberId` refuse any other spelling and round-trip with `formatWallMemberId` and
`formatOpeningMemberId`; `memberIds` builds them; `memberFullId` and `splitMemberFullId` join and
split a full id (at the first colon only, since a local id may hold one: `top1:2`). An id remap
(M7) only rewrites the feature id in front, like any `<feature id>:<suffix>` name. Core's README
lists the forms with the other naming forms.

## Wall framing: `frameWall`

```ts
import { frameWall } from '@manufakture/domain-construction';

const { members, warnings, openings, overrides } = frameWall({
  wall: 'extension#3', // the owner of the wall's own members
  segments: [
    {
      start: [0, 0],
      end: [4876.8, 0], // 16 ft
      height: 2466.975, // 97-1/8": one bottom plate, 92-5/8" precut studs, two top plates
      thickness: 88.9,
      justification: 'left',
      joins: { start: { kind: 'L', through: true, otherThickness: 88.9 } },
      openings: [
        {
          id: 'extension#7', // the owner of the opening's members
          position: 1219.2,
          width: 914.4,
          height: 2032,
          sill: 0,
          overrides: [{ id: 'king-l', stock: s2x6 }],
        },
      ],
      tees: [{ at: 2540, otherThickness: 88.9 }],
    },
  ],
  settings: { studStock, defaultHeader: { stock: s2x8, plies: 2, spacer: ply12, jacks: 1 } },
  overrides: [{ id: 's5', move: 50.8 }], // the wall's own members
});
```

**Segments.** `start` and `end` are the framed ends of the reference line: at an L corner the
wall that runs through reaches the corner's outside and the butting wall stops at its face; at a
T the butting wall stops at the other wall's face. The feature layer works these out from the
wall graph. `height` runs from the bottom of the bottom plate to the top of the top plate, from
`base` (default 0). `thickness` must equal the stud stock's depth. `justification` puts the
framing left of, right of or centred on the reference line.

**Joins** at each end: `free`; `L` with `through: true` (this wall carries the corner framing and
its cap plate stops `otherThickness` short, so the other wall's cap laps over it); `L` with
`through: false` or `T` (this wall butts; its cap plate runs `otherThickness` past the end over
the other wall). **Tees** are other walls' ends meeting this wall's side, at `at` (the centre of
the meeting wall): the host gets the tee framing and its cap plate stops across the meeting
wall's thickness so that wall's cap laps in.

**Layout.** Slot 0 flush with the start (or the end, `layoutFrom: 'end'`), slot k centred on
`layoutOrigin + k x spacing`, the last stud flush with the far end. With the origin at 0, 4 ft
sheet edges land on stud centres (Part 1, Fine Homebuilding "Laying Out Stud Walls"). Only the
origin's remainder by the spacing matters: it is brought into `(-spacing, 0]`, so slot 1 is the
first centred stud after the start (an 8" origin puts s1 at 8", not 24") and one layout has one
set of slot ids. Centred
slots that would overlap an end stud are left out. A layout stud inside an opening's framing is
removed; a layout stud that a corner or tee stud would stand on keeps its slot and the corner
stud is left out; any other layout stud overlapping corner or tee framing is removed.

**Studs** are `height` less the plates. Within 0.5 mm of a precut length they are exactly that
length, so the takeoff (T6.3a) can match them to precut stock by length.

**Plates.** `bottomPlates` and `topPlates` courses of the stud stock, lying flat. A run longer than
the longest `plateStockLengths` is spliced; each splice keeps `spliceOffset` from every splice in
the courses below, prefers leaving pieces of at least `spliceOffset`, and is reported
(`splice-offset`, a rule of thumb) when it cannot. The bottom plate is cut out across a door's
rough opening; the cap course (the top course when there are two or more) laps at L corners and
tees as above.

**Corners** (`cornerStyle`), in the wall that runs through, measured from the corner's outside;
the butting wall ends in its own end stud:

| Style                | L corner                                                                                                      | Tee                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `two-stud` (default) | End stud (outside nailer) and `corner` just past the other wall's inside face (drywall nailer), Part 1        | A stud each side of the meeting wall (`corner-l`, `corner-r`) |
| `three-stud`         | As two-stud plus `corner-2` against the end stud                                                              | Plus `corner-c` centred on the meeting wall                   |
| `ladder`             | End stud, `corner` a stud width past the other wall's face, flat `backing` between them every `ladderSpacing` | The two flanking studs with `backing` between them            |

Corner or tee framing that runs into an opening's framing, or into another corner or tee, is left
out with a `framing-conflict` warning.

**Openings** by rough opening: `position` (centre along the segment), `width`, `height` and
`sill` above the wall's base; `sill: 0` is a door. Each side gets `jacks` jack studs (inside) and
`kings` king studs (outside). Jacks stand on the bottom plate up to the head (`sill + height`);
the header's plies sit on them across the wall (the first ply on the low face, the spacer next to
it, the rest against the far face), spanning the rough opening plus the jacks; kings run full
height. So `jack = king - header - cripples above`: the header depth shorter than the kings when
the header reaches the top plates. Cripples stand on layout (Part 1): above the header where a
layout stud would be within the header's span, and, for a window, below the flat rough sill
within the rough opening. An opening outside the wall, overlapping another, with its header above
the studs or its sill too low for a rough sill is not framed (`framed: false` and a warning); the
layout studs stay.

**Headers** (ADR 0015 decision 7): an opening's own `header`, else the narrowest of the user's
`headerRules` whose `maxWidth` covers it, else the wall type's `defaultHeader`. New documents have
no rules. Every opening reports which it used (`openings[i].header.source` is `opening`, `rule`
with its index, or `default`); an opening wider than every rule gets the default and a
`no-header-rule` layout warning, which reports which header it used. Plies wider than the wall warn; a spacer thicker than the room between the plies is
left out with a warning.

**Blocking** rows (`blocking`): `none`, `mid-height`, or centred at given `heights` above the
base, between consecutive full-height studs, kings and corner studs, outside openings, corners
and tees. A row outside the studs or overlapping another is left out with a warning.

**Overrides** (ADR 0015 decision 6) are params of the member's owner, keyed by local id: the
wall's `overrides` name its own members (`s12`, `top1:2`), an opening's `overrides` name the
opening's (`king-l`, `header`). They apply last, the wall's first and then each opening's:
`delete`, `stock` (a new stock, same placement origin), `move` (mm along the wall). Each reports
`{ owner, id, status }` with `applied` or `lost`; a lost one also warns `override-lost` with the
reason: the owner no longer has that member, the opening is not framed, or an earlier override
of the same member deleted it.

**Errors.** Input the generator cannot frame at all (no segments, a segment shorter than two
studs or too low for its plates, a thickness that is not the stud depth, spacing not wider than a
stud, an opening id that is not a feature id or appears twice, counts out of range) throws a
`FramingInputError`. Everything else is a warning and the rest of the wall is framed.

### Defaults and where they come from

`DEFAULT_WALL_SETTINGS`; the stud stock and the default header have no default (the user chooses
them, ADR 0015 decision 7). Sources are the M6 plan, Part 1; "unverified" ones were read through a
summarising search, not the primary source.

| Setting             | Default                | Source                                                                                   |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `spacing`           | 16" (406.4 mm)         | Common practice; IRC Table R602.3(5) lists 12", 16", 19.2", 24" (cited, not checked)     |
| `layoutOrigin`      | 0, from the start      | Fine Homebuilding, "Laying Out Stud Walls": sheet edges on stud centres                  |
| `bottomPlates`      | 1                      | IRC R602.3.4 (via UpCodes, unverified)                                                   |
| `topPlates`         | 2                      | IRC R602.3.2, double top plate (via UpCodes, unverified)                                 |
| `spliceOffset`      | 24" (609.6 mm)         | IRC R602.3.2, end joints offset at least 24" (via UpCodes, unverified), as a layout rule |
| `plateStockLengths` | 8', 10', 12', 14', 16' | Common retail lengths (unverified)                                                       |
| `precutLengths`     | 92-5/8", 104-5/8"      | Fine Homebuilding and JLC as summarised (unverified)                                     |
| `cornerStyle`       | `two-stud`             | Fine Homebuilding, as Part 1 describes the corner                                        |
| `ladderSpacing`     | 24" (609.6 mm)         | Common practice (unverified)                                                             |
| `kings`             | 1                      | Fine Homebuilding: one full-height king each side                                        |
| `blocking`          | `none`                 | The user's choice                                                                        |
| `headerRules`       | empty                  | ADR 0015 decision 7: no shipped header table                                             |

Framing practice varies by region and framer; every choice above is a setting.

## Floor framing: `frameFloor`

```ts
import { frameFloor } from '@manufakture/domain-construction';

const { members, warnings, overrides, top, subfloor } = frameFloor({
  floor: 'extension#9', // the owner of every member
  outline: [
    [0, 0],
    [3657.6, 0],
    [3657.6, 4876.8],
    [0, 4876.8],
  ], // 12' x 16', in plan
  direction: [1, 0], // the joists span along x (12')
  elevation: 0, // the bottom of the joists and rims
  settings: {
    joistStock: s2x6,
    blocking: { kind: 'mid-span' },
    skids: { stock: s4x6, count: 3 },
    subfloor: osb2332,
  },
  walls: [{ id: 'extension#3', start: [0, 1625.6], end: [3657.6, 1625.6] }],
  overrides: [{ id: 'j5', delete: true }],
});
```

**Outline.** A simple polygon in plan, either winding, with every edge along or across the joist
`direction`: a rectangle, or an L, T or U shape, at any rotation. Repeated and collinear points
are dropped. An edge at an angle to the joists, fewer than four corners, a self-crossing outline,
an edge shorter than two joists, or any floor `openings` (stairs, out of scope in M6) throw a
`FramingInputError`.

**Rims** (band joists, `rimStock`, the joist stock by default) stand on edge along every outline
edge across the joists, full length, inside the outline; longer than the longest `stockLengths`
they are spliced at the longest length. **Joists** (`joistStock`, on edge) run between the rims.
Layout is a wall's (Part 1): `j0` flush with the side layout starts from (the least extent along
the layout axis, which is the joist direction turned 90 degrees left, or the greatest with
`layoutFrom: 'end'`), `j<k>` centred on `layoutOrigin + k x spacing`, the last flush with the far
side, so 4' sheet edges land on joist centres. Every inner outline edge along the joists (an L, T
or U) gets a flush joist inside the outline along it (`f<n>`); a layout joist within 3 mm of
that position takes its place, any other layout joist overlapping it is left out. Where the
outline splits a band of joists (a U's two arms), each piece is its own member.

**Doubled joists under walls** (`doubleUnderWalls`, on by default): each wall in `walls` (its
centre line in plan) that runs along the joists gets a pair of joists centred under it, full span
between the rims; layout joists in their way are left out and come back under their old ids when
the wall moves. A wall across the joists needs nothing; a wall at an angle, a pair outside the
floor or running into an end or flush joist warns and is left out.

**Blocking** (`blocking`): `none`, `mid-span` (in each bay, the middle of the two joists' common
span), or rows `at` distances along the span from the outline's least extent along the joists.
Blocks are joist stock on edge, from face to face, only inside the outline (never across the gap
between a U's arms). A bay is any stretch where two joists' spans overlap with no joist between
them, so a full-span joist under a U's two arms has a bay up into each arm. A row that falls in no
bay warns.

**Skids** (`skids`, optional): `count` skids (or beams) of `stock` on edge under the joists,
across them, the outer two flush with the outline and the rest spread evenly (or centred at
`positions` along the span), each running the outline's extent plus `overhang` at both ends.

**Subfloor** (`subfloor`, a sheet stock whose `width` is its thickness) is not a member: the result
reports it as a sheet layer for the takeoff (`subfloor: { stock, outline, area, z }`), sitting on
`top`, the top of the framing. The layer body is the floor feature's (T6.1c).

**Overrides** are the floor's params, keyed by local id: `delete`, `stock`, `move` (mm along the
layout axis). Each reports `applied` or `lost`, and a lost one warns `override-lost`.

**Warnings** are layout warnings only: `wall-not-parallel`, `wall-outside-floor`,
`framing-conflict`, `longer-than-stock` (a joist or skid longer than the longest stock length;
nothing about the span), `blocking-row-outside`, `skid-outside`, `override-lost`. The generator
checks no span, load or code; joist stock and spacing are the user's choice.

**Floor member ids** (owned by the floor, ADR 0015 decision 6). `:<p>` is the piece along the span
where the outline splits a band (or a rim splice): the first piece has no suffix, then `:2`, `:3`.

| Form             | Example          | Meaning                                                                                       |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `j<k>[:<p>]`     | `j12`, `j3:2`    | Layout slot k: `j0` flush where layout starts, `j<k>` centred, the last flush at the far side |
| `f<n>[:<p>]`     | `f1`             | Flush joist along the n-th inner outline edge along the joists, in layout order               |
| `w<i>a`, `w<i>b` | `w1a`, `w2b:2`   | The doubled pair under the i-th wall along the joists, in layout order; `a` nearer the start  |
| `rim<n>[:<p>]`   | `rim1`, `rim2:2` | Rim on the n-th outline edge across the joists, along the span, then along the layout         |
| `block<r>:<n>`   | `block1:4`       | Blocking row r, block n along the layout                                                      |
| `skid<n>`        | `skid3`          | Skid n along the span                                                                         |

`parseFloorMemberId` and `formatFloorMemberId` round-trip every form and refuse other spellings
(`j3:1`, `j01`, `rim1:1`).

### Floor defaults

`DEFAULT_FLOOR_SETTINGS`; the joist stock has no default (the user's choice) and the rim stock
defaults to it.

| Setting            | Default               | Source                                                     |
| ------------------ | --------------------- | ---------------------------------------------------------- |
| `spacing`          | 16" (406.4 mm)        | Common practice, as walls; spacing is the user's choice    |
| `layoutOrigin`     | 0, from the start     | As walls: sheet edges on joist centres (Fine Homebuilding) |
| `blocking`         | `none`                | The user's choice                                          |
| `stockLengths`     | 8' to 20' in 2' steps | Common retail lengths (unverified)                         |
| `doubleUnderWalls` | on                    | Common practice (unverified)                               |
| `skids`            | none                  | The user's choice                                          |

**Tests.** `src/framing/floor.test.ts` holds the hand-computed shed fixtures: a 12' x 16' floor
with 2x6 joists at 16" spanning 12' has 13 joists of 141" (12' less two 1-1/2" rims) at 0,
16k and 190-1/2", 2 rims of 16', three 4x6 skids of 16' and a mid-span row of 12 blocks (10 of
14-1/2" and, in the end bays from 1-1/2" to 15-1/4" and from 176-3/4" to 190-1/2", 2 of
13-3/4"); plus 9 joists at 24", L and U outlines, rotation, walls, splices, overrides, refusals
and the id forms. `src/framing/floor.property.test.ts` frames 300 seeded random rectangles and
L, T and U floors and checks that no two members overlap, every member but the skids stays inside
the outline, every joist end bears fully on a rim, every block has a joist each side, ids are
unique and parse, and output is deterministic.

## Roof framing: `frameRoof`

```ts
import { frameRoof } from '@manufakture/domain-construction';

const { members, warnings, geometry, overrides } = frameRoof({
  roof: 'extension#9', // owns every member below, gable studs included
  kind: 'gable', // or 'hip'
  pitch: Math.atan(6 / 12), // radians; the feature layer parses `6/12`
  footprint: {
    origin: [0, 0], // corner c1, in plan
    direction: 0, // plan angle of the length axis (e1)
    length: 4876.8, // 16 ft, along the ridge
    width: 3657.6, // 12 ft span
    plate: 2466.975, // elevation of the top of the top plates
    wallThickness: 88.9, // the birdsmouth seat
  },
  settings: {
    rafterStock: s2x6,
    ridgeStock: s2x8,
    overhang: 304.8,
    ties: { kind: 'rafter-ties', stock: s2x4, every: 2, height: 609.6 },
    gableStuds: { stock: s2x4, spacing: 406.4 },
  },
  overrides: [{ id: 'e1:c3', delete: true }],
});
```

**Footprint and frame.** A rectangle at the outside line of the walls' top plates, in the roof's
own plan frame: `u` along the length, `v` across, `z` up. Its edges, counter-clockwise from the
origin: `e1` (v = 0), `e2` (u = length), `e3` (v = width), `e4` (u = 0). A gable's eaves are e1
and e3 and its gable ends e2 and e4; a hip roof has eaves all round and its ridge along the
length, so a hip footprint's length must be at least its width (the feature layer orients it).
Along every edge, positions are measured from its end with the smaller coordinate (end `a`; the
other is `b`), so slot k on e1 faces slot k on e3, and a jack on one side of a hip meets the hip
where the jack on the other side does. Corners `c1` to `c4` are where e1 to e4 start: (0, 0),
(length, 0), (length, width), (0, width). The roof is placed by one rotation and move, so the
members' local cuts do not depend on where it stands.

**Pitch math** (M6 plan, Part 1, "Roof pitch math"), returned in `geometry`:

- **Common rafter.** Run = half the span less half the ridge board's thickness (71-1/4" for a
  12' span and a 1-1/2" ridge). Line length = run x `sqrt(12^2 + p^2) / 12` (79.66" at 6/12).
- **Birdsmouth.** A level seat of the wall's thickness on the plates and a plumb heel at the wall
  line: heel `seat x tan`, depth square to the rafter `seat x sin` (1.565" for 3-1/2" at 6/12).
  The bottom edge meets the plates at the seat's inside edge, so the rafter's top stands
  `depth / cos - seat x tan` above the plates at the wall line (height above plate, 4.399" for a
  2x6 at 6/12).
- **Ridge.** Its top is flush with the rafters' top corners at its faces: run x rise / run plus
  the height above plate above the plates (40.024" for the shed).
- **Hip.** 45 degrees in plan, angle `atan(p / 16.97)`, length factor `sqrt(16.97^2 + p^2) / 12`
  per unit of common run (1.5 at 6/12). It is **dropped** (not backed) by half its width off the
  hip line times the roof's slope across it, `(width / 2) x tan / sqrt(2)`, so its top corners
  lie in the roof planes; its seat is wherever its bottom edge meets the plates. Jacks shorten
  by `spacing x common factor` each (17.89" at 16" and 6/12).

**Members** (roles in brackets), every one cut from a blank with its cuts as half-spaces in its
own frame (ADR 0015 decision 4); a cut that removes nothing is dropped:

- **Common rafters** (`common-rafter`): local x up the slope, y level across it, the depth
  square to the top edge. Cuts: a tail cut (`tail: 'plumb'` at the overhang, or `square`, then
  the square end's top corner is at the overhang and no cut is needed), the birdsmouth as one
  `notch` (heel and seat), and a plumb cut at the ridge face. A gable lays them out like a wall:
  slot 0 flush with end a, slot k centred on k x spacing, the last flush with end b (13 pairs on
  16' at 16"). A hip roof puts one at each ridge end and others on layout between them on e1 and
  e3, one in the middle when the ridge ends are closer than a rafter, and one king common on e2
  and e4, which butts the ridge's end.
- **Jack rafters** (`jack-rafter`, hip): on layout from the ridge-end commons out towards each
  corner, as far as a jack still stands on its edge and reaches past its seat; top end a plumb
  side cut at 45 degrees in plan against the hip's face.
- **Hip rafters** (`hip-rafter`): from each outside corner to the ridge end, dropped as above;
  tail cut plumb on both eave lines; top end two plumb cuts, against the ridge's end face and
  the king common's side; a birdsmouth when the hip reaches the plates, else a `hip-above-plate`
  layout warning. A hip roof needs a ridge at least as thick as a rafter.
- **Ridge** (`ridge`): on edge along the length. Gable: the full length plus the rake overhangs.
  Hip: length less width plus one ridge thickness, so the king commons have the side commons'
  run; a square footprint gets a block one ridge thickness long (a pyramid). Longer than the
  longest of `stockLengths`, it is spliced at the farthest rafter centre that keeps each piece
  within stock.
- **Fly rafters** (`fly-rafter`, gable): with `rakeOverhang` (at least a rafter's width), one
  pair at each end with its outer face at the overhang, like a common but with no birdsmouth.
  Lookouts and barge boards are not framed.
- **Ceiling joists or rafter ties** (`ceiling-joist`, `rafter-tie`; `ties`): beside the common
  pairs, every `every`-th eligible pair from the first. Gable: the pairs over the gable walls are
  not eligible. Hip: the commons on e1 and e3, as far as the tie stays between the ridge's ends.
  A tie goes on the rafter's side towards the middle, else the other side, else it is left out
  with a `tie-skipped` layout warning. Ceiling joists sit on the plates and run wall line to wall
  line; rafter ties stand `height` above the plates and run to where their underside meets the
  roof; both are cut where their upper corners rise above the roof's top plane. Ties that would
  reach the ridge are refused.
- **Gable studs** (`gable-stud`, gable; `gableStuds`): on each gable wall's layout (stud k
  centred on `origin + k x spacing` from v = 0, per end), inside the wall's thickness, standing
  on the top plates and cut to the end rafters' underside, and flat at the ridge board's
  underside where they meet it. A stud shorter than its own width (near the eaves) is left out.
- **Sub-fascia and fascia** (`sub-fascia`, `fascia`, plumb tails only): on edge against the tail
  cuts, the fascia outside the sub-fascia, tops flush with the rafters' tails. Gable: along the
  eaves, rake to rake. Hip: all four eaves, the long sides running past the corners and the ends
  butting between them. Spliced at rafter centres like the ridge.

**Who owns the gable studs.** ADR 0015 does not say. The roof does: they are cut to the roof
line, T6.1c says a pitch change "re-runs only the roof and its gable studs", and the gable wall
(T6.2a) ends at its top plates. So the roof's input names the gable walls' stud stock, spacing
and layout origin, and the studs' ids are the roof's (`e2:g4`).

**Roof member ids** (owned by the roof; `parseRoofMemberId` and `formatRoofMemberId`
round-trip every form and refuse other spellings: `e1:c01`, `ridge:0`, `e1:ja0`):

| Form                              | Example          | Meaning                                                                       |
| --------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `e<n>:c<k>`                       | `e1:c4`, `e2:c0` | Common rafter at slot k on eave n (hip: slot 0 at the ridge end nearer end a) |
| `e<n>:ja<k>`, `e<n>:jb<k>`        | `e1:ja2`         | Jack k on edge n, k spacings from the ridge-end common towards end a or b     |
| `e<n>:fly-a`, `e<n>:fly-b`        | `e3:fly-b`       | Fly rafter beyond end a or b of eave n                                        |
| `e<n>:g<k>`                       | `e4:g3`          | Gable stud at layout position k on gable end n                                |
| `e<n>:sub:<p>`, `e<n>:fascia:<p>` | `e1:sub:2`       | Sub-fascia or fascia piece p along edge n                                     |
| `hip<c>`                          | `hip2`           | Hip rafter at corner c                                                        |
| `ridge:<p>`                       | `ridge:1`        | Ridge board piece p                                                           |
| `tie<k>`                          | `tie5`           | Ceiling joist or rafter tie beside the common pair at slot k                  |

Changing the spacing or the footprint's length renumbers slots; the hip roof's commons and jacks
are numbered from the ridge ends, so lengthening a hip roof keeps its jacks' ids.

**Warnings** (`kind` `rule-of-thumb` for framing practice, `layout` for what could not be laid out
as asked; none is a structural assessment, and no message calls anything safe, compliant or OK):

| Code                | Kind            | When                                                                                            |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `birdsmouth-deep`   | `rule-of-thumb` | The birdsmouth is deeper than a third of the rafter's (or the hip's) depth (Part 1, unverified) |
| `low-slope-no-ties` | `rule-of-thumb` | Below 3/12 with no ceiling joists or ties: framers often use a ridge beam there (IRC R802.3)    |
| `ridge-shallow`     | `rule-of-thumb` | The ridge board is shallower than the rafters' plumb cut against it (IRC R802.3)                |
| `hip-above-plate`   | `layout`        | The hips do not reach the plates, so they get no birdsmouth                                     |
| `tie-skipped`       | `layout`        | No room beside a common pair for its tie                                                        |
| `override-lost`     | `layout`        | An override names a member the roof no longer has                                               |

Warnings carry the measured `value` and the rule's `limit` in mm where there is one.

**Overrides** are the roof's params keyed by local id, as the wall's: `delete`, `stock` (same
placement and cuts; the generator does not re-cut a member for new stock) and `move` (mm along
the member's edge; along the length for the ridge, ties and hips).

**Errors** (`FramingInputError`): a roof id that is not a feature id; a pitch not between 0 and 90
degrees; an empty footprint or no wall thickness; spacing not wider than a rafter (or leaving no
room for ties); a negative overhang; a rake overhang narrower than a rafter; a seat so long the
birdsmouth would cut through the rafter; a span too narrow for the rafters to reach past their
seats; ties that reach the ridge; a fascia on square tails; a hip roof wider than long, with no
hip stock, or with a ridge thinner than a rafter.

Out of scope (ADR 0015 decision 12): unequal pitches, valleys, dormers, trusses, irregular
footprints, lookouts and barge boards.

### Roof defaults

`DEFAULT_ROOF_SETTINGS`; rafter, ridge and hip stock have no default (the user's choice, ADR 0015
decision 7), nor do ties, gable studs or fascia boards.

| Setting        | Default         | Source                                                                               |
| -------------- | --------------- | ------------------------------------------------------------------------------------ |
| `spacing`      | 16" (406.4 mm)  | Common practice, as walls; IRC R802.4.1's tables use 12" to 24" (cited, not checked) |
| `overhang`     | 12" (304.8 mm)  | Common practice (unverified); the shed in T6.7 uses it                               |
| `rakeOverhang` | 0               | The user's choice                                                                    |
| `tail`         | `plumb`         | Common practice where a fascia is hung (unverified)                                  |
| `ties`         | none            | The user's choice                                                                    |
| `stockLengths` | 8' to 16' by 2' | Common retail lengths (unverified)                                                   |

**Tests.** `src/framing/roof.test.ts` holds the hand-computed fixtures with their working in
comments: the 12' x 16' shed gable at 6/12 (13 pairs, run 71-1/4", line length 79.66", blank
95.826", height above plate 4.399", ridge 40.024" above the plates, birdsmouth 1.565"), the
warnings, square tails, fly rafters and a spliced ridge, ties, gable studs, fascia boards,
overrides and placement; and the shed as a 16' x 12' hip roof (10 commons, 32 jacks shortening
by 17.889", hips with factor 1.5, run 100.763", line length 106.875", drop 0.265").
`src/framing/roof.property.test.ts` frames 120 seeded random gable and hip roofs and checks that
no two members overlap, cuts included (each member as convex pieces, by the separating axis
test), every seated rafter's seat is level at the plates with its heel on the wall line, every
common meets the ridge at its top, members stay inside the roof's envelope, ids are unique and
round-trip, and output is deterministic.

## Takeoff

`constructionTakeoff({ members, faces, levels?, stock?, settings? })` (`src/takeoff/`, T6.3a,
ADR 0015 decision 10) counts lumber and sheet goods and prices them, as rows on
`@manufakture/takeoff`'s model (`ConstructionRow` adds `price` and `cost`), with the 1D and 2D
layouts of `@manufakture/nesting`. Its input is plain data, so it runs in Node with no kernel:
`members` as the generators return them (`TakeoffMember` is `id`, `owner`, `role`, `stock`,
`length`), `faces` as flattened sheet faces (`SheetFace`: a box, or a convex `outline` in it, less
rectangular `holes`), `levels` mapping feature ids to level ids, and the document's stock
overrides for sizes and prices.

**As framed only.** Every row counts what the generators framed and the faces laid, then what to
buy for exactly that. There is no estimating row ("one stud per foot of wall" is how many yards
quote; the project owner decided against showing it). Hardware (nails, hangers, anchors) is not
counted. The result carries `DISCLAIMER_SHORT` as `disclaimer` for every export.

| Category  | Rows                                                      | Unit                       |
| --------- | --------------------------------------------------------- | -------------------------- |
| `framing` | members by stock and blank length; items name their roles | each, + length             |
| `linear`  | plates, blocking (and backing), fascia (and sub-fascia)   | length                     |
| `faces`   | sheet layers as laid, by stock and layer: area and pieces | area                       |
| `lumber`  | to buy: precut studs, and lumber by length sold           | each, + length, board feet |
| `sheet`   | to buy: sheets per stock                                  | sheet, + area              |

**Lumber.** Studs, kings and corner studs whose length is within 0.5 mm of a precut stud of their
stock (`us-2x4-precut-92-5-8`) are bought as precuts (`precuts: false` turns this off). Every
other member of a lumber stock goes to `layoutSticks` on the lengths sold (`settings.lengths` by
stock id, else the catalog's), with `kerf` (default 1/8") and `trims`; each stick is then the
shortest length that holds its cuts, and when every length has a price the layout is ranked by
price. The wall and roof generators splice plates and ridges at their own stock lengths; a plate,
rim, ridge or fascia still longer than every length sold is bought in pieces (`spliced`), and any
other member that long is listed at its own length (`longer-than-stock`). A stock with no lengths
sold is bought at the members' lengths (`no-stock-lengths`). Members cut from sheet stock (a
header's plywood spacer) go to the sheet layout as parts.

**Sheets.** Each face is laid with whole sheets from its starting corner (`from`, default its
start) and bottom, `vertical` (wall sheathing, siding) or `horizontal` (drywall, subfloor, roof
sheathing: across the framing) by default. Each grid cell gives one piece, the bounding rectangle
of the face inside it; a hole inside a piece is cut out of it, and the cut-out is an offcut when
it is at least `minOffcut` (default 12" by 3"). The face's partial pieces are packed onto its own
cut-outs first, then every partial piece left, across all faces of that stock, onto the offcuts
left anywhere and then onto new sheets (`layoutSheets`, offcuts at no cost so they are used
first). Sheets bought are whole plus new, plus `wastePercent`, rounded up. Sheets have no grain
here; a piece the outline only partly covers (a gable's slope) is a rectangle, and the triangle
beside it is waste. Helpers build faces: `wallFace` (length by height less rough openings, with an
optional gable on top), `subfloorFace` (T6.2b's `SubfloorReport`, x across the joists; a
rectilinear outline becomes its box with the missing parts as holes) and `roofSheathingFaces`
(the same input as `frameRoof`: each plane from the eave's overhang line to the ridge's centre
line, `(overhang + width / 2) x the common factor` up the slope; gable planes as long as the
footprint plus both rakes, hip planes as trapezoids and triangles).

**Cost.** A bought row's quantity times its stock's price from `domains.stock`: lumber per piece
(per stick, any length), per foot or metre (of the row's length) or per board foot (on the
stock's basis); sheets per sheet or piece. Rows with no price (`no-price`), a price per a unit
that does not fit (`price-unit`) or a currency other than `settings.currency` (`other-currency`)
are left out of `cost.total` and listed in `cost.unpriced`. With no `currency` setting, the first
stated currency is the takeoff's.

**Subtotals** (`subtotals`) are the as-framed and as-laid rows' totals per feature (a member's
owner, so an opening's members are the opening's) and, when `levels` is given, per level. What to
buy is laid out across the whole building, so it has no per-feature split.

Tests: `src/takeoff/framing.test.ts` (the T6.2a 16' wall's rows: 13 precut studs and three 16'
plates, plates as 12' pieces, precuts off, cost per piece, foot, metre and board foot, flags),
`src/takeoff/sheets.test.ts` (a 16' x 8' face with a door is 4 sheets of 4 x 8 with the cut-out
noted; 4 x 12 drywall; offcut reuse on a face and across faces; waste; faces from walls, an L
floor and gable and hip roofs) and `src/takeoff/shed.test.ts`, the 12' x 16' shed framed with the
real generators, every count derived by hand in its comments: 51 precut studs; 2x4 13 x 16', 4 x
14', 1 x 12'; 2x6 18 x 16', 13 x 12'; 2x8 1 x 16', 1 x 8'; 4x6 3 x 16'; 25 sheets of 7/16" OSB
(18 whole, 7 new for the partial pieces) and 6 of 23/32" OSB; $1,708.90 at the test's prices.

## Tests

`src/framing/wall.test.ts` holds hand-computed fixtures in inches (13 studs on a 16' wall at 16"
and 9 at 24", plates and splices, corner styles, tees, the 36" x 80" door with 78-1/2" jacks and
6-7/8" cripples, the 36" x 48" window, header rules, blocking, overrides, segments, input errors).
`src/framing/wall.property.test.ts` frames 400 seeded random walls and checks that no two members
overlap, every member stays inside the wall's envelope, every stud bears fully on the bottom
plate, top plate splices keep their offset, full ids are unique, every local id parses for its
owner, and output is deterministic. `src/member-ids.test.ts` round-trips every id form and
refuses non-canonical spellings. `src/data.test.ts` covers `domains.construction`: valid and
invalid data with the field at fault, a variable in a level refused, newer versions, the writer's
round trip, the defaults (one level, no header rules), `newWallType`, wall type thickness (4-7/16"
for 2x4, 7/16" OSB and 1/2" drywall, and with a stock override), the length bounds and the
registration. `src/features/regen.test.ts` runs walls and openings through regen with the real
kernel: a 16' wall's layer volumes exact and T6.2a's 13 studs, an L path's mitred layers, a closed
12' x 16' outline, a 36" x 80" door cutting sheathing and drywall exactly with its members, a moved
opening re-framing only its wall, L corners and tees between walls, crossings refused, a
suppressed host, a stock override widening the wall, face names kept as a wall lengthens, opening
scope and fit, header sources and the `no-header-rule` warning, overrides. `src/features/features.test.ts`
covers the params readers, layer outlines and the wall graph at 90 and 45 degrees.
`src/boundary.test.ts` checks every import against ADR 0015's allowlist.

```sh
pnpm --filter @manufakture/domain-construction test
```
