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

## Purchased parts (`src/parts/`, T9.2a; `src/catalog/`, T9.2b and T9.2c)

One model for every bought part with ratings (ADR 0017 decision 7). Core stores user entries
(`mech.catalog`, `CatalogEntry`) and uses (`mech.purchased`, `PurchasedUse`); this package gives
them meaning.

- **Family field schemas** (`families.ts`): `FAMILY_SCHEMAS`, one per `CATALOG_FAMILIES` family,
  from T9.0c's field lists, at `fieldsVersion` 1 except motor and controller, which T9.2b raised
  to 2 (motor: thermal resistance winding to housing, housing time constant, no-load current, drag
  and viscous loss torques, cogging, and for geared actuators ratio, gear efficiency, backlash, plus
  sensors; controller: continuous and peak power, braking chopper current and smallest resistor,
  feedback and communication interfaces, operating temperatures, and the loss model's fixed loss,
  leg resistance and switching time) and cell, pack and BMS, which T9.2c raised to 2 (cell:
  minimum capacity, stated energy, standard charge current, peak discharge, AC impedance, charge and
  discharge temperature windows, specific heat capacity in J/(kg*K), cycle life, certifications and
  the open-circuit voltage curve as one voltage field per state of charge in `OCV_SOC_PERCENT`, 0,
  5, 10 to 90 by tens, 95 and 100 %, named by `ocvField` (`ocv50`); pack: the cell, full and empty
  voltage, DC resistance, interconnect resistance, peak discharge and maximum charge current; BMS:
  chemistry setting, peak discharge, cell overcharge and overdischarge thresholds, short-circuit
  response time, protections, communication and operating temperatures). Version 2 only added
  fields, so the migration from 1 leaves the ratings as they are. Each `RatingField` has a kind (a `packages/units`
  physical kind stored in SI, `number`, `count` or `text`), optional `options`, `conventions`,
  `basis` and `bom` (the comparison a BOM line states: `at-least`, `at-most`, `equals`). Geometric
  sizes are dimensions (mm, `DIMENSION_NAMES`), not ratings. `entryProblems(entry)` checks an
  entry against its family; since T9.2b it requires a convention on any Kv, Kt, R or L given (an
  `unknown` needs none), refuses a convention ending `, output side` when no gear ratio is given,
  and keeps a motor's ratio above zero, gear efficiency in (0, 1] and backlash not below zero.
  Since T9.2c it also keeps a cell's specific heat above zero and pack counts and a BMS's fewest
  cells from 1, refuses pairs out of order (cutoff above nominal voltage, nominal above maximum,
  minimum capacity above typical, standard charge above maximum, peak discharge below continuous,
  temperature windows upside down, a BMS's fewest cells above its most or overdischarge above
  overcharge, cutoff above maximum voltage, a pack's empty above its full voltage, `ocv0` below the
  cutoff, `ocv100` above the maximum voltage) and a cell OCV curve that falls as the charge rises (a flat stretch is fine).
  `KV_CONVENTIONS` and `KT_CONVENTIONS` list the conventions, each also at the output side
  (`OUTPUT_SIDE`). `migrateEntry` migrates ratings in memory and refuses a newer `fieldsVersion`.
- **The built-in catalog** (`catalog.ts`): `BUILTIN_ENTRIES`, every version ever shipped, sorted
  by id then version: T9.2a's few samples plus the family catalogs of `src/catalog/`
  (`FAMILY_CATALOG_ENTRIES`), all typical published values, all `verified: false`.
  `resolveEntry(doc, ref)` gives the entry a `CatalogRef` names (pinned version for built-ins), or
  `unknown-entry` / `newer-fields`, never a guess; it reports a `newer` version and `deprecated`.
  `copyBuiltin` copies one into a user entry with `derivedFrom`.
- **The family catalogs** (`src/catalog/`): `MOTOR_ENTRIES` and `CONTROLLER_ENTRIES` (T9.2b),
  `CELL_ENTRIES` and `BMS_ENTRIES` (T9.2c), joined into `BUILTIN_ENTRIES`; T9.2d and T9.2e add
  theirs the same way. Cells: Molicel P45B and P42A, Samsung 40T and 30Q, Murata VTC6, the small
  high-rate Murata VTC3 (sixteen in series make 92.2 Wh, the class of a 16S pack under 100 Wh) and
  the A123 ANR26650M1-B (LFP). No maker publishes an OCV table, so built-in cells use the generic
  curve; no datasheet gives specific heat, so it is a typical value, estimated. BMS boards: Daly
  16S lithium-ion 30 A and 16S LFP 40 A, Overkill Solar (JBD) 16S LFP 100 A, from distributor
  pages and search summaries, with the thresholds they are sold set to. Each motor entry stores Kv, Kt,
  R and L as the datasheet gives them, with the convention named, and its sources and notes say
  where they disagree. `motorTorqueConstant`, `motorVelocityConstant`, `motorResistance` and
  `motorInductance` (`conventions.ts`, ADR 0017 decision 8) turn an entry's value into the one
  internal convention: Kt in N*m per ampere of phase current amplitude, Kv in rad/s per volt of
  line-to-line amplitude, R and L as the equivalent wye phase-to-neutral values, all motor side
  (an output-side constant is moved through the ratio). Each returns
  `{ ok: true, value, derivation, derived?, estimated? }`, with the working in words for a calc
  record to cite (`derived` when Kt came from Kv, `estimated` when an input was), or
  `{ ok: false, missing, message }` naming the missing fields (`kt.convention` for no convention
  or one not in the list, `ratio` for an output-side constant without a usable ratio). They never
  guess.
- **Cells and packs** (`src/catalog/pack.ts`, T9.2c). `cellOcvCurve(cell)` gives a cell's
  open-circuit voltage curve (`points` of state of charge 0 to 1 and volts): its own `ocv*` fields
  when both ends (0 and 100 %) are given, points between may be missing; a partial curve without
  both ends is refused, naming the missing ends; with none, the generic curve of its chemistry
  (`GENERIC_OCV`: layered oxide for NMC, NCA and LCO, and LFP), marked `generic` and `estimated`;
  `other` or no chemistry is refused. `ocvAt(points, soc)` interpolates linearly, clamped.
  `buildPack(cell, { series, parallel, interconnect?, enclosureMass? })` refuses counts that are
  not whole numbers from 1 to `MAX_PACK_COUNT` (1000), a negative resistance or mass and an entry
  that is not a cell; otherwise every derived value is a `Normalised` with its working: nominal,
  full and empty voltage and the OCV curve `series` times the cell's; capacity and continuous,
  peak and charge current limits `parallel` times the cell's (equal current sharing assumed);
  energy as nominal voltage times rated capacity (the airline 100 Wh rule's figure); DC resistance
  `series * R_cell / parallel` plus the interconnects (`per: 'pack'`, or `per: 'series joint'`
  times `series - 1`); mass of the cells plus the enclosure (everything but the cells); the cells'
  heat capacity (mass times specific heat); and the short-circuit current, full voltage over DC
  resistance, always `estimated`. A value whose cell input is missing is `{ ok: false, missing }`,
  never guessed; estimates carry through. `packRatings(pack, cellName)` writes a built pack as the
  ratings and mass of a `pack` entry; with no interconnects given, `interconnectResistance` is
  `unknown` (absent from `Pack`, never a stated zero) and the resistance carries the basis "cells
  only, interconnects not included". The generic layered-oxide curve tops out at 4.19 V and is not
  rescaled for cells charged above 4.2 V.
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

## Requirements and load cases (`src/requirements/`, T9.4a)

Core stores them (`mech.requirements`, `mech.loadCases`, ADR 0017 decision 10); this module gives
them meaning, in SI throughout.

- **Values** (`values.ts`): `siValue(expr, kind, variables, dimension?)` reads one expression in
  coherent SI (a length site in metres, an angle in radians, a physical kind in its SI unit; a site
  of kind `any` against an optional dimension). `FieldReader` collects `ItemProblem`s
  (`{ path, message }`, the path from the item) with range checks.
- **Resistance laws** (`laws.ts`): `resolveForceLaw(dynamic, variables)` gives a `ForceLaw` or every
  problem by field, and `forceAt(law, x, v)` evaluates it: `x` the cable extension (m) from where
  the rep starts, `v` the speed (m/s, positive paying out). The load case's `force` is the base
  force for constant, eccentric (`factor` at least 1 on the return), band (`F + rate x`), chains
  (`F + rate max(0, x - from)`), isokinetic (`F` at the speed limit, none below it) and isometric;
  for damper (`min(c v, F)`, N·s/m), rowing (`min(c v^2, F)`, N·s²/m²) and table (linear in its
  points, flat beyond the ends) it is the most the law gives. Damper and rowing give nothing on the
  return; take-up tension is the drivetrain's. `limitSpeed` caps a speed at the isokinetic limit.
  `forceCurves(law, range)` samples force against extension (pull and return) and against speed
  (at mid-stroke), breakpoints on both sides, for the editor's plot.
- **Motion and duty cycle** (`motion.ts`): `resolveDynamic(dynamic, variables)` gives a
  `ResolvedDynamic` (law, motion, reps, sets defaulting to 1, rest to 0, start charge, ambient in
  K) or every problem by field; reps and sets are whole numbers up to `MAX_REPS` and `MAX_SETS`.
  `repSegments(law, motion)` cuts one rep into `Segment`s as the T9.0b spike did: a half-cosine
  pull peaking at `pullSpeed` (pi stroke / (2 pullSpeed) long), a pause, the return, a pause; a
  table motion as straight moves; an isometric case as a hold at mid-stroke (or the table's first
  extension). Under the isokinetic law a faster half-cosine follows the cosine to the limit, holds
  it and still covers the stroke (`capped`); a straight move is slowed. `segmentKinematics`,
  `sessionSegments` (sets of reps with rests, at most `MAX_SESSION_SEGMENTS`), `stateAt` (extension,
  speed and the law's force at a time) and `dutyCycle` (rep, set, session and working time) are
  what the rep simulation (T9.4b) steps through.
- **Requirements** (`requirement.ts`): `REQUIREMENT_QUANTITY_TEXT`, `quantityText`,
  `comparisonWords`, `requirementText(r, loadCases)` (the values as typed), and
  `requirementProblems` / `loadCaseProblems` (values in their kind, sizes above zero, tolerances
  not below zero, named load cases and drivetrains that exist, a load case with a motion or static
  loads), with `itemProblemText` for a line.
- **Templates** (`templates.ts`): `MECH_TEMPLATES` (cable trainer, winch, linear axis) and
  `templateCommand(doc, id)`, one batch that appends the template's load cases (fresh `lc#n`) and
  requirements (fresh `req#n`, naming those load cases) to the document's. The cable trainer takes
  its targets from T9.0c's drafted list (`docs/research/electromechanical.md`, R1 to R18), each
  requirement named with its R number; targets the model cannot state (R3, R5, R15's other modes,
  R16, R17) are left out, and no template fills in a safety factor. R11 and R14 are used only in
  part: the full charge within 2.5 h is a requirement but the 140 W USB-C input is not stated, and
  of R14's 0 to 40 °C only the 40 °C end appears (as the hold case's ambient).

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
