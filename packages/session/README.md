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
| `engine.ts`              | `WorkerEngine` (default) and `InProcessEngine`: where a session's regen engine and kernel run; which scripts run.        |
| `worker/entry.ts`        | The worker thread's script (`./worker`): the regen worker API on the main thread's compiled kernel module, over Comlink. |
| `worker/text.ts`         | The text worker's script: user fonts read and texts in them laid out, under the watchdog.                                |
| `worker/ts-hooks.ts`     | Development and tests only: lets the worker load the workspace's TypeScript sources.                                     |
| `node-host.ts`           | What a Node host injects into regen: bundled fonts from `file:` URLs, the text worker, QuickJS, the domains.             |
| `symbols.ts`             | Symbolic ids: `extrude#$boss` to `extrude#2`, through core's `commandIds` and `remapIds`.                                |
| `queries.ts`             | `tree`, `object`, `findGeometry`, `measure`, `quantities`, `errors`.                                                     |
| `model.ts`               | `ModelState`: what the session keeps between regens (face and edge names with geometry, member sets).                    |
| `schema.ts`              | JSON Schemas of command types and feature kinds, with `doc-comments.json`.                                               |
| `doc-comments.ts`        | Reads core's doc comments from its sources; `doc-comments.test.ts` keeps `doc-comments.json` equal to them.              |
| `imports.ts`             | Reference import bodies (STEP through the kernel, STL as a mesh), read again on the session's kernel.                    |
| `rebase.ts`              | Replaying the branch's commands onto Main's head, one command at a time (T7.1f's merge).                                 |
| `bundles.ts`             | `BundleBuilder` and its context, `BundleStore`, `BackendBundleStore` (branch directory, blobs) and `MemoryBundleStore`.  |
| `sync.ts`                | `SyncedLibrary`, `SyncBundleStore`, `RemoteRefusal`: sessions over a sync server (T8.4b).                                |
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
  the old branch is deleted. The new branch is `open`, and a reviewer's comment on the old one
  carries over (the library copies it, `reviewCommentFrom`), since the agent is still working on
  the changes asked for; a comment changed meanwhile refuses the update. The answer names the new branch, the batches applied, and those
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
  state set to `submitted`, the one forward move an agent makes (ADR 0016 decision 9), and only
  from `open`. A later write returns the branch to
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

## Sessions over sync

ADR 0016 decisions 10 and 12, M8 plan T8.4b. The reviewer sees an agent branch through the sync
server, so a session normally works there, with an agent token (apps/server README, "Agent
tokens"). Nothing in `Session` changes: its library is a `SyncedLibrary` (`sync.ts`), a
`DocumentLibrary` whose files are a working copy (in memory by default) of what the server holds,
and whose changes that matter go to the server first:

```ts
import {
  MemoryBundleStore,
  ServerApi,
  SessionManager,
  SyncBundleStore,
  SyncedLibrary,
} from '@manufakture/session';

const api = new ServerApi({ url: 'http://127.0.0.1:8787', token: agentToken });
const library = new SyncedLibrary(api);
const sessions = new SessionManager({
  library,
  locks: library.locks,
  bundles: new SyncBundleStore(new MemoryBundleStore(), api),
});
```

- **Main** is the server's: `open(id, 'main')` (and `previewMerge` into main) read it from there
  into the working copy (`pullMain`), whose main is a cache that is never sent anywhere.
- **Open** (`branchFromRevision`, from Main's head only): when the server has a version of Main's
  head, the branch starts from it (kept in the working copy as a version from the server) and no
  version is added; otherwise the start version is made here and sent with the branch
  (`startVersion`), which the server stores in one transaction with it, recording the token, and
  deletes with it. An agent token never adds a version to Main on its own. Then this process
  claims the branch's log (`hello`, the server's one-writer lease). An update from Main asks the
  server to copy the reviewer's comment (`commentFrom`): it never comes from the session.
- **Every batch** (`save` on a branch) is one sync entry of the branch's server log, with its
  created ids, submitted before the working copy saves it. A refusal (core's, a closed branch, a
  revoked token, another writer) throws a `RemoteRefusal`, whose fixed text with the server's code
  the session passes to the agent; the branch and the working copy stay as they were. The working
  copy's revision `n` is the server log's revision `n - 1`.
- **Review states** go to the server first, as compare-and-sets (`review-changed` is the session's
  `reviewChanged`), and the server decides what an agent token may set. `listBranches` takes the
  server's states and comments into the working copy, so the session's check before every write
  sees a reviewer's decision.
- **Bundles** and their images go to the server with the branch (`SyncBundleStore`); a branch
  resumed in another process reads its newest bundle from there.
- **Deleting** a branch (the old one, after an update from Main) deletes it on the server, as a
  compare-and-set on its review state there.
- **Resume** in another process: `materialize(documentId, branch)` builds the branch in the working
  copy from the server (its version, its record with provenance, one revision per log entry) and
  claims it; then `SessionManager.resume` as usual. A branch another client writes is refused,
  with `busy` set on the failure (`SyncFailure`).
- **The lease** on every branch this process holds is renewed with a hello every `keepAliveMs`
  (30 s, `DEFAULT_KEEP_ALIVE_MS`), so an agent that thinks for minutes between batches keeps its
  branch. The timer runs only while a branch is held, and never keeps the process alive.
- **Close** releases the branch lock, which lets go of the server's lease (`library.locks`), so
  another process can resume the branch at once; one that ends without a word frees it after the
  server's lease time.

An update from Main is "unchanged" when the base version's document is Main's head, whatever the
revision numbers of the copy that holds them.

`sync.test.ts` runs sessions against a real sync server (`test/sync-server.ts`, exported as
`@manufakture/session/test-sync-server` for apps/mcp and apps/web): the version and branch on the
server, batches and undo as log entries, the bundle and its image, a reviewer's request and
approval taken in, an update from Main after the owner edited it (the comment carried over, the
old branch gone with its start version), a branch started from a version of Main's head the
server has, a resume in another process, one writer per branch, the lease renewed while an agent
writes nothing, a revoked token and a token for other documents.

## Main is never written

Three checks in this package (ADR 0016 decision 12; the MCP server and the sync server add theirs):
a session's branch is made by `branchFromRevision` with agent provenance or, on resume, must carry
it; `resume` refuses Main by name, and a branch without agent provenance; and the one function
that saves (`#saveTo`) refuses Main whatever its caller checked. The library calls a session
makes on Main are reads, and versions (Main's head named "Agent session ... start" or "... update
from Main"), which name a revision and change no document. Over sync, such a version reaches the
server only with its branch, attributed to the agent token (above).

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

## Scripts and user fonts

ADR 0016 decision 2. This runs untrusted code and parses untrusted files headlessly, so each runs
where the host can end it, with the limits the app has, and nothing is widened.

**Which scripts run: the branch's own.** Before every regen the engine sends the regen worker a
`ScriptPolicy` (`sessionScriptPolicy`): the scripts of the regenerated document that the session's
base document (its branch's base version, read when the session starts) does not have with the
same id and source, each granted by its id and the SHA-256 of its source, as the app grants a
script the user wrote on this device. Never `auto` and never a whole document, so scripts already
in the document from someone else, and the scripts of a derived part's source document, do not run;
their features fail with `not-allowed` (`scriptsNotRunError`), as in the app before the user
allows them. A script the agent edits becomes its own, and the review shows it in full. An update
from Main makes Main's head the base (restored when the update fails). The bundle builder's
engine (`BundleContext.engine`) gets the same base, so the bundle has the bodies the session has,
and those the reviewer's regen has with **Run scripts**, which grants exactly the head's scripts.
Without a base (an engine started elsewhere) no script runs.

**Where they run: only in a worker engine.** The session's worker gets the QuickJS module the
main thread compiled (`nodeScriptModule`) and runs scripts with `@manufakture/script`'s default
limits (2 s per run, 64 MiB heap, the host call, kernel operation and payload limits), as the
app's regen worker does. The hard limit is the main thread's, as `RegenClient`'s is in the app:
the worker reports every run's start and end on a channel of its own, set before its API is
exposed, so no script runs unwatched; a run still going after `SCRIPT_HARD_TIMEOUT_MS` (10 s, the
app's) terminates the worker. The call in flight rejects with `ScriptStopped`, the session starts a
new worker, which is given the stopped runs' cache keys (at most 1,000) and fails those features
with a `timeout` error instead of running them again, and regenerates within what is left of the
batch's regen time (at most 3 stops a regen). An `InProcessEngine` cannot end a run, so it is given
no script engine: scripted features fail there as `unsupported`.

**User fonts.** Texts in a bundled font are laid out in the engine's thread as before (the font's
bytes are pinned by SHA-256). A user font is read, and texts in it laid out, in a text worker
(`worker/text.ts`, started on the first user font, ended with the engine) under
`createWatchdogOutliner`: 10 s a request, the regen's text budgets, a font that timed out or
crashed not tried again. The text worker has a 1 GiB V8 heap (`TEXT_WORKER_HEAP_MB`), so a font
that exhausts memory ends that worker, never the process. Both engines use it; in a worker engine
it is a worker of the session's worker.

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
  `reviewed: false` (ADR 0016 decision 6: on an agent
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
  replaces the worker. Scripts: the agent's scripted pin builds its body, and the bundle
  builder's engine gives the same bodies and volumes as a reviewer's regen with **Run scripts**;
  a script already on Main does not run until the branch changes it; a run past the hard limit
  ends the worker once and then fails as `timeout`; an update from Main takes Main's head as the
  base (a script Main absorbed stops running), and one that fails keeps the old base. User fonts:
  a text in a user font builds on both engines; a file that is not a font, and a text worker that
  runs out of memory or exits, fail the text as data and the session goes on.
- `engine.test.ts`: the worker engine's lifecycle; the script policy (own scripts by source, none
  without a base); the in-process engine runs no script.
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

- **Scripts from someone else.** Scripts already in the document when the branch was made never
  run in a session: there is no session setting to run them (ADR 0016 decision 2 leaves it to
  the session's configuration). A reviewer who allows such a script gets its bodies in the app's
  regen and not in the bundle; the regen check leaves those bodies out, with a note, by the same
  rule worked out from the branch's base version (apps/web `scriptedNotRunBySession`).
- **Scripts in process, renders and exports.** An `InProcessEngine` runs no script (above), and
  apps/mcp's `render` and `export` regenerate on an engine of their own with no script engine,
  so their images and files leave scripted bodies out.
- **Exact clearance between bodies.** The kernel has no minimum-distance operation between two
  shapes; `clearance` reports overlap volumes exactly and, for bodies apart, a bounding-box gap,
  which is a lower bound. Distances between faces of one body are exact (`targets`).
- **A synced branch revision holds one batch.** Over sync, every revision is one entry of the
  branch's server log; the session never saves several at once.
