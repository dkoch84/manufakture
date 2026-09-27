# Persistence

Local-first storage (ADR 0004 decision 8, product decision 1): documents live in the browser, the
JSON document is the source of truth, and everything derived is rebuilt by regen. The user's view
is in [docs/user/files.md](../../../../docs/user/files.md).

| File          | What                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `backend.ts`  | `StorageBackend`: read, write, remove, removeTree, list on slash paths. `MemoryBackend` for tests. |
| `opfs.ts`     | The Origin Private File System backend, probed before use.                                         |
| `idb.ts`      | The IndexedDB fallback (one object store, path to bytes).                                          |
| `storage.ts`  | Picks OPFS, then IndexedDB, then memory; storage estimate and `persist()`.                         |
| `blobs.ts`    | The storage form of imported files: content-addressed blobs, checked on load.                      |
| `library.ts`  | `DocumentLibrary`: list, open, save, rename, duplicate, delete, `.mfk` export and import.          |
| `mfk.ts`      | Packing and unpacking `.mfk` zips, with limits and a bounded inflate (loaded on first use).        |
| `limits.ts`   | The `.mfk` file size limit, checked before a picked or dropped file is read.                       |
| `autosave.ts` | Records the command log per document, saves after edits pause, retries failures with backoff.      |
| `imports.ts`  | Reads reference imports again when a document opens (loaded on first use).                         |
| `url.ts`      | The open document in the page URL (`?doc=<id>`).                                                   |

## Layout

```
documents/<id>/head.json              pointer: current revision, its SHA-256, name, dates, sizes
documents/<id>/snapshot-<rev>.json    the document at revision <rev>, storage form
documents/<id>/log-<rev>.json         the commands from the previous revision to <rev>
documents/<id>/blobs/<sha256>         each imported file, once
documents/<id>/damaged-snapshot-<rev>-<sha>.json, damaged-log-<rev>-<sha>.json
                                      a complete snapshot that did not read, and its log, kept aside
```

`<rev>` is zero-padded to eight digits. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`; the app
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
6. deletes snapshots older than `n` (best effort; `n`, the previous commit, stays as the spare).

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
works.

## Blobs and the command log

An `import` feature keeps its file inline, as base64, in the document (core README, "Imported
geometry"); in memory nothing changes. In storage and in `.mfk` files each import's `source` loses
`data`, and the bytes go to `blobs/<sha256>` (`externalize`, `hydrate` in `blobs.ts`). This is a
storage form, not a new file format version: `document.json` is a version 3 document with
`source.data` left out, and a plain version 3 document with the data inline is accepted too.

The log is what `DocumentStore` reports: one entry per `execute`, `undo` and `redo`, as
`{ cause, label, command, at }`. Commands go through the same rewrite, so an `addFeature` of a
20 MiB import is logged by reference to the blob the snapshot already has. Blobs are kept for the
life of the document, since logged commands can name a file the current snapshot no longer holds.
`readLog(id)` returns the committed log with the files put back (and checked).

## Not done

- **A persistent tier for the regen cache.** Cached B-rep and meshes stay in the worker's memory;
  a reload regenerates from the document. The layout leaves room for `documents/<id>/cache/`.
- **Merging two tabs' changes.** A conflict is resolved by picking one version (or keeping both
  as separate documents), not by replaying one tab's commands onto the other's.
- **Pruning.** Blobs and log segments are never pruned while the document exists.
