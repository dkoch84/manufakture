# @manufakture/sketch

The 2D sketcher's data model and constraint solver. Sketch entities and constraints are plain,
serializable data; the solver is FreeCAD's PlaneGCS (`@salusoft89/planegcs` 1.2.0, pinned, LGPL,
loaded as a separate `.wasm`) behind this package's own interface, so it can be swapped without
touching callers. The decisions behind it are in [ADR 0003](../../docs/adr/0003-sketch-solver.md)
and the measurements in the [T0.4 spike](../../docs/spikes/T0.4-planegcs.md).

Units are millimetres and radians throughout ([ADR 0005](../../docs/adr/0005-units.md)).

## Entry points

| Import                       | What                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `@manufakture/sketch/model`  | The data model only: types and pure helpers, no solver code at runtime |
| `@manufakture/sketch`        | Everything: model, validation, placement, splitting, solver, service   |
| `@manufakture/sketch/worker` | The solver worker entry (see [Worker](#worker))                        |

`packages/core` stores sketches with the types from `/model`; a test checks that `model.ts` only
has type imports, so holding a sketch never loads planegcs.

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
the RPC over a `MessageChannel`.
