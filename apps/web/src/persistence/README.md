# Persistence

Where the app keeps documents in the browser. The library itself (layout, crash safety, versions,
branches, merge, `.mfk` files, sync state) is the
[@manufakture/library](../../../../packages/library/README.md) package; this directory gives it
the browser's storage and saves the open document as it is edited. The user's view is in
[docs/user/files.md](../../../../docs/user/files.md).

| File          | What                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `opfs.ts`     | The Origin Private File System backend, probed before use.                                       |
| `idb.ts`      | The IndexedDB fallback (one object store, path to bytes).                                        |
| `storage.ts`  | Picks OPFS, then IndexedDB, then memory; storage estimate and `persist()`.                       |
| `autosave.ts` | Records the command log per document, saves after edits pause, retries failures, names versions. |
| `imports.ts`  | Reads reference imports again when a document opens (loaded on first use).                       |
| `url.ts`      | The open document, branch and part studio in the page URL (`?doc=<id>&branch=<id>&part=<id>`).   |

Both backends implement the package's `StorageBackend` on the same slash paths, and confine paths
with its `segments`. Neither is assumed to write atomically, and OPFS has no rename in every
browser; the library never relies on either (package README, "Crash safety"). Every operation on
a document holds the Web Lock `manufakture-document-<id>`, so two tabs never interleave a
document's files (package README, "Several tabs").

Tests use `@manufakture/library/test-fixtures` for documents, a `MemoryBackend`, and a backend
that crashes at a given step.
