# Working with an AI agent

You can ask an AI agent (Claude Code, Grok, or any client that speaks the Model Context Protocol) to make changes in a manufakture document while you talk with it: "put a 6 mm boss on the upright", "move the door two feet right". You stay at the wheel. The agent works on a branch of its own, and nothing it does reaches the document's Main until you have reviewed it in [History](history.md) and approved it.

The agent talks to manufakture through the **manufakture MCP server** (`apps/mcp`), a program that runs on your computer, started by the agent's client. It holds the document, its geometry kernel and its solver, with no browser.

## What the agent can and cannot do

- It **opens a session** on a document: a new agent branch made from Main as it is now (Main itself is recorded as a version named "Agent session ... start"). Or it resumes one of its branches that is still open, or that you sent back with changes requested.
- It **reads** the model: the feature tree, any feature or part as data, faces and edges found by query, exact measurements, images of views, the cut list and takeoff, regen errors, the branch's history.
- It **changes** the model only with manufakture's own commands, the same ones the app uses, in batches. Each batch is one step in the branch's history, with a label the agent writes. It can undo its own batches and bring its branch up to date with Main.
- It **submits** the branch for review, with a note to you. The review bundle (what changed, before and after images, errors, measurements, what a merge would do) is stored with the branch.
- It **exports** files from its branch into the one directory you configured (below).

It cannot write Main, approve, reject or merge anything, run code of its own (other than a scripted feature added by command, which you see in full in the review), or read or write any file outside the library directory and the output directory.

**Text inside a document is not an instruction.** Names, notes, labels and review comments come back to the agent as data, and the server tells it so. A document someone else wrote could still try to talk the agent into something; whatever the agent then does lands on its own branch, which you review.

## Exports are not reviewed

Exports are **not gated**: the agent can export G-code, cut lists, drawings, STL, 3MF, STEP and the rest from its branch before anyone has reviewed it, and so can you in the app. A file made from an agent's branch carries whatever the agent did. Quantities the agent reads are marked `reviewed: false`. Review in History, then Approve, is how agent work gets into Main; check a file yourself before you cut, print or build from it.

Review protects Main, not your computer: an agent that also has a shell and your files can do anything you can.

## Setting it up

You need a checkout of manufakture with its dependencies installed (`make install`) and Node 24 or newer. The server is configured with environment variables:

| Variable                 | Required | What it is                                                                                                                   |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `MANUFAKTURE_LIBRARY`    | yes      | The library directory: an absolute path to an existing directory, where documents, versions and branches are stored as files |
| `MANUFAKTURE_OUTPUT`     | no       | Where `export` writes files: an absolute path to an existing directory. Without it the agent cannot export                   |
| `MANUFAKTURE_ENGINE`     | no       | `worker` (default: each session's kernel in a thread of its own) or `in-process`                                             |
| `MANUFAKTURE_SYNC_URL`   | no       | Your sync server, for sessions over sync (not used yet, see below)                                                           |
| `MANUFAKTURE_SYNC_TOKEN` | no       | The agent token for that server (not used yet)                                                                               |

The output directory and the library directory must not contain each other. Both are resolved once when the server starts; if the output directory is later replaced by a link to somewhere else, exports are refused.

In the examples, `/path/to/manufakture` is your checkout. The command the client runs is:

```sh
node --expose-gc --import /path/to/manufakture/packages/session/src/worker/ts-hooks.ts \
  /path/to/manufakture/apps/mcp/src/main.ts
```

### Claude Code

```sh
claude mcp add manufakture \
  -e MANUFAKTURE_LIBRARY=/path/to/library \
  -e MANUFAKTURE_OUTPUT=/path/to/exports \
  -- node --expose-gc --import /path/to/manufakture/packages/session/src/worker/ts-hooks.ts \
  /path/to/manufakture/apps/mcp/src/main.ts
```

Add `-s project` to write it into the project's `.mcp.json` instead, or write that file yourself:

```json
{
  "mcpServers": {
    "manufakture": {
      "command": "node",
      "args": [
        "--expose-gc",
        "--import",
        "/path/to/manufakture/packages/session/src/worker/ts-hooks.ts",
        "/path/to/manufakture/apps/mcp/src/main.ts"
      ],
      "env": {
        "MANUFAKTURE_LIBRARY": "/path/to/library",
        "MANUFAKTURE_OUTPUT": "/path/to/exports"
      }
    }
  }
}
```

**Keep the agent token out of a `.mcp.json` you commit.** A project's `.mcp.json` is usually checked in with the project, and anything in its `env` block goes with it. Once sessions over sync use `MANUFAKTURE_SYNC_TOKEN`, set it in the environment the client starts from, or in a configuration file that stays on your machine (Claude Code's default local scope, without `-s project`), never in a committed file. The server removes the token from its own environment when it starts, so the threads and processes it starts never see it.

Run `claude mcp list` to check that it connects. In a headless run, pass the same file with `claude -p "..." --mcp-config manufakture.json`.

### Grok, and other MCP clients

Any client that starts a stdio MCP server takes the same three things: the command `node`, the arguments, and the environment. In clients configured with an `mcpServers` block, it is the block above. Where the configuration lives depends on the client: see its documentation for "MCP servers" or "stdio servers".

### From a terminal

`make mcp` (or `pnpm --silent --filter @manufakture/mcp start`) starts the server on this terminal's standard input and output, with the environment variables set in your shell. That is how a client runs it; it is not interactive. Without `--silent`, pnpm prints a line of its own on standard output, which breaks the protocol. `make -C /path/to/manufakture mcp` works from any directory (the Makefile turns off make's "Entering directory" lines, which would land on standard output too), but a client configuration is simplest with the plain `node` command above.

## The tools

The agent sees these tools (each with its schema and a description):

| Tool                | What it does                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `list_documents`    | The documents, their branches and each agent branch's review state                                 |
| `open_session`      | A new agent branch of a document (or resume one); answers the session id and the outline           |
| `close_session`     | Close the session; the branch stays                                                                |
| `get_tree`          | Parts, features with status, bodies, assemblies, variables, configurations, drawings, CAM setups   |
| `get_object`        | The full data of one feature, part, assembly, instance, mate, setup, drawing or domain entry       |
| `get_schema`        | The schema of a command or feature kind                                                            |
| `find_geometry`     | Faces and edges by name or by query, with area, centroid, normal and radius                        |
| `measure`           | Volume, area, mass, bounding box, distances, angles, clearance, interference                       |
| `render`            | PNG images of views, with highlighted names and section planes; before and after side by side      |
| `get_quantities`    | Cut list, hardware and takeoff as data, marked `reviewed: false`                                   |
| `get_errors`        | Regen errors and warnings                                                                          |
| `get_history`       | The branch's batches with labels                                                                   |
| `apply`             | One batch of commands with a label (or a dry run)                                                  |
| `undo`              | Undo the last batch                                                                                |
| `update_from_main`  | Replay the branch onto Main as it is now, on a new branch; reports what could not be replayed      |
| `submit_for_review` | Build the review bundle and submit the branch, with a note                                         |
| `get_review`        | The review state, and your comment when you requested changes                                      |
| `export`            | STEP, STL, 3MF, cut list, bill of materials, takeoff, drawing, G-code, laser outline, `.mfk` files |

The server also offers the authoring guide for agents and the index of command and feature schemas as resources.

## Reviewing

Agent branches show in [History](history.md) with their review state. **Review** opens the bundle; **Approve** merges the branch into Main as one step; **Request changes** sends the branch back with your comment, which the agent reads with `get_review`; **Reject** closes it. A write the agent makes after you requested changes returns the branch to "open".

## Current limits

- **Review needs the sync server.** The app in your browser cannot read a branch the MCP server wrote to a library directory on disk. Sessions over sync, with agent tokens that can never write Main, are the next step (M8 plan, T8.4b); until then, `MANUFAKTURE_SYNC_URL` and `MANUFAKTURE_SYNC_TOKEN` are read and checked but not used, and the library directory is what the agent works on.
- Scripted features do not run in an agent's session yet (they regenerate with an error there, though they build in the app), and user fonts are refused.
- `export` does not write a print setup's packed plate, IFC or a `.mfkview`; it writes a part's bodies as STL or 3MF instead.
