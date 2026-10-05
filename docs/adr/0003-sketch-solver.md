# 0003: Sketch solver: planegcs in a worker, behind our own wrapper

- Status: accepted, amended 2026-10-04
- Date: 2026-09-26

## Context

Sketches need a 2D geometric constraint solver that counts degrees of freedom, handles tangent arcs, reports redundant and conflicting constraints, and re-solves fast enough to drag a point at frame rate. The [T0.4 spike](../spikes/T0.4-planegcs.md) evaluated `@salusoft89/planegcs`, FreeCAD's PlaneGCS compiled to WebAssembly, in Node, on the main thread and in a worker. The [product decisions](../decisions/0000-product-decisions.md) require GPLv3-compatible dependencies and an LGPL component loaded as a separate `.wasm`.

The forces, from T0.4:

- **Correct.** DOF counting, tangent arcs with a radius, and redundant and conflicting constraint detection all work (19 tests). Endpoint tangency must be modelled FreeCAD's way (coincident plus `angle_via_point`); `tangent_la` at a shared endpoint is degenerate, misreports DOF and makes DogLeg converge only linearly.
- **Fast at 50 entities, not at 200.** At 50 entities DogLeg re-solves in 1.7 to 2.9 ms per move and a FreeCAD-style drag takes 3.1 ms. At 200 entities in one coupled system nothing robust meets 16 ms: 56 ms (DogLeg, driving-constraint drag), 131 ms (FreeCAD-style drag), 135 ms (dimension change).
- **Algorithms.** DogLeg converged on every move and was fastest on fully constrained sketches. LM always converged at 1.8 to 3 times DogLeg's cost. BFGS failed on all 60 moves of the fully constrained scrub at 50 and 200 entities.
- **A worker costs nothing measurable.** The round trip adds a median of 0.02 to 0.12 ms over the solve; loading planegcs in a worker takes 11.0 to 14.0 ms. On the main thread, a 130 ms solve drops 8 frames.
- **The published binary is limited.** Its memory is fixed at 16 MiB and it aborts with `Aborted(OOM)` from 130 entities in the spike's sketches (200 entities needs 40 MiB); an abort poisons the instance. It needs `'unsafe-eval'` under a Content Security Policy. Both are build flags.
- **The wrapper as published is rebuild-only.** `GcsWrapper` tags constraints by push position and cannot remove a primitive.
- **Diagnosis quirks.** Conflicts come back as one flat list with no culprit; the solve status is not a conflict signal (BFGS says `Converged` on a conflict); the diagnosis is cached until a constraint is added or removed, so value edits are not re-diagnosed.
- **Maintenance.** One maintainer, a handful of commits a year, built on Emscripten 3.1.45. The solver itself is FreeCAD's; the wasm packaging is the fragile part.
- **Alternatives are not ready.** Ansatz (`ansatz-wasm` 0.3.0, MIT) does not implement general 2D sketch constraints yet and was days old when read; nothing was measured. SolveSpace's `libslvs` (GPLv3) was named but not evaluated.

## Decision

1. **Pin `@salusoft89/planegcs` at exactly `1.2.0`** for T1.5, loaded as a separate `.wasm` asset through a `?url` import.
2. **Own wrapper in `packages/sketch`** over `GcsSystem`, not `GcsWrapper`. Each constraint's tag stands for the sketch model's stable constraint id, so conflict and redundancy lists map straight back to model ids and a constraint can be removed with `clear_by_id`. Model ids are strings ([ADR 0004](0004-document-format.md), decision 4) and planegcs tags are numbers, so the wrapper keeps a two-way map per loaded system and assigns tags from a counter that starts at 1 and only increases. Tags 0 and -1 are never assigned to model constraints: planegcs excludes both from diagnosis (T0.4), and -1 is the tag of the temporary drag constraints in decision 5. Tags are not persisted; a reload or a recycled instance builds a new map. The package exposes a small, solver-neutral interface (load sketch, solve, drag, diagnose) so the solver can be replaced without touching callers. No planegcs type leaves the package.
3. **Solve in a dedicated solver worker**, never on the main thread and never in the kernel worker ([ADR 0007](0007-worker-protocol.md)). Pointer moves are coalesced in the worker: the latest target wins, so a slow solve never queues stale drags. An `Aborted(OOM)` or any other abort discards the instance; the worker loads a new one and reloads the sketch.
4. **Algorithms: DogLeg by default, LM as a retry when DogLeg fails. Never BFGS.**
5. **Dragging the FreeCAD way**: temporary coordinate constraints on the dragged point, which consume no DOF, never conflict, and make planegcs use its SQP routine. Driving-constraint drag (`pin` in T0.4) stays in reserve for large sketches.
6. **Data model follows FreeCAD**: lines own their endpoints; connectivity is `p2p_coincident`; endpoint tangency is coincident plus `angle_via_point`, never `tangent_la` at a shared endpoint; arcs carry `arc_rules`. Dimension values are solver parameters, so a dimension edit is a value change, not a rebuild. Angles are radians ([ADR 0005](0005-units.md)).
7. **Diagnosis**: after every topology change, and after value edits that touch redundant constraints (rebuild, or check their residuals). Read the conflict and redundancy lists, never the solve status. The UI highlights the whole conflicting list and blames the most recently added constraint; constraints are pushed in creation order so that the newest is the one reported redundant.
8. **Our own planegcs build before sketches pass about 100 entities** (a follow-up task, not T1.5): built in this repository from the upstream sources with `-sALLOW_MEMORY_GROWTH` and `-sDYNAMIC_EXECUTION=0`, exporting conflict groups, and exposing `initSolution` separately so a drag does not re-partition the system on every move. T0.4's benchmark is re-run against it. This build is also the answer if the published package stops being maintained.
9. **Fallbacks.** The primary fallback is the one in step 8: owning the planegcs build, since the solver is FreeCAD's and maintained upstream. Ansatz is not a 2D fallback today because it has no 2D sketch constraints; it is re-evaluated, together with `libslvs`, when the product reaches assemblies and mates, or earlier if it gains 2D support. Its diagnostic report (DOF, redundant and conflicting groups, per-constraint residuals and messages) is the reference shape for our wrapper's `diagnose` result either way.

## Alternatives considered

- **Use `GcsWrapper` as published.** Positional tags and no removal make every edit a full rebuild. Rejected.
- **Solve on the main thread.** No latency advantage, and a large solve blocks rendering and pointer handling. Rejected.
- **LM or BFGS as the default.** LM is 1.8 to 3 times slower; BFGS fails on fully constrained sketches. Rejected.
- **`tangent_la` for endpoint tangency.** Degenerate at the solution: wrong DOF from exact geometry and slow convergence. Rejected.
- **Keep the stock 16 MiB binary indefinitely.** It aborts from about 130 entities and needs `'unsafe-eval'`. Acceptable for T1.5 only.
- **Ansatz now.** No 2D sketch constraints, one author, days old. Rejected for now (step 9).

## Consequences

- Sketches up to about 50 entities in one coupled system drag and edit well inside a frame. Larger single systems are usable but slow (56 to 135 ms per move at 200), and the viewport stays responsive only because solving is off the main thread. Sketches made of unconnected profiles split into subsystems and cost less.
- The sketch model owns stable constraint and entity ids (never reused, [ADR 0004](0004-document-format.md)), which the solver, the conflict UI and topological naming all rely on.
- Until our own build exists, a sketch of about 130 entities or more can abort the solver (125 solved in T0.4, 130 did not); the worker must survive that by recycling, and the UI must say why the sketch did not solve.
- We take on building planegcs ourselves before sketches grow. Upstream provides a Docker recipe and a 428-line binding template; its Emscripten 3.1.45 settings break on Emscripten 4 (upstream issue #8), so our build pins its toolchain too.

## Amendment: the end-of-M1 checkpoint of decision 8

Decision 8 called for our own planegcs build before sketches pass about 100 entities. The headroom of the published 1.2.0 binary and the size of real sketches were measured on 2026-10-04 ([research note](../research/end-of-m1-checkpoints.md), section 5). The decision stands; the build is deferred to a follow-up task.

- **Headroom, through `packages/sketch`.** A coupled, fully constrained sketch (T0.4's chain) solves at 115 entities and aborts at 120; free, at 130 and 135; unconnected rectangles at 200 lines; loose lines without constraints at 2,000 and more. A thousand regen-style solves in one instance do not erode it.
- **Real sketches are small.** The largest sketch of any acceptance model has 16 entities (the M5 sign's border); the most constrained has 6 lines and 17 constraints (the M1 bracket). M4 and M6 did not produce large sketches: the construction domain works from its own plan data, and text and SVG artwork enter a sketch as one outline entity.
- **The build is not needed now.** It becomes necessary before any feature makes coupled sketches of about 100 entities, when the cap on SVG import as editable geometry (`MAX_SOLVER_LOAD` in `apps/web/src/sketcher/svg-import.ts`) should be lifted, when solver aborts show up in use, or when the published package stops working with our toolchain. The note's section 6 says what the build must do and how it is accepted.
