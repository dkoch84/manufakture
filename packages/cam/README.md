# @manufakture/cam

Computer-aided machining for GRBL routers, the Shapeoko first ([M5 plan](../../docs/plans/m5.md),
[ADR 0014](../../docs/adr/0014-cam-architecture.md)). This package will hold the CAM types, the
toolpath intermediate representation (IR), WCS and stock math, the offset adapter, the operations,
linking, the simulation, the machine and tool tables, the post-processors and the CAM worker. So
far it has the foundation every later task builds on (T5.1c): evaluated input types, the IR, WCS
transforms, stock boxes, IR statistics and bounds, and the IR validator.

Pure TypeScript; its runtime dependencies are `clipper2-ts` (the offset engine, T5.2a) and
`comlink` (the CAM worker, T5.1g). Everything runs in Node tests with no kernel `.wasm` loaded.

## Units and inputs

Every number is in internal units: **millimetres, radians, millimetres per minute, rpm**, and
**minutes** for times (`@manufakture/units`), with one exception named in its field: a dwell is in
`seconds`. Functions take plain, evaluated data. The caller (`apps/web`, as for print) evaluates
the document's `StoredExpression`s and resolves its references first (ADR 0014 decision 1), so this
package never sees an expression, a face name or a document.

Fallible functions return a `CamResult<T>`: `{ ok: true, value }` or `{ ok: false, error }`, with
`error.code` one of `invalid-input`, `not-parallel` (a plane or axis not parallel to the setup,
ADR 0014 decision 5) and `stock-too-small`. They never throw on bad input.

## Package boundary

ADR 0014 decision 1: at run time the package may load only its own modules, `@manufakture/units`,
`comlink` (the worker, T5.1g) and `clipper2-ts` (the offsets, T5.2a). Type-only imports may also
name `@manufakture/core` and `@manufakture/kernel`. It never loads the kernel, regen, the sketch
package, a domain package, the app or the DOM. `src/boundary.test.ts` enforces this as an
allowlist over every file in `src/`, including subdirectories and relative paths that would leave
the package, so a new dependency fails there until it is added on purpose.

## Evaluated types (`types.ts`)

The evaluated counterparts of the document's `cam` section (T5.1b), each with its document id.

- **`Tool`**: `id` (`tool#n`), `name`, `kind` (`flat`, `ball`, `bull`, `vbit`, `drill`,
  `engraver`), `number?` (written with `T`), `diameter`, `fluteLength`, `flutes`, and per kind
  `cornerRadius?` (bull), `angle?` (V-bit included angle or drill point angle, radians) and
  `tipDiameter?` (V-bit flat tip).
- **`Feeds`**: `spindle` (rpm), `cut`, `plunge`, `ramp?` and `lead?` (mm/min; `ramp` and `lead`
  fall back to `cut`). Each IR feed move names its class, and the generator picks the feed from
  here.
- **`Stock`**: `min`, `max` in the setup frame (below), `material?` (a core material category id).
- **`Wcs`**: `up` and `origin`, see [WCS](#wcs-and-machine-coordinates).
- **`WcsFrame`**: the resolved WCS, `origin`, `xAxis`, `yAxis`, `zAxis` in model coordinates.
- **`Heights`**: `clearance` and `retract`, machine Z.
- **`Setup`**: `id`, `name`, `stock`, `wcs`, `frame`, `heights`, `machine` and `post` ids (not
  interpreted here), and `operations` in cut order.
- **`OperationInput`**, one per kind, each with `id` (`<kind>#n`), `name`, `tool` and `feeds`.
  These are first cuts that the operation tasks extend:
  - `facing`: `loops`, `depth`, `stepdown`, `stepover` (fraction of the diameter), `angle`;
  - `profile`: `loops`, `side` (`outside`, `inside`, `on`), `depth`, `stepdown`,
    `finishAllowance`, `tabs?` (`count`, `width`, `height`), `entry`, `leadIn`, `leadOut`, `climb`
    (and, for now, the optional `ProfileExtras` of [the profile operation](#the-profile-operation-opsprofilets));
  - `pocket`: `loops` (outer and islands), `depth`, `stepdown`, `stepover`, `finishAllowance`,
    `entry`, `climb`;
  - `drill`: `points` (`MachineDrillPoint`), `peck?` (mm), `dwell?` (seconds) (and, for now, the
    optional `DrillExtras` of [the drill operation](#the-drill-operation-opsdrillts));
  - `vcarve`: `loops`, `top`, `maxDepth?` (and, for now, the optional `VCarveExtras` of
    [the V-carve operation](#the-v-carve-operation-opsvcarvets));
  - `surface3d`: `mesh`, `stepover` (mm), `angle`, `allowance` (and, for now, the optional
    `Surface3dExtras` of [the 3D surfacing operation](#the-3d-surfacing-operation-opssurface3dts)).
  - `Entry` is `plunge`, `ramp` (`angle`) or `helix` (`angle`, `radius`); `Lead` is `none`,
    `line` (`length`) or `arc` (`radius`).

### Geometry inputs

- **`Loop2`**: a closed loop of `segments`, each starting where the previous one ends. Outer loops
  run counter-clockwise and holes clockwise, seen from +Z.
- **`Segment2`**: a `line` (`start`, `end`) or an `arc` (`start`, `end`, `center`, `ccw`,
  `fullCircle?`). An arc's sweep runs from start to end in its direction; a full circle is only
  ever explicit (`fullCircle: true`), never implied by equal ends (ADR 0014 decision 12). Every
  segment may carry a `source` tag.
- **`SourceTag`**: where a segment came from: `{ kind: 'edge', edge }` (a kernel edge name),
  `{ kind: 'sketch', sketch, entity }` or `{ kind: 'hole', feature }`. Toolpaths and messages use
  it to name what they follow, and the tagged arc refit (T5.2a) to rebuild exact arcs.
- **`PlanarLoops`**: loops on a plane in model coordinates, as the geometry stage (T5.1f) extracts
  them: `origin`, `xDir`, `normal`, `loops`. The 2D point (u, v) is the model point
  `origin + u * xDir + v * cross(normal, xDir)`.
- **`MachineLoops`**: loops in machine XY at one machine `z`.
- **`DrillPoint`**: a hole in model coordinates: `position` (centre of its top), `axis` (unit,
  into the material), `diameter` (the through hole's, never a counterbore head), `depth`,
  `through?`, `clearBelow?` (mm clear under a through hole's exit, when material lies further
  down), `entryTilt?` (radians the mouth is tilted from square), `source?`.
  **`MachineDrillPoint`**: `at` (machine XY), `depth`, `diameter`, `through?`, `clearBelow?`,
  `entryTilt?`, `source?`.
- **`DepthRange`**: `top` and `bottom` in machine Z, `top >= bottom`.
- **`Mesh`**: `positions` (xyz per vertex) and `indices` (three per triangle), a structural subset
  of the kernel's `MeshData`, for `surface3d`.

## WCS and machine coordinates

Machine coordinates follow the router convention: **+X to the operator's right, +Y away from the
operator, +Z up** towards the spindle. A model point gets there in two steps.

1. **`setupRotation(wcs.up)`** turns the model so the up direction becomes +Z: the _setup frame_,
   in which the stock box lives. `up` is a model axis (`{ kind: 'axis', axis: '+z' }`) or a
   resolved planar face (`{ kind: 'face', normal, xDir? }`, the face's outward normal). Without an
   explicit `xDir` it is the smallest rotation taking up to +Z, and for -Z a half turn about X:

   | up  | machine X | machine Y | machine Z |
   | --- | --------- | --------- | --------- |
   | +z  | +x        | +y        | +z        |
   | -z  | +x        | -y        | -z        |
   | +y  | +x        | -z        | +y        |
   | -y  | +x        | +z        | -y        |
   | +x  | -z        | +y        | +x        |
   | -x  | +z        | +y        | -x        |

   `boundsInSetup(rotation, box)` turns the body's model bounds into the setup frame: exact for
   the axis ups, enclosing but possibly loose for a tilted face, where
   `pointsBoundsInSetup(rotation, mesh.positions)` gives tight bounds.

2. **`wcsFrame(wcs, stock)`** puts the origin on the stock: `origin.xy` is `front-left` (min X,
   min Y), `front-right`, `back-left`, `back-right` or `centre`, and `origin.z` is `top` (the
   stock's top face, the usual Z zero) or `bottom` (the spoilboard). The result is a `WcsFrame`.

Then `toMachine(frame, p)` is `[(p - origin) . xAxis, (p - origin) . yAxis, (p - origin) . zAxis]`,
`toModel` its inverse and `directionToMachine` the rotation alone.

- **`planarLoopsToMachine(frame, planar)`** maps a face's or region's loops into machine XY at
  their plane's machine Z. The plane must be parallel to machine XY within `PARALLEL_TOLERANCE`
  (1e-6 rad), facing up or down; anything else is a `not-parallel` error, never a projection. A
  plane facing down is seen mirrored from above, so its loops are reversed (`reverseLoop`) to keep
  outer loops counter-clockwise. Tags and full-circle flags are kept.
- **`drillPointToMachine(frame, point)`** gives the hole's machine XY and `DepthRange`; its axis
  must point down the machine Z axis within the same tolerance.

## Stock

- **`stockFromBounds(bodyInSetup, margins, material?)`**: the body's setup-frame bounds grown by
  `StockMargins` (`xMin`, `xMax`, `yMin`, `yMax`, `top`, `bottom`, each zero or more).
  `uniformMargins(side, top = side, bottom = 0)` builds the common case.
- **`stockFromSize(bodyInSetup, size, offset, material?)`**: an explicit size, placed so the
  body's minimum corner sits `offset` in from the stock's minimum corner. A stock that does not
  contain the body is a `stock-too-small` error naming the axis.
- `stockSize(stock)` is its extent along X, Y and Z.

## Tool library and machine profiles (`library/`)

The built-in tools, feed presets and machine profiles (T5.1d), also exported on their own as
`@manufakture/cam/library` so the app's library store loads them without the rest of the package.
Library data keeps each number in the unit its source prints (`unit: 'in'` for Carbide 3D's inch
cutters and charts; angles in degrees as `angleDeg`), so nothing is rounded on the way in;
`toMm`, `resolvePreset` and `libraryToolToTool` give internal units. Every number from outside
says where it comes from (`source`: the URL and the figure as printed) and whether it was checked
against it (`verified`), like the kernel's `HOLE_SIZES`; `unverifiedToolFields(tool)` and
`unverifiedMachineFields(machine)` list the unchecked ones by path, for the UI to flag.

```ts
BUILTIN_TOOLS: readonly LibraryTool[]      // starter set; ids permanent (copied tools name them)
FEED_CATEGORIES                            // plywood, mdf, softwood, hardwood, plastics, aluminium, steel
MATERIAL_FEED_CATEGORY                     // core material id -> feed category ('oak' -> 'hardwood')
resolvePreset(tool, materialOrCategory): CamResult<ResolvedPreset>   // mm, mm/min, rpm, chip load
feedFromChipLoad(rpm, flutes, chipLoad)    // feed = rpm x flutes x chipLoad
chipLoadFromFeed(feed, rpm, flutes)
MACHINES, SPINDLES, COMPACT_ROUTER_DIAL, DEFAULT_MACHINE_ID, defaultPost(m), machineDial(m)
libraryToolToCamTool(tool, 'tool#3', 'builtin'): CamToolData   // for addCamTool
validateLibraryTool(value), validateToolLibraryFile(value), parseToolLibrary(json),
serializeToolLibrary(tools), validateMachine(m)
```

**Tools.** Carbide 3D #201 (1/4" flat, 3 flutes), #102 (1/8" flat), #251 (1/4" down-cut flat),
#101 (1/8" ball), #302 and #301 (1/2" V-bits, 60 and 90 degrees), plus a 3 mm and a 6 mm
two-flute flat and a 1/8" drill with no vendor. Geometry is read from each Carbide 3D product
page's spec table (`https://shop.carbide3d.com/products/<handle>`, read 2026-10-02; the vendor's
catalogue number becomes the tool number). The pages print no cutting length for the V-bits; their
`fluteLength` is the cone height, (diameter / 2) / tan(angle / 2). The metric end mills and the
drill have typical dimensions and `verified: false`. Carbide 3D's 2019 Nomad chart labels #101 as
square and #102 as ball; the current product pages say the opposite, and the product pages win.

**Feeds.** One source per entry, labelled a starting point, not a promise. The #201's presets are
the rows of Carbide 3D's "Shapeoko 3 Feeds & Speeds" chart for "#201 .25" Square" (archived at
`CHART_URL`, dated 2019-07-29; measured slotting, "100% engagement"), as printed in inches:
Plywood, MDF, Pine (softwood), Mahogany (hardwood: the chart has no oak, which is harder), ABS
(plastics; PLA and PETG soften sooner), 6061 AL, and Steel ("Use Coolant"; the category carries
the maker's warning that steel is not recommended on a Shapeoko). Every other tool's presets are
derived from those rows and flagged unverified: chip load scaled by diameter at the same rpm (a
V-bit fed as a 1/8" two-flute cutter, since it cuts mostly near the tip), plunge alike, depth by
diameter capped at the flute length; a drill feeds at its plunge and pecks one diameter. Stepovers
are this library's defaults (40% flat and V-bit, 10% ball, 50% for the drill, where drilling does
not use it), unverified. The chart's own dial table differs from the product page's, so presets
keep the rpm only and the post names the dial setting from the machine's own table.

**Machines.** The Shapeoko 5 Pro 4x4 and Shapeoko 4 XXL are the primary profiles (the machines
cut on), the 5 Pro 4x4 the default (`DEFAULT_MACHINE_ID`): the larger, stiffer machine, and nothing
in the data argues otherwise. The other Shapeoko 4 (Standard, XL) and 5 Pro (4x2, 2x2) sizes
follow. Default configuration throughout: the Carbide Compact Router and its dial, Carbide Motion,
the BitSetter. Sources, read 2026-10-02:

| Number                | Value                                                          | Source                                                                                                                                            | Verified |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Shapeoko 5 Pro travel | 4x4 1237 x 1237, 4x2 1237 x 623, 2x2 623 x 623 mm; Z 155 mm    | `carbide3d.com/shapeoko/shapeoko5pro-specs/` "Machine Travel", "Total Z Travel"; the 2023 Shapeoko 5 Pro page (Wayback 2023-09-28) gives the same | yes      |
| Shapeoko 4 travel     | Standard 17.5 x 17.5, XL 33 x 17.5, XXL 33 x 33 in; Z 4 in     | `shop.carbide3d.com/products/shapeoko4` "Cutting Area"                                                                                            | yes      |
| Maximum feed          | 5000 mm/min                                                    | `carbide3d.com/shapeoko/capable/`: "Shapeoko cuts at up to 5000 mm/min"                                                                           | yes      |
| Rapid rate            | 5000 mm/min                                                    | no maker figure; Grbl rapids at its $110/$111 maximum, taken as the cutting maximum                                                               | no       |
| Compact Router dial   | 1 11,000; 2 13,500; 3 18,250; 4 24,500; 5 29,250; 6 31,000 rpm | `shop.carbide3d.com/products/carbide-compact-router` (which also says "RPM Range 12,000 - 30,000")                                                | yes      |
| 65mm VFD spindle      | 8,000 to 24,000 rpm                                            | `shop.carbide3d.com/products/vfd-spindle-kit`                                                                                                     | yes      |
| Sender, BitSetter     | Carbide Motion; BitSetter standard                             | each machine's "Includes" list                                                                                                                    | yes      |
| Firmware              | Grbl 1.1 on both                                               | Shapeoko 5 Pro: Carbide 3D staff on its forum ("Grbl 1.1h" is current); Shapeoko 4: no maker statement                                            | no       |

The Shapeoko 5 Pro is recorded as Grbl 1.1, not grblHAL: the maker's own staff name Grbl 1.1h
as its current firmware. So every profile's posts are `['carbide-motion', 'grbl']`: Carbide Motion first, the sender
shipped and the one that handles BitSetter tool changes, then plain `grbl`.
`defaultPost(machine, available)` returns the first of these the build has (`BUILTIN_POST_IDS`
holds every built-in post, `carbide-motion` included since T5.4c; `defaultPost(machine)` alone
gives the first listed). `COMPACT_ROUTER_DIAL` is the
authoritative dial table; the GRBL post's goldens use it.

## The toolpath IR (`ir.ts`)

A **`Toolpath`** is `start` (the machine position before the first entry) and `entries`, in order.
All coordinates are machine coordinates (the setup's WCS), absolute. Arcs lie in the XY plane
(G17). Posts (T5.4a), the preview (T5.3b) and the simulation (T5.3c) read it; operations
(T5.2b to T5.2f) and linking (T5.2g) write it.

### Moves

Every move carries a **`MoveTag`**:

- `op`: the operation id (`profile#2`), or a linking id such as `link` for moves between
  operations. Never empty.
- `pass`: a whole number from 0 within the operation: a depth step, a pocket ring, a peck. What a
  pass means is the operation's to document.

The moves:

- **`rapid`**: `to` (Vec3). A G0 straight to `to`. Never meant to touch material; it has no feed.
- **`linear`**: `to`, `feed` (mm/min, greater than zero), `feedClass`. A G1 straight to `to`.
- **`arc`**: `to`, `center` (absolute machine XY, not IJ offsets), `direction` (`cw` is G2,
  `ccw` is G3, seen from +Z), `fullCircle`, `feed`, `feedClass`.
  - The arc starts at the current position. If `to[2]` differs from the start's Z it is a
    **helix**: Z changes linearly with the angle.
  - Its **sweep** runs from the start's angle to the end's angle in `direction`, in (0, 2 pi).
  - **`fullCircle`** is the explicit intended-full-circle flag (ADR 0014 decisions 10 and 12): a
    helical bore turn or a circular pocket ring. Start and end coincide in XY **only** when it is
    true; equal ends without it are an error, because Grbl would cut a whole turn. One arc is at
    most one turn; a helical bore of n turns is n arcs.
  - The arc refit (T5.2a) caps its arcs at half a turn and turns tiny ones into lines; the post
    (T5.4a) repeats Grbl's radius and travel checks in its own output frame and precision, and
    writes a failing arc as a G1. Those thresholds are engine constants, documented with the post.

**Feed classes** (`FeedClass`, `FEED_CLASSES`) say why a feed move is fed the way it is, and pick
its feed from `Feeds`:

| Class    | Meaning                                                       | Feed     |
| -------- | ------------------------------------------------------------- | -------- |
| `cut`    | cutting along the geometry                                    | `cut`    |
| `plunge` | straight down into material                                   | `plunge` |
| `ramp`   | entering material on a slope or helix                         | `ramp`   |
| `lead`   | lead-in and lead-out moves, tangent onto and off the geometry | `lead`   |

### Other entries

Each may carry an optional `op`.

- **`dwell`**: `seconds` (zero or more), `pass?` (like a move's, when it belongs to one). G4.
- **`toolChange`**: `tool` (the document id, `tool#n`), `number?` (written with `T`), `name` (for
  comments and the operator prompt). The spindle must be off.
- **`spindle`**: `state` `cw` or `ccw` with `rpm` (greater than zero), or `state: 'off'`. M3, M4,
  M5 with S.
- **`comment`**: `text`. Posts sanitise it (parenthesised ASCII, ADR 0014 decision 10).
- **`cycle`** and **`cycleEnd`**: canned-cycle markers. A `cycle` carries `drill` (a
  `DrillCycle`: `at`, `top`, `bottom`, `retract`, `peck?`, `dwell?`) and opens a group that the
  next `cycleEnd` closes. The entries between them are the cycle's expanded G0 and G1 moves (and
  its dwell), complete on their own: the tool starts and ends at `[at, retract]`, feeds down to
  `bottom` in pecks of `peck` measured down from `top` (a rapid back to `retract` after each, and a
  rapid down to just above the last depth before the next), and dwells at the bottom. Markers
  carry no motion and never nest. Grbl has no canned cycles, so its post writes the moves and skips
  the markers, as the statistics, bounds and packing do; a later post for a controller with G81,
  G82 and G83 (grblHAL) may write the cycle instead of the group, provided it reproduces these
  semantics (a G83 that measures pecks from R rather than from `top` does not).

`isMove(entry)`, `isFeedMove(entry)` and `isCycleMarker(entry)` narrow an entry.

## Statistics and bounds (`stats.ts`)

**`toolpathStats(toolpath, { rapidRate })`** returns:

- `cutLength`: the length of every feed move (all classes), mm, and `lengthByClass` per class;
- `rapidLength`: rapids, mm, as straight lines;
- `moveCount`, `toolChanges`;
- `estimate`: `feedMinutes`, `rapidMinutes`, `dwellMinutes`, `totalMinutes`. **An estimate**:
  each move at its programmed feed (or `rapidRate`, the machine's, mm/min) from its first
  instant, no acceleration, no time for tool changes or spindle spin-up. Real runs take longer,
  and the UI must label it as an estimate.

Arc lengths are exact, helices included (`sqrt((r sweep)^2 + dz^2)`).

**`toolpathBounds(toolpath)`** gives `all` (every position the tool tip passes, rapids and
`start` included) and `feed` (feed moves only; `undefined` when there are none). Arcs contribute
their **true extremes**: the end points plus every axis crossing (0, 90, 180, 270 degrees) the
sweep passes, helices included (their Z extremes are their end points). The bounds are of the
tool's control point (tip centre); add the tool radius for the swept outline. The bounds checks
against machine travel (T5.4d) build on these.

The arc helpers are exported too: `arcSweep`, `arcLength`, `arcBounds`, `angleAbout`,
`radiusAbout`, `normalizeAngle`, and `arcFrom(position, arcMove)`.

## The validator (`validate.ts`)

**`validateToolpath(toolpath, { arcTolerance? })`** returns every problem as an `IrIssue`
(`code`, `index` into `entries` (-1 for `start`), `op?`, `message`); an empty list means valid.
Operations and linking run it in their tests, and posts run it before writing anything: a failing
IR is a bug in its producer, never something to write out. The spindle starts off and no tool is
loaded.

| Code                     | Problem                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `non-finite`             | a coordinate, centre, feed, rpm or dwell that is NaN or infinite      |
| `bad-tag`                | a move with an empty `op` or a `pass` that is not a whole number >= 0 |
| `zero-feed`              | a feed move with a feed of zero or less                               |
| `spindle-off`            | a feed move while the spindle is off                                  |
| `no-tool`                | a feed move before any tool change                                    |
| `spindle-rpm`            | a spindle start at zero rpm or less                                   |
| `spindle-state`          | a spindle entry whose state is not `cw`, `ccw` or `off`               |
| `tool-change-spindle-on` | a tool change while the spindle runs                                  |
| `dwell`                  | a negative dwell                                                      |
| `arc-zero-radius`        | an arc starting on its centre                                         |
| `arc-radius`             | start and end radius differ by more than the tolerance                |
| `arc-degenerate`         | start and end coincide in XY without `fullCircle`                     |
| `arc-full-circle-open`   | a `fullCircle` arc that does not end at its start in XY               |
| `cycle-pairing`          | a nested `cycle`, a stray `cycleEnd`, or a `cycle` never closed       |
| `cycle-invalid`          | bottom not below top, top above retract, peck or dwell not above 0    |
| `cycle-content`          | in a cycle: not a rapid, straight feed or dwell, or a move off `at`   |
| `cycle-position`         | a cycle group not starting or ending at `at` on its retract plane     |

The arc tolerance, `DEFAULT_ARC_TOLERANCE`, is **0.0005 mm**: a tenth of Grbl's 0.005 mm radius
check (error 33). The refit projects arc ends onto the exact circle, so its arcs agree far better.
Rapids are allowed with the spindle off and before any tool change. A dwell's `pass`, when it has
one, is checked like a move's (`bad-tag`).

## Offsets (`offset/`)

The offset engine (T5.2a; ADR 0014 decision 12): offsets and booleans of `Loop2`s that come back
as lines and arcs. [clipper2-ts](https://github.com/countertype/clipper2-ts) 2.0.1-18 (BSL-1.0,
pinned exactly, chosen by the [T5.0a spike](../../docs/spikes/T5.0a-clipper2.md)) does the polygon
work behind an adapter (`offset/engine.ts`) that owns the integer scale, the range checks and the Z
tags; nothing else in the package imports it.

Results are `Region2`s: an `outer` loop (counter-clockwise) and the `holes` directly inside it
(clockwise). An island inside a hole is a region of its own. Inputs follow the `Loop2` convention
(outer loops counter-clockwise, holes clockwise; positive winding is inside, so overlapping outer
loops are united, and a clockwise loop that no counter-clockwise loop encloses encloses nothing: a
lone one gives an empty list). `offsetLoops` unites its input this way before offsetting, as the
booleans do. No result holds a clockwise outer, and every path drops loops that fit in a square
`2 * REFIT_TOLERANCE` wide (0.004 mm), so a shape shrinking to a speck vanishes the same way with
or without the fast path. Every function returns a `CamResult`; bad input (a coordinate that is not
finite or lies beyond 4.7 m, a gap over 0.001 mm between segments, an arc with no radius or no
sweep, a non-finite offset) is an `invalid-input` error.

- **`offsetLoops(loops, delta, options?)`**: `delta` mm, positive grows the material (out from
  outer loops, into holes), negative shrinks it. Round joins at sharp corners, as tool compensation
  needs. A shape can split into several regions or vanish (an empty list). A zero offset is the
  union of the loops. Pockets offset **every ring from the source loops**, never from the previous
  ring (22 times the vertices and 41 times the time in the spike).
- **`offsetOpenPaths(paths, delta, { ends })`**: the outline of a stroke `2 delta` wide along each
  `OpenPath2` (an open chain of segments), with `round` (default) or `butt` ends; overlapping
  outlines are united.
- **`unionLoops(loops)`**, **`differenceLoops(subject, clip)`** (stock minus part, pocket minus
  islands), **`intersectLoops(subject, clip)`**.
- `regionLoops(regions)` lists every loop; `regionArea(region)` is exact (arcs included).
- **`kerfLoops(loops, kerf)`** (`offset/kerf.ts`, T5.6b): laser and plasma kerf compensation,
  each loop on its own by half the kerf (outer loops out, holes in, arcs kept; loops never
  merge), with `lost` counting holes that closed up. A zero kerf returns the loops as given; a
  negative one is an `invalid-input` error.
- Geometry helpers, exported for operations and tests: `loopArea` (exact, signed), `loopLength`,
  `segmentLength`, `segmentPoint`, `signedSweep`, `arcRadius`, `distToSegment`, `distToLoops`,
  and `flattenSegments(segments, closed, tol?)` (a polyline with its vertices on the arcs).

### How it works

1. **Flatten and tag** (`flatten.ts`). Arcs are flattened with their vertices on the arc, each
   vertex scaled to integers and tagged in Z with its index plus one (Clipper treats 0 as "no
   tag"). A table maps each tag to its point, the source segments it lies on, whether it is a
   sharp corner (tangent junctions are not, so arcs run on through them) and whether it ends an
   open path.
2. **Clipper**. `ClipperOffset` with round joins and an explicit `arcTolerance`, or `Clipper64`
   for booleans, both with the `Positive` fill rule and a `PolyTree64` result. Clipper copies a
   vertex's tag to every point it offsets from it; the adapter's Z callback gives every other
   intersection the tag of the nearest tagged edge end.
3. **Refit** (`refit.ts`). A polyline segment whose two ends come from the same source arc lies on
   that arc's concentric offset (radius `r + |d|` or `r - |d|`, whichever fits); one whose ends
   come from the same sharp corner lies on the round join about it (radius `|d|`). A run of
   segments on one circle becomes arcs on that exact circle: ends projected onto it, clamped to the
   source arc's angles (Clipper's polyline overshoots a tangent point by a chord), and snapped to an
   open path's end vertex (Clipper squares an end to its first chord, not to the arc's tangent).
   Runs that turn more than half a turn are split into equal pieces. What the tags do not explain
   (lines, intersections, untagged polygon input) goes through a greedy fit of lines and circles
   within the refit tolerance. Then adjacent arcs meet at their circles' intersection and lines
   move to meet arcs, so every loop is exactly continuous.
4. **Demote**. The last step splits an arc swept past half a turn (a stitching artefact) into
   equal pieces on its circle, then turns an arc into a line with the same ends when its sagitta is at
   most `DEMOTE_SAGITTA`, or when it fails Grbl's checks at 3 decimals (`grblArcPrecheck`: the
   radius rule of error 33, and `mc_arc`'s angular travel, which turns an arc whose written ends
   coincide into a full circle), at `options.decimals` (default 3) on both paths. Results never hold a full circle or an arc over half a turn. The
   post repeats Grbl's checks as written (`post/grbl-arc.ts`), which is the authoritative one.

**The analytic fast path** (`analytic.ts`) skips Clipper where the exact answer is provably
simple: a lone counter-clockwise circle offset by any delta that leaves a radius, and a convex
counter-clockwise loop offset outward (each segment moved out along its normal, a round join at
each sharp corner). It declines a dense polygon, whose tiny joins would all become lines (the refit
does better there). `{ analytic: false }` forces Clipper. The spike estimated that it saves little
(0.2 to 4 ms per sketch case); it is kept because its results are exact and the tests compare the
two paths.

### Tolerances (`tolerances.ts`)

All in one place; changing any of them changes the CAM implementation version (ADR 0014).

| Constant               | Value       | Meaning                                               |
| ---------------------- | ----------- | ----------------------------------------------------- |
| `CLIPPER_SCALE`        | 1e4 per mm  | integer units handed to Clipper (0.1 micrometre)      |
| `MAX_CLIPPER_COORD`    | 4.7e7 units | largest coordinate accepted (`MAX_COORD_MM`, 4.7 m)   |
| `FLATTEN_TOLERANCE`    | 0.001 mm    | chord error of arc flattening                         |
| `JOIN_TOLERANCE`       | 0.001 mm    | chord error of Clipper's round joins (`arcTolerance`) |
| `REFIT_TOLERANCE`      | 0.002 mm    | untagged fit; the offset budget after refit           |
| `TAG_TOLERANCE`        | 0.0025 mm   | how far points may be from a circle their tags name   |
| `DEMOTE_SAGITTA`       | 0.0001 mm   | an arc this close to its chord becomes a line         |
| `GRBL_CHECK_DECIMALS`  | 3           | decimals of the refit's Grbl pre-check                |
| `MAX_ARC_SWEEP`        | pi          | largest sweep of one result arc                       |
| `TANGENT_ANGLE`        | 1e-6 rad    | junctions closer to tangent than this get no join tag |
| `CONTINUITY_TOLERANCE` | 0.001 mm    | largest gap allowed between input segments            |

**Accuracy.** Every result is within `REFIT_TOLERANCE` (0.002 mm) of the exact offset, and arcs the
tags explain sit on the exact circles (to about 1e-9 mm in the tests). One exception, inherent to
flattening: at a sharp convex tip with tip angle 2a, the joins' chord error moves the tip of an
out-then-in offset back by up to the error divided by sin(a) (0.008 mm at a 10 degree tip in the
property tests).

**Performance (an estimate).** Medians in Node on the development machine, offset plus refit, with
other tests running: the spike's bracket offset both ways in about 5 ms, a 10,000-vertex outline
in about 140 ms, and the 50 rings of the spike's pocket, each from the source, in about 450 ms (the
spike measured 264 ms for the offsets alone; the engine also re-flattens the source per call and
refits every ring). `perf.test.ts` fails only at ten times the spike's figures.

## The post-processor engine (`post/`)

One engine turns a `Toolpath` into G-code for any controller described by a **dialect record**
(T5.4a; ADR 0014 decision 10). A dialect is data only: a user post is a JSON file of this shape,
checked field by field when it is loaded, and no part of it is ever run.

```ts
postProcess(job: PostJob, dialect: Dialect | CompiledDialect, options?: PostOptions)
  : CamResult<{ files: PostFile[]; stats: PostStats }>
compileDialect(data: unknown): CamResult<CompiledDialect> // load and check a user post
```

`PostJob` is `{ toolpath, job, setup?, date?, origin?, spindleDial?, heights }`: names for the
templates, a date the caller formats (so output is reproducible), where to zero X, Y and Z in
words, the router's dial table (see Spindle below) and the setup's `Heights` (machine Z). Both heights
must be finite and `retract` may not be above `clearance`; the engine refuses the job otherwise.
`PostOptions` picks `units` (`mm`, the default, or `inch`), overrides the dialect's `toolChange`
and `splitPerTool`, and sets the refit `tolerance` (0.002 mm), the IR validator's `arcTolerance`
and the work offsets of the Grbl check. Each `PostFile` has its `lines`, its `text` (newline
terminated) and the tool ids it uses. `compileDialect` checks a JSON copy of its input and returns
it frozen; `postProcess` uses a `CompiledDialect` as is only when `compileDialect` made it, and
compiles anything else. The engine never throws on bad input: anything it cannot
write is an error value with code `unsupported` (the dialect lacks what the IR needs),
`invalid-input` (the toolpath fails `validateToolpath`, the heights are wrong, or an option,
coordinate or feed cannot be written) or `invalid-dialect`. Inch conversion uses
`@manufakture/units`' `MM_PER_INCH`.

### The dialect format

```json
{
  "id": "my-grbl",
  "name": "My Grbl",
  "gCodes": ["G0", "G1", "G2", "G3", "G4", "G17", "G20", "G21", "G90", "G91.1", "G94"],
  "mCodes": ["M0", "M2", "M3", "M5", "M30"],
  "toolChange": "none",
  "splitPerTool": true,
  "cannedCycles": false,
  "fullCircles": "halves",
  "comments": "parentheses",
  "maxLineLength": 80,
  "programDelimiter": false,
  "dwellUnit": "seconds",
  "decimals": {
    "mm": { "coordinate": 3, "feed": 0 },
    "inch": { "coordinate": 4, "feed": 1 },
    "spindle": 0,
    "dwell": 3
  },
  "templates": {
    "header": ["({job} / {setup}, {date})", "(Post {post}, {units})"],
    "tool": ["(T{tool} {tool_name} D{tool_diameter})"],
    "toolChange": ["(Tool {tool}: {tool_name}, {rpm} rpm)"],
    "footer": ["M30"]
  }
}
```

| Field                | Meaning                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`         | Lower case id (`a-z`, digits, single hyphens) and a display name (`{post}`).                                                                                                                                    |
| `gCodes`, `mCodes`   | Every code the controller accepts (`G01` and `G1` are the same). The engine needs G0 to G3, G17, G90 and G21 or G20; it writes G4, G94, M0, M3, M4, M5 and M6 only when they are listed, and refuses otherwise. |
| `toolChange`         | `none` (one tool per file), `m0-pause` (`M0` and comments between tools) or `m6` (`M6 T<n>` at every tool change, including each file's first).                                                                 |
| `splitPerTool`       | Default for writing one file per tool.                                                                                                                                                                          |
| `cannedCycles`       | Whether the controller takes G81/G83 (it must then list G80, G81, G83 and G99). The IR's drill cycles are written as G81/G83 only when a post call sets `cannedCycles: true`; otherwise as G0/G1 moves.         |
| `fullCircles`        | `halves` (default and safe) writes an intended full circle as two half arcs; `single` writes one arc with equal start and end, which Grbl 1.1 accepts in IJK form.                                              |
| `comments`           | `parentheses`, the only style written.                                                                                                                                                                          |
| `maxLineLength`      | Longest line, 40 to 255 (80 for Grbl's line buffer). Comments wrap; a longer code line is refused.                                                                                                              |
| `programDelimiter`   | `%` lines around the program (LinuxCNC, Mach3).                                                                                                                                                                 |
| `dwellUnit`          | G4's P in `seconds` (Grbl, LinuxCNC) or `milliseconds`.                                                                                                                                                         |
| `decimals`           | Decimals for coordinates (X Y Z I J) and F per unit system, and for S and P. Coordinates need 2 to 6.                                                                                                           |
| `templates`          | `header` (top of every file), `tool` (once per tool in the file, after the header), `toolChange` (at each change, before `M0`/`M6`), `footer` (end of every file).                                              |
| `maxToolNumber`      | Optional: the largest tool number a `T` word may carry, 255 when absent (Grbl's `MAX_TOOL_NUMBER`; a larger T fails with error 38). A larger number is refused, in `M6 T<n>` and in a template's `T{tool}`.     |
| `toolLengthOffset`   | Optional: write `G43 H<n>` after every `M6 T<n>` (LinuxCNC, Mach3). Needs G43 and the `m6` style; `PostOptions.toolLengthOffset` overrides it.                                                                  |
| `pathBlending`       | Optional: write `G64 P<tolerance>` after the modes line, P the post tolerance in output units rounded down to 6 decimals (LinuxCNC; G64 without P blends with no bound). Needs G64.                             |
| `arcRadiusTolerance` | Optional `{ mm, inch }`, file units: the controller's own arc radius rule when stricter than Grbl's (Mach3: 0.002 mm, 0.0002 in). Arcs whose written radii differ by more than 0.8 of it become lines.          |

**Templates.** A template line is either a comment line, `(` text `)` with no other parentheses,
or a code line of words (`G90 G94`, `T{tool}`). `{name}` substitutes a variable from the fixed
list below; an unknown variable, a stray brace or non-ASCII text refuses the dialect when it is
loaded. There is no other syntax: no expressions, conditions or loops.

| Variable                                 | Kind   | Value                                                                  |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `tool`                                   | number | the tool number                                                        |
| `tool_name`                              | text   | the tool's name                                                        |
| `tool_diameter`                          | number | cutting diameter, output units (`ToolChange.diameter`)                 |
| `rpm`                                    | number | the tool's first spindle speed                                         |
| `feed`                                   | number | the tool's first `cut` feed (else its first feed), output units        |
| `job`, `setup`                           | text   | names from the `PostJob`                                               |
| `date`                                   | text   | the `PostJob`'s date text                                              |
| `origin`                                 | text   | where to zero X, Y and Z, the `PostJob`'s `origin` text                |
| `post`                                   | text   | the dialect's name                                                     |
| `units`                                  | text   | `mm` or `inch`                                                         |
| `units_code`                             | code   | `G21` or `G20`                                                         |
| `file_index`, `file_count`, `tool_count` | number | this file's number from 1, the number of files, the tools in this file |

Text variables may appear only in comment lines, so user text never reaches a code line; code
variables only in code lines. In a comment a missing value is written as `unknown`; in a code line
it refuses the job. The only number a code line may take is the tool number as `T{tool}` (other
number variables, `T{rpm}` included, are for comments), and a code variable must be
a word of its own, so no variable can build a G, M or P word. A code line may hold one code of
each modal group and one word of any other letter: `G21 G21`, `G20 G21`, `M0 M30` or two `T`
words fail in Grbl (errors 21 and 25), so the dialect is refused. Code lines may write settings only:
G17, G20, G21, G40, G49, G61, G80, G90, G91.1, G94, G54 to G59 in the header only (a work offset
changes what every remembered position means), G64 with exactly one literal P greater than 0 and
at most 0.1 (and at most the post tolerance in output units when written; LinuxCNC's G64 without
P blends with no tolerance), and M0, M1, M5, M8, M9, with M2 and M30 in the footer and `T` in
`toolChange`. In an inch file at 4 decimals the smallest P is 0.0001 in (0.00254 mm), above the
default 0.002 mm tolerance, so an inch file holds a G64 only with a tolerance of at least
0.00254 mm; Grbl has no G64 at all, and the `grbl` dialect never writes one.
Motion, distance mode, spindle start and M6 belong to the engine. After any template
code line the engine forgets its position and modes and starts the next move from the clearance
(a `G80` cancels the motion mode, for one).

### What the engine writes

- **Modes.** After the header and tool list, one line sets whichever of the units (G21 or G20),
  G90, G17 and G94 (when the dialect has it) the header did not. A header that sets the other
  units is refused.
- **Safe start.** Each file's first tool change (or first move), every move after an `M0`, an
  `M6` or a template code line, starts with `G0 Z<clearance>`, or straight to the next rapid's Z
  when that is higher, so a file never goes to the clearance and then climbs. Before each tool
  change and before the footer the tool also rises the same way when it is known to be below that
  height. The first rapid after either goes up before across when its
  target is above the clearance, and across before down when below, never diagonally down. A feed
  move before that first rapid is refused, since the tool is not where the IR left it. Any other
  rapid that comes down while it moves across, ending below the clearance, is refused: the IR
  must go across first and then down.
- **Modal state.** A G0 or G1 word is written only when the motion changes, an axis only when its
  written value changes, F only when the written feed changes. A move that changes no written word
  is dropped. G2/G3, X and Y are always written on an arc line, with I and J both written. After an
  `M0` or `M6` every word is written again.
- **Numbers.** Fixed notation, rounded to the dialect's decimals, trailing zeros dropped, never
  `-0` or an exponent, at most eight digits (Grbl's `read_float` drops further digits silently;
  such a value is refused). Under G20 lengths are divided by 25.4 and feeds are in in/min. An F or
  S that rounds to zero is refused.
- **Comments.** Parenthesised printable ASCII only: accents transliterated, `(` and `)` turned into
  `[` and `]`, and `?`, `!`, `~`, `;`, `%` and anything outside a small set dropped. Grbl acts on
  `?`, `!` and `~` anywhere in the stream, comments included. Long comments wrap. A line, first or
  continuation, that starts (case-insensitively) with `MSG`, `DEBUG`, `PRINT`, `LOG`, `PROBE`,
  `ABORT` or `PY`, or with a word followed by a comma, gets a leading `_`: LinuxCNC and Mach3 act
  on such comments (`(LOGOPEN,file)` opens a file on the controller, `(py,...)` runs Python).
- **Spindle and dwell.** `M3 S<rpm>` (M4 when counter-clockwise and listed), `M5`; any other
  spindle state is refused (the validator's `spindle-state`). A file that ends
  with the spindle running gets an `M5` before the footer. `G4 P<t>` in the dialect's unit; a zero
  dwell is dropped. With a `spindleDial` in the `PostJob` (the router's dial table from the
  machine profile, `{ setting, rpm }[]`), each spindle start is preceded by a comment naming the
  nearest setting: `(Router dial 3: 18250 rpm, nearest to 18000 rpm)`. On a router whose speed
  is set by hand, `S` changes nothing, so that comment is what the operator acts on. The table is
  checked (a non-empty list of objects with setting text and a finite positive rpm) and copied
  before anything is written. When the IR stops the spindle with the tool below the retract
  height, the tool rises to it before the `M5`.
- **Tool changes and files.** With `splitPerTool` each tool change after a file's first starts a
  new file (comments just before the change go with it); each file is complete (header, modes,
  footer). `none` with several tools in one file is refused. At an `M0` pause the operator's
  instructions come first: the next tool's dial setting (when there is a dial table) and a
  comment to turn the router off, change the bit, re-zero Z or keep the same stick-out, set the
  dial, turn the router on and resume. With `m6`, `M6 T<n>` at every change (the first included),
  then `G43 H<n>` when the dialect or call asks for a tool length offset.
- **Canned cycles.** With `cannedCycles: true` (and a dialect that has them) each IR drill cycle
  group becomes one line, `G99 G81 X Y Z R F` (straight) or `G99 G83 X Y Z R Q F` (peck), then
  `G80`; the moves inside the group are not written. G99 returns to R, where the IR's group ends.
  A cycle with a dwell stays moves (G82's P unit is not the same on every controller), as does a
  group the writer did not reach over its hole on the R plane. The controller pecks by Q from R,
  not from the cycle's `top`, and backs off its own distance between pecks, so its first peck is
  shorter by `retract - top`; the holes reach the same depth.

### Arcs

Every arc is checked as Grbl will see it, on the words as written: in the file's units, after
rounding, read with Grbl's `read_float` in single precision, converted to millimetres and moved by
a work offset (`grbl-arc.ts`). The machine's G54 offset is not known when the file is written, and
single precision error grows with the size of the machine coordinates, so the check runs at six
offsets (`GRBL_CHECK_OFFSETS`): zero and points across a 1.5 m travel on both signs. The engine
writes an arc as **lines** (G1) when:

| Rule                                                                                                                         | Constant                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| its rounded start and end coincide (not a full circle)                                                                       |                                                                     |
| its written chord is under ten output steps (0.01 mm at 3 decimals)                                                          | `MIN_ARC_CHORD_STEPS` = 10                                          |
| its radius is under ten output steps                                                                                         | `MIN_ARC_RADIUS_STEPS` = 10                                         |
| its sagitta is at most tol / 20 (0.0001 mm)                                                                                  | `LINE_SAGITTA_FRACTION` = 1/20, `DEFAULT_POST_TOLERANCE` = 0.002 mm |
| it fails Grbl's radius rule (error 33) at any offset                                                                         | 0.005 mm or 0.1% of r, never over 0.5 mm                            |
| its radii differ by more than 0.8 of that allowance in exact arithmetic                                                      | `RADIUS_MARGIN` = 0.8                                               |
| Grbl's angular travel (`mc_arc`, with its 5e-7 rad full-turn rule) is more than 0.5 rad off the intended sweep at any offset | `TRAVEL_TOLERANCE` = 0.5 rad                                        |

An arc written as lines is not one G1 by default: its sagitta is checked too, and it becomes as
many chords as keep every chord within the tolerance of the arc (at most a quarter turn each, at
most `MAX_ARC_SEGMENTS` = 10,000), Z interpolated along a helix. So a nearly full turn whose ends
round together, or a large arc that fails the check, is cut as the arc it is, never as a full
circle and never as a short cut across it. I and J are chosen among the roundings of the exact
centre offset (each down or up) to make the written start and end radii agree best. A full circle
is written as one arc only with `fullCircles: 'single'` and only when it passes the check;
otherwise as two halves, and halves that fail become lines like any arc. The check fails real
cases: a 5 mm circle written from (4.998, 0.137) at a work offset of -1499.873 mm gets a travel
on the wrong side of Grbl's 5e-7 rad threshold for every rounding of I and J, so Grbl would cut
almost nothing. Two halves never depend on that threshold, which is why they are the default.

LinuxCNC's radius rule is Grbl's (0.5 mm, or both 0.005 mm and 0.1% of the radius), so it needs
nothing more; Mach3's is 0.002 mm (0.0002 in), kept with the dialect's `arcRadiusTolerance`. Not
covered yet: coolant (the IR has no coolant entry).

### The GRBL post (`post/grbl.ts`)

The first post (T5.4b), for Grbl 1.1 on the Shapeoko: `GRBL_DIALECT` is dialect data only, and
`postGrbl(job, options)` is `postProcess` with it (`GRBL` is the record compiled once).

```ts
postGrbl(job: PostJob, options?: GrblOptions): CamResult<PostOutput>
// GrblOptions: PostOptions without toolChange and splitPerTool, plus multiTool: 'files' | 'pause'
postFileStem(job, file, fileCount): string // 'Sign - Top - 2 of 3 - #302 60 deg V-bit'
GCODE_FILE_EXTENSION // 'nc'
```

- **Each file**: a comment block (job, setup, date, post, units, file n of m, where to zero X, Y
  and Z from `PostJob.origin`, and the tool list), then `G21 G90 G17 G94` (`G20` with
  `units: 'inch'`), the tool's comment (number, name, rpm, cutting feed), `G0 Z<clearance>`, the
  router dial comment when the job has a dial table, `M3 S<rpm>`; at the end `M5` and `M30`.
- **No M6** (Grbl fails it with error 20) and **no T word**: Grbl only parses T, and refuses one
  above 255, while Carbide 3D's catalogue numbers go past it (#301, #302), so the tool number
  appears in comments only. A job with several tools is one file per tool by default
  (`multiTool: 'files'`), or one file with an `M0` and comments at each change
  (`multiTool: 'pause'`). Grbl 1.1 does not jog while held by an `M0`, so re-zeroing Z in the
  pause needs a sender that handles it; files per tool are the safe default.
- **Never written**: G64 (Grbl has none), canned cycles (`cannedCycles: false`), coolant, G10 or
  work offset changes; the machine's active work offset is used as set.
- **Lines** at most 79 characters: Grbl's `protocol.c` keeps `LINE_BUFFER_SIZE - 1` characters
  of a line and fails a longer one with error 11.
- **File names**: `postFileStem` gives the base name (`FALLBACK_FILE_STEM`, `job`, when the
  names are empty; a Windows device name such as `CON` or `lpt1`, before any dot and in any case,
  gets a leading `_`); the export UI (T5.4e) passes it through
  `@manufakture/io`'s `fileName(stem, GCODE_FILE_EXTENSION)` for the reserved character, control
  and length rules (`packages/cam` does not depend on `io`).

Golden files for the fixture jobs are in `test/grbl/` (see the tests below); after a deliberate
change, rewrite them with `UPDATE_GOLDENS=1` and review the diff line by line. The fixture jobs
(`post/golden-jobs.ts`, test data) are shared by every post, so the goldens of different dialects
can be compared file by file.

### The Carbide Motion, grblHAL, LinuxCNC and Mach3 posts

T5.4c's posts, each dialect data with golden files in `test/<id>/` for the same fixture jobs
(`post/goldens.test.ts` writes them, `test/goldens.test.ts` checks each with `verifyGcode` for its
dialect). `BUILTIN_DIALECTS` maps every built-in post's id to its compiled dialect.

```ts
postCarbideMotion(job, options?: CarbideMotionOptions) // PostOptions: units, tolerance, ...
postGrblHal(job, options?: GrblHalOptions) // + multiTool: 'files' | 'pause' | 'm6', toolLengthOffset, cannedCycles
postLinuxCnc(job, options?: LinuxCncOptions) // + cannedCycles
postMach3(job, options?: Mach3Options) // + cannedCycles
builtinDialect(id: string): CompiledDialect | undefined
```

|                        | `grbl`                                    | `carbide-motion`                         | `grblhal`                                       | `linuxcnc`                 | `mach3`                    |
| ---------------------- | ----------------------------------------- | ---------------------------------------- | ----------------------------------------------- | -------------------------- | -------------------------- |
| Tool change            | none: a file per tool, or `M0` per change | `M6 T<n>` at every change, one file      | as `grbl`; `M6 T<n>` with `multiTool: 'm6'` [1] | `M6 T<n>`, one file        | `M6 T<n>`, one file        |
| T limit                | no T written                              | 999 [3]                                  | 99999999                                        | 99999999                   | 255                        |
| Tool length offset     | none                                      | none (G43 ignored)                       | `G43 H<n>` only with `toolLengthOffset` [2]     | `G43 H<n>`                 | `G43 H<n>`                 |
| Canned cycles (option) | no: moves                                 | no: moves                                | G81, G83                                        | G81, G83                   | G81, G83                   |
| Path blending          | none                                      | none                                     | none (G64 off by default)                       | `G64 P<tolerance>`         | none (G64 has no P)        |
| Header codes           | `G21 G90 G17 G94`                         | `G21 G90 G17` (no G94 on Carbide's list) | `G21 G90 G17 G94`                               | `G91.1`, `G21 G90 G17 G94` | `G91.1`, `G21 G90 G17 G94` |
| `%` wrappers           | no                                        | no                                       | no                                              | yes                        | yes                        |
| Longest line           | 79                                        | 79                                       | 255                                             | 255                        | 255                        |
| Arc radius rule        | Grbl's                                    | Grbl's                                   | Grbl's                                          | Grbl's (the same)          | 0.002 mm, 0.0002 in        |
| Dwell `G4 P`           | seconds                                   | seconds                                  | seconds                                         | seconds                    | seconds [4]                |
| Tool comment           | `(Tool n: name)`                          | `(TOOL n: name)`, Carbide Create's       | `(Tool n: name)`                                | `(Tool n: name)`           | `(Tool n: name)`           |
| Work offsets           | as set                                    | as set; never G10 or G54 to G59          | as set                                          | as set                     | as set                     |

1. grblHAL's M6 depends on the board driver and its tool change configuration, and a manual
   change needs a sender that handles grblHAL's tool change protocol; so it is an option, and
   Grbl's tool changes are the default. The grblHAL Simulator's `grblHAL_validator` has no tool
   change handler and crashes on M6 (and on G83), so it checks only the other grblHAL goldens.
2. grblHAL refuses G43 (as opposed to G43.1) without a tool table, which a default build lacks.
3. Carbide Motion takes `M6` itself (Grbl would fail it); whether it forwards T to Grbl, which
   refuses T over 255, is not documented. Carbide Create writes `M6 T302` for Carbide's own
   V-bits, so the post allows Carbide's three-digit numbers; unverified until T5.7b.
4. Mach3 reads G4's P as seconds or milliseconds by its Config > Logic setting; seconds is the
   safe guess (a machine set to milliseconds dwells a thousandth as long, never a thousand times
   as long).

Sources, read 2026-10-02 and cited in each dialect file: Carbide 3D's
[supported G-codes](https://guides.carbide3d.com/faq/supported-gcodes/) (taken as a floor: the
work offsets are left out because Carbide Motion owns them), the
[Shapeoko CNC A to Z](https://shapeokoenthusiasts.gitbook.io/shapeoko-cnc-a-to-z/cad-cam-tools) on
M6 prompts, Carbide 3D's [BitSetter](https://carbide3d.com/blog/bitsetter-changes-carbide-motion/)
notes and the community thread on
[tool naming](https://community.carbide3d.com/t/tool-naming-on-m6/89851); the
[grblHAL core README](https://github.com/grblHAL/core) and its `gcode.c` at the commit CI's
Simulator builds; LinuxCNC's [overview](https://linuxcnc.org/docs/html/gcode/overview.html),
[G-codes](https://linuxcnc.org/docs/html/gcode/g-code.html) and
[M-codes](https://linuxcnc.org/docs/html/gcode/m-code.html); and ArtSoft's
[Using Mach3Mill](https://www.machsupport.com/wp-content/uploads/2013/02/Mach3Mill_1.84.pdf),
revision 1.84-A2, chapter 10. Carbide Motion's accepted set is documented only partly; T5.7b
confirms it on a machine.

### Verifying G-code (`test/verify-gcode.ts`)

A test utility (T5.4d), not part of the package's exports. `verifyGcode(text, { dialect, stock,
machine, tools })` reads a finished file with `gcode-toolpath` (cncjs, MIT, a development
dependency) and returns a report: issues by line and code, the extents of all moves and of the
feed moves (arcs by their true extremes, WCS mm), move counts and tool changes. It checks line
length, characters and comments, words against the dialect's lists, tool changes in the
dialect's style (or `toolChange`), no feed move with the spindle off or before a positive F,
Grbl's arc radius rule and travel on the written words, full circles where the dialect writes
halves, the machine travel (every point from `origin`, the WCS zero's place in the travel; or
the span per axis without one), the stock bottom minus `throughCutAllowance`, and feed moves at
or below the stock top inside the stock grown by the tool radius and `leadInAllowance`. `stock`
is a box in WCS coordinates; `machine` needs only `travel`, so a machine profile can be passed.
It models only the G codes the engine writes (G0 to G4, G17, G20, G21, G54, G90, G91.1, G94;
G43 H, which must name the tool the last M6 loaded, and G49; G61 and G64, whose P must be at
most `tolerance`; and the canned cycles G81 and G83 with G80, G98 and G99, which it expands into
the controller's own moves as LinuxCNC documents them and checks like any other move); any other
code the dialect accepts (G91, G92, G28, G53, G18, G93, ...) is an `unsupported` issue, and a
modelled code outside the dialect's list only a `word` issue. M2 and M30 stop the spindle. A
dialect's `arcRadiusTolerance` is checked as well as Grbl's rule. The `cam-gcode` vitest project
(`test/goldens.test.ts`) runs it on every golden file, one dialect per directory of `test/`; CI's optional `gcode-validate` job also
runs grbl-sim's `gvalidate` and the grblHAL Simulator's `grblHAL_validator` on them
(`test/firmware-validate.sh`).

## The CAM worker (`worker/`, `client.ts`, `cache/`)

The fifth worker context (T5.1g; ADR 0014 decision 7, ADR 0007's CAM worker amendment): toolpath
generation and the simulation run here, off the main thread and away from the kernel, so a slow
pocket never delays a regen or a sketch drag. Entries: `@manufakture/cam/worker` (the worker,
`worker/worker.ts`) and `@manufakture/cam/client` (`CamClient`).

```ts
import { spawnCamClient } from './cam/spawn'; // apps/web: holds the `new Worker(...)`
const cam = spawnCamClient(); // no worker yet: it starts on the first call
const reply = await cam.generate(setup, { keys }); // null when a newer request superseded it
if (reply?.status === 'done') {
  for (const op of reply.operations) {
    if (op.ok) preview(unpackToolpath(op.toolpath));
    else show(op.id, op.error); // errors are values
  }
}
```

**`CamWorkerApi`** (`worker/api.ts`) has coarse calls (ADR 0007 decision 3):

- **`generate({ generation, setup, only?, keys?, machine? })`**: one evaluated `Setup`, generating
  each of its operations (or those in `only`) in order. Each operation's result is
  `{ id, kind, key, cached, ms, ok: true, toolpath, warnings }` or `{ ..., ok: false, error }`.
  The reply is `done`, `cancelled` (superseded) or `failed` (a malformed request).
- **`simulate({ generation, toolpaths: [{ key, tool }], stock, cell })`**: the material-removal
  simulation (T5.3c) of cached toolpaths, returning a `Heightmap` (`origin`, `cell`, `nx`, `ny`,
  `heights`). Until a `Simulator` is passed to `createCamWorkerApi`, it fails with `no-simulator`;
  a key not in the cache fails with `missing-toolpath` and the keys. The simulator gets the
  cache's own toolpaths and must never mutate them or transfer their buffers; the `heights` it
  returns are transferred.
- **`stats(keys, { rapidRate })`**: `toolpathStats` and `toolpathBounds` of cached toolpaths, null
  for a key not in the cache.
- **`cancel(channel, generation?)`**, **`cacheInfo()`**, **`clearCache()`**.

**Generations and cancellation** (ADR 0007 decision 4). `generate` and `simulate` are two
channels, each with its own generations: a newer `generate` supersedes every older one still
running, but never a simulation, and the reverse. Generators and the simulator call
`await context.checkpoint()` between passes, rings or raster lines; it yields to the event loop
once the time slice (8 ms) is used up, so a newer request arriving meanwhile is seen, and throws
`CamCancelled` when the request is stale, which the worker turns into `cancelled`. A single long
call that never checkpoints cannot be cancelled midway. `CamClient` numbers requests, drops stale
replies (resolving to null; UI code must not assume one reply per request) and settles calls in
flight with null on `terminate`.

**Operations plug in through a registry** (`worker/registry.ts`). An `OperationGenerator` takes the
evaluated operation and an `OperationContext` (`setup`, `machine`, `generation`, `cancelled`,
`checkpoint()`) and returns a `CamResult<{ toolpath, warnings? }>`, synchronously or not. The
worker entry serves `defaultOperations`, on which `registerBuiltinOperations` (`worker/builtin.ts`)
registers the operations this package ships: each operation task (T5.2b on) adds its line there.
A kind with no generator gets a `no-generator` error value. Only what the key holds may shape a
generator's output: it must not read its sibling operations, its operation's `name`, or the
setup's `name` or `post`; one that needs any of them adds it to `toolpathKey` and bumps
`CAM_IMPLEMENTATION_VERSION` in the same change.

**Errors are values.** An expected failure is the generator's `{ ok: false, error }`. A generator
that throws is a bug, reported as `internal` with the message and stack; one that returns a
toolpath the IR validator refuses is `invalid-toolpath` with the issues. The validator's `no-tool`
and `spindle-off` are not checked on an operation's own toolpath, since linking (T5.2g) puts the
tool change and spindle start in front of it.

**Transferred buffers** (ADR 0007 decision 6). Toolpaths travel packed (`worker/pack.ts`): per
entry a kind byte, six `Float64Array` values (`to`, the arc `center`, the feed) and three
`Int32Array` values (the `op` index into a string table, the `pass`, and flags for the feed class,
direction and `fullCircle`); tool changes, spindle, dwells and comments go beside them as plain
objects. `unpackToolpath` gives back the exact IR. The reply's buffers are transferred; the cached
copy keeps its own. Heightmaps transfer their `heights`. With `transferMeshes: true`,
`CamClient.generate` also transfers `surface3d` meshes into the worker (the caller's arrays are
detached afterwards).

**The toolpath cache** (ADR 0014 decision 9; `cache/`). An in-memory LRU (`LruCache`) in the
worker, bounded to 512 entries or 256 MiB of packed toolpaths (`createToolpathCache`). Keys are
`toolpathKey({ operation, setup, machine? })`: a 128-bit hash of the evaluated operation (its
tool, feeds and geometry included; not its `name`), the setup without its operation list, `name`
and `post`, the machine row, and
`CAM_IMPLEMENTATION_VERSION`, `POLYGON_LIBRARY` and, for `surface3d` only, `DROP_CUTTER`. The app
computes the keys (to mark operations stale, ADR 0014 decision 8) and sends them as `keys`; the
worker computes any missing one itself. A hit never reaches the generator. Toolpaths and expected
failures are cached; bugs and `no-generator` are not, nor anything a generator returns once its
request is stale (one that caught `CamCancelled` may return an error or a partial toolpath). Operations that finished before their
request was superseded stay cached. Any entry may be evicted at any time; a miss only means
regenerating. Typed arrays are hashed from their bytes. Bump `CAM_IMPLEMENTATION_VERSION` with any
change that can alter a toolpath.

Not yet: progress reports for long 3D finishes (T5.5a), an OPFS tier for the cache. Linking
(T5.2g) runs on the worker's results: `jobOperations` and `assembleJob` (see
[Linking and job assembly](#linking-and-job-assembly-jobts)).

## The profile operation (`ops/profile.ts`)

`generateProfile(input, context)` (T5.2b), registered as the `profile` generator, cuts along or
around closed loops: the plywood sign's outer cut. It reads its `ProfileInput`, the setup's
`heights` and nothing else.

**Extra fields** (`ProfileExtras`, all optional, until `ProfileInput` and the core schema take
them over): `finishPass` (default: true when `finishAllowance` is above zero), `finishStepdown`
(default: the whole depth in one step when within the tool's flute length, else `stepdown`),
`tabSpacing` (mm along each loop; replaces `tabs.count`; needs `tabs` for the width and height,
else a `tab-spacing-unused` warning) and `tabMinInsideSize` (default 25 mm).

**The tool centre path** is `offsetLoops(loops, +r)` for `outside`, `offsetLoops(loops, -r)` for
`inside` (r the tool radius, plus `finishAllowance` for the roughing passes), and the loops
themselves for `on` (which ignores the allowance, with an `allowance-ignored` warning). Lines stay
lines and arcs stay arcs. `loops` follow the `Loop2` convention, so holes of an outside profile
are cut on their scrap side too, and islands of an inside profile are left standing.

**Direction.** The spindle is assumed to turn clockwise (M3). Climb milling keeps the wall being
cut on the right of travel, conventional on the left: an outside (or on) cut runs clockwise around
an outer loop when climbing, an inside cut counter-clockwise.

**Passes.** Each cut loop starts half-way along its longest segment. Depth levels go from `top`
to `bottom` in equal steps of at most `stepdown` (finishing: `finishStepdown`), the last exactly at
`bottom`; `bottom` may lie below the stock for a through cut. `levels(top, bottom, step)` (shared by
profile, pocket and facing) refuses, as the operation's `invalid-input` error, a step that is not
a finite number above zero and a cut that would need more than `MAX_DEPTH_LEVELS` (1000) levels:
a stepdown typed far too small never runs the generator out of memory, and is never clamped to a
deeper cut than asked. Order: loop by loop, smallest
first, each roughed at every level and then finished, so every loop is complete before any loop
enclosing it is cut (an enclosed loop is always the smaller), and inner cuts finish while the part
is still held. A roughing loop belongs to the finishing loop nearest its start. A finishing loop
gets its own `finishStepdown` levels only where the roughing cut so far cleared along all of it:
every point of it, sampled every 0.5 mm, within 1.5 allowances of a roughing path (the slack
covers the sharp vertices at concave corners up to 90 degrees). Where the roughing offset pinched
off at a neck or merged across a gap narrower than the allowance, or the allowance closed the loop
altogether, the finishing loop is cut in `stepdown` levels instead (`finish-steps-down` when it
had roughing loops), so no finishing move ever runs deeper than one step into stock nothing has
cut. Each loop at each level is one
IR `pass`, numbered from 0. Between levels of one
loop the tool goes straight on down when it is already at the entry point; otherwise it rapids to
`retract` (at least 0.5 mm above `top`), across, and down to 0.5 mm (`PROFILE_SAFE_ABOVE`) above
the depth already cut there, and feeds from there. The program starts at `clearance` above the
first entry and ends with a rapid to `clearance`. `context.checkpoint()` runs before every pass.

**Entries.** `plunge` feeds straight down. `ramp` descends along the path itself at the given angle
(over several laps of a short loop) and then cuts one full lap at depth, so the ramp's wedge is
cleaned up; a ramp starts on the path, so it uses no lead-in (`lead-in-ignored`). `helix` turns
about a centre `radius` from the entry point on the scrap side, as `fullCircle` arcs of at most the
angle's drop per turn, turning the way that leaves it tangent to the cut; when the helix would cut
into the part (or, for a finishing pass, leave the roughed slot), the pass plunges instead
(`helix-fallback`).

**Leads.** An `arc` lead is a quarter turn of the given radius on the scrap side, tangent to the
path where it joins it; a `line` lead runs square to the wall from the scrap side. Every lead and
helix is checked against the part: the tool centre must stay on the scrap side, at least the cut's
own offset from every loop of the operation. A lead that fails is left out (`lead-collision`).
Leads of an `on` profile are not checked against the part, since the cut itself runs on the
outline. A finishing pass runs below the stock's top only where the roughing cleared to full
depth: its leads (and helix) must keep the tool centre within the roughing offset (tool radius
plus allowance) of the part, so the tool never meets uncut stock. Leads that leave that band are
left out (`finish-lead-dropped`), and the finishing pass then feeds straight down on its own path
from just above the stock. Lead-in and lead-out are fed with the `lead` feed.

**Tabs** are left at `bottom + height` in the passes below that height: the tool rises straight up
at a tab, runs over it, and drops back to depth. The lifted stretch is `width` plus the tool
diameter long, measured along the tool centre path, so a tab on a straight wall is `width` wide.
`count` tabs per loop (or one per `tabSpacing`) are spread evenly by length, then each moves to
the nearest spot clear of corners (sharp junctions and round joins about a source vertex), of
arcs shorter than the tab and of the loop's start, with `PROFILE_TAB_MARGIN` (0.5 mm) to spare.
Tabs are placed on the loops that cut the final wall and carried to the roughing loops by
position. Loops around scrap (inside cuts, holes of an outside profile) whose tool centre path
has a bounding box narrower than `tabMinInsideSize` get none (`tabs-skipped`); tabs with no room are dropped (`tabs-dropped`). A
finishing tab that cannot be carried to its roughing loop (it would cross that loop's start) is
also reported as `tabs-dropped`, saying plainly that the roughing cuts through there and the part
is held at that spot only by a sliver as thin as the allowance. Tabs as high as the cut is deep
make nothing (`tabs-unused`).

**Errors and warnings.** Bad numbers, no loops, open loops and a tool that fits nowhere are
`invalid-input` errors. Warnings: `depth-exceeds-flutes`, `loop-too-small` (an inside loop, or a
hole of an outside profile, the tool does not fit into, so it is not cut), and those above.

## The pocket operation (`ops/pocket.ts`)

`generatePocket(input, context)` (T5.2c), registered as the `pocket` generator, clears an area to
a depth and leaves islands standing: the sign's recessed border. It reads its `PocketInput`, the
setup's `heights` and nothing else. `loops` follow the `Loop2` convention: outer loops
counter-clockwise, islands clockwise. A counter-clockwise loop inside another one is united with
the pocket and cut, not left standing (`island-orientation` warning). Adaptive clearing is not in
M5.

**Extra fields** (`PocketExtras`, all optional): `finishPass` (default: true when
`finishAllowance` is above zero), `finishStepdown` (default: the whole depth in one step when
within the flute length, else `stepdown`), `floorAllowance` (default 0) and `floorPass` (default:
true when there is a floor allowance).

**Geometry** (`pocketGeometry(loops, options)`, pure, reused by V-carve and 3D roughing): rings are
`offsetLoops(loops, -(r + a + k * s))` for k = 0, 1, ... until the offset vanishes (r the tool
radius, a the wall allowance, s the stepover in mm), so arcs stay arcs. The regions of each offset
form a tree: a region splits where the pocket narrows. Every point at least `r + a` inside lies
within one stepover of the nearest ring outside it, so a stepover up to the tool radius leaves
nothing; above that, cusps can stay between rings at corners. The geometry measures them (what the
first ring can reach minus what the rings sweep, computed with Clipper) and adds clean-up spots,
points the tool centre visits after the ring outside them, until nothing is left (three rounds;
anything still left is a `stepover-cusps` warning). It also computes the areas no move reaches:
the pocket (less the allowance, when there is no finishing pass) minus everything within the tool
radius of a tool centre `r` (or `r + a`) inside. Each such area of at least
`POCKET_UNREACHABLE_MIN_AREA_FACTOR` (0.25) times r squared is an `unreachable` warning with its
area and a point inside it; smaller ones are the square corners every round tool leaves (about
0.215 r squared each).

**Clearing order.** One IR `pass` per depth level, from `top` in equal steps of at most
`stepdown` down to `bottom + floorAllowance`, then a floor pass at `bottom`. In each level the tree
is cut from the inside out along its largest branch: the entry is in the middle of the largest
piece, and each ring is cut once, in the climb direction for an M3 spindle (outer rings
counter-clockwise; `climb: false` reverses them). The smaller branches at a split (corner blobs,
the far side of a neck) are surrounded by cut rings by then and are cut from the outside in. Each
ring starts at its point nearest the tool. A ring is reached at depth when the straight link keeps
the tool centre `r + a` clear of every wall and island (an exact segment distance, not samples,
less `CLEARANCE_TOLERANCE`, 0.005 mm, of slack for the refit of the offset rings) and within one
stepover of the rings already cut (checked every quarter stepover, so the tool never takes more
than a stepover); failing that, by running on along the ring just cut (cleared
already) to its point nearest the next ring, possibly by way of one other ring cut in the level;
failing that, by a retract and a plunge where the ring passes within the tool radius of what is
cut; and only then by a retract and a new entry. Rapids go up to `retract` (at least
`POCKET_SAFE_ABOVE`, 0.5 mm, above `top`), across, and down to 0.5 mm above the floor the levels
before left under the whole tool there (the top on the first level); everything below that is fed,
even where part of the tool is over material this level has already cleared.
`context.checkpoint()` runs before every level and every ring.

**Entry.** `helix` turns about the most inside point of the innermost region, with the requested
radius or the room there is (the whole helix keeps the tool centre `r + a` from every wall and
island), as `fullCircle` arcs dropping at most the angle's slope per turn, then one level turn
that flattens the helix floor. When less than `POCKET_MIN_HELIX_FACTOR` (0.2) times the tool
radius fits, it ramps along the innermost ring instead (`helix-fallback`). `ramp` descends along
the ring at the angle (over several laps of a short ring) and then cuts one full lap at depth; a
ring shorter than the tool diameter is plunged instead (`entry-plunge`). `plunge` feeds straight
down. Every level after the first starts its entry just above the floor of the level before.

**Finishing.** With a finishing pass, each wall loop (`offsetLoops(loops, -r)`, islands
included) is cut in `finishStepdown` levels, starting at its point nearest the tool: a plunge in
the cleared pocket `a` inside the wall, a lead (fed at the `lead` feed) square onto the wall, one
lap, and a lead back. Where that lead would come too close to the wall (a sharp vertex), it starts
half-way along a segment instead, longest first; when no start has room it plunges at the wall,
through the allowance (`finish-plunge-at-wall`), and its rapids then stop above the top, not the
clearing's floor, since the allowance there is uncut. A wall loop the clearing did not run
alongside (a neck narrower than the tool plus twice the allowance) is cut in `stepdown` levels
from the top instead (`finish-steps-down`).

**Layers.** `generatePocketLayers(op, layers, context)` clears z-level layers with their own
loops (3D roughing's slices), with the same rings, entries and links; an entry starts above the
layer before where that layer cleared it, else at `top`. It makes no floor or finishing pass and
reports no unreachable areas.

**Errors and warnings.** Bad numbers (a stepover outside (0, 1], a floor allowance as deep as the
pocket), no loops and a tool that fits nowhere are `invalid-input` errors. Warnings:
`depth-exceeds-flutes`, and those above.

## The facing operation (`ops/facing.ts`)

`generateFacing(input, context)` (T5.2d), registered as the `facing` generator, flattens the top
of the stock and brings it to a set thickness. It reads its `FacingInput`, the setup's `heights`
and nothing else. `loops` is the area to face, usually the stock outline (a rectangle in M5), and
follows the `Loop2` convention.

**Extra fields** (`FacingExtras`, all optional): `margin` (mm, zero or more; default the tool
radius, so the tool's edge just clears the stock's edge at the end of every line) and `pattern`
(`zigzag`, the default, or `oneway`).

**The raster** (`facingRaster(loops, options)`, pure): the area the tool centre covers is
`offsetLoops(loops, margin)`. Straight lines along `angle` (radians from machine +X) cross it,
evenly spaced at most one stepover (`stepover` times the diameter) apart. The outermost lines sit
the tool radius less the stepover inside the loops' extent across the raster, so the tool
overlaps each edge by the stepover (or just inside the grown area, when the margin is smaller);
loops no wider than the tool get one line through the middle. Each line is cut exactly into its
stretches inside the grown area (its meetings with every line and arc, kept where the middle of a
stretch is inside), so a non-convex area gives several stretches on one line. With a margin of at
least the tool radius, every point of the loops lies within the tool radius of a stretch: the
spacing is at most the diameter, and the disc of the tool radius about any point of the loops
lies inside the grown area.

**Passes.** One IR `pass` per depth level, from `top` in equal steps of at most `stepdown` down to
`bottom`, the last exactly at `bottom` (`depth.top` is the stock top, as the geometry stage
gives it). Each level runs every line; the next level runs them in the opposite order, so it
starts where the tool already is. `zigzag` cuts each line the other way to the one before and
steps over to the next line as a `cut` feed move at depth, when the straight step stays inside the
grown area (always, for a convex one); between levels it feeds straight down where it stopped.
`oneway` cuts every line along the raster direction. Whenever the tool cannot step over at depth
(every line of a one-way raster, a stretch beyond a gap, a step that would leave the area) it
rapids up to `retract` (at least `FACING_SAFE_ABOVE`, 0.5 mm, above `top`), across, and down to
0.5 mm above the floor the level before left there (the top on the first level), then plunges at
the `plunge` feed. Nothing rapids through material. The program starts at `clearance` above the
first line's start and ends with a rapid to `clearance`. `context.checkpoint()` runs before every
level and every line.

**Errors and warnings.** Bad numbers (a stepover outside (0, 1], a negative margin, a non-finite
angle, an unknown pattern), no loops, open loops and an empty area are `invalid-input` errors.
Warnings: `depth-exceeds-flutes`, and `margin-small` when the margin is less than the tool radius
(the edges may not be faced cleanly, and at an angle the corners may be missed).

## The drill operation (`ops/drill.ts`)

`generateDrill(input, context)` (T5.2e), registered as the `drill` generator, makes the holes the
model knows about: hole features, and the round hole walls of the body that the geometry stage
finds (regen README, "CAM geometry"), each as a `MachineDrillPoint`. It reads its `DrillInput`, the
setup's `heights`, stock and WCS (for the stock top's machine Z) and nothing else.

**Extra fields** (`DrillExtras`, all optional): `breakthrough` (mm, default
`DRILL_BREAKTHROUGH_MARGIN`, 0.5), `matchTolerance` (mm, default `DRILL_MATCH_TOLERANCE`, 0.05),
`helixAngle` (default `DRILL_HELIX_ANGLE`, 3 degrees) and `boreStepover` (fraction of the tool
diameter, default `DRILL_BORE_STEPOVER`, 0.5).

**Which holes how.** Points at the same place with the same diameter are merged, cautiously: the
deepest bottom, the highest top, the highest cavity floor under the exit and the steepest mouth. When
one of them already goes below the cavity floor the other found, the merged hole cuts into that
floor with no breakthrough, and a `merged-below-floor` warning says so. A hole smaller than the tool by more than `DRILL_UNDERSIZE_TOLERANCE` (0.01 mm, the
rounding of inch sizes) is an `invalid-input` error naming every such hole. A hole up to
`matchTolerance` larger than the tool is **drilled** (any tool but a V-bit or engraver), and so is
one less than twice `DRILL_MIN_BORE_RADIUS` (0.025 mm) larger whatever the tolerance, since a
smaller helix cuts nothing and fails the arc checks. A larger
hole is **bored** with a flat, ball or bull end mill; a drill smaller than the hole is an error
("bore it with an end mill").

**Heights.** Material may start at the stock top (machine Z 0 with the origin on top, the stock
height with it on the bottom), or a hole's own top when that is higher. The retract height is the
setup's, raised to at least `DRILL_SAFE_ABOVE` (0.5 mm) above that; the clearance at least the
retract. The toolpath starts at the clearance over the first hole, crosses between holes at the
retract height, and ends at the clearance. **No rapid goes below the stock top except straight
down inside the hole just cut.** That matters for a counterbored hole, whose point starts at the
counterbore's floor: when the drill runs before the counterbore's pocket, the material above that
floor is still there, so drilling feeds from the retract height, never rapids to the point's top.

**Through holes.** A through hole's depth stops exactly at the body's bottom, and a pointed tool
leaves a cone there, so the tool goes deeper by its tip length (`toolTipLength`: a drill's point,
`r / tan(angle / 2)` with `DRILL_DEFAULT_POINT_ANGLE`, 118 degrees, when the tool has no angle; a
ball's radius; a bull nose's corner radius; nothing for a flat end mill) plus `breakthrough`. That
goes into the spoilboard. A through hole whose exit opens into a cavity (`clearBelow`, the clear
height under the exit, from the geometry stage) goes at most to `DRILL_CAVITY_CLEARANCE` (0.2 mm)
above the cavity's floor, with a `breakthrough-capped` warning when that is less than the full
breakthrough (a pointed tool then leaves the exit undersize). A blind hole stops at its bottom.
A drill (not a bore) entering a mouth tilted more than `DRILL_SLOPED_ENTRY` (20 degrees,
`entryTilt`) gets a `sloped-entry` warning: spot it or mill it flat first.

**Drilling** (one `cycle` group per hole, see [Other entries](#other-entries)): over the hole at the
retract height, a `plunge` feed to the bottom, an optional dwell (`dwell` seconds, when above zero,
tagged with the last peck's pass), and a rapid back to the retract height. With a `peck`, the pecks
reach `top - peck`, `top - 2 peck`, ... and then the bottom (`top` the start of material above);
after each peck but the last the tool rapids up to the **retract height**, then rapids down to
`DRILL_PECK_CLEARANCE` (0.5 mm) above the depth reached and feeds on. A peck as deep as the hole is
one straight feed, and the marker then has no `peck`.

**Boring.** The tool centre runs on helices about the hole's centre, counter-clockwise (climb on
the wall with an M3 spindle), as `fullCircle` `ramp` arcs from the start of material down to the
bottom, each turn dropping the same amount and at most `2 pi (rh + r) tan(helixAngle)` (the slope
at the hole wall, where the tool edge cuts), then one level `cut` turn at the bottom. The outer
helix radius is `(D - d) / 2`, so its outer diameter is the hole's exactly, and its level turn is
the finishing circle. A hole wider than about twice the tool is bored in rings from the inside out:
the first at most 0.9 tool radii (so no core is left standing, and no slug comes loose in a through
hole), then outward in equal steps of at most `boreStepover` tool diameters, each ring its own
helix from the top. Between rings the tool rapids straight up inside the bore to 0.5 mm above the
stock top and across. After the last ring it moves to the centre and rapids up. Bores have no
cycle markers. The tool's sloped helix floor is flattened by the level turn; a ball or bull end
mill leaves its own profile on a blind hole's floor.

**Order and passes.** Holes in nearest-neighbour order from the WCS origin (`nearestNeighbourOrder`;
linking, T5.2g, reorders the drilled holes from where the tool really is). Each peck and each bore ring is one `pass`, counted
across the operation. `context.checkpoint()` runs before every hole.

**Counterbores.** M5 drills a counterbored hole's through hole only, from the counterbore's floor
down; the counterbore itself is left to a pocket on its floor face. The geometry stage likewise
gives a counterbore's narrow wall and not its wide one. Countersinks are not cut (a V-bit cannot
drill here); chamfer them by hand or with a V-carve.

**Errors and warnings.** Bad numbers (a peck or helix angle not above zero, a negative dwell or
breakthrough, a bore stepover outside (0, 1], a hole whose bottom is not below its top), no holes,
and the tool cases above are `invalid-input` errors. Warnings: `depth-exceeds-flutes` when the
deepest hole goes further below the start of material than the flutes are long,
`breakthrough-capped`, `sloped-entry` and `merged-below-floor` (above).

## The V-carve operation (`ops/vcarve.ts`)

`generateVCarve(input, context)` (T5.2f), registered as the `vcarve` generator, carves sign
lettering with a V-bit (or an engraver): the depth follows the width of the shape. It reads its
`VCarveInput`, the setup's `heights`, stock and WCS (for the stock top's machine Z) and nothing
else. `loops` follow the `Loop2` convention (outer loops counter-clockwise, counters clockwise);
`top` is the machine Z of the face carved into, which may lie below the stock top.

**Extra fields** (`VCarveExtras`, all optional): `stepdown` (mm; default one level),
`flatStepover` (mm, the spacing of the V-bit's rings on a flat floor; default rings close enough
to leave ridges no higher than `VCARVE_FLAT_RIDGE`, 0.2 mm) and `clearing` (an end mill for the
flat floor, below).

**The surface.** With half angle `a` and tip radius `rt`, the carved surface lies `d / tan(a)`
below `top` at a point `d` inside the outline, down to the maximum depth `D`: `maxDepth`, or what
the bit reaches when it has none (its full diameter, `(diameter / 2 - rt) / tan(a)`, or its flute
length, whichever is less; a deeper `maxDepth` is capped with a `max-depth-limited` warning). A
bit whose tip stands on the shape's centre line (its medial axis) at depth `(f - rt) / tan(a)`,
with `f` the distance to the outline there, touches the outline with its rim at the top, and its
outer flank lies exactly on that surface out to the outline. So one pass along the centre line
carves the whole shape, corners included: a slot of width `w` is carved to `w / 2` with a 90
degree bit, and a rectangle's centre line runs out along the bisectors to each corner at depth 0.

**Finding the centre line, without a Voronoi library.** The outline is inset in steps of about
`VCARVE_INSET_STEP` (0.5 mm, at most `VCARVE_MAX_LEVELS` insets; more is a `levels-capped`
warning) from `rt` to `rt + D tan(a)`. Each inset is sampled every `VCARVE_SAMPLE` (0.25 mm), with
a fan of normals at reflex corners. From each sample the tool steps inward along the normal: where
the distance to the outline keeps growing as fast as the step for the whole way to the next inset
(and 0.02 mm past it, since the offset drops the zero-width sliver a ridge exactly there would
leave), nothing collapses there. Where it stops growing, a bisection (16 steps) finds the ridge and
a golden section search (one distance per step, to 1e-6 mm) its highest point: a centre-line
point, cut at the depth of its exact distance. The distance is unsigned, so near a very sharp
tip a normal can cross the outline within the ridge tolerance and keep "growing" outside; a point
found outside the shape is no centre-line point, and the sample falls back to the tool standing
on the inset itself (which touches the outline and no more).
Inset corners that turn by less than 8 degrees count as smooth (a flattened curve), which leaves
an error below 0.003 times the distance to the outline there. Samples are added between neighbours until the
centre-line points between them lie within 0.01 mm of the chord, or where one collapses and the
other does not. Every chord of the result is checked exactly against the outline (the distance is 1-Lipschitz, so a stretch is subdivided only while its midpoint lacks
room for half its length): the cone may reach at most `VCARVE_TOLERANCE` (0.005 mm) past the
surface, and a chord that would go further splits the line. The lines are simplified within
0.002 mm. Distances use a bucket grid over the outline's segments (`OutlineDistance`: cells
about two segments long, each arc bucketed by its own box rather than its circle's, lines in flat
arrays compared by squared distance), which agrees with the exact distance; its `inside(p)` is
an even-odd test over the outline flattened to 0.1 micrometre, looking only at the edges in the
query's grid row. The stepped insets in the plan carve every ring between them; that
is not needed, since each ring's outer flank lies on the surface that the centre line already
cuts, so this version cuts only the centre line and the full-depth rings below. No dependency
was added. The npm Voronoi packages (`d3-delaunay`, `voronoi`) take point sites only; segment
Voronoi diagrams exist as JSPoly (a JavaScript translation of Boost.Polygon, BSL-1.0, which ADR
0006 allows) and OpenVoronoi (C++, LGPL-2.1, so only as a separate `.wasm` we would build), but
both take straight segments, not arcs, so letters with arcs would be flattened first, and the
diagram still needs the same pruning, depth and link checks as the insets do.

**The flat floor.** Where the shape is wider than `2 (rt + D tan(a))`, the carve stops at `D`:
the bit cuts the inset at `rt + D tan(a)` at that depth (its outer flank finishes the slope), then
clears the floor inside with insets `flatStepover` apart at `D`, whose own collapses get the same
centre-line pass. At most `VCARVE_MAX_FLAT_RINGS` (400) rings; more makes them coarser
(`flat-stepover-coarsened`). A `flat-floor` warning gives the floor's area and ridge height, and
`tool-depth-limit` says when the floor comes from the bit's size, not `maxDepth`.

**Clearing the floor with an end mill.** With `clearing` (`tool`, a `flat` or `bull` end mill;
`feeds`; `stepdown`; `stepover`, a fraction of its diameter; `entry`, default a 3 degree helix of
half its radius), `generateVCarveClearing(input, context)` makes the end mill's toolpath of its
own: a pocket (`generatePocket`) of the floor, the shape inset by `D tan(a)`, where the bit's
flanks meet the floor, from the stock top (or `top`, when higher) down to `D`. Run it before the
V-carve; job assembly or the UI places it, as its own tool group. The V-bit's floor rings then go
only `diameter / 2` of the end mill past the full-depth inset: every floor point the end mill
cannot reach lies that close to the floor's edge. The pocket's `unreachable` warnings are dropped
(the V-bit cuts those corners). No floor (`no-floor`) or an end mill that fits nowhere on it
(`clearing-tool-does-not-fit`) gives an empty toolpath with a warning.

**Moves.** One IR `pass` per depth level: `stepdown` levels down to the deepest point the carve
has (each centre line cut only where it is deeper than the level before, clamped to the level),
or one level. In each level the pieces (centre lines, rings) are cut nearest first, open lines
from their nearer end, closed ones (without repeating their closing point) and rings from their
point nearest the tool; rings run in their natural direction (climb with an M3 spindle). The
nearest-first search skips every piece whose bounding box is no nearer than the best so far. A
piece is reached by a straight `cut` move when it is at most one tool diameter away, the move
keeps the cone inside the surface (the same exact check), stays at least `VCARVE_LINK_MARGIN`
(0.05 mm) from the outline all the way and runs inside the shape (`vcarveLinkAllowed` answers
this for a given move). The margin matters at the top: centre lines end in corners at depth 0,
where a sharp bit's cone has no reach, so the surface check alone would pass a move across the
face between two letters and score it. Otherwise up to `retract`, across, down by rapid to `VCARVE_SAFE_ABOVE` (0.5
mm) above the stock top or `top`, whichever is higher, and a `plunge` feed from there. So no rapid
ever goes below the stock top, even when `top` is below it. The retract height is the setup's,
raised to that approach height; the clearance at least the retract. It starts at the clearance
over the first piece and ends at the clearance. `context.checkpoint()` runs before every inset,
floor ring and piece cut.

**`top` below the stock top.** The carve assumes the material above `top` over the shape is
already gone: it cuts from `top` down and plunges from above the stock top, but does not clear
what lies between. When `top` is below the stock top and that material has not been removed (by
an earlier facing or pocket), ordering the operations so that it is, is the user's job.

**Performance.** Measured on one desktop core (Node 26), 60 degree bit, "O"s of 400 vertices
(two 200-gon ellipses each), from `generateVCarve` called to its result; before and after the
review fixes:

| Sign                      | Before | After |
| ------------------------- | ------ | ----- |
| 1 letter, no `maxDepth`   | 2.2 s  | 0.1 s |
| 4 letters, no `maxDepth`  | 11.0 s | 0.4 s |
| 20 letters, no `maxDepth` | 57 s   | 2.0 s |
| 4 letters, `maxDepth` 2   | 7.9 s  | 0.3 s |
| 20 letters, `maxDepth` 2  | 90 s   | 1.7 s |

The time was in the distance queries (arcs were bucketed by their whole circle, so every cell
held dozens of them; the ridge search took about 105 distances per collapsed sample, now about 45) and in choosing the next
piece (every ring's cut path was rebuilt and searched for every pick, quadratic in the rings).
Both are now near linear in the letters. A test carves the 20-letter sign with and without
`maxDepth` under a generous 30 s bound.

**Errors and warnings.** A tool that is not a `vbit` or `engraver`, an angle outside (0, 180)
degrees, a tip at least as wide as the tool, a `maxDepth`, `stepdown` or `flatStepover` not above
zero, no loops, a shape too small to carve and a clearing tool that is not a flat or bull end mill
are `invalid-input` errors. Warnings: `too-narrow` (area narrower than a flat tip, left uncut) and
those above.

## The 3D surfacing operation (`ops/surface3d.ts`)

`generateSurface3d(input, context)` (T5.5a), registered as the `surface3d` generator, machines a
curved part from its mesh (`input.mesh`, machine coordinates, as the CAM geometry stage's mesh at
the CAM tolerance turned into the setup's WCS). It reads its `Surface3dInput`, the setup's stock,
WCS and heights. Following the T5.0b spike and ADR 0014 decision 13 it runs on our own TypeScript
drop-cutter, with no OpenCAMLib and no new dependency. Two strategies:

- **`parallel`** (finishing, the default): raster lines a stepover apart within a boundary, the
  tool dropped onto the mesh along each line;
- **`zlevel`** (roughing): the part sliced at falling heights, each slice cleared by the pocket
  operation's layer clearing (`generatePocketLayers`), leaving the stock to leave.

**Waterline (constant-Z) finishing is not implemented** (out of M5's scope, T5.0b): a follow-up
decides between a TypeScript waterline (push-cutter fibres along X and Y plus a loop weave, on the
same cutter geometry) and OpenCAMLib with the ADR 0006 amendment drafted in the spike. Steep walls
are therefore finished only as well as a raster finishes them; the scallop on a slope is larger
than on a flat (the stepover is measured in XY).

**Fields.** From the core schema: `stepover` (mm between raster lines; at most the tool diameter),
`angle` (raster direction, radians from machine +X) and `allowance` (stock to leave, mm, zero or
more). The rest are `Surface3dExtras` (all optional, not in the core schema yet; they need a format
bump when the UI (T5.5b) adds them): `strategy` (`parallel` or `zlevel`), `boundary` (loops the
tool centre stays inside, machine XY; default the mesh's XY bounding box for `parallel`, the stock
outline grown by half the tool diameter for `zlevel`), `tolerance` (default
`SURFACE3D_TOLERANCE`, 0.01 mm), `sampling` (drop points along a line, default a quarter of the
tool radius, between 0.05 and 0.5 mm), `floor` (the lowest tip Z; default the mesh's lowest point),
`pattern` (`zigzag`, the default, or `oneway`), and for `zlevel` `stepdown` (default half the tool
diameter), `entry` (default a 3 degree helix, `SURFACE3D_ROUGH_ENTRY`), `climb` (default true)
and `sliceCell` (default `SURFACE3D_SLICE_CELL`, 0.2 mm). For `zlevel` the stepover becomes the
pocket's fraction of the diameter.

### The drop-cutter (`mesh/dropcutter.ts`)

`DropCutter(mesh, shape)` answers `drop(x, y, floor)`: the lowest tool tip Z at (x, y) at which
the tool clears every triangle, or `floor`. Moved from the spike, where it agreed with OpenCAMLib to
2.3e-12 mm for flat and ball cutters on 892,104 points and did not gouge where OCL's cone cutter
does. A cutter is a solid of revolution given by its profile f(r) above the tip; each triangle
bounds the tip by its vertices, its facet (one known contact point per plane normal) and its edges
(the bound along an edge is concave for every profile here, so its maximum is a closed form for
flat, ball and sharp V cutters, and a bisection on the monotonic derivative for bull and
flat-tipped V cutters). Shapes: `flat`, `ball`, `bull` (corner radius) and `vbit` (half angle and
tip radius); `cutterForTool(tool, allowance)` maps a `Tool` to one, grown by the stock to leave (a
flat end mill becomes a bull nose, a ball a larger ball, a bull a larger bull; dropping the grown
cutter and adding the allowance keeps the real tool that far from the mesh). V-bits take no
allowance (a grown cone is none of these shapes); drills and engravers are refused. The spatial
index is a uniform XY grid over the triangles' boxes (cell the tool radius, at least 0.5 mm) in a
compressed layout, and triangles wholly below the current height are skipped. It holds about 150
bytes per triangle in typed arrays. `SurfaceSampler` is the one interface surfacing reads, so a
later engine plugs in behind it.

### Parallel finishing

The raster is `facingRaster(boundary, ...)` with no margin and no tool radius inset: lines across
the boundary at most a stepover apart, each cut into its stretches inside. Along each stretch the
tool is dropped every `sampling` mm (with the grown cutter for the allowance, down to `floor`), and
between neighbouring samples the middle is dropped too: where it lies more than half the tolerance
off the chord the interval is halved, up to 10 times or down to 0.002 mm. A jump that halving
cannot resolve (a flat end mill passing a vertical wall) becomes a step straight up then across, or
across then straight down, never a diagonal through the wall. The points are then filtered to lines
and arcs (`fitPolyline`, below) within the other half of the tolerance, so the posted path stays
within `tolerance` of the true cutter locations (measured on the filleted block at 0.01 mm: no ball
centre nearer the mesh than its radius less 0.0067 mm).

**Links and safety.** The program starts at the clearance height above the first line's start.
To start a stretch the tool rises straight up to the retract height (at least
`SURFACE3D_SAFE_ABOVE`, 0.5 mm, above the stock top, or above the mesh when that is higher),
crosses there, rapids down to 0.5 mm above the stock top (or the point, when higher) and feeds down
at the plunge feed: a finish does not know what the roughing left, so nothing rapids below the
stock top except straight up. In a zigzag, the next stretch is reached along the surface instead
(the dropped cutter locations from the end of one stretch to the start of the next, fed as a cut)
when it is at most two stepovers away and the straight link stays inside the boundary; otherwise
it retracts. One IR `pass` per raster line. The program ends with a rapid to the clearance.
`context.checkpoint()` runs before every line.

**Scallops.** `scallopHeight(shape, stepover)` is the cusp a cutter leaves between lines on a flat
floor: `R - sqrt(R^2 - (s/2)^2)` for a ball, 0 for a flat end mill, the corner's for a bull. On the
filleted block's flat top the measured cusp matches it within 5 micrometres at 1 and 2 mm stepovers.

### Z-level roughing

The slices come from a height grid (`mesh/slices.ts`): at every node of a `sliceCell` grid, the
highest point of the mesh within `reach` (a flat drop-cutter of that radius), with `reach` the
cell's diagonal plus `SURFACE3D_SLICE_SIMPLIFY` (0.02 mm). Marching triangles (two per cell, so the
interpolant is one piecewise-linear function and the slices of falling levels are nested) trace
where the grid exceeds `z - allowance`; with that reach, every point under material higher than
that lies inside the traced loops, which are then simplified within 0.02 mm. Those loops are the
islands of the layer at `z`: the region cleared is the boundary grown by the tool radius plus the
allowance, less the islands, and the pocket insets both by the tool radius plus the allowance. So
at every layer the tool (taken as a flat cylinder) keeps the allowance from the part sideways and
below it. Levels: even steps of at most `stepdown` from the stock top to the floor, plus the
allowance above every horizontal face of the mesh (with at least 1 mm2 of area), so flat areas
are roughed to exactly the stock to leave. The pocket does the entries, links and rapids (rapids
only above what it has cut, at the retract height otherwise); no wall or floor finishing pass. On
the filleted block with a 6 mm flat end mill and 0.5 mm to leave, no point of the tool comes nearer
the part than the allowance, the flat top is roughed to 0.5 mm above it, and at the floor the
tool's edge stays 0.65 mm from the wall (the allowance plus the slice's reach). Round tools rough
too, with a `rough-round-tool` warning: they leave more than the allowance between levels.

**Errors and warnings.** Bad numbers (a stepover outside (0, diameter], a negative allowance, a
non-finite angle, a tolerance below 0.0001 mm, an unknown strategy or pattern), an empty or
malformed mesh (indices out of range, coordinates not finite), an empty boundary, a floor not
below the stock top, a V-bit with an allowance and a drill or engraver are `invalid-input` errors.
Warnings: `depth-exceeds-flutes` (the finish reaches, or the roughing goes, deeper below the stock
top than the flute length) and `rough-round-tool`.

### Point filtering (`mesh/fit.ts`)

`fitPolyline(points, tolerance)` turns cutter locations into lines and arcs: greedily from the
start, the longest run of points one line holds (3D distance) against the longest run one arc
holds (an XY arc, flat or helical with Z linear in the angle, at most half a turn, through the
run's first, middle and last points, every point and every chord's middle within the tolerance,
and passing `grblArcPrecheck`), the longer winning and a line on a tie. Runs are found by galloping
and bisection, and every accepted element is checked against every point it replaces. A straight
raster line lies in a vertical plane, so it only ever becomes lines (on the block's flat top, one
move per stretch); arcs come from cutter locations that turn in XY.

### Performance

Measured in Node 26 on one desktop core (an AMD Ryzen 5 7600X), medians of 3, with the test
fixture's filleted block grown to 120 x 90 x 30 mm (fillet radius 8 mm, stock 130 x 100 x 32 mm),
a 1/4" (6.35 mm) ball for finishing (raster along X, sampling 0.5 mm, tolerance 0.01 mm) and a
1/4" flat end mill for roughing (stepdown 3 mm, stepover 2.5 mm, 0.5 mm to leave, slice cell
0.2 mm):

| Mesh triangles | Index build | Finish, stepover 0.5 mm (181 lines) | Finish, stepover 1 mm | Z-level rough |
| -------------- | ----------- | ----------------------------------- | --------------------- | ------------- |
| 8,718          | 6 ms        | 263 ms                              | 127 ms                | 1.8 s         |
| 33,806         | 4 ms        | 612 ms                              | 322 ms                | 1.9 s         |
| 98,574         | 7 ms        | 1.5 s                               | 0.8 s                 | 2.0 s         |

Of the roughing on the largest mesh, the slice grid (about 600 x 450 nodes) takes about 0.42 s and
tracing 12 slices 0.06 s; the rest is the pocket clearing its 12 layers. Memory: the
JS heap after `gc()` stays flat over 8 repeated finishes (15.9 to 16.1 MiB in the test run).

## Linking and job assembly (`job.ts`)

`assembleJob(setup, operations, options)` (T5.2g) turns a setup's operation toolpaths into one
program: the IR a post writes, one file per tool where the dialect splits them. `jobOperations(setup,
results, suppressed)` builds its input from the CAM worker's `generate` reply (unpacked, in the
setup's order; an operation with no result is a `not-generated` failure). It reads the setup's
heights, stock and WCS only.

**Order.** The user's order by default; `groupByTool: true` groups operations by tool, tools in
the order they are first used and each tool's operations in the user's order. Grouping changes
the order material comes off (a profile can then run before a pocket that was listed after it),
which is why it is an option. Suppressed operations are left out. An operation with an error (or a
spindle speed not above zero) fails the job: `{ ok: false, error }` with `error.failures` naming
every such operation, so an export never silently drops a cut; suppress it to go on. A job with
nothing left to cut is an error too. Operations with no moves are left out with an
`empty-operation` warning; the operations' own warnings come through tagged with their ids.

**Heights.** The stock top is machine Z 0 with the origin on top, else the stock height
(`stockTopZ`). The job's clearance is the setup's, raised to at least `JOB_SAFE_ABOVE` (0.5 mm)
above the stock top (`clearance-raised` warning). Between operations the tool rises straight up to
the clearance (or stays higher), crosses there, and comes down to where the next operation's
toolpath starts. An operation that claims to start below `stockTop + JOB_SAFE_ABOVE` is refused,
since the job would rapid down to it. The program starts at `options.start` (default the WCS
origin at the clearance) and ends with a rise to the clearance and the spindle off.

**Tool changes and the spindle.** At every change of tool: a rise to the clearance, spindle off,
`toolChange` (id, number, name, diameter), spindle on clockwise at the operation's speed, and a
dwell of `JOB_SPINDLE_DWELL` (5 s; a cautious default with no published spin-up time behind it,
marked unverified; `spindleDwell` overrides it). The same tool at another speed gets a new spindle
entry and the dwell, also at the clearance. An operator comment with the operation's name follows.

**Independent pieces.** The job passes an operation's moves through as generated, with one
exception: pieces the operation exposes as independent may be reordered (`reorder`, default
true). Drilling made only of canned-cycle groups joined by rapids is split into its holes
(`cyclePieces`; bores and anything else keep their order); an operation can also hand over
`pieces` (toolpaths, each starting at least 0.5 mm above the stock top) in its outcome. The order
(`orderPieces`) starts from where the tool really is: the shortest of the given order, its reverse
and a nearest-neighbour tour, improved by 2-opt for up to `JOB_TWO_OPT_LIMIT` (150) pieces, and
never longer than the given order. Between pieces the tool rises straight up, crosses at the
retract height when that is at least 0.5 mm above the stock top (else at the clearance: when
unsure, the clearance), and comes down to the next piece's start. Linking moves are tagged
`op: 'link'` (`JOB_LINK_OP`), pass 0; spindle, tool change and dwell entries carry the operation
they serve. The job does not lower links into cleared material on its own: operations do that
inside themselves, where they know what they have cut.

**Result.** `Job` holds the toolpath, each operation's entry span (`from` its comment and approach,
`to` its last entry), the tool ids in the order of their changes, the warnings, the clearance and
retract it used (for the post's `heights`), and with `rapidRate` the whole program's
`toolpathStats`. The assembled toolpath is run through `validateToolpath`; an issue is an error.

## Tests

`./node_modules/.bin/vitest run packages/cam` from the repository root:

- `wcs.test.ts`: the rotation table for each up axis, face ups, setup-frame bounds, each up axis
  with front-left top, back-right bottom and centre top origins against hand-computed points (and
  every corner with margins), loops on faces facing up and down, refused tilted planes and axes,
  drill points;
- `stock.test.ts`: margins, explicit sizes, refused inputs;
- `arc.test.ts`: sweeps, helical lengths, bounds across every quadrant and a randomised check
  that the bounds contain and are tight on 200 sampled arcs;
- `stats.test.ts`: lengths per class, time estimate and bounds on a sample program;
- `validate.test.ts`: a valid program and each issue code, canned-cycle markers included;
- `boundary.test.ts`: the import allowlist above, and a self-test of its scanner.
- `job.test.ts`: jobs from the real generators on fixtures and on 40 seeded random jobs
  (profiles, pockets, facings, straight, peck and bored holes; random stock, heights, tools,
  grouping): the IR validator passes on the whole job, it starts and ends at the clearance, every
  tool change comes at the clearance with the spindle off and is followed by spindle on and a
  dwell, the job's own sideways rapids stay above the stock top, and no rapid runs into material
  (a heightmap of the stock lowered by every feed move, `rapidCollisions` in `test-helpers.ts`,
  itself tested on a rapid through stock); grouping, speed changes, suppressed and failing
  operations, explicit pieces, the clearance fallback for a low retract, the rapid length against
  the naive order on a fixture (637 mm naive, 572 mm reordered), and the worker results.
  `test/job-gcode.test.ts` posts an assembled job for Grbl and Carbide Motion and runs the G-code
  verifier on every file.
- `ops/levels.test.ts`: depth levels, the `MAX_DEPTH_LEVELS` cap, refused steps, and the error
  from profile, pocket and facing for a tiny stepdown.
- `offset/engine.test.ts`: offsets of rectangles, rounded rectangles, circles and slots against
  closed-form areas and the exact distance (both paths), slots that vanish and a 0.2 mm sliver, a
  dumbbell that splits, holes and islands, 50 pocket rings, source tags, a dense polygon refit to a
  few arcs, the fast path against Clipper, open paths (round and butt ends, along lines and arcs),
  booleans, and refused input. Every result is checked for continuity, orientation, arcs on their
  circles and at most half a turn, and Grbl's radius rule and travel at 3 and 4 decimals;
- `offset/property.test.ts`: on random star and convex polygons and plates with holes, offset out
  then in contains the original, stays within the offset of it, gives back a convex polygon, and
  offsetting it out again matches the first outward offset;
- `offset/grbl.test.ts`: the pre-check's radius rule, rounding and full-circle travel, and the
  demotion of flat arcs;
- `offset/perf.test.ts`: the performance budget above.
- `ops/profile.test.ts`: the exact IR of a rectangle cut outside, and of its climb reversal; for a
  rectangle, a rounded rectangle and a circle on each side, the tool centre at the tool radius
  with arcs kept as arcs, and climb against conventional by winding; holes cut first; even depth
  steps no deeper than the stepdown; each loop roughed and finished before the loop enclosing it;
  finishing in stepdown steps where the roughing split at a dumbbell's neck or merged across a
  narrow gap between two parts, and in one step for a rectangle with a hole near its edge;
  roughing with an allowance and the finishing pass; tabs at
  their height and width, on straight sides or long arcs and never on corners or short arcs, by
  count and by spacing, skipped on small inside loops, carried to the finishing pass, dropped when
  there is no room; tangent arc leads on the scrap side for both directions, line leads, leads
  that would gouge left out; holes of an outside profile too small for the tool; a tab spacing with
  no tabs; ramps at their angle along the path (over several laps of a short
  loop) followed by a full lap; helixes on the scrap side, tangent to the cut, and their plunge fallback; refusals;
  checkpoints and `CamCancelled`; a run through the worker; and the sign's 300 x 150 mm outline, whose finishing
  feeds below the stock's top never have the tool centre beyond the roughed slot.
  Every toolpath passes the IR validator;
- `ops/pocket.test.ts`: a raster check of the swept tool at every level (no uncut grid point a
  tool centre can reach, right up to straight and curved walls; a self-test shows it fails a first
  ring 0.3 mm too far in) for a rectangle, a circle (rings kept as arcs), a pocket
  with an island (never entered or touched), a recessed border (one entry per level) and three
  islands; no tool centre closer to a wall than the tool radius; climb against conventional;
  links at depth; clean-up spots for a 95% stepover; a dumbbell's neck reported as unreachable
  with its area and place, and square corners not reported; helixes inside the pocket and no
  steeper than the angle, shrunk to the room there is, and the ramp fallback with its warning;
  wall and floor allowances with the finishing and floor passes; finishing in stepdown steps past
  a neck; a counter-clockwise island warned about; a heightmap material-removal simulation in
  which no rapid ever runs below the material left (an island near a wall with a floor allowance,
  and a 1 mm tool between islands and walls); z-level layers; refusals; checkpoints and
  `CamCancelled`; registration. Every toolpath passes the IR validator;
- `ops/facing.test.ts`: a raster check of the swept tool at the final depth (every grid point of
  the stock within the tool radius of a level cut; a self-test shows it finds the gaps a smaller
  tool would leave) at 0, 30, 45, 90 and 135 degrees in both
  patterns, with no margin at 0 degrees, for a strip narrower than the tool and for an L-shaped
  area (whose zigzag never steps across the notch); raster directions along the angle (both ways
  in a zigzag, one way only in a one-way raster); depth levels and their pass numbers; the
  clearance start and end, rapids in XY only at the retract height (raised above a high stock top)
  and rapids down only to just above the floor already cut; zigzag step-overs fed at depth with no
  rapid between levels; the margin; line spacing and stretches split by a gap; refusals;
  checkpoints and `CamCancelled`; registration. Every toolpath passes the IR validator;
- `post/format.test.ts`: number formatting (rounding, no exponent, no `-0`, the eight-digit
  limit), Grbl's `read_float` in single precision, comment sanitising and wrapping;
- `post/dialect.test.ts`: code normalising, a JSON round trip of a dialect, and each refusal:
  unknown fields, bad codes, missing required codes, tool change styles, flags, decimals,
  unknown variables, text variables in code lines, motion and program end in templates, malformed
  lines;
- `post/grbl-arc.test.ts`: the radius rule and its margin, inch conversion, the T5.0a tiny arc that
  Grbl cuts as a full circle, intended full circles, and the work offsets;
- `post/writer.test.ts`: exact text for a sample program in millimetres and inches, modal
  omission, the modes preamble, the safe start, each arc rule, full circles (halves, single, and
  single falling back), the choice of I and J, comments and line length, files per tool, `M0`
  pauses, `M6 T<n>`, template variables, dwells, `%` lines and every refusal; a template `G80`
  followed by a full safe start, work offsets only in the header, the G64 P cap, controller
  keywords in wrapped comments, forged and hostile dialects, unknown spindle states;
- `post/writer.property.test.ts`: 3,000 random arcs (radius 0.001 to 500 mm, tiny to full sweeps,
  helical, millimetres and inches, single and split full circles) read back from the text alone:
  every G2/G3 passes Grbl's radius rule and travel at every offset, only an intended full circle
  ends where it starts, every arc ends at the IR end, and every point and chord written for an arc
  stays within the tolerance of its circle;
- `post/roundtrip.test.ts`: the output parsed back with `gcode-toolpath` (cncjs, MIT, a development
  dependency), a parser we did not write: every parsed move is the IR move in hand (or the safe
  start), within the output rounding, and every IR move is reached in order; no arc ends where it
  starts unless a full circle is meant; the only extra rapids are the engine's safe start and
  retracts. The sample program and a two-tool job in millimetres and
  inches, every file mode and tool change style, and 400 random arcs.
- `post/grbl.test.ts`: golden files (`test/grbl/*.nc`, byte for byte) for hand-written IR jobs:
  a profile with tabs (millimetres and inches), a pocket with a helical entry, peck drilling as
  moves, and a two-tool job as two files and as one file with an `M0`; every line of every golden
  checked against a Grbl 1.1 word whitelist written from `gcode.c` independently of the dialect
  (codes, letters, modal groups, repeated words, digits, line length, comments), which has its
  own test, and read back with `gcode-toolpath` to stay inside the job and never rapid down
  diagonally; the header and footer, the router dial comment, no M6, T or G64, files per tool and
  their names, and refused dial tables.
- `worker/pack.test.ts`: packed toolpaths round-trip every entry kind, flag and op id exactly;
  clones own their buffers; packing refuses unknown kinds and feed classes, bad arc directions and
  passes outside Int32;
- `cache/cache.test.ts`: canonical hashing (key order, `-0`, typed arrays by bytes), what changes
  a toolpath key and what does not (names and post do not), `POLYGON_LIBRARY` against the pinned
  clipper2-ts, refused non-plain objects, and LRU eviction by count and size;
- `worker/worker.test.ts`: the worker over a real `MessageChannel` with stub operations: results
  arrive with buffers transferred, a newer request cancels an older long one mid-generator,
  `cancel`, a cache hit sends nothing to the generator, app-sent keys and `only`, finished
  operations kept after a supersede, nothing cached from a generator that caught `CamCancelled`,
  the machine row in the context, a thrown generator bug becomes an error value, expected
  failures cached as values, invalid toolpaths refused, no generator, transferred meshes,
  statistics, eviction, and the simulation channel (transferred heightmap, a simulation during a
  long generation with both done, missing toolpaths, supersede, a simulator bug).
- `ops/drill.test.ts`: the exact moves of a straight drill and of a peck cycle (each peck back to
  the retract height, re-entering 0.5 mm above the last depth, the dwell with its pass), pecks that
  do not divide the depth, the breakthrough below through holes and every tool's tip length, a
  counterbored hole drilled from the retract height, the retract height kept above the stock top
  (origin on top and on the bottom), a 6 mm hole bored with a 1/8" end mill (every arc's outer
  diameter 6 mm within 0.01 mm, a finishing circle at the bottom, the helix slope), a 20 mm bore in
  rings from the inside out, errors for holes smaller than the tool, a drill smaller than a hole
  and V-bits, the match tolerance, refusals, nearest-neighbour order and merged duplicates, the
  bracket's two holes from model to machine coordinates, the Grbl post (plain G0 and G1, no G8x),
  packing, statistics, checkpoints and the flute warning. Every toolpath passes the IR validator,
  and a checker follows every rapid below the stock top into a column the tool has already cut.
- `ops/vcarve.test.ts`: a heightmap simulation of the swept V-bit (exact along each straight
  move) against the ideal V-carve surface: a 6 mm slot reaches 3 mm along its whole centre line
  with a 90 degree bit, a 5 mm slot `2.5 / tan(30 degrees)` with a 60 degree bit, a rectangle's
  corners carved right into the corner, a flat tip's shallower centre, and the "OAB" lettering
  fixture of T5.8 (`packages/io/src/fixtures/svg/letters.svg`, written out as loops: a polygon O,
  a straight-line A, a B with arcs and a dot) within 0.006 mm deeper and 0.02 mm shallower than
  the ideal everywhere; the maximum depth with the floor cleared by the V-bit (ridges within
  0.2 mm), the bit's own depth limit, a capped `maxDepth`; an end mill clearing the floor first
  and the V-bit after, on the same material, within the same bounds and with a much shorter V-bit
  path; empty clearings; stepdown levels; rapids above the stock top when `top` is below it (origin
  on top and on the bottom); no rapid into material; feed moves inside the outline; the bucket
  grid against the exact distance; refusals, the narrow-tip warning, checkpoints and
  `CamCancelled`, registration. Every toolpath passes the IR validator.
- `mesh/dropcutter.test.ts`: closed-form drops of every cutter (flat, ball, bull, sharp and
  flat-tipped V) on a horizontal facet, its edge and corner, inclined planes in both V regimes, a
  ridge edge and a spike vertex; a bull with its corner equal to its radius is a ball; random
  meshes against a brute-force lower bound that shares no code with the cutter (never below it,
  above it only by the bound's sampling error); the same answers at any grid cell size; the empty
  mesh; `cutterForTool` and its grown cutters (a ball grown by the allowance keeps its centre
  `R + a` from a plane), and its refusals.
- `mesh/fit.test.ts`: collinear points to one line, a raster profile within 0.001 to 0.02 mm with
  far fewer lines, circles in both directions and a helix to arcs, arcs never past half a turn and
  all passing the Grbl pre-check, random walks within the tolerance.
- `mesh/slices.test.ts`: slices of a filleted block contain every point with material above the
  level and nothing beyond the reach plus a cell, are nested as the level falls, vanish above the
  part, trace holes clockwise; closed polygon simplification within the tolerance.
- `ops/surface3d.test.ts`: golden tests on a filleted block (60 x 40 x 18 mm, fillet r 8, 8,718
  triangles built in `mesh/test-meshes.ts`): the parallel finish never puts a 6 mm ball's centre
  nearer the mesh than its radius less the tolerance, checked by exact point-to-triangle distance
  every 0.1 mm along every feed move, and keeps it touching while cutting; ball and flat end mill
  finishes keep the stock to leave; the scallop on the flat top matches `scallopHeight` within
  0.002 mm at 1 and 2 mm stepovers; zigzag links along the surface and one-way retracts, rapids
  only straight up or above the stock top; an angled raster inside a given boundary; filtering
  shrinks the moves; bull and V-bit finishes agree with the drop-cutter; z-level roughing leaves
  the stock to leave against the analytic surface, roughs the flat top to exactly it, comes to
  within 1 mm more of the wall at the floor, steps down no more than the stepdown, and never
  rapids into material (the heightmap check); a given boundary and the round-tool warning;
  refusals, the flute warning, `CamCancelled` at a checkpoint, registration; and the JS heap flat
  over 8 repeated runs. Every toolpath passes the IR validator.
  `test/surface3d-gcode.test.ts` assembles a z-level rough and a parallel finish into a job, posts
  it for Grbl (one file per tool) and runs the G-code verifier on both files.
- `library/library.test.ts`: every built-in tool validates; the starter set and catalogue
  numbers; V-bit cone heights; the #201 presets equal to the chart rows; derived presets keep the
  #201 chip load scaled by diameter, stay within the flutes and are unverified; a preset for every
  feed category on every tool, resolved in internal units; unverified fields; materials to
  categories; the chip load calculator and its refusals; copying a tool as expressions that
  evaluate (with `@manufakture/units`) to the library values;
- `library/machines.test.ts`: every machine validates; the primary machines and the default;
  every size; travel; the default configuration (router dial, Carbide Motion, BitSetter, Grbl 1.1,
  posts); the dial table; flagged fields; refused profiles;
- `library/validate.test.ts`: a library file round trip, and refusals of unknown and missing
  fields at every level, wrong types and ranges, kind rules, duplicate presets and ids, wrong
  formats and versions, non-JSON, `__proto__` keys and oversized lists.
- `apps/web/src/cam/library/` (in the app's test project): every core material id resolves on
  every built-in tool; every built-in tool copied into a document is a valid `addCamTool` whose
  result validates; the OPFS store's add, replace, remove, export, import (merge, replace,
  refused, a picked file size-checked before it is read), damaged and foreign newer files kept
  aside and never deleted, a newer `version: 2` file next to good older ones, a lone file this
  build refuses (nothing saved over it), numbers never reused and rejected bytes never
  overwritten (the double failure, a name collision, a retry), at most five rejected copies
  kept (never one the same save set aside), a save refused before any change when it would need a
  file number past eight digits, a crash at every step of a save (also one that moves a rejected file aside), write and read errors
  as values, a re-list when listed files vanish, the save size limit, two concurrent puts with no
  Web Locks, and its lock. The store's layout and rules are described in `store.ts`.
