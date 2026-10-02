# @manufakture/regen

The regeneration engine: turns a core document (`packages/core`) into geometry through the kernel
(`packages/kernel`), rebuilding only what an edit changed. It evaluates expressions
(`packages/units`), solves sketches (`packages/sketch`), translates every core feature into a kernel
`FeatureInput`, caches each feature's result, and reports per feature a status, errors, warnings,
reference resolutions and timing, plus every final body's mesh and one name table for the
viewport. A part carries a set of bodies (M2 plan, decisions 1 to 3), and an edit rebuilds only the
features of the bodies it touches. After the parts, it places the instances of every assembly with
the mate solver of `packages/assembly` ([ADR 0008](../../docs/adr/0008-assembly-mate-solver.md)),
and it answers assembly previews, drags and interference checks (see Assemblies), and drawing
views on request (see Drawings).

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
const view = await engine.drawingView(document, 'drawing#1', 'view#1', { generation, pick: true });
const sheet = await engine.drawingSheet(document, 'drawing#1', 'sheet#1', { generation });
```

That is the engine's own API, as tests and a custom host use it. apps/web does not construct an
engine: it spawns a worker entry of its own (`apps/web/src/viewport/regen-worker.ts`:
`@manufakture/regen/worker` with the app's domains registered) and calls
`RegenClient.regen(document)` (see "The worker").

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

| Import                          | Where        | What                                                                                                            |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `@manufakture/regen`            | worker, Node | the engine, graph, translation, cache, `createRegenWorkerApi`                                                   |
| `@manufakture/regen/worker`     | worker entry | `Comlink.expose` of the regen worker API, with the kernel's `.wasm` imported as a `?url` asset                  |
| `src/text-worker.ts`            | text worker  | the text worker the regen worker starts for outlines (see Text)                                                 |
| `@manufakture/regen/client`     | main thread  | `RegenClient`, without any worker entry (a host with its own entry imports only this)                           |
| `@manufakture/regen/spawn`      | main thread  | `spawnRegenWorker()`: starts regen's own worker entry and returns its `RegenClient`                             |
| `@manufakture/regen/extensions` | worker entry | the translator registry (`ExtensionRegistry`, `defaultExtensions`) without the text engine the index re-exports |
| `@manufakture/regen/explode`    | main thread  | exploded offsets (`explodedOffsets`, `explodedPose`, `explodeTrails`), pure, for the assembly viewport          |

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
the worker's `regen` takes no change, so it compares whole parts. Extensions that may read a
domain data namespace that changed are seeds too (see "Extensions"), even when `firstAffectedIndex`
is `null`. `regenOrder` and `topologicalOrder` give a dependency order that is
the document order for any valid part (core keeps dependencies earlier).

The dirty set is reported per part (`PartResult.dirty`). It is informational: the cache, not the
dirty set, decides what gets rebuilt. What actually goes to the kernel is decided by the cache: a feature whose key is cached costs nothing, so the ops sent are always a
subset of the dirty set (an expression rewritten to the same value, say `3mm` to `1mm + 2mm`, is
dirty but a cache hit).

## Translation

`translateFeature` (`src/translate.ts`) turns a core feature into a kernel input:

| Core                                 | Kernel                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `operation` new, add, cut, intersect | `mode` new, add, subtract, intersect                                                                           |
| `profile` (sketch, entities?)        | each selected region's `regionProfile` loops on the sketch placement, entities by edge id                      |
| extrude `extent`, `reverse`, `draft` | the same, distances in mm, draft in radians; `upToFace` as a `FaceRef`                                         |
| revolve `sketchLine` axis            | a model-space `Axis` from the line's start to its end; core's `flip: true` negates it                          |
| revolve `edge` axis                  | `{ edge, flip }`, oriented by the kernel's naming rules                                                        |
| fillet, chamfer, shell references    | `{ id, ref }` with the stored names; chamfer `secondDistance` / `angle` pick the size kind                     |
| hole `sketch`, `points`              | the sketch placement as the frame, each point entity's solved position                                         |
| pattern, mirror `features`           | the source features' own kernel inputs (extrudes, revolves, holes); `body: true` the body                      |
| pattern, mirror `body: true`, `mode` | `source: { type: 'body', mode }`; no `mode` when the document has none (the kernel's `add`)                    |
| `derived`                            | `derive` of the pinned source part's bodies (see Derived parts); placement in mm, radians                      |
| pattern `count`                      | checked here: a whole number, 1 to `MAX_PATTERN_COUNT`, however it was computed                                |
| `scope`                              | the same list; an entry that is not a body at that point is `reference-lost` on `scope`                        |
| body id of a `new` or `add` feature  | `body`: the feature's own id (M2 plan, decision 1)                                                             |
| `thread`                             | `ThreadFaceInput`: `face`, `start`, the size's diameters from `THREAD_SIZES`, half the clearance (see Threads) |

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
region diagnostics of warning severity (open profiles, touching loops) are warnings. A sketch with
outline entities (text) has them expanded after the solve, before region detection: see Text.

**Profiles.** Without `entities` a profile is every filled region. With `entities` it is every
region or void whose outer loop runs only along listed entities: a rectangle's four lines pick the
rectangle with its holes, and adding a hole's circle picks the disk too. Listed entities that are
gone are a `reference-lost` error on `profile`. One selected region goes to the kernel as its
loops (`{ frame, loops }`, unchanged from M1, so cache keys of existing documents stay put); several
go as `{ frame, regions }`, each region with its holes, in region id order. The kernel sweeps every
region, fuses the ones that touch and numbers their caps `<id>:cap:start#k` and `<id>:cap:end#k` by
edge id (kernel README, "Several regions"), so one extrude of a sketch with three separate regions
is one body of three solids with every region's faces. A `draft` is applied after the regions are
joined, so touching regions taper as one outline (a draft of a Bezier side fails). Separate regions
that a draft grows into each other (a negative draft, or the lower half of a `symmetric` extent
under a positive one) are fused after the draft, so the body stays one valid solid with the volume
of their union rather than two overlapping ones. An `add`
fuses its whole tool into the body it meets: regions that miss the body become extra solids of
it, not `detached` bodies.

### Threads

A `thread` feature (core README, "Threads"; ADR 0012 decision 9) translates to the kernel's thread on a face (`ThreadFaceInput`, kernel README, "Threads"): the face and start references as stored, the size's basic major diameter, pitch and tap drill from the kernel's `THREAD_SIZES` (a size it does not know is `invalid` on `['standard', 'size']`), the length in mm or `full`, and **half** the clearance, since core's clearance is diametral like the fit variables and the kernel's is radial (a negative one is `invalid` on `['clearance']`). Everything that needs the body is resolved in the kernel: the axis, side, radius and extent of the face, the ends, and the range check, so a cylinder the size cannot be cut into fails with `invalid` on the face's reference id, naming the range (`M6 (external) needs a shaft 4.988 to 8 mm across; extrude#2:side:e2 is 10 mm`). A cosmetic thread resizes the whole face (to the tap drill inside, the major diameter less the clearance outside) and builds no helix.

A thread acts on the body owning its face, like a fillet: in the graph it reads and changes only that body (`bodyUse` and `actsOn` treat it as a fillet), and the kernel input has no scope, so a coaxial body (a nut on the bolt) is never cut. The kernel's `ThreadReport` (the body, the axis from the start, the radius after the feature, length, pitch, hand, phase, representation, how each end was finished) is kept in the cache entry and returned as `FeatureResult.thread` on a build and on a cache hit alike; the app draws cosmetic threads from it. Threads are the slowest features to build (about a second for 20 mm of M6), and the per-feature cache keeps them from rebuilding on an edit that does not reach them (`threads.test.ts` checks it).

## Extensions

Domain features (a board, a joint, later a wall) are core `extension` features; regen builds them
through a **translator registry** (`src/extensions.ts`, ADR 0013 decisions 4 to 6). Regen imports no
domain package: the app's worker entry registers the domains it ships (`domain-wood` in M4) on
`defaultExtensions`, or passes its own `ExtensionRegistry` as the engine's `extensions` option;
tests register fakes.

```ts
const registry = new ExtensionRegistry();
const unregister = registry.registerDomain({
  namespace: 'wood', // the first segment of its types
  implementation: 1, // bump with any change that can alter a translator's output
  reads: ['stock'], // shared namespaces its translators read, besides its own
  data: { wood: woodReader, stock: stockReader }, // readers of the namespaces it owns
  types: { 'wood.board': board },
});
registry.register('wood.dado', dado); // one more type of a registered domain
registry.unregister('wood.dado');
```

An `ExtensionType` declares its newest `schemaVersion`, the kind (`length`, `angle`, `number`) of
each named expression, an optional `params(params, schemaVersion)` that migrates and validates the
stored params, and `translate(ctx, answers)`. The context holds the feature (a frozen copy), its
params as `params` returned them, its expressions evaluated by the declared kinds (an undeclared one
is a plain number in internal units), its references resolved on the bodies before it with their
geometry (`body`, `target`, `via`, `fragile`, plane, line or circle; the kernel's `resolve` op), the
domain data of every namespace it may read (read by the domain that owns the namespace: migrated,
validated), the solved sketches and the results (inputs and metadata) of extensions of its own
namespace that it names in `dependsOn`, the ids of the bodies before it, and `profile(sketch,
entities?)` for a sketch's kernel profile. It returns `{ inputs, metadata? }`, one or more kernel
`FeatureInput`s with the feature's id, or `{ error, field?, referenceId? }`.

**The two-step form.** A type with `queries(ctx)` first says what it needs to know about the part
before the feature: `{ type: 'resolve', ref }` (a face or edge by name, on the body that carries
it) or `{ type: 'obb', body }` (a body's oriented box). Regen answers them with the kernel's
`resolve` and `obb` ops in one batch, and passes the answers, in order, to `translate`. A joint
asks for the faces of the boards it joins this way.

**Bodies.** An extension is placed in the graph like an extrude, by its `operation` and `scope`
(`bodyUse`, `actsOn`): `new` reads only the bodies its references lie on and makes a body; `add`,
`cut` and `intersect` read their scope, or every body; with no operation it reads its scope, or
every body, since it may change bodies through inputs that name them (a joint's `tools` items).
Regen gives the translator's inputs those semantics (`checkOutput`): with an operation, every input
that combines a solid (one with a `mode`) gets the operation's mode and the feature's scope, and
with `new` or `add` makes its body under the feature's id, or `<id>:<key>` when the input names one
(several bodies from one extension, M6 decision 7). Every solid input is forced to the
operation's mode, so one extension cannot mix modes: a `new` board cannot extrude and then subtract
as two solid inputs (a cut belongs in its own feature, or in a `tools` input). A `new` extension
makes each body once: two inputs making the same body (two unkeyed solids, or one key twice) are an
`extension` error, so give each a key. Without an operation no input may combine a solid of its
own. A `scope` entry that is not a body at that point is `reference-lost` on `scope`. Each input is
one kernel `feature` op, in order, each reading the bodies as the one before left them, so face
names come from that input's rules with the extension's id (`extension#7:cap:end`). Which bodies
an input reads is set by the feature's `operation` and `scope`, not by what earlier inputs made, so
a non-solid follow-up input in a `new` extension cannot reach the body it just made. The first
input that fails stops the feature, and what the inputs before it did is undone: a failed extension
changes no body (their cache entries stay, since they are still right).

**Caching.** Translators are pure and cheap and run on every regen; only the kernel step is cached.
Each input's key is the input itself (which carries every value the translator read: evaluated
expressions, resolved geometry, stock sizes from domain data), the type, the feature's
`schemaVersion`, the domain's `implementation` and the input's position, plus the keys of the bodies
it reads. A domain data change that no translator reads (a price) is a cache hit everywhere; one that
changes an input (a stock thickness) misses for exactly the features it changes. In the dirty set, a
`domainChanged` namespace (from core's `diffDocuments`, or compared from the two documents) marks
every extension whose type may read it (`ExtensionRegistry.readsOf`); there is no per-domain
"affected features" hook.

**What fails, and how** (ADR 0013 decision 4). Nothing here rewrites the document.

| Case                                                                   | Result                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| No registered domain builds the type (with or without an operation)    | `unsupported` on `extension`, naming the type and version |
| The feature's `schemaVersion` is newer than the type's                 | `unsupported` on `schemaVersion`, naming both versions    |
| A namespace it reads is newer than its owner reads, or has no owner    | `unsupported` on `domains.<ns>`, for every reader of it   |
| The owner refuses the namespace's data                                 | `invalid` on `domains.<ns>.data...`, for every reader     |
| The type's `params` refuses the params                                 | `invalid` on `params...`, with the domain's message       |
| An expression fails, or has the wrong kind                             | `expression` on `expressions.<name>`                      |
| A reference does not resolve                                           | `reference-lost`, `reference-ambiguous` or `no-body`      |
| The translator returns `{ error }`                                     | `invalid` with its message, `field` and `referenceId`     |
| Domain code throws, writes to what it reads, or returns something else | `extension`, naming the type and the step                 |
| The kernel fails an input                                              | the kernel's error, as for any feature                    |

Malformed covers anything regen cannot use as it is: a `body` or `scope` that is not strings, a
query `ref` that is not a face (`{ face }`) or an edge (`{ faces, ends?, ordinal? }`) by name, a
value that is not plain data, a getter that throws. Regen checks the result and copies it to plain
data inside a guard, so domain code never fails the regen itself.

A failed extension makes no body; later features that name its bodies are `upstream-error`, and
features that do not depend on it build. A translator's metadata (a board's frame) is reported as
`FeatureResult.metadata`, recomputed on every regen and never stored.

## Text

Outline entities (ADR 0012 decision 7) are expanded at every regen of their sketch, after the
solve has placed their anchors (`expandOutlines` in `src/sketches.ts`): each text is laid out in
its font and its glyphs turned into region loops by the **text outliner**, placed at the anchor and
angle (`placeOutline`), and handed to `detectRegions` with the sketch's own curves, which cuts
letter-shaped holes in the face around a text and makes the letters (and the counters of letters
inside a face) regions (sketch README, "Outline entities"). Construction outlines are expanded too
but bound nothing. A sketch's `FeatureResult.outlines` (and `SketchResult.outlines`) carry every
outline's placed loops, so the app draws text as regen built it (T3.2d). Glyph geometry never
reaches the solver.

- **SVG artwork** (an outline with an `svg` source, M5 T5.8) needs no font and no text worker:
  `expandOutlines` turns its paths into region loops in the regen worker itself, at the evaluated
  `scale` (a number; one not above 0 is `invalid` on `entities.<i>.source.scale`), with
  `svgOutlineRegions` in `packages/sketch` (each path converted alone by its fill rule, then all of
  them united), and places them like glyphs, a path's index standing for the glyph's
  (`e5.g3.c0.s12#1`, fragile). Every SVG outline of the regen pass spends one `OutlineBudget`
  (`Run.svg`, passed as `OutlineContext.svgBudget`), so a document of many costly outlines is
  bounded as one: three outlines that each cost about half the budget stop in about 8 s, where a
  budget per outline would let 250 of them run for minutes. An outline refused because the pass's
  budget ran out fails the sketch with "too complex to convert in one rebuild", marked transient,
  and neither the sketch's result nor the conversion is cached, so the next regen tries again. A
  path that cannot be converted fails the sketch (`invalid` on `entities.<i>.source.paths`, naming
  the shape); open contours and loops that touch are `text` warnings, grouped by code in `svgOutlineRegions` and at most `MAX_SVG_WARNINGS` (8)
  per artwork, the rest counted in one more. Every regen gets a fresh
  copy of the document, so results are cached by content: `svgPathsHash` (computed once per paths
  array) and the scale key the last `SVG_RESULTS_CACHED` (16) conversions, and the sketch's cache
  key holds the hash instead of the paths (`sketchKeyDefinition`), so a regen that only moves the
  artwork, or changes another feature, converts nothing again. SVG artwork counts against
  `MAX_SKETCH_OUTLINE_CURVES` with the texts.
- **Values.** `size` (the cap height), `letterSpacing` and `lineSpacing` are the feature's
  expressions (core's `featureExpressions`), evaluated with the rest; a size that is not above 0 is
  `invalid` on `entities.<i>.source.size`.
- **Fonts** come from the document's `fonts` (for a derived part's source, from the source
  document's). A bundled font is fetched by `packages/text` and checked against the SHA-256 it
  ships with; when that is not the SHA-256 the document recorded (an app update changed the file),
  the text is built with the shipped font and a `font-changed` warning. A user font's base64 bytes
  are checked against its stored size and SHA-256 before they are parsed.
- **Errors.** A font that cannot be read is a `font` error (`fontId`, field
  `entities.<i>.source.font`, message "This font could not be read (name): why"), and a glyph that
  cannot be read or converted is `invalid` on `entities.<i>.source.text`; either fails the sketch,
  so its extrusions are upstream errors, rather than leave letters out silently. Characters the
  font has no glyph for (`missing`), kerning that could not be read and glyph loops that touch are
  `text` warnings.
- **The text outliner** (`src/text.ts`) is a `TextOutliner`: one `outline(request, { signal,
budget })` per outline entity, the request carrying the font (a bundled id, or a user file's
  base64 text), the string, the evaluated size and spacings and the alignment, the reply the glyph
  regions (`outlinePartsRegions`, per glyph, glyphs that overlap merged) or a failure. The engine
  takes one as `text`.
- **The default outliner is for Node and bundled fonts only.** Without `text`, the engine uses
  `createTextOutliner()` (`src/text-engine.ts`, loaded on the first text, so a host that passes
  its own never loads opentype.js). It parses fonts **in the calling thread with no time limit**, so
  it **refuses user (`file`) fonts** ("user fonts are read only in the text worker, under a time
  limit"). A browser host must pass `createWatchdogOutliner` (the regen worker does, below). A Node
  host that trusts its fonts (a test, a command-line tool) can pass
  `createTextOutliner({ allowFileFonts: true })`; pass a `fetchImpl` that reads files there, since
  Node's `fetch` cannot load the bundled font's `file:` URL.
- **The watchdog.** User fonts are attack surface, and not every cost of reading one can be bounded
  from outside the parser (a CFF font's subroutine fan-out inside opentype.js; ADR 0011's
  amendment). So the regen worker (`worker.ts`) passes `createWatchdogOutliner(spawnTextWorker)`:
  every request runs in a **text worker** of its own (`src/text-worker.ts`, a nested worker started
  on the first text), one at a time, under a `Watchdog` (`src/watchdog.ts`) with a time limit of
  `TEXT_TIME_LIMIT_MS` (10 s) per request. A font is **loaded** by a request of its own the first
  time a worker needs it (the bundled font's fetch, or a user font's bytes, transferred, and the
  parse), and each text is **laid out** by another, so a timeout says which was slow:
  - a load that passes the limit, or kills the worker (out of memory, a crash), is "This font could
    not be read (name): reading it took longer than 10000 ms" (or "ran out of memory or
    crashed"), the same `font` error as a damaged file. A user font that does so is remembered and
    not tried again, so one hostile font costs the time limit once, not once per text. A
    **bundled** font is never remembered as failed for the session: its 420 KB fetch runs under
    the limit, and a slow network must cost one regen, not the session. Within the regen it is
    remembered on the regen's `TextBudget`, so the other texts in it fail at once with the same
    message and the regen spends the time limit at most once per font;
  - a layout that passes the limit fails that text alone: "this text could not be laid out in
    time", `invalid` on `entities.<i>.source.text`. The font is not blamed;
  - a worker that **could not be started** (the constructor threw, or it died or timed out before
    it said `{ ready: true }`, which `serveText` posts first) blames nothing and is not remembered
    for the session; the regen's `TextBudget` remembers it, so the regen's other texts fail at once
    without starting another.

  Either way the worker is terminated and the next request starts a new one. The text worker keeps
  fonts loaded by key (eight, least recently used out); a font it let go is loaded again. `Watchdog`
  is generic (`{ id, request }` in, `{ id, reply }` out, over anything shaped like a `Worker`); its
  tests drive real `worker_threads` workers that hang, throw and run out of memory.

- **Time budgets.** On top of the per-request limit, each regen has a `TextBudget`: the texts of
  one font (loading it included) may take `TEXT_FONT_BUDGET_MS` (10 s) in all, so a font whose
  every text takes just under the limit fails once its texts have used it up (a user font then
  stays failed for the session; a bundled one fails for that regen only), and all the texts of
  the regen may take `TEXT_REGEN_BUDGET_MS` (30 s), past which the remaining texts fail ("this
  text was not laid out: the document's texts took longer than 30000 ms in all"). The budget is
  checked before a text and charged after it, so a text that starts just under a budget may still
  run its whole time limit: a font can take up to about 20 s, and a regen's texts up to about 40 s.
- **Cancelling.** The engine checks for a newer regen between the outline entities of a sketch,
  and a newer regen aborts the running one's signal: the watchdog terminates the text worker if it
  is laying out that regen's text (a request still queued never runs), and the superseded regen
  returns null at once instead of waiting out the time limit. A cancelled request is not a font
  failure.
- **Not cached.** A failure that may not repeat (a bundled font that could not be fetched in time,
  a worker that could not be started, a time budget used up, a user font whose bytes do not match
  their SHA-256) marks the sketch's result `transient`: it is reported but not cached, so the next
  regen tries again. A user font whose bytes do not match the SHA-256 the document claims is not
  remembered by the text worker either, so a damaged or hostile document cannot block the real
  font with that SHA-256.
- **Size limits.** A text may make at most `MAX_TEXT_LOOPS` (50,000) loops, `MAX_TEXT_CURVES`
  (500,000) curves and `MAX_TEXT_POINTS` (1,500,000) points, checked in the text worker; past any,
  the text fails as too complex. The texts of a sketch may place `MAX_SKETCH_OUTLINE_CURVES`
  (500,000) curves in all, checked by `expandOutlines`. For scale, 10,000 characters of Latin text
  in Inter Bold (core's limit for all of a sketch's texts) make about 12,000 loops, 167,000 curves
  and 448,000 points; real text never comes near, and a hostile font whose glyphs have thousands of
  contours is stopped before its loops reach `detectRegions`, whose own work for outlines is
  bounded too (sketch README, "Outline entities").
- **The sketcher's calls.** While a sketch is edited, the app draws its texts before any regen:
  `outlineText(request)` on the worker API (`RegenClient.outlineText`) runs the same outliner the
  engine uses (the watchdog outliner in the browser) on one `TextRequest` and returns its
  `TextReply`, the glyph regions in the text's own frame, which the app places at the anchor it is
  dragging (`placeOutline`). It needs no kernel and takes no generation, so it never cancels a
  regen, and it is never cancelled itself: an abort would terminate the text worker, and the next
  request would load the font again. The app waits 120 ms after the last change of a text before it
  asks (apps/web `useTextPreviews.ts`). The app asks in passes, `outlineText(request, { pass })`:
  the texts of one pass share a `TextBudget` as a regen's do, and the worker API lays previews out
  one at a time, so each is checked against the budget when it starts. A hostile font whose every
  text takes just under the time limit therefore costs a pass about two time limits (and is then
  failed for the session, as in a regen), not one time limit per text of the sketch. Previews and
  regens share the text worker's queue, so a font is charged only for the time its own requests
  run, from when each one's turn comes (`Watchdog.call`'s `onStart`): waiting behind a hostile
  font's slow request costs an honest font nothing.
- **Reading a user font for Add font.** `readFont(fileName, bytes)` (`RegenClient.readFont`) refuses
  a file above `MAX_IMPORT_BYTES` (20 MiB) before it hashes or copies it (and the text worker checks
  the size of an `info` request again), then sends the file to the text worker under the same
  watchdog as a `load` (`WireInfo`, op `info`) and replies with a `FontSummary`: family, style, version, copyright, license and license URL (names
  1/16, 2/17, 5, 0, 13 and 14), `fsType` and its decoded embedding permissions, outline kind,
  whether it is variable, its glyph count, size and SHA-256. Every string is cut to
  `MAX_FONT_NAME_LENGTH` (2000) characters in the worker; the app shows them as plain text. The
  font stays loaded in the text worker, so the first text set in it does not parse it again. A
  font that times out or crashes the worker is "This font could not be read" and is remembered as
  failed, like a font that does so in a regen; a host without the watchdog (`createTextOutliner`)
  refuses (`unreadableFont(..., 'this host has none')`). The main thread never parses the file: it
  checks only the name, size and signature first (apps/web `sketcher/text.ts`, `checkFontFile`).
- **Cost.** Layout and outlines take about 0.13 ms per glyph, region detection adds little (10,000
  characters in a plate: about 1.3 s and 130 ms; 1000 characters: about 145 ms and 30 ms, logged
  by `text.test.ts`); the kernel's sweeps dominate (kernel README, "Several regions"). Core caps a
  text at 1000 characters and a sketch's texts at 10,000.

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
  `namespace` (`sourceNamespace`: the pin's `sha256`, part id and the configuration row it is
  built in, if any) besides the usual fields, so every derived feature and instance of one pinned
  part in one row, in any part and in any regen, shares its entries;
- for a sketch: the solver build (`DEFAULT_SOLVER_BUILD`, the pinned planegcs release; pass
  `solverBuild` to override), its definition without the display name, its evaluated dimension
  values (text sizes and spacings among them), and its plane (the placement, or the keys of the
  bodies the face may lie on plus the face reference); a sketch with text adds the fonts it uses
  (`sketchFontKey`: each font's id and SHA-256, and for a bundled font the SHA-256 of the file
  this build ships under its id, so a changed bundled file is a cache miss).

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

**Configuration rows.** A source is built in a row of its document's configuration table (T2.4c;
core README, "Configurations"): the row `source.configuration` names, else the row the source
document had active when it was pinned, which is how that document shows itself; with neither, the
document as stored. Opening the pin applies the row with core's `configured`, once per hash and
row. A named row the source does not have is a `source` error on `['source', 'configuration']`
naming the row id, and so is a named row that cannot be applied; nothing of the source is built.
An active row that cannot be applied leaves the document as stored, as the source's own app does.
The row is part of the namespace and of the nesting walk (a row can suppress or unsuppress a
derived feature of the source), so two rows of one pin are two builds with entries of their own,
and changing a derived feature's row is a new build of the source in that row.

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

**Configuration rows** (`source.configuration`, T2.4c). Instance sources are grouped by
`instanceSourceKey`, which ends in `:row:<row id>` when the instance names a row, so two instances
at two rows get two builds and their bodies two keys (the connector cache keys on body keys
already). A part of this document with no row, or in the row the document is built in (its active
row: the app regenerates `configured(document)`), is the part's own `PartResult`. In any other row
it is built again from the stored document in that row, once per regen for every instance in it.
The app passes the stored document as `RegenOptions.stored` (`regen(document, stored)` on the
client; `solveAssembly` takes it too) whenever it applied the active row, because a row leaves out
the parameters it does not set and those must keep the stored value, not the active row's;
without `stored` the document passed is taken as the stored one. The row's document is kept per
stored document object and row, so a regen of the same stored document configures nothing again.
Such a part is
reported in `RegenResult.sources` under `part:<part id>:row:<row id>` with `row` set and empty
document and version fields. It is built in the document's own cache namespace: a feature's key
holds its evaluated inputs, so whatever the row leaves as it is shares its entries with the part's
own build (as switching the active row does), and only what the row changes is built again; failed
features of it are a `derived-source` warning on the instance, since no part studio shows that
build. A pinned part in a row is built as a derived source in that row (see Derived parts) and
keyed `source:<sha256>:<part id>:row:<row id>`. A row the document does not have, or one that
cannot be applied, is a `source` error on the instance on `['source', 'configuration']`, naming
the row. The one exception is an instance naming the active row when the app could not apply it:
the instance is then the part's own build, which the app makes from the document as stored (and
says so in its configuration message), so it shows the part as stored rather than failing. Every `SourceResult` carries the part's name (`partName`) and, when one is applied, the
row (`row: { id, name }`), for the app's labels and export names.

## Exploded views

`src/explode.ts` is the one owner of exploded offsets (M4 plan, decision 9 and T4.5a). An
assembly's exploded views (`Assembly.explodedViews`, core) are named, ordered steps, each moving
some instances along a direction by a distance expression. After an assembly is solved, regen
resolves every view at the solved poses into `AssemblyResult.explodedViews`
(`ExplodedViewResult`: per step the instances it moves, a unit direction in the assembly's frame
and the distance in mm). A `vector` direction is taken as written; an `edge` or `face` direction
of an instance is the z of a mate connector frame on it (`midpoint` on the edge, `centroid` on the
face: a straight edge's direction, a plane's normal or a cylinder's axis), found by the same
`connector` op and cache as mate connectors, turned by that instance's solved pose, and reversed
with `flip`. Nothing here changes a pose: `explodedOffsets(view, progress?)` adds the steps up in
order into one offset per instance, `explodedPose(pose, offset)` moves a solved pose by it, and
`explodeTrails` gives each step's move per instance for trail lines. `progress` (0 assembled, 1
exploded) plays the steps one after another, each over an equal share (`stepFraction`), for the
app's slider. What does not resolve is an `ExplodeWarning` on its step, never a failure: an
instance the assembly no longer has (`missing-instance`, left out of the step), a distance that
does not evaluate (`expression`) or a direction whose instance is not placed or whose edge or face
does not resolve (`direction`; both make the step move nothing), and a direction resolved other
than exactly (`reference`). Suppressed instances are not placed, so steps skip them silently. The
module imports nothing that needs a worker, so the app imports it as `@manufakture/regen/explode`.

## Drawings

`src/drawing.ts` is the drawing stage (M4 plan T4.4e, decisions 7 and 8): the one place where
core's drawings (`Drawing`, `Sheet`, `View`, `Dimension`, `Note`) meet the kernel's `project` op
and `packages/drawing`'s inputs. Views are never computed by a regen: the drawing workspace asks
for the views on screen (`drawingView`, `RegenClient.drawingView`) and export for whole sheets
(`drawingSheet`). Both take the client's current generation (never a new one, so they never cancel
a regen), run on the regen chain, build the parts and assemblies through the cache (all hits after
a regen of the same document; `stored` as for `regen`), and resolve to null when a newer regen
supersedes them. A drawing, sheet or view the document does not have rejects.

**Views.** A part view shows the part's bodies (or those its `source.bodies` lists; missing ones
are a `missing-body` diagnostic) at the identity pose; an assembly view shows every unsuppressed
instance's bodies at their solved poses, keyed `<instance id>/<body id>`. Features of the part, or
instances of the assembly, that failed are a `source-errors` warning; the view shows what was built.
A view of an exploded view places each instance at its solved pose plus its exploded offset,
from the same `explodedOffsets` the assembly viewport calls (see Exploded views); an exploded view
the assembly does not have (drawn assembled), or steps of it that did not resolve in full, are an
`exploded-view` warning. Exploded poses are poses like any other, so the cache keys on them and
dimensions resolve on the instances where they are drawn. Every body of a view goes into ONE `project` op (T4.4a: projecting bodies
alone and merging is wrong where they hide each other), with the view's hidden and smooth options
and its section (core removes the side the section normal points to, so the kernel's normal is
its negation, through `normal * offset`). The result is cached as plain data by the bodies' keys
and poses, the direction, the options and `DRAWING_STAGE_VERSION`, so an unchanged view, a moved
view or a new dimension sends no `project` op (`DrawingViewResult.cached`,
`engine.drawingStats`). Scales are two length expressions: a ratio reduced to a smaller side of 1,
or the architectural notation when both sides are written in inches or feet. Core anchors a view
at its model origin, `packages/drawing` at the centre of its bounds; the stage converts.

**Dimensions.** Each reference is resolved on its body (by body id, and instance in assembly
views): edges and faces with the `resolve` op, vertices with the `connector` op's vertex rule (the
kernel's `resolveVertex`, ordinal included), then measured exactly (`measure` by index), placed at
the body's pose and projected in TypeScript with the view's frame (`viewFrame`, `projectPoint`).
Resolutions are cached by body key and reference, and picking data by body key; the caches are
bounded, and a request reads its own results, never back from a cache, so a view of more bodies or
references than a cache keeps still works (`new DrawingStage({ refs, picks, views })` sizes them).
The outcome per dimension is `exact`, `warning`
(`reference` warnings for weaker or positional resolutions, `foreshortened`, `not-parallel`,
`silhouette`),
`lost` or `ambiguous` (`reference-lost`, `reference-ambiguous` errors with `referenceId` `refs.0`
or `refs.1`; a body that is not in the view is `reference-lost` too), or `error` (geometry that
cannot be dimensioned so). Anchors follow core's rules: a vertex, a line edge's midpoint, a
circle's centre, a cylinder's axis; a planar face is a plane, and between a point and a plane or
two parallel planes the distance is along the (first) plane's normal. Core's linear `offset` is
from the first anchor along the measuring direction turned counter-clockwise (left for vertical);
`packages/drawing`'s is from the nearer anchor (right for vertical): `drawingOffset` converts. A
radius or diameter of a circle or a cylinder seen face on is a circle (`at` gives the leader's
angle, not its length); a diameter of a cylinder seen across is its two silhouettes, as long as
the face's axial extent (from its boundary edges, found with the `topology` op and measured, as
picking finds it), with a `silhouette` warning when the face covers only part of the round and a
silhouette is not on it (a fillet's quarter round); a radius of one is an error. An angle takes two line edges or planar faces seen edge on; `at` picks the quadrant and the
arc's radius. Values are formatted in the document's display units with the dimension's
`decimals` or `denominator`.

**Sheets.** `drawingSheet` lays the sheet out with `layoutSheet`: a custom size is evaluated first,
and one that does not evaluate or is not positive is a diagnostic and no display list (never a
`RangeError`). Title block fields map to the title block's cells by label (`Title`, `Drawing
number`, `Revision`, `Sheet`, `Scale`, `Company`, `Drawn by`, `Date`, `Material`, `Units`,
`Projection`); other labels are a `title-field` warning. A note on a view sits relative to the
view's position. No collision nudging of dimensions and notes is done here (the plan does not give
it to this task; `packages/drawing` places each where its offset says).

**Picking.** With `pick: true` a view carries, per body, its named edges as 3D polylines (the
mesh's), its vertices and its cylindrical faces (axis, radius, extent and the arc the face
covers), each with the reference a dimension stores (the kernel's `pick` op), placed at the body's
pose and cached by body key. They stay 3D because the pick needs depth: `pickInView(data, at,
{ radius })` takes a vertex within `vertexRadius` (default half the radius), else the nearest edge
or cylinder silhouette, and among candidates within `PICK_TIE_TOLERANCE` (0.15 mm) of the nearest,
the one nearest the viewer (T4.4a: 99.99 % right where the nearest alone is 78.3 %). A silhouette
is only offered where the face really has one (a fillet's quarter round has one at most).

## Oriented sizes

`orientedSizes(document, partId, { generation, stored?, bodies?, skipExtensions? })`
(`src/oriented.ts`, `RegenClient.orientedSizes`; M4 plan T4.3d) sizes a part's bodies by the
kernel's `obb` op (T4.3b): the cut list's input for bodies that are not boards. Like the drawing
requests it is on demand only, at the client's current generation, on the regen chain (null when a
newer regen supersedes it), and builds the part through the cache. `bodies` limits it to those
body ids (any the part does not have come back in `missing`); `skipExtensions` leaves out bodies
made by extension features of those types (the app passes `wood.board`: a board's size is its
blank, never its box). The bodies not yet measured go to the kernel in one batch; their sizes
(longest first, with the box's `source`, `obb` or `aabb`) are cached by body key (an LRU of
`ORIENTED_CACHE_SIZE` bodies), so asking again for unchanged bodies sends nothing
(`orientedStats`: `obbOps`, `obbHits`). A body the kernel cannot measure is a `failures` entry.

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
fragile resolutions), `missed` and `direction`. Regen adds `expression`, `sketch`, `upstream`,
`source`, `font` and `extension` errors (the last when a domain's code throws or returns something
malformed, see "Extensions"), and `sketch`, `redundant`, `reference-body`, `derived-source`, `text`
and `font-changed` warnings. The `extension` warning is no longer emitted.

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
await and resolves to null. Text is cancelled the same way: the older regen's signal is aborted,
which stops the text it is laying out (terminating the text worker), and it checks for a newer
regen between texts ("Text", Cancelling).

A default generation is newer than the newest the engine requested, the kernel has seen, and the
kernel has cancelled through (`stats().cancelledThrough`): `cancel(g)` raises the latter even past
any batch seen, so a second engine on a shared service would otherwise pick a cancelled generation
and resolve to null.

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
  sources?: SourceResult[]; // pinned parts and parts in another row that instances show: key, pin details, partName, row, bodies with meshes
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
- `extensions.test.ts`: extensions through the registry against the scripted kernel
  (`fake-kernel.ts`, shared with `engine.test.ts`): a fake board making a body named after it, cache
  hits across regens and an expression edit rebuilding only it, `add` and `cut` by operation and
  scope, several inputs from one extension, a kernel failure; a throwing translator isolated as a
  feature error, malformed results (a non-string `body` or `scope`, a throwing getter, one body
  made twice) and malformed queries, an extension that fails partway leaving the bodies as they
  were, a translator writing to its input, error values, refused and migrated params, a wrong
  expression kind; unregistered types and newer `schemaVersion`s as
  `unsupported` with the document untouched, registering and unregistering a domain between regens;
  domain data given to readers, a `domainChanged` dirtying every reader while the cache rebuilds only
  the board whose stock thickness changed, an implementation bump missing the cache, newer, invalid
  and unowned data failing its readers only; the two-step form (resolve and `obb` queries answered
  before the build), resolved and lost references, results of earlier extensions of the namespace;
  a pattern of an extension refused; and the registry's checks.
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
- `text.test.ts`: the in-process outliner on the bundled font (glyph regions equal to converting
  each glyph alone, missing characters), user fonts by bytes (loaded once, a SHA-256 mismatch and a
  file that is not a font failing as "this font could not be read", a mismatch not remembered so
  the real font with that SHA-256 still loads, user fonts refused unless the host opts in), the
  time budget per font and per regen, the size limits, the `Watchdog` on real `worker_threads`
  workers (one worker for queued requests; a hang terminated at the time limit and a new worker
  for the next request; a throw and an out-of-memory death reported as crashed), the watchdog
  outliner (a font loaded once per worker and a user font's bytes sent with it, again after a
  restart; a font that hangs failing once and never retried; a text that hangs failing alone; a
  font whose texts use up its budget failed for the session; a bundled font whose fetch hangs, and
  a worker that cannot be started or dies before it is ready, not remembered for the session but
  for the regen: six texts in a hanging bundled font cost one load and one worker; the budget
  checked again before a font a worker let go is loaded a second time; an aborted signal
  terminating the worker), the cost of a 1000-character text (logged), and reading a user font
  for Add font (its names and permissions from the bundled font's file, a file that is not a font
  refused, strings cut to length, read through the watchdog with the bytes sent once and the font
  kept for its first text, a font whose reading hangs failed once and never retried, and the worker
  API's `readFont` and `outlineText`, refused without a watchdog).
- `svg-regen.test.ts`: SVG artwork through the engine with the real kernel and solver: a plate cut
  around an `evenodd` frame and a square and the artwork extruded, its volume following the scale
  variable, the sketch cached on a fresh copy of the document, the conversion cached by content and
  the key holding a hash of the paths, and a scale of 0 and paths that cannot be converted failing
  the sketch with the field and shape named.
- `text-regen.test.ts`: text through the engine with the real kernel and solver: a plate with "OK"
  in it, the plate extruded by its lines (letter-shaped holes, the counter of the "O" kept) and the
  letters by the text, volumes against areas computed glyph by glyph from the font; a new string
  and a new `#size` rebuilding (the letters' area scaling with the square of the size), an
  unchanged document served from the cache; a sketch on a glyph's side face resolving with a
  fragile warning; a missing character as a `text` warning; an unreadable user font as a `font`
  error with the extrusions upstream errors; a bundled font of another SHA-256 as a
  `font-changed` warning and a cache miss; a newer regen aborting the text in flight (the older
  regen null at once); the stale check between the texts of a sketch; a transient text failure
  not cached; and a sketch whose texts place more curves than allowed refused.
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
  forced between the source build and the derive; nothing leaks. A fake board extension builds a
  body of exactly its volume with faces named after it, and a second one, scoped to it, cuts it.

- Assemblies (`engine.test.ts`, "assemblies", against the scripted kernel): frames found once
  per body and a pose-only change re-solved with no kernel op; frames kept across a recycle; a lost
  connector, a limit that does not evaluate and suppression per mate, the lost mate leaving its
  instance free; rollback warnings, a pinned instance's source and a row its source lacks; drags
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
- Configuration rows (`engine.test.ts`, against the scripted kernel): instances of a part in
  another row build only what the row changes (the fillet again, the sketch and extrude from the
  cache), once for every instance in that row, reported once in `sources`; an unchanged regen
  builds nothing, and building the document in that row makes those instances the part itself,
  all cache hits; a row the document does not have is a `source` error naming it; a pinned source
  in the row it names, else its active row, else as stored, and a row it lacks fails before
  anything is built; a pinned instance in a row gets a source of its own. With the real kernel
  (`integration.test.ts`): two instances of the shelf board at 600 and 1000 mm have exactly those
  volumes (and the 600 mm row is the part's own build, the same body key), and a shelf board
  derived at row 800 mm has the exact volume, then 1000 mm after its row is changed. With an
  active row applied and the stored document passed, an instance in a row that leaves a
  parameter out gets the stored value: the same body as the document built in that row, unlike
  configuring the active-row document.
- `explode.test.ts`: exploded offsets: steps adding up in order, the slider's progress playing
  steps one after another, trails, a deleted instance, a suppressed one, a distance that does not
  evaluate and a direction that does not resolve as warnings on their step; with the real kernel
  and solver on the box and lid, an edge and a face direction read at the solved pose (one
  flipped), the solved and stored poses unchanged, distances following a variable, and a lost face.
- `drawing.test.ts`: the drawing stage's mapping (offsets, scales, custom sheet sizes, title
  blocks, value formats), dimension geometry (parallel planes, foreshortening, silhouettes, angle
  quadrants, a partial cylinder's extent and arc) and the depth tie-break of `pickInView`; a stage
  with one-entry caches answering a view of five bodies on a fake host; with the real kernel, the M1 bracket's front
  and top views: dimensions on picked references following `#thickness` 6 to 8 and a radius `lost`
  when the fillet goes, views projected only on request with no `project` op on a cache hit (also
  after moving a view or adding a dimension), the quarter round picked by its one silhouette and its diameter drawn its full height with a
  `silhouette` warning, sections keeping the side core keeps with their cut faces filled in, an
  assembly view at the solved poses with a dimension across two instances, then the same view of an
  exploded view: the lid at its exploded offset (a vector step and a face-normal step), the
  dimension following it, no diagnostic, and an `exploded-view` warning once a step's face is lost,
  a laid-out sheet with notes, title block and inch values, and a bad custom size as a diagnostic.
- `derived.test.ts` also checks that a source whose reading throws is a `source` error, and how a
  source opens in a row (once per hash and row, the namespace, a missing row).

## Deviations and gaps

- **`FeatureResult`** extends ADR 0007's first cut with `status`, `warnings`, `cached`, `ms` and
  `kind`, and its references are `ReferenceResolution`s. Errors carry a `message` each.
- **One feature op per batch.** Before body sets, a run of cache misses went to the kernel as one
  batch chained by `{ result }`. The next feature's key now depends on the outcome of the previous
  one, so each is flushed on its own (in the worker, a batch costs no structured clone).
- **Detached bodies.** An `add` that touches no body used to stay in the part's one compound; it is
  now a body of its own (with a `detached` warning), so such an M1 document shows two bodies.
- **Caps of several regions are fragile.** With several regions, the caps are numbered pieces
  (`cap:end#2`), renumbered when a region is added or removed; a reference to one resolves with a
  `fragile` warning. Pick a side face, or a single region, where a stable reference matters.
- **Hole points** must be point entities.
- **Glyph faces are fragile.** A text's side faces are named after positional glyph edge ids
  (`extrude#2:side:e5.g3.c0.s12#1`), so a reference to one resolves with a `fragile` warning, and
  editing the text can renumber them (ADR 0012 decision 7).
- **The text worker** is a worker started by the regen worker (a nested dedicated worker). A
  browser without nested workers cannot start it; the text then fails as a font that could not be
  read ("the text worker could not be started"), not remembered and not cached. Node hosts use the
  in-process outliner, which has no time limit and so reads bundled fonts only unless the host
  opts in (`allowFileFonts`).
- **Extensions in patterns.** A pattern or mirror of features cannot repeat an extension: an
  extension can build several kernel inputs, and the pattern input takes one per feature.
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
