# @manufakture/domain-construction

The construction domain (M6 plan, [`docs/plans/m6.md`](../../docs/plans/m6.md);
[ADR 0015](../../docs/adr/0015-construction-domain.md)): framing
generators that turn a wall (and, with T6.2b and T6.2c, a floor and a roof) into **member data**,
the member data shape and its ids, and the short "not an engineering tool" text. Plain TypeScript
under GPL-3.0-or-later.

**Not an engineering tool.** The generator lays framing out by geometric rules the user chooses
(spacing, plate counts, header sizes, corner style). It computes no loads, checks no spans, sizes
no members and checks nothing against a building code. Its warnings are layout warnings, and the
ones that come from framing practice are labelled as rules of thumb. `DISCLAIMER_SHORT` is the
one string the app, drawing title blocks and takeoff exports show (a placeholder until T6.0c's
wording is approved by the maintainer).

**Dependencies.** At run time only `@manufakture/units` (for `MM_PER_INCH` in the defaults), so
everything runs in Node with no `.wasm`. ADR 0015 decision 1 also allows `core`, `takeoff`,
`nesting` and `stock` at run time, and `regen` and `kernel` as types only; never the kernel,
regen, Manifold, the app or another domain. `src/boundary.test.ts` enforces that allowlist. The generator's input is this package's own type: the feature layer
(T6.1b) evaluates the wall feature's expressions, resolves the wall graph and the construction
domain data (T6.1a), and passes plain numbers in. Stock is passed in as a `StockRef` (catalog
id, nominal name, dressed sizes), so the package does not read the stock catalog itself.

**Units.** Millimetres everywhere inside (ADR 0005). The tests write their fixtures in inches
and convert.

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

## Tests

`src/framing/wall.test.ts` holds hand-computed fixtures in inches (13 studs on a 16' wall at 16"
and 9 at 24", plates and splices, corner styles, tees, the 36" x 80" door with 78-1/2" jacks and
6-7/8" cripples, the 36" x 48" window, header rules, blocking, overrides, segments, input errors).
`src/framing/wall.property.test.ts` frames 400 seeded random walls and checks that no two members
overlap, every member stays inside the wall's envelope, every stud bears fully on the bottom
plate, top plate splices keep their offset, full ids are unique, every local id parses for its
owner, and output is deterministic. `src/member-ids.test.ts` round-trips every id form and
refuses non-canonical spellings. `src/boundary.test.ts` checks every import against ADR 0015's
allowlist.

```sh
pnpm --filter @manufakture/domain-construction test
```
