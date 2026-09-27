# @manufakture/core

The document model: the source of truth for a part. It is plain TypeScript and plain JSON data,
with no WebAssembly and no geometry. Regen (`packages/regen`) turns a document into shapes; the
app edits it through commands. The shape follows
[ADR 0004](../../docs/adr/0004-document-format.md); numbers follow
[ADR 0005](../../docs/adr/0005-units.md) and are parsed by
[`@manufakture/units`](../units/README.md).

```ts
import {
  createDocument,
  DocumentStore,
  storedExpression,
  previewIds,
  serialize,
  deserialize,
} from '@manufakture/core';
```

## The document

```ts
interface ManufaktureDocument {
  format: 'manufakture';
  version: 3; // file format version, FORMAT_VERSION
  namingScheme: 1; // topological naming scheme version (T0.5), NAMING_SCHEME
  id: string;
  name: string;
  units: DisplayUnits; // display only; never changes geometry
  variables: Variable[]; // { name, expression: StoredExpression }, in display order
  parts: Part[];
}

interface Part {
  id: string; // 'part#1'
  name: string;
  features: Feature[]; // regen order
  rollbackIndex: number | null; // features [0, rollbackIndex) regenerate; null means all
  nextIds: Record<string, number>; // next number per id counter; only ever increases
  material?: MaterialId; // what the part's body is made of; absent: not set (since version 2)
}
```

`createDocument({ id, name, units? })` makes an empty document with one part, `part#1`. Core never
invents document ids; pass a UUID or similar.

### Materials

`MATERIALS` (`src/materials.ts`) is the built-in table: PLA, PETG, ABS, pine, oak, plywood, MDF,
aluminium 6061 and steel, each with an `id`, a display `name`, a `category`, a **typical** density
in kg/m3, the range stock is usually found in where it varies notably, and the `source` the value
comes from (maker data sheets for the plastics and aluminium, The Wood Database for pine and oak,
EN 1993-1-1 for steel). Real stock varies with species, moisture, maker and infill, so a mass
computed from these is an estimate. `findMaterial(id)` looks one up and `massGrams(mm3, kgPerM3)`
turns a volume into grams.

A part stores only the id (`material`), set with the `setMaterial` command. A part has one body
until multi-body parts (M2), so the part's material is its body's. Ids are permanent: the table
may gain materials, but an id is never removed or given another meaning.

### Numbers are expressions

Every number a user types is a `StoredExpression`: the source text, plus the units a bare number
meant when it was typed.

```ts
interface StoredExpression {
  source: string; // '2*#thickness + 1/8"'
  lengthUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  angleUnit: 'deg' | 'rad';
}
```

Build one with `storedExpression(source, doc.units)`. Under the `ft-in` and `in-fraction` display
formats a bare number means inches (`bareUnits` gives `'in'`). Changing the display units later
changes nothing geometric, because each expression keeps the units it was entered under.

Commands refuse an expression that does not parse, and one that names a variable that does not
exist. Core does **not** check dimensions: a length field holding `30deg`, or a variable of the
wrong kind, is accepted here. Evaluation, dimension checking against the field's kind from
`featureExpressions`, and domain errors are regen's job (T1.9 must implement the dimension
check): it evaluates with the stored units
and reports a `FeatureError` with the `UnitsError` ([ADR 0007](../../docs/adr/0007-worker-protocol.md)).
`featureExpressions(feature)` lists every expression in a feature with the kind its field expects
(`length`, `angle`, `number`, or `any` for extension fields).

### Variables

A variable has a name valid under `isValidVariableName` and an expression that may reference
other variables. Names are unique, references must resolve, and cycles are refused.
`variableOrder(variables)` gives an evaluation order. A variable cannot be deleted while a
variable or a feature reads it (`variableUsers` lists them).

`src/variables.ts` has the edits that touch every use of a variable at once, each returned as one
`batch` command (one undo step):

- `variableUses(doc, name)` lists each direct use: another variable, or a feature field with its
  path and expected kind (and `constraintId` for a sketch dimension).
- `renameVariable(doc, from, to, expression?)` renames in place and rewrites every reference as
  `#to` (found by the parser, so `#width` is untouched when renaming `w`).
- `inlineVariable(doc, name, literal)` writes `literal` into every use, parenthesised inside a
  larger expression, then deletes the variable. Core does not evaluate, so the caller supplies the
  literal (the app writes the current value with explicit units, such as `25mm`).
- `rewriteReferences(source, name, replacement)` is the text rewrite both use.

### Ids

Ids are permanent and never reused, including after deletion (ADR 0004 decision 4):

| Id                  | Form           | Counter (`nextIds` key) |
| ------------------- | -------------- | ----------------------- |
| feature             | `kind#n`       | the kind: `extrude`     |
| sketch entity       | `e<n>`         | `e`                     |
| sketch constraint   | `k<n>`         | `k`                     |
| geometry reference  | `r<n>`         | `r`                     |
| sketch split pieces | `<id>#a`, `#b` | none: named from `<id>` |

All counters are per part, so sub-ids are unique across the part, not only within one feature.
Entities are `e` and constraints `k` because T0.5 face names use sketch entity ids after `side:`
(`extrude#1:side:e2`, `side:c1` for a circle in the spike); a constraint prefix of `c` would read
like an entity.

A client that creates something asks for fresh ids with `previewIds(part.nextIds, 'extrude')`
or `previewIds(part.nextIds, 'e', 4)` and puts them in the command. Applying the command
allocates them: `addFeature` and `editFeature` refuse an id below its counter with `id-reused`,
and move the counter past every id they introduce. Undo never moves counters back, so an id
seen once is never handed out again.

Split pieces have no counter, so they follow a structural rule instead: a new split id must split
an id that the same feature had before the command and no longer has after it. `editFeature` of
sketch#1 may replace `e2` with `e2#a` and `e2#b`, and later `e2#a` with `e2#a#a` and `e2#a#b`.
It refuses (`invalid-id`) a piece whose parent is still present, a piece of an entity in another
feature (`e5#a` in sketch#1 while `e5` lives in sketch#2), a piece that skips a level (`e2#a#a`
straight from `e2`), and a deleted piece brought back: once `e2` is gone, nothing names `e2#a`
again. `addFeature` has no earlier state, so it refuses split ids altogether. The same rule
applies to every sub-id kind (`e`, `k`, `r`); only entities are split in practice.

### References

Geometry is referenced by name, never by index (T0.5, ADR 0004 decision 5):

```ts
interface Reference {
  id: string; // 'r1'
  ref: FaceRef | EdgeRef;
  lastResolved?: { point: Vec3; direction: Vec3 }; // re-pick hint only, never used to resolve
}
interface FaceRef {
  face: string;
} // 'extrude#1:cap:end'
interface EdgeRef {
  faces: string[];
  ends?: string[];
  ordinal?: number;
}
```

Fields that must be a face or an edge use `FaceReference` or `EdgeReference`. Face and edge names
themselves, and how a reference resolved, are derived data and never stored.

## Features

Every feature has `id`, `kind`, a display `name` (1 to 200 characters) and `suppressed`. The
union is discriminated by `kind`.

| Kind        | Inputs                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sketch`    | `plane` (explicit `origin`, `normal`, `xDir`, or a `face` reference), `entities`, `constraints`                                                                  |
| `extrude`   | `profile`, `operation` (`new`, `add`, `cut`, `intersect`), `extent`, `reverse`, optional `draft` (angle; + tapers inward)                                        |
| `revolve`   | `profile`, `axis` (a line of the sketch or an edge reference, each with optional `flip`), `angle`, `symmetric`, `operation`                                      |
| `fillet`    | `edges` (edge references), `radius`                                                                                                                              |
| `chamfer`   | `edges`, `distance`, optional `secondDistance` or `angle` (not both)                                                                                             |
| `shell`     | `faces` to remove (face references), `thickness`, `outward`                                                                                                      |
| `hole`      | `sketch` and its `points`, `diameter`, `extent` (blind depth or through all), `head` (simple, counterbore, countersink), optional `standard` (`size`, `fit`)     |
| `pattern`   | `features` to repeat, or `body: true` (and no features) for the whole body, `layout` (linear: direction, count, spacing; circular: axis, count, angle; `flip`)   |
| `mirror`    | `features`, or `body: true`, `plane` (a planar face reference)                                                                                                   |
| `extension` | a later domain feature: `extension` type (`print.brim`), `schemaVersion`, `dependsOn`, `references`, `expressions`, opaque JSON `params`                         |
| `import`    | `source` (the imported file: `format` `step` or `stl`, `fileName`, `size`, `sha256`, base64 `data`), `operation` (`reference`, `new`, `add`, `cut`, `intersect`) |

A `profile` is `{ sketch, entities? }`: the sketch feature and the entities bounding the chosen
regions (absent: every closed region). Extrude extents are `blind`, `symmetric` (total depth,
centred), `throughAll` and `upToFace`.

The kernel implements these as `applyFeature` inputs (`packages/kernel`, Part features). Unequal
chamfers measure `distance` on the reference face of each edge, the adjacent face whose name sorts
first. A hole's `standard` records the screw size and clearance fit (`close`, `normal`, `loose`)
of the kernel's `HOLE_SIZES` table it was sized from; `diameter` and the head sizes stay what
regen uses. A shell with no `faces` is a closed hollow.

A direction or axis taken from an edge or face reference (a revolve's edge axis, a pattern's
direction or axis) points the way the kernel's naming rules orient it, never the way OCCT happens
to store the edge (kernel README, Directions); `flip: true` turns it round. A revolve about a
sketch line turns right-handed about the line's direction, start to end; `flip: true` turns that
round too. A pattern count is at most `MAX_PATTERN_COUNT` (1000) instances, the original included.
The schema does not check the range: the kernel does at regen, for a count written as a plain
number and one computed by an expression alike, so a stored count out of range (say `1001`) still
loads and fails only that pattern at regen, where the user can fix it.

`extension` is the extension point: core validates its dependencies, references and
expressions like any other feature's, and leaves `params` to the domain package that owns the
type.

### Imported geometry

An `import` feature (since version 3) is a file brought in from another program. A STEP file is a
B-rep: the kernel reads it (`import` feature input, kernel README) and names its faces
`import#k:face:<n>` in the file's face order. Imported topology has no history, so those names
are positional and every reference to them resolves `fragile`; a face name mentioning `import#k`
makes `import#k` a dependency like any other feature id. With `operation: 'reference'` the body is
kept aside (shown and measured, not part of the part's body); `new`, `add`, `cut` and `intersect`
combine it with the body like an extrusion. An STL file is a mesh with no B-rep, so it can only be
a `reference` (the schema refuses anything else): shown and measured, never used by a B-rep
feature.

**Where the file lives: in the document.** `source.data` is the file's bytes as base64, next to
its `size` and the lower-case hex SHA-256 of the bytes. The schema checks that `data` is base64
and decodes to exactly `size` bytes, and refuses a file over `MAX_IMPORT_BYTES` (20 MiB) by the
length of `size` and `data` alone, before the text is scanned. The schema does not hash `data`
(checking a document is synchronous); regen checks `sha256` against `data` before a combining
import is built (regen README, "Import integrity"). This was chosen over a separate blob store because:

- ADR 0004 makes the document the source of truth and everything else a disposable cache. An
  imported file is input, not derived data: it cannot be rebuilt from anything else, so it cannot
  live in the cache, and a store beside the document would have to be saved, copied, exported
  and undone together with it. Inside the document, undo, redo, save and copy just work.
- The hash makes storing the bytes apart mechanical, and the app's persistence (#935) does so
  without a format change: in storage and in `.mfk` files each `source` loses `data` and the
  bytes go to a content-addressed blob keyed by `sha256`, checked when they are put back on load
  (`apps/web/src/persistence/README.md`). In memory the document keeps `data` inline, so core,
  regen and the kernel are unaffected.

The cost is size: base64 is 4/3 of the file, in every saved copy and in the undo history's
snapshots (which share it, since documents are immutable). The app refuses files over the same
`MAX_IMPORT_BYTES`, which is below the kernel's own STEP limit (`MAX_STEP_BYTES`, 64 MiB).

### Sketch data

A sketch stores its geometry and constraints as plain data in exactly the shape of the sketch
model in `@manufakture/sketch/model`, which the solver loads
([ADR 0003](../../docs/adr/0003-sketch-solver.md)). Coordinates are the last
solved values, in millimetres in the sketch plane's 2D frame: they seed the solver and pick which
solution the sketch settles into; the constraints define it. The plane is an explicit
`{ origin, normal, xDir }` (the sketch package's `SketchPlacement`) or a face reference.

| Entity   | Fields                                                          |
| -------- | --------------------------------------------------------------- |
| `point`  | `position`                                                      |
| `line`   | `start`, `end` (lines own their endpoints, FreeCAD style)       |
| `circle` | `center`, `radius`                                              |
| `arc`    | `center`, `start`, `end` (counter-clockwise; radius is derived) |

Every entity also has `id` and `construction`. Constraints name geometry in two ways: a curve is
an entity id, and a point is a `PointRef { entity, at? }`, where `at` is `start` or `end` (lines,
arcs) or `center` (circles, arcs) and is absent for a point entity. The built-ins `@origin` (a
point), `@x-axis` and `@y-axis` (curves) can be named too.

| Constraint                               | Fields                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| `coincident`                             | `a`, `b` (points)                                             |
| `horizontal`, `vertical`                 | `line`, or `a`, `b` (points)                                  |
| `parallel`, `perpendicular`, `equal`     | `a`, `b` (curves)                                             |
| `tangent`                                | `a`, `b` (curves), `at?` (`[end, end]` for endpoint tangency) |
| `distance`                               | `a`, `b` (points), or `point` and `line`; `value`             |
| `horizontalDistance`, `verticalDistance` | `a`, `b` (points), `value` (signed)                           |
| `angle`                                  | `a`, `b` (lines), `value` (an angle)                          |
| `radius`, `diameter`                     | `entity`, `value`                                             |
| `fix`                                    | `point`                                                       |
| `midpoint`                               | `point`, `line`                                               |
| `pointOnObject`                          | `point`, `on`                                                 |
| `symmetric`                              | `a`, `b` (points), and `line` or `center` (a point)           |

Every constraint has an `id`. Values are `StoredExpression`s; `DIMENSION_KINDS` says which kinds
hold one and whether it is a length or an angle. Core checks that every named entity is in the
same sketch and that every point reference names a vertex its entity has
(`constraintTargets(constraint)` lists them). Whether a constraint makes geometric sense, and how
it maps onto planegcs, is the sketch package's business.

### One source of truth for sketch types

The sketch data types are defined once, in `@manufakture/sketch/model`: `SketchEntity` (and
`PointEntity`, `LineEntity`, `CircleEntity`, `ArcEntity`), `SketchConstraint`, `ConstraintKind`,
`PointRef`, `PointPosition`, `EndPosition`, `SketchPlacement`, `StoredExpression`, `Vec2` and
`Vec3`. Core imports them with `import type` only and re-exports them, so
`import type { SketchEntity } from '@manufakture/core'` is the same type as the sketch package's;
core's `Point2` is the sketch `Vec2`. **Core never imports runtime code from the sketch package**:
the document does not load the solver, planegcs or anything else from it. A test
(`src/sketch-model.test.ts`) fails on any `@manufakture/sketch` import in core that is not an
`import type` (or `export type`) from `@manufakture/sketch/model`. Core keeps its own copies of
the three built-in names (`SKETCH_ORIGIN` and the axes) for that reason.

Core still needs zod schemas for these types to validate files, and they are tied to the sketch
types at compile time in both directions, so drift in either package fails `make typecheck`:

- each schema ends in `satisfies z.ZodType<T>`: every value it accepts is a valid `T`;
- `src/sketch-model.test.ts` asserts that `z.infer<typeof Schema>` equals `T` exactly
  (`expectTypeOf(...).branded.toEqualTypeOf`), so the schema also covers every field of `T`.

Two consequences in the schemas: the coordinate tuples are `.readonly()` (the sketch `Vec2` and
`Vec3` are readonly; parsed tuples are frozen), and optional sketch fields (`PointRef.at`,
`tangent.at`) use `.exactOptional()`, because the repo builds with `exactOptionalPropertyTypes`
and the sketch types allow the key to be absent but never `undefined`.

### Dependencies

`featureDependencies(feature)` lists the features a feature depends on: the ones it names by id
(profiles, hole sketches, patterned and mirrored features, `dependsOn`) and every feature whose id
starts a face name in one of its references (`extrude#1:cap:end`, including names nested in
merges and corners). The rule, checked on every command and on load:

- **A feature comes after everything it depends on.** Every dependency must exist in the part and
  sit earlier in the list.
- **Reorder** refuses to move a feature before one of its dependencies, or after one of its
  dependents, and names them in `error.blockers`.
- **Delete** refuses while any feature depends on the one being deleted; delete the dependents
  first, or edit them to drop the reference.
- **Suppress** is always allowed. Regen skips a suppressed feature, and its dependents report
  what they cannot find.
- **Face-name dependencies see only the creating feature.** `extrude#1:side:e2` depends on
  `extrude#1`, not on later features that reshaped that face. So reorder lets a fillet on an edge
  move before a later cut that shaped the edge, as long as it stays after `extrude#1`; regen then
  resolves the reference against different geometry (or reports it lost).
- Whether a profile's entities, a hole's points or a revolve's axis line still exist in the sketch
  is **not** checked here: editing a sketch must never be blocked by the features built on it.
  Regen reports a missing entity as an error on the dependent feature, the same way it reports a
  lost face reference.

## Commands

Every change is a command: a plain, JSON-serializable object. `applyCommand(doc, command)`
validates the command against `CommandSchema`, applies it without mutating `doc`, checks the
resulting document with `checkDocument`, and returns `{ document, inverse }` or a `CoreError`.

| Command           | Fields                                                | Inverse                             |
| ----------------- | ----------------------------------------------------- | ----------------------------------- |
| `addFeature`      | `partId`, `feature`, `index?` (default: rollback bar) | `deleteFeature`                     |
| `editFeature`     | `partId`, `feature` (same id and kind)                | `restoreFeature` (old state)        |
| `deleteFeature`   | `partId`, `featureId`                                 | `restoreFeature`                    |
| `restoreFeature`  | `partId`, `feature`, `index`, `rollbackIndex`         | `restoreFeature` or `deleteFeature` |
| `reorderFeature`  | `partId`, `featureId`, `index` (final position)       | `reorderFeature`                    |
| `suppressFeature` | `partId`, `featureId`, `suppressed`                   | `suppressFeature`                   |
| `renameFeature`   | `partId`, `featureId`, `name` (trimmed)               | `renameFeature`                     |
| `setRollback`     | `partId`, `index` (`null`: after the last)            | `setRollback`                       |
| `setVariable`     | `name`, `expression`, `index?` (for a new one)        | `setVariable` or `deleteVariable`   |
| `deleteVariable`  | `name`                                                | `setVariable` at the old index      |
| `setDisplayUnits` | `units`                                               | `setDisplayUnits`                   |
| `setMaterial`     | `partId`, `material` (a material id, `null` clears)   | `setMaterial` (the old one or null) |
| `renameDocument`  | `name` (trimmed, 1 to 200 characters)                 | `renameDocument` (the old name)     |
| `batch`           | `commands` (applied in order, all or nothing)         | `batch` of inverses, reversed       |

`restoreFeature` is a history-only command: it is what undo and redo use to put a feature state
back, and clients must not use it to edit. Unlike `addFeature` and `editFeature`, it requires its
ids to have been allocated before, so undoing a delete brings back the same ids without counting
as reuse. That is its only id check: it does not apply the split rule, because the states it
restores really existed. Everything else (dependencies, expressions, sketch consistency) is
checked as for any command.

A `batch` is checked once, at the end, so its steps may pass through invalid states (add a
feature, then the sketch it uses, in one step).

The rollback bar: inserting at or before it moves it down by one, so the new feature is active;
deleting above it moves it up; reordering leaves it at the same index, so moving a feature across
the bar changes which features are active.

### Errors

Expected failures are values, never exceptions:

```ts
interface CoreError {
  code: CoreErrorCode; // 'dependency' | 'id-reused' | 'expression' | 'variable-cycle' | ...
  message: string;
  path: (string | number)[]; // where in the document or command
  blockers?: string[]; // the features or variables in the way
  unitsError?: UnitsError; // for 'expression': the range to highlight
  issues?: CoreError[]; // every problem, for 'schema' and failed validation
}
```

`validateDocument(doc)` returns every semantic problem; `checkDocument(doc)` wraps it as a result.

## Store, undo and redo, events

```ts
const store = unwrap(DocumentStore.create(doc, { historyLimit: 500 }));
const off = store.subscribe((event) => regen.schedule(event.document, event.change));
store.execute(
  { type: 'renameFeature', partId: 'part#1', featureId: 'fillet#1', name: 'Round' },
  'Rename Fillet 1',
);
store.undo();
store.redo();
```

`DocumentStore` holds the current document, which is always valid, and its undo and redo stacks.
`execute` applies a command as one undo step and clears the redo stack; a command that changes
nothing leaves history alone. `undo` applies the recorded inverse and pushes that command's own
inverse onto the redo stack, and `redo` does the reverse. Both stacks hold `{ label, command }`,
plain data that can be persisted. `load(doc)` replaces the document and clears history.

Every change notifies subscribers with a `ChangeEvent`: the `cause` (`execute`, `undo`, `redo`,
`load`), the `command` applied (recording these gives the op log for version history and sync),
the `label`, the `previous` and new `document`, and a `DocumentChange`. The change is computed by
comparing documents (`diffDocuments`), so it is the same for every cause. Per part it lists added,
removed and changed features, whether the order or the rollback bar changed, and
`firstAffectedIndex`: the first feature whose result may differ, counting edits, moves,
suppression, the rollback bar, and features that read a changed variable, directly or through
other variables. A rename has none, and neither has a material change, which sets
`materialChanged` instead: masses change, geometry does not. Every listener runs even if one throws; the first error is
rethrown afterwards.

## File format

`serialize(doc)` writes canonical JSON: keys in schema order (records such as `nextIds` sorted),
two-space indent, trailing newline. `deserialize(text)` (or `parseDocument(value)`) loads:

1. parse the JSON (`json` error);
2. check `format: 'manufakture'` (`format`);
3. read `version`; a version newer than `FORMAT_VERSION` is **refused** with a message, and the
   input is never modified (`version`);
4. run the file format migrations from that version up to the current one (`migration`);
5. read `namingScheme`; a newer one than `NAMING_SCHEME` is refused the same way;
6. run the naming scheme migrations (none yet);
7. check the schema; objects are strict, so unknown keys are errors, not dropped (`schema`);
8. check the semantic rules above.

It returns `{ document, from: { version, namingScheme }, migrated }`; when `migrated` is true the
app should offer to save in the current version. Nothing is repaired silently.

### Migrations

A migration is `{ from, to, description, migrate }`, a pure function from the JSON of version N
to version N + 1 that must set the new `version`. `FORMAT_MIGRATIONS[i]` goes from i to i + 1;
naming scheme migrations are a separate chain. Version 0 was the pre-release draft (no
`namingScheme`, no `suppressed`, no `rollbackIndex`); `migrateV0ToV1` adds them. Version 2 added
the optional part `material`; `migrateV1ToV2` only bumps the version, since a version 1 part has no
material. Version 3 added the `import` feature kind; `migrateV2ToV3` only bumps the version, since
a version 2 part has no imports. The test migrates `src/fixtures/v0-bracket.json` to exactly
`v1-bracket.json`, that to exactly `v2-bracket.json`, and that to exactly `v3-bracket.json`.

To change the file shape:

1. bump `FORMAT_VERSION` in `src/schema.ts` and change the schema;
2. append a migration to `FORMAT_MIGRATIONS` in `src/migrations.ts`;
3. add a fixture of the old version to `src/fixtures/` and register it in `FIXTURES` in
   `src/format.test.ts` (a test fails until every older version has one).

## Where this deviates from ADR 0004's first cut

- **Added fields.** The document has `id` and `name`; a part has `name`, `rollbackIndex` and an
  optional `material` (the material of its one body; per body once parts have several bodies);
  every feature has `name` and `suppressed`. The ADR's shape was a first cut that expected feature kinds
  to add their own fields.
- **Cuts are extrudes.** The ADR's comment lists `'cut'` as a kind and T0.5 names faces
  `cut#4:...`. Here a cut is an `extrude` (or `revolve`) with `operation: 'cut'`, so its faces are
  named after an `extrude#n` id. Nothing in the naming scheme depends on the kind's name.
- **`version`, not `formatVersion`.** The task text says `formatVersion`; the ADR's field name is
  kept, and the constant is `FORMAT_VERSION`.
- **Constraint ids use `k`.** The ADR's example `c1` is a sketch entity (a circle) in T0.5, so
  constraints use `k1` to keep entity and constraint ids apart.
