# @manufakture/kernel

The only path by which manufakture touches OpenCASCADE. OCCT (libcascade 3.0.2, single-threaded, [ADR 0002](../../docs/adr/0002-kernel-build-and-loading.md)) runs in a Web Worker behind a thin wrapper of our own ([ADR 0001](../../docs/adr/0001-kernel-wrapper.md)); the main thread talks to it through Comlink with plain data and transferred buffers ([ADR 0007](../../docs/adr/0007-worker-protocol.md)). The UI thread never calls the kernel directly.

```
main thread                         kernel worker
-----------                         -------------
KernelClient  --- Comlink --->  createKernelWorkerApi   (loading, progress, transfer)
 (client.ts)                        KernelService      (batches, generations, errors as data, recycling)
                                    Kernel             (arena, ops, history, topology, mesh)
                                    libcascade (.wasm)
```

## Entry points

| Import                        | Where                 | What                                                                                 |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `@manufakture/kernel`         | worker, Node          | `Kernel`, `KernelService`, `createKernelWorkerApi`, `OcctLoader`, types, name tables |
| `@manufakture/kernel/client`  | main thread           | `spawnKernelWorker()`, `KernelClient`                                                |
| `@manufakture/kernel/worker`  | worker entry          | `Comlink.expose` of the worker API, with the `.wasm` imported as a Vite `?url` asset |
| `@manufakture/kernel/node`    | Node (tests, goldens) | `createNodeKernel()`, `createNodeService()`, `nodeLoader()`, `wasmPath()`            |
| `@manufakture/kernel/testing` | Node tests            | `track()`: records every embind object, to prove nothing is left undeleted           |

## Using it from the app

```ts
import { spawnKernelWorker } from '@manufakture/kernel/client';

// At app start-up, so kernel loading overlaps UI start-up (ADR 0002).
const kernel = spawnKernelWorker({
  onStatus: (s) => {
    if (s.type === 'loading') splash.update(s.progress); // download, compile, instantiate, init, ready
  },
});
await kernel.ready;

const reply = await kernel.submit([
  { op: 'profile', frame, loops, featureId: 'sketch#1', keep: false },
  { op: 'extrude', profile: { result: 0 }, distance: 10, featureId: 'extrude#1' },
  { op: 'tessellate', shape: { result: 1 } },
]);
if (reply !== null) {
  // null: superseded by a newer submit, drop it
  const [, extrude, mesh] = reply.results; // typed per op
}
```

`spawnKernelWorker` creates `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. Vite emits the `.wasm` as its own content-hashed asset and copies the Emscripten glue verbatim; the `.wasm` is never inlined (checked with a production build: `worker-*.js` 35 KB, `opencascade_single-*.js` 67 KB, `opencascade_single-*.wasm` 42.7 MB). Vite's default worker format builds; the T0.2 spike ran its module worker with `worker: { format: 'es' }`, which is the safer setting when the app wires this in. Hosting must serve the `.wasm` hashed, immutable and brotli-compressed (ADR 0002).

## Operations

A batch is a list of ops and gets one reply (ADR 0007, decision 3). An op can use the shape made by an earlier op of the same batch with `{ result: <index> }`, so a whole chain is one round trip.

| Op           | Arguments                                                                   | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `box`        | `size`, `at?`                                                               | `{ shape }`                                                                             |
| `cylinder`   | `radius`, `height`, `at?`, `axis?`                                          | `{ shape }`                                                                             |
| `profile`    | `frame` (origin, xDir, normal), `loops` of line/arc/circle                  | `{ shape }`: a planar face                                                              |
| `extrude`    | `profile`, `distance` (along the normal) or a vector, `history?`            | `ExtrudeResult`: shape, history, `capStart`, `capEnd`, `sides` per loop in entity order |
| `boolean`    | `kind` (`fuse`, `cut`, `common`), `shape`, `tools`, `simplify?`, `history?` | `OperationResult`: shape, history                                                       |
| `fillet`     | `shape`, `edges` (1-based edge indices), `radius`, `history?`               | `OperationResult`                                                                       |
| `tessellate` | `shape`, `deflection?` (`linear` 0.1 mm, `angular` 0.5 rad)                 | `MeshData`, transferred                                                                 |
| `topology`   | `shape`                                                                     | `Topology`: faces, edges, vertices (ADR 0007)                                           |
| `properties` | `shape`                                                                     | volume, area, bounding box, validity, counts                                            |
| `release`    | `shapes`                                                                    | `{ released, unknown }`                                                                 |

Every op takes `featureId?` (echoed in its result and any failure, and stamped on the shapes it makes) and `keep?` (default true; `false` releases the op's shape when the batch ends, for intermediates).

Inside the worker the same operations are methods of the synchronous `Kernel` (`box`, `cylinder`, `profile`, `extrude`, `boolean`, `fillet`, `mesh`, `topology`, `properties`, `count`, `release`, `checkpoint`, `releaseSince`), which throw `KernelError`. The regen engine (`packages/regen`, #931) will call those directly from the worker.

### History

Topology-changing ops return a `HistoryEntry` for every face, edge and vertex of every operand (operand 0 is the shape or profile, 1.. the tools), with `kept`, `modified` and `generated` as kinded `{ kind, index }` result references, sorted faces, edges, vertices, then by index (ADR 0007, decision 9). `deleted` is informational: fillet's `IsDeleted` is wrong for untouched edges, so naming must never use it. History is collected by default; `history: false` skips it. All indices are 1-based in `TopExp.MapShapes` order and valid for one shape only.

## Replies

```ts
interface BatchReply {
  generation: number; // echoed
  instance: number; // kernel instance; increases with every recycle
  status: 'done' | 'cancelled';
  results: OpResult[]; // one per op; empty when cancelled
  completedOps: number;
  names: string[]; // name table for the meshes' name slots
  heapBytes: number;
  shapeCount: number;
  ms: number;
  recycle: RecycleReason | null; // a recycle runs right after this reply
}
```

### Errors are data

Nothing an op does throws through the worker boundary (ADR 0007, decision 5). A failed op has `{ ok: false, error: KernelFailure }` and the rest of the batch still runs; ops that depend on it fail with `dependency`.

| `code`             | Meaning                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `kernel`           | OCCT failed; `occtType` and `occtMessage` carry the decoded OCCT exception when there is one       |
| `invalid-op`       | malformed op: unknown name, wrong types, a `{ result }` that is not an earlier op or made no shape |
| `invalid-argument` | well formed but out of range: zero size, open loop, missing edge, zero-length extrusion            |
| `unknown-shape`    | the id is not live: released, never issued, or from before a recycle                               |
| `dependency`       | an input is the result of an op that failed                                                        |
| `fatal`            | the wasm instance trapped; the rest of the batch fails and the instance is recycled                |

Every failure has `operation` and `message`, and `featureId` when the op had one. Only a malformed envelope (not an object, no integer `generation`, no `ops` array) rejects: that is a programming error.

### Meshes

Per body, fresh typed arrays, all transferred (never copied, the worker keeps nothing):

- `positions`, `normals` (`Float32Array`, xyz per vertex, vertices not shared between faces, normals outward), `indices` (`Uint32Array`, counter-clockwise from outside);
- `faceRanges` (`[firstIndex, indexCount]` per face, three.js group layout) and `triangleFaces` (1-based face index per triangle);
- `edgePositions` (xyz per polyline point) and `edgeRanges` (`[firstPoint, pointCount]` per edge). Edge points are taken from the polygon BRepMesh stored on the triangulation, so they are exactly mesh nodes; degenerate edges have no points;
- `faceNames`, `faceFragile`, `edgeNames`, `edgeFragile`: the name slots of ADR 0007 decision 7.

Face `i` is slot `i - 1` of every per-face array, edge `i` slot `i - 1` of every per-edge array: the same numbering as history and topology. The kernel does not name anything; slots start as `UNNAMED` and the naming layer fills them with `NameTable` and `applyNames`, sending `table.names` once per reply. `faceNameOfTriangle` is the picking lookup (decision 8: picking returns a name).

## Cancellation

Generation numbers, as ADR 0007 decision 4 decides. Every request carries a `generation` that increases with every edit. A batch is abandoned when a request with a higher generation arrives before it finishes, or when `cancel(g)` covers it; batches with equal generations do not cancel each other and run in submission order. Batches never run concurrently.

An OCCT call cannot be interrupted, so the unit of cancellation is one op: the batch yields to the event loop between ops (a macrotask, not `setTimeout`, which browsers clamp), which is what lets a newer request or a `cancel` message be received at all while a batch runs. A cancelled batch releases every shape it made and replies `status: 'cancelled'` with no results; that includes a newer request that arrives during the last op, which the batch sees at one more yield after it. On the main thread, `KernelClient.submit` resolves to `null` for a reply that a newer submit has superseded. When such a reply had finished (the newer submit came while it travelled back), the client releases the shapes it kept through the worker's `release(shapes)`, which is not a batch: it runs after whatever is queued, is never cancelled and does not count as a newer request, so the next edit (during a drag there always is one) cannot cancel it and leak the shapes. A batch at a stale generation is cancelled even when it is empty. A batch cancelled after its last op has run every op, so its `release` ops have taken effect although the reply carries no results. A `release` op on a lost kernel fails as `fatal`, like every other op.

Terminating the worker is the last resort for a single op that never returns: `KernelClient.restart()` terminates and respawns it, resolves pending submits to `null`, and every shape id is gone. It is not the normal cancellation path because it costs a new instance (0.3 to 0.4 s) plus a replay.

## Shape handles and leaks

Shapes live in an arena in the worker and cross the API as integer `ShapeId`s; no OCCT object leaves the package. Ids are never reused, not even across a recycle. Callers release explicitly (`release` op, `Kernel.release`, `checkpoint` / `releaseSince`).

- Every live shape records the op, `featureId` and `generation` that made it; `leaks()` (client and service) lists them oldest first.
- With `debug: true` (a `KernelServiceConfig` passed to `spawnKernelWorker({ config })` or `init`) shapes also record their creation stack, and a `leak-warning` status is emitted once when more than `maxLiveShapes` (default 10,000) are live.
- Every temporary OCCT object is owned by a scope and released before `delete()` (T0.2's rules: `Nullify`, `Clear`, `Reset`, empty argument lists, `BRepTools.Clean` after meshing), including on every error path. `leaks.test.ts` proves it with the embind tracker, and checks that 30 regens of a small part leave the heap at its initial size.

## Recycling

libcascade's empty destructors leak on every regen, and a `WebAssembly.Memory` never shrinks, so the instance is recycled (ADR 0002, decision 5):

- after a batch, when the heap exceeds `heapThresholdBytes` (default 1 GiB) and no other batch is queued (an idle point);
- after a wasm trap (`WebAssembly.RuntimeError`), always;
- on request (`recycle()`).

A recycle drops the old instance without touching it, creates a new one from the cached `WebAssembly.Module` (no refetch, no recompile), and runs the replay hooks registered with `KernelService.onRecycle(hook)`; the regen engine will register one to replay the document. Status events `recycling`, `loading` (instantiate, init, ready) and `recycled` (with heap before and after, lost shapes and hook errors) go to subscribers. The reply of the batch that triggered it says `recycle: <reason>`, and the recycle runs before the next batch, including batches that were already queued when the trap happened.

## Testing

```sh
pnpm --filter @manufakture/kernel test       # this package only
make test                                    # everything
```

The tests run the real 42 MB kernel in Node, one instance per test file (about half a second each):

- `kernel.test.ts`: every operation, history, topology and mesh against known geometry, and the error cases;
- `leaks.test.ts`: embind objects, arena and heap after regens, releases and failures;
- `service.test.ts`: batches, references, errors as data, cancellation, recycling, leak warnings;
- `worker.test.ts`: the worker API through Comlink on a real `MessageChannel`, so requests are cloned and buffers transferred: progress, transfer, cancellation across the channel, stale replies, restart;
- `loader.test.ts`: the browser loading path (streaming compile, progress) fed from memory;
- `names.test.ts`, `ops.test.ts`: name tables and op validation, no wasm.

For golden tests, `createNodeKernel()` gives a synchronous kernel and `createNodeService()` the full service, both from a module compiled once per process.

## Deviations from the ADRs

- **Op batches, not `regen` yet.** ADR 0007 decision 3 has one `regen` call per user intent. The regen engine is #931, so the worker exposes the plumbing under it: batches of kernel ops with in-batch references. `regen` will be added to the worker API on top of `KernelService` without changing the protocol rules (generations, errors as data, transfer).
- **API surface.** Implemented from ADR 0001: `release`, `checkpoint`, `releaseSince`, `shapeCount`, `heapBytes`, `box`, `cylinder`, `profile`, `extrude`, `boolean`, `fillet`, `count`, `mesh`. Not yet: `revolve`, `chamfer`, `describe`, `adjacentFaces`, `exportStep`, `exportStl` (#931 and later). `volume` and `boundingBox` are one `properties()` query; `adjacentFaces` is covered by `topology()`. `profile` takes a `Frame` (origin, xDir, normal) as its plane.
- **`KernelError`** carries a `code` (the table above), `occtMessage` and `featureId` besides ADR 0001's `operation` and `occtType`.
- **Mesh layout.** ADR 0007 left the edge polyline layout to this task: `edgePositions` plus `edgeRanges`. `triangleFaces` is added next to `faceRanges`. Name slots are `UNNAMED` until the naming layer fills them.
- **History by default.** ADR 0001 has `history?: boolean`; ADR 0007 requires history from every topology-changing op, so it is on unless `history: false`.
- **Topology and mesh extraction go through embind**, not C++ helpers (ADR 0002, decision 3); the API is shaped so that the custom build can replace them.
- **Not in this package yet:** the `MessageChannel` port from the kernel worker to the solver worker (ADR 0007, decision 2), and the replay itself (only the hook).
