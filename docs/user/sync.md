# Sync

Sync keeps one document the same in several browsers: your laptop and your workshop PC, say, or two browser profiles. Every change you make is sent to **your own manufakture server**, and every change made elsewhere arrives in the open document within a moment, as if you had made it: the model regenerates and the feature tree updates.

Documents still live in your browser first. Sync adds to that; it replaces nothing. You keep working offline, and what you did is sent when the connection is back.

There is no hosted manufakture service: sync needs a server you run (the `apps/server` program; its README says how to run it). One server has one user, and one token of its own; it can also issue agent tokens for AI agents (below, "Tokens").

## Setting it up

1. Run the server and put it behind https (the server's README, "Routing `/api` to the server"), with `MANUFAKTURE_ORIGINS` set to the address of the app you use.
2. In the app, click **Sync** in the header (next to **Share**), enter the server's address (`https://...`, without `/api`) and its token (`MANUFAKTURE_TOKEN`), and click **Save server**.

This is the same server setting as for [share links](sharing.md#share-links): set it in either place and both use it. The address and the token are kept in this browser only, never in a document or a file. **Forget** removes them.

## Syncing a document

- **Start:** open the document, click **Sync**, tick **Sync this document**. The server gets a copy, and from then on every change goes there.
- **In another browser:** set the same server there, click **Sync**, then **Documents on the server**, and **Open here** next to the document. It is stored in that browser and opens, syncing.
- **Stop:** untick **Sync this document**. The document stays in this browser as it is; the server keeps its copy. Ticking it again later sends this browser's copy as one change on top of what the server holds.

If the server already has the document when you tick the box (you synced it before, or opened it in another browser), the app starts from the server's copy, and when this browser's copy differs it is put on top as one change, labelled "This browser's copy".

Only a document's main [branch](history.md) syncs its changes. While another branch is open, the button says so; open the main branch to sync again. Named versions and branches themselves do go to the server (below).

## Versions and branches

While a document syncs, the [versions](history.md#creating-a-version) and [branches](history.md#branches) you make on its main branch are stored on the server too, and every browser that syncs the document gets them:

- **A version** made here is stored on the server as soon as the changes it holds are there, naming that point of the server's history. When you made it offline, it waits (saved with the document, across a reload) and goes up once your changes have arrived. In other browsers it appears in the **History** panel within a few seconds, marked **from the server**, and can be viewed, restored, branched from and pinned like any version of their own.
- **A branch** made here from a version the server has is stored there too, and appears in the branch list of the other browsers within a few seconds, starting from that version. What you then do on the branch stays in the browser you do it in: only the main branch's changes sync. Syncing a branch's own changes is not part of this release.
- **A derived part** that pins a version of another synced document finds it on the server when this browser does not have it, and keeps it from then on.

Versions and branches made before the document started syncing in this browser stay in this browser, and so do the ones sync makes itself to keep work it could not apply (below). A branch made from a version of Main that came from the server can be merged into Main here: its own changes are replayed onto Main as it is now, as for any merge. A branch made from a version of another branch that came from the server cannot be merged here, since this browser does not have that branch's history: merge it in the browser it was made in.

**Agent branches** are the exception to "only the main branch's changes sync": an AI agent working through the [MCP server](agents.md) writes its branch on the server, and while the document syncs here, that branch appears in History with each of the agent's batches, its review bundle and its review state, within a few seconds. Your **Approve**, **Request changes** (with its comment) and **Reject** go back to the server, where the agent reads them; what the server said last about each agent branch is saved with the document's sync state, so a reload neither loses a decision not sent yet nor undoes a change the agent made since. When the agent brings its branch up to date with Main, the new branch replaces the old one here too, also when that happened while this browser was closed; an agent branch you approved or rejected here stays. A version of Main the agent made on the server to start its branch from shows in History marked **made by an agent**.

## The status

The **Sync** button shows how the open document stands:

| Status                  | What it means                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Not synced              | the document does not sync                                                                  |
| Synced                  | everything you made is on the server, and you have everything the server has                |
| Pending _n_             | _n_ of your changes are on their way, or waiting for the server to confirm them             |
| Offline                 | the browser is offline: your changes are kept and sent when it is back online               |
| Connecting              | the app is (re)connecting to the server                                                     |
| Synced by another tab   | another tab of this browser has the document open and syncs it (see below)                  |
| Only the main branch... | a branch other than main is open                                                            |
| No server               | the document syncs, but no server (or another one) is set in this browser                   |
| Not saved: not sent     | the app could not save, so it sends nothing until it can (it keeps trying)                  |
| Update the app to sync  | the server is newer than this app: **Update the app** fetches the new version               |
| The server is too old   | the app is newer than the server: whoever runs it must upgrade it                           |
| Sync stopped            | the server's copy disagrees with this browser's in a way the app cannot resolve (see below) |
| Cannot sync             | the sync state saved with the document cannot be read (see below)                           |

A red number on the button counts notices (below).

## When two browsers change the same thing

Changes are put in one order by the server, in the order it receives them. Usually that is all there is to it: you add a fillet here, someone adds a hole there, and both appear in both places.

- **Two new features at once** each keep their own: if both browsers added the third extrude at the same moment, both take the name `Extrude 3` locally and one becomes `Extrude 4` once the server has put them in order. Whatever you did to your feature afterwards follows it to its new id; it is never applied to the other browser's feature.
- **A change that no longer fits** is dropped, with a notice: for example, you renamed a feature that the other browser deleted meanwhile. The notice says which change and why. Your work as it was just before is kept as a new **branch** of the document, named "Kept from sync" with the date and time (and a version named "Before sync changes" that the branch starts from), so nothing you made is lost: open it from the branches menu, and copy what you need back.
- **Two edits of one feature:** the later one wins whole.

**Undo** undoes your own last change, also after changes from elsewhere have arrived; changes from elsewhere are not on your undo stack. When a change of yours is dropped, the undo history is cleared, since the steps in it may build on it.

## Several tabs

When the same document is open in two tabs of one browser, one of them syncs it (the one that opened it first); the other says **Synced by another tab**, and keeps working as it always has with two tabs: saving in one makes the other offer to load the newer version (see [Files](files.md)). When the syncing tab closes, the other one takes over within a few seconds.

## When sync stops

**Sync stopped** means the server sent something that contradicts what it sent before (a change that does not apply to the document as the server itself described it). The app keeps the document as it is in this browser and sends nothing more. This should not happen with an intact server; if it does, keep a copy (**Export** on the home screen), untick and tick **Sync this document** again to start over from the server's copy with yours on top.

**Cannot sync** means the sync state saved in this browser with the document is damaged. The app does not fall back to an older copy of it: that copy could resend changes under numbers the server has already given to others. Your document is still there and saves as usual; untick and tick **Sync this document** to start over from the server's copy with this browser's on top.

## Tokens

A server knows two kinds of token:

- **Its own token** (`MANUFAKTURE_TOKEN`), the one you enter in the app: it may do everything, on every document. Keep it to yourself and your browsers.
- **Agent tokens**, for an AI agent's MCP server ([Working with an AI agent](agents.md)). You issue one with the server's token, for the documents it may work on, and revoke it the same way; the server keeps only a hash of it. An agent token reads those documents, all of them, other agent tokens' branches, logs and review bundles included, makes agent branches of them and writes only the branches it made, and only while they are open. It never writes Main or adds a version to it, never approves, rejects, requests changes, comments or merges, never writes a branch you approved or rejected, and reaches no other document and none of the server's other routes (documents, tokens, share links): the server answers all of that with a refusal. A revoked token is refused at once, its open connections end, and the start versions it made that no branch starts from are deleted. Each agent token has limits of its own (branches under way, versions, image bytes, review bundle bytes), and so does the server as a whole (all review bundles together). You can always delete an agent branch together with the versions agents made on it, and any version an agent made that no branch starts from (`DELETE /api/documents/<id>/versions/<version id>`, with the server's own token; [What one token may use](agents.md#what-one-token-may-use)).

For now, use agent tokens only with a server on the same machine as the agent, listening on localhost (the server's default); their use across a network waits for a security review.

## Privacy and safety

- The server sees the documents you sync, as they are. It is your server: nobody else does.
- The token travels with every request to the server, and nowhere else. It is kept in this browser's storage (as for share links), so anyone who can use this browser profile can use it.
- Each browser also keeps a random key per synced document, which proves to the server that a change comes from that browser's copy; it is stored with the document in this browser and never shown.
- Everything the server sends is checked by the app before it is used, like a file you import: a server cannot make the app hold an invalid document.

## Known limitations

- One server, one person: there are no accounts and no sharing of editing with others yet. Agent tokens are for your own agents, on localhost for now.
- When sync renames a feature (above) while its dialog is open, the dialog opens again on the new id, and what you had typed in it but not applied is lost; when the feature is gone, the dialog closes. Selected features follow the rename; selected faces, edges and vertices of that part studio are deselected.
- Changes made on a branch stay in the browser they were made in; only the branch itself (where it starts) is on the server. A version made on a branch stays in that browser too. Agent branches are the exception (above).
