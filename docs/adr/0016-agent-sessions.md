# 0016: Agent sessions: headless sessions on agent branches, an MCP surface, review in History before fabrication

- Status: proposed
- Date: 2026-10-08

## Context

M8 lets a person describe a change in conversation and have an AI agent (Claude Code, Grok, any MCP client) make it in manufakture, while nothing the agent does counts until a person has reviewed it ([M8 plan](../plans/agent-surface.md)). The maintainer's framing: the person tasks the agent and stays at the wheel, chatting with it while it works; the live runs of the acceptance scenarios (T8.6a to T8.6c) are done by the pipeline agent, not by hand. The plan's four decisions (headless first, an MCP server, review in History only, a milestone of its own) and six cross-cutting decisions are instructions; this ADR records them with the spikes' evidence and answers what the plan left to it (task T8.0c).

The inputs:

- **The [M8 plan](../plans/agent-surface.md)**: decisions 1 to 4, the cross-cutting decisions 1 to 6 (commands only; agents never write Main; provenance as library data; bundle computed where the work was done and checked where it is approved; fabrication exports gated; errors as data), the headless session model, the MCP tool list, the review bundle and the gate, three open questions with assumed defaults, and the risks.
- **The [T8.0a spike](../spikes/T8.0a-headless.md)** (done 2026-10-08): a prototype session on the M1 bracket, the M4 bookshelf and the M6 shed. Cold start about 1 s; incremental regen per batch 36 to 298 ms (median); 1,000 batches with no failure; kernel recycles every 187 to 413 batches on heavy documents, each landing right after a regen; resident memory not bounded by the recycle unless V8 collects the old instance; Node 26.10 and Chromium 153 bit-identical on the bracket and the bookshelf, and on the shed different only in framing mesh bits and two cache keys, from JavaScript `Math`; two injections a Node host needs; recommended limits.
- **The [T8.0b spike](../spikes/T8.0b-render.md)** (done 2026-10-08): a TypeScript software rasteriser, hidden-line SVG and headless Chromium compared. The rasteriser alone shows framing members in 3D without a browser, adds no dependency, gave byte-identical PNGs in every run, and draws the shed's four views in about 0.42 s.
- **What has landed in this epic.** `packages/library` (T8.1a, [README](../../packages/library/README.md)) with `NodeBackend`, `NodeBranchLocks`, `BranchProvenance` and `branchFromRevision`; `packages/render` (T8.2a, [README](../../packages/render/README.md)); and one entry point per fabrication format runnable in Node (T8.1b, [io README, "Fabrication exports"](../../packages/io/README.md#fabrication-exports)).
- **ADRs it builds on**: [0004](0004-document-format.md) (decision 8, regen cached by input hash), [0007](0007-worker-protocol.md) (plain data; decision 5, errors as data), [0009](0009-sync-model.md) (the command log as the sync unit, branches and merge by replay), [0010](0010-scripting-sandbox.md) (scripts in QuickJS with limits), [0011](0011-fonts.md) (user fonts under a watchdog), and [product decision 0001](../decisions/0001-m7-hosting-accounts-and-sharing.md) (self-hosted, one user, one bearer token), and the [M7 plan](../plans/m7.md) cross-cutting decisions 2 (the server never computes geometry) and 3 (core is a wire protocol).

## Decision

### Sessions

1. **A session is one agent on one agent branch of one document, in one Node process.** The process is the MCP server (decision 6), started by the agent's client on the user's machine. It holds core, regen, the kernel and the solver; the sync server still runs no geometry (M7 plan decision 2) and only orders and stores what the session sends.

   - **Open** takes Main's head, makes a version of it named "Agent session `<id>` start" and an agent branch from that version (`branchFromRevision`, landed), takes the branch's lock, loads it into a core `DocumentStore` and runs a full regen. **Resume** reopens an agent branch in review state `open` or `changes-requested`, never one that is `submitted` (the session would race the reviewer), `approved` or `rejected`.
   - **Apply**: one batch per write, as one `batch` command, one regen, one saved revision with one log entry, one label from the agent. A batch that core refuses, or that runs over the regen limit, leaves the branch unchanged. `dryRun` applies and regenerates without saving. A write to a `submitted` branch returns it to `open` and marks its bundle stale.
   - **Undo** applies the last batch's inverse as a new revision, and reaches only the session branch's own batches. `DocumentStore` keeps 500 undo steps; past that, T8.1c reads the inverse from the library's log or refuses with a typed error.
   - **Update from Main** replays the branch onto Main's current head with T7.1f's merge and reports dropped commands by label.
   - **Close** releases the kernel, the solver and the lock; the branch and its bundle stay. An idle session closes itself; T8.1c sets the timeout.
   - **One writer per branch.** Locally, `NodeBranchLocks`: an `O_EXCL` lock file with a 30 s heartbeat, broken only when its process is gone (by pid and process start time on the same machine; after 2 minutes without a heartbeat for a record from another machine). Two sessions on one document get two branches. Over sync, the server holds the branch (T8.4b decides how one writer is enforced there).
   - **The recycle after a regen.** The kernel recycles at an idle point, which in a session is right after the regen; the measurement that follows then finds its shapes gone. The session regenerates once more before answering (T8.0a recommendation 3).

2. **What a Node host injects.** The session builds its regen engine directly, never through the browser's worker spawn modules (`text-spawn.ts`, `spawn.ts`, `regen/worker.ts`), and passes:

   - `fetchImpl` to the text outliner, serving the bundled font from `file:` URLs only (Node's `fetch` refuses them);
   - a domain registry of its own: stock, wood and construction, as the app's regen worker registers them (without it 29 of the bookshelf's 37 features are `unsupported`);
   - **user fonts** through `serveText` with the watchdog outliner (`createWatchdogOutliner`) in a worker thread, as the browser does under ADR 0011's amendment, never parsed in the session's thread;
   - **scripts** through `nodeScriptEngine` and `setScriptPolicy`, in a worker thread the host can terminate, with ADR 0010's limits and the browser's 10 s backstop. A session must run the agent's own scripted features to show their result; whether it runs scripts already in a document from someone else follows the same rule as the app (ADR 0010 amendment item 11), set in the session's configuration (T8.1c).

   Nothing else on the session path needs a browser API: Manifold, `crypto.subtle` and `navigator.locks` exist in Node 26, and no package reaches `OffscreenCanvas`.

3. **Limits.** Each ends with a typed error, as data (T8.1c). Values from T8.0a's recommendations:

   - **Commands per batch: 500.** 500 commands apply and validate in 3.0 ms; a batch's cost is its regen.
   - **Batches per session: 2,000.** 1,000 ran with no failure and no slowdown.
   - **Regen time per batch: 30 s** (the plan said 60). The slowest batch seen took 2.6 s. Cancelling acts only between kernel operations, so one long OCCT operation overruns it; with a worker thread the hard bound is terminating the worker (T8.1c sets the margin). An overrun batch is rolled back.
   - **Kernel recycle: 512 MiB, and the recycled instance must actually be released.** Without forced collections the process grew to 2.1 GiB (bracket) and 3.7 GiB (bookshelf) over 1,000 batches; a `gc()` every 100 batches kept the bracket between 0.76 and 1.3 GiB, but one right after a recycle did not free it.
   - **Sessions per process: 4 only with each session's kernel in a worker thread of its own; 2 if they share the main thread.** A session reaches about 0.7 GiB before a recycle, and on one thread four sessions took turns (a 38 ms batch took 151 ms).
   - **One kernel service per session, never shared.** A recycle drops every shape of every engine on a service.
   - **Images: 8 per call, 2048 px on the long side** (`packages/render`'s `MAX_IMAGES_PER_CALL` and `MAX_IMAGE_SIDE`; about 200 MiB transient at 2048 x 2048).
   - **Document size: the `.mfk` limits.** Nothing seen argues otherwise.
   - **One session per branch**: the lock of decision 1.

   **The preferred design is a worker thread per session**, holding its kernel service, solver, text and script engines: it gives parallel regens, hard timeouts for fonts and scripts, and frees a kernel instance on terminate. Whether terminating the worker (or a `gc()` after each recycle, which needs `--expose-gc`) bounds memory is unverified; T8.1c verifies one of them before the 4-session limit applies, and keeps 2 until then.

4. **Determinism, and what the review compares.** Node and Chromium load the same libcascade build and the same planegcs `.wasm`, and the kernel and solver gave identical bits for identical inputs throughout T8.0a. JavaScript `Math` does not: V8 14.6 (Node 26.10) and V8 15.3 (Chromium 153) differ by 1 or 2 ulp in `sin`, `cos`, `tan`, `atan`, `asin`, `acos`, `atan2`, `exp`, `log` and `cbrt` for 4 to 19 % of inputs (`sqrt`, `hypot` and `pow` agree). The construction domain computes roof and gable geometry with them, so on the shed 12 of 36 member meshes differ in their bits (every corner within 2.2 × 10⁻¹² mm, 2 of them in vertex order) and 2 sheathing bodies have different cache keys; every measurement, name, feature result and status is identical.

   So **the review gate compares measurements, with a tolerance, and names (name tables, feature statuses, error codes), never cache keys or mesh hashes**, between the bundle made in Node and the app's own regen at review time. T8.3b sets the tolerance (T8.0a saw no measurement differ at all, so it can be tight) and shows any mismatch, never hides it. Node and the browser will drift whenever either updates V8; "identical" is promised only for the kernel's outputs given identical inputs. Renders are evidence for the person and are not compared by the gate.

### Rendering

5. **Images come from `packages/render`, the TypeScript software rasteriser** T8.0b chose and T8.2a landed: orthographic preset and given cameras, `fit` to named bodies, members, faces or edges, highlight, hide, members only, a section plane with a filled cut, body colours from the document, flat shading with lights fixed in view space, PNG through fflate, failures as data. Its pipeline uses only exactly rounded arithmetic, so PNGs are byte-identical on rerun and serve as goldens. It is the only approach that shows framing members in a 3D view without a browser; hidden-line SVG shows only kernel bodies there, and headless Chromium needs a browser and leaks edges through thin sheathing. Images carry no text; labels travel as data beside them. At house scale a 2x4 is under 2 px across, so review images of framing changes frame the named members (`fit`).

### The MCP surface

6. **One MCP server over stdio, `apps/mcp` (T8.4a), on the TypeScript MCP SDK.** Tools take and return JSON; `render` returns MCP image content. Lengths are millimetres and angles degrees on the wire, except fields that take an expression string with units (ADR 0005). Input schemas are generated from core's zod schemas. Expected failures are data (a `CoreError`, a `FeatureError`, a limit's typed error), never a thrown tool error.

   The tools, as the plan lists them:

   - **Session**: `open_session` (a new agent branch of a document, or resume one; returns the session id, base version and outline), `close_session` (the branch stays).
   - **Read**: `list_documents` (with branches and review states), `get_tree` (parts, features with status, bodies, assemblies, mates, variables, configurations, drawings, CAM setups, domain summaries), `get_object` (full JSON of one item), `get_schema` (JSON Schema of a command type or feature kind from core's zod schemas, with doc comments), `find_geometry` (faces, edges and vertices by name or query, with hints: area, centroid, normal, radius), `measure` (distance, angle, area, volume, mass, bounding box, clearance, interference at given poses), `render` (PNG views through `packages/render`, base against head on request), `get_quantities` (cut list, takeoff and hardware as data, marked `reviewed: false` on an agent branch), `get_errors`, `get_history` (the branch's batches with labels and revisions), `get_review` (the review state and the reviewer's comment).
   - **Write**: `apply` (one batch with a label, symbolic ids of decision 8, `dryRun`), `undo`, `update_from_main` (reports dropped commands), `submit_for_review` (builds and attaches the bundle of decision 11, with a note to the reviewer).
   - **Gated**: `export` (a fabrication file into the configured output directory, refused on an unreviewed agent branch, decision 12).

   There is no approve tool, no tool that writes Main or sets a review state other than through `submit_for_review`, no file path outside the configured roots, and no tool that evaluates code: the one way to run logic is a scripted feature added by command, which runs in ADR 0010's sandbox and appears in full in the bundle. The authoring guide (T8.5a) and the schema index are MCP resources.

7. **Tools are a public contract, like commands** (M7 plan cross-cutting decision 3). Agents, the authoring guide and people's prompts depend on tool names, input and output shapes and meanings. The rule is **add, never silently change**: a new tool, or a new optional input field or output field, is allowed; renaming, removing, tightening an input or changing what a field means is a new tool under a new name, with the old one kept and marked deprecated in its description. T8.4a keeps a golden of every tool's name and its input and output schemas, and a change that alters one fails CI unless it only adds. The server reports its surface version in the MCP server info, raised on every addition. Since tool inputs embed command schemas, a command change already follows core's rule.

8. **Symbolic ids.** A model cannot reliably compute the next free id per scope, so in `apply` any id field may hold `$name` (`"$boss"`). The session allocates real ids in order with `previewIds`, substitutes them through the whole batch with T7.1a's `remapIds` (face names included, through the naming parser, never string replacement) and returns the table. A symbol lives for one batch; later batches use the real ids from the table. A symbol used before it is created, defined twice, or a literal id below its counter is refused as data (T8.1c).

### Branches and review

9. **Branch provenance is library data, not document format** (landed in T8.1a). An agent branch's record carries `provenance: { origin: 'agent', sessionId, clientName, review }`, `review` one of `open`, `submitted`, `changes-requested`, `approved`, `rejected`. `clientName` is self-reported, so it is shown and never trusted: 1 to 200 characters, no control or format characters, no lone surrogates. Provenance is parsed strictly, and a record whose provenance does not check makes the whole list read as damaged, so damage never turns an agent's branch into a person's. A new agent branch is made only in state `open`. `setBranchReview` does not check who asks: its callers do, and no path from an agent may reach it for its own branch except to `submitted`.

   **Forward-compatibility caveat.** Because parsing is strict, a review state added later is unknown to older releases: a branch record holding it does not read, the whole branch list counts as damaged, and an older release falls back to the spare (an older branch list) or to none. A new review state therefore needs every release that may open the library to know it first, or a format change. The five states are meant to be final for M8.

   `adoptBranch` (sync) does not carry provenance yet; T8.4b adds it, so an agent branch keeps its provenance on every device.

10. **Review happens only through the sync server** (the plan's open question 1, default accepted). The browser cannot read a branch a Node process wrote to disk, so the reviewer sees agent branches through the sync server (T8.4b), a self-hosted one on localhost being enough. A local library directory is for tests and CI only; there is no serverless review path in M8.

11. **The review bundle** (T8.3a, `packages/review`) is computed in the session and checked in the app. It is keyed by the branch's base version and head revision, so a bundle whose head moved is stale and cannot be approved, and it is stored in the branch directory as `review-<rev>.json` with its PNGs as blobs. It holds:

    - **command diff**: every batch with its label and commands; a readable summary per command type (a test fails when a type has none); a feature-level diff per part and assembly (added, edited with changed fields, deleted, reordered, suppressed); domain data diffs through each domain package's summariser; scripts added or changed, in full;
    - **renders**: isometric and the three principal views of base and head, at the same camera, plus any the agent asks for at submit;
    - **regen errors and warnings** at base and head, new ones first;
    - **measurements**: per body volume, mass and bounding box at base and head; interference of each assembly at its stored poses; quantity deltas (cut list, takeoff, hardware);
    - **merge preview** against Main's current head, listing what would not apply.

    In the app (T8.3b) the bundle is untrusted: its text is rendered as text and its sizes are bounded. It leads with what changed geometrically (renders, measurement deltas, new errors) and keeps command detail one click away, against review fatigue. **Approve** is offered only when the bundle matches the branch head, the app's own regen of the head matches the bundle's measurements and names (decision 4), and the merge preview drops nothing; it merges into Main with T7.1f's merge, labelled with the session, as one undoable step, sets the state to `approved` and keeps the bundle with the merge revision. **Request changes** stores a comment the agent reads with `get_review`; **Reject** closes the branch. Scripts in an agent branch follow T7.2d's opt-in on the reviewer's device.

12. **The export gate** (T8.3c). One `exportAllowed(branch)` in `packages/library`, called by every fabrication entry point, by the app's export dialogs and by the MCP `export` tool. It refuses an agent branch in any state but `approved`, with "This is an agent's unreviewed branch. Review it in History first.", and allows Main and a person's branches. The merge records a label and a bundle reference on Main, so a later export can say which review it came from. The gated formats, each with its entry point:

    - G-code: `exportGcode` in `@manufakture/cam/export`;
    - laser and plasma files (DXF, SVG): `exportLaser` in `@manufakture/cam/export`;
    - cut lists and layouts (cut list CSV, bill of materials CSV, shop PDF): `exportCutList` in `@manufakture/domain-wood/files`;
    - takeoffs (CSV, PDF): `exportTakeoff` in `@manufakture/domain-construction/files`;
    - construction drawing sets, and drawing PDF, DXF and SVG: `drawingFile` in `@manufakture/io`;
    - print files, STL (one, or one per body) and 3MF, and STEP: `exportBodyFiles` in `@manufakture/io`;
    - a print setup's plate export, still the app's (`apps/web/src/print/exportPrint.ts`): gated at that call site.

    STEP, STL and 3MF are fabrication exports (the plan's open question 3, default accepted). Not gated, on any branch: renders, and quantities read as data (marked `reviewed: false`). IFC, published views (`.mfkview`) and `.mfk` files are not fabrication files (io README) and are not gated in the app; the MCP `export` tool offers only the gated formats above, so an agent cannot produce those either in M8. The maintainer may extend the gate to IFC in T8.0d.

13. **Agents never write Main, enforced three times**: in the session (a write targeting Main is refused, T8.1c), in the MCP server (no tool names Main as a target), and for synced documents on the sync server with **scoped agent tokens** (T8.4b). Product decision 0001 gives an instance one bearer token; M8 adds a second kind, issued and revoked by the owner, that may create branches with agent provenance and write only those, read the documents it is scoped to, and never write Main, approve, merge, write an `approved` or `rejected` branch, or set a review state other than `submitted`. Attempts are refused with 403 and tested. How tokens are scoped to documents and issued is T8.4b's; documenting them for use beyond localhost waits for T8.7a's sign-off.

14. **Prompt injection through document text.** Names, notes, labels, domain data, script source, version and branch names, and the `clientName` of other sessions are text from whoever wrote the document, and a shared document can carry instructions aimed at the agent. Tools return them only inside JSON data fields, never in tool descriptions, resource text or error wording composed by the server; lengths are bounded by the document's own limits; the authoring guide (T8.5a) tells agents that document text is data, not instruction. The backstop is the gate: whatever an injected agent does lands on its branch and reaches Main or a fabrication file only through a person's approval. The reverse direction (an agent writing text a reviewer reads) is covered by decision 11's untrusted rendering. T8.7a's threat model lists both.

## Alternatives considered

- **A session in a live browser tab**, where the user watches the agent work. Reuses the app's regen and viewport, but needs a local bridge into the page with its own security review. Deferred to a later phase (plan decision 1).
- **Sessions on the sync server.** Would put the kernel on the server, against M7 plan decision 2, and make every self-hosted instance a geometry host. Rejected; the session runs where the agent's client runs.
- **A command-line interface** instead of MCP. Claude Code and Grok both speak MCP, so one server serves both. Deferred; it can sit on `packages/session` later.
- **Several sessions sharing one kernel service.** Saves about 0.3 GiB per session, but a recycle drops every engine's shapes and cancellation is by generation across all of them (T8.0a). Rejected.
- **Comparing mesh hashes or cache keys at review time.** The strongest check, but V8 `Math` differs between Node and Chromium, so the shed would never approve. Rejected for measurements and names (decision 4).
- **Hidden-line SVG or headless Chromium for images.** The first shows no framing members in 3D; the second needs a browser (261 MiB, plus 326 MiB of libraries in a minimal container), gives 18 to 426 KB PNGs and leaks hidden edges. Rejected (T8.0b).
- **Provenance in the document format.** Would need a format bump for what is a fact about a branch, not a model. Rejected (plan decision 3).
- **Server-assigned or agent-computed ids.** The first adds a round trip per batch; the second fails because models cannot track counters per scope. Rejected for symbolic ids (decision 8).
- **An approve tool behind a confirmation.** Any tool the agent can call is a tool an injected agent can call. Rejected: approval is a person's act in History.
- **A tool that runs code** (a JavaScript or shell tool). Rejected: commands only, and scripted features where logic is needed, so everything is reviewable.

## Consequences

- New packages: `packages/session` (T8.1c, security review), `packages/review` (T8.3a), `apps/mcp` (T8.4a, security review); `packages/library` and `packages/render` have landed. The MCP SDK's license is read from the installed package at adoption, with a row in ADR 0006.
- A session costs about 0.5 to 1 GiB resident. Until T8.1c verifies that a recycled kernel is released, a process holds at most 2 sessions.
- The tool surface is a second public contract beside commands, with its own golden in CI; every later milestone that adds a command kind may need a tool, and none may change one silently.
- The review gate's check depends on measurements and names agreeing between Node and the browser. A domain that computes geometry with JavaScript `Math` may differ in the last bits; a domain whose measurement differs beyond the tolerance would block approval, which shows up as a visible mismatch, never a silent pass.
- Strict provenance parsing makes the review states a compatibility promise (decision 9).
- The gate is a workflow guarantee, not a sandbox. It stops unreviewed agent work from reaching Main or a fabrication file through manufakture; an agent that also has a shell and the user's files can do anything the user can, and scoped tokens protect the server, not the machine. The user docs (T8.5a) say so.
- Review requires a running sync server, even on one machine.
- The print setup plate export stays in the app; until it moves to a package, a headless session cannot write a packed plate, only per-part STL or 3MF.

## Questions and their owners

- **Session model** (open, resume, apply, undo, update from Main, close): decision 1; T8.1c builds it.
- **Limits**: decision 3; the idle timeout and the regen overrun margin are T8.1c's.
- **Releasing a recycled kernel** (terminating the worker, or `gc()` after each recycle): T8.1c verifies; 2 sessions per process until then.
- **Node against browser determinism**: decision 4; the measurement tolerance is T8.3b's.
- **Injections for Node** (text `fetchImpl`, domain registry, user fonts and scripts in a worker with a watchdog): decision 2; the script policy in sessions is T8.1c's.
- **Rendering**: decision 5, landed in T8.2a.
- **Tool list and versioning**: decisions 6 and 7; the schema golden is T8.4a's.
- **Symbolic ids**: decision 8; T8.1c.
- **Branch provenance and its forward compatibility**: decision 9, landed in T8.1a; provenance over sync is T8.4b's.
- **Bundle contents and approval**: decision 11; T8.3a and T8.3b.
- **Export gate and its formats**: decision 12; T8.3c; extending it to IFC is the maintainer's call in T8.0d.
- **Scoped agent tokens, and one writer per branch over sync**: decision 13; T8.4b.
- **Review through the sync server only** (open question 1): decision 10.
- **What the gate covers** (open question 3): decision 12.
- **Prompt injection**: decision 14; the guide is T8.5a's, the threat model T8.7a's.
- **Spikes before M7 lands** (open question 2): moot; both spikes are done, and T8.1a has landed on T7.1f's merge.
