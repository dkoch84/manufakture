# 0007: Worker protocol: Comlink, coarse calls, errors as data, named meshes

- Status: accepted, amended 2026-09-26
- Date: 2026-09-26

## Context

The kernel and the solver run in Web Workers; the UI, the viewport and the document live on the main thread. This ADR fixes how they talk, so that `packages/kernel`, `packages/sketch`, `packages/regen` and the app can be built in parallel against one contract. It is the protocol task #926 builds.

The inputs:

- [T0.2](../spikes/T0.2-occt.md): libcascade runs in a module worker behind Comlink 4.4.2 and hands meshes to three.js as transferred typed arrays (positions, normals, indices, per-face `[firstIndex, indexCount]` ranges). The Comlink round trip added little to a bracket regen (74.84 ms against 73.59 ms inside the worker). A regen can take hundreds of milliseconds (722.7 ms for the fine bracket), recycling the instance takes about 0.3 to 0.4 s, and OCCT exceptions arrive as `WebAssembly.Exception` to be decoded and released.
- [T0.4](../spikes/T0.4-planegcs.md): the solver belongs in its own worker (a median of 0.02 to 0.12 ms round-trip overhead), pointer moves should be coalesced there, and a solver abort poisons its instance. Its spike used plain `postMessage` with a transferred `Float64Array` of parameters.
- [T0.5](../spikes/T0.5-topo-naming.md), recommendations for #926: topology-changing operations return kinded history for every input face, edge and vertex; `extrude` returns the profile-to-face map and both caps; a `topology(shape)` query supplies what edge names and ambiguity checks need; the naming layer runs in the worker next to the regen engine; meshes carry names as a string table plus per-face and per-edge indices, with a `fragile` flag; picking returns a name, not an index; a feature with an unresolved reference is skipped with a `FeatureError` and later features still regenerate. T0.5 also found that `BRepFilletAPI_MakeFillet::IsDeleted` returns true for edges the fillet did not touch.
- [ADR 0001](0001-kernel-wrapper.md): the synchronous kernel API, `HistoryEntry` (history to result faces only), `MeshData`, and `KernelError` with the operation and the decoded OCCT exception type. Its decision 2 leaves it to T0.5 to extend `HistoryEntry` to what naming needs.

## Decision

1. **Three contexts.** The kernel and the solver are in **separate workers** so that a long regen or a kernel recycle never delays a sketch drag, and an abort in one never takes down the other. Each is recycled on its own.
   - **Main thread**: UI, three.js viewport, the document and its persistence ([ADR 0004](0004-document-format.md)).
   - **Kernel worker**: the regen engine (`packages/regen`), the naming layer, and `packages/kernel` with its OCCT instance ([ADR 0002](0002-kernel-build-and-loading.md)).
   - **Solver worker**: `packages/sketch` with its planegcs instance ([ADR 0003](0003-sketch-solver.md)).
2. **Comlink for every call.** Each worker exposes one TypeScript interface, defined in the package that owns it. No OCCT or planegcs object, and no pointer into a wasm heap, crosses a worker boundary. At start-up the main thread creates a `MessageChannel` and hands one port to each worker, so the regen engine can re-solve sketches on the solver directly, without a round trip through the main thread.
3. **Coarse calls, batched per user intent.** One edit is one `regen` call carrying the document (or a delta against the worker's copy) and returning, in one reply, the status of every feature, the meshes of every changed body and the name table. There is never one message per OCCT operation. Interactive sketching is one call per coalesced pointer move.
4. **Cancellation by generation.** Every request carries a `generation` number that increases with every edit, and every reply echoes it. A newer regen supersedes an older one: the worker checks between features and abandons stale work, and the main thread drops replies older than the newest request. An OCCT call cannot be interrupted, so the unit of cancellation is one feature operation. Terminating a worker is the last resort for a stuck operation, at the cost of a recycle and a replay.
   - The solver worker holds one session per loaded sketch, keyed by the sketch's id. Interactive drags from the main thread are coalesced per session: the latest target wins and superseded moves are dropped ([ADR 0003](0003-sketch-solver.md), decision 3).
   - Solve requests from the regen engine arrive on the kernel worker's port and are never coalesced with drags or dropped by them: each is answered in full. A regen solves the sketch as stored in the document, so it does not depend on the state of an interactive session for the same sketch.
5. **Errors are data.** Expected failures come back as values in the reply, never as exceptions through Comlink, which are reserved for programming errors. A fatal failure inside a worker (a wasm abort), like the kernel reaching its heap threshold, makes that worker recycle its instance and replay; the main thread is told through a status event, and the regen that follows reports normally.
   - a failed feature has one or more `FeatureError`s (every lost or ambiguous reference, not only the first) and is skipped; later features still regenerate on the last good result, so one bad feature never crashes a regen;
   - kernel failures carry `KernelError`'s fields (the operation and the decoded OCCT exception type and message); the kernel decodes and releases the `WebAssembly.Exception` itself;
   - reference outcomes carry T0.5's names: `lost` with the missing names, `ambiguous` with the candidates, and `via` and `fragile` for warnings;
   - expression errors carry the `UnitsError` with its source range ([ADR 0005](0005-units.md));
   - sketch failures carry the conflicting and redundant constraint ids, read from the solver's lists, never from its status.
6. **Meshes are transferred, not copied.** Per body, `MeshData` from ADR 0001: `Float32Array` positions and normals, a `Uint32Array` index buffer and `Uint32Array` face ranges, plus edge polylines (layout settled with the viewport). All buffers go through `Comlink.transfer`, and the worker keeps no copy. Sketch parameters come back as a transferred `Float64Array`.
7. **Names travel with meshes.** Each regen reply has one string table. Each body adds a `Uint32Array` of name indices aligned with its face ranges, another aligned with its edge polylines, and a per-face and per-edge fragile flag, so the UI can warn at pick time.
8. **Picking returns a name.** The main thread raycasts in three.js, maps the triangle to its face through the face ranges and the face to its name through the table, and sends the name with the generation it came from. For an edge, the kernel worker returns the minimal `EdgeRef` to store (with `ends` or `ordinal` only when needed). Indices are valid only within their generation and are never stored.
9. **Kernel history and topology for naming**, adopted from T0.5's recommendations 1 to 3 for #926. This is the extension of `HistoryEntry` that ADR 0001's decision 2 anticipated, not a change of that decision; `packages/kernel` implements it.
   - Every topology-changing operation returns a `HistoryEntry` for every face, edge and vertex of every operand, including inputs with no face output. `kept`, `modified` and `generated` refer to result sub-shapes of any kind, as `{ kind, index }`.
   - Naming uses `kept`, `modified` and `generated` only. `deleted` is informational: fillet's `IsDeleted` is wrong for untouched edges, so naming never relies on it.
   - `extrude` (and later revolve and sweep) also returns both caps and the result face each profile entity generated, in the order of the loop's entities, so the regen engine can name faces after sketch ids.
   - A `topology(shape)` query returns faces, edges and vertices with the fields below. In the spike it went through embind per sub-shape and took about 7 of the 17 ms of a regen of the test part, so it is implemented in C++ with the other helpers ([ADR 0002](0002-kernel-build-and-loading.md), decision 3).

The kernel shapes for decision 9, extending ADR 0001's API (`SubShapeRef` is ADR 0001's `{ kind, index }`, with 1-based indices in `TopExp.MapShapes` order):

```ts
interface HistoryEntry {
  operand: number; // which input: 0 = shape, 1 = tool, ...
  input: SubShapeRef; // a face, edge or vertex of that input
  kept: number; // index of the same sub-shape (same kind) in the result when untouched, else 0
  modified: SubShapeRef[]; // result sub-shapes this input became (OCCT Modified)
  generated: SubShapeRef[]; // result sub-shapes it gave rise to (OCCT Generated)
  deleted: boolean; // informational only; never used for naming
}

interface ExtrudeResult extends OperationResult {
  capStart: number; // result face index of the cap at the profile
  capEnd: number; // result face index of the far cap
  sides: number[][]; // per profile loop, the result face each entity generated, in loop order
}

interface Topology {
  faces: FaceInfo[];
  edges: EdgeInfo[];
  vertices: VertexInfo[];
}

interface FaceInfo {
  index: number;
  surface: string; // surface type
  centroid: Vec3;
  area: number;
  normal: Vec3 | null; // outward normal, planes only
  axis: Vec3 | null; // cylinders only
  radius: number | null; // cylinders only
}

interface EdgeInfo {
  index: number;
  faces: number[]; // adjacent faces, unique, ascending; a seam lists its one face once
  seam: boolean;
  curve: string; // curve type
  midpoint: Vec3;
  length: number;
  vertices: number[]; // one for a closed edge
}

interface VertexInfo {
  index: number;
  point: Vec3;
  faces: number[]; // faces around the vertex, unique, ascending
}

interface Kernel {
  // ... ADR 0001's members, plus:
  topology(shape: ShapeId): Topology;
}
```

A first cut of the regen reply, for `packages/regen`:

```ts
interface RegenResult {
  generation: number;
  names: string[]; // name table for this regen
  features: FeatureResult[];
  bodies: BodyMesh[]; // changed bodies only; buffers are transferred
}

interface FeatureResult {
  featureId: string;
  errors: FeatureError[]; // empty unless the feature was skipped; lists every failed reference
  references: ReferenceResolution[]; // via and fragile, per reference id
}

type FeatureError =
  | { code: 'kernel'; operation: string; occtType?: string; message: string }
  | { code: 'reference-lost'; referenceId: string; missing: string[] }
  | { code: 'reference-ambiguous'; referenceId: string; candidates: string[] }
  | { code: 'unnamed-face'; message: string }
  | { code: 'expression'; field: string; error: UnitsError }
  | { code: 'sketch'; conflicting: string[]; redundant: string[]; message: string };

interface BodyMesh {
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array; // [firstIndex, indexCount] per face
  faceNames: Uint32Array; // per face, an index into RegenResult.names
  faceFragile: Uint8Array; // per face, 1 when its name is positional
  // edge polylines, edgeNames and edgeFragile follow the same pattern
}
```

## Alternatives considered

- **Plain `postMessage`**, as the T0.4 spike used. It works and costs nothing, but every call needs hand-written message types and correlation. Comlink gives typed calls at a cost T0.2 could barely see. Rejected.
- **Kernel and solver in one worker.** A 700 ms regen or a 0.3 s recycle would freeze sketch dragging, and a solver abort would force a kernel replay. Rejected.
- **Solver on the main thread.** No latency gain (T0.4), and a large solve drops frames. Rejected.
- **Fine-grained RPC** (one call per kernel operation, shapes as remote handles). Many round trips per regen, and OCCT lifetimes managed across threads. Rejected: the regen engine lives next to the kernel.
- **`SharedArrayBuffer` for meshes.** Needs cross-origin isolation and synchronisation, while transfer is already zero copy. Rejected.
- **Throwing errors through Comlink.** Per-feature failures are normal results that the UI shows in the feature tree, and they must not depend on how a thrown error is serialised. Rejected.
- **Picking by index.** T0.5 shows indices silently drifting to another edge after an edit. Rejected.

## Consequences

- The main thread never waits on the kernel: regens and recycles run while the viewport keeps drawing the last good meshes.
- Every request and reply type is plain data plus transferable buffers, so the workers can be tested in Node without a browser.
- The regen engine owns the document copy the kernel works on; the main thread owns the saved one. Deltas, if used, must be versioned by generation.
- Stale replies are normal and are dropped silently; UI code must not assume one reply per request.
- The exact edge polyline layout, and how `ReferenceResolution` is shaped, are settled by #926 and the viewport task within this contract.

## Amendment: the regen worker solves sketches in-process (T1.10, #933)

Decision 2 hands the kernel worker a `MessageChannel` port to the solver worker, so the regen engine can re-solve sketches there. When the engine was wired into the app, the solver went into the regen worker instead, as its own `SolverService` (planegcs loaded on the first sketch solve):

- the engine awaits every solve before its next kernel op, so a solver in another worker adds a round trip per sketch and buys no parallelism;
- the solver worker belongs to the sketcher, starts on the first sketch and is disposed with the app, so a port would tie regen to its lifetime (and start it for every opened document with a sketch);
- regen solves are stateless and never touch the interactive sessions (decision 4 already said so), and a planegcs abort is contained by `SolverService`, which replaces its instance without touching the kernel's.

The cost is planegcs's 0.5 MB `.wasm` instantiated in both workers. Decision 1 still holds for interactive sketching: drags and dimension edits run in the solver worker, never behind a regen. The engine takes any `solve` implementation (`createRegenWorkerApi({ solver })`), so a port can come back without changing it. Details are in `packages/regen/README.md`, "The worker".
