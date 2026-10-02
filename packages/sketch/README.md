# @manufakture/sketch

The 2D sketcher's data model and constraint solver. Sketch entities and constraints are plain,
serializable data; the solver is FreeCAD's PlaneGCS (`@salusoft89/planegcs` 1.2.0, pinned, LGPL,
loaded as a separate `.wasm`) behind this package's own interface, so it can be swapped without
touching callers. The decisions behind it are in [ADR 0003](../../docs/adr/0003-sketch-solver.md)
and the measurements in the [T0.4 spike](../../docs/spikes/T0.4-planegcs.md).

Units are millimetres and radians throughout ([ADR 0005](../../docs/adr/0005-units.md)).

## Entry points

| Import                         | What                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `@manufakture/sketch/model`    | The data model only: types and pure helpers, no solver code at runtime                                         |
| `@manufakture/sketch/geometry` | Everything but the solver: model, ids, splitting, placement, regions, fills, outlines, validation; no planegcs |
| `@manufakture/sketch/rpc`      | `connectSolver` / `serveSolver`, the worker protocol, without the solver                                       |
| `@manufakture/sketch`          | Everything: the above plus the solver and its service                                                          |
| `@manufakture/sketch/worker`   | The solver worker entry (see [Worker](#worker))                                                                |

`packages/core` stores sketches with the types from `/model`; a test checks that `model.ts` only
has type imports, so holding a sketch never loads planegcs. The app imports `/geometry` and `/rpc`,
which keeps planegcs's Emscripten glue out of its main bundle (it loads in the solver worker and
the regen worker only); `geometry.test.ts` walks their runtime imports to keep it so.

## Data model

```ts
interface SketchInput {
  entities: SketchEntity[]; // with their last solved coordinates
  constraints: SketchConstraint[]; // in creation order
}
```

Entities carry the coordinates of their last solve. They are the solver's starting point and
decide which solution the sketch settles into ([ADR 0004](../../docs/adr/0004-document-format.md),
decision 1); the constraints are what define the sketch.

| Entity    | Fields                                                                     |
| --------- | -------------------------------------------------------------------------- |
| `point`   | `position`                                                                 |
| `line`    | `start`, `end` (a line owns its endpoints, as in FreeCAD)                  |
| `circle`  | `center`, `radius`                                                         |
| `arc`     | `center`, `start`, `end`, counter-clockwise; radius and angles are derived |
| `outline` | `anchor`, `angle`, `source`: closed shapes (text) placed at the anchor     |

Every entity has an `id` and a `construction` flag. Construction geometry is solved like any
other and never becomes a profile edge.

An **outline** ([ADR 0012](../../docs/adr/0012-3d-printing.md) decision 7) is closed shapes from a
`source`, placed at `anchor` and turned by `angle` (radians, counter-clockwise from the sketch x
axis) about it. The only source so far is text, `{ kind: 'text', text, font, size, align:
{ horizontal, vertical }, letterSpacing?, lineSpacing? }` (core README, "Sketch data"; M5 adds an
`svg` source). To the solver an outline is its anchor and nothing else: two unknowns, referenced
as `{ entity, at: 'anchor' }`, so constraints place a text like a point (`coordinateCount` is 2,
`packCoordinates` packs the anchor). `angle` and the source are carried through unchanged, and the
glyphs are never solved: regen lays the text out after the solve and hands its loops to
`detectRegions` (see [Outline entities](#outline-entities)). An outline is never a curve to a
constraint (`horizontal`, `pointOnObject`, `tangent`... refuse it), cannot be split, and its id
takes no split suffix, since its glyph edge ids are built on it.

Constraints refer to points with a `PointRef`: `{ entity: 'p1' }` for a point entity, or
`{ entity: 'l1', at: 'start' | 'end' }` for a line, `'center'` for a circle, any of the three
for an arc, and `'anchor'` for an outline. Three built-ins are always available: `SKETCH_ORIGIN` (`@origin`, a point) and
`SKETCH_X_AXIS` / `SKETCH_Y_AXIS` (`@x-axis`, `@y-axis`, lines). They are fixed and cost no DOF.

| Constraint           | Fields                                          | Notes                                       |
| -------------------- | ----------------------------------------------- | ------------------------------------------- |
| `coincident`         | `a`, `b` points                                 |                                             |
| `horizontal`         | `line`, or `a`, `b` points                      |                                             |
| `vertical`           | `line`, or `a`, `b` points                      |                                             |
| `parallel`           | `a`, `b` lines                                  |                                             |
| `perpendicular`      | `a`, `b` lines                                  |                                             |
| `tangent`            | `a`, `b` curves, optional `at: [end, end]`      | see below                                   |
| `equal`              | `a`, `b`: two lines, or two circles/arcs        | length or radius                            |
| `distance`           | `a`, `b` points, or `point` and `line`; `value` | positive; to the line's extension           |
| `horizontalDistance` | `a`, `b` points; `value`                        | signed: `b.x - a.x`                         |
| `verticalDistance`   | `a`, `b` points; `value`                        | signed: `b.y - a.y`                         |
| `angle`              | `a`, `b` lines; `value`                         | from `a` to `b`, counter-clockwise          |
| `radius`, `diameter` | `entity` circle or arc; `value`                 | positive                                    |
| `fix`                | `point`                                         | pins it at its stored coordinates           |
| `midpoint`           | `point`, `line`                                 |                                             |
| `pointOnObject`      | `point`, `on` line, circle or arc               | lines extend; arcs count their whole circle |
| `symmetric`          | `a`, `b` points; `line` or `center` point       |                                             |

**Tangency** follows FreeCAD. With `at` (for example `at: ['end', 'start']`), it is an
endpoint-to-endpoint tangency between lines and arcs: the constraint joins the two ends itself
(coincident plus `angle_via_point`), so do not add a separate coincident, which would be
redundant. Whether the curves continue at 0 or turn back at pi is taken from the current
geometry, so a joint keeps the direction it was drawn with. Without `at`, it is an edge tangency:
a line and a circle or arc, or two circles or arcs (internal or external, again from the current
geometry). `tangent_la` is never used at a shared endpoint: T0.4 showed it degenerates there.

"The current geometry" is always the coordinates passed to the solve, never what an earlier
solve saw; see [Geometry-derived values](#geometry-derived-values).

**Dimension values** are `StoredExpression`s, `{ source, lengthUnit, angleUnit }`, the text the
user typed plus the bare-number units it was entered under
([ADR 0004](../../docs/adr/0004-document-format.md), decision 7). They are evaluated with
`@manufakture/units` before every solve, with a variable lookup supplied by the caller.

### Ids

Entity ids feed topological naming (`extrude#3:side:<entity-id>`), so they are restricted:
letters, digits, `_`, `.` and `-`, optionally followed by split suffixes `#a`, `#b`, ... An id
may never contain `#<digits>`: that is reserved for positional kernel splits, which are fragile
([T0.5](../../docs/spikes/T0.5-topo-naming.md)). `isValidSketchId` and `sketchIdProblem` check
this, and the solver refuses a sketch with a bad id.

`splitEntity(entity, points)` splits a line or arc (or a circle at two or more points) into
pieces named `<id>#a`, `<id>#b`, ... in order along the original, the convention the naming layer
reads as descent. A piece split again gets another suffix (`e2#a#b`). `splitIds`,
`splitParent` and `splitAncestors` work on the ids alone. Moving the original's constraints onto
the pieces is the editor's job.

## Solving

```ts
const backend = await loadPlanegcsBackend(); // Node: finds planegcs.wasm itself
const system = backend.createSystem(); // one per loaded sketch

const result = system.update(sketch, { variables: (name) => vars.get(name) });
result.status; // 'solved' | 'conflicting' | 'failed' | 'invalid' | 'aborted'
result.entities; // the input entities with solved coordinates
result.diagnosis; // { dof, conflicting, redundant, partiallyRedundant, entities }
result.issues; // input problems, when 'invalid'
```

`update` is incremental. It compares the sketch with what is loaded: a changed dimension value
sets a solver parameter, added and removed constraints are pushed and removed (`clear_by_id`),
and anything else (new, removed or reordered entities) rebuilds. The input's coordinates are
always the starting point, and the result is always what a freshly created system would give for
the same input. Invalid input (bad ids, unknown or wrong references, degenerate
geometry, expression errors, non-positive lengths) is reported as `invalid` with one issue per
problem, and the loaded state is left alone.

Solving uses DogLeg, and Levenberg-Marquardt from the same start when DogLeg does not converge;
never BFGS. Geometry is only taken over from a converged solve without conflicts; otherwise the
result carries the input coordinates.

### Geometry-derived values

Three things are taken from the geometry rather than stored in the constraint: the coordinates a
`fix` pins, 0 or pi for an endpoint tangency, and internal or external for two tangent circles.
The rule: **each is derived from the coordinates passed to that `update`**, on every update,
exactly as a fresh system would derive it. The incremental path recompiles every loaded
constraint against the incoming coordinates; a changed pin or angle is a parameter change (like a
dimension edit), and a tangency that changes between internal and external rebuilds. So a result
never depends on what was loaded before: moving a fixed point's stored coordinates moves the pin,
and two sketches that share ids solve independently.

This does not make curves flip. A drag does not recompile, so the choices hold for the whole
drag, and solved geometry satisfies them, so an update from the last solved coordinates derives
the same ones again. A choice only changes when the caller hands in geometry that is on the other
side, and then it changes the same way a regen of the stored sketch would.

### Diagnosis

- `dof`: remaining degrees of freedom, or `null` while constraints conflict.
- `conflicting`: every constraint taking part in a conflict, as one flat list in creation order.
  planegcs does not say which one to drop; blame the one the user just added.
- `redundant`: constraints implied by the others. Constraints are pushed in creation order, so
  the newest of equivalent constraints is the one reported. The solver ignores redundant ones.
- `entities`: per entity, `over` when it takes part in a conflicting or redundant constraint,
  `fully` when none of its coordinates can move, else `under`.

Read the lists, not the status: a redundant sketch solves normally. planegcs only re-runs its
diagnosis when a constraint is added or removed, so a value edit while anything is redundant or
conflicting rebuilds the system instead (a redundant constraint can turn into a conflict by its
value alone).

planegcs reports the total DOF but not which parameters are free. The per-entity status comes
from this package's own analysis: the same constraints, compiled once into primitive operations
(`ops.ts`), are both pushed to planegcs and turned into residual equations (`equations.ts`),
whose Jacobian is reduced per connected component (`analysis.ts`). A parameter is determined
when no first-order motion allowed by the constraints moves it. The tests check that its DOF
matches planegcs's on every sketch. Pass `analyze: false` to skip it for rapid value edits.

### Dragging

```ts
system.beginDrag({ entity: 'l1', at: 'end' });
const move = system.drag([x, y]); // { status, coordinates: Float64Array }
const entities = applyCoordinates(sketch.entities, move.coordinates);
const done = system.endDrag(); // full SolveResult
```

The dragged point is a soft target, FreeCAD's way: two temporary constraints (tag -1) that use no
DOF, never conflict, and make planegcs solve with its SQP routine. A fully constrained point stays
put; a partly constrained one slides along what is free. Coordinates come back packed in entity
order (point 2, line 4, circle 3, arc 6 numbers; see `packCoordinates`), ready to transfer.

### Out of memory

The published planegcs binary has a fixed 16 MiB heap and aborts with `Aborted(OOM)` from about
130 connected entities (T0.4). An abort poisons the instance. The system then answers
`aborted` with a message saying the solver ran out of memory, and keeps answering `aborted`; the
service discards the instance, loads a new one, and reloads its sessions. Building planegcs with
memory growth is ADR 0003's follow-up (decision 8).

## Service

`SolverService` implements `SketchSolverApi`, the worker's interface: plain data in and out
([ADR 0007](../../docs/adr/0007-worker-protocol.md)).

| Method                             | What                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `solve(sketch, variables?)`        | Regen: solve a sketch as stored. Never coalesced or dropped.    |
| `update(sessionId, sketch, vars?)` | Load or edit the interactive session for a sketch id, and solve |
| `dragStart(sessionId, point)`      | Start a drag                                                    |
| `dragMove(sessionId, target)`      | Move the target; `null` if a later move superseded this one     |
| `dragEnd(sessionId)`               | End the drag (solving a pending move first)                     |
| `close(sessionId)`                 | Drop the session                                                |

Variables cross the boundary as a plain `Record<string, Quantity>`. Drag moves are coalesced per
session: moves that arrive while one is waiting replace its target, only the latest is solved,
and the others resolve to `null`. Each regen solve gets a fresh solver system, disposed afterwards,
so it never depends on an interactive session's state or on the sketches solved before it (ids
repeat across sketches).

## Worker

`src/worker.ts` serves a `SolverService` on the worker's global scope:

```ts
const worker = new Worker(new URL('@manufakture/sketch/worker', import.meta.url), {
  type: 'module',
});
const solver = connectSolver(worker); // a SketchSolverApi
```

In the browser, `planegcs.wasm` is a separate asset: import it with Vite's `?url` and pass the
URL as the worker URL's `wasm` query parameter, or rely on the Emscripten glue finding it next to
the bundled JS.

ADR 0007 calls for Comlink on every worker boundary. This package does not depend on Comlink
yet, so `rpc.ts` provides a minimal request/reply protocol (`serveSolver`, `connectSolver`) that
transfers drag coordinates. `SolverService` is a plain object with async methods and plain data,
so replacing the entry's `serveSolver(self, service)` with `Comlink.expose(service)` changes
nothing else.

## Placement

A sketch sits in 3D on a `SketchPlacement`: `{ origin, normal, xDir }`, with the sketch y axis
`normal x xDir` (right-handed). `XY_PLANE`, `XZ_PLANE` (normal -Y, as in FreeCAD) and `YZ_PLANE`
are provided; `placementFromNormal(origin, normal, xDir?)` builds one for a datum plane or a
planar face, normalising and projecting `xDir` into the plane (or picking one). `sketchToWorld`,
`sketchDirectionToWorld`, `worldToSketch` (projecting along the normal), `distanceFromPlane` and
`placementMatrix` (column-major 4x4, as three.js reads it) map between the two.

## Regions

`detectRegions(entities)` turns a solved sketch into the closed areas extrude and revolve consume.
It is pure and takes the entities with their solved coordinates:

```ts
const { regions, voids, diagnostics } = detectRegions(result.entities);
regions[0].id; // 'l1/L+l2/L+l3/L+l4/L'
regions[0].outer.curves; // lines, arcs, circles in loop order, each with its edgeId
regions[0].holes; // clockwise loops
```

**How.** Non-construction lines, arcs and circles are split wherever they meet: crossings,
T-junctions (an endpoint on another curve), tangencies, and collinear or concentric overlaps, where
the shared stretch becomes one edge, owned by the entity with the smaller id (plain string order,
so the result does not depend on the order entities are listed in). Points closer than the tolerance
(1e-6 times the sketch extent, at least 1e-6 mm) are one vertex. Tangency is decided by distance: a
line and a circle touch when the centre is within the tolerance of the radius from the line, two
circles when the centre distance is within the tolerance of the sum or difference of the radii. They
then meet at one point, so solver residue that dips one curve a hair into the other does not open a
sliver face between two crossings. Edges with a free end are pruned, then bridges (an edge with the
same face on both sides), and the faces of the remaining planar graph are traced, taking at every
vertex the next edge clockwise; edges that leave a vertex in the same direction (tangent arcs) are
ordered by curvature. Every bounded face is a candidate region. Loops that do not touch are nested
by containment (the smallest enclosing face, by exact winding number over lines and arcs), and the
nesting depth decides even-odd: faces at even depth are `regions`, faces at odd depth (inside a hole)
are `voids`, and an island inside a hole is a region again. Overlapping outlines that cross are one
connected outline, so their faces are all regions (two overlapping rectangles give three), which is
what a user picking faces expects; the even-odd rule applies to separate nested outlines.

With `outlines` (`detectRegions(entities, { outlines })`, the placed loops of the sketch's outline
entities, see [Outline entities](#outline-entities)), text joins the regions too; outline entities
themselves are never curves of the graph.

A region's `outer` loop runs counter-clockwise and its `holes` clockwise. A loop that touches itself
or a hole at a single point (a hole tangent to the outline) is split there, so a touching hole is a
hole; it gets a `touching` warning: the kernel builds such a face, but the solid it makes is not
manifold at that point (BRepCheck reports it), which slicers may not accept.

**Edge ids.** Every curve of a loop carries `edgeId`, the name its side face gets on extrusion
(`extrude#3:side:<edgeId>`, T0.5). It is the entity id when the regions use the entity in one
stretch, and `<id>#1`, `<id>#2`, ... when other geometry meets the entity and splits it into several
used stretches, numbered along the entity (lines from start to end, arcs from start
counter-clockwise, circles counter-clockwise from angle 0). Stretches that meet only each other are
joined again, so a line that merely overshoots a corner, or is touched by a dangling edge, keeps its
plain id. `#<digits>` is the positional form of T0.5 (the sketcher's own splits use letters, `e2#a`,
and a sketch id can never contain `#<digits>`), so these edges are `fragile: true`: the naming layer
reads `e2` as the ancestor of `e2#1` (a reference to `side:e2` still resolves, as a descendant), and
any reference resting on `e2#1` itself warns at regen, since an edit that adds or removes a
crossing can renumber the pieces.

**Region ids.** A region's `id` is the set of entities on its outer loop, each with the side the
region lies on relative to the entity's own direction (`/L` left, `/R` right, `/LR` both), sorted by
entity id and joined by `+`: a rectangle with a hole is `l1/L+l2/L+l3/L+l4/L`, and a circle cut by a
line gives `c1/L+l1/L` and `c1/L+l1/R`. Entity ids, not edge ids, so a region keeps its id when
other geometry crosses its entities elsewhere; sides, so the two halves of a cut shape differ; the
outer loop only, so adding or removing a hole keeps the id. Resizing and moving keep it too, as long
as no entity is reversed: `/L` and `/R` are relative to the entity's direction, so reversing a line
(swapping `start` and `end`) or an arc flips its side and changes the id of every region it bounds
(`c1/L+l1/L` becomes `c1/L+l1/R`). The sketcher must therefore not reverse entities in place; an
edit that needs the other direction must either keep the stored direction or be handled by the naming
layer (#931) as a rename. When two faces still get the same id (a line cutting both horns of a
crescent), they are numbered by position, x then y (`...#1`, `...#2`), flagged `fragile`, and
reported as `ambiguous-id`. Ids are unique across `regions` and `voids`.

**Diagnostics.** Each has a `code`, a `severity`, a readable `message`, the `entityIds` involved and,
where it helps, `points`.

| Code              | Severity | Meaning                                                               |
| ----------------- | -------- | --------------------------------------------------------------------- |
| `open-profile`    | warning  | connected geometry that encloses nothing; `points` are its open ends  |
| `dangling-edge`   | warning  | an entity that bounds no region, although what it touches does        |
| `overlap`         | warning  | two entities on top of each other; the smaller id keeps the edge      |
| `touching`        | warning  | loops of one region touch at a point; the solid is not manifold there |
| `degenerate`      | warning  | zero length or radius, or an arc whose end is off its circle; ignored |
| `overhang`        | info     | part of an entity runs past where it meets other geometry             |
| `crossing`        | info     | two entities cross between their ends; `points` are the crossings     |
| `ambiguous-id`    | info     | faces numbered by position because their ids collided                 |
| `outline-overlap` | warning  | a text overlaps other geometry or text, or is too complex to check    |

**To the kernel.** `regionProfile(region, placement)` gives the kernel's `profile` input as plain data
(`frame`, then `loops`, outer first, each entity tagged with its `id` = edge id; arcs traversed
against their entity are `clockwise`; a glyph's curves are `bezier` entities of 3 or 4 points, the
kernel's T3.2a profile entity) plus an `edges` map from edge id to `{ entityId, fragile }`.
The kernel's extrude reports the side face of every tagged entity in `sideIds`, so the regen engine
names `extrude#3:side:<edgeId>` without matching geometry. This package does not import the kernel;
the kernel's `regions.test.ts` builds a checked-in fixture of such profiles in OCCT, and
`region-profile.test.ts` keeps the fixture equal to what `regionProfile` produces (regenerate with
`UPDATE_REGION_FIXTURES=1`, then format it with Prettier).

**Fills.** `regionFill(region, placement, deflection?)` (and `regionFills` for a list) triangulates a
region with its holes for hover highlighting: `positions` (world xyz, `Float32Array`), `indices`
(`Uint32Array`, counter-clockwise about the placement normal), `normal` and `area`. Arcs are
flattened within a linear and angular deflection (default 0.05 mm, 0.25 rad), chords are split
further where other geometry comes closer to an arc than its chord (a corner just inside a circle, a
tangent hole), holes are bridged into the outline, and the polygon is ear clipped. Beziers (glyphs)
are flattened within the linear deflection, at most 256 chords each. It is meant for highlights, not
for export: cost grows quadratically with the number of flattened points. So `flattenRegion` (which
the fills and the sketcher's overlay use) is capped: a region whose loops would flatten to more than
`MAX_FLATTEN_POINTS` (100,000) points in all, or to more than `{ maxPoints }` when the caller passes
a lower cap, throws a `RangeError` (naming that cap) as soon as the count passes it, before the
points are made, and `regionFill` throws it on. `regionFills` throws it for the whole list, so a
caller that should skip only the region past the cap calls `regionFill` per region and draws no fill
for that one. Without the cap a large or hostile text (up to 500,000 Bezier
curves, regen's `MAX_TEXT_CURVES`) could make tens of millions of points. The sketcher's overlay
also spends one budget of 200,000 points on all the fills of a sketch. `loopPolygon(loop,
deflection)` gives any region loop as a closed polygon, for containment tests and drawing.

## Outlines

`outlineRegions(path, options?)` (`src/outline.ts`) turns a path of lines and quadratic and cubic
Beziers into closed region loops. It is written for glyph outlines (`packages/text`) and SVG paths
(M5's import) alike and knows about neither: a path is plain data.

```ts
const path: PathCommand[] = [
  { kind: 'moveTo', to: [0, 0] },
  { kind: 'lineTo', to: [10, 0] },
  { kind: 'quadTo', control: [12, 5], to: [10, 10] },
  { kind: 'cubicTo', control1: [7, 12], control2: [3, 12], to: [0, 10] },
  { kind: 'close' },
];
const { regions, issues } = outlineRegions(path);
regions[0].outer.segments; // lines and Beziers, counter-clockwise
regions[0].holes; // clockwise loops
```

**Contours.** Each `moveTo` starts a contour, counted from 0 (a bare `moveTo` counts and draws
nothing). A contour that does not end where it started is closed with a straight segment, with an
`open-contour` warning unless the path said `close`. Drawing after `close` continues from the
contour's start, as in SVG. Segments shorter than the tolerance are dropped (glyphs often start with
a zero-length line), ends that agree within it are joined exactly, and a Bezier whose control points
lie on its chord becomes a line. A contour that encloses no area is ignored (`empty-contour`). A
Bezier that closes on itself (a contour drawn as one curve) is cut in half, the halves `split` 0
and 1 of its command, so no segment starts where it ends.

**Fill rule and nesting.** The fill rule is `nonzero` (TrueType and CFF glyphs) unless
`fillRule: 'evenodd'` is asked for. When no contours cross or touch, every contour has one winding
number outside it and one inside it, and it is kept when exactly one side is filled: outer loops
(fill inside) run counter-clockwise, holes (fill outside) clockwise, and each hole goes under the
smallest outer loop around it. A contour with fill on both sides, such as a same-direction contour
inside another under `nonzero`, bounds nothing and is dropped. An island inside a hole is a region of
its own.

**Overlaps are merged.** Contours that cross or touch, which every composite glyph with an accent,
bar, slash or ogonek component has (`Ç`, `Ð`, `Ø`, `Ų` in Inter Bold), as do variable-font
instances and overlapping SVG shapes, are merged: every segment is cut where another meets it
(lines and Beziers intersected by subdivision, collinear overlaps by their ends), each piece is kept
when the fill rule gives fill on exactly one side of it, turned so the fill is on its left, and the
pieces are chained into loops, taking the sharpest left turn where several leave one point. The
fill on each side is read just off the piece's middle, closer than any other curve comes there
(half the clearance to the nearest other command, at most 1e-5 times the extent): a short piece
next to a shallow crossing, such as where the ogonek of `Ų` leaves the bowl, has the other curve
within a hair of it, and the fixed offset used before T3.2c read the wrong side and refused the
glyph. A chain that comes back through a point it passed (a hole touching the outline there) is
split at that point into simple loops, the hole a hole, with a `touching` warning: the kernel
refuses the pinched wire, and builds the split loops to the right volume, but the solid is
non-manifold where they touch and BRepCheck reports it as such (`packages/kernel/test/outlines.test.ts`).
Two outlines that touch at a corner stay two loops. Beziers are cut exactly (de Casteljau), so merged loops are still lines and
Beziers. A shared edge between two filled shapes disappears, and a contour drawn twice counts
once. The result carries a `merged` issue (severity `info`) naming the contours involved. Merging
gives up only on curves that partly run on top of each other (a Bezier and a piece of the same
curve); the path is then refused with a `crossing` error and no regions, never passed on as
overlapping loops.

**Segment sources.** Every segment says where it came from: `contour`, `index` (the drawing
command within the contour, from 0, not counting the `moveTo`; a closing segment gets the next
index), `split` (its position among the pieces merging cut the command into, else 0), `piece` (its
position among the lines and arcs `arcs` made of it, else 0) and `reversed` (it runs against the
command). The first four are unique within a result and stable as long as the path is, so a caller
can build edge names from them (T3.2c builds glyph edge ids from them). `split` and `piece` are
positional, so names that use them are fragile in the T0.5 sense. A loop's `contour` is its
contour's index, or the lowest of the contours merged into it; regions are ordered by it.

**Areas.** `loop.area` is the loop's signed area, exact for lines, Beziers (Green's theorem with
three-point Gauss-Legendre, exact for cubics) and arcs; `outlineRegionArea(region)` subtracts the
holes. `loopArea(segments)` takes any loop of segments.

**Arcs.** With `arcs: { tolerance }`, every Bezier of the result is replaced by circular arcs and
lines within that tolerance (an arc through the piece's ends and midpoint, checked at 31 points, the
piece halved until it fits; flat pieces become lines), for consumers that take lines and arcs only.
Arcs are `{ center, start, end, clockwise }` in loop order. The tests check the two-sided distance
between each Bezier and its replacement against the tolerance on dense samples.

**Tolerance.** `tolerance` (default 1e-6 times the path's extent, at least 1e-9, as
`detectRegions`) decides which points are one and which segments are degenerate. `flattenSegment`
gives a polyline of any segment, for drawing. `tolerance`, `arcs.tolerance` and `flattenSegment`'s
tolerance must be finite and above 0; anything else throws a `RangeError` (a caller's mistake, not the path's).

**Limits.** Merging and the crossing test grow faster than linearly (640 bars all crossing each other
took 26 s to merge), and paths come from user fonts and SVG files, so every call is bounded. A path
of more than `MAX_OUTLINE_COMMANDS` (100,000) commands is refused up front; past that, every step
draws on a budget of `MAX_OUTLINE_WORK` (250 million elementary steps: a chord or segment test, a
polygon vertex a winding count visits, an arc fit, weighted by cost) and flattening may make at most
`MAX_OUTLINE_POINTS` (1,000,000) vertices, which bounds memory. Running out of either gives a
`too-complex` error and no regions, in about a second or less on a desktop (the 640 bars now fail in
0.8 s). The most demanding glyph of Inter Bold up to U+024F (`ø`, merged, then turned into arcs)
takes 7.9 million steps and 30,000 vertices, a thirtieth of the budget; 120 bars through one point
or twenty overlapping circles still merge.
Callers run `outlineRegions` on untrusted paths in a worker with a time limit all the same
(`packages/text`'s README, "Untrusted fonts").

| Issue           | Severity | Meaning                                                             |
| --------------- | -------- | ------------------------------------------------------------------- |
| `crossing`      | error    | contours overlap in a way that cannot be merged; no regions         |
| `not-finite`    | error    | a coordinate is NaN or infinite; no regions                         |
| `too-complex`   | error    | the path is over the command, work or vertex limit; no regions      |
| `touching`      | warning  | merged loops touch at a point (`point`): split, non-manifold there  |
| `open-contour`  | warning  | a contour without `close` ended away from its start; closed         |
| `empty-contour` | warning  | a contour encloses no area; ignored                                 |
| `merged`        | info     | contours that crossed or touched were merged; `contours` lists them |

### Several paths

`outlinePartsRegions(paths, options?)` converts the glyphs of a text (or any list of paths) at
once. Paths whose bounding boxes overlap are converted together, so glyphs that really overlap
(touching after kerning, a script font's joins) are merged into one outline; every other path is
converted on its own, which keeps the cost of merging to the glyphs that need it. Every segment,
loop and issue says which path (`part`) and which of its contours it comes from, contours counted
within each path as `outlineRegions` counts them; each group is one `outlineRegions` call with its
own limits.

### Outline entities

`placeOutline(entity, glyphs, result)` (`src/outline-entity.ts`) places the result of
`outlinePartsRegions` for an outline entity: every point turned by the entity's `angle` and moved
to its `anchor`, and every curve named. `glyphs[part]` is the glyph's position in the text (line
breaks counted), and edge ids are positional, built from the entity id, the glyph, the contour,
the drawing command and, as T0.5's final positional piece, the piece merging cut it into:
`e5.g3.c0.s12#1` (`outlineEdgeId`). The `#<digits>` makes every face built on a glyph edge
**fragile**, like an imported face: editing the text renumbers them, and a reference to one
resolves with a warning (ADR 0012 decision 7). The result is a list of `OutlineShape`s, one per
region (`key` `e5.g3.c0` from its outer loop's contour, `#k` when merging made several loops of
one contour), each with its holes (keyed the same way).

`detectRegions(entities, { outlines })` then joins them to the sketch's own faces:

- every outline region is a **region**, whatever its nesting depth, with the shape's key as its id;
- an outline that lies cleanly inside a face (crossing none of its loops, enclosing no other
  geometry, overlapping no other outline) cuts a hole of its shape in that face, so a plate with a
  text in it is the plate with letter-shaped holes plus the letters;
- the **counters** of such letters (the inside of an "O") become faces of the same kind as that
  face, id `<hole key>/counter`, with `selectedWith` set to the face's outer-loop entities: listing
  the plate's lines selects the plate and its counters (a stencil keeps them), listing the text
  selects the letters alone, and listing both selects the whole plate;
- an outline that crosses or encloses other geometry, or overlaps another outline, is kept as it
  is, cuts no hole, gets no counters, and gets an `outline-overlap` warning naming what it meets
  (the kernel fuses whatever is extruded together).

Glyph loops never reach the solver or the planar graph, so the region detection of the sketch's
own curves costs what it did. The outline tests are bounded, since a text's loops come from a
font, which may be hostile:

- an outline is compared with the sketch's loops and with **other entities'** outlines only where
  their bounding boxes meet (a sweep by x per pair of entities whose boxes meet; the glyphs of one
  text are never compared with each other), and two outlines' segments only where they lie near
  each other (a grid over the overlap of their boxes), so two interleaved combs of 64,000 segments
  each are checked in about 0.1 s rather than 13 s;
- which other outline holds a glyph's first point is looked up on a grid of the outlines' boxes,
  not by scanning every hole cut so far: 40,000 glyphs in one plate take about 0.13 s. A glyph in
  another glyph's counter (earlier or later in the text) cuts its hole in that counter, not in the
  face the other went into;
- loops are flattened to polygons only after their points are counted and paid for, and all
  flattening together may make at most `MAX_OUTLINE_POLYGON_POINTS` (4 million) points, lowered
  per call by `RegionOptions.outlinePoints` in tests, so a text of many finely curved Beziers
  falls back as below instead of running out of memory. The flattening tolerance counts Bezier
  control points in the sketch's extent, as `outlineRegions` does, so it is never finer here;
- all of it draws on a work budget, `MAX_OUTLINE_PLACEMENT_WORK` (100 million steps: a polygon
  vertex flattened or visited, a segment pair tested, a grid cell filled, a pair of boxes
  compared), lowered per call by `RegionOptions.outlineWork` in tests. Ten thousand characters of
  Inter Bold in a plate spend under two million; running it out takes about 0.6 s. When it runs
  out (or the points do), no outline cuts a hole: every outline entity is kept as it is with an
  `outline-overlap` warning ("too complex to check against ...") naming what its box meets, the
  result an overlapping text gets, never a wrong hole.

Regen also caps what a text may make before it gets here (regen README, "Text", Size limits).
Measured in `packages/regen/src/text.test.ts` (logged, not asserted) for 1000 characters of
Inter Bold in 20 lines inside a rectangle (821 glyphs drawn, 857 outline regions, 1195 regions in
all) on a desktop machine: layout and outlines about 145 ms, region detection about 30 ms; 10,000
characters in 125 lines (8572 outline regions, 11,962 loops) take about 1.3 s and 130 ms.

## Performance

Measured in Node by `src/latency.test.ts` on one coupled 50-entity system (the T0.4 chain of ten
rounded rectangles, 250 unknowns), Ryzen 5 7600X, Node 26.10:

| Operation                                                | Median  | p95     |
| -------------------------------------------------------- | ------- | ------- |
| Drag move (FreeCAD-style, under-constrained sketch)      | 3.30 ms | 4.45 ms |
| Dimension edit (`update`, DOF 0, no per-entity analysis) | 3.58 ms | 5.92 ms |
| Rebuild, solve, diagnosis and per-entity analysis        | 8.17 ms | 9.38 ms |

The test holds the first two to the 16 ms frame target with a wide margin. Larger single systems
are slower (T0.4: 56 to 135 ms per move at 200 entities) and hit the memory limit above.

## Tests

`make test` (or `pnpm --filter @manufakture/sketch test` for this package alone) runs everything in
Node, including the real planegcs wasm: DOF sequences for the rectangle (16, 8, 4, 2, 0) and the
rounded rectangle with a tangent arc (21, 11, 7, 5, 2, 0), redundancy and conflicts with their ids,
every constraint kind, expressions, incremental edits (including geometry-derived values that change
between updates), dragging, the service's coalescing and recovery from an out-of-memory abort, and
the RPC over a `MessageChannel`. Region tests (`regions.test.ts`, `region-profile.test.ts`,
`region-mesh.test.ts`) cover the cases in [Regions](#regions), fills whose triangles add up to the
flattened region, and 60 random grid-snapped rectangle sets whose faces must tile exactly the area
their outlines enclose. `outline.test.ts` covers loops, winding, nesting, clean-up (a contour of
one closed Bezier included), merging (crossing and touching contours, a bar through a ring, a
figure eight, curves crossing lines, a hole touching its outline, a short piece by a shallow
crossing, duplicates, and the refusal of coincident curves), the limits (hundreds of crossing
contours, too many commands or vertices, an arc tolerance too fine to fit, invalid tolerances),
exact areas, and the arc approximation's distance to the Beziers both ways.
`outline-entity.test.ts` covers the outline entity in the solver and validation,
`outlinePartsRegions`, `placeOutline`'s placement and names, and text joining the regions: letter
holes and counters in a plate, a text alone and in a void, a text that crosses or encloses other
geometry, two texts that overlap, and Bezier profile entities and fills.
