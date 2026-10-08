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
  version: 17; // file format version, FORMAT_VERSION
  namingScheme: 1; // topological naming scheme version (T0.5), NAMING_SCHEME
  id: string;
  name: string;
  units: DisplayUnits; // display only; never changes geometry
  variables: Variable[]; // { name, expression: StoredExpression }, in display order
  parts: Part[];
  assemblies: Assembly[]; // instances of parts placed by mates, in tab order (since version 7)
  print: PrintData; // print setups: what to print, on which printer, oriented how (since version 8)
  fonts: DocumentFont[]; // the fonts texts use, bundled or added by the user (since version 9)
  cam: CamData; // CAM tools and setups with their operations (since version 14)
  scripts?: Script[]; // the script library, in library order; absent: none (since version 16)
  drawings?: Drawing[]; // drawings of parts and assemblies, in tab order; absent: none (since version 12)
  configurations?: Configurations; // the configuration table; absent: none (since version 5)
  domains?: Record<string, DomainData>; // domain settings by namespace; absent: none (since version 11)
  nextIds: Record<string, number>; // document-level counters: `part` (since version 4), `cp`, `cfg`, `assembly`, `font`, `drawing`, `script`
}

interface Part {
  id: string; // 'part#1'
  name: string;
  features: Feature[]; // regen order
  rollbackIndex: number | null; // features [0, rollbackIndex) regenerate; null means all
  nextIds: Record<string, number>; // next number per id counter; only ever increases
  material?: MaterialId; // default material of the part's bodies; absent: not set (since version 2)
  bodies: BodyProps[]; // per-body name, colour, material, for bodies that have any (since version 4)
  bodyGroups?: BodyGroup[]; // named groups of bodies, in list order; absent: none (since version 17)
}

interface BodyProps {
  id: string; // a body id: 'extrude#3', 'pattern#2:i3', 'derived#1:from/extrude#1'
  name?: string;
  color?: string; // '#rrggbb', lower-case
  material?: MaterialId; // overrides Part.material for this body
}

interface BodyGroup {
  id: string; // 'group#1', from the part's nextIds.group; never reused
  name: string; // trimmed, 1 to 200 characters
  bodies: string[]; // body ids, in the user's order; may be empty
}
```

`createDocument({ id, name, units? })` makes an empty document with one part, `part#1`, no
assemblies, an empty print section (`createPrintData()`), no fonts, an empty CAM section
(`createCamData()`), and `nextIds: { part: 2 }`. Core never invents document ids; pass a UUID or similar.

### Bodies

A part holds any number of bodies. Which bodies exist, their solids and volumes are derived by
regen; the document stores only what the user set on a body, and which bodies each feature acts
on.

- **A body is named after the feature that made it.** Its id is the creating feature's id
  (`extrude#3`, `import#1`). A pattern or mirror owns the bodies its copies make, under its
  instance prefix: copies of bodies (`body: true`), and copies of features that make bodies (a
  `new` extrude, revolve or import, or an `add` whose copy touches nothing). A copy is
  `pattern#2:i3` or `mirror#1:image`, followed by `/<source id>` when the pattern copies several
  bodies or features (`pattern#2:i3/extrude#1`). An extension feature with operation `new` or
  `add` makes bodies under its own id, alone (`extension#3`) or with a key its domain chooses
  (`extension#3:layer/sheathing`) when it makes several (since version 11; ADR 0013 decision 6).
  A pattern or mirror of features does not copy a body-making extension: it makes no copies of
  it, so `pattern#2:i3/extension#3` is not a body id. A derived body is
  `derived#1:from/<source body id>`, the source body id being the body's id in the source
  document (`derived#1:from/pattern#2:i3/extrude#1`). Feature ids are never reused, so body ids
  are not either, and they need no counter. `bodyCreator(bodyId)` gives the creating feature: the
  id up to the first `:`. Nothing after it is read for feature ids, since it is an instance suffix
  or a name in another document.
- **Merging and splitting.** A `new` extrude, revolve or import makes a body. An `add` whose tool
  touches several bodies in its scope fuses them into one, which keeps the id of the body whose
  creating feature comes first in the part; the others end there. An `add` that touches no body
  makes a new body under its own id (with a `detached` warning), like any other body. A `cut` that
  leaves a body in pieces keeps one body with several solids; splitting a body into separate bodies
  is later work.
- **Scope.** Extrude, revolve, import and hole, and a pattern or mirror with `body: true`, take an
  optional `scope: string[]` of body ids: the bodies the operation combines with, or the bodies a
  body pattern copies. Absent means every body at that point, which is what a version 3 part (one
  compound) did, so old documents regenerate unchanged. A scope is at least one body; a `new` or
  `reference` operation and a pattern of features have none (the schema refuses it). A derived
  feature takes a scope like an import (since version 6). An extension takes one too (since
  version 11): every body it combines with or changes, with or without an `operation` of its own
  (a joint cuts the boards it names and has none), refused only with `new`. Fillet, chamfer and shell take no
  scope: they act on the bodies that own their references.
- **Body pattern mode.** A pattern or mirror with `body: true` may say how its copies join the
  part (since version 6): `mode: 'add'` fuses each copy with the bodies it touches, `mode: 'new'`
  keeps every copy a body of its own. Absent means `add`, which is what a body pattern did before,
  so older documents are unchanged. Only a pattern or mirror of bodies has a mode.
- **What is stored.** `Part.bodies` has an entry only for a body the user has named, coloured or
  given a material, so every entry sets at least one of them. `Part.material` stays and is the
  default: a body's material is its own `material` if it has one, else the part's, else none.
  Visibility is view state in the app, not document state.

Validation checks body ids as far as it can without regen. A `BodyProps.id` or a `scope` entry
must name a body a feature of the part can create: its creating feature exists and is an extrude,
revolve or import with operation `new` or `add` (named exactly its id), a pattern or mirror of
bodies or of body-making features (named with a suffix), a derived feature with operation
`new` or `add` (named `<id>:from/<source body id>`, and when it lists `bodies`, one of them), or
an extension with operation `new` or `add` (named its id, or `<id>:<key>` with any key; which keys
exist is its domain's business). An extension with `cut`, `intersect` or no operation makes no
body. A scope entry's creator must come before the feature; it becomes one
of `featureDependencies`, so reorder and delete respect it. Duplicate ids in `bodies` or in one
scope are refused. The rest is regen's: whether an `add` really made a body (it may have merged),
whether an instance suffix exists (`:i3` of a three-copy pattern) and whether a source body
exists in the pinned version, are reported by regen as `reference-lost`.

**Body groups** (since version 17) name a set of a part's bodies so the app can show, hide and
isolate them together (the seat or the pedal box of a rig). A group describes the model, like a
body name, so it is document data and undoable; whether a group is hidden is view state, like a
body's. A body is in at most one group of its part (validation refuses a body in two groups, or
twice in one). Members are not checked against the features: a member whose body is gone (its
feature deleted, or merged into another body by an `add`) stays listed and the app does not show
it. Body ids are never reused, so such a member can never pick up another body, and it is back in
its group when the body comes back (undo, the rollback bar, an unsuppress); a feature delete is
therefore never blocked by a group. Grouping changes no geometry, no export and no cut list.

Part ids are `part#n`, allocated from the document's `nextIds.part` like feature ids: a
`part#n` at or past the counter is refused, and the counter only increases. A part id of another
form is allowed and not counted.

### Configurations

A document can define variants as rows of a parameter table (since version 5). Each row gives an
ordinary document that regen builds unchanged.

```ts
interface Configurations {
  parameters: ConfigParameter[]; // the columns, in display order
  rows: ConfigRow[]; // the variants, in display order
  active: string | null; // the row the document is shown and built in; null: none
}

type ConfigParameter =
  | { id: 'cp#1'; name: string; kind: 'variable'; variable: string } // overrides its expression
  | { id: 'cp#2'; name: string; kind: 'suppression'; partId: string; featureId: string }; // overrides `suppressed`

interface ConfigRow {
  id: 'cfg#1';
  name: string;
  values: Record<string, StoredExpression | boolean>; // by parameter id
}
```

`configured(doc, rowId?)` (`src/configurations.ts`) is a pure function giving the document with a
row applied, the active row by default: each variable a parameter names takes the row's
expression, and each feature a suppression parameter names takes the row's flag. A parameter the
row has no value for keeps the document's own value, so a new column needs no value in every row.
The result has `active` set to that row and is checked with `checkDocument` like any document.
With no row to apply (no table, no active row, or `rowId` `null`) it returns `doc` itself. The
document's own variable expressions and `suppressed` flags stay the base values; rows only
override them.

Parameter ids are `cp#n` and row ids `cfg#n`, allocated from the document's `nextIds.cp` and
`nextIds.cfg` (`CONFIG_PARAMETER_COUNTER`, `CONFIG_ROW_COUNTER`; `previewIds(doc.nextIds, 'cp')`
gives the next one), by the same rules as feature ids: never reused, never moved back by undo.

Validation refuses: an id at or past its counter, or used twice; a parameter or row name used
twice; a parameter naming a variable, part or feature that does not exist; two parameters for one
variable or one feature; a row value for an id that is not a parameter, or of the wrong kind (an
expression for a variable, `true`/`false` for a suppression); a row expression that does not parse
or names an unknown variable; a row that makes a variable cycle once applied; and an `active` that
is not a row. Core does not evaluate row values, as for any expression.

What a configuration uses cannot be removed under it:

- `deleteVariable` refuses while a parameter configures the variable or a row value mentions it
  (`variableUsers` lists the `cp#n` and `cfg#n` ids; `variableUses` has `parameter` and `row`
  entries).
- `renameVariable` updates the parameters that configure it and rewrites references in row
  values. `inlineVariable` rewrites row values too, and deletes the parameter that configures the
  variable (with every row's value for it) in the same batch: once inlined, the value is the same
  in every row.
- `deleteFeature` refuses while a suppression parameter names the feature (`blockers` lists the
  parameter ids); delete the parameter first in the same `batch`.
- `deleteConfigRow` refuses while an assembly instance of a part of this document is built in the
  row (`dependency`; `blockers` lists `<assembly id>/<instance id>`, as `rowInstances(doc, rowId)`
  does). Instances of pinned parts name rows of their own source and do not block.

A table left with no parameters, no rows and no active row is removed from the document, so
undoing the first configuration command gives back a document with no `configurations` key.

### Assemblies

A document holds assemblies (since version 7): instances of its part studios, or of parts pinned
from other documents, placed by mates between mate connectors. The mates are the ones the solver
of [ADR 0008](../../docs/adr/0008-assembly-mate-solver.md) solves (`packages/assembly`); core
stores them and never loads the solver.

```ts
interface Assembly {
  id: 'assembly#1'; // from the document's nextIds.assembly
  name: string;
  instances: Instance[];
  mates: Mate[]; // in creation order: the last is the newest
  explodedViews?: ExplodedView[]; // absent: none, never empty (since version 12; see Exploded views)
  nextIds: Record<string, number>; // `inst`, `mate`, `mc`, `r`, `explode`, `step`; only ever increase
}

interface Instance {
  id: 'inst#1';
  name: string;
  source: { part: string; configuration?: string } | DerivedSource; // a part here, or pinned
  bodies?: string[]; // the source part's bodies to show, by body id; absent: every body
  fixed: boolean; // fixed instances never move; they root the mate graph
  suppressed: boolean;
  pose: Pose; // the last solved pose (ADR 0008 decision 3)
}

interface Pose {
  translation: [number, number, number]; // mm, each within MAX_POSE_TRANSLATION (1e9)
  rotation: [number, number, number, number]; // unit quaternion [x, y, z, w], checked to 1e-6
}

interface Mate {
  id: 'mate#1';
  name: string;
  kind: 'fastened' | 'revolute' | 'slider' | 'planar' | 'cylindrical' | 'ball'; // MATE_KINDS
  a: MateConnector;
  b: MateConnector; // on another instance than a
  suppressed: boolean;
  limits?: { min?: StoredExpression; max?: StoredExpression }; // revolute (angles), slider (lengths)
}

type MateConnector = {
  id: 'mc#1';
  instance: string; // an instance of the same assembly
  flip?: boolean; // turn the z axis round (a half turn about x)
  rotate?: 1 | 2 | 3; // quarter turns about z
  offset?: { translation: [E, E, E]; rotation: [E, E, E] }; // E = StoredExpression, as a derived placement
} & (
  | { inference: 'centroid'; origin: FaceReference }
  | { inference: 'centre'; origin: FaceReference | EdgeReference } // circle, cylinder, cone, sphere
  | { inference: 'midpoint'; origin: EdgeReference }
  | { inference: 'vertex'; origin: VertexReference } // VertexRef: { faces: string[]; ordinal? }
);
```

**Why these shapes.** The mate kinds and their names are the solver's `MateKind`, and a `Pose` is
the solver's `Pose`, so T2.3c passes them through; `limits` hold expressions like every number a
user types (the solver's are radians and millimetres once evaluated). The poses are stored because
the solver needs a seed and they choose among solutions (a four-bar's two branches); the mates
define the result, so poses are output as much as input, and change on every solve that moves
something. Commit them with `setPoses` on drag end and after a mate edit, never per frame, or the
command log grows with every pointer move. A connector's `inference` decides what `origin` is,
so a vertex (`{ faces }`) and an edge (`{ faces, ends?, ordinal? }`) never have to be told apart
by shape. A connector belongs to its mate: deleting the mate deletes it, so no connector is ever
left unused. `configuration` on either source kind is a row id of the source's table for T2.4c,
which makes regen build it. For a part of this document the row must exist in this document's
table, checked at load and by every command (like `active`); for a pinned part it names a row of
the pinned document, which regen, not the load, checks.

**Names are the source part's.** A connector's `origin` and an instance's `bodies` name faces and
bodies of the instance's part (or of its pinned source), found at every regen like a feature's
references. So they are not read for this document's feature ids, and nothing in a part is
blocked by them: a connector whose face is gone is a regen error on its mate, which leaves the
instance free (T2.3c).

**Ids.** Assembly ids are `assembly#n` from the document's `nextIds.assembly`; inside an
assembly, instances are `inst#n`, mates `mate#n`, connectors `mc#n` and connector references
`r<n>`, from the assembly's own `nextIds` (`previewIds(assembly.nextIds, 'mc', 2)`), never
reused. Assembly, instance, mate and connector ids have at most 15 digits; connector references
use the same `ReferenceIdSchema` as feature references, with no digit cap of their own. There are
no split pieces in an assembly.

Validation refuses: an id at or past its counter, used twice in its assembly, or a split piece; an
instance of a part of this document that does not exist, or in a configuration row this
document's table does not have; a body listed twice in an instance's
`bodies`; a connector on an instance that is not in the assembly; a mate whose connectors are on
the same instance; an offset or limit expression that does not parse or names an unknown variable.
The schema refuses limits on a kind other than revolute and slider, limits with neither bound, a
rotation that is not a unit quaternion, a translation component beyond `MAX_POSE_TRANSLATION`, a
vertex `ordinal` below 1 or not an integer, a reference that does not suit the inference, and more
than `MAX_ASSEMBLY_ITEMS` (10,000) assemblies, instances per assembly or mates per assembly.

What an assembly uses cannot be removed under it:

- `deletePart` refuses while an instance in any assembly shows the part (`dependency`; `blockers`
  lists `<assembly id>/<instance id>`, as `partInstances(doc, partId)` does). An instance of a
  pinned part names no part of this document and does not block.
- `deleteInstance` refuses while a mate connects the instance (`blockers`: the mate ids;
  `instanceMates(assembly, id)` lists them), while a step of an exploded view moves it or reads
  its direction from it (`<assembly id>/<exploded view id>`; `instanceExplodedViews`). Delete or
  edit them first in the same `batch`. A drawing dimension that measures the instance does not
  block: regen reports it `lost` (`instanceDimensions(doc, assemblyId, id)` lists them, as
  `<drawing>/<sheet>/<dimension>`, so the app can warn).
- `deleteAssembly` refuses while a drawing view shows the assembly (`assemblyViews(doc, id)`).
- `deleteVariable` refuses while a connector offset or a limit reads the variable (`variableUsers`
  lists `<assembly id>/<mate id>`, and `variableMates(doc, name)` the mates). `renameVariable` and
  `inlineVariable` rewrite those expressions with `editMate`. `variableUses` lists each as a
  `mate` use (`{ kind: 'mate', assemblyId, mateId, path, expected }`), after the features.

`mateExpressions(mate)` lists a mate's expressions with the kind each expects, like
`featureExpressions`; `mateIds`, `mateConnectors`, `mateInstances`, `isPinnedSource` and
`instancePart` are the other generic views, in `src/features.ts`.

### Exploded views

An assembly may have exploded views (since version 12; M4 plan decision 9): named, ordered steps,
each moving a set of its instances along a direction by a distance. They are applied on top of the
solved poses for display (the viewport and drawings) and never change a stored pose or a mate.
Regen computes the offsets (T4.5a), one function for both callers.

```ts
interface ExplodedView {
  id: 'explode#1'; // from the assembly's nextIds.explode
  name: string;
  steps: ExplodeStep[]; // applied in order; moves add up
}

interface ExplodeStep {
  id: 'step#1'; // from the assembly's nextIds.step
  instances: string[]; // instances of the same assembly, each once, at least one
  direction:
    | { vector: Vec3 } // in the assembly frame; non-zero, only its direction counts
    | { instance: string; edge: EdgeRef; flip?: true } // a line edge's direction
    | { instance: string; face: FaceRef; flip?: true }; // a plane's normal or a cylinder's axis
  distance: StoredExpression; // a length
}
```

A reference direction names geometry of `instance`'s part, like a mate connector's origin, read at
the instance's solved pose; a lost one is a warning on the step at regen, never a load error.
Validation refuses an exploded view or step id at or past its counter or used twice in the
assembly, a step that moves an instance twice, an instance (moved, or read for a direction) that
is not in the assembly, and a distance that does not parse or names an unknown variable. The
schema refuses a zero vector, a step that moves nothing, `flip: false` (absent means not flipped),
an empty `explodedViews` and more than `MAX_ASSEMBLY_ITEMS` views per assembly, steps per view or
instances per step. `deleteExplodedView` refuses while a drawing view shows it
(`explodedViewViews(doc, assemblyId, id)`). `deleteVariable` refuses while a step distance reads
the variable (`variableUsers` lists `<assembly id>/<exploded view id>`, and
`variableExplodedViews(doc, name)` the views); `renameVariable` and `inlineVariable` rewrite them
with `editExplodedView`. `explodedViewIds`, `explodedViewExpressions`, `explodeStepInstances` and
`instanceExplodedViews` are the generic views, in `src/features.ts`.

### Print setups

A document holds print setups (since version 8, [ADR 0012](../../docs/adr/0012-3d-printing.md)
decisions 1 and 2): which bodies to print, on which printer and nozzle, oriented how, with which
printability thresholds.

```ts
interface PrintData {
  setups: PrintSetup[];
  nextIds: Record<string, number>; // `print`, `item`, `r`; only ever increase
}

interface PrintSetup {
  id: 'print#1'; // from print.nextIds.print
  name: string;
  printer: string; // a printer table id, 'bambu-a1-mini'; PRINTER_ID_PATTERN, checked at use
  nozzle: number; // mm, positive, at most MAX_NOZZLE (10)
  thresholds?: {
    overhang?: StoredExpression; // angle from vertical (60 deg is OrcaSlicer's 30 from horizontal)
    minWall?: StoredExpression; // lengths from here on
    minGap?: StoredExpression;
    minHole?: StoredExpression;
    teardrop?: StoredExpression; // horizontal holes above this diameter are flagged
  }; // absent: every default from the printer and nozzle; present: sets at least one
  items: PrintItem[];
}

interface PrintItem {
  id: 'item#1'; // from print.nextIds.item
  part: string; // a part id of this document
  body?: string; // a body id of that part; absent: every body of the part
  orientation:
    | { kind: 'asModelled' }
    | { kind: 'layFlat'; face: FaceReference; turn?: StoredExpression } // face down, then a turn about z
    | { kind: 'rotate'; x: StoredExpression; y: StoredExpression; z: StoredExpression }; // fixed x, y, z
  copies?: number; // 1 to MAX_PRINT_COPIES (1000); absent: one
}
```

**Why it is not a feature.** A setup changes no geometry: it chooses bodies, a printer and an
orientation. In the feature tree it would sit in regen order and dirty every regen after it, and
it would belong to one part while an item may print bodies of several. So it is document state
beside `parts` and `assemblies`, like M5's CAM setups will be. Regen never reads it, and
`diffDocuments` reports print edits in `printChanged` and `print`, never in `parts`. Nothing
derived from a setup is stored (ADR 0004 decision 1): no analysis, no transformed meshes, no
exports; `packages/print` computes those from the setup and regen's results.

**Print references never block modelling.** An item's `body` and a `layFlat` face name geometry
of the item's part, resolved when the print workspace uses the setup. Deleting, suppressing or
changing the feature that made either is always allowed; the workspace then reports the item as
`reference-lost` and offers a re-pick. Validation checks only that they are well formed (a body id
whose creator `bodyCreator` can read, a `FaceReference`), never that they exist. Likewise the
printer id is checked against the printer table (`packages/print`, which core does not import)
only at use, so the table grows without a format change and a document naming a printer this
build does not know still loads.

**Ids.** Setups are `print#n`, items `item#n` and `layFlat` face references `r<n>`, all from
`print.nextIds` (`previewIds(doc.print.nextIds, 'item')`), never reused, and separate from every
part's counters: a print `r3` and a part's `r3` are different references. Setup and item ids have
at most 15 digits; there are no split pieces in the print section.

Validation refuses: an id at or past its counter, used twice anywhere in the print section, or a
split piece; an item of a part that does not exist; a threshold or orientation expression that
does not parse or names an unknown variable. The schema refuses an unknown key, a printer id that
is not lower-case letters, digits, `.`, `_` and `-` (at most 64), a nozzle that is not positive or
above `MAX_NOZZLE`, empty `thresholds`, a `layFlat` without a face or on an edge, copies that are
not a whole number from 1 to `MAX_PRINT_COPIES`, and more than `MAX_PRINT_ITEMS` (10,000) setups
or items per setup.

What a setup uses:

- `deletePart` refuses while a print item prints the part (`dependency`; `blockers` lists
  `<setup id>/<item id>`, as `partPrintItems(doc, partId)` does). Only the part blocks; the body
  and face an item names never do.
- `deleteVariable` refuses while a threshold or an orientation angle reads the variable
  (`variableUsers` lists the setup id; `variablePrintSetups(doc, name)` the setups).
  `renameVariable` and `inlineVariable` rewrite those expressions with `editPrintSetup` and
  `editPrintItem`. `variableUses` lists each as a `print` use
  (`{ kind: 'print', setupId, itemId?, path, expected }`, `path` from the setup), after the mates.

`printSetupExpressions(setup)` lists a setup's expressions with the kind each expects (thresholds,
then items); `printThresholdExpressions`, `printItemExpressions`, `printSetupIds` and
`printItemIds` are the other generic views, in `src/features.ts`. `createPrintSetup(id, name,
printer, nozzle)` makes a setup with no items and default thresholds, and `findPrintSetup(doc,
id)` finds one.

### CAM

A document holds CAM tools and setups (since version 14,
[ADR 0014](../../docs/adr/0014-cam-architecture.md) decisions 2 to 6): the tools a job cuts with,
copied from a library, and per setup the body it machines, the stock, the work coordinate system,
the heights, the machine and post, and the operations in cut order. Nothing derived is stored: no
extracted loops, no toolpaths, no G-code (`packages/cam` computes those from this data and regen's
results).

```ts
interface CamData {
  tools: CamTool[];
  setups: CamSetup[];
  nextIds: Record<string, number>; // `tool`, `setup`, one per operation kind, `r`; only ever increase
}

interface CamTool {
  id: 'tool#1'; // from cam.nextIds.tool
  name: string;
  kind: 'flat' | 'ball' | 'bull' | 'vbit' | 'drill' | 'engraver';
  number?: number; // T<n>, 0 to MAX_CAM_TOOL_NUMBER (99,999)
  diameter: StoredExpression; // lengths, so `1/4"` works in a millimetre document
  fluteLength: StoredExpression;
  flutes: number; // 1 to MAX_CAM_FLUTES (32)
  cornerRadius?: StoredExpression; // a bull's, and required on it
  angle?: StoredExpression; // a V-bit's included angle (required) or a drill's point angle
  tipDiameter?: StoredExpression; // a V-bit's flat tip only
  presets: {
    material: string; // a material category, 'plywood'; each once per tool
    spindle: StoredExpression; // spindle speed, '18000rpm'
    feed: StoredExpression; // feed rates, '1500mm/min'
    plunge: StoredExpression;
    stepdown: StoredExpression; // a length
    stepover: StoredExpression; // a fraction of the diameter, '0.4'
  }[];
  source?: { library: string; id: string }; // where it was copied from
}

interface CamSetup {
  id: 'setup#1'; // from cam.nextIds.setup
  name: string;
  part: string; // a part id of this document
  body?: string; // a body id of that part; absent: its only body
  machine: string; // a machine table id, 'shapeoko-5-pro-4x4'; checked at use
  post: string; // a post id, 'grbl'; checked at use
  stock:
    | { kind: 'fromBody'; margins: { xMin; xMax; yMin; yMax; top; bottom }; material?: string }
    | { kind: 'explicit'; size: { x; y; z }; offset: { x; y; z }; material?: string }; // lengths
  wcs: {
    up:
      | { kind: 'axis'; axis: '+x' | '-x' | '+y' | '-y' | '+z' | '-z' }
      | { kind: 'face'; face: FaceReference };
    origin: {
      xy: 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'centre';
      z: 'top' | 'bottom';
    };
  };
  heights: { clearance: StoredExpression; retract: StoredExpression };
  operations: CamOperation[]; // cut order
}

// Every operation: id '<kind>#n' (from cam.nextIds.<kind>), kind, name, suppressed, tool (a tool
// id), geometry (sources, below), feeds? ({ spindle?, cut?, plunge?, ramp?, lead? }, overriding
// the tool's preset; sets at least one). Then per kind:
//   facing:    depth (removed from the stock top), stepdown?, stepover?, angle
//   profile:   side ('outside' | 'inside' | 'on'), depth, stepdown?, finishAllowance?,
//              tabs? ({ count, width, height }), entry, leadIn, leadOut, climb
//   pocket:    depth, stepdown?, stepover?, finishAllowance?, entry, climb,
//              finishPass? (boolean), finishStepdown?, floorAllowance?, floorPass? (boolean)
//   drill:     depth? (absent: each hole's), peck?, dwell? (seconds)
//   vcarve:    maxDepth?, stepdown?, flatStepover? (a length),
//              clearing? ({ tool (a flat or bull tool id), stepdown?, stepover?, entry?, feeds? })
//   surface3d: stepover (a length here), angle, allowance?, strategy? ('parallel' | 'zlevel'),
//              tolerance?, sampling?, pattern? ('zigzag' | 'oneway'), stepdown?, entry?,
//              climb? (boolean), sliceCell?
// depth: { kind: 'blind'; depth } | { kind: 'through'; extra? }
// entry: { kind: 'plunge' } | { kind: 'ramp'; angle } | { kind: 'helix'; angle; radius }
// lead:  { kind: 'none' } | { kind: 'line'; length } | { kind: 'arc'; radius }

type CamGeometrySource =
  | { kind: 'face'; face: FaceReference } // a planar face of the setup's body, 'r<n>' from cam.nextIds.r
  | { kind: 'region'; sketch: 'sketch#n'; entities?: string[] } // a sketch region; absent: every region
  | { kind: 'hole'; feature: 'hole#n' }; // a hole feature's points and through-hole diameter
```

Absent `stepdown`, `stepover` and feeds come from the tool's preset for the stock's material (a
V-carve clearing's from its own tool's). A drill takes only `hole` sources and the others faces and
sketch regions (a `facing` with none faces the whole stock top; a `surface3d` machines the setup's
body, and its faces and regions, when it has any, bound it in XY).

**Optional operation fields** (T5.5b, added to the version 14 schema in place: the format came in
with M5 and no released document lacks them, so there is no format bump or migration). Every one is
optional and absent means `packages/cam`'s default, so a document without them reads as before:
`pocket`'s finishing and floor choices (`PocketExtras`), `vcarve`'s stepdown, floor stepover and
floor clearing (`VCarveExtras`) and `surface3d`'s strategy and parallel or z-level settings
(`Surface3dExtras`). Booleans and choices are strict (`z.boolean()`, enums); the numbers are
`StoredExpression`s of the kind `camExpressions` lists, checked for range by the geometry stage like
every other CAM number. A V-carve's `clearing.tool` is a second tool reference: validation requires it
in `cam.tools` (`dependency`), `camToolUsers` counts it (so the tool cannot be deleted under it), and
`camOperationTools(op)` lists both of an operation's tools. "Profile" inside `cam`
always means the operation; the sketch region source is `region` (ADR 0014 decision 4).

**Why it is not a feature.** As for print setups: an operation changes no body, acts on the part's
final body whatever comes after it in the feature list, and is in cut order, not regen order. So
`cam` is document state beside `parts` and `print`. Regen never reads it, and `diffDocuments`
reports CAM edits in `camChanged` and `cam`, never in `parts`.

**CAM references never block modelling** (ADR 0014 decision 6). A setup's body, a WCS or source
face, a region's sketch and entities and a hole feature are names resolved when toolpaths are
generated. Deleting, suppressing, reordering or editing what they name is always allowed; the
operation then reports `reference-lost`. Validation checks only that they are well formed, never
that they exist; likewise machine, post and material ids are checked against `packages/cam`'s
tables only at use, so a document naming a machine this build does not know still loads.

**Ids.** Tools are `tool#n`, setups `setup#n`, operations `<kind>#n` (`profile#2`, `pocket#1`) and
face references `r<n>`, all from `cam.nextIds` (`previewIds(doc.cam.nextIds, 'pocket')`), never
reused, unique across the whole section (moving an operation to another setup keeps its id) and
separate from every part's and from `print`'s: a CAM `r3` and a part's `r3` are different
references. Ids have at most 15 digits; there are no split pieces in CAM.

Validation refuses: an id at or past its counter, used twice anywhere in `cam`, or a split piece; a
setup of a part that does not exist; an operation whose tool is not in `cam.tools`; a geometry
source of a kind the operation does not take (`kind-mismatch`); an expression that does not parse
or names an unknown variable. The schema refuses an unknown key or `nextIds` counter, an operation
id whose prefix is not its kind, a region of a feature that is not a `sketch#n` or a hole source
that is not a `hole#n`, the tool kind rules above, two presets for one material, table ids that are
not lower-case letters, digits, `.`, `_` and `-` (at most 64), names over 200 characters, an
expression source over `MAX_CAM_EXPRESSION` (10,000) characters, and more than `MAX_CAM_TOOLS`
(1000) tools, `MAX_CAM_SETUPS` (1000) setups, `MAX_CAM_PRESETS` (100) presets per tool,
`MAX_CAM_SOURCES` (1000) sources per operation, `MAX_CAM_REGION_ENTITIES` (10,000) entities per
region, and in the whole section `MAX_CAM_OPERATIONS` (10,000) operations and
`MAX_CAM_TOTAL_SOURCES` (100,000) sources. Commands refuse what would pass the section-wide
limits (`schema`), since validation does not rerun the schema.

What CAM uses:

- `deletePart` refuses while a setup machines the part (`dependency`; `blockers` lists the setup
  ids, as `partCamSetups(doc, partId)` does). Only the part blocks: delete or retarget the setup
  first (`editCamSetup` with another `part`).
- `deleteCamTool` refuses while an operation cuts with the tool (`dependency`; `blockers` lists
  `<setup id>/<operation id>`, as `camToolUsers(doc.cam, toolId)` does).
- `deleteVariable` refuses while a CAM expression reads the variable (`variableUsers` lists the
  tool id, the setup id for its stock and heights, `<setup id>/<operation id>` for an operation;
  `variableCamUsers(doc, name)` lists only those). `renameVariable` and `inlineVariable` rewrite
  them with `editCamTool`, `editCamSetup` and `editCamOperation`. `camVariableUses(doc, name)`
  lists each as `{ kind: 'camTool', toolId, path, expected }` or
  `{ kind: 'camSetup', setupId, operationId?, path, expected }` (`path` from the setup). They are
  kept out of `variableUses`, so code that switches over its kinds keeps working, as for drawings.

`camExpressions(op)` lists an operation's expressions with the kind each expects (`length`,
`angle`, `number`, `feed`, `spindleSpeed`: a `CamExpressionKind`, which adds the feed rate and
spindle speed of `@manufakture/units` to core's kinds), for evaluation by the app;
`camToolExpressions`, `camSetupOwnExpressions` (stock and heights) and `camSetupExpressions` (those,
then every operation's) are the others. `camSetupIds`, `camSetupOwnIds`, `camOperationIds`,
`camOperationReferences` and `camToolUsers` are the other generic views, in `src/features.ts`.
`createCamData()` makes an empty section, `createCamSetup(id, name, part, machine, post)` a setup
with no operations (stock from the body with no margins, Z up, origin at the front left of the
stock top, clearance 10 mm and retract 5 mm), and `findCamSetup` and `findCamTool` find them.

### Fonts

A document lists the fonts its texts use (since version 9; [ADR 0011](../../docs/adr/0011-fonts.md),
[ADR 0012](../../docs/adr/0012-3d-printing.md) decision 8). A text (an `outline` sketch entity,
see Sketch data) names its font by id.

```ts
interface DocumentFont {
  id: 'font#1'; // from the document's nextIds.font; never reused
  family: string; // 'Inter', read from the font when it was added; display only
  style: string; // 'Bold'
  source:
    | { kind: 'bundled'; id: string; sha256: string } // 'inter-bold' and the file's SHA-256
    | { kind: 'file'; fileName: string; size: number; sha256: string; data: string }; // base64
}
```

- **Bundled** fonts ship with the app (`packages/text`): the document records the id and the
  SHA-256 of the file the text was made with, and no bytes. A build whose file under that id has
  another hash still builds the text, with a warning, and misses the regen cache: an app update
  never changes geometry silently.
- **User** fonts (TTF or OTF) are stored like imported files: base64 `data`, at most
  `MAX_IMPORT_BYTES` (20 MiB), with the lower-case hex SHA-256 of the bytes, checked by regen
  before the font is read. Persistence moves the bytes to a content-addressed blob
  (`apps/web/src/persistence/README.md`). What the file is allowed to be used for is the user's
  business (ADR 0011 decision 7); the app shows its embedding permissions when it is added.

A document holds at most `MAX_FONTS` (1000) fonts, and its user fonts at most
`MAX_FONT_TOTAL_BYTES` (64 MiB) in all, the sum of their `size`: the count alone would let a
document claim 1000 fonts of 20 MiB each. A family of a dozen styles takes a few MiB, so the limit
leaves room for several families and a large CJK font or two. The schema refuses a document past
it, and `addFont` refuses a font that would take the document past it (`schema`, "The document's
fonts would hold ... MiB").

Validation checks that font ids are allocated and unique and that every outline's font is in the
list. `addFont` refuses a second copy of the same bytes (same SHA-256), and `deleteFont` refuses a
font an outline still uses (`fontUsers(doc, id)` lists them as `<part>/<sketch>/<entity>`), so a
font never disappears from under a text. `findFont(doc, id)` finds one. Fonts change no geometry
by themselves, so `diffDocuments` reports `fontsChanged` apart from the parts.

### Scripts

A document may carry a library of scripts that `scripted` features run (since version 16;
[ADR 0010](../../docs/adr/0010-scripting-sandbox.md) decision 8). Scripts are data in the
document; core never runs them (regen does, in QuickJS inside the regen worker).

```ts
interface Script {
  id: 'script#1'; // from the document's nextIds.script; never reused
  name: string; // display only, trimmed, 1 to 200 characters
  language: 'js' | 'ts'; // TypeScript is erased before it runs (ADR 0010 decision 7)
  apiVersion: number; // the script API version it was written against, from 1
  source: string; // as the user typed it
}
```

`apiVersion` is stored, never inferred: a script written against an API version runs unchanged,
with the same results, forever (ADR 0010 amendment, item 12), so a newer API never changes an old
script's geometry. Which versions exist is regen's to know; an unknown one is a feature error at
regen, not a load error. Whether a document's scripts may run on this device (the opt-in until the
security sign-off, T7.2d) is stored by the app per device, never in the document.

Limits, checked by the schema and by `setScript`: a source of at most `MAX_SCRIPT_SOURCE_BYTES`
(256 KiB) of UTF-8, at most `MAX_SCRIPTS` (256) scripts, and at most `MAX_SCRIPT_TOTAL_BYTES`
(4 MiB) of source in all. The library is absent when empty, never an empty list.

Validation checks that script ids are allocated and unique and that every scripted feature names a
script of the library (`dependency`, the script id in `blockers`). `setScript` creates (a fresh
`script#n`, at `index`, default last) or replaces by id; `deleteScript` refuses a script a
scripted feature runs (`scriptUsers(doc, id)` lists them as `<part>/<feature>`), and deleting the
last one drops `scripts`. `diffDocuments` reports `scriptsChanged` (ids added, removed or edited);
a script whose source, language or API version changed also marks every scripted feature that
runs it as changed in `parts`, with its `firstAffectedIndex`, so regen rebuilds it; a rename does
not.

### Domain data

A document may carry settings that belong to a domain but are not features (since version 11;
[ADR 0013](../../docs/adr/0013-domain-packages.md) decision 3): woodworking's kerf and trims under
`wood`, the document's stock overrides under `stock`.

```ts
interface DomainData {
  schemaVersion: number; // the domain's own version of `data`, from 1
  data: JsonValue; // validated and migrated by the domain package, never by core
}
```

`domains` is keyed by namespace, the first segment of an extension type (`wood` of `wood.board`):
`DOMAIN_NAMESPACE_PATTERN`, `^[a-z][a-z0-9-]*$`, at most `MAX_DOMAIN_NAMESPACE_LENGTH` (64)
characters, at most `MAX_DOMAINS` (1000) entries, never an empty record (no domain data means no
`domains` key). `data` is any JSON nested at most `MAX_DOMAIN_DATA_DEPTH` (32) levels of arrays and
objects; deeper data is a `schema` error, checked without recursion. Core checks only this envelope: an entry of a
namespace no domain claims, or with a `schemaVersion` newer than its domain knows, loads and is
kept as it is; the domain reports what it cannot read. Domain data holds settings, not model: no
face names, feature or body ids, or variable uses, so no core command ever looks inside `data`
(the domain's validator enforces this). There is no `expressions` record on an entry. Absent
`domains` means no domain data.

Rules for domain packages reading and writing `domains`:

- Look a namespace up with `Object.hasOwn(doc.domains ?? {}, ns)`, never `ns in doc.domains` or a
  bare `doc.domains[ns]` truthiness test, so an inherited name such as `constructor` is never
  mistaken for an entry.
- `data` must not contain an object shaped like a stored source, which the app's file store treats
  as a reference to a stored file and rewrites on save: an object with a `source` object and
  `kind` `import` or `derived` and a string `id`; an object whose `id` is a font id (`font#n`)
  and whose `source` has `kind: 'file'`; or any object whose `source` has string `documentId`,
  `versionId` and `partId`. Settings never need these shapes; avoid the key `source` with an
  object value altogether.

`setDomainData { namespace, schemaVersion, data }` replaces a namespace's entry whole; without
`schemaVersion` and `data` it removes the entry, and removing the last one drops `domains`. Adding
a new namespace to a document that already holds `MAX_DOMAINS` entries is refused (`schema`);
replacing or removing an entry at the cap works. Its
inverse sets the old entry back (or removes it), so every change is one undo step. `null` is data
like any other, not a removal. `diffDocuments` reports the namespaces whose entry changed in
`domainChanged`, apart from the parts and with no `firstAffectedIndex`: core cannot tell which
features a domain setting affects. There is no per-domain hook: regen marks dirty every extension
of a domain that may read the namespace (for `stock`, every `wood.*` extension), and the cache
sorts out which really changed (ADR 0013 decision 5). `serialize`
writes namespaces and the keys of every object in `data` sorted, so equal documents save as the
same text.

### Drawings

A document may hold drawings (since version 12; M4 plan decision 7, the dimension model of the
[T4.4a spike](../../docs/spikes/T4.4a-hlr.md)): sheets of views of its parts and assemblies, with
dimensions and notes. Drawings are generic (woodworking, and later construction, use the same
ones) and are document state, not features: a drawing changes no geometry. Nothing derived is
stored (ADR 0004 decision 1): regen computes each view's hidden-line projection and resolves each
dimension on request (T4.4e), and `packages/drawing` lays them out on paper from its own input
types, which regen fills from these.

```ts
interface Drawing {
  id: 'drawing#1'; // from the document's nextIds.drawing
  name: string;
  sheets: Sheet[]; // in page order
  nextIds: Record<string, number>; // `sheet`, `view`, `dim`, `note`; per drawing, never reused
}

interface Sheet {
  id: 'sheet#1';
  name: string;
  size: 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'letter' | 'tabloid' | { width: E; height: E }; // E = StoredExpression (lengths)
  orientation: 'landscape' | 'portrait'; // the longer side across, or up; a custom size too
  titleBlock?: { fields: { label: string; value: string }[] }; // absent: no title block
  views: DrawingView[];
  dimensions: Dimension[]; // in drawing order
  notes: Note[];
}

interface DrawingView {
  id: 'view#1';
  label?: string; // a caption, 'SECTION A-A'
  source:
    | { part: string; bodies?: string[] }
    | { assembly: string; explodedView?: string }
    | { domain: string; part: string; schemaVersion: number; params: Json }; // since version 15
  direction:
    | 'front'
    | 'back'
    | 'left'
    | 'right'
    | 'top'
    | 'bottom'
    | 'isometric'
    | { direction: Vec3; up: Vec3 };
  scale: { paper: E; model: E }; // 1:5 is paper 1, model 5; 1-1/2" = 1' is paper 1-1/2", model 1'
  position: [number, number]; // paper mm from the sheet's bottom-left corner, of the projected model origin
  options: { hidden: boolean; smooth: boolean; section?: { normal: Vec3; offset: E } };
}

type DimensionRef = ({ vertex: VertexRef } | { edge: EdgeRef } | { face: FaceRef }) & {
  body: string; // a body id of the view's part, or of the instance's part
  instance?: string[]; // assembly views only: the instance path, today one instance id
};

type Dimension = {
  id: 'dim#1';
  view: string; // a view on the same sheet
  text?: string; // replaces the value; `<>` stands for the value
  decimals?: number; // 0 to 12, for decimal lengths and angles; absent: the display units'
  denominator?: 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128; // for ft-in and in-fraction
} & (
  | {
      kind: 'horizontal' | 'vertical' | 'aligned';
      refs: [DimensionRef, DimensionRef];
      offset: number;
    }
  | { kind: 'radius' | 'diameter'; refs: [EdgeOrFaceRef]; at: [number, number] }
  | { kind: 'angle'; refs: [EdgeOrFaceRef, EdgeOrFaceRef]; at: [number, number] }
);

interface Note {
  id: 'note#1';
  view?: string; // attached: `position` is from the view's position, so it moves with the view
  position: [number, number]; // paper mm
  text: string; // 1 to MAX_NOTE_TEXT (10,000) characters
}
```

**Directions.** `STANDARD_VIEWS` gives each named view's `direction` (the way the viewer looks,
from the eye into the model) and `up`, for a Z-up model in third-angle convention, as the spike
used: front looks along +Y, right along -X, top down -Z, and isometric looks down from the front
right. A custom direction gives both vectors (non-zero, not parallel). Views are orthographic.

**Domain views** (since version 15; M6 plan T6.4a): a view whose source is
`{ domain, part, schemaVersion, params }` is drawn by the domain that owns the namespace (the
construction domain's floor plans, framing elevations and roof framing plans). `params` is opaque
JSON at the domain's own `schemaVersion`, nested at most `MAX_VIEW_PARAMS_DEPTH` (8) levels and at
most `MAX_VIEW_PARAMS_LENGTH` (16,384) characters as JSON, both checked without recursion. Core
checks the envelope and that the part exists; the domain checks its params when regen draws the
view, and chooses the view's frame and section from them, so `direction` and `options.section`
are not used for such a view. A domain view's source also has `part`, so a test of `'part' in
source` matches it: test `isDomainViewSource(source)` first. It blocks deleting its part like a
part view (`partViews` lists it). Nothing a domain view draws is stored: its dimension strings are
derived at every request (ADR 0015).

**Scale and position.** The scale is two length expressions so imperial scales keep their text and
a scale can read a variable; the ratio is what they evaluate to. A view's `position` places the
projection of the model origin, not the projected geometry's centre, so editing the model never
moves a view on the sheet. A section view cuts the model by the plane at `offset` along `normal`
from the origin and removes the side `normal` points to.

**Dimensions store model references only** (T4.4a): the kernel's `VertexRef`, `EdgeRef` and
`FaceRef`, with the body they are on and, in an assembly view, the instance. Regen resolves them
like a feature's references and measures and projects their exact geometry; values are never
stored, so a dimension follows model edits and is `lost` (never moved) when a reference is.
How each kind is stored, which settles the spike review's open points:

- **Linear** (`horizontal`, `vertical`, `aligned`): two references, each anchoring at a point (a
  vertex; a line edge's midpoint; a circular edge's centre) or, for a planar face, a plane.
  Between two planar faces the dimension stores both face references and nothing else, and its
  value is the distance between the planes along the first face's normal (regen warns when they
  are not parallel); a point and a plane measure along the plane's normal. `offset` places the
  dimension line: the signed distance in paper mm from the first anchor, along the measuring
  direction turned a quarter turn counter-clockwise (for `horizontal`, upwards).
- **Angle**: two references, each a line edge or a planar face (a plane seen edge on is a line);
  never a vertex. The arc is centred where the two projected lines meet, and `at` is a point on
  it in paper mm from there: its length is the arc's radius, and its direction picks which of the
  four angles is meant (the one containing `at`).
- **Radius and diameter**: one circular edge or cylindrical face. Their leader is placed by a 2D
  point, `at`, not a scalar offset: where the value's text sits, in paper mm from the projected
  centre (a circle seen face on) or from the midpoint of the projected axis (a cylinder seen
  across, drawn between its two silhouettes). Both the leader's angle and its length come from it.
- Text, `decimals` and `denominator` override the document's display units for one dimension;
  values are formatted with `packages/units`.

**What blocks what.** A view's source blocks: `deletePart`, `deleteAssembly` and
`deleteExplodedView` refuse while a view shows what they delete (`dependency`, `blockers` as
`<drawing id>/<sheet id>/<view id>`; `partViews`, `assemblyViews`, `explodedViewViews` list them),
unless the views are deleted or changed first in the same `batch`. A dimension's model references
never block: deleting, suppressing or changing the feature that made a body, face, edge or vertex
always succeeds, and regen's drawing stage reports the dimension `lost` (like print references and
M5's CAM references), so validation checks only that they are well formed. That holds for
instances too: in an assembly view each reference names one instance, but `deleteInstance` still
succeeds while a dimension measures it, and the instance is not checked against the view's
assembly (`instanceDimensions` lists the dimensions on an instance). A view's `bodies` are not
checked against the part either. Inside a sheet, `deleteView` refuses while a dimension or note is
in the view (`blockers`: their ids); deleting a sheet or a drawing takes everything on it.

**Ids.** Drawings are `drawing#n` from the document's `nextIds.drawing`; inside a drawing, sheets
are `sheet#n`, views `view#n`, dimensions `dim#n` and notes `note#n`, from the drawing's own
`nextIds`, unique across the drawing's sheets and never reused. All have at most 15 digits.

Validation refuses: a drawing id at or past its counter or used twice; an id inside a drawing at
or past its counter or used twice in it; a view of a part, assembly or exploded view that does not
exist; a body listed twice in a view; a dimension or note in a view that is not on its sheet; a
dimension reference with an instance in a part view, without one (or with a path of more than one
instance) in an assembly view; a sheet
size, scale or section offset that does not parse or names an unknown variable. The schema refuses
an unknown sheet size or key, a zero or parallel custom direction, a zero section normal, a vertex
for a radius, diameter or angle, a linear dimension placed by `at` or another kind by `offset`,
empty texts and labels, a paper coordinate or offset beyond `MAX_PAPER_COORDINATE` (1 km), more
than `MAX_TITLE_FIELDS` (100) title fields, an empty `drawings`, and more than
`MAX_DRAWING_ITEMS` (10,000) drawings, sheets per drawing, or views, dimensions or notes per sheet.

`deleteVariable` refuses while a sheet size, a view scale or a section offset reads the variable
(`variableUsers` lists the drawing id; `variableDrawings(doc, name)` the drawings), and
`renameVariable` and `inlineVariable` rewrite them with `editSheet` and `editView`.
`drawingVariableUses(doc, name)` lists each use in an exploded view or a drawing with its path; it
is apart from `variableUses` so that code switching over every `VariableUse` kind keeps working.
`drawingExpressions`, `sheetExpressions`, `viewExpressions`, `sheetIds`, `dimensionInstances` and
`forEachView` are the generic views, in `src/features.ts`; `createDrawing(id, name)` makes an
empty drawing and `findDrawing(doc, id)` finds one.

### Materials

`MATERIALS` (`src/materials.ts`) is the built-in table: PLA, PETG, ABS, pine, oak, plywood, MDF,
aluminium 6061 and steel, each with an `id`, a display `name`, a `category`, a **typical** density
in kg/m3, the range stock is usually found in where it varies notably, and the `source` the value
comes from (maker data sheets for the plastics and aluminium, The Wood Database for pine and oak,
EN 1993-1-1 for steel). Real stock varies with species, moisture, maker and infill, so a mass
computed from these is an estimate. `findMaterial(id)` looks one up and `massGrams(mm3, kgPerM3)`
turns a volume into grams.

A part stores only the id (`material`), set with the `setMaterial` command. It is the default for
the part's bodies; a body can override it in `Part.bodies` with `setBodyProps` (see Bodies). Ids
are permanent: the table
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
  path and expected kind (and `constraintId` for a sketch dimension); then mates, print setups and
  configurations (see Assemblies, Print setups and Configurations). Uses in exploded views and
  drawings are listed by `drawingVariableUses(doc, name)` (see Drawings); both edits below
  rewrite them too.
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

Assemblies have their own counters, per assembly (see Assemblies): `inst`, `mate`, `mc`, `r`,
`explode` and `step`. The print section has its own too (see Print setups): `print`, `item` and
`r`. So does each drawing (see Drawings): `sheet`, `view`, `dim` and `note`.

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

#### Construction member ids (M6)

Framing members are data, not bodies ([ADR 0015](../../docs/adr/0015-construction-domain.md)
decision 4): they have no counter and no face names. A member's full id is
`<owner feature id>:<local id>` (decision 6): the owner is the wall, opening, floor or roof
feature the member belongs to, so every full id holds exactly one feature id, at its front, and a
local id may itself contain a colon (split at the first colon only). The wall framing generator
(`@manufakture/domain-construction`, T6.2a) defines these local id forms, stable by role and
layout and fragile by design. Nothing in the document stores them except per-member overrides in
the owner's params, keyed by local id, which report `lost` when their member disappears.

| Owner   | Local id form                                                                               | Full id example            | Meaning                                                                    |
| ------- | ------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| wall    | `s<k>`                                                                                      | `extension#3:s12`          | Stud layout slot k                                                         |
| wall    | `bottom<c>:<n>`, `top<c>:<n>`                                                               | `extension#3:top1:2`       | Plate course c, piece n (splices)                                          |
| wall    | `block<r>:<n>`                                                                              | `extension#3:block1:4`     | Blocking row r, block n                                                    |
| wall    | `start:<m>`, `end:<m>`                                                                      | `extension#3:start:corner` | Corner framing at an L corner (`corner`, `corner-2`, `backing<r>`)         |
| wall    | `t<i>:<m>`                                                                                  | `extension#3:t1:corner-l`  | Framing at the i-th tee (`corner-l`, `corner-r`, `corner-c`, `backing<r>`) |
| wall    | `seg<n>/<id>`                                                                               | `extension#3:seg2/s0`      | Any wall form, in segment n >= 2 of a multi-segment wall                   |
| opening | `king-l`, `jack-r2`, `header`, `header-2`, `spacer`, `sill`, `cripple-a<n>`, `cripple-b<n>` | `extension#7:king-l`       | The opening's own members                                                  |

Each member has one spelling (`king-l`, never `king-l1`; `header`, never `header-1`). Since the
only feature id is the owner in front, M7's name parser and id remap (T7.1a) treat a member id as
any other `<feature id>:<suffix>` name and need nothing inside `params`. Core has no name parser
or remap yet, so these forms live in `domain-construction` (`parseWallMemberId`,
`parseOpeningMemberId`, `splitMemberFullId`) until T7.1a picks them up.

#### Construction layer bodies and member references (M6)

Two more forms come from the wall and opening features (`construction.wall`,
`construction.opening`, T6.1b; [ADR 0015](../../docs/adr/0015-construction-domain.md) decisions 3
and 6). Neither changes the document's shape, so neither needs a format bump.

| Form                         | Example                       | Where it appears                                                                                                         |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<feature id>:layer/<layer>` | `extension#3:layer/sheathing` | A body id: one body per sheet layer of a wall, `<layer>` the layer id from its wall type; in `scope`, `bodies` and props |
| `<feature id>:<local id>`    | `extension#7:king-l`          | A member reference: the owner's per-member overrides store the local id only (`king-l`), keyed in the owner's params     |

- **Layer bodies** are extension bodies under a key (see Bodies), so `bodyCreationProblem` and
  `bodyCreator` read them like any `<id>:<key>` body: the creator is the id up to the first `:`.
  An opening, which has no operation, lists the layer bodies it cuts in its `scope`, so
  `featureDependencies` counts the wall through them as well as through `dependsOn`. Their face
  names are `extension#3:side:<layer>.ext<i>` and `.int<i>` (the exterior and interior faces along
  segment i), `.start` and `.end` (an open wall's ends), and `extension#3:cap.<layer>:start` and
  `:end` (bottom and top); an opening's cuts add `extension#7:<layer>:<role>`. Every one starts
  with exactly one feature id, so `featureIdsInName` reads it. Removing a layer from a wall type
  loses the body and the references to its faces, as removing any body does.
- **Member references** name exactly one feature, the owner at the front; the overrides inside
  the owner's params hold only the local id, so nothing inside `params` names a feature.
- Core has no name parser or id remap yet; M7's T7.1a takes both forms from here.

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
interface VertexRef {
  faces: string[]; // the sorted names of the faces around the vertex (the kernel's `vertexName`)
  ordinal?: number; // only when two vertices share the same faces; 1-based, fragile
} // since version 7, for mate connectors only
```

Fields that must be a face or an edge use `FaceReference` or `EdgeReference`, and a connector on a
vertex uses `VertexReference`. Face and edge names
themselves, and how a reference resolved, are derived data and never stored.

## Features

Every feature has `id`, `kind`, a display `name` (1 to 200 characters) and `suppressed`. The
union is discriminated by `kind`.

| Kind        | Inputs                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sketch`    | `plane` (explicit `origin`, `normal`, `xDir`, or a `face` reference), `entities`, `constraints`                                                                                                                                                                        |
| `extrude`   | `profile`, `operation` (`new`, `add`, `cut`, `intersect`), `extent`, `reverse`, optional `draft` (angle; + tapers inward)                                                                                                                                              |
| `revolve`   | `profile`, `axis` (a line of the sketch or an edge reference, each with optional `flip`), `angle`, `symmetric`, `operation`                                                                                                                                            |
| `fillet`    | `edges` (edge references), `radius`                                                                                                                                                                                                                                    |
| `chamfer`   | `edges`, `distance`, optional `secondDistance` or `angle` (not both)                                                                                                                                                                                                   |
| `shell`     | `faces` to remove (face references), `thickness`, `outward`                                                                                                                                                                                                            |
| `hole`      | `sketch` and its `points`, `diameter`, `extent` (blind depth or through all), `head` (simple, counterbore, countersink), optional `standard` (`size`, `fit`)                                                                                                           |
| `pattern`   | `features` to repeat, or `body: true` (and no features) for the bodies with an optional `mode` (`new`, `add`), `layout` (linear: direction, count, spacing; circular: axis, count, angle; `flip`)                                                                      |
| `mirror`    | `features`, or `body: true` with an optional `mode`, `plane` (a planar face reference)                                                                                                                                                                                 |
| `extension` | a domain feature: `extension` type (`wood.board`), `schemaVersion`, `dependsOn`, `references`, `expressions`, opaque JSON `params`, optional `operation` (`new`, `add`, `cut`, `intersect`) and `scope` (since version 11)                                             |
| `import`    | `source` (the imported file: `format` `step` or `stl`, `fileName`, `size`, `sha256`, base64 `data`), `operation` (`reference`, `new`, `add`, `cut`, `intersect`)                                                                                                       |
| `derived`   | `source` (the pinned version: `documentId`, `documentName`, `versionId`, `versionName`, `partId`, optional `configuration`, `size`, `sha256`, text `data`), optional `bodies`, `placement` (`translation`, `rotation`), `operation` (`new`, `add`, `cut`, `intersect`) |
| `thread`    | `face` (a cylinder), optional `start` (a circular edge of it), `length` (an expression or `'full'`), `standard` (`system` `iso-metric` or `unc`, `size`), `hand` (`right`, `left`), `clearance` (diametral), `representation` (`modelled`, `cosmetic`)                 |
| `scripted`  | `script` (a `script#n` of the library), `params` (values by parameter name), `seed` (an unsigned 32-bit integer), `dependsOn` (since version 16)                                                                                                                       |

A `profile` is `{ sketch, entities? }`: the sketch feature and the entities bounding the chosen
regions (absent: every closed region). Extrude extents are `blind`, `symmetric` (total depth,
centred), `throughAll` and `upToFace`.

Extrude, revolve, import, hole, derived, and pattern and mirror with `body: true`, also take an
optional `scope` (since version 4; see Bodies), and so does an extension (since version 11). A thread acts on the body owning its face and
takes none.

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

`extension` is the extension point for domain packages ([ADR 0013](../../docs/adr/0013-domain-packages.md)):
core validates its dependencies, references, expressions, `operation` and `scope` like any other
feature's, and leaves `params` to the domain package that owns the type. `operation` says how the
extension's solid combines with the part, as for an extrude; with `new` or `add` the extension
creates bodies (see Bodies). Without an `operation` it makes no solid of its own to combine, but
it may still change the bodies in its `scope`.

`scripted` runs a script of the document's library (see Scripts; ADR 0010 decisions 3, 6 and 8).
`params` holds one value per parameter the script declares, keyed by its name (an identifier, at
most 64 characters, at most `MAX_SCRIPT_PARAMS` (256) values): `{ kind: 'expression', expression }`
for `length`, `angle` and `number` parameters (variables and units like any field; core checks
them as untyped, `any`, since only the script knows the kind), `{ kind: 'boolean', value }`,
`{ kind: 'choice', value }`, or `{ kind: 'reference', references }` with references whose `r<n>`
ids come from the part's counter like any feature's. Whether the values fit the declarations is
regen's to check by running the script. `seed` (0 to `MAX_SCRIPT_SEED`) seeds the script's
`Math.random` together with the source hash, never with the feature id, so a remap or a merge never
changes geometry. A scripted feature depends on `dependsOn`, on every feature its reference names
mention, and needs its script to exist. Every face it makes is named
`<feature id>:<operation id>/<name>` (decision 6; `scriptOperationPrefix`), for example
`scripted#2:boss/cap:end`, and every body `<feature id>:<operation id>` (`scripted#2:boss`). The
operation id matches `SCRIPT_OPERATION_ID_PATTERN` (a lower-case letter, then letters, digits and
`_`, at most 64 characters); `scriptOperationOf(name)` reads the prefix back (null past that
limit). See Face names for how the parser and the remap treat it. `serialize` writes `params`
sorted by name.

### Threads

A `thread` feature (since version 10; [ADR 0012](../../docs/adr/0012-3d-printing.md) decision 9)
threads a cylindrical face: a shaft gets an external thread, a hole an internal one, told apart by
the side of the face the material is on. It acts on the body that owns the face, like a fillet,
so it has no `scope`. `start` is a circular edge of the face, the end the thread starts from
(absent: the end at the face's first neighbour by name, the top of a lone extruded cylinder,
whose `cap:end` sorts before `cap:start`; the schema refuses an edge that is not on the face); `length` runs from there, or
`'full'` for the whole face. `standard.size` names a size of the kernel's thread table
(`THREAD_SIZES`: `M6`, `#10-24`, `1/4-20`, UNC sizes with or without their threads per inch).
Core does not check it: regen refuses a size it does not know, so adding sizes never changes the
format (ADR 0012 decision 14). `clearance` is diametral, like the fit variables (`#fit_slip`), and
the app defaults it to `#fit_slip` when the document has that variable. `representation` is
`modelled` (real helical geometry) or `cosmetic` (the cylinder resized to the tap drill or to the
major diameter less the clearance, the thread only drawn); regen and the kernel build both
(`packages/regen/README.md`, "Threads").

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
- The hash makes storing the bytes apart mechanical, and the app's persistence (T1.12) does so
  without a format change: in storage and in `.mfk` files each `source` loses `data` and the
  bytes go to a content-addressed blob keyed by `sha256`, checked when they are put back on load
  (`apps/web/src/persistence/README.md`). In memory the document keeps `data` inline, so core,
  regen and the kernel are unaffected.

The cost is size: base64 is 4/3 of the file, in every saved copy and in the undo history's
snapshots (which share it, since documents are immutable). The app refuses files over the same
`MAX_IMPORT_BYTES`, which is below the kernel's own STEP limit (`MAX_STEP_BYTES`, 64 MiB).

### Derived parts

A `derived` feature (since version 6) brings bodies of a part of another document into this one,
or of another version of this document, pinned to a named version (`apps/web/src/persistence`,
"versions"). `source` names what is pinned: `documentId` and `versionId` (the version's id is
permanent), `partId`, and for display `documentName` and `versionName` as they were when the pin
was made. `configuration` is a row id of the source's configuration table to build it in; nothing
writes it yet, and regen checks it against the source, not the load. `bodies` lists the source
part's bodies to derive by their ids in the source (absent: every body); `placement` moves them,
a rotation by `rotation` (angles about the fixed x, y and z axes, in that order, about the
origin) and then a translation by `translation` (lengths), all expressions like any other; and
`operation` and `scope` combine them with the part like an import's.

**The pinned document is in the document.** `source.data` is the canonical JSON text
(`serialize`) of the source document at that version, its imports inline, with `size` its UTF-8
length in bytes and `sha256` the lower-case hex SHA-256 of those bytes. The reasoning is the one
for imported files (above): the pin is input, not cache, since nothing in this document can
rebuild it, so it lives in the document, and undo, save, copy and export just work, with no store
beside the document to keep in step. Storage moves `data` out by hash the same way, so each
pinned version is one blob per document (`apps/web/src/persistence/README.md`). Load checks the
envelope only: the hash format, `size` against the UTF-8 length of `data` (counted without
encoding it, after refusing a text longer than `MAX_DERIVED_BYTES`, 64 MiB, since a UTF-8 length
is never less than the text's), and the other fields' shapes. The nested document itself is not
opened at load: regen checks the hash, migrates, validates and builds it, and reports what is
wrong on the feature, as for imports (`packages/regen/README.md`, "Derived parts").

**Cycles are impossible.** A pin names an immutable snapshot, not a live document, so a document
can derive from an older version of itself, and a chain of pins can never lead back to the
version being edited. Deep nesting (a source deriving from a source, and so on) multiplies the
work of a regen; it is capped at `MAX_DERIVED_DEPTH` (8), checked by regen as it opens sources.

**Names from the source.** A derived body is `<id>:from/<source body id>` (see Bodies), and its
faces are named `<id>:from/<source face name>`. Everything after `<id>:from/` is a name in the
source document, whose feature ids are not features of this part, so `featureIdsInName` reads it
as `<id>` alone: `derived#1:from/extrude#1:cap:end` depends on `derived#1` and never on a local
`extrude#1`, which may not exist or may come later (see Dependencies). No stored reference had
this form before, so `NAMING_SCHEME` stays 1.

### Sketch data

A sketch stores its geometry and constraints as plain data in exactly the shape of the sketch
model in `@manufakture/sketch/model`, which the solver loads
([ADR 0003](../../docs/adr/0003-sketch-solver.md)). Coordinates are the last
solved values, in millimetres in the sketch plane's 2D frame: they seed the solver and pick which
solution the sketch settles into; the constraints define it. The plane is an explicit
`{ origin, normal, xDir }` (the sketch package's `SketchPlacement`) or a face reference.

| Entity    | Fields                                                                              |
| --------- | ----------------------------------------------------------------------------------- |
| `point`   | `position`                                                                          |
| `line`    | `start`, `end` (lines own their endpoints, FreeCAD style)                           |
| `circle`  | `center`, `radius`                                                                  |
| `arc`     | `center`, `start`, `end` (counter-clockwise; radius is derived)                     |
| `outline` | `anchor`, `angle` (radians), `source` (since version 9; text or SVG art, see below) |

Every entity also has `id` and `construction`. Constraints name geometry in two ways: a curve is
an entity id, and a point is a `PointRef { entity, at? }`, where `at` is `start` or `end` (lines,
arcs), `center` (circles, arcs) or `anchor` (outlines) and is absent for a point entity. The built-ins `@origin` (a
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

**Outlines** ([ADR 0012](../../docs/adr/0012-3d-printing.md) decision 7) are closed shapes from a
source, placed at `anchor` and turned by `angle` about it. The anchor is solved like a point, so
constraints can place a text; `angle` and the shape are not solved. Regen lays the source out and
turns it into regions at every regen. Two source kinds exist, text and (since version 13, M5 T5.8)
SVG artwork:

```ts
source: {
  kind: 'text';
  text: string; // line breaks start lines; at most MAX_OUTLINE_TEXT (1000) code points
  font: string; // a font id of the document, 'font#1'
  size: StoredExpression; // cap height (the height of "H"), a length
  align: { horizontal: 'left' | 'center' | 'right'; vertical: 'baseline' | 'middle' | 'top' };
  letterSpacing?: StoredExpression; // a length; absent: 0
  lineSpacing?: StoredExpression; // a multiple of the font's line height, a number; absent: 1
}
```

```ts
source: {
  kind: 'svg';
  fileName: string; // the file it came from, for display; at most 255 characters
  paths: { fillRule: 'nonzero' | 'evenodd'; commands: PathCommand[] }[]; // see below
  scale?: StoredExpression; // a plain number multiplying the paths about the anchor; absent: 1
}
```

An SVG source holds the file's shapes already read (`@manufakture/io`'s `svgOutlinePaths`): one
path per shape, its commands `moveTo`, `lineTo`, `quadTo`, `cubicTo` and `close` (the sketch
model's `PathCommand`) in millimetres in the outline's own frame (the anchor at the origin), at
scale 1, with the shape's fill rule. The document stores no SVG text, so loading one parses no
XML: the schema checks every coordinate is a finite number and caps a source at
`MAX_SVG_OUTLINE_PATHS` (20,000) paths and `MAX_SVG_OUTLINE_COMMANDS` (100,000) commands, and
validation caps all the SVG outlines of one sketch together at `MAX_SKETCH_SVG_COMMANDS` (100,000).
Regen bounds the work of turning them into regions (regen README, "Text").

The text of all outlines of one sketch together is capped at `MAX_SKETCH_OUTLINE_TEXT` (10,000
code points): layout and kerning cost grow with it, and the string comes from the document. An
outline's id takes no split suffix (its glyph edge ids are built on it). `featureExpressions`
lists `size`, `letterSpacing` and `lineSpacing` (and an SVG source's `scale`, a number) at
`['entities', i, 'source', ...]`, so they are checked, renamed and inlined like any other
expression. Only text uses fonts: an SVG outline never blocks deleting one.

### One source of truth for sketch types

The sketch data types are defined once, in `@manufakture/sketch/model`: `SketchEntity` (and
`PointEntity`, `LineEntity`, `CircleEntity`, `ArcEntity`, `OutlineEntity` with its
`OutlineSource`, `TextOutlineSource`, `SvgOutlineSource`, `SvgOutlinePath`, `PathCommand` and
`OutlineAlign`), `SketchConstraint`, `ConstraintKind`,
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
(profiles, hole sketches, patterned and mirrored features, `dependsOn`), every feature whose id
starts a face name in one of its references (`extrude#1:cap:end`, including names nested in
merges and corners), and the creator of every body in its `scope` (by `bodyCreator`, never by
reading the body id as a face name).

`featureIdsInName(name)` splits a name into members at `+` in a merge `(A+B)` and at `&` in a
corner `A&B&C`, keeping parenthesised groups whole, and reads every feature id that starts a name
in a member, up to its first `<id>:from/`. That `<id>` counts; the rest of the member (a name,
or one group) is a name in a derived part's source and is skipped. So
`(derived#1:from/extrude#1:cap:end+extrude#2:side:e5)` gives `derived#1` and `extrude#2`,
`pattern#7:i2/derived#1:from/extrude#3:side:e1` gives `pattern#7` and `derived#1`, and a corner
of the source, whose members are each prefixed
(`derived#1:from/fillet#3:corner:A&derived#1:from/B`), gives `derived#1` alone.

The scan is one pass with a stack of open groups, linear in the name's length and with no
recursion. The schema caps a stored face name at `MAX_FACE_NAME_LENGTH` (4096) characters and
`MAX_FACE_NAME_DEPTH` (32) nested brackets, so a hostile name is a `schema` error at load rather
than work for the parser; the longest name the kernel's golden and bracket tests produce is 84
characters with one level of brackets.
Body ids are capped the same way: `MAX_BODY_ID_LENGTH` (4096) characters, and at most
`MAX_BODY_LIST` (10,000) entries in a `scope`, a derived feature's `bodies` and a part's `bodies`
props.

The rule, checked on every command and on load:

- **A feature comes after everything it depends on.** Every dependency must exist in the part and
  sit earlier in the list.
- **Reorder** refuses to move a feature before one of its dependencies, or after one of its
  dependents, and names them in `error.blockers`.
- **Delete** refuses while any feature depends on the one being deleted; delete the dependents
  first, or edit them to drop the reference. It also refuses while `Part.bodies` has props for a
  body the feature makes (`blockers` lists the body ids); clear them with `setBodyProps` and
  empty `props` in the same `batch`, so one undo brings both back.
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

| Command                  | Fields                                                        | Inverse                                                                |
| ------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `addFeature`             | `partId`, `feature`, `index?` (default: rollback bar)         | `deleteFeature`                                                        |
| `editFeature`            | `partId`, `feature` (same id and kind)                        | `restoreFeature` (old state)                                           |
| `deleteFeature`          | `partId`, `featureId`                                         | `restoreFeature`                                                       |
| `restoreFeature`         | `partId`, `feature`, `index`, `rollbackIndex`                 | `restoreFeature` or `deleteFeature`                                    |
| `reorderFeature`         | `partId`, `featureId`, `index` (final position)               | `reorderFeature`                                                       |
| `suppressFeature`        | `partId`, `featureId`, `suppressed`                           | `suppressFeature`                                                      |
| `renameFeature`          | `partId`, `featureId`, `name` (trimmed)                       | `renameFeature`                                                        |
| `setRollback`            | `partId`, `index` (`null`: after the last)                    | `setRollback`                                                          |
| `setVariable`            | `name`, `expression`, `index?` (for a new one)                | `setVariable` or `deleteVariable`                                      |
| `deleteVariable`         | `name`                                                        | `setVariable` at the old index                                         |
| `setDisplayUnits`        | `units`                                                       | `setDisplayUnits`                                                      |
| `setMaterial`            | `partId`, `material` (a material id, `null` clears)           | `setMaterial` (the old one or null)                                    |
| `setBodyProps`           | `partId`, `bodyId`, `props`, `index?` (for a new one)         | `setBodyProps` (the old props)                                         |
| `setBodyGroup`           | `partId`, `group` (a fresh `group#n`, or by id), `index?`     | `setBodyGroup` (the old group) or `deleteBodyGroup`                    |
| `deleteBodyGroup`        | `partId`, `groupId` (the bodies stay)                         | `restoreBodyGroup` at the old index                                    |
| `restoreBodyGroup`       | `partId`, `group`, `index` (history only)                     | `deleteBodyGroup`                                                      |
| `renameDocument`         | `name` (trimmed, 1 to 200 characters)                         | `renameDocument` (the old name)                                        |
| `setDomainData`          | `namespace`, `schemaVersion` and `data` (both absent: remove) | `setDomainData` (the old entry, or a removal)                          |
| `setConfigParameter`     | `parameter` (by id: new or replaced), `index?`                | `setConfigParameter` or `deleteConfigParameter`                        |
| `deleteConfigParameter`  | `parameterId` (its row values go too)                         | `restoreConfigParameter`, plus `setConfigRow` per row that had a value |
| `restoreConfigParameter` | `parameter`, `index` (history only)                           | `deleteConfigParameter`                                                |
| `setConfigRow`           | `row` (by id: new or replaced), `index?`                      | `setConfigRow` or `deleteConfigRow`                                    |
| `deleteConfigRow`        | `rowId` (the active row: none is active after)                | `restoreConfigRow`, plus `setActiveConfiguration` if it was active     |
| `restoreConfigRow`       | `row`, `index` (history only)                                 | `deleteConfigRow`                                                      |
| `setActiveConfiguration` | `rowId` (`null`: none)                                        | `setActiveConfiguration`                                               |
| `addPart`                | `partId` (a fresh `part#n`), `name`, `index?`                 | `deletePart`                                                           |
| `renamePart`             | `partId`, `name` (trimmed, 1 to 200 characters)               | `renamePart` (the old name)                                            |
| `deletePart`             | `partId` (not the last part)                                  | `restorePart`                                                          |
| `restorePart`            | `part`, `index` (history only)                                | `deletePart`                                                           |
| `reorderParts`           | `partId`, `index` (final position)                            | `reorderParts`                                                         |
| `duplicatePart`          | `sourcePartId`, `partId` (fresh), `name`, `index?`            | `deletePart`                                                           |
| `addAssembly`            | `assemblyId` (a fresh `assembly#n`), `name`, `index?`         | `deleteAssembly`                                                       |
| `renameAssembly`         | `assemblyId`, `name` (trimmed, 1 to 200 characters)           | `renameAssembly` (the old name)                                        |
| `deleteAssembly`         | `assemblyId` (with its instances and mates)                   | `restoreAssembly`                                                      |
| `restoreAssembly`        | `assembly`, `index` (history only)                            | `deleteAssembly`                                                       |
| `addInstance`            | `assemblyId`, `instance` (a fresh `inst#n`; last)             | `deleteInstance`                                                       |
| `editInstance`           | `assemblyId`, `instanceId`, fields to change (below)          | `editInstance` (the old values)                                        |
| `setPoses`               | `assemblyId`, `poses` (by instance id; one step)              | `setPoses` (the old poses)                                             |
| `deleteInstance`         | `assemblyId`, `instanceId` (not while mated)                  | `restoreInstance`                                                      |
| `restoreInstance`        | `assemblyId`, `instance`, `index` (history only)              | `deleteInstance`                                                       |
| `addMate`                | `assemblyId`, `mate` (fresh ids; goes last)                   | `deleteMate`                                                           |
| `editMate`               | `assemblyId`, `mate` (by id; new ids fresh)                   | `restoreMate` (old state)                                              |
| `deleteMate`             | `assemblyId`, `mateId` (with its connectors)                  | `restoreMate`                                                          |
| `restoreMate`            | `assemblyId`, `mate`, `index` (history only)                  | `restoreMate` or `deleteMate`                                          |
| `suppressMate`           | `assemblyId`, `mateId`, `suppressed`                          | `suppressMate`                                                         |
| `addPrintSetup`          | `setup` (fresh ids, items included), `index?`                 | `deletePrintSetup`                                                     |
| `editPrintSetup`         | `setupId`, fields to change (below)                           | `editPrintSetup` (the old values)                                      |
| `deletePrintSetup`       | `setupId` (with its items)                                    | `restorePrintSetup`                                                    |
| `restorePrintSetup`      | `setup`, `index` (history only)                               | `deletePrintSetup`                                                     |
| `addPrintItem`           | `setupId`, `item` (fresh ids), `index?`                       | `deletePrintItem`                                                      |
| `editPrintItem`          | `setupId`, `item` (by id; new ids fresh)                      | `restorePrintItem` (old state)                                         |
| `deletePrintItem`        | `setupId`, `itemId`                                           | `restorePrintItem`                                                     |
| `restorePrintItem`       | `setupId`, `item`, `index` (history only)                     | `restorePrintItem` or `deletePrintItem`                                |
| `addCamTool`             | `tool` (a fresh `tool#n`), `index?`                           | `deleteCamTool`                                                        |
| `editCamTool`            | `tool` (by id)                                                | `restoreCamTool` (old state)                                           |
| `deleteCamTool`          | `toolId` (refused while an operation cuts with it)            | `restoreCamTool`                                                       |
| `restoreCamTool`         | `tool`, `index` (history only)                                | `restoreCamTool` or `deleteCamTool`                                    |
| `addCamSetup`            | `setup` (fresh ids, operations included), `index?`            | `deleteCamSetup`                                                       |
| `editCamSetup`           | `setupId`, fields to change (below)                           | `restoreCamSetup` (old state)                                          |
| `deleteCamSetup`         | `setupId` (with its operations)                               | `restoreCamSetup`                                                      |
| `restoreCamSetup`        | `setup`, `index` (history only)                               | `restoreCamSetup` or `deleteCamSetup`                                  |
| `reorderCamSetups`       | `setupId`, `index` (final position)                           | `reorderCamSetups`                                                     |
| `addCamOperation`        | `setupId`, `operation` (fresh ids), `index?` (default: last)  | `deleteCamOperation`                                                   |
| `editCamOperation`       | `setupId`, `operation` (by id; new ids fresh)                 | `restoreCamOperation` (old state)                                      |
| `deleteCamOperation`     | `setupId`, `operationId`                                      | `restoreCamOperation`                                                  |
| `restoreCamOperation`    | `setupId`, `operation`, `index` (history only)                | `restoreCamOperation` or `deleteCamOperation`                          |
| `reorderCamOperation`    | `setupId`, `operationId`, `index` (final cut order position)  | `reorderCamOperation`                                                  |
| `suppressCamOperation`   | `setupId`, `operationId`, `suppressed`                        | `suppressCamOperation`                                                 |
| `addFont`                | `font` (a fresh `font#n`; not the same bytes twice), `index?` | `deleteFont`                                                           |
| `deleteFont`             | `fontId` (refused while an outline uses it)                   | `restoreFont`                                                          |
| `restoreFont`            | `font`, `index` (history only)                                | `deleteFont`                                                           |
| `setScript`              | `script` (by id: a fresh `script#n`, or replaced), `index?`   | `setScript` (the old script) or `deleteScript`                         |
| `deleteScript`           | `scriptId` (refused while a scripted feature runs it)         | `restoreScript`                                                        |
| `restoreScript`          | `script`, `index` (history only)                              | `deleteScript`                                                         |
| `addExplodedView`        | `assemblyId`, `explodedView` (fresh ids), `index?`            | `deleteExplodedView`                                                   |
| `editExplodedView`       | `assemblyId`, `explodedView` (by id; new ids fresh)           | `restoreExplodedView` (old state)                                      |
| `deleteExplodedView`     | `assemblyId`, `explodedViewId` (not while a view shows it)    | `restoreExplodedView`                                                  |
| `restoreExplodedView`    | `assemblyId`, `explodedView`, `index` (history only)          | `restoreExplodedView` or `deleteExplodedView`                          |
| `addExplodeStep`         | `assemblyId`, `explodedViewId`, `step` (fresh), `index?`      | `deleteExplodeStep`                                                    |
| `editExplodeStep`        | `assemblyId`, `explodedViewId`, `step` (by id)                | `restoreExplodeStep` (old state)                                       |
| `deleteExplodeStep`      | `assemblyId`, `explodedViewId`, `stepId`                      | `restoreExplodeStep`                                                   |
| `restoreExplodeStep`     | `assemblyId`, `explodedViewId`, `step`, `index` (history)     | `restoreExplodeStep` or `deleteExplodeStep`                            |
| `addDrawing`             | `drawing` (a fresh `drawing#n`), `index?`                     | `deleteDrawing`                                                        |
| `renameDrawing`          | `drawingId`, `name` (trimmed, 1 to 200 characters)            | `renameDrawing` (the old name)                                         |
| `deleteDrawing`          | `drawingId` (with its sheets)                                 | `restoreDrawing`                                                       |
| `restoreDrawing`         | `drawing`, `index` (history only)                             | `deleteDrawing`                                                        |
| `reorderDrawings`        | `drawingId`, `index` (final position)                         | `reorderDrawings`                                                      |
| `addSheet`               | `drawingId`, `sheet` (fresh ids, contents included), `index?` | `deleteSheet`                                                          |
| `editSheet`              | `drawingId`, `sheetId`, fields to change (below)              | `editSheet` (the old values)                                           |
| `deleteSheet`            | `drawingId`, `sheetId` (with everything on it)                | `restoreSheet`                                                         |
| `restoreSheet`           | `drawingId`, `sheet`, `index` (history only)                  | `deleteSheet`                                                          |
| `reorderSheets`          | `drawingId`, `sheetId`, `index` (final position)              | `reorderSheets`                                                        |
| `addView`                | `drawingId`, `sheetId`, `view` (a fresh `view#n`), `index?`   | `deleteView`                                                           |
| `editView`               | `drawingId`, `sheetId`, `view` (by id)                        | `restoreView` (old state)                                              |
| `moveView`               | `drawingId`, `sheetId`, `viewId`, `position`                  | `moveView` (the old position)                                          |
| `deleteView`             | `drawingId`, `sheetId`, `viewId` (not while in use)           | `restoreView`                                                          |
| `restoreView`            | `drawingId`, `sheetId`, `view`, `index` (history only)        | `restoreView` or `deleteView`                                          |
| `addDimension`           | `drawingId`, `sheetId`, `dimension` (fresh `dim#n`), `index?` | `deleteDimension`                                                      |
| `editDimension`          | `drawingId`, `sheetId`, `dimension` (by id)                   | `restoreDimension` (old state)                                         |
| `deleteDimension`        | `drawingId`, `sheetId`, `dimensionId`                         | `restoreDimension`                                                     |
| `restoreDimension`       | `drawingId`, `sheetId`, `dimension`, `index` (history only)   | `restoreDimension` or `deleteDimension`                                |
| `addNote`                | `drawingId`, `sheetId`, `note` (a fresh `note#n`), `index?`   | `deleteNote`                                                           |
| `editNote`               | `drawingId`, `sheetId`, `note` (by id)                        | `restoreNote` (old state)                                              |
| `deleteNote`             | `drawingId`, `sheetId`, `noteId`                              | `restoreNote`                                                          |
| `restoreNote`            | `drawingId`, `sheetId`, `note`, `index` (history only)        | `restoreNote` or `deleteNote`                                          |
| `replaceDocument`        | `document` (the same `id`; history only)                      | `replaceDocument` (the old document)                                   |
| `batch`                  | `commands` (applied in order, all or nothing)                 | `batch` of inverses, reversed                                          |

`restoreConfigParameter` and `restoreConfigRow` are history-only in the same way: they put back a
deleted parameter or row under its old id, which must have been allocated before, while
`setConfigParameter` and `setConfigRow` require a fresh id for a new item.

Part studios: `addPart` and `duplicatePart` take a `part#n` id from the document's
`nextIds.part` (`previewIds(doc.nextIds, PART_COUNTER)` gives the next one) and move the counter
past it, so a deleted part's id is never handed out again. `restorePart` is their history-only
counterpart: undo of a delete puts the part back under its old id without counting as reuse. A
new part goes last; a duplicate goes just after its source and copies the whole part (features
with the same ids, since ids are per part, counters, rollback bar, material and body props).
`deletePart` refuses the document's last part (`last-part`), refuses while a suppression
configuration parameter names a feature of the part (`dependency`, the parameter ids in
`blockers`; `partParameters(doc, partId)` lists them): delete the parameter in the same batch,
refuses while an assembly instance shows the part (`dependency`, `<assembly id>/<instance id>`
in `blockers`; `partInstances(doc, partId)` lists them), refuses while a print item prints
it (`dependency`, `<setup id>/<item id>` in `blockers`; `partPrintItems(doc, partId)`), and
refuses while a CAM setup machines it (`dependency`, the setup ids in `blockers`;
`partCamSetups(doc, partId)`).

CAM: `editCamSetup` takes any of `name` (trimmed, 1 to 200 characters), `part`, `body` (`null`:
the part's only body), `machine`, `post`, `stock`, `wcs` and `heights`; absent fields stay, and a
new WCS face reference takes a fresh `r<n>`. Every CAM edit's inverse is the matching `restore`
of the old state, which needs only that its ids were allocated. To move an operation to another
setup under its id, batch `deleteCamOperation` with `restoreCamOperation` into the other setup.

Assemblies: `addAssembly` takes an `assembly#n` from the document's `nextIds.assembly`, like
`addPart`. `addInstance` and `addMate` allocate from the assembly's `nextIds` and refuse an id
handed out before (`id-reused`): a mate introduces its own id, both connector ids and both
reference ids. Instances and mates are appended, so mates stay in creation order, which is what
the solver blames by; only the history-only `restoreInstance` and `restoreMate` put one back at
an index. `editMate` replaces a mate by id, and the ids it introduces must be fresh, as for
`editFeature`; its inverse is `restoreMate` with the old state. `editInstance` changes only the
fields it is given (`name`, `fixed`, `suppressed`, `bodies` with `null` for every body, `source`
for another part, pin or configuration row), and its inverse gives exactly those fields their old
values. `setPoses`
changes the poses of several instances in one undo step; it is what a drag or a mate dialog
commits.

Print setups: `addPrintSetup` allocates the setup's id and every id inside it (items and their
face references) from `print.nextIds` and refuses one handed out before (`id-reused`), as
`addPrintItem` does for one item. `editPrintSetup` changes only the fields it is given (`name`,
trimmed, 1 to 200 characters; `printer`; `nozzle`; `thresholds`, with `null` for the defaults),
and its inverse gives exactly those fields their old values. `editPrintItem` replaces an item by
id, and the ids it introduces must be fresh: re-picking a `layFlat` face takes a new `r<n>`.
`restorePrintSetup` and `restorePrintItem` are the history-only counterparts. None of them looks
at geometry, and no part or feature command looks at print references (see Print setups).

Exploded views and drawings: every list (exploded views and their steps, drawings, sheets, views,
dimensions, notes) follows the rules of mates and print items. An add allocates every id the item
carries (a sheet's views, dimensions and notes included) from its counter and refuses one handed
out before (`id-reused`); an add past a list's cap is refused (`schema`). An edit replaces an item
by id and its new ids must be fresh; its inverse is the history-only restore with the old state,
which replaces by id at the same index, or inserts. `editExplodedView` replaces a whole exploded
view, so it renames it and adds, removes, edits and reorders its steps in one undo step; the step
commands do one step at a time. `editSheet` changes only the fields it is given (`name`, `size`,
`orientation`, `titleBlock` with `null` for none) and its inverse gives exactly those fields their
old values; `moveView` sets only a view's position (a drag). `addDrawing` takes a fresh
`drawing#n` from the document's `nextIds.drawing`; the drawing's own `nextIds` must already cover
the ids inside it. Removing the last drawing drops `drawings`, and the last exploded view drops
`explodedViews`, so undo of the first add is exact and the saved text canonical. No drawing
command looks at what a dimension's references name.

`restoreFeature` is a history-only command: it is what undo and redo use to put a feature state
back, and clients must not use it to edit. Unlike `addFeature` and `editFeature`, it requires its
ids to have been allocated before, so undoing a delete brings back the same ids without counting
as reuse. That is its only id check: it does not apply the split rule, because the states it
restores really existed. Everything else (dependencies, expressions, sketch consistency) is
checked as for any command.

`replaceDocument` is history-only too: it puts a whole document in place of the open one, which
is how the app restores a version or a revision (and how undo takes a restore back). The
replacement must have the same `id` and pass the schema and `checkDocument` as a whole, parts,
assemblies and configurations included. It does not look at counters itself, so that its inverse
can put back exactly what was there; a client builds the replacement with
`restoredDocument(current, past)`, which keeps `past`'s content under `current`'s id and raises
every counter (the document's, the print section's, and each part's, assembly's and drawing's
that both have) to the higher of the two values, so no id handed out after `past` is handed out again. A part deleted since
`past` has no counters in `current`, so pass a high-water mark as the third argument,
`restoredDocument(current, past, floor)` (see Sync), and no counter goes back. In the op log the command
carries the whole document: imported files and pinned versions are stored by reference as for any
command, so it is the feature JSON that repeats.

`setBodyProps` replaces the body's whole entry with `props` (`{ name?, color?, material? }`);
empty `props` removes the entry. Its inverse sets the old props back at the old index, or removes
the entry when there was none.

`setBodyGroup` creates a group (a fresh `group#n` from the part's `nextIds.group`, at `index` or
last) or replaces one by id: its name and its whole member list. Moving a body from one group to
another is a `batch` of two `setBodyGroup`s, since a body is in one group at most. The list is
absent when empty, so deleting the last group gives back a part with no `bodyGroups` key.

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
`materialChanged` instead: masses change, geometry does not. A change to `Part.bodies` sets
`bodyPropsChanged` the same way (names, colours, materials: no geometry). A scope is a feature
input, so changing one is a feature change. `configurationsChanged` says the table changed. The
change is computed for the documents as stored and for them with their active rows applied
(`configured`), and the two are merged: switching the active row, or editing its values, lists
the variables it overrides differently in `variables.changed` and the features whose suppression
it flips in `changed`, and sets `firstAffectedIndex` as for a variable edit; an edit of an
inactive row changes no feature result. Every listener runs even if one throws; the first error is
rethrown afterwards.

Per assembly, `assemblies` lists added, removed and changed instances (anything but the pose),
the instances whose pose changed (`posed`), added, removed and changed mates (edited,
suppressed, renamed, or with an offset or limit reading a changed variable, also through the
active configuration row), whether mates were reordered, and `posesOnly`: only poses changed, as
after a committed drag, so nothing regenerates and nothing needs solving again. It also lists
added, removed and changed exploded views (`explodedViews`, a step distance reading a changed
variable counts), whether they were reordered, and `explodedOnly`: only exploded views changed, so
nothing regenerates or solves, and only the exploded offsets are computed again. An assembly change
never lists a part in `parts`; an instance's geometry changes when its part does, which `parts`
reports.

Print setups never dirty a regen (ADR 0012 decision 1). `printChanged` says the print section
changed: a setup or item added, removed or edited, setups reordered, or a threshold or orientation
reading a changed variable (also through the active configuration row). `print.setups` lists the
added, removed and changed setup ids and `print.reordered` whether their order changed. A print
edit adds nothing to `parts`, so it has no `firstAffectedIndex`; the print workspace re-checks the
setups listed, and re-checks every setup when `parts` reports a part it prints.

CAM never dirties a regen either (ADR 0014 decision 2). `camChanged` says the CAM section changed:
a tool, setup or operation added, removed or edited, setups reordered, or an expression of a tool or
setup (its operations' included) reading a changed variable, also through the active configuration
row. `cam.tools` and `cam.setups` list the added, removed and changed ids and `cam.reordered`
whether the setups' order changed; a tool edit lists the tool, not the setups that cut with it.
Which operations changed is for the CAM workspace to find by its toolpath keys (decision 9). A
CAM-only edit adds nothing to `parts`, so it has no `firstAffectedIndex`.

Drawings never dirty a regen either. `drawingChanged` says `drawings` changed: a drawing, sheet,
view, dimension or note added, removed or edited, drawings reordered, or a sheet size, view scale
or section offset reading a changed variable. `drawings.drawings` lists the added, removed and
changed drawing ids and `drawings.reordered` whether their order changed. A drawing-only edit adds
nothing to `parts` or `assemblies`, so it has no `firstAffectedIndex`; a model edit sets no
`drawingChanged`, since regen caches views by the bodies they show (T4.4e).

`domainChanged` lists, sorted, the namespaces whose `domains` entry was added, removed or changed
(since version 11). It adds nothing to `parts` and has no `firstAffectedIndex`. There is no
per-domain hook: regen marks dirty every extension of a domain that may read the namespace, and the
cache sorts out the rest (ADR 0013 decision 5).

## Sync

What sync needs from core ([ADR 0009](../../docs/adr/0009-sync-model.md) and its amendment), as
pure functions and schemas. The client engine and the reference server (`packages/sync`, M7
T7.1b) build on them.

```ts
import {
  parseName,
  printName,
  remapIds,
  remapDocument,
  createdIds,
  takenIds,
  freshRenames,
  tombstoneTable,
  remapCreatedIds,
  documentCounters,
  maxCounters,
  counterRegressions,
  restoredDocument,
  migrateCommand,
  SyncEntrySchema,
  PROTOCOL_VERSION,
} from '@manufakture/core';
```

### Face names

`parseName(name)` reads the naming grammar of `packages/kernel/src/naming.ts` and
`printName(parseName(name)) === name` for every string. The parse is a flat list of parts, one
left-to-right pass with no recursion (linear on hostile input, like the old scanner):

| Part      | What it is                                                                            |
| --------- | ------------------------------------------------------------------------------------- |
| `feature` | a feature id starting a born name, an instance prefix or a derived prefix (`kind#n:`) |
| `sub`     | a born name's tail when the whole tail is a sub-id: `e7` with suffix `#a#1`           |
| `source`  | what follows `<id>:from/` to the end of its merge or corner member: never read        |
| `text`    | roles, punctuation, other tails (`end`, `start#2`, `4`, `xmax`), placeholders         |

So born names `extrude#1:side:e2#a`, region edges `e2#1`, nested names
`shell#5:offset:extrude#1:cap:end`, pieces `X#2`, merges `(A+B)`, corners `A&B&C`, instance
prefixes `pattern#7:i2/X` and `mirror#8:image/X`, `import#9:face:4`, `?face3` and derived
prefixes all parse, and so do edge names (`A|B[C,D]#2`, display only). A scripted feature's
operation prefix `<feature id>:<operation id>/` (`scripted#2:boss/cap:end`) is a `feature` part
followed by the text `:boss/`; the rest is parsed on, so feature ids of member names after it
(`scripted#2:rnd/round:extrude#1:cap:end&extrude#1:side:e2`) are `feature` parts, while the
script's roles and local ids (`cap:end`, `side:s1`, even `side:e2`) stay text. A remap therefore
rewrites the feature id of the prefix and never the operation or local ids, and an operation id
is never read as a derived prefix, even `from`. `mapName(name, maps)`
rewrites the feature ids and sub-id tails (keeping suffixes) and of a derived prefix only its own
id. `featureIdsInName` is the `feature` parts of the parse, so validation and the remap read names
the same way.

### Counter scopes

A scope is a `nextIds` object, keyed as a string: `document`, `part:<id>`, `assembly:<id>`,
`cam`, `print`, `drawing:<id>`. `documentCounters(doc)` snapshots every scope's counters as plain
JSON (`CounterTable`); `maxCounters(a, b)` is a high-water mark that keeps deleted scopes;
`counterRegressions(before, after)` lists every counter of `after` below `before` for scopes in
both. A new `nextIds` object is one entry in `COUNTER_SCOPES`; a new counter in an existing one
(`script` in the document's, since version 16) needs nothing there.

### Created ids

`createdIds(doc, command)` gives the ids a command allocates, by scope
(`{ "part:part#1": ["extrude#4", "e10"] }`): the ids in its fields that `applyCommand` takes fresh
(at or above the scope's counter before, below it after), never split pieces, and never ids in a
scope the command creates (a new part's or drawing's), whose own id is listed in the parent scope
instead. The client computes it on the document it made the command on and sends it in the
entry. The server cannot: two edits that each add `e10` to one sketch are both accepted by core,
the second taking over the first one's entity. `takenIds(counters, created)` is the guard: the
created ids below the head's counters, refused as `id-reused` before core runs.

### Remap

`remapIds(commands, table, { document, report })` rewrites every id in a list of commands through
one table (`RenameTable`: scope to old id to new id), so a queue, an undo stack's inverses or a
redo list is rewritten in one call with simultaneous renames. Fields are walked structurally by
schema in `IdWalker`, each through its own scope, so a CAM `profile#1` and a feature id of the same
shape never mix; names go through the parser. Names of another part (a mate connector's faces are
its instance's part's, a CAM operation's its setup's part's, an instance's `bodies`, a drawing
dimension's view part) are resolved through `document` and the commands before them; what cannot
be resolved is left and counted in `report.unresolved`. Opaque data is never read: derived and
pinned sources, extension `params`, domain data, view params, names, labels, expressions. Counters
a command carries (a restored part's, a replaced document's) are raised to cover the renamed ids.
`remapDocument(doc, table)` renames a whole document the same way; for any table that renames into
fresh numbers, applying `remapIds(commands)` to `remapDocument(start)` gives
`remapDocument(end)` (a seeded property test checks it, and a second one against an independent
text rewrite).

Building tables: `freshRenames(counters, ids, { reserved })` renames ids to the next free numbers
of their counters (in order) and returns the counters after; `takenIds` plus `freshRenames` is how a
client renames an in-flight entry whose ids were taken, in its own naming. A dropped command's ids
become tombstones with `tombstoneTable(created)` (table value `null`): `kind#0` / `e0` in a plain
field, which the schema refuses, and the number `TOMBSTONE_NAME` (999999999999999) inside a name:
a feature id with it is refused by the dependency check, and a sub-id tail with it
(`extrude#1:side:e999999999999999`, even on a live `extrude#1`) by the schema of every stored face
name (`hasTombstoneSubId`, a `schema` error saying the name names a dropped command's sub-id). So a
held entry that names them fails instead of binding to whatever takes the
number later. `remapCreatedIds(created, table)` rewrites an entry's `created` with its command,
scope keys included (`part:part#3` follows `part#3`).

Left to the sync client (T7.1b): a duplicated part's copied ids follow its source part's renames
up to the duplicate, so the client copies the source scope's entries into the new part's table;
and a restore is kept as its intent and re-derived with `restoredDocument(head, past, floor)` at
every replay (amendment, item 11), with the restored version tracked in the client's queue state,
not in `SyncEntrySchema`. The spike's fixed concurrent sequences (two concurrent sketch edits adding
one entity id, an in-flight collision followed by an edit of the remote feature, a dropped head
with a held follower, a duplicate of a part that takes remote features, a stale restore) belong to
T7.1b's fuzz suite: they exercise the client engine, not a single core command log.

### Restores and counter regressions

A server refuses an entry whose head has a counter below its high-water mark
(`counterRegressions(high, documentCounters(head))`, with `high` the `maxCounters` of every
accepted head). `restoredDocument(current, past, floor)` takes that mark as `floor`, so a part
deleted since `past` comes back with the counters it reached, not `past`'s.

### Sync entries

`SyncEntrySchema` is an entry in storage form: `{ clientId, clientSeq, prevSeq?, baseRev, format,
cause, label, command, created, at }`. `command` is stored as written under document format
`format`; read it with `migrateCommand(entry.command, entry.format)`. `prevSeq` is the `clientSeq`
of the entry the new one was built on, assigned with `clientSeq` when the entry is sent: the
nearest entry before it in the queue that is neither refused nor doomed, else the latest accepted
entry, else absent. `created` is `createdIds`' result (`CreatedIdsSchema`); `RenameTableSchema`
validates a saved table. `PROTOCOL_VERSION` (1) versions the wire shapes, apart from
`FORMAT_VERSION`.

### Known limitations

- **A rename can reverse the code-unit order of face names** (`e9` to `e10`, `extrude#9` to
  `extrude#10`). An edge reference stores its faces sorted by code unit, and the kernel reads a
  chamfer's reference face and an edge's direction from that order. The remap keeps positions, so
  the stored list is no longer sorted; it counts each case in `report.orderFlips` (a test pins the
  current behaviour). The kernel's naming is unchanged in M7: numeric-aware comparison would make
  every remap order-preserving, at the cost of a naming-scheme bump, and is left to T7.1b and
  T7.0d to decide.
- **A stale whole-feature edit is refused**: an `editFeature` that re-introduces a sub-id a
  concurrent edit removed is not a fresh id, so no remap applies (amendment, item 10).
- **`RenameTable` keys are ids straight from counters.** A sub-id is renamed by its base, so `e7`
  also renames `e7#a` and `e7#1`; split pieces are never keys.

## File format

`serialize(doc)` writes canonical JSON: keys in schema order (records such as every `nextIds`,
a drawing's included, and a row's `values` sorted),
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
a version 2 part has no imports. Version 4 added bodies: `migrateV3ToV4` adds `bodies: []` to
every part and `nextIds: { part: <highest part#n + 1> }` to the document (1 when no part id is
numbered), and changes no feature, since an absent `scope` means every body; a part with two `new`
solids in one compound (`v3-two-bodies.json`) regenerates the same solids, now as two bodies
(`extrude#1` and `extrude#2`). The test migrates `src/fixtures/v0-bracket.json` to exactly
`v1-bracket.json`, that to exactly `v2-bracket.json`, that to exactly `v3-bracket.json` and that
to exactly `v4-bracket.json` and that to exactly `v5-bracket.json` and that to exactly
`v6-bracket.json` and that to exactly `v7-bracket.json` and that to exactly `v8-bracket.json`
and that to exactly `v9-bracket.json` and that to exactly `v10-bracket.json` and that to exactly
`v11-bracket.json` and that to exactly `v12-bracket.json` and that to exactly `v13-bracket.json`
and that to exactly `v14-bracket.json` and that to exactly `v15-bracket.json` (and every older
fixture loads as exactly the current one),
and
`v3-two-bodies.json` to
exactly `v4-two-bodies.json`. Version 5 added the optional configuration table; `migrateV4ToV5`
only bumps the version, since a version 4 document has none and an absent counter starts at 1.
Version 6 added the `derived` feature kind and the optional `mode` of a pattern or mirror of
bodies; `migrateV5ToV6` only bumps the version, since a version 5 document has no derived feature
and an absent `mode` is `add`; `v5-bracket.json` migrates to exactly `v6-bracket.json`. Version 7
added assemblies and the vertex reference; `migrateV6ToV7` adds `assemblies: []` right after
`parts` (where a saved file has it) and changes nothing else, since a version 6 document has no
assembly and an absent `assembly` counter starts at 1; `v6-bracket.json` migrates to exactly
`v7-bracket.json`. Version 8 added print setups (ADR 0012); `migrateV7ToV8` adds
`print: { setups: [], nextIds: {} }` right after `assemblies` (where a saved file has it) and
changes nothing else, since a version 7 document has no setups and every print counter starts at
1; `v7-bracket.json` migrates to exactly `v8-bracket.json`. Version 9 added fonts and the
`outline` sketch entity (ADR 0012 decisions 7 and 8); `migrateV8ToV9` adds `fonts: []` right
after `print` (where a saved file has it) and changes nothing else, since a version 8 document has
no text and the `font` counter starts at 1; `v8-bracket.json` migrates to exactly
`v9-bracket.json`. Version 10 added the `thread` feature kind (ADR 0012 decision 9);
`migrateV9ToV10` only bumps the version, since a version 9 part has no threads;
`v9-bracket.json` migrates to exactly `v10-bracket.json`. Version 11 let extension features make
and change bodies (optional `operation` and `scope`, and `<id>:<key>` body ids) and added the
optional `domains` (ADR 0013 decisions 3 and 6); `migrateV10ToV11` only bumps the version, since
both are optional and a version 10 file has neither; `v10-bracket.json` migrates to exactly
`v11-bracket.json`. Version 12 added drawings (the optional document-level `drawings`) and
exploded views (the optional `explodedViews` of an assembly), M4 plan decisions 7 and 9;
`migrateV11ToV12` only bumps the version, since both are optional, absent when empty, and a version
11 file has neither; `v11-bracket.json` migrates to exactly `v12-bracket.json`. Version 13 added
the `svg` source of the `outline` entity (ADR 0012 decision 7, M5 T5.8); `migrateV12ToV13` only
bumps the version, since a version 12 file's outlines are all text; `v12-bracket.json` migrates to
exactly `v13-bracket.json`. Version 14 added CAM (ADR 0014, M5 T5.1b); `migrateV13ToV14` adds
`cam: { tools: [], setups: [], nextIds: {} }` right after `fonts` (where a saved file has it) and
changes nothing else, since a version 13 document has no CAM and every CAM counter starts at 1; a
version 13 file that already has a `cam` key is refused (`migration`), never repaired;
`v13-bracket.json` migrates to exactly `v14-bracket.json`. Version 15 added the domain view
source (`{ domain, part, schemaVersion, params }`, M6 plan T6.4a: construction floor plans,
framing elevations and roof framing plans); `migrateV14ToV15` only bumps the version, since a
version 14 file's views all show a part or an assembly; `v14-bracket.json` migrates to exactly
`v15-bracket.json`. Version 16 added the script library (`scripts`, absent when empty) and the
`scripted` feature kind, with the document counter `script` (ADR 0010 decision 8, M7 plan
T7.2a); `migrateV15ToV16` only bumps the version, since a version 15 file has no scripts, and
refuses one that already has a `scripts` key (`migration`); `v15-bracket.json` migrates to exactly
`v16-bracket.json`. Its command step changes no command: the script commands are new, and a
version 15 command carries no scripted feature.

Commands carry parts of the document shape too (a feature, a whole part, a whole document), and
log entries and sync queues store them as written, with the format they were written under.
`migrateCommand(command, fromFormat)` brings one up to the current format and validates it:
`COMMAND_MIGRATIONS[i]` goes from format i to i + 1 beside `FORMAT_MIGRATIONS[i]` (a test keeps the
two lists in step). Each step runs its document migration on the document a `replaceDocument`
carries, recurses into batches, and migrates the items other commands carry: version 0 to 1 gives
a feature its `suppressed` flag (in `addFeature`, `editFeature`, `restoreFeature`, `restorePart`)
and a restored part its rollback bar, version 3 to 4 gives a restored part `bodies: []`; the other
steps change no command. A command written under a newer format is refused (`version`).

### Golden command logs

Core is a wire protocol (M7 plan, cross-cutting decision 3): command semantics must not change
under old logs. `src/fixtures/logs/*.json` are command logs, each with the format version it was
written under, a start document, entries in the persistence `LogEntry` shape
(`{ cause, label, command, at }`) and the document they lead to. `golden-logs.test.ts` replays
every entry through `migrateCommand` and `applyCommand` and compares `serialize` of the result with
the expected document (itself loaded through the document migrations), and checks that the logs
together use every command type, `batch` included. Undo entries are the inverses core returned, so
every `restore*` command is covered.

To change the file shape and commands:

1. bump `FORMAT_VERSION` in `src/schema.ts` and change the schema;
2. append a migration to `FORMAT_MIGRATIONS` in `src/migrations.ts`;
3. add a fixture of the old version to `src/fixtures/` and register it in `FIXTURES` in
   `src/format.test.ts` (a test fails until every older version has one);
4. append the matching step to `COMMAND_MIGRATIONS`: `commandStep(migration)` when no command
   carries the changed shape except inside a whole document, or with an `entities` function that
   migrates the item the affected commands carry;
5. never edit or regenerate a golden log: the old ones must keep replaying, through step 4. A
   command whose meaning changes is a new command type, not an edit of the old one; a new command
   type gets a golden log of its own (the coverage test fails until it has one);
6. a new id field, counter or naming form goes into the remap in the same task (see Sync): a
   field in `IdWalker` (`src/remap.ts`), a `nextIds` object in `COUNTER_SCOPES`
   (`src/scopes.ts`), a naming form in `parseName` (`src/names.ts`), each with its tests. A missed
   one renames a local id and leaves a stale reference, which core then refuses.

## Where this deviates from ADR 0004's first cut

- **Added fields.** The document has `id`, `name`, `nextIds`, `assemblies`, `print`, `cam` and optional `configurations` and `drawings`; a part has `name`,
  `rollbackIndex`, an optional `material` (the default for its bodies) and `bodies`;
  every feature has `name` and `suppressed`. The ADR's shape was a first cut that expected feature kinds
  to add their own fields.
- **Cuts are extrudes.** The ADR's comment lists `'cut'` as a kind and T0.5 names faces
  `cut#4:...`. Here a cut is an `extrude` (or `revolve`) with `operation: 'cut'`, so its faces are
  named after an `extrude#n` id. Nothing in the naming scheme depends on the kind's name.
- **`version`, not `formatVersion`.** The task text says `formatVersion`; the ADR's field name is
  kept, and the constant is `FORMAT_VERSION`.
- **Constraint ids use `k`.** The ADR's example `c1` is a sketch entity (a circle) in T0.5, so
  constraints use `k1` to keep entity and constraint ids apart.
