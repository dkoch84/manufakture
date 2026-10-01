# @manufakture/regen

The regeneration engine: turns a core document (`packages/core`) into geometry through the kernel
(`packages/kernel`), rebuilding only what an edit changed. It evaluates expressions
(`packages/units`), solves sketches (`packages/sketch`), translates every core feature into a kernel
`FeatureInput`, caches each feature's result, and reports per feature a status, errors, warnings,
reference resolutions and timing, plus every final body's mesh and one name table for the
viewport. A part carries a set of bodies (M2 plan, decisions 1 to 3), and an edit rebuilds only the
features of the bodies it touches. After the parts, it places the instances of every assembly with
the mate solver of `packages/assembly` ([ADR 0008](../../docs/adr/0008-assembly-mate-solver.md)),
and it answers assembly previews, drags and interference checks (see Assemblies).

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
const preview = await engine.solveAssembly(draft, 'assembly#1', { generation }); // a mate dialog
const step = await engine.drag('assembly#1', 'inst#2', target, { generation }); // coalesced
const clash = await engine.interference('assembly#1', { generation, onPair }); // on demand
```

That is the engine's own API, as tests and a custom host use it. apps/web does not construct an
engine: it spawns the regen worker (`@manufakture/regen/worker`) through `spawnRegenWorker` and
calls `RegenClient.regen(document)` (see "The worker").

## Where it runs

**Decision: the engine runs in the kernel worker, and the main thread makes one `regen` call per
user intent** ([ADR 0007](../../docs/adr/0007-worker-protocol.md), decisions 1 and 3). Inside the
worker it drives the kernel through `KernelService`'s batch API in-process: `feature` ops with
`applyFeature` semantics on the bodies each feature reads, plus `resolve`, `connector` and
`tessellate`. The next
feature's cache key depends on what the previous one did to the body set (which bodies it made,
changed or merged away), so every `feature` op is its own batch; in the worker a batch costs no
structured clone.

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

### The worker

| Import                      | Where        | What                                                                                           |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `@manufakture/regen`        | worker, Node | the engine, graph, translation, cache, `createRegenWorkerApi`                                  |
| `@manufakture/regen/worker` | worker entry | `Comlink.expose` of the regen worker API, with the kernel's `.wasm` imported as a `?url` asset |
| `@manufakture/regen/client` | main thread  | `spawnRegenWorker()`, `RegenClient`                                                            |

`createRegenWorkerApi` (`src/worker-api.ts`) builds the kernel's worker API (`createKernelWorkerApi`: loading with progress, batches, release, cancel, recycle, stats), waits for its service, creates the engine next to it and adds `regen(document, { generation })`, `solveAssembly(document, assemblyId, { generation })`, `dragInstance(assemblyId, instanceId, target, { generation })`, `interference(assemblyId, { generation, mesh?, tolerance? }, onPair?)`, `cancelInterference(assemblyId)` and `regenStats()`. `RegenClient.solveAssembly`, `RegenClient.dragInstance` and `RegenClient.interference` send the client's current generation (`latestGeneration`), never a new one, so none of them cancels a regen. `interference`'s `onPair` is a `Comlink.proxy` passed as an argument of its own (Comlink only looks for proxies in top-level arguments); each pair's mesh buffers are transferred with it. Mesh buffers are marked with `regenTransferables(result)`; nothing else heavy crosses. `RegenClient` extends the kernel's `KernelClient` (imported from `@manufakture/kernel/kernel-client`, so the kernel's own worker entry is not bundled), so every request of every kind (a regen, a `pick`, a `measure`, an export) takes its generation from the one sequence the client keeps. The service cancels by generation whoever sent a batch (see Cancellation), so a regen cancels older requests, and a pick or measure sent at the client's current generation never cancels a regen. Only a regen may take a new generation: any other batch that did (a STEP import, say) would cancel the regen in flight, which then resolves to null with nothing reporting in its place, so the app sends every other batch at `latestGeneration` and releases shapes with `KernelClient.release`, outside the batch queue. The app's `startRegen` also asks again when its newest regen comes back null. A pending regen resolves to null when the worker is restarted or terminated, like a pending submit. `RegenClient.regen` returns every regen the worker completed, even when a newer request came meanwhile: the engine reports a changed mesh once, to the regen that built it, so a caller that dropped completed results would lose meshes.

After a recycle every body is gone. The engine only forgets (its hook runs inside the service's queue, where nothing may be submitted); the main thread hears of it through the kernel's `recycled` status and asks for a regen of its current document (apps/web `kernelLoader`). A worker restart is handled the same way, through the client's `onRestarted` option. Imported STEP reference bodies are not part of a regen, so the app reads them again from the files their import features store.

**In apps/web.** `kernelLoader` (`apps/web/src/viewport/scenes.ts`) spawns the regen worker, and
`kernelRegenerator` (`apps/web/src/model/kernelModel.ts`) wraps its `RegenClient`: it skips a
completed result no newer than the last one it applied, keeps each body's last mesh (the engine sends one only
when the body changed), and registers each body's `shape` for measuring, exporting and picking. Until
the app shows bodies as such (T2.1d), a part's first body has the part id as its viewport id and
every other body is `<part id>/<body id>`.
`startRegen` (`apps/web/src/model/model.ts`) asks for one regen of the whole document on every
document change and after every recycle or restart, applies a result only when it is newer than
the one shown, and asks again, up to three times, when its newest regen comes back null. The
client's `regen` sends the document and a generation only, not the store's previous document and
change, so in the app the engine finds the dirty subgraph by comparing with the document of its
last completed regen (see below). For assemblies, `kernelRegenerator` keeps the meshes of pinned
sources like those of parts and registers every body an instance shows under
`<assembly id>/<instance id>/<body id>` with its source body's shape, so a pick on an instance
becomes a stored reference like a pick on a part; the assembly workspace previews mates with
`RegenClient.solveAssembly`, drags instances with `dragInstance` and checks interference with
`interference` (the loader's `assembler`).

**Decision: the sketch solver runs in the regen worker, in-process**, as a `SolverService` loading planegcs on the first sketch solve, instead of on a `MessageChannel` port to the solver worker (ADR 0007 decision 2, amended there):

- the engine awaits every solve before its next kernel op, so a solver in another worker buys no parallelism, only a round trip per sketch;
- the solver worker is the sketcher's, started lazily on the first sketch and disposed with the app; a regen of an opened document would otherwise have to start it and couple its lifetime to the kernel's;
- regen solves are stateless (a fresh system per solve), so they share nothing with the sketcher's interactive sessions anyway, and a planegcs abort is contained by `SolverService`, which discards the poisoned instance without touching the kernel's;
- the cost is planegcs's 0.5 MB `.wasm` loaded a second time, in this worker, when the first sketch is regenerated.

Pass `solver` to `createRegenWorkerApi` to use another (a `connectSolver` proxy on a port, in tests a fake).

## Dependency graph and the dirty subgraph

`buildGraph(part, variables)` (`src/graph.ts`) has three kinds of edge from a feature to what it
needs:

- features it names by id or by face name: core's `featureDependencies` (profiles, hole sketches,
  pattern and mirror sources, `dependsOn`, the creator of every face a reference names, and the
  creator of every body in its `scope`);
- the **body edges**, one per body it reads: a feature depends on the last active, unsuppressed
  kernel feature that changed each body it reads (see below), and so does a sketch placed on a
  face, which resolves the face on the body it lies on;
- the variables its expressions read, closed over variables that read other variables.

**Which bodies a feature reads** (`bodyUse`, `routeBodies`): with a `scope`, the bodies it lists;
without one, every body at that point (an `add`, a cut, a hole, a pattern or mirror of bodies),
which is exactly the M1 chain; plus, for every reference, the bodies it lies on. Fillets, chamfers
and shells read only the bodies their references lie on (a shell removing no face, a closed hollow,
reads every body). A `new` extrusion, revolution or import reads only the bodies its references lie
on (an up-to-face face, an edge axis; a through-all extrusion reads every body, since its length is
measured against them), so a blind `new` feature reads none: a body made later does not depend on
the bodies before it. A pattern or mirror of features reads what the features it repeats read,
plus its own reference.

**Which body owns a face name.** Face names never include a body id. Each body keeps the set of
features it `carries`: the feature that made it, every feature that changed it, and everything the
bodies merged into it carried. A reference goes to the bodies that carry one of the feature ids of
every name in it (`featureIdsInName`), so a fillet after a merge finds the faces of a consumed body
on the body they went into. A reference that no body carries is sent every body, so the kernel
reports it `lost` exactly as it would have on one body, never on the wrong one. The engine routes
on the bodies the kernel really returned; the graph routes on an estimate from the document (a
`new` feature makes a body under its id; a feature changes the bodies in its scope, or all of them;
an `add` may merge them), which errs towards more edges.

`dirtyFeatures(previous, next)` gives the dirty subgraph of an edit: the seeds (new or newly active
features, changed inputs ignoring the display name, different body edges, a changed
variable they read) plus everything depending on a seed, through any edge. A variable edit dirties
only its readers and what hangs off them; a sketch edit dirties the sketch, the features built on
it, and the features that read the bodies it changes. With explicit scopes, an edit to one body
leaves the features of the others clean; without scopes, an unscoped feature reads every body, so
everything after it is dirty, as in M1. The comparison is always with the document of the
engine's last completed regen. With a store change event (`update`, or `regen` given `previous`
and `change`) whose previous document is that one, the part's `firstAffectedIndex` bounds the
comparison (features before it are not compared, and `null` means nothing in the part is dirty);
the worker's `regen` takes no change, so it compares whole parts. `regenOrder` and `topologicalOrder` give a dependency order that is
the document order for any valid part (core keeps dependencies earlier).

The dirty set is reported per part (`PartResult.dirty`). It is informational: the cache, not the
dirty set, decides what gets rebuilt. What actually goes to the kernel is decided by the cache: a feature whose key is cached costs nothing, so the ops sent are always a
subset of the dirty set (an expression rewritten to the same value, say `3mm` to `1mm + 2mm`, is
dirty but a cache hit).

## Translation

`translateFeature` (`src/translate.ts`) turns a core feature into a kernel input:

| Core                                 | Kernel                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `operation` new, add, cut, intersect | `mode` new, add, subtract, intersect                                                        |
| `profile` (sketch, entities?)        | one region's `regionProfile` loops on the sketch placement, every entity tagged by edge id  |
| extrude `extent`, `reverse`, `draft` | the same, distances in mm, draft in radians; `upToFace` as a `FaceRef`                      |
| revolve `sketchLine` axis            | a model-space `Axis` from the line's start to its end; core's `flip: true` negates it       |
| revolve `edge` axis                  | `{ edge, flip }`, oriented by the kernel's naming rules                                     |
| fillet, chamfer, shell references    | `{ id, ref }` with the stored names; chamfer `secondDistance` / `angle` pick the size kind  |
| hole `sketch`, `points`              | the sketch placement as the frame, each point entity's solved position                      |
| pattern, mirror `features`           | the source features' own kernel inputs (extrudes, revolves, holes); `body: true` the body   |
| pattern, mirror `body: true`, `mode` | `source: { type: 'body', mode }`; no `mode` when the document has none (the kernel's `add`) |
| `derived`                            | `derive` of the pinned source part's bodies (see Derived parts); placement in mm, radians   |
| pattern `count`                      | checked here: a whole number, 1 to `MAX_PATTERN_COUNT`, however it was computed             |
| `scope`                              | the same list; an entry that is not a body at that point is `reference-lost` on `scope`     |
| body id of a `new` or `add` feature  | `body`: the feature's own id (M2 plan, decision 1)                                          |

**Numbers.** Variables are evaluated once per regen, in dependency order, in the units each was
stored with (`evaluateVariables`; they have no declared kind). Every feature expression is
evaluated against the kind its field expects (`featureExpressions`: length, angle, number), which
is the dimension check core leaves to regen: `30deg` in a length field is an `expression` error with
the units error's range. An expression reading a variable that itself failed says which.

**Sketches** are solved as stored with a fresh solver system each time (`SketchSolverApi.solve`),
then split into regions (`detectRegions`). An explicit plane is normalised with
`placementFromNormal`; a face plane is resolved on the body it lies on before the sketch with a `resolve` op
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
  resolved upstream data: profile loops, axes, pattern sources) and the id and key of every body
  it reads (see the graph section), not of the whole body set, so an edit to one body is a cache
  hit for the features of the others. A body's key is the key of the feature that last changed it
  plus its id, which chains every upstream key of that body;
- for a derived feature: its `derive` input with each source body's id and key in place of its
  shape id, so it is keyed by what the source built, not by where it lives in the arena;
- for a feature of a derived part's source: the source document's naming scheme and a
  `namespace` (`sourceNamespace`: the pin's `sha256` and part id) besides the usual fields, so
  every derived feature of one pinned part, in any part and in any regen, shares its entries;
- for a sketch: the solver build (`DEFAULT_SOLVER_BUILD`, the pinned planegcs release; pass
  `solverBuild` to override), its definition without the display name, its evaluated dimension
  values, and its plane (the placement, or the keys of the bodies the face may lie on plus the
  face reference).

Equal keys mean equal results, so entries are never invalidated by hand. Failures are cached too
(they are just as deterministic), so an unrelated edit does not retry a failing fillet. An entry
holds the statuses, errors, warnings and resolutions, the solved sketch for sketches, and for
kernel features the per-body outcome (`CachedOutcome`): the bodies it made or changed, each with
its own new arena shape and solid count, the bodies it merged away, and the kernel instance the
shapes live in. Both lists are empty when the feature failed or changed nothing: every body keeps
its shape. A hit applies the outcome to the body set exactly as the kernel's reply was applied.

`MemoryCache` keeps every entry the last completed regen used plus `spare` (default 64) others,
least recently used out first, so undo and toggling back are cache hits. The engine releases the
shapes of dropped entries. After a recycle every body entry is dropped (`dropBodies`).

**Stale shapes.** After the part loop, every part's bodies must come from the kernel instance of
the run's latest reply: a part built only from cache hits holds a shape id from before a recycle
that landed during another part's batch, and nothing in its own (empty) batch would notice. Such a
run restarts like any other stale batch.

A recycle can also land between a cache hit (the body is now a cached shape
id) and the batch that uses it: a heap-threshold recycle queued after a batch, or a trap in
another client's batch. Every batch notes the kernel instance its concrete shape ids come from,
and before any of its results is used or cached the engine checks the reply: a reply from
another instance, an op that failed with `unknown-shape`, or a `feature` op the kernel passed
through with `no-body` and no names (what `applyFeature` returns for an unknown body id; a
`no-body` failure on a live body keeps its names) all restart the regen without the lost
bodies, up to twice. Such a batch's results are never cached, so a pass-through built on a dead
shape can never be served later.

**Persistent tier: allowed, not built.** `MemoryCache` is the only cache there is, so a reload
regenerates from the document (document persistence in apps/web stores no regen cache; see
`apps/web/src/persistence/README.md`). `FeatureCache` leaves room for one: `get`, `set`, `retain`,
`dropBodies` and `clear` may return promises, and the engine awaits them. Such a tier (in OPFS,
say) could store what outlives a kernel instance as it is: statuses, errors and warnings, and
solved sketches (plain data). Kernel bodies are the hard part. The kernel does read and write STEP
(`exportStep` and `importStep`, `packages/kernel/src/exchange.ts`), but STEP keeps only a product
name per body and none of the face, edge and vertex names that later features and references
resolve against; restoring a body needs a B-rep format that keeps its names and topology, which
the kernel does not have. Until it does, a persistent tier should return body entries without
`body`, which the engine treats as a miss.

## Derived parts

A `derived` feature (core README, "Derived parts") carries its source document at a pinned
version as canonical JSON text. Regen builds it in four steps (`src/derived.ts`, the engine's
`#derivedBodies`):

1. **Open the pin.** The UTF-8 bytes of `data` must be `size` long and hash to `sha256`; this is
   checked once per source object, as for imported files. The text is read with core's
   `deserialize`, which migrates an older format in memory; a newer format, text that is not a
   document, and a `partId` the document does not have are each a `source` error on the feature
   (`field` `['source', 'sha256']`, `['source', 'data']` or `['source', 'partId']`); so is text on
   which reading throws, which never fails the regen. A read document is kept by hash while
   regens use it, so an edit elsewhere never parses it again.
2. **Check the nesting, before building anything.** A source may derive from another source, and
   so on. Regen walks the chain (the active, unsuppressed derived features of each part it would
   build), opening each source but building none, and refuses one that nests deeper than
   `MAX_DERIVED_DEPTH` (8): the feature fails with `source` on `['source']` and nothing of the
   chain reaches the kernel. The walk stops at that depth, so a hostile chain costs at most eight
   openings; the height of each (hash, part) is memoized. A source that cannot be opened counts as
   one level, since it fails on its own when its turn comes.
3. **Regenerate the source part** in the same kernel, by the same engine, with the source
   document's own variables and naming scheme, under its cache namespace (see Cache). Every
   derived feature of that part in the regen uses this one build; across regens, an unchanged
   pin is all cache hits. The source's features are not reported; features of it that failed
   give the derived feature a `derived-source` warning listing them (from the kernel and from the
   cache alike), and its bodies are what it built without them. A kernel failure as a whole in
   the source is a `source` error.
4. **Derive.** The listed `bodies` (absent: every body of the source part, in its creator order)
   go to the kernel's `derive` input with the placement. A listed body the source does not have
   at that version (merged away, or never made) is `reference-lost` on `bodies` with `missing`,
   and a source with no bodies is `no-body`. The kernel names the copies `<id>:from/<source
body id>` and their faces `<id>:from/<source face name>` (kernel README, "Derived bodies"),
   which core's name parser reads as depending on the derived feature only.

**Updating a pin** (a new `source` with another version) is a new `sha256`, so a new namespace:
the source is built afresh, while a fillet on a derived edge keeps its reference, which names
source features, not positions, and resolves `exact` wherever the edge still exists.

**Body properties.** A derived body's name, colour and material in its source (its own, else
the source part's material) carry over to `BodyResult.inherited`, field by field, unless the
deriving part sets that field for the body itself in `Part.bodies`. The app shows the body's
own settings, then these, then the deriving part's material.

**Recycles.** A nested build adds shapes to the same heap, so a recycle can land between the
source build and the derive. Source bodies take part in the stale-shape check like any body the
batch reads (see Cache), and a derive whose source shape is unknown fails with `no-body` on
`sources`, which the engine treats as stale too: the regen restarts, rebuilding the source on
the new instance, and nothing built on the dead shapes is cached.

## Assemblies

After the parts, every assembly of the document is placed (`src/assembly.ts`, the engine's
`#assembly`), in four steps:

1. **What each instance shows.** A part of this document is its `PartResult`, as regenerated, the
   rollback bar included; when the bar is not at the end the instance has a `rollback` warning. A
   pinned part of another document is opened, depth-checked and built exactly like a derived
   feature's source (see Derived parts), and shared with any derived feature of the same pin; its
   bodies, with meshes, are reported once in `RegenResult.sources` under the key
   `source:<sha256>:<part id>`, which the instance names (`InstanceResult.source`). A source that
   cannot be built is a `source` error on the instance; features of it that failed are a
   `derived-source` warning. The instance shows the bodies it lists (`bodies`; absent: all), and a
   listed body the part no longer has is `reference-lost` on `bodies`. Instances reuse their
   source's body meshes: no copies, no meshes per instance.
2. **Connector frames.** Each connector of an unsuppressed mate is found on the bodies its
   instance shows (a body the instance hides is not looked at) by the kernel's `connector` op
   (kernel README, "Mate connectors"), one op per body for every frame not found before, in one
   batch. Of the bodies' reports (`pickReport`), an exact match wins over any other rule; several
   equally good matches on different bodies (a face split into two bodies since) are
   `reference-ambiguous` with the body ids as candidates, never a silent pick of one. Frames are cached in the engine by body key
   and reference: plain data, valid for as long as the body is the same (a recycle does not lose
   them), kept for the frames the last regen used. So an unchanged assembly, and a pose-only change
   (core's `posesOnly`), costs no kernel op at all; an edit of one part finds only the frames on
   its bodies again. `flip`, `rotate` and the evaluated `offset` are applied to the frame in regen.
3. **Errors per mate.** A connector that does not resolve (`reference-lost`, `reference-ambiguous`
   with its candidates, `invalid` for a point the inference cannot take), an offset or limit that
   does not evaluate (`expression`), or an instance that could not be built (`upstream`) makes the
   mate `error`, with a message ending in "re-pick it" for references. Such a mate never reaches the
   solver, so its instances are free of it and the rest of the assembly still solves (M2 plan,
   T2.3c risks). A suppressed mate, and a mate on a suppressed instance, is `suppressed`.
   Suppressed instances are not solved and keep their stored pose.
4. **The solve.** Instances with their stored poses (the seeds, ADR 0008 decision 3) and the mates
   that got both frames, in creation order, go to `solve`. Its report fills `AssemblyResult`: the
   outcome, DOF, redundant and conflicting groups (blaming the newest mate), issues and warnings,
   and per mate the solver's status, free coordinates and residual. Per instance, the solved
   `transform` and `moved`, whether it differs from the stored pose.

**Previews.** `solveAssembly(document, assemblyId)` runs the same steps on a document that has not
been committed (a mate dialog, before OK): the parts are built through the cache, so when only the
assembly changed they are all hits, and nothing is reported to later regens (no meshes, no
`#reported` change, drags keep the last regen's state). The dialog then commits the mate and the
poses of the instances that `moved` in one `batch`.

**Drags.** `drag(assemblyId, instanceId, target)` (`dragInstance` on the worker) is one step of a
pointer drag: the solver's `drag` on the solver input the last regen built, seeded with where the
previous step left the instances. It needs no kernel work, so it never waits for a regen. Steps are
coalesced: a step that has not started when a newer one arrives resolves to null, and only the
latest target is solved (the engine yields to the event loop before each step, so pointer moves
queued behind it replace it). A step older than the newest regen, or for an assembly the last regen
does not have, is null too. `DragResult.moved` lists the instances whose pose now differs from the
document's: commit them with `setPoses` on release, never per step. A drag that commits nothing (cancelled,
or nothing moved) calls `endDrag(assemblyId)` (`RegenClient.endDrag`), so the next drag starts
from the last regen's poses again rather than from where the last step left them.

**Interference.** `interference(assemblyId, { generation, mesh?, tolerance?, onPair? })`
(`RegenClient.interference`) lists the pairs of instances whose bodies overlap, with the overlap's
volume (and its mesh, in world coordinates, with `mesh`). It is on demand only and never part of a
regen: the pairwise booleans are the costly part. It checks what the last regen placed: every
completed regen keeps, per assembly, the bodies each unsuppressed instance shows (live shape ids
from the cache, with the kernel instance they live in) next to the drag state, and the poses are
the drag state's, so an instance being dragged is checked where the screen shows it. The check
runs on the regen chain, after any regen in flight, so no regen can evict those bodies while it
runs. One batch runs the kernel's bounding-box prefilter over every instance (`prefilterOnly`),
then one batch per candidate pair (kernel README, "Interference"); each pair goes to `onPair` as
it is found (awaited, so from the worker every pair reaches the main thread before the report),
and the report lists them again (without meshes when they were streamed). Cancellation: the check
takes the client's current generation, so it never cancels a regen; a newer regen supersedes it
between two pairs (it resolves to null); `cancelInterference(assemblyId)` stops it before its next
pair with a `cancelled` report and the pairs found so far; bodies lost to a recycle give a `stale`
report (check again after the next regen). A request older than the newest regen, or for an
assembly the last regen does not have, is null.

**Configuration rows** (`source.configuration`) are not applied yet (T2.4c): the instance shows the
part as it is, with a `configuration` warning. Instance sources are grouped by
`instanceSourceKey`, which T2.4c extends with the row, so two instances at two rows get two builds
and their bodies two keys; the connector cache already keys on body keys.

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
fragile resolutions), `missed` and `direction`. Regen adds `expression`, `sketch`, `upstream` and
`source` errors, and `sketch`, `redundant`, `extension`, `reference-body` and `derived-source`
warnings.

**Propagation.** A failed feature is skipped: the kernel passes the bodies through, so independent
later features still build on them. A feature naming a failed, suppressed or upstream-errored feature
(by id or through a face name) is `upstream-error` and never reaches the kernel. An op that fails
as a whole (a wasm trap) leaves no body; kernel features after it are upstream errors, and the
recycle that follows is reported through `onKernelRecycled`. A `scope` entry that is not a body
at that point (merged into another, or never made) fails the feature with `reference-lost` on
`scope` before anything is sent.

**Suppression and rollback.** A suppressed feature is skipped and changes no body; its
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
per client. So the engine's `cancel(older)` also abandons other batches (`pick`, `measure`, STEP
import and export) with generations up to `older`. In apps/web every request goes through the
one `RegenClient` and its one generation sequence: only a regen takes a new generation, every
other batch is sent at `latestGeneration` (`apps/web/src/io/exchange.ts`), and a regen that comes
back null is asked for again (see "The worker"). Regens run one at a time, so they never race on
the cache; results a superseded regen did finish stay cached for the next one.

## Result

```ts
interface RegenResult {
  generation: number;
  names: string[]; // one name table for every mesh in the result
  parts: PartResult[]; // per part: features, dirty, bodies, consumed
  assemblies?: AssemblyResult[]; // per assembly (always set by the engine; see Assemblies)
  sources?: SourceResult[]; // pinned parts instances show: key, pin details, bodies with meshes
  counters: RegenCounters; // featureOps, otherOps, batches, solves, cacheHits, cacheMisses
  ms: number;
}

interface PartResult {
  partId: string;
  features: FeatureResult[];
  dirty: string[];
  bodies: BodyResult[]; // after the last feature, in creator order
  consumed: { bodyId: string; featureId: string }[]; // bodies an `add` merged away
}

interface BodyResult {
  bodyId: string; // `extrude#3`, `pattern#2:i3`: named after the feature that made it
  creator: string; // that feature
  shape: ShapeId;
  bodyKey: string;
  solids: number; // a cut can leave a body in several pieces
  meshChanged: boolean;
  mesh: MeshData | null;
  topology: Topology | null;
  inherited?: BodyPropsFields; // derived bodies: name, colour, material from the source
}
```

```ts
interface AssemblyResult {
  assemblyId: string;
  outcome: 'solved' | 'conflicting' | 'invalid'; // the solver's
  dof: number | null; // null while mates conflict
  instances: InstanceResult[]; // status, source ({ part } or { source: key }), bodies, transform, moved
  mates: MateResult[]; // status (the solver's, or `error`), coordinates, residual, connectors, errors
  redundant: MateGroup[];
  conflicting: MateGroup[]; // { mates, blame, message }: blame is the newest mate
  issues: AssemblyIssue[];
  warnings: AssemblyWarning[]; // outside-limits, ...
  message?: string;
  ms: number;
}
```

A `MateResult`'s `connectors` give each connector's frame in its instance's coordinates (after
flip, rotate and offset) and how its origin resolved, for drawing connectors and re-pick prompts.
Sources' body meshes follow the same once-per-change rule as parts' and are transferred too.

A body's `mesh` is sent only when it differs from the one last reported under that part and body
id (`meshChanged`), so an edit to one body sends one mesh; its name slots index `names`. Its
`topology` (faces with their planes and normals, edges with their faces, vertices; numbered like
the mesh) comes with it, in the same batch, for edge picking, vertex markers and sketch planes on
faces. A sketch's result carries the `placement` it was solved on, so the app draws and edits a
sketch on a face where regen put it. `shape` is the body's arena id for `pick`, `resolve` and
`measure` ops, valid until a later regen evicts it or the kernel recycles. Body ids follow the
kernel's convention (M2 plan, decision 1), in the ops regen sends as in the result. A part whose
kernel failed as a whole has no bodies. `regenTransferables(result)` lists the mesh buffers of
every body for `Comlink.transfer`.

## Tests

```sh
pnpm --filter @manufakture/regen test
```

- `graph.test.ts`: edges, body edges with suppression and rollback, variable closure, topological
  order, and the dirty subgraph for renames, variable edits (through variables), feature edits,
  suppression, reorder, rollback and `firstAffectedIndex`; per-body dirty sets (an edit to body 2
  leaves body 1's fillet clean with a scoped cut between them, not with an unscoped one) and
  references routed through a merge.
- `engine.test.ts`: the engine against a scripted kernel and solver: ops sent, cache hits on
  unrelated edits, same-value rewrites, eviction and release, undo from spare entries, upstream
  versus independent failures, cached failures, reference errors and warnings, sketch conflicts,
  dimension checks, pattern counts from expressions, suppression, rollback, cancellation of a
  running batch, stale generations, recovery from a recycle (the fake kernel answers a dead body
  as the real one does, with a feature-level `no-body` pass-through), no caching of such a
  pass-through, a part served from the cache while a recycle lands during another part's batch,
  topology sent with a changed mesh only, sketch keys per solver build, sketches on faces and the
  placement they report; with two bodies, the bodies each feature op gets, the ops sent per edit, a
  mesh only for the changed body, scoped versus unscoped features, consumed bodies and references
  routed to the body they merged into, and a scope naming a missing body; derived features: a
  damaged pin, two derived features of one source building it once, an unrelated edit all cache
  hits, a pin update rebuilding only that source, unreadable, newer-format and part-less sources,
  a lost source body, `derived-source` warnings, carried body properties, a chain one level too
  deep refused before anything is built (and one at the limit built), and a recycle between the
  source build and the derive.
- `derived.test.ts`: every derived name form read by core's parser as depending on the derived
  feature alone, hashing once per source object, document reuse by hash, the nesting walk, and
  body properties.
- `translate.test.ts`, `values.test.ts`, `cache.test.ts`: profile selection, revolve axes and
  `flip`, holes, patterns, scopes and body ids, expressions and units, keys and the memory cache.
- `worker-api.test.ts`: the regen worker through Comlink on a real `MessageChannel` with the real
  kernel and solver: a named mesh with its topology and sketch placements, buffers transferred
  (detached in the worker), a measure at the current generation next to regens, a newer regen
  superseding an older one, a regen after a recycle rebuilding on the new instance, and a mesh per
  body, transferred, sent only for the body an edit changed.
- `integration.test.ts`: the real kernel (node harness) and the real planegcs solver, driven by a
  `DocumentStore`. A sketch, an extrude and a fillet whose radius variable nothing else reads:
  editing the variable sends exactly one `feature` op (the fillet) with the sketch and extrude from
  the cache; undo sends none; widening the base sketch rebuilds all three and the fillet resolves
  exactly to the same named edge, whose round face has moved to the new corner (checked on the
  mesh), with the volume checked each time; a rename sends nothing; a regen whose batch is running
  in the kernel is cancelled by a newer one; a recycle is recovered, including one that runs
  between a cache hit and the batch using its shape (the regen retries, and the next regen serves
  an `ok` fillet from the cache, not a `no-body` failure); nothing leaks. A two-body part (two
  blocks, each with its own fillet): editing one body's width or radius sends only that body's
  features, the other body keeps its shape, and the volumes are checked per body. The M1 bracket
  fixture (`packages/core/src/fixtures/v5-bracket.json`, no scopes) regenerates to one body with
  the volume and face names the one-body regen gave. Derived parts: the M1 bracket derived at a
  placement with a fillet on one of its edges, whose pin is then updated to a version where
  `#thickness` is 8 mm; the fillet resolves `exact` to the same named edge, and the volume and the
  round's extent are checked at both versions. A cut with the derived bracket, with a recycle
  forced between the source build and the derive; nothing leaks.

- Assemblies (`engine.test.ts`, "assemblies", against the scripted kernel): frames found once
  per body and a pose-only change re-solved with no kernel op; frames kept across a recycle; a lost
  connector, a limit that does not evaluate and suppression per mate, the lost mate leaving its
  instance free; rollback and configuration warnings and a pinned instance's source; drags
  coalesced, answered while the kernel is busy, dropped when stale, stopped at a slider limit.
  With the real kernel (`integration.test.ts`): a lid hinged on a box resolves to the expected
  transform (DOF 1), follows an edit of the lid's depth with only the lid's frame found again, and
  a burst of drags opens it 90 degrees about the hinge; a lost connector is a `reference-lost` mate
  error with a re-pick prompt and the lid free (DOF 6); a fastened mate contradicting the hinge is
  a conflict blaming it (and without its offset agrees, DOF 0); a pinned instance's bodies come
  with meshes in `sources`, and a preview solve places it without reporting anything; nothing
  leaks. Through the worker (`worker-api.test.ts`): a preview, coalesced drags at the current
  generation, and committing the drag as a pose-only regen that sends no mesh.
- Interference (`engine.test.ts`, against the scripted kernel): never sent by a regen; the
  prefilter batch, then one batch per candidate pair, with the regen's live body shapes, the
  suppressed instance left out and pairs streamed in order; the poses of a drag in progress; a
  `stale` report after a recycle; null for a stale request or an unknown assembly. Through the
  worker with the real kernel (`worker-api.test.ts`): a lid lying on its box (touching: no
  candidate, no boolean), then the lid turned a quarter turn down into the box by its stored pose,
  solved on the hinge, overlapping by 4000 mm3 with the overlap's mesh streamed ahead of the
  report; a stop before the first pair; a check superseded by a regen; nothing left in the kernel.
- `derived.test.ts` also checks that a source whose reading throws is a `source` error.

## Deviations and gaps

- **`FeatureResult`** extends ADR 0007's first cut with `status`, `warnings`, `cached`, `ms` and
  `kind`, and its references are `ReferenceResolution`s. Errors carry a `message` each.
- **One feature op per batch.** Before body sets, a run of cache misses went to the kernel as one
  batch chained by `{ result }`. The next feature's key now depends on the outcome of the previous
  one, so each is flushed on its own (in the worker, a batch costs no structured clone).
- **Detached bodies.** An `add` that touches no body used to stay in the part's one compound; it is
  now a body of its own (with a `detached` warning), so such an M1 document shows two bodies.
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
