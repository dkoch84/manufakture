# Sync

Sync keeps one document the same in several browsers: your laptop and your workshop PC, say, or two browser profiles. Every change you make is sent to **your own manufakture server**, and every change made elsewhere arrives in the open document within a moment, as if you had made it: the model regenerates and the feature tree updates.

Documents still live in your browser first. Sync adds to that; it replaces nothing. You keep working offline, and what you did is sent when the connection is back.

There is no hosted manufakture service: sync needs a server you run (the `apps/server` program; its README says how to run it). One server has one token and one user.

## Setting it up

1. Run the server and put it behind https (the server's README, "Routing `/api` to the server"), with `MANUFAKTURE_ORIGINS` set to the address of the app you use.
2. In the app, click **Sync** in the header (next to **Share**), enter the server's address (`https://...`, without `/api`) and its token (`MANUFAKTURE_TOKEN`), and click **Save server**.

This is the same server setting as for [share links](sharing.md#share-links): set it in either place and both use it. The address and the token are kept in this browser only, never in a document or a file. **Forget** removes them.

## Syncing a document

- **Start:** open the document, click **Sync**, tick **Sync this document**. The server gets a copy, and from then on every change goes there.
- **In another browser:** set the same server there, click **Sync**, then **Documents on the server**, and **Open here** next to the document. It is stored in that browser and opens, syncing.
- **Stop:** untick **Sync this document**. The document stays in this browser as it is; the server keeps its copy. Ticking it again later sends this browser's copy as one change on top of what the server holds.

If the server already has the document when you tick the box (you synced it before, or opened it in another browser), the app starts from the server's copy, and when this browser's copy differs it is put on top as one change, labelled "This browser's copy".

Only a document's main [branch](history.md) syncs. While another branch is open, the button says so; open the main branch to sync again.

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

## Privacy and safety

- The server sees the documents you sync, as they are. It is your server: nobody else does.
- The token travels with every request to the server, and nowhere else. It is kept in this browser's storage (as for share links), so anyone who can use this browser profile can use it.
- Each browser also keeps a random key per synced document, which proves to the server that a change comes from that browser's copy; it is stored with the document in this browser and never shown.
- Everything the server sends is checked by the app before it is used, like a file you import: a server cannot make the app hold an invalid document.

## Known limitations

- One server, one token, one person: there are no accounts and no sharing of editing with others yet.
- When sync renames a feature (above) while its dialog is open, the dialog opens again on the new id, and what you had typed in it but not applied is lost; when the feature is gone, the dialog closes. Selected features follow the rename; selected faces, edges and vertices of that part studio are deselected.
- The server's copy has no named versions or branches of its own; those stay in each browser.
