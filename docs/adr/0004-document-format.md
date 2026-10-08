# 0004: Document format: a versioned JSON feature list, with names as references

- Status: accepted
- Date: 2026-09-26

## Context

Every M1 package reads or writes the document: `core` holds the model, `regen` replays it, `kernel` and `sketch` compute from it, `io` imports and exports, and the app persists it. It needs a fixed shape before any of them is written.

The inputs:

- [Product decisions](../decisions/0000-product-decisions.md): local-first and single user, with documents in the browser's Origin Private File System (OPFS) until M7; GUI feature tree first, with scripting later on the same document model.
- [T0.2](../spikes/T0.2-occt.md): the OCCT instance leaks and must be recycled, which "only works if the document is the feature tree and OCCT state is always rebuildable from it".
- [T0.5](../spikes/T0.5-topo-naming.md): references to faces and edges survive edits when stored as names built from OCCT history, and its section "For the document format ADR (T0.6)" lists what the file must guarantee. Sub-shape indices look stable and silently drift.
- [T0.4](../spikes/T0.4-planegcs.md): the solver keys constraints by stable model ids.
- [`packages/units`](../../packages/units/README.md) and [ADR 0005](0005-units.md): numbers are typed as expressions, and bare numbers are read in the display unit.

## Decision

1. **The source of truth is a JSON document**: document settings, a variables table, and per part an ordered feature list whose features hold their own inputs (sketches, expressions, references). Nothing derived is stored in it: no B-rep, no mesh, no face or edge names or indices, no evaluated numbers. A sketch stores its entities with their last solved coordinates, because they are the solver's starting point and pick which solution a sketch settles into; the constraints remain what defines it.
2. **Versioned.** The file has `format: 'manufakture'` and an integer `version`. Every change to the shape bumps `version` and adds a migration: a pure function from version N to N + 1, applied in sequence on load and tested against fixture files of every older version. The app always saves the current version. A document with a newer `version` than the app knows is refused with a clear message and never modified.
3. **A separate `namingScheme` version**, per T0.5, so a later naming scheme can migrate stored references independently of the file shape.
4. **Ids are permanent.** Feature ids are `kind#n` (`extrude#1`, `fillet#3`), assigned at creation, unique within the part, and never reused, including after deletion: a reused id would silently re-attach a lost reference. They are never tree positions, so reordering renames nothing. Sketch entity ids (`e1`, `c1`), sketch constraint ids and reference ids (`r1`) follow the same rule (the solver maps constraint ids to its own tags, [ADR 0003](0003-sketch-solver.md)), and sketch splits name their pieces `<id>#a`, `<id>#b` in order along the original entity. The part stores its next-id counters so that deletion never frees an id.
5. **References are names, never indices or hashes.** A face reference is `FaceRef { face }`; an edge reference is `EdgeRef { faces, ends?, ordinal? }`, with `ends` and `ordinal` present only when they were needed to be unique at pick time. A feature holds each reference in a wrapper that carries the reference's own id. Optionally a reference keeps the geometry of its last successful resolution (a point plus a normal or tangent) so the re-pick UI can show what was lost; it is never used to resolve.
6. **Face and edge names are derived data**, recomputed on every regen by the naming layer in the kernel worker. Only references store names. How a reference resolved (`via`, `fragile`) is also recomputed, never stored, and is surfaced to the UI per reference: an `exact`, non-fragile resolution is silent; `descendant`, `ancestor`, `ends`, `ordinal` or any fragile resolution is a warning on the feature; `lost` (with the missing names) and `ambiguous` (with the candidates) fail the feature with a re-pick prompt while later features keep regenerating; an unnamed result face is a regen error. These rules are T0.5's recommendations for T1.8, adopted as the contract.
7. **Numbers are stored as expressions**: the source text in the syntax of `packages/units`, plus the bare-number units in force when it was entered (a `LengthUnit`, which is `'in'` under the `ft-in` and `in-fraction` display formats, and an `AngleUnit`), so that changing the document's display units never changes geometry ([ADR 0005](0005-units.md)). Evaluated values exist only in memory.
8. **OPFS holds the document and a disposable cache.** Each document has its own OPFS directory with the JSON file and a cache (per-feature B-rep, meshes, name tables). A cache entry is keyed by a hash of the feature's inputs, the keys of the features it depends on, the kernel build identity, an implementation version of the regen engine and feature code, and the naming scheme version. The implementation version is bumped with any code change that can alter a feature's output, so a new app build never serves results computed by old code. Any cache entry may be deleted at any time; a missing, corrupt or mismatched entry is a cache miss and triggers a rebuild, never an error. A save never leaves a half-written document as the only copy.
9. **Validated on load.** After migration, the document is checked against a schema. An invalid document is reported, not silently repaired.

The shape, as a first cut for `packages/core` (feature kinds add their own fields):

```ts
interface ManufaktureDocument {
  format: 'manufakture';
  version: number; // file format version; each bump has a migration
  namingScheme: number; // topological naming scheme version (T0.5)
  units: DisplayUnits; // ADR 0005
  variables: Variable[]; // name plus StoredExpression
  parts: Part[];
}

interface Part {
  id: string;
  features: Feature[]; // regen order
  nextIds: Record<string, number>; // per id kind; only ever increases
}

interface Feature {
  id: string; // 'extrude#1'
  kind: string; // 'sketch' | 'extrude' | 'cut' | 'fillet' | ...
}

// Named to avoid a clash with the units package's AST type `Expression`.
interface StoredExpression {
  source: string; // for example '2*#thickness + 1/8"'
  lengthUnit: LengthUnit; // what a bare number meant when this was entered; 'in' under ft-in and in-fraction (ADR 0005)
  angleUnit: AngleUnit;
}

interface Reference {
  id: string; // 'r1'; permanent, never reused
  ref: FaceRef | EdgeRef;
  lastResolved?: { point: Vec3; direction: Vec3 }; // normal or tangent; re-pick hint only, never used to resolve
}

interface FaceRef {
  face: string;
}

interface EdgeRef {
  faces: string[];
  ends?: string[];
  ordinal?: number;
}
```

## Alternatives considered

- **Store the B-rep (STEP or OCCT's native format) as the document.** Loses the design intent, cannot be edited parametrically, and ties the file to one kernel's output. B-rep is cache only.
- **Store sub-shape indices or shape hashes in references.** T0.5 shows an index staying on the right edge through a resize and a reorder, then silently landing on another edge after a sketch split or a rotated rectangle. OCCT hashes are unique only within one kernel instance. Rejected.
- **Ids from tree position or recycled counters.** Reordering would rename geometry, and a reused id would re-attach a lost reference to the wrong thing. Rejected.
- **Store evaluated numbers instead of expressions.** Loses parametric intent and the variables table's meaning. Rejected.
- **One version number for both the file shape and the naming scheme.** A naming change would force a file migration and the reverse; T0.5 asks for a separate version. Rejected.
- **A binary format.** Nothing in M1 needs it; JSON diffs, debugs and migrates easily, and heavy data lives in the cache.

## Consequences

- Loading a document means a full regen, unless valid cache entries exist; recycling the kernel is always safe.
- Every schema change costs a migration and a fixture file. That is the price of opening old documents forever.
- Deleting a feature leaves a gap in the id sequence by design.
- The regen engine, the UI and tests share one vocabulary for reference outcomes (`exact`, `descendant`, `ancestor`, `ends`, `ordinal`, `fragile`, `lost`, `ambiguous`).
- Feature kinds not exercised by T0.5 (revolve, sweep, loft, shell, chamfer, patterns, mirrors, imported geometry) must define their birth names before they land; patterns and mirrors will need an instance index in names, which may bump `namingScheme`.

## Amendment: body groups are document data, their visibility is not (format version 17, 2026-10-08)

A part can group its bodies (`Part.bodyGroups`, #1198): a named list of body ids, so a user can show, hide or isolate a subassembly of a large part at once. The question was whether a group is part of the model or of the view.

- **The group is document data.** It describes the model the way a body name does: "these six bodies are the pedal box" is true of the design, is worth keeping across sessions and devices, and should travel with the file and through sync. So groups are stored in the part, changed by undoable core commands (`setBodyGroup`, `deleteBodyGroup`, `restoreBodyGroup`), and the format went to version 17 with a version-only migration (a version 16 part with a `bodyGroups` key is refused rather than read). Group ids are `group#n` from the part's `nextIds.group` and are never reused, per decision 4; the field is absent when a part has no groups, so the content of existing files is unchanged apart from `version`.
- **Whether a group is hidden stays view state.** Hiding a body is not an undo step and is not in the file (M2 plan, decision 5); a group is hidden exactly when its bodies are, so hiding or isolating a group writes the same per-body hidden state, and nothing about it reaches the document.
- **Members are names, checked like other body lists that may outlive their body.** A body is in at most one group of its part, and a group lists a body at most once; these are validated. Whether a member's body still exists is not: like a body id in an instance's `bodies`, a member whose feature was deleted, or whose body merged into another, stays listed and the app simply does not show it. Body ids are never reused, so a stale member cannot attach to a different body, and it rejoins its group when the body returns (undo, rollback bar, unsuppress). This also means a feature delete is never refused because of a group, including one arriving from another client. The app prunes the members of a feature it deletes itself, in the same undo step.
- **Nothing derived changes.** Regen, the cut list, exports and selection ignore groups.
