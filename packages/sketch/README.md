# @manufakture/sketch

The 2D sketcher's data model and constraint solver. Sketch entities and constraints are plain,
serializable data; the solver is FreeCAD's PlaneGCS (`@salusoft89/planegcs` 1.2.0, pinned, LGPL,
loaded as a separate `.wasm`) behind this package's own interface, so it can be swapped without
touching callers. The decisions behind it are in [ADR 0003](../../docs/adr/0003-sketch-solver.md)
and the measurements in the [T0.4 spike](../../docs/spikes/T0.4-planegcs.md).

Units are millimetres and radians throughout ([ADR 0005](../../docs/adr/0005-units.md)).

## Entry points

| Import                         | What                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@manufakture/sketch/model`    | The data model only: types and pure helpers, no solver code at runtime                                     |
| `@manufakture/sketch/geometry` | Everything but the solver: model, ids, splitting, placement, regions, fills, validation; loads no planegcs |
| `@manufakture/sketch/rpc`      | `connectSolver` / `serveSolver`, the worker protocol, without the solver                                   |
| `@manufakture/sketch`          | Everything: the above plus the solver and its service                                                      |
| `@manufakture/sketch/worker`   | The solver worker entry (see [Worker](#worker))                                                            |

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

| Entity   | Fields                                                                     |
| -------- | -------------------------------------------------------------------------- |
| `point`  | `position`                                                                 |
| `line`   | `start`, `end` (a line owns its endpoints, as in FreeCAD)                  |
| `circle` | `center`, `radius`                                                         |
| `arc`    | `center`, `start`, `end`, counter-clockwise; radius and angles are derived |

Every entity has an `id` and a `construction` flag. Construction geometry is solved like any
other and never becomes a profile edge.

Constraints refer to points with a `PointRef`: `{ entity: 'p1' }` for a point entity, or
`{ entity: 'l1', at: 'start' | 'end' }` for a line, `'center'` for a circle, and any of the three
for an arc. Three built-ins are always available: `SKETCH_ORIGIN` (`@origin`, a point) and
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

A region's `outer` loop runs counter-clockwise and its `holes` clockwise. A loop that touches itself
or a hole at a single point (a hole tangent to the outline) is split there, so a touching hole is a
hole; it gets a `touching` warning, because OCCT may refuse such a face.

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

| Code            | Severity | Meaning                                                               |
| --------------- | -------- | --------------------------------------------------------------------- |
| `open-profile`  | warning  | connected geometry that encloses nothing; `points` are its open ends  |
| `dangling-edge` | warning  | an entity that bounds no region, although what it touches does        |
| `overlap`       | warning  | two entities on top of each other; the smaller id keeps the edge      |
| `touching`      | warning  | loops of one region touch at a point; the kernel may refuse the face  |
| `degenerate`    | warning  | zero length or radius, or an arc whose end is off its circle; ignored |
| `overhang`      | info     | part of an entity runs past where it meets other geometry             |
| `crossing`      | info     | two entities cross between their ends; `points` are the crossings     |
| `ambiguous-id`  | info     | faces numbered by position because their ids collided                 |

**To the kernel.** `regionProfile(region, placement)` gives the kernel's `profile` input as plain data
(`frame`, then `loops`, outer first, each entity tagged with its `id` = edge id; arcs traversed
against their entity are `clockwise`) plus an `edges` map from edge id to `{ entityId, fragile }`.
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
tangent hole), holes are bridged into the outline, and the polygon is ear clipped. It is meant for
highlights, not for export: cost grows quadratically with the number of flattened points.

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
their outlines enclose.
