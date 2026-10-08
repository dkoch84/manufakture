# @manufakture/review

The review bundle ([ADR 0016](../../docs/adr/0016-agent-sessions.md) decision 11, M8 plan
[T8.3a](../../docs/plans/agent-surface.md)): what an agent's branch changed, as JSON data plus PNG
images, built in the session where the work was done and read in History where a person approves
it (T8.3b). The builder is Node only (it regenerates on a kernel); the app reads bundles through
`@manufakture/review/data`, which loads no Node module and no kernel.

```ts
import { bundleBuilder } from '@manufakture/review';

// The session's BundleBuilder hook: views besides the fixed four are the agent's, at submit.
const r = await session.submit(
  bundleBuilder({ views: [{ name: 'boss', camera: { view: 'top', fit: ['extrude#2'] } }] }),
  'A boss on the upright.',
);
```

```ts
import { isStale, readBundle } from '@manufakture/review/data';

const read = readBundle(stored.bundle); // untrusted: bounds checked before anything is shown
if (read.ok && !isStale(read.bundle, { branch, revision, baseVersion })) {
  // offer Approve (with the app's own regen compared, T8.3b)
}
```

| File            | What                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `ReviewBundle` and its parts; `LIMITS`, the bounds of everything in it.                                  |
| `bundle.ts`     | `buildBundle` (documents, log, engine), `bundleBuilder` (the session's hook), regen issues, body deltas. |
| `workbench.ts`  | Base and head regenerated on an engine of the bundle's own; meshes, measurements, interference, counts.  |
| `commands.ts`   | The command diff: the branch's log replayed from the base, one summary per command.                      |
| `summaries.ts`  | `SUMMARIES`: one readable line per command type, every type core has.                                    |
| `describe.ts`   | Names looked up across documents; feature descriptions ("Fillet 3 (2 mm) on 4 edges of Extrude 1").      |
| `diff.ts`       | Feature diff per part and assembly, other document changes, scripts.                                     |
| `domains.ts`    | The domain summariser hook and the generic fallback.                                                     |
| `quantities.ts` | Cut list, hardware and takeoff deltas.                                                                   |
| `renders.ts`    | The views and the camera both sides share.                                                               |
| `data.ts`       | `readBundle` and `isStale` (`./data`, with `types.ts`).                                                  |
| `text.ts`       | Bounded text without control characters, rounding, expressions as typed, the generic field diff.         |

## The bundle

Keyed by `{ documentId, branch, baseVersion, headRevision }`. Text is from the document or the
agent, so every string goes through `shown`: control, format and lone surrogate characters
(Unicode Cc, Cf, Cs: bidi overrides, zero-width marks) become U+FFFD, and it is cut at
`LIMITS.text` (500) characters. Script sources are the exception: they are kept exactly, and
`hiddenCharacters` says when one holds such characters. Numbers from the kernel are rounded to 12
significant digits, so a bundle is stable data. Lengths mm, areas mm², volumes mm³, masses g.

| Section        | How it is made                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`     | The branch's log (`readHistory` and `readLog`), every entry with its revision, cause and label. Each command (a `batch` by its parts) is replayed from the base through core, so its summary sees the document right before and after it, and has its JSON cut at 4,000 characters. At most 2,000 batches and 5,000 commands.                                                                                                                     |
| `features`     | Base against head, not the commands, so an edit undone leaves nothing. Per part that differs: its own fields (name, material, rollback, body props and groups) and each feature added, deleted, renamed, suppressed or unsuppressed, edited (with the fields that differ, as dotted paths, expressions as typed) and reordered (outside a longest common subsequence of the ids both lists hold). Per assembly: instances and mates the same way. |
| `document`     | Other document-level changes as fields: name, units, variables by name, configurations, fonts, drawings, CAM tools and setups, print setups.                                                                                                                                                                                                                                                                                                      |
| `domains`      | Each namespace whose data differs, through its domain package's summariser (`woodDataSummariser`, `stockDataSummariser`, `constructionDataSummariser`); a namespace without one, or one whose summariser throws, gets the fields that changed. CAM and print keep their data in the document proper, not in `domains`, so they have none.                                                                                                         |
| `scripts`      | Scripts added, changed (with the old source as `previous`) or deleted, and unchanged ones that a scripted feature the branch added or edited runs (`used`), each in full up to 256 KiB, 4 MiB in all, with the scripted features that run it.                                                                                                                                                                                                     |
| `renders`      | Isometric, front, top and right, plus at most four views asked for at submit, of base and head. A view that does not frame itself (`fit` or `extent`) is framed on the box round everything either side draws, centred, with the renderer's 24 px margin, so the two images line up. 800 x 600 by default. Images over 8 MiB, or that cannot be drawn (nothing to draw), say why instead.                                                         |
| `regen`        | `errors()` of each side (features, instances, mates, reference imports), compared by where, code and message: `new` (head only, errors first), `remaining`, `resolved` (base only), and counts.                                                                                                                                                                                                                                                   |
| `measurements` | Each body's volume, area, bounding box, and mass from its material (else the part's), exact from the B-rep, at both sides, with the change and the delta; added and changed first. Interference of each assembly (at most 32) at the poses stored in the document, at both sides.                                                                                                                                                                 |
| `quantities`   | The session's `quantities()` of each side: cut list, hardware and each takeoff, rows matched by their takeoff key and unit, totals by group and unit. Only what differs.                                                                                                                                                                                                                                                                          |
| `merge`        | `previewMerge` of the branch into Main's current head: the batches that apply, those dropped with why, ids renamed and objects Main changed that the merge replaces. When it cannot be made, `ok: false` and why.                                                                                                                                                                                                                                 |

Every list is a `{ items, omitted }` where it can be long. `readBundle` checks the envelope and
key, then walks every value once without recursion: nesting at most 16 deep, lists and objects
at most 5,000 entries, strings at most `LIMITS.text` (script sources and command JSON at their own
limits), 64 MiB of text in all, finite numbers, and `sha256` fields that are SHA-256s.

**Stale.** `isStale(bundle, { branch, revision, baseVersion })` is true when the branch, its head
revision or its base version is not the bundle's: a write after the submit, or an update from
Main (a new branch). The session's `info().bundle.stale` says the same for the newest one.

**Measurements are for comparing.** ADR 0016 decision 4: the app compares the head's
measurements, names and error codes with its own regen, with a tolerance, never mesh hashes or
cache keys. Renders are evidence for a person and are not compared.

## How it is built

`bundleBuilder(options)` returns the session's hook `(base, head, context)`. It reads the
branch's log and the merge preview from `context.library`, starts an engine of the host's kind
(`context.engine()`: a kernel of its own, never the session's, closed when done), and calls
`buildBundle`. The base is regenerated first, then the head on the same engine, so what the
branch did not change comes from the cache; a body or member set the head's regen reports
unchanged keeps the mesh the base sent (by body and set key). Each side is measured while its
shapes are live. A regen keeps to the session's `regenMsPerBatch` and every other kernel call to
`kernelMsPerCall`; past either the build fails and the submit answers `bundle`. An in-process
kernel that recycled mid-side is regenerated again; a worker past its heap threshold is
restarted first.

**Storage.** The session stores the bundle as `documents/<id>/branches/<branch>/review-<rev>.json`
(`BackendBundleStore`), and each image through `context.putBlob` as a blob of the document,
`documents/<id>/blobs/<sha256>`, where the library keeps imported files and never prunes, so a
bundle kept with its merge still finds its images after the branch is deleted. The bundle names
images by SHA-256 (`ImageRef`); `BundleStore.readBlob` reads one back, checked against its name.

**Summaries.** `SUMMARIES` maps every command type core has to a summariser; its type requires
every `CommandType`, and `summaries.test.ts` checks it against core's schema and summarises every
command of core's golden logs (which cover every type) without falling back. A new command type
therefore fails the build until it has a summary.

## Tests

```sh
./node_modules/.bin/vitest run --project packages packages/review
```

- `bundle.test.ts`: bundles of scripted edits of the bracket (a boss, a smaller fillet, a
  material, an assembly of two whose instances overlap; Main deletes the fillet meanwhile, so the
  merge preview drops the fillet edit), the cabinet (the shelf raised, a thicker back, a kerf, a
  plywood price, a rename) and the shed (a window moved, studs at 24 inches), built through a
  real session's `submit` on the kernel in this thread and compared with `src/test/goldens/*.json`
  (the data, and every image by its SHA-256); every image is a stored blob. The shed's again with the session and the builder on worker
  engines gives the same golden. A write after the
  submit makes the bundle stale. A scripted feature (built from documents, since a session's
  engine runs no scripts) shows its script in full and its regen error.
- `summaries.test.ts`: the completeness check above, and summaries pinned word for word.
- `diff.test.ts`: feature, script, document and domain diffs, regen issue order, quantity deltas,
  the shared camera, `readBundle`'s bounds and `isStale`.

After a deliberate change to the bundle, the renderer or regen, rewrite the goldens and read the
diff (the images' hashes change with any pixel):

```sh
UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run --project packages packages/review
```

## Not done

- **Reference imports** (STEP and STL references) are listed in `regen` when they do not read,
  but not measured or drawn: they are not regen bodies.
- **Scripted features** regenerate as `unsupported` in a session's engine (see the session
  README), so a bundle shows their script and that error, not their geometry.
- **Exploded views and drawings** are not rendered; assemblies are not drawn either
  (`@manufakture/render` draws parts only).
