# Persistence

Local-first storage (ADR 0004 decision 8, product decision 1): documents live in the browser, the
JSON document is the source of truth, and everything derived is rebuilt by regen. The user's view
is in [docs/user/files.md](../../../../docs/user/files.md).

| File          | What                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `backend.ts`  | `StorageBackend`: read, write, remove, removeTree, list on slash paths. `MemoryBackend` for tests.  |
| `opfs.ts`     | The Origin Private File System backend, probed before use.                                          |
| `idb.ts`      | The IndexedDB fallback (one object store, path to bytes).                                           |
| `storage.ts`  | Picks OPFS, then IndexedDB, then memory; storage estimate and `persist()`.                          |
| `blobs.ts`    | The storage form of imported files and pinned versions: content-addressed blobs, checked on load.   |
| `library.ts`  | `DocumentLibrary`: list, open, save, rename, duplicate, delete, versions, branches, replay, `.mfk`. |
| `mfk.ts`      | Packing and unpacking `.mfk` zips, with limits and a bounded inflate (loaded on first use).         |
| `limits.ts`   | The `.mfk` file size limit, checked before a picked or dropped file is read.                        |
| `autosave.ts` | Records the command log per document, saves after edits pause, retries failures, names versions.    |
| `imports.ts`  | Reads reference imports again when a document opens (loaded on first use).                          |
| `url.ts`      | The open document, branch and part studio in the page URL (`?doc=<id>&branch=<id>&part=<id>`).      |

## Layout

```
documents/<id>/head.json              pointer: current revision, its SHA-256, name, dates, sizes,
                                      `versions: <n>`, the current version list (0: none), and
                                      `branches: <n>`, the current branch list (0: none)
documents/<id>/snapshot-<rev>.json    the document at revision <rev>, storage form
documents/<id>/log-<rev>.json         the commands from the previous revision to <rev>
documents/<id>/versions-<n>.json      the named versions, the n-th write of the list
documents/<id>/branches-<n>.json      the branches besides main, the n-th write of the list
documents/<id>/branches/<b>/head.json, snapshot-<rev>.json, log-<rev>.json, damaged-*
                                      branch <b>: its own head, snapshots and log
documents/<id>/blobs/<sha256>         each imported file and pinned version, once
documents/<id>/damaged-snapshot-<rev>-<sha>.json, damaged-log-<rev>-<sha>.json
                                      a complete snapshot that did not read, and its log, kept aside
```

`<rev>` and `<n>` are zero-padded to eight digits. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`; the app
makes UUIDs, and an imported `.mfk` with any other id gets a new one.

## Crash safety

Neither OPFS nor IndexedDB is assumed to write atomically, and there is no rename in OPFS in every
browser, so nothing is ever overwritten in place that a pointer names. With the head at revision
`n`, a save:

1. deletes logs and snapshots above `n`: what an earlier save that failed left behind (the same
   library retrying, say, after a full disk), so each command is logged once;
2. writes the blobs the document and the logged commands need that are not already stored and
   matching their hash (a blob cut short by a crash does not match, so it is rewritten);
3. writes `log-<n+1>.json`, when there are commands, with `base: n`;
4. writes `snapshot-<n+1>.json`;
5. writes `head.json` naming revision `n + 1` and the snapshot's SHA-256: the commit;
6. deletes snapshots older than `n` (best effort; `n`, the previous commit, stays as the spare),
   except the history: every revision a version names, every checkpoint (below), the lowest
   retained snapshot (where the history starts), and a revision whose log segment starts a
   history (`base: null`, see "Versions in `.mfk` files"). When the version list cannot be read,
   nothing is deleted (logged).

Step 1 also deletes version lists above the one the head names: what a version change that died
left behind.

A save over an unreadable head first recovers the head from the snapshots, then goes on as above.
Opening takes the newest snapshot that reads completely: the JSON parses, the document migrates and
validates, and every blob it needs matches its SHA-256 and size. The snapshot the head names is
used when it reads, even if its SHA-256 differs from the head's (logged, and the head corrected):
it is a whole document, and falling back could drop real work. A snapshot written by a newer app
is refused at once, without trying older ones. If the chosen revision is not the head's (a crash
between steps 4 and 5, or a torn head), the head is rewritten. Recovery deletes only logs and
snapshots above both the head and the chosen revision: never the snapshot the head names, nor
anything below it. A snapshot passed over because it is complete (its JSON parses) but does not
read as the document (a missing blob, a validation a later release adds, another document's id)
is first copied, with its log segment, to `damaged-snapshot-<rev>-<sha>.json` and
`damaged-log-<rev>-<sha>.json` (the first 16 hex digits of its SHA-256), which no snapshot or log
pattern matches: the next open or save then deletes the original above the head, and the copies
stay until the document is deleted. A missing, empty or torn snapshot is not copied. The list reads heads only, so it is fast, and never writes: a document without
a readable head is described from its newest readable snapshot (and repaired when opened), and one
that cannot be read at all is listed as damaged (so it can be deleted).

A version list follows the same rule (below): the head is its pointer too. When the head is
missing or torn, recovery takes the newest `versions-<n>.json` that reads, and deletes the ones
above it; so does a save when no snapshot reads either. A save checks, just before writing the
head, that the head still names the same revision, snapshot and version list, so without Web
Locks a version another tab named meanwhile is never dropped.

`readLog` follows the chain back from the head (each segment's `base`; a revision without a
segment was saved without commands, from the one before), and refuses a segment of the wrong shape.

## Several tabs

Every operation on a document (open, save, rename, duplicate, export, delete, import under its id)
holds the Web Lock `manufakture-document-<id>`, so two tabs never interleave a document's files;
where Web Locks are missing the library runs without them. The library remembers the revision it
last opened or saved per document, and a save refuses with `RevisionConflict` when the head has
moved past it (another tab saved), writing nothing; it looks again just before writing the head,
for browsers without locks. A save of its own that failed after writing its snapshot is recognised
by that snapshot's SHA-256 and is not a conflict; when that save had in fact committed (the head
write landed, then threw), the retry leaves out the log entries already written with it, so each
command is logged once. Autosave does not retry a conflict: the status
says `conflict`, and the app offers to open the stored version or save this tab's as a copy
(`saveCopy`).

`library.test.ts` crashes a save at every step, cleanly and with a torn write, then reopens the
store with a new library and checks the document is the old or the new one and that the next save
works; it does the same for every step of `createVersion`, checking the version list is the old
or the new one.

## Named versions

A version names a stored revision for good: `{ id, name, description, revision, snapshotSha256,
createdAt }`. Its id (a UUID) is permanent and never reused, so other documents can pin it
(`documentId` plus `versionId`, plan decision 8); versions are storage, not document shape, and
the file format does not change for them. `createVersion(id, { name, description })` names the
revision the head names; autosave's `createVersion` saves what is pending first (and stores a
document that never was), so a version is always of what the user sees. `listVersions`,
`renameVersion` and `readVersion` go with it. There is no delete: a pinned copy lives in the
documents that derive from it anyway.

The list is one file, rewritten whole on every change:

```json
{
  "format": "manufakture-versions",
  "id": "<document id>",
  "generation": 3,
  "versions": [
    {
      "id": "...",
      "name": "...",
      "description": "",
      "revision": 12,
      "snapshotSha256": "...",
      "createdAt": "..."
    }
  ]
}
```

A change writes `versions-<n+1>.json` (generation `n + 1`), then the head with `versions: n + 1`
(the commit), then deletes the lists before `n` (best effort): list `n` stays as the spare. A
crash before the head leaves the old list (the new file lies above the head, and the next open or
save deletes it); a torn head is recovered from the newest list that reads, which is the new one.
Without Web Locks another tab can delete the new list as stale between its write and the head
naming it; a head that names a missing list is then read from the newest older list that reads
(the spare), no snapshot is pruned while that is so, and the next version change writes a whole
list above it. Only the version named in that race is lost, never the ones before. Every record is checked field by
field when read (and a list that would not read back is never written): names are trimmed, 1 to
200 characters; descriptions at most 2000; ids unique; revisions positive; the SHA-256 a hash.

`readVersion` reads the version's snapshot and checks it against the SHA-256 the version
recorded. When the snapshot is gone or changed, the revision is rebuilt from the log (below) and
the rebuilt storage form must match that SHA-256 instead; otherwise the version is reported
damaged.

## Checkpoints and replay

Besides the head and the spare, a save keeps the snapshot of every revision `1 + k *
CHECKPOINT_EVERY` (`CHECKPOINT_EVERY` is 64: revisions 1, 65, 129, ...) and of every revision a
version names. So any revision is at most 63 log segments from a retained snapshot.

`readRevision(id, rev)` takes the nearest retained snapshot at or below `rev` that reads, then
replays each later revision's log segment through core `applyCommand` (a revision without a
segment was saved without commands, and is its predecessor unchanged). Where a retained snapshot
lies on the way (with `{ from }`, the replay starts at a given retained snapshot, a checkpoint say,
and passes others), the replay is compared with it: by the SHA-256 of its storage form, and, for a
snapshot an older format wrote, by canonical `serialize` of the two. A mismatch, or a logged
command that no longer applies, is logged and the replay goes on from the snapshot (the result
lists it in `mismatches`); with no snapshot to go on from, the read fails and says where. This is
the mitigation for a later release changing what a command does: replay only ever runs between a
snapshot and the revision asked for.

`historyStart(id)` is the oldest retained snapshot that reads. A document saved before
checkpoints existed kept only its last two snapshots, so its history starts at the older of those,
which is then kept for good as the lowest retained snapshot.

## Versions in `.mfk` files

An export that would hold more entries than an import reads (`MFK_LIMITS.maxEntries`) is refused
with a clear message rather than written. `exportMfk(id, { versions: true })` adds `manifest.json` (`{ "format": "manufakture-manifest",
"versions": [...] }`, the records with each `snapshotSha256` that of its entry) and
`versions/<version id>.json`, each version's document in storage form; their blobs go in
`blobs/` with the document's. Import treats all of it as outside input and refuses the whole file
on any fault: every record is checked as above, each must have its entry, the entry must match its
SHA-256, read as a document (blobs checked, migrated, validated) and belong to the imported
document. It then stores each version's document as a revision of its own (1, 2, ...; versions
with identical documents share one), oldest first, the document itself as the newest, then the
version list and the head. Version ids, names, descriptions and dates are kept, so pins in other
documents still match; revisions and SHA-256s are this store's. Each of those revisions gets an
empty log segment with `base: null`, which says no logged history leads to it, so replay never
crosses from one imported revision into the next; step 6 keeps them. An import that dies before
its head is written is recovered from its snapshots like any document, possibly without its
version list.

## Blobs and the command log

An `import` feature keeps its file inline, as base64, in the document (core README, "Imported
geometry"); in memory nothing changes. In storage and in `.mfk` files each import's `source` loses
`data`, and the bytes go to `blobs/<sha256>` (`externalize`, `hydrate` in `blobs.ts`). This is a
storage form, not a new file format version: `document.json` is a document with `source.data`
left out, and a plain document with the data inline is accepted too.

A `derived` feature (core README, "Derived parts") is stored the same way: its `source.data` is
the pinned version's document as JSON text, and the blob is that text's UTF-8 bytes, which is
what the source's `sha256` and `size` describe. So each pinned version is one blob per document,
however many derived features, snapshots and commands pin it, and loading checks it like a file.

The log is what `DocumentStore` reports: one entry per `execute`, `undo` and `redo`, as
`{ cause, label, command, at }`. Commands go through the same rewrite, so an `addFeature` of a
20 MiB import is logged by reference to the blob the snapshot already has. Blobs are kept for the
life of the document, since logged commands can name a file the current snapshot no longer holds.
`readLog(id)` returns the committed log with the files put back (and checked).
`readHistory(id)` returns the same chain per revision with only each entry's `cause`, `label` and
`at`, without reading any blob: the history panel's timeline (`src/history/`). A restore is logged
as a core `replaceDocument` command carrying the whole document, with its files by reference like
any other command.

## Branches

The document's own directory is its **main** branch (`MAIN_BRANCH`, `"main"`), so a document saved
before branches existed is its main branch with no migration, and a URL without `branch` opens it.
Every other branch lives in `branches/<branch id>/` (a UUID) with its own `head.json`,
`snapshot-<rev>.json` and `log-<rev>.json`, under exactly the rules above: its own revision
numbers (starting at 1), checkpoints, spare, replay, recovery and quarantine. A branch's head
names no lists (`versions` and `branches` are 0 there). What the branches share is the
document's: `blobs/` (blobs are never pruned, so no branch can lose one another needs), the
version list, and the branch list, both committed by the **main** head.

Every operation that reads or writes one branch takes it as an argument, and without one it is
the main branch: `open(id, branch)`, `save(doc, entries, branch)`, `readHistory`, `readLog`,
`readRevision` (`{ branch }`), `historyStart`, `createVersion`, `rename`, `duplicate` and
`exportMfk` (`{ branch }`). The library keeps no "current branch": the app does, and passes it.
Autosave records the branch with each change when the change is made (its `branch` option, read
from the app) and saves and names versions on that branch, so an edit made while the app switches
branches lands on the branch it was made on, and an edit on a branch deleted meanwhile is refused
(`BranchDeleted`) rather than saved onto main. The home screen acts on the main branch of any
document, except the open one, which it duplicates as it is open. `listVersions(id)` lists
every branch's versions (a version records its branch, and `readVersion` reads from it, so a pin
needs no branch); `listVersions(id, branch)` filters. The revision known per tab
(`RevisionConflict`) is kept per branch, so saving one branch never conflicts with another tab
saving a different one. A failure because the branch is not there carries `noBranch: true`, and
never repeats the branch id it was given (it may come from a URL).

What it costs: an operation on a branch other than main also reads the main head and the branch
list (to check the branch exists), and its save reads the version list (to keep the snapshots
its versions name) and checks the branch list a second time just before writing its head (for
browsers without locks, where another tab may have deleted the branch meanwhile; the save then
throws `BranchDeleted` and its head is never written), so a branch save does a handful more
small reads than a save of main, and no more writes.

The branch list, `branches-<n>.json`, follows the version list's rule exactly (a new file, then
the main head naming it, the list before kept as the spare; recovery from a torn head takes the
newest list that reads):

```json
{
  "format": "manufakture-branches",
  "id": "<document id>",
  "generation": 2,
  "branches": [{ "id": "...", "name": "...", "fromVersion": "<version id>", "createdAt": "..." }]
}
```

A branch exists only while the committed list names it: `open`, `save` and the other operations
refuse a branch it does not name, and a save to one that another tab deleted throws
`BranchDeleted` (a `RevisionConflict`, so autosave shows the conflict and the tab can keep its
version as a copy). Names are trimmed, 1 to 200 characters, unique, never "Main"; at most
`MAX_BRANCHES` (100) besides main.

- `createBranch(id, fromVersion, name)` reads the version (of any branch, checked against its
  SHA-256), then writes, in order: the branch's directory (deleting whatever an earlier attempt
  left there), its `snapshot-00000001.json` (blobs are already stored), its `head.json`, then the
  branch list `n+1`, then the main head naming it (the commit). A crash before the commit leaves a
  directory no list names: never opened, and deleted by the next `createBranch` or `deleteBranch`
  (`#dropOrphans`, skipped when the list was read from the spare, where a real branch could look
  unnamed). The new branch's history starts at revision 1, with no log leading to it.
  Without Web Locks another tab's branch change could take the new directory for an orphan
  between its writes and this commit; so after the commit the branch's head is read again, and
  the snapshot and head are written again when it is gone. Orphan cleanup also never deletes a
  directory that a version names, whatever the branch list says (it may be lost: see below), and
  deletes nothing when the version list cannot be read.
- `renameBranch(id, branch, name)` writes a new list and commits it.
- `deleteBranch(id, branch)` commits a list without it, then removes its directory (best effort;
  a leftover directory is an orphan as above). Main cannot be deleted or renamed. A branch that a
  version names cannot be deleted: versions are kept for good and other documents may pin them.
- `listBranches(id)`: main first (`MAIN_BRANCH_NAME`, "Main"), then the list, oldest first.

The per-document Web Lock covers every branch: one lock name per document, so a save on one
branch and a branch change on another never interleave. A crash on one branch writes nothing in
another's directory, and a branch save writes nothing in main's except new blobs; a branch change
writes only the list and the main head, whose revision and snapshot stay the same.
`library-branches.test.ts` crashes a branch save, a main save, `createBranch`, `renameBranch`,
`deleteBranch` and `createVersion` on a branch at every step, cleanly and torn, and checks that
every other branch is byte for byte as it was, the crashed one is its old or its new state, and
the next change works; it saves two branches alternately past two checkpoints and reads every
revision of each back; it races a branch save against a delete in another tab without locks; and
it opens, versions and branches a document whose head was written before versions and branches
existed, checking that reading it rewrites nothing.

`.mfk` export is of one branch's document (`exportMfk(id, { branch })`); with `versions`, the
versions of every branch go in, and an import stores them all as revisions of main (the `branch`
field is dropped). Branches themselves are not exported. Merging is not done (it needs the op-log
replay that sync brings); restoring a version of one branch on another (`replaceDocument`) is how
work moves between them.

A release from before branches reads a document with branches as its main branch, and ignores
the `branches` field of the head; if it saves the document, it writes a head without it, so the
branches are no longer listed (their directories stay; the next branch change deletes those no
version names, and keeps the others so their versions still read).

## Not done

- **A persistent tier for the regen cache.** Cached B-rep and meshes stay in the worker's memory;
  a reload regenerates from the document. The layout leaves room for `documents/<id>/cache/`.
- **Merging two tabs' changes.** A conflict is resolved by picking one version (or keeping both
  as separate documents), not by replaying one tab's commands onto the other's.
- **Pruning.** Blobs and log segments are never pruned while the document exists, and retained
  snapshots (checkpoints, versions) grow with the history; the storage estimate is shown.
