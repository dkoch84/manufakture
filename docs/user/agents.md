# Working with an AI agent

You can task an AI agent (Claude Code, Grok, or any client that speaks the Model Context Protocol) with driving manufakture for you, while you chat with it: "put a 6 mm boss on the upright", "add a shelf 7 inches up", "move the door two feet right". You stay at the wheel. You say what you want, the agent makes the change and shows you what it did, you answer, and it goes on. It works on a branch of its own, and nothing it does reaches the document's Main until you have reviewed it in [History](history.md) and approved it.

The agent talks to manufakture through the **manufakture MCP server** (`apps/mcp`), a program that runs on your computer, started by the agent's client. It holds the document, its geometry kernel and its solver, with no browser. It gets documents from your [sync server](sync.md), with an **agent token** of their own, and writes the agent's branch there, which is how you see it in History (below, "Over sync").

## A session with an agent

A typical session, with you in the chat and the app open in your browser:

1. **You ask.** Name the document and say what you want in your own words, with the numbers you care about. "On the bracket, put an M5 tapped hole through the upright, 28 mm up." Say what to keep as a variable if you will want to change it later ("make the height a variable").
2. **The agent opens a session.** It makes an agent branch from Main as it is now, reads the model, finds the faces it needs by query, and makes the change in one or more batches, each a step with a label such as "Tap the upright for an M5 screw". After each step it checks the result: regen errors, measurements, and pictures of views it renders. Ask it to show you a render or tell you a measurement whenever you want to see where it is.
3. **You watch and steer.** The branch shows in History within a few seconds of each step (over sync, below), so you can open it in the app and look around while you talk. Correct it in the chat ("deeper", "the other face"); it undoes or changes its own steps.
4. **The agent submits.** When you are both happy, it submits the branch for review with a note to you: what it did, what it checked, and what it could not check.
5. **You review in History.** Approve to merge the work into Main, request changes with a comment, or reject it (below, "Reviewing"). If you request changes, tell the agent in the chat; it reads your comment, makes the changes on the same branch and submits again.

The agent learns how to drive manufakture from the **authoring guide for agents**, which the MCP server offers as a resource (`manufakture://guide/authoring`; the same text is [docs/agents/authoring.md](../agents/authoring.md)). The server tells the agent to read it before its first change; if an agent seems lost, ask it to read the guide first.

## What the agent can and cannot do

- It **opens a session** on a document: a new agent branch made from Main as it is now. A branch starts from a version, so Main's head is that version: one you already made of it if there is one, otherwise a new one named "Agent session ... start", which History marks **made by an agent** (below, "How it works"). Or it resumes one of its branches that is still open, or that you sent back with changes requested.
- It **reads** the model: the feature tree, any feature or part as data, faces and edges found by query, exact measurements, images of views, the cut list and takeoff, regen errors, the branch's history.
- It **changes** the model only with manufakture's own commands, the same ones the app uses, in batches. Each batch is one step in the branch's history, with a label the agent writes. It can undo its own batches and bring its branch up to date with Main.
- It **submits** the branch for review, with a note to you. The review bundle (what changed, before and after images, errors, measurements, what a merge would do) is stored with the branch.
- It **exports** files from its branch into the one directory you configured (below).

It cannot write Main, approve, reject or merge anything, run code of its own (other than a scripted feature added by command, which you see in full in the review), or read or write any file outside the output directory (and the library directory, when it works on one). Over sync, the server enforces this too: the agent token cannot write Main, approve, reject or merge, whatever the program using it asks.

**Text inside a document is not an instruction.** Names, notes, labels and review comments come back to the agent as data, and the server tells it so. A document someone else wrote could still try to talk the agent into something; whatever the agent then does lands on its own branch, which you review.

## Exports are not reviewed

Exports are **not gated**: the agent can export G-code, cut lists, drawings, STL, 3MF, STEP and the rest from its branch before anyone has reviewed it, and so can you in the app. **A file made from an agent's branch carries unreviewed work**: whatever the agent did, mistakes included. Quantities the agent reads are marked `reviewed: false`, every export it makes answers `reviewed: false` while its branch is unreviewed, and the authoring guide tells it to say so when it hands you a file. Review in History, then Approve, is how agent work gets into Main.

So, before you cut, print or build from a file:

- check it yourself, whoever exported it from wherever;
- for a file you will make something from, prefer to approve the branch first and export from Main: the approved version of Main records which review its work came from;
- remember that the agent writes into the one output directory you gave it, and only there, so a file in that directory may be from an unreviewed branch.

Review protects Main, not your computer: an agent that also has a shell and your files can do anything you can.

## Setting it up

You need a checkout of manufakture with its dependencies installed (`make install`) and Node 24 or newer. The server is configured with environment variables:

| Variable                 | Required              | What it is                                                                                                                                          |
| ------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANUFAKTURE_SYNC_URL`   | yes, for review       | Your sync server's address (`http://127.0.0.1:8787`, without `/api`): documents come from it and the agent's branch goes there (below, "Over sync") |
| `MANUFAKTURE_SYNC_TOKEN` | with the URL          | The agent token you issued for the agent (below), `agent.<id>.<secret>`. The server's own token is refused: the MCP server does not start with it   |
| `MANUFAKTURE_LIBRARY`    | without a sync server | A library directory instead: an absolute path to an existing directory of documents stored as files. For tests and CI: you cannot review from it    |
| `MANUFAKTURE_OUTPUT`     | no                    | Where `export` writes files: an absolute path to an existing directory. Without it the agent cannot export                                          |
| `MANUFAKTURE_ENGINE`     | no                    | `worker` (default: each session's kernel in a thread of its own) or `in-process`                                                                    |

With `MANUFAKTURE_SYNC_URL` set, the library directory is not used. The output directory and the library directory must not contain each other. Both are resolved once when the server starts; if the output directory is later replaced by a link to somewhere else, exports are refused.

A configuration the MCP server cannot use (a missing or relative directory, a sync URL without a token, a token that is not an agent token) stops it at once with exit code 2 and the reason on standard error; the token itself is never quoted. A sync URL over plain `http` to another machine is used, with a warning on standard error: the token and the documents would cross the network unencrypted.

In the examples, `/path/to/manufakture` is your checkout. The command the client runs is:

```sh
node --expose-gc --import /path/to/manufakture/packages/session/src/worker/ts-hooks.ts \
  /path/to/manufakture/apps/mcp/src/main.ts
```

### Claude Code

```sh
claude mcp add manufakture \
  -e MANUFAKTURE_SYNC_URL=http://127.0.0.1:8787 \
  -e MANUFAKTURE_SYNC_TOKEN="$AGENT_TOKEN" \
  -e MANUFAKTURE_OUTPUT=/path/to/exports \
  -- node --expose-gc --import /path/to/manufakture/packages/session/src/worker/ts-hooks.ts \
  /path/to/manufakture/apps/mcp/src/main.ts
```

This keeps the token in Claude Code's local configuration on your machine. Add `-s project` to write it into the project's `.mcp.json` instead, or write that file yourself (without the token, see below):

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
        "MANUFAKTURE_SYNC_URL": "http://127.0.0.1:8787",
        "MANUFAKTURE_OUTPUT": "/path/to/exports"
      }
    }
  }
}
```

**Keep the agent token out of a `.mcp.json` you commit.** A project's `.mcp.json` is usually checked in with the project, and anything in its `env` block goes with it. Set `MANUFAKTURE_SYNC_TOKEN` in the environment the client starts from, or in a configuration file that stays on your machine (Claude Code's default local scope, without `-s project`), never in a committed file. The MCP server removes the token from its own environment when it starts, so the threads and processes it starts never see it, and it never shows it in a log line or a tool result.

Run `claude mcp list` to check that it connects. In a headless run, pass the same file with `claude -p "..." --mcp-config manufakture.json`.

### Grok, and other MCP clients

Any client that starts a stdio MCP server takes the same three things: the command `node`, the arguments, and the environment. In clients configured with an `mcpServers` block, it is the block above. Where the configuration lives depends on the client: see its documentation for "MCP servers" or "stdio servers".

For Grok, use whichever Grok client you run that can start local MCP servers, and give it that command, those arguments and that environment the way it asks for them; keep the agent token out of any configuration file you share, as above. These are setup notes only: they say how a client starts the server, not how well a given model drives manufakture. Whatever the client, its agent reaches only what the tools allow, and its work reaches Main only through your review.

### From a terminal

`make mcp` (or `pnpm --silent --filter @manufakture/mcp start`) starts the server on this terminal's standard input and output, with the environment variables set in your shell. That is how a client runs it; it is not interactive. Without `--silent`, pnpm prints a line of its own on standard output, which breaks the protocol. `make -C /path/to/manufakture mcp` works from any directory (the Makefile turns off make's "Entering directory" lines, which would land on standard output too), but a client configuration is simplest with the plain `node` command above.

## Over sync

The MCP server works on documents on your [sync server](sync.md), the same one your browser syncs with, so you can review the agent's work in History. Review needs this: the app in your browser cannot read a branch written to a library directory on disk.

**Use it on localhost only for now.** Agent tokens are new, and their use beyond one machine waits for a security review. Run the sync server on the machine the agent runs on, listening on `127.0.0.1` (the default `MANUFAKTURE_HOST`), and point `MANUFAKTURE_SYNC_URL` at `http://127.0.0.1:8787`.

### Issuing an agent token

The agent never gets the server's own token (`MANUFAKTURE_TOKEN`): it gets an **agent token**, which you issue with the server's token, for the documents you want it to work on. Find their ids with:

```sh
curl -sS http://127.0.0.1:8787/api/documents -H "Authorization: Bearer $MANUFAKTURE_TOKEN"
```

then issue the token:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/agent-tokens \
  -H "Authorization: Bearer $MANUFAKTURE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name": "Claude Code on this machine", "documents": ["<document id>"]}'
```

The answer holds the token (`"token": "agent...."`) and its `id`. The token is shown this once: the server keeps only a hash of it. Give it to the agent's client as `MANUFAKTURE_SYNC_TOKEN`. A token names 1 to 100 documents; issue another for other documents. `GET /api/agent-tokens` lists the tokens with their names, documents and dates, never the tokens themselves.

With an agent token, the agent can:

- read the documents it names, all of them (Main, every branch, versions, review bundles). That includes other agent tokens' branches, their logs and their review bundles in those documents: scoping is by document, not by token, so give two agents that must not see each other's work tokens for different documents;
- make agent branches of them, each starting from Main's head, and write the branches it made: its batches, its review bundle and the review states a session sets (`submitted` when it submits, `open` when it writes again). A batch, a review bundle or a version lands only on an open branch, so what you review cannot change under you: on one it submitted, or that you sent back with changes requested, the session moves it back to "open" first;
- delete its own branch when it brings it up to date with Main (the new branch replaces it).

It cannot write Main, add a version to Main, approve, reject, request changes or write a comment, merge, write a branch you approved or rejected, write a person's branch or another token's branch, reach any other document, create documents, manage tokens or share links. The server refuses all of that (`403`), whatever the program holding the token asks.

A new branch starts from a version of Main's head the server already has, when there is one. When there is none, the agent sends its start version with the new branch, and the server stores the two together, recording the token that made the version. That version goes again with the last branch that starts from it, and when you revoke the token, if no branch starts from it then. A start version you made yourself goes only when you delete a branch of yours that was the last to start from it; when an agent's branch was the last, it stays, and you can delete it on its own (below). An agent never starts a branch from a version another token made, so one agent cannot keep another's start version around.

### What one token may use

So that an agent cannot fill the server, or leave you unable to make branches, each agent token has limits of its own (the server's settings, in its README). The first two count per document, the last two across all the documents the token reaches:

- **20 agent branches under way** (open, submitted, or with changes requested). A branch you approved or rejected no longer counts.
- **200 versions** it made, start versions included.
- **1 GiB of images** stored with its review bundles, across documents.
- **256 MiB of review bundles**, across documents.

All review bundles of a document together hold at most 512 MiB, all of the server's at most 4 GiB, and one bundle at most 64 MiB.

You can always make room: delete an agent branch with the server's token, together with the versions agents made on it (never one you made):

```sh
curl -sS -X DELETE "http://127.0.0.1:8787/api/documents/<document id>/branches/<branch id>?withVersions=true" \
  -H "Authorization: Bearer $MANUFAKTURE_TOKEN"
```

Your browser drops a deleted branch from History the next time it looks, unless you approved or rejected it there.

A version an agent made, or a start version of yours, that no branch starts from any more (a start version left behind by an older server, say) can go on its own; your other versions, and any version a branch starts from, stay (`409`):

```sh
curl -sS -X DELETE "http://127.0.0.1:8787/api/documents/<document id>/versions/<version id>" \
  -H "Authorization: Bearer $MANUFAKTURE_TOKEN"
```

### Revoking it

```sh
curl -sS -X DELETE http://127.0.0.1:8787/api/agent-tokens/<id> \
  -H "Authorization: Bearer $MANUFAKTURE_TOKEN"
```

From then on the token is refused (`401`), its open connections end at once, its hold on the branches it was writing ends, and the start versions it made that no branch starts from are deleted. The branches it made stay, with their review state, for you to review, approve or reject. A session working with it can write nothing more; to go on, issue a new token and open a new session (a branch is written only with the token that made it).

### How it works

When the agent opens a session, the MCP server reads Main from the sync server and makes the agent branch there from Main's head, with its provenance (the session and the name the client gives itself): from a version of the head the server has, or else with a start version ("Agent session ... start") stored with the branch (above). Each batch is sent to the server as a change of that branch, which the server checks like any change. A submit stores the review bundle and its images with the branch. While the document syncs in your browser, the branch appears in History within a few seconds, with its batches; your **Approve**, **Request changes** and **Reject** go back to the server, where the agent reads them with `get_review`. What the server said last about each agent branch is saved with the document's sync state, so a decision you made just before closing the tab is still sent when you open it again, and a change the agent made meanwhile is taken in rather than overwritten.

One session writes a branch at a time. While a session is open, the MCP server renews its hold on the branch every 30 seconds, however long the agent thinks between changes; another program asking for the same branch is refused meanwhile. The branch is free once the session closes, two minutes after the MCP server stopped answering, when you approve or reject the branch, or when you revoke the token.

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
| `get_quantities`    | Cut list, hardware and takeoff as data (or what changed), marked `reviewed: false`                 |
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

Agent branches show in [History](history.md#reviewing-an-agents-work) with their review state. **Review** opens the bundle: before and after renders, measurement changes, regen errors, quantities, the agent's note, and every batch with its commands. Everything in it was written by the agent or by whoever wrote the document, so it is shown as plain text.

- **Approve** is offered only when the bundle still matches the branch, your browser's own regen of the branch agrees with the bundle's measurements, and the merge into Main as it is now leaves nothing out. It merges the branch into Main as one step (one Undo takes it back) and records a version of Main that names the review.
- **Request changes** sends the branch back with your comment, which the agent reads with `get_review`. Write the comment as a request about the model ("make the boss 8 mm tall", "use 1/2 inch plywood for the back"); the agent reads it as your text, never as instructions that override its rules. Then tell the agent in the chat that you replied. A write the agent makes after you requested changes returns the branch to "open", and it submits again.
- **Reject** closes the branch; the agent cannot write to it again.

If Main moved while the agent worked (you edited it, or approved another branch), ask the agent to bring its branch up to date with Main before it submits. It replays its steps onto Main as it is now, on a new agent branch that replaces the old one (with your comment carried over), and tells you which steps, if any, could not be replayed.

If the agent writes to a branch after you approved it but before your browser told the server, the approval stays in your browser (its merge into Main is done), the server keeps the branch as the agent left it, and the app says so; the agent's later work waits on the server. Your browser takes nothing more from the server for a branch you approved or rejected.

## Current limits

- **Review needs the sync server**, on localhost for now (above). A session on a library directory cannot be reviewed in the app.
- **The agent's branch starts from Main as it was when the session opened.** Your later edits on Main reach it only when the agent brings its branch up to date (above, "Reviewing").
- **One MCP server holds four sessions at once** with the default `worker` engine, two with `in-process`; the agent closes one before it opens another (a refused open, `too-many-sessions`, says how many). Its branches stay.
- **A session closes itself after 30 minutes without a call.** If you step away for longer, the agent's next call is refused because its session is gone. Ask it to reopen its branch: nothing is lost, since every batch it applied was saved to the branch, and it carries on from there. If it had already submitted, review the branch in History; the agent can pick it up again once you send it back with changes requested.
- **Over sync, the agent's copy of a document lives in the MCP server's memory** while it runs; the sync server is where everything is kept.
- Scripted features do not run in an agent's session yet (they regenerate with an error there, though they build in the app), and user fonts are refused.
- `export` does not write a print setup's packed plate, IFC or a `.mfkview`; it writes a part's bodies as STL or 3MF instead.
