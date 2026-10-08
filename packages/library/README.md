# @manufakture/library

The document library: local-first storage (ADR 0004 decision 8, product decision 1) of documents,
their revisions and command log, named versions, branches, merging, and `.mfk` files. The JSON
document is the source of truth, and everything derived is rebuilt by regen. The user's view is in
[docs/user/files.md](../../docs/user/files.md).

It runs on any `StorageBackend`. The app gives it the browser's storage (OPFS, else IndexedDB;
`apps/web/src/persistence/`, which also holds autosave and the restore of reference imports). In
Node it runs on a directory (`@manufakture/library/node`, "Node" below), for headless sessions,
tests and CI.

```ts
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend, NodeBranchLocks } from '@manufakture/library/node';

const library = new DocumentLibrary(new NodeBackend('/srv/library'));
const lock = await new NodeBranchLocks('/srv/library').acquire(docId, branchId, sessionId);
if (!lock) throw new Error('Another session works on that branch.');
const opened = await library.open(docId, branchId);
```

| File               | What                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `backend.ts`       | `StorageBackend`: read, write, remove, removeTree, list on slash paths. `MemoryBackend` for tests.            |
| `blobs.ts`         | The storage form of imported files, user fonts and pinned versions: content-addressed blobs, checked on load. |
| `library.ts`       | `DocumentLibrary`: list, open, save, rename, duplicate, delete, versions, branches, replay, merge, `.mfk`.    |
| `mfk.ts`           | Packing and unpacking `.mfk` zips, with limits and a bounded inflate (`./mfk`, loaded on first use).          |
| `limits.ts`        | The `.mfk` file size limit, checked before a picked or dropped file is read.                                  |
| `walk.ts`          | One walk over plain JSON, to find (`visitJson`) or rewrite (`mapJson`) what a document holds.                 |
| `locks.ts`         | Branch locks (`BranchLocks`): one holder per branch. `MemoryBranchLocks` within a process.                    |
| `node.ts`          | `./node`: `NodeBackend` on a directory, `NodeBranchLocks` as lock files across processes.                     |
| `test-fixtures.ts` | `./test-fixtures`: documents and backends for tests, the app's included.                                      |

## Layout

```
documents/<id>/head.json              pointer: current revision, its SHA-256, name, dates, sizes,
                                      `versions: <n>`, the current version list (0: none), and
                                      `branches: <n>`, the current branch list (0: none)
documents/<id>/snapshot-<rev>.json    the document at revision <rev>, storage form
documents/<id>/log-<rev>.json         the commands from the previous revision to <rev>
documents/<id>/versions-<n>.json      the named versions, the n-th write of the list
documents/<id>/branches-<n>.json      the branches besides main, the n-th write of the list
documents/<id>/sync-<n>.json          the sync state (T7.1d), the n-th write, for the revision it names
documents/<id>/remote-<v>.json        the document of version <v> kept from the sync server (T7.1e)
documents/<id>/branches/<b>/head.json, snapshot-<rev>.json, log-<rev>.json, damaged-*
                                      branch <b>: its own head, snapshots and log
documents/<id>/blobs/<sha256>         each imported file, user font and pinned version, once
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
is refused at once, without trying older ones; the failure carries `newer: true` (as does
`importMfk`'s for a newer `.mfk`), so the home screen offers to update the app. If the chosen
revision is not the head's (a crash between steps 4 and 5, or a torn head), the head is
rewritten. Recovery deletes only logs and
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
what the source's `sha256` and `size` describe. An assembly instance of a pinned part carries the
same source (core README, "Assemblies") and is stored the same way; instances have no `kind`, so
`blobs.ts` knows a pinned source by its shape (`documentId`, `versionId`, `partId`), wherever it
sits: in an assembly, an `addInstance`, the `source` of an `editInstance`, or a document a
`replaceDocument` carries. So each pinned version is one blob per document, however many derived
features, instances, snapshots and commands pin it, and loading checks it like a file. A document
stored with an instance's pin inline (before instances moved out) needs no blob and loads as it
is; its next save moves the pin out.

A font the user added to a document (core README, "Fonts"; since format version 9) is stored like
an imported file: the entry in `fonts` (`{ id: 'font#n', family, style, source: { kind: 'file',
fileName, size, sha256, data } }`) loses `data`, and the font file's bytes go to `blobs/<sha256>`,
checked against `size` and `sha256` on load ("The font file Label.otf is damaged"). `blobs.ts`
knows one by its id (`font#n`) and its `file` source, wherever it sits: in the document's `fonts`,
or in a logged `addFont` or `restoreFont`. A bundled font (`source.kind: 'bundled'`) holds no
bytes and has no blob.

The log is what `DocumentStore` reports: one entry per `execute`, `undo` and `redo`, as
`{ cause, label, command, at }`. Commands go through the same rewrite, so an `addFeature` of a
20 MiB import is logged by reference to the blob the snapshot already has. Blobs are kept for the
life of the document, since logged commands can name a file the current snapshot no longer holds.
`readLog(id)` returns the committed log with the files put back (and checked).
`readHistory(id)` returns the same chain per revision with only each entry's `cause`, `label` and
`at`, without reading any blob: the history panel's timeline (`apps/web/src/history/`). A restore is logged
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

A branch an agent session made also carries `provenance` ("Agent branches" below); a branch
without it is a person's.

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

## Agent branches

An agent never writes main: a headless session works on a branch of its own
([docs/plans/agent-surface.md](../../docs/plans/agent-surface.md), decisions 2 and 3). Who made
such a branch is library data in the branch record, not document format, so there is no format
bump:

```json
{
  "id": "...",
  "name": "...",
  "fromVersion": "...",
  "createdAt": "...",
  "provenance": {
    "origin": "agent",
    "sessionId": "<a storable id>",
    "clientName": "<what the client calls itself>",
    "review": "open"
  }
}
```

`review` is one of `REVIEW_STATES`: `open`, `submitted`, `changes-requested`, `approved`,
`rejected`. `clientName` is self-reported, so it is shown and never trusted: 1 to
`MAX_CLIENT_NAME` (200) characters, not padded, no control or format characters (Unicode Cc and
Cf, so no bidi overrides or zero-width marks) and no lone surrogates. `parseProvenance` checks
all of it and keeps only these four fields; it accepts any review state, since it reads stored
branches. A new branch (`createBranch`, `branchFromRevision`) is made only in review state
`open`. A branch record whose provenance does not check does
not read at all (the list is then damaged, and read as any damaged list is): a damaged
provenance never turns an agent's branch into a person's. A list written before provenance
existed reads unchanged, and a release that does not know the field reads a list with it as
before (it drops the field if it writes the list again).

Forward compatibility is strict, though: a review state added later is unknown to this release,
so a branch record holding one does not read, the whole list counts as damaged, and this release
falls back to the spare list (an older branch list) or to none. A new review state therefore
needs every release that may open the library to know it first, or a format change.

- `createBranch(id, fromVersion, name, { provenance })` makes an agent branch; provenance that
  does not check is refused before anything is written. `adoptBranch` (sync) keeps none yet.
- `setBranchReview(id, branch, review)` changes the review state, as a new branch list committed
  like a rename. Main and a person's branch have none. The library does not check who asks: its
  callers (the review UI, T8.3b; the session server, T8.4b) decide who may, and an agent must
  never reach it for its own branch. `adoptBranch` does not carry provenance yet (T8.4b).
- `branchFromRevision(id, { from, revision, version, name, provenance })` makes a branch from any
  stored revision of a branch (default: main's head), through a version of that revision named
  `version` (branches start from versions): that is how a session starts ("Agent session `<id>`
  start"). A version of an older revision records the SHA-256 of its retained snapshot. When that
  snapshot is no longer kept (or does not read), the revision is rebuilt by replay
  (`readRevision`) and written as `snapshot-<rev>.json` in storage form first, its blobs stored as
  a save stores them (a snapshot there that does not read is copied aside as
  `damaged-snapshot-...` first); the version records that file's SHA-256. So pruning keeps it as a
  named revision, and `readVersion` reads its bytes directly, not depending on the log or on the
  storage form staying what it was (a hash of a replay would stop matching after any format
  change). A crash before the version is committed leaves an extra snapshot below the head, which
  the next save prunes. The name, the provenance and the free branch slot are checked before the version is
  made; a branch that still cannot be made leaves the version (versions are kept for good), and
  the message says so.

A revision named this way must be one of the branch's, an integer from 1 to its head: it is
checked before any file name is made of it.

### The export gate

`exportAllowed(branch)` (M8 plan T8.3c, ADR 0016 decision 12) says whether a fabrication file may
be made from a branch, given its record as `listBranches` lists it: yes for main and a person's
branch, and for an agent's branch in review state `approved`; no for an agent's branch in any other
state, with `UNREVIEWED_EXPORT` ("This is an agent's unreviewed branch. Review it in History
first."), and no (`UNKNOWN_EXPORT_SOURCE`) for a missing or malformed record. The rule itself is
`@manufakture/io`'s `exportAllowed`, since every package with a fabrication entry point depends on
`@manufakture/io` and this one does too; the library exports the same function typed for `Branch`.
Every entry point takes the branch as a required `source` and refuses before it does any work (io
README, "Fabrication exports").

A version of main can record the review its work came from: `createVersion(id, { name, review })`
with a `ReviewReference` (`branch`, the agent branch's id; `sessionId`; `clientName`;
`bundleRevision`, the head revision the approved bundle was built at, so the bundle is
`review-<bundleRevision>.json` in that branch's directory; `label`, the merge's label). Approving
in History (T8.3b) writes it after the merge. Only main's versions take one; it is checked as
provenance is (ids, a client name and a label of at most `MAX_REVIEW_LABEL` characters with no
control or format characters), a damaged one makes the version list read as damaged, and an
imported `.mfk` keeps none (a review recorded in another library is not this one's). An older
release reading the list drops the field, as it drops any field it does not know.
`reviewOf(id, revision?)` reads it back: the latest version of main at or before `revision`
(default: main's head) that records a review, with its reference, or null when main's work there
is a person's. `library-export-gate.test.ts` covers the gate over every review state and a merge,
the reference round trip and its checks, and the revision check.

`library-agent.test.ts` covers provenance round trips, old lists, damaged provenance, review
states (and that a new branch starts `open`), client names with format characters or lone
surrogates, branching from kept and rebuilt revisions of main and of a branch, reading those
versions back after more saves (and after the log segments a rebuilt one came from are gone), and
merging such a branch into main.

## Node

`@manufakture/library/node` (kept out of the package root, so no browser build reaches
`node:fs`):

- `NodeBackend(root)`: the library's files under a directory, the same layout as in the browser
  (`documents/...`). Every path goes through `confinedSegments`: `segments` (no empty segment, no
  `.` or `..`, so no absolute path), and no backslash, NUL or colon in a segment, so no segment is
  a path of its own on any platform; the joined path is checked to be under the root once more.
  It behaves as `MemoryBackend` does: a directory exists only while a file is under it (emptied
  ones are removed, and `list` leaves out empty ones a crash left), a directory is no file and a
  file no tree. Writes are plain `writeFile`, not atomic, which the library never relies on.
  Symbolic links are not listed; one planted inside the root by someone who can write there is
  followed by reads and writes.
- `NodeBranchLocks(root, { staleAfterMs, heartbeatMs })`: one holder per branch across processes,
  as `locks/<document id>/<branch>.lock` beside `documents/`, created with `O_EXCL`, so of two
  processes asking at once exactly one gets it; `acquire` never waits, and returns null while
  another holder has it. The file records a unique token, host, pid, the process's start time and
  the holder's name (`holder(id, branch)` reads it). A holder refreshes its file's time every
  `heartbeatMs` (30 s; the timer never keeps the process alive) and checks its token, so
  `held()` turns false and `release()` does nothing once its lock was broken. A lock is stale, and
  broken by the next `acquire`, when its process is gone:
  - a record of this machine: its pid no longer runs, or runs a process that started at another
    time than the record says (containers reuse pids). The start time comes from /proc on Linux
    (`linuxProcessStart`: boot time plus field 22 of `/proc/<pid>/stat`), the same value the
    holder recorded, within 2 s. While the process runs, the lock is never broken by age: a hung
    holder keeps it until it is killed. Where the start time cannot be read (no /proc), a live
    pid is taken for the holder.
  - a record of another machine (a shared directory), or a file that does not read as a record
    (a pid that is not a positive safe integer included, so no pid of 0 or below is ever
    signalled): nobody refreshed it for `staleAfterMs` (2 minutes). This compares the file's time, set by the
    other machine or its file server, with this machine's clock, so clocks more than
    `staleAfterMs` apart break a live lock (or keep a dead one longer); keep the machines' clocks
    in sync.

  Breaking happens under a `.lock.break` file made the same exclusive way (itself stale after
  10 s). The lock is opened once, and its bytes (at most 4 KB read; a longer file is no record)
  and time come from that one handle (opened without blocking, so a FIFO planted there does not
  hang it). Just before the unlink the path is checked again (`lstat`): only when it is still the
  same file (device, inode, times) is it removed; otherwise (another breaker took over a break it
  thought dead, broke the lock and took it) this one gives up. An old `.break` is removed
  under the same check, and a breaker removes only its own. So two processes breaking at once
  cannot both end up holding it, nor one remove the lock the other just took.

- Ids are checked (`isStorableId`, `isBranchId`), but on a case-insensitive file system (macOS and
  Windows by default) ids differing only in case name the same files: two such branch ids share
  one lock, and two such document ids one directory. The ids the library makes are lowercase
  UUIDs, so this only matters for ids given from outside.

The library's own document locks (`DocumentLocks`, one operation at a time) default to the Web
Locks API, which Node 22 and later also has, within one process. Two processes on one directory
then work as two browser tabs without Web Locks do: every save checks the head again before its
commit (`RevisionConflict`), and one writer per branch is the branch lock's job.

`node.test.ts` tries path traversal in every operation (`..`, absolute paths, backslashes, NUL,
drive letters), the directory rules, and the locks: two holders, many at once, two instances on
one directory, dead and live processes (a real child process; an old file never breaks a live
one), a reused pid (by start time, and the start time read from /proc), another machine's lock, a
torn lock file, an oversized one and a FIFO, a broken holder's release, the heartbeat, a break
left by a crash, two breakers of one stale lock (one stalled between its read and its unlink by
the `beforeBreak` hook), and a lock written again after it was judged.

### Tests on every backend

The library's suites run twice: in the `packages` test project on `MemoryBackend`, and in the
`library-node` project (root `vitest.config.ts`) on `NodeBackend`, each test in a new temporary
directory: its setup file (`test-node-setup.ts`) points `newBackend` and `cloneBackend` in
`test-fixtures.ts` at directories on disk, with a `files` map the tests read and damage files
through. `pnpm --filter @manufakture/library test` runs both.

## Sync

A document that syncs ([docs/user/sync.md](../../docs/user/sync.md), `apps/web/src/sync/`) keeps its
sync state beside its snapshots: `sync-<n>.json`, the `n`-th write, named by the **main** head's
`sync: n` (0 or absent: the document does not sync; branches never sync). It holds the server's
address (never the token), the client key the browser proves its client id with, the server's
last confirmed document in storage form (files as blobs), and `SyncClient.save()` (packages/sync
README, "The saved queue state") with its files as blobs too, plus `revision`: the revision it was
saved with.

```json
{
  "format": "manufakture-sync",
  "id": "<document id>",
  "generation": 4,
  "revision": 12,
  "server": "https://...",
  "clientKey": "...",
  "confirmed": { "...": "the confirmed document, storage form" },
  "state": { "...": "SyncQueueState" }
}
```

The state and the document must never come from different revisions: a queue paired with an older
document would resend entries the document already shows, and a newer document with an older
queue would hold changes the server never gets. So both are committed by one head:

- `save(doc, entries, main, sync)` writes `sync-<n+1>.json` after the log segment and before the
  snapshot, and the head names both (step 5 above). Autosave passes the state whenever the
  document syncs, taken when the save starts, together with every change made up to then.
- `saveSync(id, sync)` writes the state alone for the revision the head names, when nothing waits
  to be saved (the sync loop checks that first): `sync-<n+1>.json`, then the head naming it, as for
  a list. It is how the loop saves before it sends.
- `readSync(id)` reads what the head names and says whether it was saved with the head's
  revision (`paired`). A save without the state (another tab, an older release) leaves an older
  state; the loop then puts this browser's document on top as one change. When the file the head
  names cannot be read, `readSync` fails (the sync status shows "Cannot sync"); it never falls back
  to the spare: an older queue would hand out `clientSeq` values the server has already accepted
  from the newer one. Switching sync off and on starts over from the server's copy.
- The record may carry `uploads` (T7.1e): versions and branches made here that wait for the
  server, each version with the server revision it names once known (`rev`) or the queue entry
  whose landing tells it (`after`). Saved with the state, so a reload does not lose them.
- `dropSync(id)` commits a head naming none, then deletes the files.

Crash rules are those of the lists: a sync file above the head's is what a save that died left,
deleted by the next open or save; after a commit the one before stays as the spare. Recovering a
torn head takes the newest sync file whose `revision` is the revision recovered, so a crash
between the snapshot and the head finds the new pair, and one before the snapshot is complete the
old pair. `library-sync.test.ts` crashes a save with state and a `saveSync` at every step, clean
and torn, and checks the reopened document and state are the old pair or the new pair.

### Versions and branches from the server

T7.1e (`apps/web/src/sync/records.ts`). A version the server has and this browser does not is kept with
`adoptVersion(id, remote, document)`: its document goes to `remote-<version id>.json` in the main
directory (storage form, files as blobs), and its record to the version list with `revision: 0`
and `serverRev` (the revision of its branch's server log), committed like any version. Revision 0
names no revision here; `readVersion` reads the remote file instead and checks it against
`snapshotSha256` as usual. Such a version can be viewed, restored, pinned and branched from;
merging a branch made from one is refused with a message (the history before it is not here). An
`.mfk` export carries it, and an import makes it a revision of main and drops `serverRev`.
`adoptBranch(id, branch)` makes a branch the server has from its version, under the server's id
and time (a taken name gets " (2)", " (3)", ...); a branch already here is returned as it is.

`readVersion` asks `setRemoteVersions(source)` (the sync controller sets it) for a version that is
not here, outside the queue and the lock; the answer must be of that document and version, and is
kept with `adoptVersion` when the document is here.

`subscribe(listener)` reports `{ id, kind: 'versions' | 'branches' }` after this library changed a
document's versions (made, renamed, adopted) or branches (made, renamed, deleted, adopted); other
tabs' changes are not reported. The sync controller uses it to find versions and branches to
upload, and the History panel and the branch switcher to read their lists again.
`library-remote.test.ts` covers all of it.

A change from the server reaches the document store as a `remote` change (core `DocumentStore`
`applyRemote`), which autosave logs as an `execute` of `replaceDocument` with the whole new
document: a rebase is not one command, and replay must reproduce the revision.

## Not done

- **A persistent tier for the regen cache.** Cached B-rep and meshes stay in the worker's memory;
  a reload regenerates from the document. The layout leaves room for `documents/<id>/cache/`.
- **Merging two tabs' changes.** A conflict is resolved by picking one version (or keeping both
  as separate documents), not by replaying one tab's commands onto the other's.
- **Pruning.** Blobs and log segments are never pruned while the document exists, and retained
  snapshots (checkpoints, versions) grow with the history; the storage estimate is shown.
