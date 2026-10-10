# @manufakture/mcp

The MCP server for AI agents ([ADR 0016](../../docs/adr/0016-agent-sessions.md) decisions 6, 7,
12 and 13; M8 plan [T8.4a](../../docs/plans/agent-surface.md)): one tool per row of the plan's
tool table over [`packages/session`](../../packages/session/README.md), over stdio, on the
TypeScript MCP SDK. Setup for users, Claude Code and other clients:
[docs/user/agents.md](../../docs/user/agents.md).

```sh
MANUFAKTURE_SYNC_URL=http://127.0.0.1:8787 MANUFAKTURE_SYNC_TOKEN=agent.... \
  MANUFAKTURE_OUTPUT=/abs/exports make mcp
# a library directory instead (tests, CI): MANUFAKTURE_LIBRARY=/abs/library
# or: pnpm --silent --filter @manufakture/mcp start
```

stdout carries the protocol and nothing else; log lines go to stderr. The process ends when its
input closes, closing every session (the branches stay).

**Keeping stdout to the protocol.** OCCT prints (the STEP writer's transfer statistics, about 13
lines a file), and Emscripten's default for that is `console.log`. Three layers keep it off
stdout: the kernel's text output goes to stderr (`STDERR_OUTPUT` from `@manufakture/kernel/node`,
passed by the workshop and by `packages/session` to every kernel instance); a session worker's
stdout is piped to stderr (`packages/session`'s engine); and `src/stdout.ts`, imported first by
`src/main.ts`, gives the transport its own writable on the real stdout and sends everything else
written to `process.stdout`, and `console.log`, `info` and `debug`, to stderr.

| File                    | What                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/main.ts`           | The stdio entry: configuration from the environment, the transport, shutdown.                          |
| `src/stdout.ts`         | stdout for the transport alone: everything else written there goes to stderr.                          |
| `src/config.ts`         | `loadConfig(env)`: the library root, the output directory, the engine kind, the sync server (checked). |
| `src/server.ts`         | `createMcpServer(options)`: the tools and their handlers, on a `SessionManager`.                       |
| `src/schemas.ts`        | Every tool's input and output schema (zod).                                                            |
| `src/results.ts`        | Results as data: `{ ok, ...fields }` or `{ ok: false, error }`, held under the JSON limit.             |
| `src/bounds.ts`         | `boundJson`: cuts the largest lists and the longest strings until a result fits, and reports the cuts. |
| `src/quantities.ts`     | `get_quantities`' options: the scope (`owner`, `phase`), lists and categories shown, `detail: false`.  |
| `src/render.ts`         | The `render` tool: PNG views of the head (and the base) through `@manufakture/render`.                 |
| `src/exports.ts`        | The `export` tool's formats, through T8.1b's Node entry points.                                        |
| `src/files.ts`          | Writing into the output directory and nowhere else: safe names, `realpath`, no symbolic links.         |
| `src/workshop.ts`       | One in-process kernel where `render` and `export` regenerate the head, one call at a time.             |
| `src/resources.ts`      | The authoring guide and the schema index (and one schema per command type and feature kind).           |
| `src/surface.ts`        | The tool surface as a contract, and which changes do more than add.                                    |
| `src/version.ts`        | `SURFACE_VERSION`, the server info's version.                                                          |
| `src/tools.golden.json` | The golden of every tool's name with its input and output schemas.                                     |

## Configuration

From the environment (`src/config.ts`); a problem ends the process with exit code 2 and the
reasons on stderr (never quoting the token). A warning (a sync URL over plain `http` to a host
that is not this machine) goes to stderr, and the server starts.

| Variable                 | Required        | Value                                                                                                                               |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MANUFAKTURE_SYNC_URL`   | no              | http(s) URL of the sync server, no credentials in it: sessions work over sync (T8.4b)                                               |
| `MANUFAKTURE_SYNC_TOKEN` | with the URL    | An agent token, `agent.<id>.<secret>` (the instance's own token is refused); never logged or returned, removed from the environment |
| `MANUFAKTURE_LIBRARY`    | without the URL | Absolute path of an existing directory: a `NodeBackend` root (`documents/...` under it); unused over sync                           |
| `MANUFAKTURE_OUTPUT`     | no              | Absolute path of an existing directory for exports; without it `export` answers `no-output`                                         |
| `MANUFAKTURE_ENGINE`     | no              | `worker` (default) or `in-process`, where each session's kernel runs                                                                |

Both directories are resolved with `realpath` at start, and must not contain each other.

**Over sync** (ADR 0016 decision 10, T8.4b), the library is a `SyncedLibrary` from
`packages/session`: a working copy in memory of what the server holds, with every change going
to the server first (batches as entries of the branch's server log, bundles and images with the
branch, review states as compare-and-sets there), and branch locks that also let go of the
server's one-writer lease. `list_documents` lists the server's documents the token reaches
(`savedAt` is when the document was made there: the server keeps no save time), with each
document's branch records; `open_session` with a branch first builds it here from the server's
log (`SyncedLibrary.materialize`), refusing as `locked` a branch another process writes (told by
the failure's `busy`, not by its text);
`get_review` by document and branch reads the server's record. A refusal from the server reaches
the agent as the session's typed error, with the server's code and no address or token
(`RemoteRefusal`). A library directory stays for tests and CI.

**Running TypeScript in Node.** Like `packages/session`'s worker threads (ADR 0016 decision 2), the
server runs the workspace's sources through `packages/session/src/worker/ts-hooks.ts`
(`--import`): it resolves extensionless imports and transpiles `.ts` with the repository's
TypeScript. Session workers load the same hooks. Nothing is built ahead of time. `--expose-gc`
lets a replaced in-process kernel be collected.

## Tools

The plan's table, one tool each: `list_documents`, `open_session`, `close_session`, `get_tree`,
`get_object`, `get_schema`, `find_geometry`, `measure`, `render`, `get_quantities`, `get_errors`,
`get_history`, `get_review`, `apply`, `undo`, `update_from_main`, `submit_for_review`, `export`.
docs/user/agents.md summarises them; their schemas are in `src/schemas.ts`.

**Results.** Each tool answers structured content (checked by the SDK against the output schema)
and the same JSON as a text block. Success is `{ ok: true, ...fields }`. An expected failure is
`{ ok: false, error }` with `isError` set, never a thrown error: `error.kind` is `session` (the
session's typed `SessionError`, limits included), `core` (core's `CoreError` for a refused
command, under `error.error`) or `server` (this server's own, `ServerErrorCode` in
`src/results.ts`). An input its schema refuses is answered by the SDK, before the tool runs, as
an `isError` result with the validation message. Anything unexpected is logged on stderr and
answered with a general message.

**Images.** `render` answers its images as MCP image content (PNG), after the text block;
`images[i].content` is the index of each one, with its view, side (`head` or `base`), size,
millimetres per pixel and the highlight names that matched nothing. With `compare`, each view is
drawn of the base version too, at the same camera (`@manufakture/review`'s `sharedCamera`).

**Review.** `submit_for_review` passes `@manufakture/review`'s `bundleBuilder` (with the agent's
views, at most four) to `Session.submit`; it is the only tool that submits. A write by `apply` or
`undo` also moves a review state: it returns a `submitted` or `changes-requested` branch to `open`
(ADR 0016 decision 9). `get_review` reads the branch record from the library each time, so a reviewer's
decision and comment are current.

**Export.** Not gated (ADR 0016, "Acceptance"): any branch exports, an unreviewed agent branch
included; the result says `reviewed: false`. Formats: `step`, `stl`, `stl-each`, `3mf` (a part's
framing members with them), `cut-list-csv`, `bom-csv`, `cut-list-pdf`, `takeoff-csv`,
`takeoff-pdf`, `drawing-pdf`, `drawing-dxf`, `drawing-svg`, `gcode`, `laser-dxf`, `laser-svg`
(face and sketch region sources) and `mfk` (the branch, through `DocumentLibrary.exportMfk`).

## Security

The security review's points (M8 plan T8.4a), and where each is held:

- **Input validation.** Every tool's input is a strict zod schema (`src/schemas.ts`): unknown
  fields refused; ids by pattern and length; numbers finite and bounded; lists bounded (500
  commands, 8 views, 64 laser sources, 256 highlight names). Commands are checked by core inside
  the session. The SDK also bounds the elements of a call's arguments (`maxToolInputElements`).
- **Session ids** are made by the session (a new UUID, or a resumed branch's): `open_session`
  takes no id, and its schema refuses one. A call reaches only sessions this process opened.
  The library's `reviewCommentFrom` is never passed: no call here creates branches itself.
- **Main.** No tool takes Main as a target to write: `open_session` refuses `branch: main` itself
  (`main-refused`), the session refuses it again, and every save checks.
- **Review states.** No tool approves, rejects, merges or requests changes;
  `submit_for_review` only submits, and a write by `apply` or `undo` only reopens a `submitted`
  or `changes-requested` branch.
- **Paths.** Documents come only from the library root (ids are `isStorableId`, and
  `NodeBackend` confines every path), or over sync only from the sync server, where the agent
  token is checked on every request (apps/server README, "Agent tokens"). Exports go only into the output directory
  (`src/files.ts`): every name, the agent's or the document's, is reduced to one plain file name
  (no separators, no leading dot, no trailing dot or space, no control characters, Windows'
  reserved names prefixed), and no two files of one export share a name (without case); the
  directory's real path must still be the configured one; the target must sit directly in it; a
  link, directory or other non-file at the name is refused; a file is written under a temporary
  name with `O_CREAT | O_EXCL`, then hard-linked to its name (which fails if anything appeared
  there since the check) or, with `overwrite`, renamed onto it, so nothing is written through a
  link and an existing file is replaced only with `overwrite`. When one file of an export cannot
  be written, those already written are removed. At most 500 files and 512 MiB an export.
- **Output size.** Every result's JSON is held under 256 KiB (`boundJson`: the largest list
  halved, or every string over the length that makes it fit cut to that length in one pass,
  until it fits; each cut reported under `truncated`). Images: at most 8 a call,
  2048 px a side, 8 MiB each and 16 MiB a call; one over is left out and listed in `failed`.
- **Document text** (names, notes, labels, comments) travels only in data fields. Tool
  descriptions, the server's instructions, the resources and the messages this server writes
  are fixed text; where a package's message may quote the document (an export naming an
  operation, a render failure), it goes into `error.details`.
- **Errors** about the file system carry the system error code only (`Writing failed (ENOSPC).`),
  never a path; the session does the same for its own.

## Tool list versioning

ADR 0016 decision 7: the tools are a public contract. `src/tools.golden.json` holds every tool's
name with its input and output schemas as `tools/list` gives them (descriptions and titles left
out: they may be reworded). `test/golden.test.ts` fails when the surface does more than add
(`surfaceChanges`: a removed tool or field, a newly required input, a tightened bound, a dropped
enum value or union option, a changed type), whatever else happens. When it only adds, raise
`SURFACE_VERSION` in `src/version.ts` and rewrite the golden:

```sh
UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run --project mcp apps/mcp/test/golden.test.ts
./node_modules/.bin/prettier --write apps/mcp/src/tools.golden.json
```

In outputs, a new enum value (a review state, a render side) counts as more than adding: a
client that handles every value it knows would meet one it does not.

`apply` checks only a command's `type` here (ADR 0016, amendment of decisions 6 and 7): the
session validates the rest of each command against core's zod schema and answers a failure as
data, and `get_schema` serves each command's full JSON Schema. So a new command type changes the
golden (an added input enum value) and needs a version raise; a change to a command's own fields
follows core's add-only rule for commands, not this golden.

## Testing

```sh
./node_modules/.bin/vitest run --project mcp
```

- `test/tools.test.ts`: every tool on the M1 bracket through the SDK's client over the in-process
  transport (sessions on the in-process kernel): the documents, a session on a new agent branch,
  the reads, a batch with symbolic ids, a dry run and undo, renders with their labels (and base
  against head), every export format the bracket has from the unreviewed branch (STEP, STL, STL
  per body, 3MF, `.mfk`, a laser outline, a cut list) and those it lacks refused as data, update
  from Main, a submit with the real bundle builder, a reviewer's comment read back as data, and a
  resume after changes were requested.
- `test/security.test.ts`: Main refused (by the server and by the session), unknown documents,
  sessions and branches, core's and the session's refusals as data, strict inputs (the caller
  never picks a session id), the session's limits, export names from a hostile document name,
  names that are paths, a symbolic link or directory at the target, overwrite, an output
  directory swapped for a link, no output directory, configurations that are refused, documents
  only from the library root, the JSON and image bounds, and document text kept out of
  descriptions, resources and messages.
- `test/golden.test.ts`: the tool golden, and the rule's cases.
- `test/stdio.test.ts`: the server started as a client starts it, over stdio: initialize, the
  tool list, a session with the default worker engine; STEP, STL and 3MF exports with every
  stdout line JSON-RPC (and OCCT's statistics on stderr); a bad configuration ends with its
  reason.
- `test/workshop.test.ts`: a call over its work limit answered at once while the next waits for
  its work to settle; work that never settles has its kernel dropped, disposed once it settles,
  and beyond `MAX_STUCK` (2) such kernels a call is answered `busy`; a kernel that fails to load
  is not kept.
- `test/sync.test.ts`: the server over sync against a real sync server (in this process) with an
  agent token and no library directory: the server's documents, a session through submit with
  the bundle on the server, the reviewer's comment read back, exports, an update from Main after
  the owner edited Main, a resume in a second server process (refused while the first holds the
  branch), a revoked token, and the configuration's sync rules.
- `test/units.test.ts`: `boundJson` (strings cut in one pass), file names (unique after cutting,
  trailing dots), the hard link that never replaces, and an export that fails partway leaving
  nothing behind.
- `test/authoring-guide.test.ts`: every example of the authoring guide for agents
  ([docs/agents/authoring.md](../../docs/agents/authoring.md)), run in order through the server on
  the bracket, the cabinet and the shed. Examples are fenced blocks tagged `json mcp:<tool>` (with
  `refused` or `regen-errors` when that is what they show, or `as-previous` for the previous call
  with some arguments changed), each optionally followed by a `json mcp:result` block matched
  against the result; the convention is in a comment at the top of the guide. Any other fence
  (any indentation, backticks or tildes, any json fence without `mcp:`) is refused unless marked
  `<lang> not-run`, so a mistagged example cannot go unrun. A call that fails, a result that does
  not match, or fewer than 30 examples fails the test.

## Not done

- **`find_geometry` finds faces and edges, not vertices.** The ADR's tool list names vertices too;
  they are not found yet.
- **Export formats**: a print setup's packed plate (still the app's), IFC and `.mfkview`. Laser
  sections (they need the kernel's section op through the scene) are not offered; faces and
  sketch regions are.
- **The workshop's kernel runs in the server's thread.** A render or export regen over the
  session's regen limit, and an export's own work (nesting, toolpaths, a STEP write) over
  `exportMs`, is answered at once with its timeout (`regen-timeout`, or `export` with `limit`),
  and the kernel generation is cancelled, which stops it between kernel operations. The engine is
  disposed and the kernel recycled only once that work has settled, and the next render or
  export waits for it. Work that has not stopped `regenStopMs` after its deadline keeps its
  kernel, which the workshop drops and never uses again: the next call starts a new one. When that
  work settles, its engine is disposed and the kernel let go for collection. At most two dropped
  kernels may still be running; beyond that a render or export is answered `busy` at once. A single
  kernel operation that never returns cannot be stopped here, as it can in a session's worker.
- **No license notices for this app.** It is not one of `tools/licenses`' targets (the web app and
  the sync server are); it runs from sources, and its dependencies are listed in ADR 0006.
