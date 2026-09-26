# @manufakture/regen

The regeneration engine: turns a core document (`packages/core`) into geometry through the kernel
(`packages/kernel`), rebuilding only what an edit changed. It evaluates expressions
(`packages/units`), solves sketches (`packages/sketch`), translates every core feature into a kernel
`FeatureInput`, caches each feature's result, and reports per feature a status, errors, warnings,
reference resolutions and timing, plus the final body's mesh and name table for the viewport.

```ts
import { RegenEngine } from '@manufakture/regen';

// In the kernel worker, next to the kernel service (see "Where it runs").
const engine = new RegenEngine({
  kernel: service, // a KernelService: run, release, cancel, onRecycle, stats
  solver, // a SketchSolverApi (its stateless `solve`)
  onKernelRecycled: () => rerun(), // every cached body is gone; regen the document again
});

const result = await engine.regen(document, { generation }); // null when superseded
store.subscribe((event) => engine.update(event)); // uses the event's previous document and change
```

## Where it runs

**Decision: the engine runs in the kernel worker, and the main thread makes one `regen` call per
user intent** ([ADR 0007](../../docs/adr/0007-worker-protocol.md), decisions 1 and 3). Inside the
worker it drives the kernel through `KernelService`'s batch API in-process: `feature` ops with
`applyFeature` semantics, chained by `{ result }` references, plus `resolve` and `tessellate`.

Why not drive op batches from the main thread:

- **Mid-regen kernel data.** A sketch on a face needs that face's plane on the body at that point,
  and a feature that depends on another must know whether it failed before it is attempted (it is
  then an upstream error, not run on a body its dependency never changed). From the main thread
  each of those is a round trip through structured clone; in the worker it is a function call.
- **Nothing heavy crosses the boundary.** A `feature` op's value carries the new body's whole name
  table, lineage included. In the worker nothing is cloned; the regen result keeps only statuses,
  errors, warnings and resolutions, and the viewport gets the name table of the mesh slots
  (`RegenResult.names`), not lineage. That is where the kernel README's carry-over about heavy name
  tables is resolved: the engine never forwards `FeatureOutcome.names`.
- **Shape lifetimes stay in one place.** Cached bodies are arena ids; the engine releases evicted
  ones through `KernelService.release` (never cancelled), in the same thread that owns them.
- **Cancellation is the same machinery.** Every batch carries the regen's generation; a newer regen
  cancels the older one's batches (`cancel`) and the service abandons them between ops.

The engine depends only on the `RegenKernel` interface (`run`, `release`, `cancel`, optional
`onRecycle` and `stats`), which `KernelService` satisfies as it is, so Node tests drive the real
service (`@manufakture/kernel/node`) and the real solver directly.

Not wired yet, and outside this package's footprint:

- **A worker entry that hosts the engine.** `packages/kernel/src/worker.ts` exposes only the
  kernel API. Hosting regen needs an entry that builds `createKernelWorkerApi`, waits for its
  `service`, creates the engine and exposes `{ ...kernelApi, regen }` through Comlink, marking
  mesh buffers with `regenTransferables(result)`. Either regen gets that entry (it then needs
  `comlink` as a dependency and the kernel's `.wasm?url` import), or the kernel's worker API takes
  an extension hook.
- **The solver port** (ADR 0007 decision 2): a `MessageChannel` port handed to the kernel worker,
  on which `connectSolver(port)` gives the engine its `SketchSolverApi`. Until then a host can pass
  any object with `solve`.

## Dependency graph and the dirty subgraph

`buildGraph(part, variables)` (`src/graph.ts`) has three kinds of edge from a feature to what it
needs:

- features it names by id or by face name: core's `featureDependencies` (profiles, hole sketches,
  pattern and mirror sources, `dependsOn`, and the creator of every face a reference names);
- the **body edge**: every kernel feature (extrude, revolve, fillet, chamfer, shell, hole, pattern,
  mirror, and a STEP import that is not a reference) takes the body the last active, unsuppressed kernel feature left, and so does a sketch
  placed on a face, which resolves the face on that body;
- the variables its expressions read, closed over variables that read other variables.

`dirtyFeatures(previous, next)` gives the dirty subgraph of an edit: the seeds (new or newly active
features, changed inputs ignoring the display name, a different body before them, a changed
variable they read) plus everything depending on a seed, through any edge. A variable edit dirties
only its readers and what hangs off them; a sketch edit dirties the sketch, the features built on
it, and everything later in the body chain. With a store change event, the part's
`firstAffectedIndex` bounds the comparison (features before it are not compared, and `null` means
nothing in the part is dirty). `regenOrder` and `topologicalOrder` give a dependency order that is
the document order for any valid part (core keeps dependencies earlier).

The dirty set is reported per part (`PartResult.dirty`). It is informational: the cache, not the
dirty set, decides what gets rebuilt. What actually goes to the kernel is decided by the cache: a feature whose key is cached costs nothing, so the ops sent are always a
subset of the dirty set (an expression rewritten to the same value, say `3mm` to `1mm + 2mm`, is
dirty but a cache hit).

## Translation

`translateFeature` (`src/translate.ts`) turns a core feature into a kernel input:

| Core                                 | Kernel                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `operation` new, add, cut, intersect | `mode` new, add, subtract, intersect                                                       |
| `profile` (sketch, entities?)        | one region's `regionProfile` loops on the sketch placement, every entity tagged by edge id |
| extrude `extent`, `reverse`, `draft` | the same, distances in mm, draft in radians; `upToFace` as a `FaceRef`                     |
| revolve `sketchLine` axis            | a model-space `Axis` from the line's start to its end; core's `flip: true` negates it      |
| revolve `edge` axis                  | `{ edge, flip }`, oriented by the kernel's naming rules                                    |
| fillet, chamfer, shell references    | `{ id, ref }` with the stored names; chamfer `secondDistance` / `angle` pick the size kind |
| hole `sketch`, `points`              | the sketch placement as the frame, each point entity's solved position                     |
| pattern, mirror `features`           | the source features' own kernel inputs (extrudes, revolves, holes); `body: true` the body  |
| pattern `count`                      | checked here: a whole number, 1 to `MAX_PATTERN_COUNT`, however it was computed            |

**Numbers.** Variables are evaluated once per regen, in dependency order, in the units each was
stored with (`evaluateVariables`; they have no declared kind). Every feature expression is
evaluated against the kind its field expects (`featureExpressions`: length, angle, number), which
is the dimension check core leaves to regen: `30deg` in a length field is an `expression` error with
the units error's range. An expression reading a variable that itself failed says which.

**Sketches** are solved as stored with a fresh solver system each time (`SketchSolverApi.solve`),
then split into regions (`detectRegions`). An explicit plane is normalised with
`placementFromNormal`; a face plane is resolved on the body before the sketch with a `resolve` op
and turned into a frame with the kernel's `frameOnPlane` (exactly what `sketchFrame` does), and a
fragile or non-exact resolution is a warning on the sketch. A conflict fails the sketch with the
solver's conflicting and redundant constraint ids; redundant constraints alone are a warning;
region diagnostics of warning severity (open profiles, touching loops) are warnings.

**Profiles.** Without `entities` a profile is every filled region. With `entities` it is every
region or void whose outer loop runs only along listed entities: a rectangle's four lines pick the
rectangle with its holes, and adding a hole's circle picks the disk too. Listed entities that are
gone are a `reference-lost` error on `profile`. The kernel builds one region per feature, so a
profile that selects several separate regions fails with `unsupported`.

## Cache

Every built feature's result is cached (`src/cache.ts`) under `cacheKey`: a 128-bit hash of the
canonical JSON of

- the kernel build, the naming scheme version of the document and `REGEN_IMPLEMENTATION_VERSION`
  (ADR 0004 decision 8; bump it with any change that can alter an output);
- for a kernel feature: its translated `FeatureInput` (the definition with evaluated parameters and
  resolved upstream data: profile loops, axes, pattern sources) and the key of the body it is
  applied to, which chains every upstream key;
- for a sketch: the solver build (`DEFAULT_SOLVER_BUILD`, the pinned planegcs release; pass
  `solverBuild` to override), its definition without the display name, its evaluated dimension
  values, and its plane (the placement, or the body key plus the face reference).

Equal keys mean equal results, so entries are never invalidated by hand. Failures are cached too
(they are just as deterministic), so an unrelated edit does not retry a failing fillet. An entry
holds the statuses, errors, warnings and resolutions, the solved sketch for sketches, and for
kernel features the body: its own new arena shape with the kernel instance it lives in, or
`passthrough` when the feature failed or changed nothing (the body before it is used, whatever
shape that is now).

`MemoryCache` keeps every entry the last completed regen used plus `spare` (default 64) others,
least recently used out first, so undo and toggling back are cache hits. The engine releases the
shapes of dropped entries. After a recycle every body entry is dropped (`dropBodies`).

**Stale shapes.** A recycle can still land between a cache hit (the body is now a cached shape
id) and the batch that uses it: a heap-threshold recycle queued after a batch, or a trap in
another client's batch. Every batch notes the kernel instance its concrete shape ids come from,
and before any of its results is used or cached the engine checks the reply: a reply from
another instance, an op that failed with `unknown-shape`, or a `feature` op the kernel passed
through with `no-body` and no names (what `applyFeature` returns for an unknown body id; a
`no-body` failure on a live body keeps its names) all restart the regen without the lost
bodies, up to twice. Such a batch's results are never cached, so a pass-through built on a dead
shape can never be served later.

**Persistent backend (T1.12, #935).** `FeatureCache` is the plug-in point: `get`, `set`, `retain`,
`dropBodies` and `clear` may return promises, and the engine awaits them. An OPFS tier stores what
outlives a kernel instance: statuses, errors and warnings, and solved sketches (plain data) as they
are. Kernel bodies need a serialized B-rep with its names and topology to restore from, which the
kernel cannot yet export or import; until it can, a persistent tier should return body entries
without `body`, which the engine treats as a miss.

## Errors, warnings, statuses

Per feature: `ok`, `error`, `upstream-error`, `suppressed` or `rolled-back`, with `errors`,
`warnings`, `references` (per reference id: target, `via`, `fragile`), `cached` and `ms`.

Kernel error codes map onto ADR 0007's names as the kernel README's table says: `lost` is
`reference-lost` (with `missing`), `ambiguous` is `reference-ambiguous` (with the sorted
`candidates` to offer), `unnamed` is `unnamed-face`, `kernel` keeps `occtMessage`; `invalid`,
`invalid-shape`, `no-body`, `empty` and `unsupported` keep their codes. A reference error carries
the core reference id (a kernel field name such as `extent`, `axis`, `direction` or `plane` is
mapped back to the id of the reference that field holds), a message ending in "re-pick it", and the
reference's `lastResolved` hint when it has one. Missing sketch geometry (a profile entity, an axis
line, a hole point) is `reference-lost` on `profile`, `axis` or `points`. Kernel warnings map the
same way: `reference` (with `via` and `fragile`, for `ends`, `descendant`, `ancestor`, ordinal and
fragile resolutions), `missed` and `direction`. Regen adds `expression`, `sketch` and `upstream`
errors, and `sketch`, `redundant`, `extension` and `reference-body` warnings.

**Propagation.** A failed feature is skipped: the kernel passes the body through, so independent
later features still build on it. A feature naming a failed, suppressed or upstream-errored feature
(by id or through a face name) is `upstream-error` and never reaches the kernel. An op that fails
as a whole (a wasm trap) leaves no body; kernel features after it are upstream errors, and the
recycle that follows is reported through `onKernelRecycled`.

**Suppression and rollback.** A suppressed feature is skipped and leaves the body chain; its
dependents are upstream errors. Features at or after the part's `rollbackIndex` are not evaluated
and are reported `rolled-back`.

## Cancellation

`regen(document, { generation })` takes the caller's generation (default: one more than the newest
the engine or the kernel has seen). A regen whose generation is not newer than one already
requested resolves to null at once. A newer regen cancels the running one's kernel batches, which
the service abandons between ops (releasing what they made); the older regen stops at its next
await and resolves to null.

`KernelService.cancel(generation)` cancels every batch up to that generation, whoever sent it:
generations are one sequence shared by every client of the kernel (ADR 0007 decision 4), not one
per client. So when the engine is wired into apps/web, its `cancel(older)` also abandons other
clients' batches (`pick`, `measure`) with generations up to `older`; those clients must send the
current generation and treat a `cancelled` reply as "ask again". Regens run one at a time, so they never race on the cache; results a
superseded regen did finish stay cached for the next one.

## Result

```ts
interface RegenResult {
  generation: number;
  names: string[]; // one name table for every mesh in the result
  parts: PartResult[]; // per part: features, dirty, shape, bodyKey, meshChanged, mesh
  counters: RegenCounters; // featureOps, otherOps, batches, solves, cacheHits, cacheMisses
  ms: number;
}
```

A part's `mesh` is sent only when its body differs from the one last reported (`meshChanged`); its
name slots index `names`. `shape` is the final body's arena id for `pick` and `resolve` ops, valid
until a later regen evicts it or the kernel recycles. `regenTransferables(result)` lists the mesh
buffers for `Comlink.transfer`.

## Tests

```sh
pnpm --filter @manufakture/regen test
```

- `graph.test.ts`: edges, body chain with suppression and rollback, variable closure, topological
  order, and the dirty subgraph for renames, variable edits (through variables), feature edits,
  suppression, reorder, rollback and `firstAffectedIndex`.
- `engine.test.ts`: the engine against a scripted kernel and solver: ops sent, cache hits on
  unrelated edits, same-value rewrites, eviction and release, undo from spare entries, upstream
  versus independent failures, cached failures, reference errors and warnings, sketch conflicts,
  dimension checks, pattern counts from expressions, suppression, rollback, cancellation of a
  running batch, stale generations, recovery from a recycle (the fake kernel answers a dead body
  as the real one does, with a feature-level `no-body` pass-through), no caching of such a
  pass-through, sketch keys per solver build, sketches on faces.
- `translate.test.ts`, `values.test.ts`, `cache.test.ts`: profile selection, revolve axes and
  `flip`, holes, patterns, expressions and units, keys and the memory cache.
- `integration.test.ts`: the real kernel (node harness) and the real planegcs solver, driven by a
  `DocumentStore`. A sketch, an extrude and a fillet whose radius variable nothing else reads:
  editing the variable sends exactly one `feature` op (the fillet) with the sketch and extrude from
  the cache; undo sends none; widening the base sketch rebuilds all three and the fillet resolves
  exactly to the same named edge, whose round face has moved to the new corner (checked on the
  mesh), with the volume checked each time; a rename sends nothing; a regen whose batch is running
  in the kernel is cancelled by a newer one; a recycle is recovered, including one that runs
  between a cache hit and the batch using its shape (the regen retries, and the next regen serves
  an `ok` fillet from the cache, not a `no-body` failure); nothing leaks.

## Deviations and gaps

- **`FeatureResult`** extends ADR 0007's first cut with `status`, `warnings`, `cached`, `ms` and
  `kind`, and its references are `ReferenceResolution`s. Errors carry a `message` each.
- **Meshes per part**, not per body id: a part is one body (a compound) until multi-body parts (M2).
- **One region per profile**, a kernel limit (see above).
- **Hole points** must be point entities.
- **Extension features** change no geometry yet; they are `ok` with an `extension` warning.
- **Imports.** A STEP import with operation `new`, `add`, `cut` or `intersect` is a kernel feature
  like an extrusion: it is translated to the kernel's `import` input with the document's base64
  text passed as is, and its faces are named `import#k:face:<n>` (always fragile). A file the kernel
  cannot read fails that feature (`invalid`) and the body passes through. A `reference` import (and
  every STL import, which the schema only allows as a reference) is not part of the body: regen
  sends nothing to the kernel for it and reports it `ok` with a `reference-body` warning. The app
  shows and measures reference bodies from the file itself. Patterning or mirroring a reference
  import is `unsupported`.
- **Import integrity.** Before a combining import is first built, regen checks that `data`
  decodes to `size` bytes whose SHA-256 is the stored `sha256` (`src/imports.ts`); a mismatch
  fails that import (`invalid`, field `source.sha256`) and nothing goes to the kernel. The check
  runs once per source object (documents share unchanged objects between edits), not on every
  regen. Regen rather than document load does it: load is a synchronous schema check and would
  hash every import, reference ones included, on every open. Once checked, the cache key holds
  the import's `sha256` and `size` instead of the base64 text, so a regen never hashes a 20 MB
  file again (about 80 ms each time).
- **Chamfer reference faces** are left to the kernel's default (the adjacent face whose name sorts
  first); core stores none.
- **Kernel build identity**: the kernel exports none, so `DEFAULT_KERNEL_BUILD` names the pinned
  libcascade release; pass `kernelBuild` to override.
