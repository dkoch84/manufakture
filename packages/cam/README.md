# @manufakture/cam

Computer-aided machining for GRBL routers, the Shapeoko first ([M5 plan](../../docs/plans/m5.md),
[ADR 0014](../../docs/adr/0014-cam-architecture.md)). This package will hold the CAM types, the
toolpath intermediate representation (IR), WCS and stock math, the offset adapter, the operations,
linking, the simulation, the machine and tool tables, the post-processors and the CAM worker. So
far it has the foundation every later task builds on (T5.1c): evaluated input types, the IR, WCS
transforms, stock boxes, IR statistics and bounds, and the IR validator.

Pure TypeScript with no dependencies. Everything runs in Node tests with no kernel `.wasm` loaded.

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
    `finishAllowance`, `tabs?` (`count`, `width`, `height`), `entry`, `leadIn`, `leadOut`, `climb`;
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
| `tool-change-spindle-on` | a tool change while the spindle runs                                  |
| `dwell`                  | a negative dwell                                                      |
| `arc-zero-radius`        | an arc starting on its centre                                         |
| `arc-radius`             | start and end radius differ by more than the tolerance                |
| `arc-degenerate`         | start and end coincide in XY without `fullCircle`                     |
| `arc-full-circle-open`   | a `fullCircle` arc that does not end at its start in XY               |

The arc tolerance, `DEFAULT_ARC_TOLERANCE`, is **0.0005 mm**: a tenth of Grbl's 0.005 mm radius
check (error 33). The refit projects arc ends onto the exact circle, so its arcs agree far better.
Rapids are allowed with the spindle off and before any tool change.

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
