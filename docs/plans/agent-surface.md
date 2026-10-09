# M8 plan: agent surface, drive manufakture by conversation with review before Main

- Status: proposed
- Date: 2026-10-04
- Epic: "Can't CAD Can We?", milestone M8 (planned as T7.7)
- Builds on: M1 to M6 as landed, the [M7 plan](m7.md) (T7.1e versions and branches on the server, T7.1f merge by replay, T7.2 scripted features, T7.3a publish bundles), ADRs [0004](../adr/0004-document-format.md) (document format), [0006](../adr/0006-licensing.md) (licensing), [0007](../adr/0007-worker-protocol.md) (worker protocol), [0009](../adr/0009-sync-model.md) (sync model) and [0010](../adr/0010-scripting-sandbox.md) (scripting sandbox), and one ADR written for this plan: 0016, agent sessions (T8.0c)

M8 lets a person describe a change in conversation and have an agent (Claude Code, Grok, any MCP client) make it in manufakture, while nothing the agent does reaches Main until a person has reviewed it. The agent works on a branch of its own; each submission comes with a review bundle (the commands, before and after renders, regen errors, measurements); approving it in History merges the branch into Main, which is the only way agent work gets there. Exports (G-code, cut lists, construction drawings and the rest) are not gated: they are allowed from any branch, an unreviewed agent branch included (decided at ADR 0016's acceptance).

| Item                                             | Tasks                        |
| ------------------------------------------------ | ---------------------------- |
| Decisions, spikes, ADR                           | T8.0a to T8.0d               |
| Headless foundations: library, builders, session | T8.1a to T8.1c, T8.2a        |
| Review bundle, History review                    | T8.3a, T8.3b (T8.3c dropped) |
| MCP server and sessions over sync                | T8.4a, T8.4b                 |
| Authoring guide                                  | T8.5a                        |
| Acceptance scenarios that expose gaps            | T8.6a to T8.6c               |
| Security review and acceptance                   | T8.7a, T8.8                  |

## Decisions

The maintainer answered the four questions of T7.7 on 2026-10-04. They are instructions for every task here.

1. **The session runs headless first.** A Node process holds core, regen, the kernel and the solver, with no browser: fastest to ship and to test. A session attached to a live browser tab, where the user watches the agent work, is a later phase (see "Later phases").
2. **The interface is an MCP server.** Claude Code and Grok both speak MCP, so one server serves both. No separate command-line interface in this milestone.
3. **Review happens in manufakture's History only.** Agent work lands on a branch plus a review bundle; approving merges the branch into Main with M7's merge by replay (T7.1f). (As planned it also unlocked fabrication exports; at ADR 0016's acceptance the maintainer dropped any export gate, so exports work from any branch.) No integration with any external task board.
4. **Its own milestone, M8.** Planned now, built after M7's sync and branches (T7.1e, T7.1f) land.

## Where M7 leaves us

From the code and the M7 plan:

- **Commands are the unit of change.** `applyCommand` (`packages/core/src/commands.ts`) validates, applies without mutation, checks the whole document and returns the inverse; `batch` is all or nothing. Clients choose ids (`previewIds`); T7.1a adds `createdIds` and `remapIds`. Every write the agent can make is already a command: features, parts, assemblies, mates, configurations, drawings, CAM setups, domain data (`setDomainData`) and, after T7.2a, scripts.
- **Everything geometric already runs in Node.** `packages/regen/src/integration.test.ts` drives a `RegenEngine` on the real kernel (`createNodeService` from `@manufakture/kernel/node`, reading the pinned libcascade `.wasm` from disk) and the real planegcs solver from a core `DocumentStore`. ADR 0007 made every request and reply plain data for exactly this. `packages/io` writes STEP, STL, 3MF, DXF, SVG and PDF; `packages/cam` has the posts; `packages/drawing` projects views with hidden lines (T4.4a).
- **Some of what an agent needs still lives in the app.** The library with versions and branches (`apps/web/src/persistence/library.ts`), the cut list (`apps/web/src/wood/cutlist/`), the takeoff PDF (`apps/web/src/construction/takeoff/pdf.ts`) and drawing exports (`apps/web/src/drawing/exports.ts`). The library already sits on a `StorageBackend` interface with OPFS, IndexedDB and memory implementations; it needs a Node file system backend and a home outside `apps/web`.
- **Branches exist, merge arrives in M7.** Branches are made from versions (T2.5c, `docs/user/history.md`); T7.1e puts versions and branches on the sync server; T7.1f merges a branch by replaying its commands with remap, reporting dropped commands by label, as one undoable step.
- **The app's automation hook is for tests.** `window.__manufakture` (`apps/web/src/testHooks.ts`) exposes the library, autosave, measure and assembly state to Playwright in development and e2e builds only. It is not an API and M8 does not build on it.
- **Node has no WebGL.** The viewport renders with three.js in the browser; a headless session needs its own way to make images (T8.0b).

## Decisions that cut across tasks

1. **Commands only.** The agent changes a document with core commands and nothing else: no tool evaluates code, edits files or touches storage. The one way to run logic is an M7 scripted feature (`setScript` plus a `scripted` feature), which runs in the QuickJS sandbox of ADR 0010 like any user's script and appears in full in the review bundle.
2. **Agents never write Main.** A session always works on an agent branch, created from a version the session makes of Main's head. Main changes only by a person approving a bundle (merge) or by a person editing. This is enforced in the session, in the MCP server and, for synced documents, on the sync server with scoped tokens (T8.4b).
3. **Branch provenance is library data, not document format.** An agent branch carries `origin: 'agent'`, the session id, the client's self-reported name and a review state (`open`, `submitted`, `changes-requested`, `approved`, `rejected`). No format bump.
4. **The review bundle is computed where the work was done and checked where it is approved.** The session builds the bundle in Node; the app regenerates the branch head at review time and compares its measurements with the bundle's. A mismatch is shown, never hidden.
5. **Fabrication exports are files for making things, and they are not gated** (amended at ADR 0016's acceptance; as planned, all were refused for an unreviewed agent branch). G-code, cut lists and layouts, takeoffs, construction drawing sets, drawing PDF and DXF, laser files, print files (STL, 3MF), STEP, and also IFC, `.mfkview` and `.mfk`: all are allowed from any branch, including an unreviewed agent branch, in the app and through MCP. There is no `exportAllowed`. Quantities read as data are marked `reviewed: false` on an agent branch.
6. **Errors are data** (ADR 0007 decision 5). A refused command returns its `CoreError`; a failing feature returns its `FeatureError`. Tools never throw for expected failures.

## Order and parallel lanes

Implementation starts once T7.1e and T7.1f have landed (decision 4). The two spikes and the ADR touch no shipped code and may run earlier when an agent is free. Human-only tasks are marked (H).

| Wave | Tasks                      |
| ---- | -------------------------- |
| 0    | T8.0a, T8.0b, T8.1a, T8.1b |
| 1    | T8.0c, T8.2a               |
| 2    | T8.0d (H), T8.1c           |
| 3    | T8.3a (T8.3c dropped)      |
| 4    | T8.3b, T8.4a               |
| 5    | T8.4b, T8.5a               |
| 6    | T8.6a, T8.6b, T8.6c        |
| 7    | T8.7a (part H)             |
| 8    | T8.8                       |

| Task  | Title                                                     | Depends on                 | Human | Security review |
| ----- | --------------------------------------------------------- | -------------------------- | ----- | --------------- |
| T8.0a | Spike: a headless session in Node                         | M6                         |       |                 |
| T8.0b | Spike: rendering views without a browser                  | M6                         |       |                 |
| T8.0c | ADR 0016: agent sessions, MCP surface, review before Main | T8.0a, T8.0b               |       |                 |
| T8.0d | Accept or amend ADR 0016                                  | T8.0c                      | yes   |                 |
| T8.1a | `packages/library`: storage, versions, branches, merge    | T7.1f                      |       |                 |
| T8.1b | Fabrication and quantity builders out of the app          | M6                         |       |                 |
| T8.1c | `packages/session`: headless document sessions            | T8.0a, T8.1a; T8.0c soft   |       | yes             |
| T8.2a | `packages/render`: views as PNG without a browser         | T8.0b                      |       |                 |
| T8.3a | Review bundle                                             | T8.1c, T8.1b, T8.2a        |       |                 |
| T8.3b | App: agent branches and the Review view in History        | T8.3a, T7.1e, T7.1f        |       | yes             |
| T8.3c | Export gate (dropped at ADR acceptance)                   | T8.1a, T8.1b               |       |                 |
| T8.4a | `apps/mcp`: the MCP server                                | T8.1c, T8.2a, T8.3a, T8.0d |       | yes             |
| T8.4b | Sessions over sync: agent branches and scoped tokens      | T8.4a, T7.1e               |       | yes             |
| T8.5a | Authoring guide for agents, user docs                     | T8.4a                      |       |                 |
| T8.6a | Scenario: drawer slides                                   | T8.3b, T8.4b, T8.5a        |       |                 |
| T8.6b | Scenario: heat-set inserts in a printed enclosure         | T8.3b, T8.4b, T8.5a        |       |                 |
| T8.6c | Scenario: remodelling an existing frame                   | T8.3b, T8.4b, T8.5a        |       |                 |
| T8.7a | Threat model, review notes and sign-off                   | T8.3b, T8.4b               | part  | is the review   |
| T8.8  | M8 acceptance: end-to-end suite and docs                  | every task above           |       |                 |

The critical path is T8.0a, T8.1c, T8.3a, T8.4a (which also waits for T8.2a, since it offers `render`), T8.4b, then the scenarios, the review and the acceptance. T8.1a and T8.1b are refactors with no new behaviour and can start the day T7.1f lands. Shared files with merge-level overlap: `apps/web/src/App.tsx`, `apps/web/src/history/`, `apps/server`.

## The headless session model

A **session** is one agent working on one branch of one document, in one Node process.

- **Open.** `openSession({ document, resume? })`: the document comes from a library directory on disk (tests, CI, offline use) or from a sync server (T8.4b, the normal case, since that is how the reviewer sees the branch). The session takes Main's head, records it as a version ("Agent session `<id>` start"), creates an agent branch from it (decision 2), loads it into a core `DocumentStore` and runs a full regen. `resume` reopens an existing agent branch in state `open` or `changes-requested`.
- **Work.** Each write is one batch: one `batch` command, one revision on the branch, one label the agent supplies. The session applies it with core, regenerates (cached by input hash, ADR 0004 decision 8), saves through the library, and answers with the ids created, the features whose status changed, errors and a short measurement summary. `undo` applies the last batch's inverse as a new revision. `updateFromMain` replays the branch onto Main's current head with T7.1f's merge and reports dropped commands. It does so on a **new agent branch** made from that head (ADR 0016 decision 1): the branch id changes, the new branch keeps the old one's name and provenance, including the reviewer's comment (the agent is still working on the requested changes), and starts `open` with no bundle, and the old branch is deleted once the new one holds every batch (on any failure the new one goes instead and the old one stays as it was).
- **Submit.** `submit` calls a bundle builder for the branch head against its base, stores the result with the branch and sets the state to `submitted`. T8.1c defines `submit` with the builder as an injected hook (a stub in its tests); T8.3a supplies the real builder; further writes return the branch to `open` and make the bundle stale.
- **Close.** Releases the kernel, the solver and the branch lock. A session idle past a timeout closes itself; its branch and bundle stay.
- **One writer per branch.** A file lock in the Node backend, the server branch in sync mode. Two sessions on one document work on two branches.
- **Determinism.** Node and the browser load the same libcascade single-threaded build and the same planegcs `.wasm`; regen is deterministic for the same inputs (ADR 0004 decision 8), scripts are deterministic by ADR 0010 decision 5. T8.0a measures it rather than assuming it: the same fixtures regenerated in Node and in Chromium must give identical mesh hashes, name tables and measurements. Anything that differs is listed in ADR 0016, and the app's check at review time (decision 4) catches the rest.
- **Limits** (starting values, tuned by T8.0a): commands per batch (500), batches per session (2,000), regen time per batch (60 s, then the batch is refused and rolled back), kernel memory (the existing recycle threshold, 512 MiB since the end-of-M1 checkpoint), images per call (8) and size (2048 px on the long side), document size (the `.mfk` limits), one open session per branch, sessions per process (4).

## The MCP tool list

The server (T8.4a) speaks MCP over stdio. Tools take and return JSON; images come back as MCP image content (PNG). Lengths are millimetres and angles degrees on the wire, except where a field takes an expression string with units, as in the app (ADR 0005).

| Tool                | Kind    | What it does                                                                                                                                                                         |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_documents`    | read    | Documents the server can open, with names, branches and their review states                                                                                                          |
| `open_session`      | session | Open a document on a new agent branch, or resume one; returns session id, base version, outline                                                                                      |
| `close_session`     | session | Close the session; the branch stays                                                                                                                                                  |
| `get_tree`          | read    | Outline: parts, features with status, bodies, assemblies, mates, variables, configurations, drawings, CAM setups, domain data summaries                                              |
| `get_object`        | read    | Full JSON of a feature, part, instance, mate, setup or domain entry                                                                                                                  |
| `get_schema`        | read    | JSON Schema of a command type or feature kind, generated from core's zod schemas (`z.toJSONSchema`), with their doc comments                                                         |
| `find_geometry`     | read    | Faces, edges and vertices by name or by query (planar with normal, cylinder of radius, nearest to a point, born by a feature), with names and hints (area, centroid, normal, radius) |
| `measure`           | read    | Distance, angle, area, volume, mass, bounding box, clearance between bodies, interference of an assembly at given poses                                                              |
| `render`            | read    | PNG of preset or given views, with optional highlighted names, section plane, and a base-versus-head comparison                                                                      |
| `get_quantities`    | read    | Cut list, takeoff and hardware counts as data, marked `reviewed: false` on an agent branch                                                                                           |
| `get_errors`        | read    | Regen errors and warnings of the head                                                                                                                                                |
| `get_history`       | read    | The branch's batches with labels and revisions                                                                                                                                       |
| `apply`             | write   | One batch of commands with a label; symbolic ids (`extrude#$boss`) resolved to fresh ids; `dryRun` applies and regenerates without saving                                            |
| `undo`              | write   | Undo the branch's last batch                                                                                                                                                         |
| `update_from_main`  | write   | Replay the branch onto Main's head on a new agent branch (the branch id changes); reports the new id and dropped commands                                                            |
| `submit_for_review` | write   | Build and attach the review bundle, with an optional note to the reviewer                                                                                                            |
| `get_review`        | read    | Review state and the reviewer's comment (stored in the branch provenance) when changes were requested                                                                                |
| `export`            | export  | A file export from the session's branch into the configured output directory; not gated, allowed on any branch including an unreviewed agent branch (decision 5)                     |

There is no approve tool, no tool that writes Main, no file path outside the output directory, and no tool that runs code. The authoring guide (T8.5a) and the schema index are also offered as MCP resources.

Symbolic ids exist because a model cannot reliably compute the next free id per scope. In `apply`, any id may have its number replaced by `$name` while its counter stays written (`extrude#$boss`, `sketch#$s`, `e$p1`, and inside a face name `extrude#$boss:side:e$l1`), so every symbol has exactly one counter (ADR 0016 decision 8, as T8.1c built it); the session allocates real ids per scope and counter in order, as `previewIds` would, substitutes them through the batch (T7.1a's `remapIds`, names included) and returns the table.

## The review bundle and approval

A bundle (T8.3a) is keyed by the branch's base version and head revision. It holds:

- **Command diff**: every batch with its label and commands, and a readable summary per command ("Added Fillet 3 (2 mm) on 4 edges of Extrude 1"); a feature-level diff (added, edited with changed fields, deleted, reordered, suppressed) per part and assembly; domain data diffs through each domain package's summariser; scripts added or changed, in full.
- **Renders**: the same fixed views (isometric plus the three principal views, plus any the agent asked for at submit) of base and head, side by side, at the same camera.
- **Regen errors**: errors and warnings at base and at head, with new ones first.
- **Measurements**: per body volume, mass and bounding box at base and head; interference of each assembly at its stored poses; quantity deltas (cut list, takeoff, hardware).
- **Merge preview**: T7.1f's preview against Main's current head, listing what would not apply.

Approval, in the app (T8.3b): History marks agent branches; **Review** opens the bundle; **Approve** is offered only when the bundle matches the branch head, the app's own regen of the head matches the bundle's measurements, and the merge preview drops nothing. Approve runs `mergeBranch` into Main with a label naming the session, sets the branch state to `approved`, and records on Main a version with a review reference (the branch, session, client name, bundle revision and merge label), so a Main version can say which review it came from (ADR 0016 decision 11). **Request changes** stores a comment in the branch's provenance, which the agent reads with `get_review` (ADR 0016 decision 9). **Reject** closes the branch. Exports do not check the source: they work from any branch (decision 5).

## Tasks

Every task follows the repository's rules: tests with the code, `make lint`, `make typecheck` and `make test` green, the e2e specs it names passing, the package README updated where its API changes, user docs in `docs/user/` for anything a user sees, and a license check of every new runtime dependency from its installed `package.json` and license file with a row in ADR 0006 (decisions 5 and 6).

### T8.0a: Spike: a headless session in Node

**Goal.** Prove the session model on real documents before building it.

**Scope.** In `spikes/T8.0a-headless/`: a library on a throwaway Node file system backend, a `DocumentStore`, `RegenEngine` on `createNodeService` and the solver, text features and fonts; open the M1 bracket, an M4 cabinet and the M6 shed, apply batches, regenerate, measure, save, reopen. Regenerate the same fixtures in Chromium through Playwright and compare mesh hashes, name tables and measurements.

**Acceptance.** Write-up `docs/spikes/T8.0a-headless.md`: cold start, first full regen and incremental regen per fixture, resident memory, kernel recycles over 1,000 batches, Node versus Chromium differences (none, or each listed with its cause), and starting values for the session limits.

**Dependencies.** M6. **Footprint.** `spikes/T8.0a-headless/`, `docs/spikes/T8.0a-headless.md`. **Risks.** Text or a domain translator may reach for a browser API (`OffscreenCanvas`, `fetch` of an asset URL); the spike lists each and how to inject it.

### T8.0b: Spike: rendering views without a browser

**Goal.** Choose how a headless session makes images an agent and a reviewer can judge.

**Scope.** In `spikes/T8.0b-render/`, compare on the three fixtures: a TypeScript software rasteriser of regen meshes (flat shading, depth buffer, edge polylines, PNG through the `fflate` deflate already in the tree); hidden-line SVG from `packages/drawing` rasterised to PNG; and, only as a reference, headless Chromium with the viewer entry (T7.3b). Measure time, image size, legibility of small features at 1024 px, and determinism (byte-identical PNG on rerun).

**Acceptance.** Write-up `docs/spikes/T8.0b-render.md` with the numbers, sample images and a recommendation. **Dependencies.** M6. **Footprint.** `spikes/T8.0b-render/`, `docs/spikes/T8.0b-render.md`. **Risks.** Thousands of framing members (M6) at one draw per triangle may be slow in plain TypeScript; the spike measures the shed.

### T8.0c: ADR 0016: agent sessions, MCP surface, review before Main

**Goal.** Record the decisions above with the spikes' evidence.

**Scope.** `docs/adr/0016-agent-sessions.md`, proposed: the session model and limits, determinism findings, the rendering choice, the tool list and its versioning (tools are a public contract like commands, M7 cross-cutting decision 3), symbolic ids, branch provenance, the bundle contents, the export gate and its list of fabrication formats (dropped at acceptance), scoped agent tokens. Index updated.

**Acceptance.** The ADR answers every question above or names its owner task. **Dependencies.** T8.0a, T8.0b. **Footprint.** `docs/adr/0016-agent-sessions.md`, `docs/adr/README.md`.

### T8.0d: Accept or amend ADR 0016 (human-only)

**Goal.** The maintainer accepts the ADR or amends it. **Acceptance.** Status set, index updated. **Dependencies.** T8.0c. **Footprint.** `docs/adr/0016-agent-sessions.md`.

**Outcome (2026-10-08).** Accepted with amendments: no export gate (the proposed decision 12 dropped, T8.3c's gating removed, exports allowed from any branch); agents still never write Main, and review in History followed by Approve and merge is how agent work gets into Main. The maintainer left the implementation points to the pipeline, recorded in the ADR as decisions: symbolic ids are counter-prefixed (decision 8); `update_from_main` makes a new agent branch (decision 1); CI keeps a golden of the MCP tool list (decision 7); the reviewer's comment is stored in the branch provenance (decisions 9 and 11). The point about Duplicate on an agent branch giving an ungated Main is moot with no gate.

### T8.1a: `packages/library`: storage, versions, branches, merge

**Goal.** The library usable outside the app, unchanged in behaviour.

**Scope.** Move `library.ts`, `backend.ts`, the memory backend, blobs, limits and T7.1f's `mergeBranch` from `apps/web/src/persistence/` into a new `packages/library`; OPFS and IndexedDB backends stay in the app. Add a Node file system backend (`node:fs/promises`, paths confined to its root by `segments`) and a lock per branch. Branch records gain the optional provenance of cross-cutting decision 3, and branch creation from a revision through an automatic version.

**Acceptance.** Every existing library and branch test passes from the package against memory and Node backends; app e2e unchanged; provenance round-trips and old branch lists load. **Dependencies.** T7.1f. **Footprint.** `packages/library/` (new), `apps/web/src/persistence/`, `apps/web/src/history/`. `mfk.ts` (`.mfk` packing) moves into `packages/library` with its tests, and its one app import (`formatBytes` from `apps/web/src/io/files`) moves to `packages/io`; `imports.ts` stays in the app, since it uses the app's exchange and mesh code, and T8.1c gives the session its own restore of reference imports. **Risks.** A wide move while other work edits persistence; land it in one change with no behaviour edits.

### T8.1b: Fabrication and quantity builders out of the app

**Goal.** Everything an export or a quantity needs, callable from Node.

**Scope.** Move the cut list model and PDF (`apps/web/src/wood/cutlist/`), the takeoff display and PDF (`apps/web/src/construction/takeoff/`) and drawing set exports (`apps/web/src/drawing/exports.ts`) into the domain packages or `packages/io`, leaving React components in the app. One entry point per fabrication format, as listed in cross-cutting decision 5, each taking a regen result.

**Acceptance.** Byte-identical outputs before and after for the existing goldens; a Node test exports each format from the shed and cabinet fixtures. **Dependencies.** M6. **Footprint.** `packages/{io,domain-wood,domain-construction,takeoff,drawing}`, `apps/web/src/{wood,construction,drawing,cam}/`.

### T8.1c: `packages/session`: headless document sessions

**Goal.** The session model above as a package with no transport.

**Scope.** `Session` with open, resume, apply (batch, label, symbolic ids, dry run), undo, updateFromMain, submit (taking a `BundleBuilder` hook: `(base, head) => Promise<Bundle>`, stored opaquely with the branch; tests pass a stub, T8.3a provides the real one), close; restoring reference import bodies (STEP and STL) on the Node kernel, which `apps/web/src/persistence/imports.ts` does for the app; the queries behind the read tools (`tree`, `object`, `schema`, `findGeometry`, `measure`, `quantities`, `errors`, `history`); `findGeometry` over the regen name table with per-face geometric hints from the kernel; the limits; a branch lock; refusal of any write targeting Main.

**Acceptance.** Node tests on the three fixtures: a batch with symbolic ids lands with real ids and returns the table; a batch that fails core or exceeds the regen budget leaves the branch unchanged; undo and resume; a write to Main is refused; `updateFromMain` after Main moved reports a dropped command; limits each end with a typed error. **Dependencies.** T8.0a, T8.1a; T8.0c soft. **Footprint.** `packages/session/` (new). **Security review:** yes (limits as denial of service; no path from input to storage paths).

### T8.2a: `packages/render`: views as PNG without a browser

**Goal.** The renderer T8.0b chose, as a package. **Scope.** Preset and given cameras, highlighted names, a section plane, body colours from the document, a fixed lighting model, PNG out; deterministic. **Acceptance.** Golden PNGs for the fixtures, byte-identical on rerun; a highlight test; the shed within the time T8.0b measured. **Dependencies.** T8.0b. **Footprint.** `packages/render/` (new).

### T8.3a: Review bundle

**Goal.** The bundle of "The review bundle and approval" as data plus images.

**Scope.** `packages/review`: build from a base and a head (documents and regen results); readable command summaries per command type, with a test that fails when a command type has none; feature diffs; a summariser hook per domain package for `setDomainData`; renders through T8.2a; measurement and quantity deltas; merge preview. Stored in the branch directory (`review-<rev>.json` plus PNGs as blobs) through T8.1a.

**Acceptance.** Bundles for scripted edits of the three fixtures match goldens; a stale bundle is detected; a bundle with a scripted feature shows the script source. **Dependencies.** T8.1c, T8.1b, T8.2a. **Footprint.** `packages/review/` (new), domain package summarisers. It implements the `BundleBuilder` hook T8.1c's `submit` takes.

### T8.3b: App: agent branches and the Review view in History

**Goal.** A person reviews and approves agent work where they already look at history.

**Scope.** History and the branch switcher mark agent branches and their states; **Review** shows the bundle (diff, side-by-side renders, errors, measurements, merge preview); the app regenerates the head and compares measurements; **Approve** (merge, behind the checks above), **Request changes** with a comment stored in the branch provenance, **Reject**. Scripts in an agent branch follow T7.2d's opt-in on the reviewer's device: the reviewer is asked before they run.

**Acceptance.** e2e `apps/web/e2e/agent-review.spec.ts`: a branch and bundle written by `packages/session` into a synced document appear in History; approve merges and Main shows the change as one undoable step; request changes stores the comment; a branch changed after its bundle cannot be approved; a bundle whose measurements disagree with the app's regen shows the mismatch. **Dependencies.** T8.3a, T7.1e, T7.1f. **Footprint.** `apps/web/src/history/`, `apps/web/src/review/` (new), `docs/user/history.md`. **Security review:** yes (bundle content is untrusted text and images: rendered as text, sizes bounded).

### T8.3c: Export gate (dropped)

**Dropped at ADR acceptance: no export gate; the review reference on Main versions it added stays.** As planned, one `exportAllowed(branch)` in `packages/library` would have refused fabrication exports from an unreviewed agent branch in every entry point of T8.1b, the app's export dialogs and the MCP `export` tool. The maintainer decided exports are allowed from any branch, so `exportAllowed` and its call sites are removed and not built again. What stays is the merge label and bundle reference recorded on Main (`ReviewReference` on a Main version, `reviewOf` in `packages/library`), so a Main version can say which review it came from (ADR 0016 decision 11).

### T8.4a: `apps/mcp`: the MCP server

**Goal.** The tool list above over stdio.

**Scope.** New `apps/mcp` on the TypeScript MCP SDK (`@modelcontextprotocol/sdk`; license read from the installed package at adoption), one tool per row of the table, input schemas generated from zod, image content for `render`, errors as data, the authoring guide and schema index as resources; configuration from environment (library root, output directory, sync server URL and token); `pnpm --filter @manufakture/mcp start`; setup snippets for Claude Code and Grok in the user docs.

**Acceptance.** Node tests with the SDK's client over an in-process transport: every tool on the bracket fixture; refusals as data; no tool reaches a path outside its roots; `export` writes a file from an agent branch as from Main (no gate); a golden of every tool's name and input and output schemas, which fails CI on any change that does not only add (ADR 0016 decision 7); a manual run in Claude Code and in Grok noted in the task report. **Dependencies.** T8.1c, T8.2a (`render`), T8.3a (`submit_for_review` passes its builder to the session), T8.0d. **Footprint.** `apps/mcp/` (new), root workspace config. **Security review:** yes (input validation, path confinement, output size).

### T8.4b: Sessions over sync: agent branches and scoped tokens

**Goal.** The agent's branch reaches the reviewer's browser through the user's sync server, and the agent's credential cannot write Main.

**Scope.** `packages/session` opens a document from the server with `packages/sync`, creates the start version and branch there (T7.1e), submits batches as sync entries on the branch, and uploads the bundle with the branch. Server: **agent tokens**, a second token kind that may create branches with agent provenance and write only those, read anything in its documents, and never write Main or approve; the only review states it may set are `submitted` (from `open`) and `open` (from `submitted` or `changes-requested`, as a write does), plus restoring the state a failed write left (ADR 0016 decision 9).

**Acceptance.** Integration test: session and browser on one server, the branch and bundle appear in the app; an agent token's write to Main and its attempt to set `approved` are refused with 403; concurrent edits on Main during the session are picked up by `update_from_main`. **Dependencies.** T8.4a, T7.1e. **Footprint.** `packages/session`, `apps/server`, `docs/user/agents.md`. **Security review:** yes.

### T8.5a: Authoring guide for agents, user docs

**Goal.** Agents that drive manufakture well on the first try, and users who know how to set it up and review.

**Scope.** `docs/agents/authoring.md`, also served as an MCP resource: the document model in one page; units and expressions; symbolic ids; finding geometry instead of clicking; references by name and what makes them fragile; batching (one intent per batch, readable labels, measure and render after each); domain recipes (boards and joints, holes and threads, walls and openings, CAM setups); scripted features and when not to use them; how to submit and answer a review. `docs/user/agents.md`: connecting Claude Code or Grok, agent tokens, reviewing, and that exports are not gated (a file exported from an agent's branch carries unreviewed work).

**Acceptance.** Every example in the guide is run by a test against the MCP server. **Dependencies.** T8.4a. **Footprint.** `docs/agents/authoring.md`, `docs/user/agents.md`, a test in `apps/mcp`.

### T8.6a to T8.6c: Acceptance scenarios that expose gaps

Each scenario is run twice: as a scripted MCP client test (a fixed tool-call sequence, in CI, deterministic) and live by an agent in Claude Code and in Grok from a one-paragraph request, with the transcript summarised in `docs/m8-acceptance/<scenario>.md`. Each task records which gaps were confirmed, which were not, and files a follow-up per confirmed gap. The gaps below are the plan's hypotheses.

**T8.6a: Drawer slides.** "Add a drawer to the bottom opening of this cabinet on 18" side-mount ball-bearing slides, 1/2" clearance each side, and check it opens fully." Expected gaps: no purchased-part catalog (a slide as a component with a length series, clearance and mounting-hole pattern, counted in the bill of materials beside dowels and pocket screws); interference is checked at one pose, not over a slider mate's travel; variables cannot take a measured value (the drawer width from the opening), so the agent hardcodes numbers a later edit breaks; the cut list does not separate hardware lines.

**T8.6b: Heat-set inserts in a printed enclosure.** "Put M3 heat-set inserts in the four lid bosses of this enclosure and make the lid screw holes clear." Expected gaps: no insert table (hole diameter and depth per insert size) next to the thread tables, only cosmetic threads; no hole type for inserts; no wall thickness check around a hole; section renders are needed for review and must show the hole depth; bosses chosen by geometry query need hints `find_geometry` may not have (boss axes, coaxial holes).

**T8.6c: Remodelling an existing frame.** "On the shed, move the door 2' right, add a 3' window on the back wall, and show what new lumber I need." Expected gaps: members have no phase (existing, new, demolish), so takeoff counts the whole frame instead of new material and drawings cannot dash out removals; an as-built frame off the layout (studs not on centre) cannot be modelled, since members can only be deleted or restocked, not added; changing layout renumbers studs and orphans per-member changes; `setDomainData` replaces a whole namespace, so the command diff is unreadable without the domain summariser and two branches touching one wall conflict as a whole.

**Dependencies.** T8.3b, T8.4b, T8.5a. **Footprint.** `apps/mcp/test/scenarios/`, fixtures, `docs/m8-acceptance/`. **Risks.** Live runs vary between models and days; the CI test is the gate, the live run is evidence.

### T8.7a: Threat model, review notes and sign-off (part human)

**Goal.** A written review of what M8 exposes, signed off by a person before agent tokens are documented for use beyond localhost.

**Scope.** `docs/security/m8-threat-model.md`: assets (documents, Main, tokens, exports), actors (a misbehaving or prompt-injected agent, a hostile document whose names and notes carry instructions to the agent, a malicious server); mitigations with links to tests (scoped tokens, no code tool, limits, path confinement, review before Main, bundle rendering as text); open risks, including that exports are not gated, so a fabrication file made from an unreviewed agent branch (by a person or by the agent through `export`) carries whatever the agent did. The maintainer's sign-off is recorded in the same file.

**Acceptance.** Every task marked for review is covered; sign-off recorded. **Dependencies.** T8.3b, T8.4b. **Footprint.** `docs/security/m8-threat-model.md`.

### T8.8: M8 acceptance: end-to-end suite and docs

**Goal.** Show the milestone end to end.

**Scope.** A suite that starts a sync server, opens the M1 bracket through the MCP server, applies three batches (one refused and corrected), submits, reviews and approves in a browser context, then exports G-code from Main, whose version names the review it came from. No export is refused on the branch: there is no export gate. `docs/m8-acceptance.md` with the walkthrough, the three scenarios' gap tables, budgets (session cold start, batch round trip, bundle build time) and screenshots.

**Dependencies.** Every task above. **Footprint.** `apps/web/e2e/m8-*.spec.ts`, `docs/m8-acceptance.md`, `docs/m8-acceptance/`.

## Open questions

Three questions for the maintainer that the decisions above do not settle. Until they are answered, the plan assumes the default stated with each.

1. **Review needs a sync server.** The browser app cannot read a branch a Node process wrote to disk, so the reviewer sees agent branches only through the sync server (T8.4b); a self-hosted server on localhost is enough. Assumed: acceptable, and no serverless review path in M8 (a local library is for tests and CI only).
2. **Spikes before M7 lands.** Assumed: T8.0a, T8.0b and T8.0c may run before T7.1e and T7.1f land, since they touch no shipped code; every other task waits (decision 4).
3. **What the export gate covers.** Assumed: STEP, STL and 3MF count as fabrication exports and are refused on unreviewed agent branches, along with G-code, cut lists, takeoffs, drawing sets and laser files; renders and quantities read as data are allowed on any branch. Answered at ADR 0016's acceptance: there is no export gate, and every export is allowed from any branch.

Questions 1 and 2 are answered in ADR 0016 (decision 10, and moot); the implementation points raised while writing it were left to the pipeline and are recorded there as decisions (symbolic ids, update from Main, the tool-list golden, the reviewer's comment).

## Later phases (not in M8)

- **A live browser tab.** The MCP server attaches to an open app tab instead of a Node session, so the user watches changes arrive; the tab's regen and viewport do the work. Needs a local bridge with its own security review.
- **A command-line interface** over `packages/session`, if MCP leaves a need unmet.
- Fixes for the gaps T8.6a to T8.6c confirm, planned as their own tasks.

## Risks across M8

- **Review is a workflow guarantee, not a sandbox.** It stops unreviewed agent work from reaching Main through manufakture; it does not stop a fabrication file being exported from an agent branch, since exports are not gated. An agent that also has a shell and the user's files can do anything the user can; scoped tokens (T8.4b) protect the server, not the machine.
- **Prompt injection through documents.** Names, notes and domain data are text an agent reads; a shared document can carry instructions. Tools return them as data, the guide says so, and review before Main catches what slips through into Main; a file exported from the agent's branch is not covered.
- **Review fatigue.** A bundle nobody reads approves anything. Bundles lead with what changed geometrically (renders, measurement deltas, new errors) and keep command detail one click away.
- **Tools become a contract.** Agents and guides depend on tool names and shapes; changes follow the same rule as commands: add, never silently change.
- **Node and browser regen may differ** in rare cases (fonts, a domain translator using a browser API). T8.0a looks; the app's comparison at review time is the backstop.
- **Gaps may dominate.** The scenarios are expected to show that agents need catalogs, measurement-driven variables and finer domain commands more than they need more tools; M8 accepts with those gaps filed, not fixed.
