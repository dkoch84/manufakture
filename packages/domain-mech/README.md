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

## Purchased parts (`src/parts/`, T9.2a; `src/catalog/`, T9.2b to T9.2e)

One model for every bought part with ratings (ADR 0017 decision 7). Core stores user entries
(`mech.catalog`, `CatalogEntry`) and uses (`mech.purchased`, `PurchasedUse`); this package gives
them meaning.

- **Family field schemas** (`families.ts`): `FAMILY_SCHEMAS`, one per `CATALOG_FAMILIES` family,
  from T9.0c's field lists, at `fieldsVersion` 2 except `generic` (still 1): motor and controller, which T9.2b raised
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
  response time, protections, communication and operating temperatures), and bearing, belt,
  pulley, gear and rope, which T9.2d raised to 2 (bearing: SKF's calculation factors `kr` and `f0`
  and the contact angle; belt: the rated working tension on the largest pulley of the maker's
  table and its grooves, so a check interpolates between it and the rating at the fewest grooves,
  teeth in mesh the rating assumes, tensile stiffness EA, mass per length, drive efficiency and an
  endless belt's teeth; pulley: material, flanges, mounting and highest rim speed, the pitch
  diameter being derived; gear: surface durability torque, helix angle, material, hardness and
  quality grade; rope: suggested bend ratio, what the breaking loads are (`strengthBasis`:
  spliced, unterminated, terminated, not stated), termination efficiency, elastic elongation with
  the fraction of break it is stated at, design factor, cycle rating, creep and fatigue notes),
  and wire, connector, fuse, switch and resistor, which T9.2e raised to 2 (wire: a bundled
  ampacity beside the free-air one, the conductor count it assumes and the ambient both are
  stated at, insulation temperature rating and lowest temperature, conductor (copper, tinned
  copper, copper-clad aluminium, aluminium), cross-section in mm², strands, strand diameter in mm
  and mass per length; connector: burst current with its basis, wire range, an anti-spark contact
  and operating temperatures; fuse: the voltage the interrupting rating is stated at, melting I²t
  in A²s, the longest opening times at 135 and 200 % of rating, the largest continuous current as
  a fraction of the rating, cold resistance, voltage drop and operating temperatures; switch: the
  voltage DC breaking is stated at, short-time and making current, mechanical life, contact
  resistance, a contactor's coil voltage, hold power and inrush current, auxiliary contacts,
  operating temperatures and a `rotary` kind, with a basis on continuous and breaking current;
  resistor: the pulse length and repetition period the pulse energy is stated for, power with no
  heat sink, tolerance, thermal resistance surface to ambient and hottest surface allowed).
  Version 2 only added fields, so the migration from 1 leaves the ratings as they are. Each `RatingField` has a kind (a `packages/units`
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
  Since T9.2d it keeps a bearing's `kr` and `f0` above zero, contact, pressure and helix angles
  below 90 degrees, a belt's efficiency, a rope's termination efficiency and the elongation load
  fraction in (0, 1], elongation from 0 below 1, bend ratios above zero, a design factor from 1 and
  teeth in mesh from 1, and refuses a bearing's fatigue limit above C0, a belt's large-pulley
  grooves or tension below the fewest-grooves ones or either tension above the breaking strength,
  and a rope's minimum breaking load above the average or minimum bend ratio above the suggested.
  Since T9.2e it keeps a wire's resistance, cross-section and strand diameter above zero and its
  strands and bundled conductors from 1, a connector's poles from 1, a fuse's I²t above zero and
  continuous fraction in (0, 1], and a resistor's tolerance from 0 below 1, and refuses a wire's
  bundled ampacity above the free-air one or its ambient or lowest temperature above its rating, a
  connector's burst or a switch's short-time current below the continuous one, a fuse's rating
  above its interrupting rating or its 200 % opening time above the 135 % one, a switch's
  electrical life above its mechanical life, and a resistor's free-air power above its mounted
  power or pulse longer than its period.
  `KV_CONVENTIONS` and `KT_CONVENTIONS` list the conventions, each also at the output side
  (`OUTPUT_SIDE`). `migrateEntry` migrates ratings in memory and refuses a newer `fieldsVersion`.
- **The built-in catalog** (`catalog.ts`): `BUILTIN_ENTRIES`, every version ever shipped, sorted
  by id then version: T9.2a's few samples plus the family catalogs of `src/catalog/`
  (`FAMILY_CATALOG_ENTRIES`), all typical published values, all `verified: false`.
  `resolveEntry(doc, ref)` gives the entry a `CatalogRef` names (pinned version for built-ins), or
  `unknown-entry` / `newer-fields`, never a guess; it reports a `newer` version and `deprecated`.
  `copyBuiltin` copies one into a user entry with `derivedFrom`.
- **The family catalogs** (`src/catalog/`): `MOTOR_ENTRIES` and `CONTROLLER_ENTRIES` (T9.2b),
  `CELL_ENTRIES` and `BMS_ENTRIES` (T9.2c), `BEARING_ENTRIES`, `BELT_ENTRIES`,
  `PULLEY_ENTRIES`, `GEAR_ENTRIES` and `ROPE_ENTRIES` (T9.2d), `WIRE_ENTRIES`,
  `CONNECTOR_ENTRIES`, `FUSE_ENTRIES`, `SWITCH_ENTRIES` and `RESISTOR_ENTRIES` (T9.2e), joined
  into `BUILTIN_ENTRIES`. Wire: one seller's fine-stranded silicone wire at 10, 12, 14, 16, 18 and
  22 AWG (200 °C, 600 V); the cross-section is the stated stranding's, the resistance copper over
  it and the mass copper plus silicone, both estimated; ampacity is the NEC 200 °C column at 40 °C
  ambient (free air, and at most three conductors in a raceway) for 10 to 14 AWG and PowerStream's
  chassis wiring figure for the smaller sizes, each with its basis. Connectors: Amass XT30U, XT60
  and anti-spark XT90-S (continuous 4 h and burst 1 min under 60 °C rise, as Holybro reproduces
  Amass), Anderson SB50 and a 17-position JST XH balance lead. Fuses: Littelfuse ATO 32 V 20 A,
  TAC ATO-style 58 V 30 A and MIDI High Performance 70 V 30 A, the only one rated for a 16S
  pack's 67.2 V. Switches: a TE KILOVAC EV200 contactor (2000 A break once at 320 V, 1.7 W coil
  hold), a Blue Sea 6006 battery switch (48 V, no breaking rating) and a Carling V-Series rocker
  (20 A at 12 V DC). Braking resistors: TE HCH165 and HCH215 at 6.8 ohm (200 and 300 W, pulse
  energy for a 1 s pulse in a 120 s cycle), an Arcol HS100 3.3 ohm (100 W on its heat sink, 30 W
  without, no pulse figure) and ODrive's 2 ohm 50 W part. Bearings: SKF 6202-2RSH, 6204-2RSH, thin-section 61805-2RS1
  and angular contact 7202 BEP from a catalogue mirror (SKF's pages render with script), and the
  INA HK1612 drawn cup needle bearing. Belts: Gates 2MGT 6 mm, 3MGT 15 mm and HTD 5M 15 and 25 mm,
  rated at the fewest grooves and at 45 from the design manual's table 6, efficiency typical and
  estimated. Pulleys: Gates P20 and P90-5MGT-15 (a 4.5:1 pair) and a 20-tooth GT2 printer pulley.
  Gears: KHK SS1-20 and SS1-60 (module 1 steel, 3:1) and the moulded acetal DS1-20. Rope: Samson
  AmSteel-Blue HMPE at 2.5 and 3 mm (spliced strengths; the 3 mm line is T9.3b's spool example)
  and galvanised 7x19 steel at 3/32 and 1/8 in, whose 34:1 minimum bend ratio is why a portable
  trainer uses fibre. T9.2a's samples (`bearing/skf-6001-2rsh`, `bearing/skf-6005-2rsh`,
  `belt/gates-5mgt-15`) stay at fields version 1 and migrate. Cells: Molicel P45B and P42A, Samsung 40T and 30Q, Murata VTC6, the small
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

## Drivetrain (`src/drivetrain/`, T9.3a)

Core stores the chain (`mech.drivetrains`, ADR 0017 decision 9); this module reads it into numbers
and states them as calc records. One degree of freedom per drivetrain, from the motor to the
output; couplings between drivetrains and coupling mates are a later phase.

- **The chain** (`chain.ts`): `drivetrainChain({ document, variables, measured?, partBodies? }, d)`
  gives each stage's ratio and efficiency, `n` (the motor's speed over an element's) at every
  stage's input and output, every turning element with its inertia, and the problems by path from
  the drivetrain. A ratio is input speed over output speed (a 5:1 reduction is 5); tooth counts
  give driven over driver. A ratio must be above 0, a tooth count a whole number from 1, an
  efficiency above 0 and at most 1, an inertia not below 0.
- **Where an inertia comes from**, in order: the stage's typed `inertia` (it wins, the user typed it
  on purpose), the motor entry's `rotorInertia` (catalog), or the kernel's mass properties of the
  bodies the named instance shows (each body's volume inertia times its material's density, moved
  to the common centre of mass). A motor's instance is never measured (its housing is not its
  rotor). A reduction's typed inertia is referred to its input, as gearbox datasheets give it; a
  gear or planetary stage's `instances` are measured with the first at the input speed and the
  rest at the output speed (the order of `{ driver, driven }`). A belt's inertia is typed or not
  counted. A gear or planetary member fixed in the assembly (a held ring) does not turn and is not
  counted; members that turn at a third speed (planets, a turning ring) need the stage's inertia
  typed, which the records say for every planetary stage. The spin axis is not in the model, so a
  measured element turns about its axis of symmetry: the principal axis whose moment differs most
  from the other two (the largest for a disc or spool, the smallest for a shaft); the records say
  so with the three moments, and add that the axis is a guess when no two moments agree within
  `SYMMETRY_TOLERANCE` (5 %). A linear output adds a zero element for the screw and the load it
  carries, and every record says that the screw's lead, efficiency, inertia and carried mass are
  not in it (the numbers stop at the screw shaft). An element
  with no source counts as zero, stated in the records' assumptions; one whose source gives no
  value (a missing instance, an unmeasured body, no material, a catalog entry with no rotor
  inertia) makes the records that need it `unknown`, naming why.
- **Nested sub-assemblies**: an instance of a part from another document (how a sub-assembly
  enters an assembly) is not measured, as the session's assembly mass skips it; type its inertia.
  A suppressed instance is not measured either.
- **Records** (`records.ts`), `MechRecord`s with `check` and the drivetrain as subject, none with a
  factor or limit: `drivetrain.ratio` (the product of the ratios), `drivetrain.efficiency` (the
  product of the efficiencies), `drivetrain.inertia` (reflected to the motor, `J = sum J_k / n_k^2`,
  by equal kinetic energy, each term in the working) and `drivetrain.inertia-output` (`J i^2`).
  `analyseDrivetrain` / `analyseDrivetrains` give the chain with its records and the two inertias.
- **Torque** (`torque.ts`): `motorTorque(chain, { outputTorque, outputAcceleration?, flow })`, a
  `drivetrain.torque` record. A positive acceleration speeds the motion up in its own direction.
  With `flow: 'driving'` the motor's torque is in the direction of motion and every efficiency
  divides on the way back to it, `T_m = T_out / (i eta) + sum J_k alpha_m / (n_k^2 eta_k)`. With
  `'back-driven'` (the user pulling the cable out, the motor generating) the motor's torque is
  against the motion: the user's torque crosses the chain toward the motor, each element takes
  what its acceleration needs on the way, and what is left reaches the motor times the
  efficiencies, so `T_m = T_out eta / i - sum J_k alpha_m eta_k / n_k^2`. Here
  `alpha_m = i alpha_out` and `eta_k` is the product of the efficiencies between the motor and
  element k. A steady torque needs no inertias.
- **References**: a stage naming an instance, mate, purchased use or body that is not there is a
  `reference` problem, and `drivetrainWarnings` turns each into a `mech-reference` warning on the
  drivetrain (`objectId` the drivetrain, `target` the missing id). A chain not starting at its one
  motor, a motor stage whose use is not a motor, or a mate that is not revolute is a `structure`
  problem; an expression that does not read or is out of range, a `value` problem.
- **Through regen**: the evaluation stage's first step also asks for the bodies of every instance a
  drivetrain would measure (`drivetrainNeeds`: nothing typed or catalog-given); its second adds
  `drivetrains: DrivetrainAnalysis[]` to `MechEvaluation` (absent when the document has none) and
  the `mech-reference` warnings. `MECH_IMPLEMENTATION` is 6 (bumped for the spool, T9.3b, then for
  the electrical system, T9.7a).
- **The typed override** is core's optional `inertia` (an `inertia` expression) on every stage and
  on spool and rotary outputs, added within format version 19 (ADR 0017 decision 9 lists it).
- Tests: `drivetrain.test.ts` holds the acceptance, direct drive and a 5:1 belt drive of the same
  spool against a hand calculation written out step by step; `drivetrain.regen.test.ts` measures a
  placed bearing (a tube) with the real kernel against `m (ro^2 + ri^2) / 2`.

## Spool and cable (`src/spool/`, T9.3b)

The output stage of a winch or trainer: a drivetrain's `spool` output read into numbers, wound, and
stated as calc records. `analyseDrivetrain` carries it as `DrivetrainAnalysis.spool`, so it reaches
regen's `mech` evaluation data with the drivetrain.

- **Winding** (`winding.ts`, pure, SI, no document vocabulary): `wind({ core, width }, d, length)`
  gives the layers from the core outward. Simple stacked winding: each layer adds one cable
  diameter, so layer n's pitch radius is `r_n = D_core/2 + d/2 + (n - 1) d`; every layer holds
  `N = floor(w / d)` turns (the cable centres from d/2 to w - d/2) and `N 2 pi r_n` of cable; the
  last layer may be partial. Stacked is the upper bound on the radius (full nesting adds
  `d sqrt(3)/2` per layer), so it gives the most torque per newton. The cable pays out from the
  outermost layer first. The functions the simulation (T9.4b) and the checks (T9.5e) read:
  `layersWound(w, paidOut)`, `effectiveRadius(w, extension)` and `layerAt`, `spoolAt(w, extension)`
  (layer, radius, which is also the torque per newton, and `1 / r`, the spool speed per m/s of
  cable), `radiusSteps(w)` (radius against extension as steps, outermost first), `outerSurface`
  and `bendRatio(D, d)`. Extensions outside 0 to the length are clamped. A length needing more
  than `MAX_LAYERS` (1000) layers winds nothing (`tooManyLayers`) and the records are `unknown`,
  so a typo cannot stall regen.
- **Reading** (`spool.ts`): `readSpool(ctx, d, output)` takes the drivetrain's context. The cable is
  the purchased use `output.cable`, which must be a `rope` entry (else a `structure` problem): its
  `diameter` dimension (mm to m), breaking loads, bend ratios, elastic elongation and its
  reference load, and mass per length, each with its catalog ref. The cable length, core
  diameter, width between the flanges and the fairlead's bend diameter are typed lengths. The
  flange diameter is typed or read from the spool body: regen measures the body (or the
  instance's bodies) and its tight bounding box in the part's coordinates; the axis is the one
  whose two cross extents agree within `ROUND_TOLERANCE` (1 %) while the third differs, and the
  outside diameter is taken as the flange diameter. The core and the width are inside the body,
  where a bounding box cannot see, so they are typed; a record that needs one says to type it,
  with the body's outside diameter and length. A typed width longer than the body, or a flange
  smaller than the core, or a typed length not above zero, is a `value` problem; a cable that is
  not a rope a `structure` one. `analyseDrivetrain` adds them to the drivetrain's `problems`, so
  the panel lists them, the toolbar counts them and the panel refuses to save the ones it can see
  without a measurement. `spoolNeeds` (called from `drivetrainNeeds`) asks
  for the body when no flange is typed or when a width is typed (to compare). The requirements
  used are the most demanding `travel`, `maxForce` and `peakCableSpeed` (`>=` or `>`) that name
  this drivetrain or none.
- **Records** (`records.ts`), subject the drivetrain: `spool.layers` (layers at full wind; the
  working lists N, each layer's radius and cable, the turns in the top layer and the cable mass),
  `spool.radius-wound` and `spool.radius-out` (the effective radius at zero extension and at full
  payout, with the torque per newton, and the torque at the maximum force and the spool speed at
  the peak cable speed when those requirements exist), `spool.flange-clearance`
  (`D_f/2 - (D_core/2 + n d)`, compared with `FLANGE_CLEARANCE_GUIDE` = 2 cable diameters, a winch
  drum rule of thumb stated as one; below it, and below zero where the top layer stands over the
  flange, the status is `warning`), `spool.bend-ratio` (core diameter over d) and `spool.fairlead-bend-ratio` (when a
  fairlead is typed), each against the rope's minimum bend ratio with the suggested one beside it
  (the status is `warning` below the minimum; below the suggested one the note says so; with no
  minimum in the entry the ratio is shown with nothing to compare), `spool.travel` (the cable
  length against the travel requirement, or the length alone with a note when none applies) and
  `spool.stretch` (`eps_ref F / (f_ref F_break) L`, linear through the catalog's one elongation
  point, at the maximum force over the whole length; a braided fibre rope stiffens with load, so
  this line understates the stretch below the reference load and overstates it above). The rope's
  design factor is not a spool
  record: `cable.tension` (T9.5a) compares tension with the breaking load against the user's
  factor. No factor ships and no record calls anything safe.
- **Assumptions** stated in the records: stacked and level winding, the whole length wound at zero
  extension and all of it paid out (no dead turns, no cable between the spool and the fairlead),
  a round cable that keeps its diameter, D at the core and at the fairlead's tread.
- **Measured geometry**: `MeasuredBody.boundingBox` (metres, from regen's `BodyMeasure`) is new for
  the spool; other readers ignore it.
- Tests: `spool.test.ts` holds the acceptance, 2.85 m of the 3 mm AmSteel-Blue on a 40 mm core,
  20 mm wide, against a hand calculation written out step by step (6 turns a layer, 4 layers,
  30.5 mm at full wind, 21.5 mm at full payout, 27.5 mm at 1 m out, 8 mm of flange over the top
  layer, D/d 13.3); `spool.regen.test.ts` reads the flange diameter of a placed bearing (47 mm
  across) from its bounding box with the real kernel.

## Electrical system (`src/electrical/`, T9.7a)

Core stores the system (`mech.electrical`, ADR 0017 decision 11: components, connections between
their terminals, harness segments, and the diagrams' manual nudges); `src/electrical/model/` reads
it into a model. Nothing in it needs the kernel, so the panel reads it straight from the document.

- **Roles** (`roles.ts`): `ROLE_DEFS` gives each of core's roles its text, its default terminals
  (a pack `+` and `-`; a controller `bus+`, `bus-`, `a`, `b`, `c`, `brake+`, `brake-`, `signal`; a
  BMS `b+`, `b-`, `p+`, `p-`, `signal`; and so on), how each terminal takes part in the current
  paths (`source`, `draw` with a simulated quantity or the typed load, `through` within a group,
  `precharge`) and the catalog families the role may use (`generic` always may; `other` takes
  anything). **Terminal ids are a published contract**: connections and schematic ports (decision
  12, T9.7d) name them, so a default id is never renamed or removed, as a built-in catalog entry is
  never edited; adding a default terminal is allowed. The test `terminals are stable` pins the list.
- **Terminals of a component** (`componentTerminals`): its own typed list (core's `terminals`)
  wins; else a `connector` with a connector entry gets pins `1` to `poles` (kind `power`); else
  the role's defaults. A connector pin is one node: the wires on both halves of the connector
  meet at the same pin id. A pin's `effectiveKind` (on the connection's end) is what its net
  carries: walking the connections through any connector pins, `phase` if it reaches a phase
  terminal, else `signal` if a signal one, else `power` or `ground`. A phase or signal line
  through any number of connectors therefore keeps its kind for the kind check and the currents.
- **The model** (`system.ts`): `analyseElectrical({ document, variables })` gives every component
  with its terminals and where they came from, its catalog entry in words and whether it is
  verified, its instance and its typed always-on load (A, V); every connection with its two ends,
  its wire and the segments that carry it; every segment with its length; and the problems by
  path from `mech.electrical`:
  - `reference`: an assembly, instance, component, terminal, purchased part or connection that is
    not there, or a component's or a wire's catalog entry that does not resolve.
    `electricalWarnings` turns each into a `mech-reference` warning (`objectId` the component,
    connection or segment; `target` the missing id, `<component>/<terminal>` for a terminal). A
    missing assembly is reported on each component and segment that names an instance in it
    (`target` the assembly), and only once on the system when none does.
  - `dangling`: a terminal nothing connects to (`target` `<component>/<terminal>`, path ending in
    the terminal's index in the component's terminals).
  - `structure`: a part of a family the role does not use, a wire that is not a wire entry, a
    terminal listed twice, a connection from a terminal to itself, or one joining kinds that do
    not belong together (power or ground to a signal or a phase), comparing a pin's
    `effectiveKind`.
  - `value`: a load or length that does not read, a negative load, a length not above 0.
- **Harness lengths**: typed, or measured: the straight line between the origins of its two ends'
  instances (a component end uses the component's `instance`) at their stored poses, plus the
  typed slack for the route, bends and service loops (`MEASURED_LENGTH_ASSUMPTION`). Nothing
  follows a route around the parts. A measured segment whose ends are not both placed has no
  length and says which end is missing.
- **The current on each connection** (`currents.ts`):
  `connectionCurrents(ctx, simulation?, analysis?)` is the hook the simulation fills. The structure
  is final now; the values are not:
  - Terminals are nodes; connections and each role's `through` groups join them (a fuse's `1` and
    `2`, a BMS's `b+` and `p+`). A precharge conducts only while the bus charges, so it is not a
    through path; a connection at it carries the precharge's `precharge-current`.
  - A **power** connection: take it out, find the side with a source (a pack, a DC-DC converter's
    output, a controller's brake output or a chopper's resistor output), and sum what draws on
    the other side: a controller's or chopper's `bus-current`, a braking resistor's
    `resistor-current`, a charger input's `charge-current` and the typed loads of the always-on
    parts. Peaks and RMS values add (an upper bound when the parts do not peak together); running
    and charging are separate modes, and the larger is taken. A connection in a loop of parallel
    paths, fed from both ends, fed from neither, or with nothing drawing beyond it is
    `unresolved`, saying why: the model does not divide currents.
  - A **phase** connection carries the `phase-current` of the controller on that line (through any
    connector pins), else the motor's. A **signal** connection is taken as negligible (0, with the
    assumption stated).
  - Simulated parts are read as series `electrical/<component>/<quantity>`
    (`electricalSeries`) with statistics `peak` and `rms`, per load case, through
    `SimulationEnvelopes`. **T9.4b names its series to match.** Until it runs, `NO_SIMULATION`
    leaves every simulated part unknown, naming the series and the load case
    (`electrical/el#6/bus-current: no simulation of lc#1 has run`). When a connection's parts are
    all typed loads, `steady` gives its current now. T9.5f (wire ampacity and voltage drop, fuse
    and connector ratings) and T9.7c (power budget) read this; `sources` names the components
    that feed a power connection, for the voltage they will need.
- **The template** (`template.ts`): `electricalTemplateCommand(doc)` appends the cable trainer's
  system (14 generic components and 31 connections: pack, BMS, main fuse, contactor with a
  precharge across it, controller with its brake output to a braking resistor, motor phases, a
  charger input on the BMS's load side, a DC-DC converter feeding the controller board, encoder,
  load cell and display) as one `setElectrical`, so one undo step. Its always-on loads are
  estimates to replace; it has no harness, as segments need the parts placed. With the
  requirements template's load cases and the series supplied, every connection carries a current
  in every load case (the acceptance test in `electrical.test.ts`).
- **Through regen**: the evaluation stage's second step adds `electrical: ElectricalAnalysis` to
  `MechEvaluation` (absent when the document has none) and the `mech-reference` warnings of
  `electricalWarnings`, so they reach an agent's `get_errors`; dangling, structure and value
  problems stay in the model (the panel lists them). Nothing is measured: lengths come from stored
  poses. `MECH_IMPLEMENTATION` is 6. `electrical.regen.test.ts` checks it with the real kernel.
- No core change: core already had every field and command this needs.

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
