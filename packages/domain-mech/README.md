# @manufakture/domain-mech

The mechanical domain (M9, [ADR 0017](../../docs/adr/0017-mechanical-domain.md)): machines that
move and carry load, mechanical and electrical in one domain. Pure TypeScript under
GPL-3.0-or-later.

**Calculates, never certifies.** Results are numbers and margins against the user's own factors
and targets; nothing this package shows calls a design safe, certified, compliant, passing or OK
(ADR 0017 decision 6). Every mechanical output carries `DISCLAIMER_SHORT`; the long form opens
[docs/user/mechanical.md](../../docs/user/mechanical.md).

## Where things live

- **The model is core's.** Requirements, load cases, drivetrains, purchased parts and user catalog
  entries, the electrical system, schematics and user symbols, stress studies, check overrides,
  specification notes, hazards and test bands are the typed `mech` section of the document
  (`@manufakture/core`, format version 19), which core validates and its commands, variable rename,
  id remap and `diffDocuments` reach. User materials are core's too (`materials`), since every
  domain's mass properties read them.
- **Settings are the domain's**: `domains.mech`, plain constants with no variables and nothing that
  names a document object (ADR 0013 decision 3).
- **FEA is `packages/fea`**, which this package never imports (decision 13).

## Settings (`domains.mech`, schema version 1)

```ts
interface MechSettings {
  factors: { strength?: number; fatigue?: number; checks?: Record<string, number> };
  ambient: number; // K, default 298.15
  printedKnockdown: number; // default PRINTED_KNOCKDOWN_START (0.5)
  simulation: { step: number; transientStep: number; budget: number }; // 1 ms, 50 µs, 2 s
  fea: { targetDof: number }; // 175000
  report: { unitSystem?: 'si' | 'us'; sections?: string[]; titleBlock?: Record<string, string> };
}
```

Stored data holds only what the user set; `readMechSettings(data, schemaVersion)` fills the
defaults, refuses unknown keys and out-of-range values with the field at fault, and refuses a newer
version. `mechSettings(doc.domains)` reads a document's (the defaults when it has none).

**No safety factor ships** (the maintainer's decision of 2026-10-10). `DEFAULT_MECH_SETTINGS` has
none. Starting the domain asks for a strength factor on yield and a fatigue factor, both optional:
`setFactorsCommand(doc.domains, { strength?, fatigue? })` gives the `setDomainData` command that
starts the domain or changes the two factors, keeping every other stored setting; a factor left out
is not set and no default takes its place. `factorFor(settings, check, kind)` gives the factor that
applies to a check (its own, its family's by the longest `prefix.`, else the kind's), and
`factorText(reached, wanted)` words it: `factor 2.28, above your 2`, `factor 1.70, below your 2`,
or `factor 2.28; not compared: no factor set` when the user set none, with no warning.

## Registration

`mechDomain` is the `ExtensionDomain` (namespace `mech`, the reader of `domains.mech`);
`registerMech(registry)` registers it. The app's regen worker (`apps/web/src/viewport/regen-worker.ts`)
and the session's Node host (`packages/session/src/node-host.ts`) call it beside the wood and
construction domains. It registers one extension type, `mech.placeholder` (T9.2a), and the
evaluation stage of decision 15 (`createMechEvaluation`, below: the checks; the simulation joins it
in T9.4b).

## Purchased parts (`src/parts/`, T9.2a)

One model for every bought part with ratings (ADR 0017 decision 7). Core stores user entries
(`mech.catalog`, `CatalogEntry`) and uses (`mech.purchased`, `PurchasedUse`); this package gives
them meaning.

- **Family field schemas** (`families.ts`): `FAMILY_SCHEMAS`, one per `CATALOG_FAMILIES` family at
  `fieldsVersion` 1, from T9.0c's field lists. Each `RatingField` has a kind (a `packages/units`
  physical kind stored in SI, `number`, `count` or `text`), optional `options`, `conventions`,
  `basis` and `bom` (the comparison a BOM line states: `at-least`, `at-most`, `equals`). Geometric
  sizes are dimensions (mm, `DIMENSION_NAMES`), not ratings. `entryProblems(entry)` checks an
  entry against its family; `migrateEntry` migrates ratings in memory and refuses a newer
  `fieldsVersion`.
- **The built-in catalog** (`catalog.ts`): `BUILTIN_ENTRIES`, every version ever shipped, a few
  samples with typical published values, all `verified: false` (T9.2b to T9.2e add the catalogs).
  `resolveEntry(doc, ref)` gives the entry a `CatalogRef` names (pinned version for built-ins), or
  `unknown-entry` / `newer-fields`, never a guess; it reports a `newer` version and `deprecated`.
  `copyBuiltin` copies one into a user entry with `derivedFrom`.
- **Typing values in** (`input.ts`, `entry.ts`): every value through `packages/units`. With a
  unit the unit decides; a bare number is the document's display unit for the kind (catalog values
  are stored as SI numbers, not expressions, so a stored value never depends on a display
  preference); `unknown` is a value the datasheet does not give; a frequency refuses `rpm`.
  `readEntryFields(fields, id, units)` builds a checked entry from text fields by name, as the
  app's datasheet form and each CSV row give them; `entryFields(entry)` is its inverse.
- **CSV import** (`csv.ts`): `parseCsv(text, limits)` is a one-pass RFC 4180 reader bounded in
  characters (2 Mi), rows (2,000; empty lines are skipped and cost none), columns (256) and field
  length (10,000), refusing control characters (kept only with `keepControls`, for this program's
  own text), stray and unclosed quotes with the line. `entryProblems` refuses bidirectional
  controls in short texts and negative physical ratings. `importCatalogCsv(doc, text, { units })`
  returns one batch of `setCatalogEntry` commands, or every problem (at most 50) with its line and
  column; all or nothing.
- **The `mech.placeholder` extension** (`placeholder.ts`): params `{ entry: CatalogRef, shape:
'cylinder' | 'ring' | 'box', axis }` (schema version 1), sizes as the feature's length
  expressions (`PLACEHOLDER_SIZES`), each above zero and at most 10 m. `placeholderFeature` fills
  them from an entry's dimensions; `placeholderDrift` says when they differ from the entry now
  (a BOM line flag, below).
  A translator never reads `mech.catalog`, so the sizes travel with the feature.
- **Placing** (`place.ts`): `placePurchasedPart(doc, ref, { assemblyId?, name?, alternates? })`
  gives one batch: `addPart`, the geometry (an `import` feature, operation `reference`, for an
  entry with a STEP file, checked in full by `@manufakture/io`'s `checkStepFile` whoever wrote the
  entry; else the placeholder), `setPurchasedUse` and, with an assembly, `addInstance`, named
  uniquely (`uniqueName`: `Name (2)`, cut so the suffix fits in 200 characters). A name with a
  bidirectional control is refused.
- **BOM lines** (`bom.ts`): `purchasedBom(doc, { assemblyId? })` gives `@manufakture/takeoff` rows
  (category `purchased`, one per entry) with `ratings` (`bomRatings`: the family's BOM fields in
  display units, "C at least 5100 N") and `alternates`; instances of the use's part count it
  (the part once without an assembly), else its `quantity` expression. Flags: `unverified`,
  `unknown-entry`, `newer-version`, `deprecated`, `part-missing`, `quantity-ignored`,
  `quantity-unknown`, `estimated`, `placeholder-drift` (with the sizes as a warning). `purchasedBomCsv` writes them; `withPurchasedRows(bomCsv, rows,
units)` adds them to the cut list's `bom-csv` (columns `BOM_COLUMNS`). Text cells go through
  `csvTextField`, so a cell starting with `=`, `+`, `-` or `@` is written as text.
- **Tables** (`tables.ts`): `partsTables()` is what the MCP server serves at
  `manufakture://tables/parts`.

## Checks (`src/checks/`, T9.5a)

One way for every check to gather its inputs, compute and report (ADR 0017 decisions 5, 6 and 15).

- **A check** is a `CheckDefinition`: a stable `id` (`cable.tension`; the family is the part before
  the last dot), a `version` (bump it when what it gives can change), the user's factor it compares
  with (`factor: 'strength' | 'fatigue'`, or none), the bodies it needs measured (`measures`), its
  `subjects` (one per record: a `location` for the record id `<check>@<location>`, a title, the
  `SubjectRef`s it is about, the governing load case, and its gathered inputs by symbol) and
  `compute`, which hands the inputs to a `@manufakture/calc` function. Every input is a
  `CheckInput`: an SI value or none, where it came from in words and as an `InputRef`, its kind
  (how an override's expression for it is read) and, when it is missing, why (`missing`: "no
  simulation of lc#4 has run"). `CheckRegistry` holds them; `builtinChecks()` is what this build
  ships. T9.5b to T9.5h register theirs there and add no stored shape.
- **Inputs** come from the model (requirements, load cases, catalog entries through
  `resolveEntry`, materials), from **measured geometry** (`measuredFrom(answers)`: the bodies regen
  measured, in SI; `measuredMassInput` is volume times the material's density) and from the
  **simulation's envelopes**, `SimulationEnvelopes` (`envelope(loadCase, series, statistic)`,
  `state(loadCase)`), which T9.4b supplies; until then `NO_SIMULATION` answers nothing and
  `simulationInput` makes the input missing, naming the load case.
- **The runner** (`runChecks`) applies the user's overrides and factor, computes and wraps each calc
  record as a `MechRecord` (`check`, `subject`, `loadCase`, `inputRefs` by symbol). A missing input
  makes the record `unknown`, with `missing` naming the inputs as the check gathered them and the
  note saying what would give each. A margin or result that is not finite is `unknown` too, never
  room to spare (calc's `marginOf` now gives NaN for a limit that is not above zero). A check that
  throws gives an `unknown` record saying so, never a failed evaluation.
- **Overrides** (`mech.checks`): the most specific one that matches applies, field by field (the
  factor, each input symbol): a subject beats none, the exact id beats a family (`cable.`), a longer
  family beats a shorter one, and among equals the later one wins. An override's input replaces
  the gathered value by symbol and cites the override; a text input (a fit class) reaches `compute`
  as `texts`; an expression for a symbol the check does not read is left out. The factor falls back
  to `domains.mech` (`factorSetting`: the check's own, its family's, its kind's). An override's
  factor that does not evaluate, or is not above 0 and at most 100, makes the record `unknown`
  ("Not compared: ..."); it never silently drops the comparison.
- **Numbers and margins only** (decision 6). With a factor: "factor 2.28, above your 2" or "below
  your 2", the latter a `warning`. With none set: "factor 2.28; not compared: no factor set", and
  no warning (decision 6, no factor ships). `recordText` gives each record's line,
  `statusLabel` a few words for a list; neither ever shows the internal `ok`. The tests check
  every line against safe, pass, fail, certified, compliant and OK.
- **Recomputed only when the inputs change.** Each record is cached in memory (`RecordCache`) by
  `stableKey` of everything that goes into it: the domain's `MECH_IMPLEMENTATION`, the check and
  its version, the record id and title, the subjects, every input's value, source and reason, the
  texts and the factor. A run keeps only the records it used. Nothing is stored.
- **Through regen**: `createMechEvaluation` is the domain's evaluation stage. Its first step asks
  regen to measure the bodies the checks need; its second runs every check and returns
  `MechEvaluation` `{ version: 1, checks: { record, factor?, text }[], disclaimer }` as the result's
  data, plus a `mech-check` warning (the record's line as the message) for every record below the
  user's factor or not computed. A document using neither the `mech` section nor `domains.mech`
  reports nothing. `mechEvaluationOf(result.evaluations)` reads it back (the app's checks panel);
  sessions list the warnings in `get_errors` as `where: 'mech'`, with `id` the record id and
  `check` the check id.
- **The sample check, `cable.tension`** (`cable.ts`): per rope in the design (a purchased use whose
  entry is of the `rope` family) and per load case that pulls the cable, the minimum breaking load
  over the cable tension, against the user's strength factor (calc's `loadFactor`). A dynamic load
  case reads the simulation's peak `cable.tension` (`unknown` until T9.4b runs it); a static one,
  its largest cable pull. T9.5e may refine it.

## Review

`mechDataSummariser` describes a change of `domains.mech` (a start lists both factors, set or not)
and `mechSectionSummariser` a change of the `mech` section, by collection and id, ending with the
notice. `@manufakture/review` calls both for the bundle's `mech` entry.

## The notice

`DISCLAIMER_SHORT` (`src/disclaimer.ts`) is a **placeholder** the agent drafted
(`DISCLAIMER_IS_PLACEHOLDER`); the maintainer may reword it at M9 acceptance (T9.12b, task #1269).
Keep it and the long form in `docs/user/mechanical.md` saying the same thing.

## Dependencies

`@manufakture/core`, `@manufakture/units`, `@manufakture/takeoff` (BOM lines) and
`@manufakture/calc` (the checks' formulas) at run time; `@manufakture/regen` and
`@manufakture/kernel` for types and tests only.
