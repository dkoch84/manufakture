# @manufakture/session

Headless document sessions ([ADR 0016](../../docs/adr/0016-agent-sessions.md), M8 plan
[T8.1c](../../docs/plans/agent-surface.md)): one agent on one agent branch of one document, in
one Node process, with a regen engine and kernel of its own. A session applies batches of core
commands, answers the queries behind the MCP read tools, and never writes Main. There is no
transport here: `apps/mcp` (T8.4a) puts the tools on top. Node only (`node:fs`,
`node:worker_threads`).

```ts
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend, NodeBranchLocks } from '@manufakture/library/node';
import { BackendBundleStore, SessionManager } from '@manufakture/session';

const backend = new NodeBackend('/srv/library');
const sessions = new SessionManager({
  library: new DocumentLibrary(backend),
  locks: new NodeBranchLocks('/srv/library'),
  bundles: new BackendBundleStore(backend),
});
const opened = await sessions.open({ documentId, clientName: 'Claude Code' });
if (!opened.ok) return opened.error; // errors are data
const session = opened.value;
const report = await session.apply({
  label: 'Add a boss',
  commands: [
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: { id: 'sketch#$s', kind: 'sketch' /* ... */ },
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: { id: 'extrude#$boss', profile: { sketch: 'sketch#$s' } /* ... */ },
    },
  ],
});
// report.value.symbols: { $s: 'sketch#3', $boss: 'extrude#2' }
await session.close(); // the branch stays
```

| File                     | What                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `session.ts`             | `Session`: open, resume, apply, undo, updateFromMain, submit, close, and the reads.                                      |
| `manager.ts`             | `SessionManager`: the sessions of one process under the per-process limit; the host each session gets.                   |
| `engine.ts`              | `WorkerEngine` (default) and `InProcessEngine`: where a session's regen engine and kernel run.                           |
| `worker/entry.ts`        | The worker thread's script (`./worker`): the regen worker API on the main thread's compiled kernel module, over Comlink. |
| `worker/ts-hooks.ts`     | Development and tests only: lets the worker load the workspace's TypeScript sources.                                     |
| `node-host.ts`           | What a Node host injects into regen: the bundled font read from `file:` URLs, the stock, wood and construction domains.  |
| `symbols.ts`             | Symbolic ids: `extrude#$boss` to `extrude#2`, through core's `commandIds` and `remapIds`.                                |
| `queries.ts`             | `tree`, `object`, `findGeometry`, `measure`, `quantities`, `errors`.                                                     |
| `model.ts`               | `ModelState`: what the session keeps between regens (face and edge names with geometry, member sets).                    |
| `schema.ts`              | JSON Schemas of command types and feature kinds, with `doc-comments.json`.                                               |
| `doc-comments.ts`        | Reads core's doc comments from its sources; `doc-comments.test.ts` keeps `doc-comments.json` equal to them.              |
| `imports.ts`             | Reference import bodies (STEP through the kernel, STL as a mesh), read again on the session's kernel.                    |
| `rebase.ts`              | Replaying the branch's commands onto Main's head, one command at a time (T7.1f's merge).                                 |
| `bundles.ts`             | `BundleBuilder` and its context, `BundleStore`, `BackendBundleStore` (branch directory, blobs) and `MemoryBundleStore`.  |
| `limits.ts`, `errors.ts` | The limits, and the typed errors every refusal is.                                                                       |

## Sessions

- **Open** (`SessionManager.open({ documentId, clientName })`): `branchFromRevision` records
  Main's head as a version "Agent session `<id>` start" and makes an agent branch from it,
  named "Agent session `<id>`", with provenance `{ origin: 'agent', sessionId, clientName,
review: 'open' }` (the library checks `clientName`). The session takes the branch's lock
  (`NodeBranchLocks`), starts its engine, opens the branch and regenerates it fully. When any of
  that fails, the new branch is deleted again (its start version stays).
- **Resume** (`resume({ documentId, branch })`): an agent branch in review state `open` or
  `changes-requested`; never Main, a person's branch, or one that is `submitted` (the session
  would race the reviewer), `approved` or `rejected`. The session id is the branch's; one that is
  open in this process is refused (`locked`).
- **Apply** (`apply({ label, commands, dryRun })`): the commands go through core as one `batch`
  (all or nothing), regen rebuilds what changed, and the library saves one revision of the branch
  with one log entry `{ cause: 'execute', label, command }`. The answer: the revision, the
  symbolic id table, the ids made (`createdIds`, by counter scope), features whose status
  changed, every regen error and warning, and the volume, area and box of each body whose shape
  changed (from the kernel). `dryRun` applies, regenerates and answers, then puts the engine back
  and saves nothing. A batch that core refuses, or whose regen runs over the limit, or that the
  library cannot save, leaves the branch, the document and the engine as they were.
- **Undo**: the inverse of the branch's last batch not undone, as a new revision logged with
  `cause: 'undo'` and the batch's label. The session keeps its own stack of batches rather than
  `DocumentStore`'s (500 steps, and empty after a resume): after a resume the stack is rebuilt from
  the library's log, and an inverse is computed from the revision before the batch
  (`readRevision`), so undo reaches every batch of the branch.
- **Update from Main**: the branch's commands since it was made (`readLog`) replayed onto Main's
  current head with T7.1f's merge (an offline `SyncClient` with id remap and restore intents),
  one command at a time, onto a new agent branch made from that head under the old branch's name;
  the old branch is deleted. The answer names the new branch, the batches applied, and those
  dropped with the reason. Replaying onto a new branch, rather than saving the result as one
  `replaceDocument` on the old one, keeps one revision per batch, and a later merge into Main
  replays only the agent's own commands: a `replaceDocument` on the branch would be replayed as a
  restore of the whole document and undo whatever Main did after the update. The branch id
  changes; nothing else that names it exists before a submit. When Main has not moved, nothing
  happens (`changed: false`).
- **Submit** (`submit(builder, note)`): `builder(base, head, context)` (`@manufakture/review`'s
  `bundleBuilder`; a stub in the tests) gets the base version's document, the head's document,
  revision and last regen, and a `BundleContext`: the document id, the library (for the branch's
  log and the merge preview), `engine()` to start an engine of the host's kind for the builder
  alone (it closes it), the session's limits, and `putBlob(bytes)`, which stores an image as a
  blob of the document (`documents/<id>/blobs/<sha256>`, at most `MAX_BUNDLE_BLOB_BYTES`) and
  returns its SHA-256. It returns the bundle as JSON data. It is stored with the branch
  (`BundleStore`, keyed by the head revision; at most `MAX_BUNDLE_BYTES`) and the branch's review
  state set to `submitted`, the only state an
  agent may set (ADR 0016 decision 9), and only from `open`. A later write returns the branch to
  `open`, and `info().bundle.stale` turns true. A write to a branch the reviewer has `approved`
  or `rejected` is refused; one with `changes-requested` returns it to `open`.
- **Close**: releases the engine (a worker is terminated), the branch lock and the idle timer.
  The branch and its bundles stay. A session idle for `idleMs` (30 minutes) closes itself. A call
  in flight gets `regenStopMs` to finish; then the session ends anyway, so a stuck call never
  holds its slot, and later calls answer `closed` at once.

Calls on one session run one at a time, in order. Every write first checks the lock is still held
(`lock-lost` otherwise: another process broke it) and reads the branch's review state again.

**A reviewer's decision is never overwritten.** A batch's regen may take 30 s, so the state is read
again right before the save, and every state change is a compare-and-set
(`setBranchReview(id, branch, review, { expected })`): a write to a `submitted` or
`changes-requested` branch sets it to `open` only if it is still in the state just read, and a
submit sets `submitted` only if the branch is still `open`. Otherwise the call answers
`branch-state` and nothing is saved. An update from Main reads the old branch's state again before
it deletes it (the commit); a refused or failed delete removes the new branch instead. What is
left is the window between that last read and the save itself, which only a reviewer acting on an
`open` branch could use; the review UI acts on submitted branches.

### Symbolic ids

A model cannot reliably compute the next free id of each counter (ADR 0016 decision 8), so any id
may have its **number** replaced by `$name`: `extrude#$boss`, `sketch#$s`, `e$p1`, `part#$side`,
`assembly#$a` and `inst#$one`, and inside face names `extrude#$boss:side:e$c`. The counter stays
written, so each symbol has exactly one counter (the ADR's example writes `$boss` alone; with the
counter in the symbol nothing has to be guessed from context). Resolution (`symbols.ts`):

1. each symbol becomes a placeholder id of its counter, numbered from `PLACEHOLDER_BASE`, far
   above any counter and below the sync tombstone;
2. core's own walk of the commands (`commandIds`) says in which counter scope each placeholder
   sits in a plain id field;
3. real ids are handed out per scope and counter in order of first appearance, from the
   document's counters (as `previewIds` does), past any literal fresh id of the same counter in
   the batch; a part or assembly the batch makes starts its own counters at 1;
4. core's `remapIds` substitutes them through the whole batch, face names included, through the
   naming parser;
5. a placeholder in text no id walk reaches (a name, a note) is put back as written, in one regex
   scan of each string.

Before step 1 the batch's shape is checked without recursion, and a literal id numbered at or
above `PLACEHOLDER_BASE` (core's tombstone aside) is refused (`symbol`), so none can pass for a
placeholder.

A symbol written with two counters, or used for two different things (two scopes), is refused
(`symbol`), as is one that no command of the batch creates. Two creations of one symbol, or a use
before its creation, are refused by core like any such batch. A symbol lives for one batch.

## Limits

ADR 0016 decision 3. Each ends in a typed error (`SessionError` with `code` and `limit`), never a
throw. `sessionLimits(overrides)` checks overrides.

| Limit                 | Default                          | Error                                              |
| --------------------- | -------------------------------- | -------------------------------------------------- |
| Commands per batch    | 500 (nested ones counted)        | `too-many-commands`, before anything runs          |
| Batches per session   | 2,000 (dry runs and undos count) | `too-many-batches`                                 |
| Regen time per batch  | 30 s, then 5 s to stop           | `regen-timeout`, the batch rolled back             |
| Any other kernel call | 30 s (`kernelMsPerCall`)         | `kernel-timeout`; the kernel is ended (below)      |
| Kernel heap           | 512 MiB                          | none: the kernel is replaced (below)               |
| Document size         | 64 MiB of JSON (`.mfk`)          | `document-too-large`, checked before the regen     |
| Sessions per process  | 4 (worker), 2 (in process)       | `too-many-sessions`                                |
| Idle                  | 30 minutes                       | the session closes; its calls then answer `closed` |
| One session a branch  | the branch lock                  | `locked`                                           |

Also bounded: batches nested at most `MAX_BATCH_DEPTH` (8) deep and JSON at most
`MAX_JSON_DEPTH` (100) deep (`too-deep`), and commands counted through nested batches, all checked
without recursion before anything parses the batch; labels 1 to 200 characters without control or format characters
(`invalid-label`); notes to the reviewer 4,000 characters; symbols per batch 10,000; bundles 64
MiB; `findGeometry` 200 results; `measure` 64 targets or bodies. Images are `packages/render`'s.

A regen over its time is cancelled through the kernel (which acts between operations); if it has
not stopped `regenStopMs` later, a worker engine terminates its worker and starts a new one, which
is the hard bound. An in-process engine can only wait for the operation to end.

Every other kernel call (a measurement, the 2,016 pairs of a 64-body interference, the
measurements of a batch report, a STEP reference read, a heap probe) runs under
`kernelMsPerCall`: past it the worker is terminated and a new one started, the document
regenerated on it, and the call answers `kernel-timeout`. A batch whose report measurements ran
over is still saved, with no measurements. A STEP file that ran over keeps that as its error and
is not read again until its file changes. A new worker gets `WORKER_START_MS` (2 minutes) to load
its kernel.

**Errors the agent reads.** File system errors (with absolute paths) and a worker's error text
never reach the agent: it reads a general message with the system error code (`storage failed
(ENOSPC).`), and the full error goes to the host's log hook (`SessionManagerOptions.log`).

## Main is never written

Three checks in this package (ADR 0016 decision 12; the MCP server and the sync server add theirs):
a session's branch is made by `branchFromRevision` with agent provenance or, on resume, must carry
it; `resume` refuses Main by name, and a branch without agent provenance; and the one function
that saves (`#saveTo`) refuses Main whatever its caller checked. The library calls a session
makes on Main are reads, and versions (Main's head named "Agent session ... start" or "... update
from Main"), which name a revision and change no document.

**No path from input to storage paths.** Document ids must be `isStorableId`, branch and session
ids `isBranchId`/`isStorableId`, before any library or lock call; the library and `NodeBackend`
confine every path again. `BackendBundleStore` writes
`documents/<id>/branches/<branch>/review-<rev>.json` from those ids and a revision number only,
and blobs as `documents/<id>/blobs/<sha256>` from the document id and the hash it computes;
`readBlob` refuses a name that is not a SHA-256 and bytes that do not match it.
The worker's script and Node options come from the host's configuration, never from a call.

## Engines and memory

Each session has a kernel service of its own (a recycle drops every shape of every engine on a
service). Where it runs:

- **`WorkerEngine`** (the default): the regen worker API (`createRegenWorkerApi`: engine, kernel,
  solver, text, domains) in a `worker_threads` worker, over Comlink on a `MessageChannel`. The
  main thread compiles libcascade once and sends the `WebAssembly.Module`; each worker only
  instantiates it. The kernel never recycles in place (`autoRecycle: false`): after each regen
  the session asks the worker's heap, and past the threshold terminates the worker and starts a
  new one, then regenerates. A worker that dies is replaced the same way, and the call answers
  `kernel`. Starting a worker costs about 1.6 s here (most of it the TypeScript hooks, below).
- **`InProcessEngine`**: the same API in this thread, recycling in place as the app does; the
  session regenerates once more when a recycle landed right after its regen (T8.0a). Cheaper to
  start; the tests use it.

**The T8.0a open item: is a replaced kernel freed?** `memory.test.ts` (opt-in, see Testing) runs
the cabinet for 1,000 batches (a shelf moved to a new height each time) with the kernel
replaced once its heap passes 130 MiB, and samples the process's resident memory:

| Resident memory (MiB), at batch    | 0   | 200 | 400   | 600   | 800   | 1,000 | Highest | Replaced | Time   |
| ---------------------------------- | --- | --- | ----- | ----- | ----- | ----- | ------- | -------- | ------ |
| Worker engine                      | 634 | 730 | 713   | 738   | 723   | 772   | 824     | 5        | 94.4 s |
| In process                         | 507 | 805 | 1,075 | 1,352 | 1,609 | 1,869 | 1,870   | 5        | 94.8 s |
| In process, `gc()` after a recycle | 502 | 788 | 1,045 | 1,307 | 1,290 | 1,336 | 1,455   | 5        | 85.4 s |

Measured 2026-10-08 on the T8.0a machine (Node 26.10), one process per row, sampled every 25
batches (`process.memoryUsage().rss`, which counts the worker's memory too). In every row the
kernel was replaced between batches 175 and 200, 350 and 375, 525 and 550, 700 and 725, and 875
and 900.

**Terminating the worker bounds memory; recycling in place does not, even with a collection.**
With the worker engine resident memory rose by about 1 MiB a batch as the kernel heap grew, and
fell back by 80 to 120 MiB at each replacement: a sawtooth between 665 and 824 MiB over the 1,000
batches, ending 138 MiB above the start. In process it rose by about 140 MiB at each recycle (the
new 128 MiB instance and its bindings, the old not yet freed) and never came back: 1.87 GiB at the
end, as T8.0a saw. A `gc()` after each recycle (the host run with `--expose-gc`; the engine then
collects on the turn after the recycle) slowed that but did not stop it: 1.34 GiB at the end;
memory came back only twice, in part, long after a recycle. A worker costs about 127 MiB more
than the in-process engine to start with (its isolate, and here the transpiled sources).

So the sessions-per-process limit is 4 with worker engines, as ADR 0016 allows once the release
is verified, and stays 2 in process.

**Running the worker.** The worker's script is `worker/entry.ts`. In development and tests it is
loaded through `worker/ts-hooks.ts` (`--import`): Node strips types itself, but the workspace
uses extensionless imports and a few constructs type stripping refuses, so the hooks resolve
`./x` to `./x.ts` or `./x/index.ts`, transpile `.ts` with TypeScript (the repository's
development dependency) and load `opentype.js` from its ES module build. A bundled host
(`apps/mcp`, T8.4a) builds `@manufakture/session/worker` as an entry of its own and passes its
URL (`SessionManagerOptions.workerUrl`); the hooks are never loaded then.

## Reads

All plain JSON; text from the document (names, labels, notes) travels only in data fields
(ADR 0016 decision 13). Lengths mm, areas mm², volumes mm³, masses g, angles degrees.

- `tree()`: parts with features (kind, status, error counts), bodies (name, material, solids)
  and member sets; variables with values; assemblies with instances and mates and their solved
  status; configurations; drawings; CAM setups; domain namespaces with their sizes.
- `object(query)`: the full JSON of one document, part, feature, variable, assembly, instance,
  mate, CAM setup, drawing, configuration table, domain namespace or script.
- `schema({ command } | { feature })`, `schemaIndex()`: JSON Schema (`z.toJSONSchema`, input
  side) of a command type (and `batch`) or feature kind, with core's doc comments as
  `description`s of the schema and its fields.
- `findGeometry(query)`: faces and edges of the last regen's bodies, from the name table regen
  sent with each body's mesh and the kernel's topology (kept per body key between regens, since a
  regen sends a body only when it changed): by `name`, `bornBy` (a feature id), `normal` (planar
  faces within `angleTolerance`), `radius` (cylinders within `tolerance`), `nearest` (sorted by
  distance of a face's centroid or an edge's midpoint), `partId`, `bodyId`, `kind`, `limit`. Each
  hit has its name (null when unnamed), whether the name is positional, its 1-based index (this
  regen only), and hints: surface or curve type, area or length, centroid or midpoint, normal,
  axis, radius.
- `measure(query)`, exact from the B-rep: `body` (volume, area, centre of mass, bounding box, and
  mass from the body's material, else the part's); `targets` on one body (each item, and between
  two the distance and the angle); `clearance` between bodies at optional placements (overlap
  volume per pair from the kernel's `interference`, and for pairs apart the gap between their
  placed bounding boxes, a lower bound); `interference` of an assembly at its solved poses or at
  given poses per instance.
- `quantities()`: the cut list and its hardware (`documentCutList`), and a construction takeoff
  per part studio with framing members (`takeoffModel`, `constructionTakeoff`), as data, with
  `reviewed: false` (ADR 0016 decision 11: on an agent
  branch nothing is reviewed).
- `errors()`: every regen error and warning of the head (features, instances, mates, reference
  imports), errors first.
- `history()`: the branch's log entries with revisions, causes, labels and times.
- `info()`: ids, branch, base version, revision, review state, batches, engine, kernel
  replacements, and the newest bundle with whether it is stale.

**Reference imports.** Regen does not build `import` features with `operation: 'reference'`; the
app reads them again from their files (`apps/web/src/persistence/imports.ts`). A session does the
same on its own kernel: STEP through the kernel's `importStep` op, STL parsed as a mesh
(`parseStl`, `meshProperties`). They are read on open, after every write that adds, replaces or
removes one (removed ones are released), and again on a new kernel instance. `measure` reaches
them by the import feature's id as `bodyId`; a file that does not read is listed by `errors()`.

## Testing

```sh
./node_modules/.bin/vitest run --project packages packages/session
```

- `session.test.ts` (the M1 bracket, in process): open on a new agent branch with provenance and
  a start version; a batch with symbolic ids lands with real ids, the table, created ids, status
  changes and measurements, saved on the branch with Main untouched; its faces found by query;
  mass with a material; a dry run saves nothing; a batch core refuses, one over the regen budget
  and one with a symbol nothing creates leave the branch unchanged; undo, then close and resume
  and undo from the library's log; a second holder of the branch refused (also across processes,
  by the lock file); Main and a person's branch refused on resume, writes to an approved branch
  refused; update from Main after a person deleted the fillet on Main: the fillet edit dropped by
  label, the boss replayed on a new branch, the old branch gone, undo still reaching the
  replayed batch; submit with a stub builder, stored, then stale after a write; the builder's
  context (log reads, an engine, blobs stored and checked on read); and each limit's
  typed error (commands per batch, nested too; batches per session; document size; sessions per
  process; idle close; labels).
- The fixtures and the seeded library are exported for other packages' tests
  (`@manufakture/session/test-fixtures`, `@manufakture/session/test-setup`).
- `queries.test.ts`: the cabinet (tree, objects, faces by plane and position, distance and angle
  between them, cut list as data, clearance and overlap between two boards); an assembly of two
  brackets made with symbolic ids (interference at the solved and at given poses); the shed
  (takeoff as data, a window moved); STEP and STL reference imports measured, then one removed;
  a schema for every command type and feature kind, with doc comments.
- `worker.test.ts`: the shed on the worker engine; a regen that does not stop ends its worker
  and the batch is rolled back, the next one served by a new worker; a heap past the threshold
  replaces the worker.
- `hardening.test.ts` (the security review): kernel calls that hang (a measurement, a batch
  report's measurements, a STEP read) end in `kernel-timeout` on a new kernel; close and idle
  close end a session whose queue is stuck; a reviewer approving or rejecting while a batch
  regenerates, while a bundle is built, or during an update from Main is never overwritten;
  batches nested too deep or holding too many nested commands refused before parsing; 10,000
  symbols in one string; literal ids at the placeholders' numbers refused; storage and worker
  errors reach the agent without their text; open and resume clean up.
- `symbols.test.ts`, `doc-comments.test.ts`: symbol resolution (order, names, literal ids, new
  parts, conflicts, text) and the comment table against core's sources.
- `memory.test.ts`: the memory probe, skipped unless `SESSION_MEMORY_PROBE=1`:

  ```sh
  SESSION_MEMORY_PROBE=1 SESSION_MEMORY_BATCHES=1000 SESSION_MEMORY_ENGINES=worker \
    ./node_modules/.bin/vitest run --project packages packages/session/src/memory.test.ts \
    --silent=false --reporter=verbose
  ```

## Not done

- **Scripts and user fonts.** Scripted features are not run (the session's engine has no script
  engine), so they regenerate as `unsupported` errors, as data.
  User fonts are refused by the in-thread outliner. In a worker engine both could run under the
  regen limit's hard bound (the worker is terminated), but ADR 0010's own limits and the policy
  for scripts already in a document are not wired yet.
- **Exact clearance between bodies.** The kernel has no minimum-distance operation between two
  shapes; `clearance` reports overlap volumes exactly and, for bodies apart, a bounding-box gap,
  which is a lower bound. Distances between faces of one body are exact (`targets`).
- **Sessions over sync** (T8.4b): opening from a sync server, batches as sync entries, and
  carrying provenance with `adoptBranch`.
