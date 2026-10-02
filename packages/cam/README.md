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
  - `drill`: `points` (`MachineDrillPoint`), `peck?` (mm), `dwell?` (seconds);
  - `vcarve`: `loops`, `top`, `maxDepth?`;
  - `surface3d`: `mesh`, `stepover` (mm), `angle`, `allowance`.
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
  `through?`, `source?`. **`MachineDrillPoint`**: `at` (machine XY), `depth`, `diameter`,
  `through?`, `source?`.
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

- **`dwell`**: `seconds` (zero or more). G4.
- **`toolChange`**: `tool` (the document id, `tool#n`), `number?` (written with `T`), `name` (for
  comments and the operator prompt). The spindle must be off.
- **`spindle`**: `state` `cw` or `ccw` with `rpm` (greater than zero), or `state: 'off'`. M3, M4,
  M5 with S.
- **`comment`**: `text`. Posts sanitise it (parenthesised ASCII, ADR 0014 decision 10).

`isMove(entry)` and `isFeedMove(entry)` narrow an entry.

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

The arc tolerance, `DEFAULT_ARC_TOLERANCE`, is **0.0005 mm**: a tenth of Grbl's 0.005 mm radius
check (error 33). The refit projects arc ends onto the exact circle, so its arcs agree far better.
Rapids are allowed with the spindle off and before any tool change.

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

| Field              | Meaning                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`       | Lower case id (`a-z`, digits, single hyphens) and a display name (`{post}`).                                                                                                                                    |
| `gCodes`, `mCodes` | Every code the controller accepts (`G01` and `G1` are the same). The engine needs G0 to G3, G17, G90 and G21 or G20; it writes G4, G94, M0, M3, M4, M5 and M6 only when they are listed, and refuses otherwise. |
| `toolChange`       | `none` (one tool per file), `m0-pause` (`M0` and comments between tools) or `m6` (`M6 T<n>` at every tool change, including each file's first).                                                                 |
| `splitPerTool`     | Default for writing one file per tool.                                                                                                                                                                          |
| `cannedCycles`     | Whether the controller takes G81/G83. Recorded for the drill posts; the IR has no cycle markers yet, so drilling is always written as G0/G1 moves.                                                              |
| `fullCircles`      | `halves` (default and safe) writes an intended full circle as two half arcs; `single` writes one arc with equal start and end, which Grbl 1.1 accepts in IJK form.                                              |
| `comments`         | `parentheses`, the only style written.                                                                                                                                                                          |
| `maxLineLength`    | Longest line, 40 to 255 (80 for Grbl's line buffer). Comments wrap; a longer code line is refused.                                                                                                              |
| `programDelimiter` | `%` lines around the program (LinuxCNC, Mach3).                                                                                                                                                                 |
| `dwellUnit`        | G4's P in `seconds` (Grbl, LinuxCNC) or `milliseconds`.                                                                                                                                                         |
| `decimals`         | Decimals for coordinates (X Y Z I J) and F per unit system, and for S and P. Coordinates need 2 to 6.                                                                                                           |
| `templates`        | `header` (top of every file), `tool` (once per tool in the file, after the header), `toolChange` (at each change, before `M0`/`M6`), `footer` (end of every file).                                              |
| `maxToolNumber`    | Optional: the largest tool number a `T` word may carry, 255 when absent (Grbl's `MAX_TOOL_NUMBER`; a larger T fails with error 38). A larger number is refused, in `M6 T<n>` and in a template's `T{tool}`.     |

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
  dial, turn the router on and resume.

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

Not covered yet: LinuxCNC's own arc radius tolerance (T5.4c may need a per-dialect value);
coolant (the IR has no coolant entry); canned cycles. Neither is in the IR: drilling arrives as
G0/G1 moves (pecks, dwells and retracts written out), so every post writes it that way, and a
Grbl post needs neither.

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
change, rewrite them with `UPDATE_GOLDENS=1` and review the diff line by line.

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

Not yet: linking per setup and its cache (T5.2g), progress reports for long 3D finishes (T5.5a),
an OPFS tier for the cache.

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
`bottom`; `bottom` may lie below the stock for a through cut. Order: loop by loop, smallest
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
the tool centre `r + a` clear of every wall and island (an exact segment distance, not samples)
and within one stepover of the rings already cut (checked every quarter stepover, so the tool
never takes more than a stepover); failing that, by running on along the ring just cut (cleared
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
through the allowance (`finish-plunge-at-wall`). A wall loop the clearing did not run alongside (a neck narrower than the
tool plus twice the allowance) is cut in `stepdown` levels from the top instead
(`finish-steps-down`).

**Layers.** `generatePocketLayers(op, layers, context)` clears z-level layers with their own
loops (3D roughing's slices), with the same rings, entries and links; an entry starts above the
layer before where that layer cleared it, else at `top`. It makes no floor or finishing pass and
reports no unreachable areas.

**Errors and warnings.** Bad numbers (a stepover outside (0, 1], a floor allowance as deep as the
pocket), no loops and a tool that fits nowhere are `invalid-input` errors. Warnings:
`depth-exceeds-flutes`, and those above.

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
- `validate.test.ts`: a valid program and each issue code;
- `boundary.test.ts`: the import allowlist above, and a self-test of its scanner.
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
