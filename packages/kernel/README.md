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

| Import                              | Where                 | What                                                                                                                         |
| ----------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@manufakture/kernel`               | worker, Node          | `Kernel`, `KernelService`, `createKernelWorkerApi`, `OcctLoader`, `applyFeature`, naming, hole tables, types, name tables    |
| `@manufakture/kernel/client`        | main thread           | `spawnKernelWorker()`, `KernelClient`                                                                                        |
| `@manufakture/kernel/kernel-client` | main thread           | `KernelClient` alone, for the client of a worker that extends this one (the regen worker) without bundling this worker entry |
| `@manufakture/kernel/worker`        | worker entry          | `Comlink.expose` of the worker API, with the `.wasm` imported as a Vite `?url` asset                                         |
| `@manufakture/kernel/node`          | Node (tests, goldens) | `createNodeKernel()`, `createNodeService()`, `nodeLoader()`, `wasmPath()`                                                    |
| `@manufakture/kernel/testing`       | Node tests            | `track()`: records every embind object, to prove nothing is left undeleted                                                   |

## Using it from the app

The app talks to the regen worker (`@manufakture/regen/worker`), which hosts this package's worker API and the regen engine in one worker; its `RegenClient` is a `KernelClient`. `KernelClient.worker()` (protected) gives such a subclass the worker proxy typed as its extended API. What follows is the kernel's own worker, used as is by tests and tools.

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

| Op           | Arguments                                                                   | Value                                                                                              |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `box`        | `size`, `at?`                                                               | `{ shape }`                                                                                        |
| `cylinder`   | `radius`, `height`, `at?`, `axis?`                                          | `{ shape }`                                                                                        |
| `profile`    | `frame` (origin, xDir, normal), `loops` of line/arc/circle, each with `id?` | `{ shape }`: a planar face                                                                         |
| `extrude`    | `profile`, `distance` (along the normal) or a vector, `history?`            | `ExtrudeResult`: shape, history, `capStart`, `capEnd`, `sides` per loop in entity order, `sideIds` |
| `boolean`    | `kind` (`fuse`, `cut`, `common`), `shape`, `tools`, `simplify?`, `history?` | `OperationResult`: shape, history                                                                  |
| `fillet`     | `shape`, `edges` (1-based edge indices), `radius`, `history?`               | `OperationResult`                                                                                  |
| `tessellate` | `shape`, `deflection?` (`linear` 0.1 mm, `angular` 0.5 rad)                 | `MeshData`, transferred                                                                            |
| `topology`   | `shape`                                                                     | `Topology`: faces, edges, vertices (ADR 0007)                                                      |
| `properties` | `shape`                                                                     | volume, area, bounding box, validity, counts                                                       |
| `release`    | `shapes`                                                                    | `{ released, unknown }`                                                                            |
| `feature`    | `body` (a named body or null), `feature` (a `FeatureInput`)                 | `FeatureOutcome`: the body after the feature, its names, errors, warnings (see Part features)      |
| `resolve`    | `shape` (a named body), `refs` (`FaceRef` / `EdgeRef`)                      | `{ results }`: per reference its `Resolution` plus the face or edge geometry                       |
| `pick`       | `shape` (a named body), `kind` (`face`, `edge`), `index`                    | `{ ref }`: the `FaceRef` / `EdgeRef` a click there is stored as, or null                           |
| `measure`    | `shape`, `targets` (`{ kind, name }` or `{ kind, index }`), `body?`         | `MeasureResult`: per target its exact values, distance and angle of two, body properties (Measure) |
| `exportStep` | `bodies` (`{ shape, name }`, at least one)                                  | `{ data }`: one AP214 STEP file, transferred (STEP exchange)                                       |
| `importStep` | `data` (the file's bytes, or base64 text of them)                           | `{ shape }`: a new shape without names, a compound when the file has several roots                 |

Every op takes `featureId?` (echoed in its result and any failure, and stamped on the shapes it makes) and `keep?` (default true; `false` releases the op's shape when the batch ends, for intermediates).

Inside the worker the same operations are methods of the synchronous `Kernel` (`box`, `cylinder`, `profile`, `extrude`, `boolean`, `fillet`, `mesh`, `topology`, `properties`, `measure`, `count`, `release`, `checkpoint`, `releaseSince`), which throw `KernelError`. For the part features it also has `revolve` (with caps and the face each entity swept, 0 for an entity on the axis), `chamfer` (distance, two distances or distance and angle, on a reference face), `shell` (remove faces, wall inward or outward), `offset`, `draft`, `transform` (translate, rotate, mirror), `compound`, `geometry` (the line, circle, plane or axis of a face or edge), `isValid`, and `setNames` / `named` (a body's names, kept on its arena entry and dropped with it). Every topology-changing one returns kinded history. The regen engine (`packages/regen`, #932) calls `applyFeature` directly from the worker, or sends `feature` ops.

Profile entities may carry an `id` (a sketch region's edge id, `e2` or `e2#1`; unique within the profile, else `invalid-argument`). The kernel does not interpret it: `extrude` returns `sideIds`, the side face of every tagged entity by id, so the naming layer can name `<feature>:side:<id>` directly. `packages/sketch`'s `regionProfile` produces such loops from a sketch region; `regions.test.ts` builds its fixture profiles (`fixtures/region-profiles.json`) end to end.

## Part features

`applyFeature(kernel, body, input)` (`src/features.ts`) is one part feature: the body before it (a shape id, or null before the first) and a plain-data `FeatureInput` in, the body after it out, with every face and edge named. It is the API the regen engine (#932) builds on: it translates each core feature into an input (expressions evaluated to millimetres and radians, sketch regions turned into profile loops by `@manufakture/sketch`'s `regionProfile`, references copied as names) and chains the outcomes. The kernel has no runtime dependency on the sketch or core packages; references are resolved here, in the worker, against the input body's names.

| Kind      | Input                                                                                                                                                                                                        | Faces it names                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `extrude` | `profile` (`frame`, `loops`, every entity with its sketch edge id), `extent` (`blind`, `symmetric`, `throughAll`, `upToFace` a planar face), `reverse?`, `draft?` (radians, + tapers inward), `mode`         | `<id>:cap:start`, `<id>:cap:end`, `<id>:side:<edge id>`                                 |
| `revolve` | `profile`, `axis` (an `Axis`, a converted sketch line, or `{ edge, flip? }` a straight edge), `angle` (to 2 pi, right-handed about the axis direction), `symmetric?`, `mode`                                 | the same; a full turn has no caps, an entity on the axis sweeps nothing                 |
| `fillet`  | `radius`, `edges` (`{ id, ref: EdgeRef }`)                                                                                                                                                                   | `<id>:round:<ref id>`; `<id>:round:A&B` along a tangent chain; `<id>:corner:A&B&C`      |
| `chamfer` | `size` (`distance`, `distances`, `distance-angle`), `edges` with an optional reference `face`                                                                                                                | `<id>:bevel:<ref id>`, and the same chain and corner names                              |
| `shell`   | `thickness`, `faces` to remove (none: a closed hollow), `outward?`                                                                                                                                           | `<id>:offset:X` for the wall grown from face X; a removed face's name goes to the rim   |
| `hole`    | `frame` (drilled against its normal), `points` (`{ id, at }`), `diameter`, `extent` (`blind` with `tipAngle?`, default 118 degrees, or `throughAll`), `head` (simple, counterbore, countersink)              | `<id>:<part>:<point id>`, part `wall`, `tip`, `bottom`, `cbore`, `cbore-floor`, `csink` |
| `pattern` | `source` (`features`: extrude, revolve and hole inputs to rebuild; or `body`), `layout` (`linear`: direction vector or `{ ref, flip? }`, count, spacing; `circular`: axis or `{ ref, flip? }`, count, angle) | `<id>:i<k>/<source name>` for instance k (2 and up; 1 is the original)                  |
| `mirror`  | `source`, `plane` (a `Plane` or a planar `FaceRef`)                                                                                                                                                          | `<id>:image/<source name>`                                                              |
| `import`  | `step` (a STEP file's bytes, or base64 text), `mode`                                                                                                                                                         | `<id>:face:<n>`, n in the file's face order; always fragile                             |

`mode` is `new` (a separate solid in the body's compound; without a body, the first body), `add`, `subtract` or `intersect`. A `new` solid that overlaps the body (or a `new` pattern copy that overlaps another) fails with `invalid`: the compound would count the overlap twice (48,000 mm3 for two 24,000 mm3 blocks sharing 12,000), and a part holds one body until multi-body parts (M2). Solids that only touch are fine. A hole always subtracts. A pattern has 1 to `MAX_PATTERN_COUNT` (1000) instances, the original included; core checks the same limit on a count written as a plain number. A circular pattern over a full turn spaces its instances evenly; over less, the last instance sits at `angle`.

Pattern and mirror copies of features are rebuilt per copy against the body at that point, then moved, so a through-all (or up-to-face) length is measured from where the copy will be: a through cut turned 90 degrees still goes through. A subtracting copy that does not touch the body changes nothing and gives a `missed` warning naming the instances (`pattern#3:i4`, `mirror#2:image`); the feature still succeeds, since a pattern running partly off the body is often meant (a hole, whose every point is placed by hand, errors instead). Added copies that do not touch stay as separate solids, like the copies of a body pattern, and are not warned. Feature ids are `kind#n`; sketch edge ids must be plain tokens with letter splits (`e2#a`) and at most one final positional piece (`e2#1`, from sketch regions); reference and point ids take no piece. Anything else (`e2#1#a`, a `:`, `|`, `/`, `&`, `?`) is rejected at the boundary, since it would read as a kernel split or break a name.

`FeatureOutcome` has `ok`, `shape`, `created`, `names`, `errors`, `warnings` and `resolved`. When a feature fails, `shape` is the input body unchanged and `created` is false, so the features after it still regenerate; the `feature` op's value has the same `shape`, and a batch only owns (and with `keep: false` releases) a shape the op created. `applyFeature` throws only `KernelError` `fatal` (a wasm trap).

| Error code      | Meaning                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lost`          | a reference no longer resolves: `missing` lists the names that are gone (empty: the faces exist but no longer meet)                                |
| `ambiguous`     | a reference matches several faces or edges: `candidates` lists them, sorted                                                                        |
| `invalid`       | a malformed or out-of-range input, a hole that misses the body, two references to one edge, an overlapping `new`                                   |
| `no-body`       | the feature needs a body (or the shape has no names)                                                                                               |
| `kernel`        | OCCT refused; `occtMessage` when it threw                                                                                                          |
| `invalid-shape` | OCCT returned a shape that fails `BRepCheck_Analyzer`, a shell or hollow it silently got wrong, or a closed hollow it could not make (with a hint) |
| `empty`         | a cut or intersection left nothing                                                                                                                 |
| `unnamed`       | a result face no history named: never silently accepted                                                                                            |
| `unsupported`   | the feature cannot do this yet (a pattern or mirror of an intersecting feature)                                                                    |

Every error carries `featureId`, `message`, and for references `ref` (the reference id, or the field: `extent`, `axis`, `plane`, `direction`) and `target` (the reference as a name). `resolved` lists every reference with its `via` and `fragile`.

`warnings` never fail the feature; each has a `code`:

- `reference`: a resolution that is not `exact` and non-fragile (`descendant`, `ancestor`, `ends`, `ordinal`, or any fragile resolution, including an exact match on a positional name), with the `ResolvedRef` fields;
- `missed`: subtracting pattern or mirror copies that do not touch the body, in `instances`;
- `direction`: a direction taken from a reference that no naming rule could orient (see Directions), where its sign matters.

For the regen engine (#932), these codes map onto ADR 0007's first-cut `FeatureError` union as follows. The ADR's list was a first cut; the codes without a counterpart are kept as they are, and regen adds its own `expression` and `sketch` errors, which never come from the kernel.

| Kernel code     | ADR 0007 first cut    | Fields                                                               |
| --------------- | --------------------- | -------------------------------------------------------------------- |
| `lost`          | `reference-lost`      | `ref` becomes `referenceId`; `missing`                               |
| `ambiguous`     | `reference-ambiguous` | `ref` becomes `referenceId`; `candidates`                            |
| `unnamed`       | `unnamed-face`        | `message`                                                            |
| `kernel`        | `kernel`              | `message`, `occtMessage` (the ADR's `operation` is in the message)   |
| `invalid-shape` | none (kernel family)  | OCCT returned something wrong without failing; shown like `kernel`   |
| `invalid`       | none                  | a bad or out-of-range input; with `ref` when a reference is at fault |
| `no-body`       | none                  | the feature needs a body                                             |
| `empty`         | none                  | a cut or intersection removed everything                             |
| `unsupported`   | none                  | not implemented yet                                                  |

### Directions

Linear pattern directions, revolve axes and circular pattern axes can come from a reference. Which way such a direction points is chosen by names, never by the order OCCT stores faces and edges in, since an unrelated upstream edit (a sketch started at another corner, a through hole) reorders them. `orientedGeometry` (`src/features.ts`) applies these rules, and the `resolve` op reports geometry oriented the same way:

- a straight edge between two planar faces that are not parallel runs along `nA x nB`, the outward normals of its faces, A being the face whose name sorts first (by code unit): a block's top front edge, `extrude#1:cap:end|extrude#1:side:e1`, runs `+z x -y = +x`;
- any other straight edge (a seam, an edge on a curved face, between tangent faces) runs toward the end vertex of the first end face, by name, that touches only one end (end faces are at a vertex of the edge, not on it);
- a circle edge's normal points toward the first of its faces, by name, whose centroid lies off the circle's plane;
- a cylinder's or cone's axis points toward the first neighbouring face, by name, at one of its ends: every vertex and midpoint of the edges the neighbour shares with the face lies on one side of the plane through the face's centroid square to the axis. A hole wall's axis points toward whichever of its rim faces sorts first; a fillet round's toward the first of the faces at its ends. The faces a round is tangent to run its whole length and never decide, since their centroids move with unrelated edits (a boss on the top face); with no end neighbour, the `direction` warning applies;
- a plane's normal is its outward normal.

`flip: true` on the reference (`{ ref, flip }`, `{ edge, flip }`) turns the result round, so the user can pick the other way. A revolve has no separate `reverse`: it turns right-handed about its axis, so `flip` on an edge axis is how it goes the other way, and a model-space axis (a converted sketch line) is flipped by the caller negating its direction, which is what regen does for core's `sketchLine` `flip`. When no rule decides (every candidate is symmetric about the edge or face), OCCT's direction is used and, where the sign matters (a linear pattern, a partial-angle revolve or circular pattern), a `direction` warning says so.

For the UI and sketch placement: `resolveReferences` (the `resolve` op) gives each stored reference's resolution and geometry, `pickReference` (the `pick` op) the reference to store for a click, and `sketchFrame(kernel, body, faceRef)` the deterministic sketch frame on a planar face (origin: the world origin projected onto the plane; x: world X projected, or world Y when the face faces X).

### Naming

`src/naming.ts` is the production naming layer of the T0.5 scheme ([report](../../docs/spikes/T0.5-topo-naming.md), naming scheme version 1 in ADR 0004), ported from `spikes/topo-naming`: faces named at birth and carried by kinded history (kept and `Modified` inherit, one input in several faces gives `#k` pieces by centroid, several inputs in one face merge as `(A+B)`), lineage for descendant matching, edges named by their adjacent faces with end faces and a positional ordinal only when needed, references resolved `exact`, then `descendant`, then `ancestor`, with `ends` and `ordinal` only choosing among candidates, and `lost` / `ambiguous` failures. What the features add:

- **Faces generated from a face** (a shell's walls, OCCT's draft) are named by the feature when it has a name for them; otherwise, when the input face was neither kept nor modified, they replace it and inherit its name.
- **Faces generated from edges or vertices**: a referenced edge gives `<id>:round:<ref id>` (`bevel` for chamfers); an edge OCCT added to the blend along a tangent chain gives `<id>:round:A&B`, after the two faces of the edge it replaced; a vertex gives a corner blend `<id>:corner:A&B&C` (exercised by a three-edge fillet).
- **No duplicates.** Faces that still share a name are numbered by position, fragile.
- **Unnamed faces are errors.** A face no history reached gets the placeholder `?faceN`, the feature fails with `unnamed`, and a placeholder can never be picked, stored or resolved (a reference to one is `lost`). `?` is reserved in ids, so any name containing it counts as a placeholder, however a feature wrapped it (`shell#2:offset:?face3`, `hole#2:?face3`); every step of a feature carries its unnamed faces through (a draft, an outward hollow), and the result's names are checked for placeholders as well.
- **Instances.** A pattern instance is `<pattern>:i<k>/<source name>`, a mirror image `<mirror>:image/<source name>`. Their lineage is prefixed too and never contains the source names, so a reference to the source never finds a copy, and a copy can be referenced like any face (`{ faces: [top, 'pattern#3:i2/extrude#2:side:c1'] }`).
- **Nested positional names.** `splitParent` reads a trailing `#<digits>` as a kernel split. In a corner name whose last component is a piece (`fillet#3:corner:A&B&C#2`, where `C#2` is a piece of `C`) that reading is ambiguous: the "parent" `fillet#3:corner:A&B&C` is the same corner round the whole `C`, which is the right face when `C` became whole again, and such a resolution is always `fragile`, so it warns.
- **Sketch region pieces.** Region edge ids `e2#1` are positional: their faces are fragile, and `e2` is their ancestor, so a reference to `side:e2` finds `side:e2#1` as a descendant.

### STEP exchange

`Kernel.exportStep(bodies)` (the `exportStep` op, `src/exchange.ts`) writes one AP214 STEP file (`AUTOMOTIVE_DESIGN` schema, lengths in millimetres) with every body a top-level product of its name; `Kernel.importStep(data)` (the `importStep` op) reads one with `STEPControl_Reader` into a new shape. OCCT's translators only work on files, so both go through the instance's in-memory file system (a scratch file in MEMFS, removed on every path, a write that fails part way included).

Names need XCAF. The plain `STEPControl_Writer` names every product `Open CASCADE STEP translator 8.0 <n>`, so export builds an XCAF document (`TDocStd_Document`, `XCAFDoc_ShapeTool.AddShape`, a `TDataStd_Name` per body) and writes it with `STEPCAFControl_Writer`. What libcascade 3.0.2 binds for this, checked:

- `STEPControl_Writer` and `STEPControl_Reader`: bound and working (`Transfer`, `Write`, `ReadFile`, `TransferRoots`, `OneShape`).
- `STEPCAFControl_Writer` and `STEPCAFControl_Reader`, `XCAFApp_Application.GetApplication().InitDocument`, `XCAFDoc_DocumentTool.ShapeTool`, `TDataStd_Name.Set`: bound and working; names round-trip through `STEPCAFControl_Reader` too.
- **Trap:** `STEPCAFControl_Writer.Transfer(doc, mode, multi, progress)` binds `multi` (a `const char*` that must be null for one file) as `std::string`, so it can never be null, and an empty string turns on external references: one file per body plus an assembly file. `Perform(doc, path, progress)` passes null inside OCCT and writes one self-contained file; it is what export uses.
- Reading a name back from a `TDataStd_Name` needs `TCollection_ExtendedString.ToExtString`, which is not usable (unbound type). Product names are read from the file text instead (`@manufakture/io`'s `stepProductNames`).
- AP242 would need `Interface_Static.SetCVal("write.step.schema", ...)`; export stays on OCCT's default, AP214, which is the older and more widely read of the two.

The XCAF document's attributes hold the shapes, so the root label's attributes are forgotten (`ForgetAllAttributes`) before the wrappers are deleted; the reader's work session is cleared (`ClearShapes`, `WS().ClearData(1)`) on every path, failures included. Imported files come from outside, so `importStep` refuses an empty file, one over `MAX_STEP_BYTES` (64 MiB, checked before base64 text is decoded), text that is not STEP and a file with no shapes, each as `invalid-argument`; a truncated file and a header with no data are tested to fail cleanly and leave no embind object behind. `exchange.test.ts` round-trips the demo part (volume, area, face, edge and vertex counts, tight bounding box), checks the schema, unit and product names in the file, runs the `import` feature against a body, and checks with the embind tracker that export and import leave no live embind object behind. They do cost wasm heap: libcascade's empty destructors (ADR 0002) keep some of each cycle, measured at about 400 KB per export and 280 KB per import of the demo part. That growth is bounded by instance recycling, like every other operation's; the test checks it stays far below what a leaked file or model would add.

The **`import` feature** (`applyFeature`, kind `import`) reads the file and names every face `<id>:face:<n>` in the order `TopExp.MapShapes` gives for the file's shape. Imported topology has no history to carry names across edits of the file, so the names are positional: `isPositional` counts a name built on `import#k:face:<n>` as positional, every face and edge name is `fragile`, and a reference to one always resolves with a warning. `mode` combines the shape with the body like an extrusion's (`new` without a body makes it the body). A file OCCT cannot read fails the feature with `invalid`, passing the body through.

### Measure

`Kernel.measure(shape, targets, { body? })` (the `measure` op, `src/measure.ts`) measures the exact B-rep, never the mesh, in millimetres and radians. A target is a face, edge or vertex of the shape: by its name on a body made by feature operations (faces and edges by the naming layer's name, a vertex by `vertexName`, the sorted names of the faces around it joined by `&`), or by 1-based index (a body with no names, and the viewport's vertices, which have no mesh name slots). A target that is not on the shape, or whose name matches several, is reported in its `items` slot (`not-found`, `ambiguous`) and the others are still measured.

- **Per target**: a vertex's point; an edge's curve type, length, end points, midpoint, direction (lines) and centre, radius, axis and swept angle (circles and arcs); a face's surface type, area, centroid, outward normal (planes), axis and radius (cylinders, spheres, tori; cones get the axis).
- **Two targets**: `distance`, the minimum distance from `BRepExtrema_DistShapeShape` with its witness points `from` and `to` (when several pairs reach it, as between parallel faces, the pair nearest the middle of all of them), and `angle` when both have a direction: between two lines (line edges, cylinder and cone axes), two planes, or a line and a plane, always 0 to 90 degrees, plus for two planar faces the angle between their outward normals (0 to 180).
- **`body: true`**: volume, surface area, centre of mass (`BRepGProp`, uniform density) and a tight bounding box (`BRepBndLib.AddOptimal`, not enlarged by tolerances, unlike `properties`).

`BRepExtrema_DistShapeShape` holds both input shapes, so it is released before delete by loading null shapes into it (`releaseOwned`). `measure.test.ts` checks every value against geometry computed by hand.

### Hole sizes

`HOLE_SIZES` (`src/holes.ts`), `holeSize(size)` and `clearanceDiameter(size, fit)` give clearance holes for metric M3 to M12 and inch #6 to 1/2" in close, normal and loose fits, with counterbore and countersink sizes. Metric clearances are ISO 273 (fine, medium, coarse; the same values as ASME B18.2.8's metric table), inch clearances ASME B18.2.8 (the nominal diameter of the drill it names). Both were checked against charts reproducing the standards, not the standard texts. Counterbore and countersink sizes (socket head cap screws, ISO 4762 / ASME B18.3; flat heads 90 degrees ISO 10642, 82 degrees inch) are not verified and are marked so per size (`verified`).

### Known-hard cases

OCCT refuses many fillets and shells, and some it gets wrong without saying so. `features.test.ts` keeps a corpus that must fail cleanly (a per-feature error, the body passed through, nothing left in the arena): a fillet wider than the faces beside its edge, a fillet taller than the block, an oversize chamfer, a fillet on a 0.2 mm step. Two shells OCCT gets wrong silently: a wall thicker than half the part, and removing every face, both come back as the unchanged solid, reported valid. The shell feature rejects removing every face up front, and checks that every kept face grew a wall and that the volume changed, failing with `invalid-shape` otherwise.

Closed hollows of filleted L-brackets are in the corpus too, at 0.5 and 3 mm, inward and outward; they must be exactly right or fail cleanly. Outward, OCCT's offset of such a body came back as a hollow reported ok that was only the enlarged offset (the cut of the body from it left it untouched), or at 3 mm a collapsed sliver of a few mm3. `hollow` therefore checks that the offset grew (inward: shrank) the volume, that its bounding box contains the body's (inward: fits inside it), and that the result's volume is the difference of the two, failing with `invalid-shape` otherwise. With the OCCT build in use all eight of these bracket hollows fail: outward mostly on these checks (one offset throws), inward in OCCT's offset or cut. An offset or cut that throws is reported as `invalid-shape` too, not a bare `kernel` error, with OCCT's message and a hint (another wall thickness, or hollowing before filleting). Closed hollows are only reliable on bodies without fillets for now.

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

Face `i` is slot `i - 1` of every per-face array, edge `i` slot `i - 1` of every per-edge array: the same numbering as history and topology. Tessellating a body made by `feature` ops fills every slot from the body's names through the batch's `NameTable` (`applyNames`), and the reply carries `table.names` once; raw shapes keep `UNNAMED` slots. `faceNameOfTriangle` is the picking lookup (decision 8: picking returns a name); for an edge, or to store a reference, send a `pick` op.

## Cancellation

Generation numbers, as ADR 0007 decision 4 decides. Every request carries a `generation` that increases with every edit. A batch is abandoned when a request with a higher generation arrives before it finishes, or when `cancel(g)` covers it; batches with equal generations do not cancel each other and run in submission order. Batches never run concurrently.

An OCCT call cannot be interrupted, so the unit of cancellation is one op: the batch yields to the event loop between ops (a macrotask, not `setTimeout`, which browsers clamp), which is what lets a newer request or a `cancel` message be received at all while a batch runs. A cancelled batch releases every shape it made and replies `status: 'cancelled'` with no results; that includes a newer request that arrives during the last op, which the batch sees at one more yield after it. On the main thread, `KernelClient.submit` resolves to `null` for a reply that a newer submit has superseded. When such a reply had finished (the newer submit came while it travelled back), the client releases the shapes it kept through the worker's `release(shapes)`, which is not a batch: it runs after whatever is queued, is never cancelled and does not count as a newer request, so the next edit (during a drag there always is one) cannot cancel it and leak the shapes. Callers releasing shapes they kept themselves use the same path, `KernelClient.release(shapes)`, and never a `release` batch, which the next edit's cancel could drop. A batch at a stale generation is cancelled even when it is empty. A batch cancelled after its last op has run every op, so its `release` ops have taken effect although the reply carries no results. A `release` op on a lost kernel fails as `fatal`, like every other op.

Terminating the worker is the last resort for a single op that never returns: `KernelClient.restart()` terminates and respawns it, resolves pending submits to `null`, and every shape id is gone; the `onRestarted` option is called once the new worker is ready, so the owner can replay its document. It is not the normal cancellation path because it costs a new instance (0.3 to 0.4 s) plus a replay.

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
- `regions.test.ts`: sketch regions (a fixture made by `packages/sketch`) as faces and extrusions, with every side face named by its edge id;
- `features.test.ts`: golden volume, face count and bounding box of every feature against hand-computed values, the names each gives, and the known-hard corpus;
- `survival.test.ts`: the T0.5 scenarios on the production features: the fillet stays on its semantic edge through resizing, sketch splits, reordering and all at once (its geometry is asserted), lost, ambiguous, ancestor, ends and ordinal resolutions, with their warnings;
- `feature-ops.test.ts`: the `feature`, `resolve` and `pick` ops through the service, and meshes of named bodies with every name slot filled;
- `exchange.test.ts`: STEP export and import round trips, product names and units, the `import` feature and its fragile names, the `exportStep` and `importStep` ops, no leaked embind objects or scratch files, and bounded heap growth;
- `measure.test.ts`: golden measurements (volume, area, centre of mass, bounding box, face-face, skew edge-edge and vertex-face distances with witness points, angles, radii, arcs) of boxes, cylinders and named prisms, and the `measure` op through the service;
- `names.test.ts`, `naming.test.ts`, `ops.test.ts`: name tables, the naming rules on synthetic history, and op validation, no wasm.

For golden tests, `createNodeKernel()` gives a synchronous kernel and `createNodeService()` the full service, both from a module compiled once per process.

## Deviations from the ADRs

- **Op batches here, `regen` in the regen worker.** ADR 0007 decision 3 has one `regen` call per user intent. This worker exposes the plumbing under it: batches of kernel ops with in-batch references, including one `feature` op per part feature. `regen` is added on top of `KernelService` by the regen worker (`packages/regen`, `createRegenWorkerApi`), without changing the protocol rules (generations, errors as data, transfer).
- **API surface.** Implemented from ADR 0001: `release`, `checkpoint`, `releaseSince`, `shapeCount`, `heapBytes`, `box`, `cylinder`, `profile`, `extrude`, `revolve`, `boolean`, `fillet`, `chamfer`, `count`, `mesh`, `exportStep`, plus `shell`, `offset`, `draft`, `transform`, `compound`, `geometry`, `importStep`. Not yet: `describe`. `exportStl` is not a kernel call: STL and 3MF are written from `mesh` output by `@manufakture/io`, which welds and checks the mesh. `volume` and `boundingBox` are one `properties()` query; `adjacentFaces` is covered by `topology()`. `profile` takes a `Frame` (origin, xDir, normal) as its plane.
- **Multi-body parts are one compound.** A `new` feature on an existing body puts the new solid next to it in one compound shape, so every feature takes and returns one body id; later booleans act on the whole compound. Until M2 brings real multi-body parts, a `new` solid must not overlap the body (`invalid`).
- **The `feature` op reply carries every name.** `FeatureOutcome.names` holds the whole table of the new body: every face with its lineage and every edge. That is more than the UI needs per edit (it needs the mesh name slots, and lineage only to resolve references, which happens in the worker). Slimming it (names of the new body only, lineage on demand) is left to the regen engine (#932), which decides what a `regen` reply carries.
- **Up to face** extrudes to the plane of a planar face (the face's own boundary does not limit it), and only planar faces are accepted.
- **`KernelError`** carries a `code` (the table above), `occtMessage` and `featureId` besides ADR 0001's `operation` and `occtType`.
- **Mesh layout.** ADR 0007 left the edge polyline layout to this task: `edgePositions` plus `edgeRanges`. `triangleFaces` is added next to `faceRanges`. Name slots are `UNNAMED` until the naming layer fills them.
- **History by default.** ADR 0001 has `history?: boolean`; ADR 0007 requires history from every topology-changing op, so it is on unless `history: false`.
- **Topology and mesh extraction go through embind**, not C++ helpers (ADR 0002, decision 3); the API is shaped so that the custom build can replace them.
- **No solver port.** The regen worker runs the sketch solver in-process instead of on a `MessageChannel` port to the solver worker (ADR 0007 decision 2, amended; the reasons are in the regen README). The replay after a recycle is the app's: it regenerates the document when it hears the `recycled` status.
