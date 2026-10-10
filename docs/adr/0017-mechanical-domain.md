# 0017: The mechanical domain: a typed mech section, calc records that never certify, purchased parts as versioned data, simulation and FEA on the client

- Status: accepted (2026-10-10, task #1230, no amendments)
- Date: 2026-10-10

## Context

M9 lets a person design a machine that moves and carries load, size it to a stated outcome, check that it holds together and come away with specifications someone can build from ([M9 plan](../plans/m9.md)). The reference machine is a portable cable trainer: a 6 kg box with a spool, a motor and a battery that pulls a cable at 5 to 200 lbf. The plan's ten cross-cutting decisions, its domain model, its checks and its task scopes are the starting point; this ADR (task T9.0d) fixes the shapes and rules the other 44 tasks build on, and decides what the plan left open.

The inputs:

- **The [M9 plan](../plans/m9.md)**: decisions 1 to 10, "The domain model", "The checks", every task's scope, three open questions with assumed defaults, and the later phases.
- **The [T9.0a spike](../spikes/T9.0a-fea.md)** (done 2026-10-10). gmsh compiled to WebAssembly (`@loumalouomega/gmsh-wasm` 0.3.0, GPL-2.0-or-later) meshes the kernel's STEP into TET10 elements with exact curved faces and the kernel's face order; an own TypeScript solver with AMG-preconditioned conjugate gradients converged in 17 to 26 iterations from 3k to 940k DOF. Every benchmark (cantilever, plate with a hole, Lame cylinder) was within 1.4 % at every density. One analysis took 3.7 to 6.2 s at about 200k DOF and 10.2 to 16.0 s at about 500k in Chromium, Firefox and WebKit; memory is the limit (1.6 to 2.4 GiB renderer peak at 500k). The prebuilt `.wasm` contains Blossom IV, used under a permission "only for use within the Gmsh system", which is not GPL-compatible.
- **The [T9.0b spike](../spikes/T9.0b-sim.md)** (done 2026-10-10). The lumped model of plan decision 6 closes its energy ledger below 10⁻⁸, lands on two makers' datasheet curves within 1.4 %, and runs a 466 s session in about 50 ms with quasi-static currents at 1 ms under the implicit midpoint rule. It found that the same two numbers give copper losses a factor of two apart depending on the resistance convention (119 W against 237 W), that the return stroke draws 12C from the pack, and that the braking resistor takes 41 % of a session's energy.
- **The [T9.0c research](../research/electromechanical.md)**: published specifications of six machines, representative parts and the conventions their datasheets use (resistance phase-neutral, phase to phase or line to centre; Kt per amp of amplitude or RMS; motor side or output side), field lists for every catalog family, and the standards a builder should know about, by name and scope only.
- **`packages/calc` as T9.1d built it** ([README](../../packages/calc/README.md), [`src/record.ts`](../../packages/calc/src/record.ts)): pure functions over SI numbers returning `CalcRecord`s, with no domain vocabulary and no dependencies.
- **The code at format version 18.** `packages/core/src/materials.ts` has nine built-in materials with density only, picked by id (`Part.material`, `bodies[].material`), and no user materials. `packages/units` has `QuantityKind = 'length' | 'angle' | 'feed' | 'spindleSpeed' | 'number'` over a `Dimension` of length, angle and an optional time. `print` and `cam` are required typed sections; `scripts` and `drawings` are optional ones, absent when unused and never empty. `RegenWarning` is a discriminated union (the wall check's `thin-wall` and `wall-unchecked` are the closest precedent for a check), and the session's `get_errors` lists `ErrorLine`s of `{ where, severity, code, message, ... }`.
- **ADRs it builds on**: [0004](0004-document-format.md) (nothing derived is stored; every shape change bumps the format; ids permanent; numbers as `StoredExpression`s; cache keys), [0005](0005-units.md) (all input through `packages/units`; bare numbers mean the display unit), [0006](0006-licensing.md) (the allowlist; LGPL only as a separate module), [0008](0008-assembly-mate-solver.md) (decision 6: couplings wait for OndselSolver), [0013](0013-domain-packages.md) (domain packages, `domains` holds settings and not model, typed sections for content that fails that test), [0015](0015-construction-domain.md) (the style model, and decision 8, "not an engineering tool", which this ADR departs from for the mechanical domain only) and [0016](0016-agent-sessions.md) (sessions, the MCP surface, add-only tools, compute limits).
- **The maintainer's decisions of 2026-10-10**, given as instructions for this ADR: FEA runs in the browser only (decision 13); stress and life are numbers and margins against the user's own factor, never "safe" (decision 6); schematic capture is in M9 (decision 12, which amends plan decision 8); and the agent drafts the disclaimer, which the maintainer may reword at M9 acceptance (decision 17).

## Decision

1. **One domain package, `packages/domain-mech`, owning the `mech` namespace**, pure TypeScript under GPL-3.0-or-later, under ADR 0013 decision 1.
   - **Mechanical and electrical in one domain** (plan decision 2). The simulation needs the motor, the controller and the pack in one model, and no domain imports another.
   - **Run-time dependencies**: `@manufakture/core`, `@manufakture/units`, `@manufakture/calc` (formulas, decision 5) and `@manufakture/takeoff` (BOM lines, decision 7). `@manufakture/regen` and `@manufakture/kernel` are type-only devDependencies. The simulation (decision 14), the checks, the sizing study and the netlist builder are pure TypeScript inside the package, so all of them run in Node tests with no `.wasm`.
   - **FEA is its own package, `packages/fea`** (decision 13), which the domain never imports: the app's FEA worker and the session load it. The domain builds a study's inputs and reads its results as plain data (ADR 0007).
   - **Specification writers** (PDF and CSV of every specification, the KiCad netlist) live in `@manufakture/domain-mech/files`, the `./files` subpath ADR 0013's amendment allows, which may load `packages/io`.
   - **Construction is unchanged.** ADR 0015 decision 8 stands for construction. `packages/calc` is a shared package that any domain may import, but a construction task that wanted to use it for a structural check would need a new ADR first.

2. **Typed `mech` section for the model, `domains.mech` for plain settings.** The line is ADR 0013 decision 3's test, applied field by field: anything that names a document object (part, body, instance, mate, connector, assembly), holds a face reference, may use a variable, or must be reached by core's commands (variable rename and inline, M7's id remap, `diffDocuments`) goes in `mech`. Everything else goes in `domains.mech`.
   - **`mech`** is an optional top-level section, absent when a document has no mechanical content and never empty, like `scripts` and `drawings`, so documents that do not use it cost nothing and keep their bytes. Core validates its shape with zod and its commands reach every expression and reference in it; the domain validates meaning (a load case naming a missing drivetrain, a stage with no ratio).

     ```ts
     interface MechData {
       requirements: Requirement[]; // req#n (decision 10)
       loadCases: LoadCase[]; // lc#n (decision 10)
       drivetrains: Drivetrain[]; // drive#n (decision 9)
       purchased: PurchasedUse[]; // pp#n (decision 7)
       catalog: CatalogEntry[]; // entry#n: the user's own entries (decision 7)
       electrical: Electrical; // decision 11
       schematics: Schematic[]; // sch#n (decision 12)
       symbols: SymbolDef[]; // sym#n: the user's own symbols (decision 12)
       studies: Study[]; // study#n (decision 13)
       checks: CheckOverride[]; // chk#n: per-check factor or input overrides (decision 5)
       specNotes: SpecNote[]; // note#n: what the user adds to a specification (T9.9a to T9.9d)
       hazards: Hazard[]; // hz#n: hazards the user adds to the hazard analysis (T9.9d)
       testBands: TestBand[]; // vt#n: pass bands of the verification test plan (T9.9c)
       nextIds: Record<string, number>; // per counter, only ever increases
     }
     interface CheckOverride {
       id: string; // chk#n
       check: string; // check id, 'bolt.preload'; or a family prefix, 'shaft.'
       subject?: SubjectRef; // absent: every subject of the check
       factor?: StoredExpression; // the user's safety factor for this check
       inputs?: Record<string, StoredExpression | string>; // by input symbol: a preload, a fit class, 'thread-locker'
     }
     interface SpecNote {
       id: string; // note#n
       spec: 'mechanical' | 'electrical' | 'control' | 'hazard' | 'test';
       subject?: SubjectRef; // a part, instance, component, stage; absent: the whole specification
       field: 'condition' | 'process' | 'finish' | 'assembly' | 'fault-response' | 'note';
       text: string;
     }
     interface Hazard {
       id: string; // hz#n
       name: string;
       cause: string;
       mitigation?: string;
       remaining?: string; // what is left for the builder
       records?: string[]; // MechRecord ids the mitigation relies on
     }
     interface TestBand {
       id: string; // vt#n
       test: string; // id of a derived test: 'proof-load@drive#1', 'thermal@lc#2'
       low?: StoredExpression;
       high?: StoredExpression;
     }
     ```

   - **Every later task's stored data has a shape here.** Check inputs that geometry and the catalog do not give (a bolt's preload, a fit class, a thread locker, a key's material) are `CheckOverride.inputs`, keyed by the check's input symbols, so check tasks T9.5b to T9.5h add no shape. The specifications (T9.9a to T9.9d) are derived; what the user writes into them (a part's condition and finish, assembly notes, a fault response) is a `SpecNote`, the hazard rows the user adds are `Hazard`s, and the verification test plan's user-set pass bands are `TestBand`s. The diagram layout is on `mech.electrical` (decision 11) and the schematic is decision 12's. The sizing study (T9.8a) stores nothing: its free variables, ranges and objective live in the app's state and in `size_design`'s arguments, and applying a design is ordinary edits.

   - **`domains.mech`** (`schemaVersion` 1) holds constants only, under ADR 0013's rule that refuses variables: default safety factors per check family (decision 6), the default ambient temperature, the knockdown for printed parts (decision 4), the simulation's step and mode defaults, the FEA mesh target, the automatic simulation budget (decision 16) and report options (sections, title block fields, the display unit system of the reports). A per-check factor that should follow a variable is a `CheckOverride` in `mech.checks`, not a setting.
   - **One format bump, taken by T9.1e** (the next free `FORMAT_VERSION`, 19 if nothing lands before it), with a version-only migration and a fixture of the previous version. It carries every shape in this ADR at once: the `mech` section including the diagram layout of decision 11 (`Component.layout`), the schematic and symbol fields of decision 12, check overrides, spec notes, hazards and test bands, user materials (decision 4) and per-kind display units (decision 3). The `mech.placeholder` extension's params (decision 7) are not in it: extension params are versioned by the domain and migrated in memory (ADR 0013 decision 4), so they need no format bump. Later M9 tasks add behaviour, not shape, so the plan's "one bump" holds even with schematic capture added.
   - **Commands**: one replace-style command per collection, each with its inverse, as the plan lists (`setMechRequirements`, `setMechLoadCase`, `setDrivetrain`, `setElectrical`, `setStudy`), plus `setPurchasedUse`, `setCatalogEntry`, `setSchematic`, `setSymbol`, `setCheckOverride`, `setSpecNote`, `setHazard`, `setTestBand` and the delete and restore pairs. `diffDocuments` reports `mechChanged` per collection and id. The review bundle summarises `mech` through the domain's summariser.
   - **Deltas from T9.1e** (as built at format version 19; `packages/core/README.md` and `schema.ts` are the reference):
     - **Collections are absent when empty.** Every list of `MechData` is optional (absent, never `[]`), and `electrical` is absent with no components, connections or segments. The section appears with its first allocated id and, once it has counters, keeps them even when everything in it is deleted (`{ nextIds }` alone), so an id is never handed out twice. A document that never used the section has no `mech` key.
     - **One counter space.** Every id in the section, nested ones included, comes from `mech.nextIds` and is unique across the section: `req`, `lc`, `drive`, `stage`, `pp`, `entry`, `el`, `conn`, `seg`, `sch`, `sheet`, `us`, `wire`, `label`, `port`, `text`, `sym`, `study`, `chk`, `note`, `hz`, `vt`, and `r` for a study's face references. Placed symbols are `us#n` rather than `u#n` (one-letter counters are reserved for sub-ids such as `e7`), sheet notes `text#n`, and sheets, wires, labels and ports carry the counters of their names. The sync layer lists the `mech` scope while the section is absent, so the first mechanical id is a created id like any other.
     - **Commands.** `setMechRequirements` replaces the whole list (an empty list removes it) with the history-only `restoreMechRequirements`; `setElectrical` likewise with `restoreElectrical`. Every other list has `set...` (create or replace by id), `delete...` and the history-only `restore...`: `setMechLoadCase`, `setDrivetrain`, `setPurchasedUse`, `setCatalogEntry`, `setSchematic`, `setSymbol`, `setStudy`, `setCheckOverride`, `setSpecNote`, `setHazard`, `setTestBand`. Ids a `set` introduces must be fresh; a `restore` takes only allocated ids. No delete is refused: references between mechanical items and to document objects are the domain's `mech-reference` warnings, never core errors. `diffDocuments` reports `mechChanged` as sorted `<collection>/<id>` entries and `materialsChanged` as material ids.
     - **`Electrical.assembly`** names the assembly that `Component.instance` and a segment's `instance` live in, as `Drivetrain.assembly` does for stages.
     - **`SubjectRef`** is a union by `kind`: `part`, `body` (part and body id), `instance` and `mate` (with their assembly), `drivetrain`, `stage` (with its drivetrain), `purchased`, `component`, `connection`, `segment`, `schematic`, `study`, `loadCase` and `requirement`, each with an optional `at`, a free-text sub-location (`seat-A`).
     - **`StaticLoad`** is a union by `kind`, each with a `name`: `cable` (`force`, `angle` from the cable's free direction, optional `azimuth`), `point` (`force`, a non-zero `direction` in the assembly's frame, `at: SubjectRef`) and `acceleration` (`acceleration`, `direction`), the last for a drop or transport as a static equivalent.
     - **`Fixture`**: `{ kind: 'fixed'; faces }` or `{ kind: 'bolted'; faces; stiffness? }`, a bolted hole held fixed, or with `stiffness` as an axial spring. **`Load`**: `force` (`force`, optional `direction`; absent, along each face's normal into the body), `pressure`, `bearing` (`force`, `direction`), `torque` (`torque`, `axis`) and `simulated` (`series`, `statistic` of `peak`, `rms`, `mean` or `final`, `apply` as a `force` or `bearing` load, `direction`). Faces are 1 to 1,000 face references; directions are non-zero vectors in the part's frame.
     - **`SymbolGraphic`**: `line` (2 to 1,000 points), `rect` (`from`, `to`, `fill`), `circle` (`center`, `radius`, `fill`), `arc` (`center`, `radius`, `start` and `end` in degrees, counter-clockwise) and `text` (`at`, `text`, `rotation`). Symbol drawings may use fractions of a grid unit; pins, placements, wires, junctions, labels, ports, no-connects and layout nudges are whole grid units.
     - **Catalog shapes.** `Rated` gains a text arm, `{ text }`, for a rating that is not a number (a chemistry, a bearing type); `ratings` and `dimensions` are records by field name. `PlaceholderShape` is `{ kind: 'cylinder' | 'ring' | 'box'; axis? }`, the solid built from the entry's dimensions. A STEP `blob` is base64 within the `.mfk` import limit, all user entries together at most 64 MiB. A source's `read` is a date (`YYYY-MM-DD`) and its `url` http or https only.
     - **A requirement on a series** takes `statistic` from the simulation's list (`peak`, `rms`, `mean`, `energy`, `final`); only `envelope` takes three values, always with `within`.
     - **Parse modes.** Each mechanical expression site has a kind (`requirementKind` gives a requirement's from its quantity; a tolerance on a temperature is a `temperatureDelta`). A site of a physical kind, or of kind `any` (a check input, a test band, a series requirement, a damper coefficient), is parsed in the physical mode; length, angle and number sites keep the old reading. Core's `expressionReferences`, `expressionMeasures` and `expressionVariableNames` take the mode, with caches keyed on it, and variable rename and inline rewrite each site in its own mode.
     - **User materials** are `materials: MaterialDef[]`, absent when empty, at most 1,000; `Part.material` and a body's `material` take a built-in id or `material#n`. Values are refused when they use a variable or are not of their property's kind (density in mass per volume, conductivity in W/(m·K), specific heat in J/(kg·K), expansion per kelvin, the rest by their `packages/units` kind); a density must be above zero. `documentMaterial(doc, id)` gives a built-in or a user material as a `Material` in SI.
     - **`units.quantities`** is a partial record from physical kind to one of that kind's display units, absent when empty.
     - **Size limits** beyond the ADR's list: 5,000 labels, ports, junctions, no-connects and text notes per sheet each; 1,000 points per wire or symbol line and 1,000 graphics per symbol; 100 static loads per load case and 100 fixtures and 100 loads per study; 200 ratings and 100 dimensions per entry, 32 sources and 32 alternates; 256 terminals per component; 64 inputs per override and 64 fields per placed symbol; grid coordinates within 100,000.
     - **Not in T9.1e:** the `mech.placeholder` extension type, which needs the catalog and its dimensions, lands with T9.2a; its params are versioned by the domain and need no format bump.

3. **Physical quantities in `packages/units`** (T9.1a; README section first, as ADR 0005 requires).
   - **Dimension** gains optional `mass`, `current` and `temperature` exponents, absent meaning 0, as `time` was added. Existing expressions keep their dimensions and evaluate bit-identically (golden logs replay).
   - **New kinds**: `mass`, `force`, `torque`, `speed`, `angularSpeed`, `acceleration`, `power`, `energy`, `voltage`, `current`, `resistance`, `inductance`, `charge`, `temperature`, `temperatureDelta`, `pressure` (stress too), `stiffness`, `rotationalStiffness`, `inertia`, `frequency`, `time`, and the derived kinds the catalogs need: `torqueConstant` (N·m/A), `velocityConstant` (rpm/V), `thermalResistance` (K/W), `heatCapacity` (J/K), `linearDensity` (kg/m). Torque and energy share a dimension; the field's kind decides how it is shown.
   - **Internal values**: the existing kinds keep their internal units (mm, rad, mm/min, rpm). The new kinds evaluate to coherent SI (kg, N, N·m, m/s, W, J, V, A, Ω, H, C, K, Pa), which is what `packages/calc` takes. The domain converts lengths from mm to m at its boundary through `packages/units`, never by hand.
   - **Radians are dimensionless in physical kinds**: where the expected kind is a new kind, the angle exponent is ignored in the comparison (SI's rad = 1), so `22 N*m * 60 rad/s` is a power. The geometric kinds keep checking angle as today.
   - **Syntax**: unit symbols from an explicit list, with no generic SI prefix rule, so `min`, `mm` and `ms` never collide. Mass `kg g lb oz`; force `N kN lbf ozf kgf`; torque `N*m Nm kN*m lbf*ft lbf*in ozf*in`; speed `m/s mm/s km/h ft/s mph`; angular speed `rad/s rpm deg/s`; acceleration `m/s^2 gn` (`g` stays the gram); power `W kW hp`; energy `J kJ Wh kWh`; `V mV kV`, `A mA`, `ohm Ω mohm kohm`, `H mH uH µH`, `C Ah mAh`; temperature `K degC degF °C °F` (a lone `°` stays the degree of angle); pressure `Pa kPa MPa GPa psi ksi bar`; stiffness `N/m N/mm lbf/in`; inertia `kg*m^2 g*cm^2 lb*in^2`; frequency `Hz kHz`; time `s ms min h`. `·` is accepted as `*` between units. Compound units use the existing `*`, `/`, `^` and parentheses.
   - **Temperature is affine.** `25degC` in a `temperature` field is 298.15 K; in a `temperatureDelta` field it is 25 K. An absolute temperature may only stand alone, take a delta added or subtracted, or be subtracted from another absolute temperature (giving a delta); anything else (two absolute temperatures added, a temperature multiplied) is a `dimension` error. Inside a compound unit (`W/(m*degC)`) a temperature unit is a delta.
   - **Bare numbers are an error in a physical-kind field** ("Write 200 lbf or 890 N"), so a stored expression's meaning never depends on a display preference and `StoredExpression` needs no new entry-unit field. `number` fields (ratios, efficiencies, counts, factors) are unchanged.
   - **Display units per kind** are a new optional `units.quantities` record in the document (part of T9.1e's bump). Absent, the system follows the length format: SI for `mm`, `cm` and `m`; US customary (lbf, lbf·ft, psi, mph, °F) for `in`, `ft`, `ft-in` and `in-fraction`. Formatted output parses back to the displayed value (ADR 0005 decision 3).
   - **Takeoff** gains a mass unit for BOM and weight rows.
   - **Deltas from T9.1a** (as built; the `packages/units` README is the reference):
     - A `frequency` field refuses a value that carries an angle (`600 rpm`, an angular speed), which the rad = 1 rule would otherwise read as 62.8 Hz; the user writes `Hz` or divides by `(2*pi)rad`. The other direction follows rad = 1: `10 Hz` in an `angularSpeed` field is 10 rad/s.
     - **A physical parse mode.** The physical-field rules (no bare numbers, compound units after any unit such as `5 m/s` and `2 mm^2`, rates like `50/s`, `rpm` as 2π rad/min) apply where the expected kind is physical or the context says `physical: true`. Elsewhere a compound unit is read only when it starts with a new unit (`22 N*m` anywhere), so `100mm/s` and `2mm^2` keep their old reading in existing documents. `parseExpression`, `findReferences` and `findMeasures` take `{ physical }`, and an AST whose reading depends on the mode records it in a `parsedPhysical` field of its root; evaluating it in the other mode is an error.
     - The kinds include the derived ones the catalogs need: `torqueConstant`, `velocityConstant`, `thermalResistance`, `heatCapacity`, `linearDensity`, and `rotationalStiffness`, 26 in all.
     - Two `degC`/`degF` literals are two absolute temperatures: `80degC - 20degC` is a 60 K difference, and `20degC + 5degC` is a difference too (an error in a temperature field). A literal with an absolute temperature or a kelvin value keeps the reading its use needs.
     - **For T9.1e:** core's `expressionReferences` (`packages/core/src/validate.ts`) calls `findReferences(source)` in the old mode. For a physical field it must pass `{ physical: true }`, with the mode in its cache key, or `5 m/s` reports an unknown variable `s`.

4. **Materials: a property set, user materials in core, printed parts knocked down** (T9.1b).
   - **Built-in materials stay in `packages/core/src/materials.ts`** with permanent ids. The existing nine keep their ids and densities, so no mass result changes. New built-ins: `aluminium-7075`, `steel-1018`, `steel-4140`, `steel-304`, `brass`, `pa12`, `pom`, `pc`, `pa-cf` (carbon-filled nylon). The existing `aluminium-6061` is the T6 temper and gains its properties under the same id.
   - **The property set**, each value a `Property` with its source:

     ```ts
     interface Property {
       value: number; // SI
       source: string; // datasheet, handbook and table
       typical: boolean; // true: a typical published value, not a specification minimum
       note?: string; // condition, temper, direction ("printed, XY, 100 % infill")
     }
     interface MaterialProperties {
       density: number; // kg/m3, as today
       elasticModulus?: Property; // Pa
       poissonRatio?: Property;
       yieldStrength?: Property; // Pa, 0.2 % offset
       ultimateStrength?: Property; // Pa
       enduranceLimit?: Property; // Pa, cycles stated in the note
       fatigue?: { cycles: number; stress: number }[]; // S-N points, Pa, where published
       elongation?: Property; // fraction at break
       thermalConductivity?: Property; // W/(m·K)
       specificHeat?: Property; // J/(kg·K)
       thermalExpansion?: Property; // 1/K
       maxServiceTemperature?: Property; // K
       form: 'wrought' | 'cast' | 'printed' | 'moulded' | 'wood' | 'panel';
     }
     ```

     A check that needs a missing property reports `unknown` naming it (decision 5).

   - **User materials are core data, not mech data**, because `Part.material` and `bodies[].material` are core fields that every domain's mass properties read. They are a new optional top-level `materials` array (part of T9.1e's bump), ids `material#n` from the document's `nextIds.material`, never reused; `Part.material` and `bodies[].material` accept a built-in id or the id of a user material in the same document. Values are typed through `packages/units` and stored as constant `StoredExpression`s with a `source` and `typical` per property; a variable is refused (a material is a library entry, and a design variable belongs in the feature or the check that uses it). Commands `setMaterialDef`, `deleteMaterialDef` (refused while a part or body uses it) and `restoreMaterialDef`.
   - **Deltas from T9.1b, accepted.** As built in [`materials.ts`](../../packages/core/src/materials.ts): the Z strengths are their own fields, `yieldStrengthZ?` and `ultimateStrengthZ?` (Pa, printed only), and the XY values stay in `yieldStrength` and `ultimateStrength` with the direction in the note. `fatigue` is a `FatigueCurve` `{ points: { cycles, stress }[]; source; typical; note? }` rather than a bare array, so the curve is sourced like every other property. User materials (T9.1e) use `MaterialDef`, whose properties are `{ value: StoredExpression; source; typical; note? }`, and `PRINTED_KNOCKDOWN_START` (0.5, sourced) is the starting value for `domains.mech.printedKnockdown`.
   - **Printed parts.** Built-in printed materials state XY and Z (layer) strengths where published. A strength check on a body whose material has `form: 'printed'` uses the Z value when given, else the XY value times the knockdown in `domains.mech.printedKnockdown` (the user's to set; T9.1b documents a starting value with its source). The record shows the knockdown as an input and says that a linear isotropic model does not capture layer adhesion, infill or orientation.

5. **The calc record is `packages/calc`'s `CalcRecord` as built**, with the domain adding where its inputs came from.
   - **The shape** is the one in [`record.ts`](../../packages/calc/src/record.ts): `{ id, title, method, formula, inputs[], result, unit, derived[], limit?, limitKind?, margin?, assumptions[], sources[], status, missing?, note? }`, values in SI, `status` one of `ok`, `warning` and `unknown`.
   - **Deltas against plan decision 4**, all accepted: `derived` holds the intermediate values in order; `limitKind` says which side of the limit the result must be on; `margin` is a fraction of the limit (`(result - limit) / limit` for `at-least`, the reverse for `at-most`), negative when the limit is not met; `missing` names missing inputs and `note` explains any other `unknown` (outside a fit's range, invalid geometry). An `ok` record with no limit means "computed, nothing to compare with".
   - **The domain wraps it** with structured provenance that calc, having no domain vocabulary, cannot carry:

     ```ts
     interface MechRecord extends CalcRecord {
       check: string; // stable check id: 'shaft.fatigue', 'bearing.l10', 'electrical.pack-charge-rate'
       subject: SubjectRef[]; // what it is about: instances, bodies, stages, components, studies
       loadCase?: string; // lc#n that governs
       inputRefs: Record<string, InputRef>; // by input symbol
     }
     type InputRef =
       | { kind: 'requirement'; id: string }
       | { kind: 'catalog'; entry: CatalogRef; field: string; derivation?: string } // decision 8
       | { kind: 'material'; id: string; property: string }
       | {
           kind: 'measured';
           what: 'mass' | 'inertia' | 'area' | 'distance' | 'section';
           subject: SubjectRef;
         }
       | {
           kind: 'simulation';
           loadCase: string;
           series: string;
           statistic: 'peak' | 'rms' | 'mean' | 'energy' | 'final';
         }
       | { kind: 'setting'; key: string } // domains.mech
       | { kind: 'override'; id: string } // mech.checks
       | { kind: 'record'; id: string }
       | { kind: 'given' };
     ```

     Record ids are `<check>@<location>` (`shaft.stress@inst#3/seat-A`), stable across regens while the subject exists. The report (T9.9c) prints records in order and resolves `inputRefs` to readable sources.

   - **Never stored** (ADR 0004 decision 1). Records are recomputed from the document; each check's records are cached in memory keyed by a hash of its gathered inputs and the domain's implementation version.
   - **Requirement results are separate** from check records: `{ requirement, value, target, margin, status: 'meets' | 'misses' | 'unknown', records: string[] }`. "Meets" and "misses" are allowed only here, against the user's own targets (decision 6).

6. **Safety judgement: numbers and margins only** (decided by the maintainer on 2026-10-10).
   - Strength and life results are a value and a factor against a safety factor the **user** chooses: "von Mises 182 MPa, yield 415 MPa, factor 2.28 against your 2.0". Below the user's factor is a `warning`. Performance results against the user's own targets may say "meets" or "misses" ("200 lbf: meets, 14 % torque headroom").
   - Nothing is ever called safe, certified, compliant, passing, failing or OK. The internal status `ok` is never shown as a word; the UI shows the numbers and "above your factor", "below your factor" or "not compared: no factor set". Every record's and every label's wording is tested against those words, as calc's tests already do; the reviewers of every M9 task check it.
   - **No factor ships.** `domains.mech` starts with no safety factors. Starting the mechanical domain asks for a strength factor on yield and a fatigue factor, both optional to fill; a check with no factor reports its value and factor with no comparison. (Question 1 asks whether to suggest starting values instead.)
   - Construction keeps its "not an engineering tool" stance (ADR 0015 decision 8, unchanged).

7. **Purchased parts are versioned catalog data, referred to by id and version** (T9.2a to T9.2e; plan decision 7).
   - **An entry**:

     ```ts
     interface CatalogEntry<F extends Family = Family> {
       id: string; // built-in: 'motor/odrive-d6374-150kv'; user: 'entry#3'
       version: number; // revision of this entry, from 1
       family: F; // motor, controller, cell, pack, bms, bearing, belt, pulley, gear, rope, wire,
       //            connector, fuse, switch, resistor, generic
       fieldsVersion: number; // version of the family's field schema the ratings are written in
       maker: string;
       partNumber: string;
       description: string;
       ratings: Ratings[F]; // typed per family, T9.0c's field lists
       dimensions?: Record<string, Rated>; // mm
       mass?: Rated; // kg
       geometry?: { kind: 'placeholder'; shape: PlaceholderShape } | { kind: 'step'; blob: string };
       sources: { title: string; url?: string; revision?: string; read: string }[];
       verified: boolean; // false until checked against the maker's current datasheet
       derivedFrom?: CatalogRef; // a user entry copied from a built-in one
       notes?: string;
     }
     type Rated =
       { value: number; convention?: string; basis?: string; estimated?: true } | { unknown: true };
     type CatalogRef =
       { source: 'builtin'; id: string; version: number } | { source: 'document'; id: string }; // entry#n in mech.catalog
     ```

   - **Built-in entries** ship in `packages/domain-mech/src/catalog/` as data with `verified: false` unless checked. The app ships representative entries with typical published values, not a vendor database: no scraping, and no claim that a part is current.
   - **References pin a version.** A document refers to a built-in entry by `{ id, version }`. A published entry is never edited in place: a correction is a new version, and the package keeps every version it has ever shipped, as it keeps migrations, so a document's numbers never change under it. The app shows "a newer revision exists" with what changed and offers the update as one undoable command. An entry is never removed; a withdrawn one is marked `deprecated` with a reason. A reference to an entry or version this build does not have (a document from a newer build) fails visibly with a `mech-catalog` warning on every use, and the records that need it are `unknown`, never computed from a guess (ADR 0013 decision 4's stance).
   - **Field schemas migrate in memory.** Each family's rating fields have a `fieldsVersion`; built-in versions and user entries written at an older one are migrated in memory by pure per-family migrations and written back only when the user edits the entry, as ADR 0013 decision 4 does for params.
   - **User entries** live in `mech.catalog` (ids `entry#n`), added field by field from a datasheet or by a CSV import of many (refusing malformed rows with line numbers). Editing a built-in entry copies it into the document with `derivedFrom`.
   - **Use in a design** is a `PurchasedUse`: `{ id: 'pp#n', entry: CatalogRef, part?: string, quantity?: StoredExpression, alternates: CatalogRef[], name?: string }`. `part` names the part that holds its geometry: a STEP import kept as a reference body, as today, or a placeholder made by a `mech.placeholder` extension feature whose params hold the `CatalogRef` (params versioned by the domain, so no format bump) and whose translator builds generic solids (a ring, a cylinder, a box) from the entry's dimensions. Instances of that part in assemblies give the count; `quantity` is for parts not modelled (screws, ferrules).
   - **BOM lines** are `packages/takeoff` rows from a mech producer, with two optional fields added to the row model: `ratings` (`{ name, comparison, value, unit, record? }[]`, the ratings the design relies on: "C at least 5.1 kN") and `alternates`. `manufakture://tables/parts` serves the catalogs over MCP.
   - **Placeholder solids and STEP files from untrusted entries** go through T9.2a's security review.

8. **One internal convention for motor constants, and conversions with their working** (T9.2b; the T9.0b spike's finding and T9.0c's conventions).
   - **Internal**: Kt is newton-metres per ampere of **phase current amplitude** (peak) of sinusoidal three-phase current, motor side, at 25 °C, so torque is `Kt · i_q` in amplitude-invariant dq. R and L are the **equivalent wye phase-to-neutral** values at 25 °C. Copper loss is `1.5 · R · I²` with I the amplitude. This is the spike's model.
   - **Every entry stores the value as entered with its convention**, and one pure function per field normalises it, returning the value and its derivation, which records cite (`Kt 0.0551 N·m/A from Kv 150 rpm/V line-to-line amplitude, 8.27 / Kv`). The catalog editor shows the convention next to each field. The conversions:
     - Kt per ampere RMS: `Kt = Kt_rms / √2`.
     - Kt of a block-commutated motor rated in DC terms (six-step): `Kt = k_dc · π / (2√3) ≈ 0.907 · k_dc` (six-step `k = (3√3/π)·p·λ`, FOC `Kt = 1.5·p·λ`, the spike's model).
     - Kt from Kv when no Kt is given, marked derived: Kv in rpm per volt of line-to-line amplitude gives `Kt = (60 / 2π)(√3 / 2) / Kv ≈ 8.27 / Kv` (ODrive's whole table satisfies it). Other Kv definitions convert to that first: line-to-line RMS `Kv_amp = Kv_rms / √2`; line-to-line peak-to-peak `Kv_amp = 2 · Kv_pp`. T9.2b tests each conversion against a published pair.
     - Resistance or inductance measured line to line (wye or delta): `R = R_ll / 2`. One delta winding's own resistance: `R = R_w / 3`. Phase-neutral: as entered.
     - Output-side constants of geared actuators: `Kt_motor = Kt_out / ratio`; gear efficiency stays its own field (1 when the maker's output constant already includes it, which the entry says).
   - **Other conventions**: pack energy is nominal voltage times rated capacity (the airline basis, so the 100 Wh requirement reads it); currents and powers marked **(basis)** in T9.0c's lists (continuous current, ampacity, connector and resistor ratings) require the basis text, and a check states it; fuse and switch voltage ratings are DC ratings; a cell's charge and discharge limits carry their temperature cutoffs.
   - **Allowance on thermal data**: continuous current derived from datasheet thermal resistances carries a 15 % allowance in the thermal checks, from the spike's 7 to 14 % overestimate against maxon's published values.

9. **The drivetrain model** (T9.3a, T9.3b).

   ```ts
   interface Drivetrain {
     id: string; // drive#n
     name: string;
     assembly?: string; // the assembly its instances live in
     stages: Stage[]; // ordered from the source to the output
     output: Output;
   }
   type Stage =
     | {
         id: string;
         kind: 'motor';
         use: string /* pp#n */;
         instance?: string;
         mate?: string; /* revolute */
       }
     | {
         id: string;
         kind: 'belt';
         ratio: Ratio;
         efficiency: StoredExpression;
         belt?: string;
         pulleys?: string[];
       }
     | {
         id: string;
         kind: 'gear' | 'planetary';
         ratio: Ratio;
         efficiency: StoredExpression;
         uses?: string[];
         instances?: string[];
       }
     | {
         id: string;
         kind: 'shaft';
         instance?: string;
         bearings: { use: string; instance?: string }[];
       }
     | { id: string; kind: 'coupling'; use?: string; instance?: string };
   type Ratio = StoredExpression | { driver: StoredExpression; driven: StoredExpression }; // teeth
   type Output =
     | {
         kind: 'spool';
         instance?: string;
         body?: string;
         cable: string /* pp#n */;
         length: StoredExpression;
         core?: StoredExpression;
         flange?: StoredExpression;
         width?: StoredExpression; // override what geometry gives
         fairlead?: { instance?: string; bendDiameter: StoredExpression };
       }
     | { kind: 'rotary'; instance?: string }
     | { kind: 'linear'; lead: StoredExpression; efficiency: StoredExpression; instance?: string };
   ```

   - **Inertia** comes, in order, from the kernel's mass properties of the named instance's bodies (T9.1c), the catalog's rotor inertia, or a typed override; each record says which. It is reflected through `ratio²`. **Efficiency** is one value per stage, applied by the direction of power flow (divided when driving, multiplied when back-driven), as the spike's model does.
   - **A spool's effective radius** follows the wound layers as cable pays out (T9.3b), so torque per newton changes along the travel, and requirements are checked over the whole payout.
   - **Several drivetrains** may exist; each is its own one-degree-of-freedom chain, and a load case names one. Couplings between them, and coupling mates in assemblies, are out of scope (ADR 0008 decision 6).
   - A stage naming an instance, mate or use that no longer exists gives a `mech-reference` warning on the drivetrain, and the records that need it are `unknown`.

10. **Requirements and load cases** (T9.4a).

    ```ts
    interface Requirement {
      id: string; // req#n
      name: string;
      quantity: RequirementQuantity; // 'maxForce' | 'minForce' | 'forceStep' | 'peakCableSpeed' | 'travel' | 'holdDuration'
      //   | 'sessionsPerCharge' | 'chargeTime' | 'packEnergy' | 'mass' | 'envelope' | 'surfaceTemperature'
      //   | { record: string } | { series: string; statistic: string }
      comparison: '>=' | '<=' | '>' | '<' | 'within';
      value: StoredExpression | [StoredExpression, StoredExpression, StoredExpression]; // envelope: x, y, z
      tolerance?: StoredExpression;
      loadCase?: string; // lc#n
      drivetrain?: string;
    }
    interface LoadCase {
      id: string; // lc#n
      name: string;
      drivetrain?: string;
      dynamic?: {
        mode: ResistanceMode;
        force: StoredExpression;
        motion:
          | {
              kind: 'half-cosine';
              stroke: StoredExpression;
              pullSpeed: StoredExpression;
              returnSpeed: StoredExpression;
              pause: StoredExpression;
            }
          | { kind: 'table'; points: [number, number][] }; // s, m
        reps: StoredExpression;
        sets?: StoredExpression;
        rest?: StoredExpression;
        startCharge?: StoredExpression;
        ambient?: StoredExpression;
      };
      static?: StaticLoad[]; // side pull at an angle, drop as a static equivalent, transport, handle loads
    }
    type ResistanceMode =
      | { kind: 'constant' }
      | { kind: 'eccentric'; factor: StoredExpression }
      | { kind: 'band'; rate: StoredExpression }
      | { kind: 'chains'; rate: StoredExpression; from: StoredExpression }
      | { kind: 'isokinetic'; speed: StoredExpression }
      | { kind: 'damper'; coefficient: StoredExpression }
      | { kind: 'rowing'; coefficient: StoredExpression }
      | { kind: 'isometric'; duration: StoredExpression }
      | { kind: 'table'; by: 'position' | 'speed'; points: [number, number][] }; // SI pairs
    ```

    Values are `StoredExpression`s and may use variables, so "the spool radius that meets the force target" can be a variable the user tunes. Table points are plain SI numbers (they are data series, not typed fields), bounded in count (decision 16).

11. **The electrical system model** (T9.7a to T9.7c).

    ```ts
    interface Electrical {
      components: Component[];
      connections: Connection[];
      harness: Segment[];
    }
    interface Component {
      id: string; // el#n
      name: string;
      role:
        | 'pack'
        | 'bms'
        | 'fuse'
        | 'switch'
        | 'precharge'
        | 'controller'
        | 'brake-resistor'
        | 'chopper'
        | 'motor'
        | 'charger-input'
        | 'dcdc'
        | 'board'
        | 'encoder'
        | 'load-cell'
        | 'display'
        | 'connector'
        | 'other';
      use?: string; // pp#n; absent for a generic component
      instance?: string; // where it sits in the assembly, for harness lengths
      terminals?: { id: string; name: string; kind: 'power' | 'ground' | 'phase' | 'signal' }[]; // overrides the family's defaults
      load?: { current: StoredExpression; voltage?: StoredExpression }; // always-on loads the simulation does not model
      layout?: { block?: [number, number]; wiring?: [number, number] }; // manual nudges per diagram, grid units,
      //                                                                   offsets from the automatic placement
    }
    interface Connection {
      id: string; // conn#n
      from: { component: string; terminal: string };
      to: { component: string; terminal: string };
      wire?: string; // pp#n of a wire entry
      colour?: string;
      number?: string; // wire number on the wiring diagram
    }
    interface Segment {
      id: string; // seg#n
      from: { component: string } | { instance: string };
      to: { component: string } | { instance: string };
      length: StoredExpression | { measured: true; slack: StoredExpression };
      connections: string[];
    }
    ```

    - Each family defines default terminals (a pack `+` and `-`; a controller `bus+`, `bus-`, `a`, `b`, `c`, `brake+`, `brake-`, `signal`). A connection's current and voltage come from the simulation by the roles at its ends (pack to controller carries bus current; controller to motor carries phase current; chopper to resistor carries resistor current), or from the components' typed `load`. A measured segment's length is the distance between instance origins in the assembly at its stored pose plus slack.
    - The block diagram, wiring diagram and harness table (T9.7b) are derived, never stored, except manual layout nudges, which are `Component.layout`: one offset per component per diagram, on the same 1.27 mm grid as schematics (decision 12), reached by `setElectrical` and dropped with the component. Nothing about the diagrams goes in `drawings`.

12. **Schematic capture is in M9** (decided by the maintainer on 2026-10-10; this amends plan decision 8). It sits on top of the system-level design of decision 11: a schematic details one `board` (or any) component of `mech.electrical`, and its hierarchical ports are that component's terminals, so the system level and the schematic describe one machine. PCB layout and circuit simulation stay out of scope.

    ```ts
    interface Schematic {
      id: string; // sch#n
      name: string;
      details?: string; // el#n: the system-level component this schematic is the inside of
      sheets: Sheet[];
    }
    interface Sheet {
      id: string; // sheet#n, within the schematic
      name: string;
      size: 'A4' | 'A3' | 'letter' | 'tabloid';
      symbols: PlacedSymbol[];
      wires: { id: string; points: [number, number][] }[]; // grid units
      junctions: [number, number][];
      labels: { id: string; name: string; at: [number, number]; scope: 'local' | 'global' }[];
      ports: { id: string; at: [number, number]; terminal: string }[]; // a terminal of `details`
      noConnects: [number, number][];
      notes: { id: string; at: [number, number]; text: string }[];
    }
    interface PlacedSymbol {
      id: string; // u#n, within the schematic
      designator: string; // 'R3', 'U1': user-visible, unique per schematic (checked by the ERC)
      symbol: SymbolRef; // { source: 'builtin'; id; version } | { source: 'document'; id: 'sym#n' }
      at: [number, number];
      rotation: 0 | 90 | 180 | 270;
      mirror: boolean;
      value?: string; // '10k', 'STM32G431'
      use?: string; // pp#n, when the part is in the BOM
      footprint?: string; // free text for the netlist, such as 'Resistor_SMD:R_0603_1608Metric'; not validated
      fields?: Record<string, string>;
    }
    interface SymbolDef {
      id: string; // sym#n, or a built-in id with a version
      name: string;
      body: SymbolGraphic[]; // lines, rectangles, circles, arcs, text, in grid units
      pins: {
        number: string;
        name: string;
        at: [number, number];
        orientation: 'left' | 'right' | 'up' | 'down';
        length: number;
        type: PinType;
      }[];
      power?: { net: string }; // a power symbol (GND, VBUS, +3V3): names a global net
    }
    type PinType =
      | 'input'
      | 'output'
      | 'bidirectional'
      | 'tristate'
      | 'passive'
      | 'power-in'
      | 'power-out'
      | 'open-collector'
      | 'open-emitter'
      | 'no-connect'
      | 'unspecified';
    ```

    - **Coordinates** are integers on a 1.27 mm (50 mil) grid, the grid KiCad's libraries use, so wires connect by coincident endpoints, exactly, with no tolerance.
    - **Nets are derived**, never stored: connectivity from wires, junctions and pin ends; names from labels (local per sheet, global across the schematic's sheets), power symbols and ports. Hierarchy is one level: sheets of a schematic share global labels, and the schematic links up to the system level through ports. Nested sheet symbols are not in M9.
    - **A small built-in symbol library**, drawn for this project (no symbols copied from KiCad's or anyone's library): resistor, capacitor (plain and polarised), inductor, diode, Zener, TVS, LED, NPN and PNP transistors, N and P MOSFETs, fuse, switch, push button, relay coil and contact, crystal, three-pin regulator, op-amp, thermistor, load cell bridge, motor, battery and cell, test point, generated 1xN and 2xN connectors (N up to 40), a generic box IC, power symbols (GND, a named rail), the power flag and the no-connect marker. Symbols are versioned data like catalog entries (decision 7). User symbols live in `mech.symbols`, made in a small editor or as a generic box from a pin table.
    - **Electrical rules check (ERC)**: a pin-type conflict matrix with KiCad's meaning (two outputs on a net, an output against power-out, unconnected input), unconnected pins not marked no-connect, a power-in net with no power-out or power flag, nets with one pin, labels used once, duplicate designators, ports whose terminal is not on the detailed component, and a port's net class (power, ground, signal) disagreeing with the system-level terminal's kind. Findings are `erc` warnings through regen and `get_errors` (decision 15); none is a statement that a circuit works.
    - **Output**: schematic sheets drawn through `packages/drawing` as PDF and SVG sheets with a title block, like T9.7b's diagrams; a **KiCad netlist** in the s-expression format KiCad 7 and 8 read (`(export (version "E") ...)`: components with designator, value, footprint and fields; nets with their nodes, pins and pin types), checked against a fixture written by KiCad; and a per-board BOM CSV. Every string from the document is escaped for the s-expression format (untrusted text into a file another program parses: security review).
    - **Proportion.** The plan estimated that schematic capture adds about a quarter to the milestone. It is four tasks (Implementation consequences), with the shapes above (symbol placements, wires, junctions, labels, ports, no-connects, notes and user symbols) landing in T9.1e's bump.

13. **FEA on the client: gmsh built here, our own TET10 solver** (T9.6a to T9.6c; the T9.0a spike's recommendation).
    - **Browser only, no server fallback** (decided by the maintainer on 2026-10-10). M7's "the server never computes geometry" stands: the sync server never meshes or solves. If the browser proves slow on real machines, M9 ships a smaller model limit and says so in the docs; "we can make it faster later". The agent's session (ADR 0016), a Node process on the user's own machine that already runs the kernel, counts as a client and may run a study (question 2).
    - **Mesher: gmsh, built in this repository** from `@loumalouomega/gmsh-wasm`'s build scripts with `ENABLE_BLOSSOM=OFF` and the contribs FEA does not use switched off, emitted as its own `.wasm` and loaded lazily on the first analysis (7.8 MB with Brotli as prebuilt; less without the unneeded contribs). It imports the kernel's STEP with its own OCCT, keeps curved faces exact, and maps face references to gmsh surface tags by the kernel's face order, with a test on a multi-body document that fails loudly if the counts differ. HXT is the default 3D algorithm. fTetWild is not shipped in M9.
    - **Solver: `packages/fea`, our own TypeScript**, taking over the spike's `tet10.ts`, `solver.ts`, `amg.ts` and `order.ts`: isotropic linear elastic TET10, AMG-preconditioned conjugate gradients to a relative residual of 1e-8, nodal von Mises, principal stresses and displacements, in a worker of its own (an out-of-memory crash takes only the analysis), with progress per phase and cancellation between phases and iterations. The spike's three benchmarks are its tests, within 5 %.
    - **Limits**: a hard cap of **500k DOF** (refused before solving with a typed error), a default mesh aimed at **150k to 200k DOF**, and a warning above 200k that the run may take tens of seconds and gigabytes. These apply to the study's own mesh, which is the finer of the two densities a study runs (see Records); the check mesh is coarser, so the cap bounds both. Before meshing, the DOF are estimated from the volume and element size, and a mesh that would exceed the cap is refused without being built. One study runs at a time per tab and per session.
    - **Studies** (`mech.studies`): `{ id: 'study#n', name, part, bodies: string[], fixtures: Fixture[], loads: Load[], mesh: { size?: StoredExpression; refine: FaceReference[] }, loadCase?: string }`. Fixtures are fixed faces or bolted holes (fixed or as springs); loads are force, pressure, bearing load and torque on faces, or values taken from a load case's simulation peaks (cable tension at the fairlead, a bearing's reaction). Several bodies are bonded at shared faces. Face references follow ADR 0004's outcomes.
    - **Results are derived and never stored.** They are cached in memory keyed by the bodies' cache keys, materials, loads and mesh settings; after an edit, the study's records are `unknown` ("not run since the last change") until it runs again. A study never runs on open, on regen or on sync: only on a person's action or an agent's `run_study` call.
    - **Records** report the peak von Mises stress with its location and margin against yield or the endurance limit at the user's factor, and the same peak excluding one element layer next to fixtures and point-like loads; when the two differ by more than 20 %, the record warns of a stress singularity. Every study runs at two densities: its own mesh, whose results the records report, and a check mesh at 1.4 times its element size (about a third of the DOF); a change in peak stress above 10 % between them is a `warning` on the record. The assumptions (isotropic, linear, elastic, bonded, small deflection; printed and wood bodies approximated) are in every record.
    - **Licence consequences for ADR 0006**, done by T9.6a before anything ships: an amendment admitting the gmsh `.wasm` as a third separately loaded, replaceable module, GPL-2.0-or-later for gmsh with OCCT (LGPL-2.1 with the Open CASCADE exception) and the LGPL contribs inside it (each confirmed from its licence file at build time); `tools/licenses/policy.ts` extended to allow those components inside that module only; the notices carrying gmsh's licence, its CREDITS.txt and every enabled contrib's licence text; and a build check that fails if the gmsh configuration string or the binary names Blossom. CalculiX and the prebuilt npm `.wasm` are not shipped.

14. **The simulation model** (T9.4b; the T9.0b spike, plan decision 6).
    - **One degree of freedom per drivetrain**: the user is a prescribed motion (cable position and speed against time) with a target force from the resistance mode; the controller is ideal force control that feeds forward inertia and loss torques unless the current or voltage limit intervenes. The force felt comes from the shaft's torque balance, with efficiencies applied by power-flow direction.
    - **Components**: a surface-magnet PMSM in amplitude-invariant dq (`Ld = Lq`, `i_d = 0`) from the internal constants of decision 8, with copper loss `1.5·R(T)·|i|²`, Coulomb and viscous friction and hysteresis plus eddy iron loss; a controller with a current limit, a voltage vector clamped to `m·Vbus/√3` (m 0.95 by default), and fixed, conduction and switching losses; a pack with a piecewise-linear open-circuit voltage against charge, internal resistance (cells plus interconnect), a charge acceptance limit tapering near full and a load cutoff; an ideal chopper sending what the pack does not accept to the braking resistor, flagging any step where the surplus exceeds `V²/R`; and first-order thermal nodes: winding and housing for the motor (two nodes), plus the cells, the controller and the resistor. Copper +0.393 %/K and magnet Kt -0.12 %/K are defaults an entry may override.
    - **Field weakening is not modelled**: when the voltage limit is reached the model clamps and marks the interval, and a record says so.
    - **Integrator**: the theta method at θ = 0.5 (implicit midpoint), with every ledger power evaluated at the midpoint. **Sessions and envelopes** use quasi-static currents at a 1 ms step. **Transients** (force steps, reversals, the voltage limit, for the control specification) use the full current-loop model at 50 µs, on request only.
    - **Ledgers**: the energy and thermal ledgers close below 10⁻⁶ relative in every test (the spike reached 10⁻⁸), a cheap guard against a forgotten loss term. Their entries become records.
    - **Outputs**: time series (decimated for display) and envelopes per component (peak, RMS, mean, energy, time above a limit), consumed by checks and requirements through `InputRef`s of kind `simulation`. Deterministic for given inputs in one engine; Node and the browser may differ in the last bits through JavaScript `Math`, which ADR 0016 decision 4's tolerance absorbs.
    - **Fitting**: T9.4b fits the two published Voltra points (about 6 sessions at 100 lb, 14 at 60 lb) once a session definition is stated, as a validation target, not as built-in data.

15. **Checks report through regen and `get_errors`** (T9.5a).
    - **A mech stage after regen.** The domain's registration gains an optional evaluation hook (an extension of ADR 0013 decision 5, which gave the two-step form to translators only), called by regen after the parts and assemblies have regenerated, in the same containment as translators (a throw becomes an error on the `mech` section, never a failed regen). It uses ADR 0013 decision 5's two-step form: the domain first returns the measurements it needs (mass properties and inertia of instances, section dimensions, face areas, distances between instances), regen answers them with kernel ops, and the domain then runs the simulation (cached, within the automatic budget of decision 16) and every check, returning records, requirement results and warnings.
    - **Fast checks run on every regen**; the simulation runs when its inputs changed; FEA never runs in regen (decision 13).
    - **Warnings**, added to the `RegenWarning` union (an addition, so older consumers still compile):

      ```ts
      | { code: 'mech-check'; message: string; check: string; recordId: string; status: 'warning' | 'unknown' }
      | { code: 'mech-requirement'; message: string; requirementId: string; status: 'misses' | 'unknown' }
      | { code: 'mech-reference'; message: string; objectId: string; target: string } // a missing instance, mate, use
      | { code: 'mech-catalog'; message: string; entry: CatalogRef; reason: 'unknown-entry' | 'newer-version' | 'deprecated' }
      | { code: 'mech-budget'; message: string; what: 'simulation' | 'sizing' | 'fea'; objectId: string }
      | { code: 'erc'; message: string; schematicId: string; sheetId: string; rule: string; at: [number, number][] }
      ```

      One code per kind of finding, with the check id as a field, rather than one code per check: the check list grows with every task, and the union stays readable. Messages state the numbers ("Shaft at bearing A: factor 1.7 against your 2.0").

    - **`get_errors`**: `ErrorLine.where` gains `'mech'` (add-only), with `id` the record, requirement or object id and `code` the warning's code; a new optional `check` field carries the check id. Warnings and `unknown`s are severity `warning`; invalid `mech` data is `error`.
    - **The checks panel** lists records with their working; a record's `unknown` names its missing inputs.

16. **Compute budgets in shared documents and over MCP** (security review in T9.12a). A shared document or an agent can ask for work; nothing a document holds may make a client compute without bound.
    - **Size limits on the section**, checked by core: at most 500 requirements, 200 load cases, 32 drivetrains of 64 stages, 2,000 purchased uses, 2,000 user catalog entries, 2,000 components, 10,000 connections, 2,000 segments, 100 schematics of 50 sheets, 2,000 symbols and 5,000 wires per sheet, 1,000 user symbols of 1,000 pins, 200 studies, 2,000 check overrides, 2,000 spec notes of 10,000 characters, 500 hazards, 500 test bands, and 10,000 points per table. STEP blobs follow the `.mfk` limits.
    - **Simulation**: at most 10⁷ steps per run (2.8 h of simulated time at 1 ms; the 466 s session is 466k steps) and 10⁶ in full mode. Automatic runs after a regen stop at 2 s of wall time per document by default (`domains.mech`); load cases beyond it show `unknown` with a `mech-budget` warning and a Run action. In the app it runs in a worker; in a session, in the worker thread of ADR 0016 decision 3.
    - **FEA**: decision 13's caps; never automatic.
    - **Sizing study** (T9.8a): never automatic; at most 10,000 candidate evaluations and 120 s by default in the app (the user may raise them to 100,000 and 10 minutes), and 10,000 and 60 s per `size_design` call over MCP; cancellable; the result says how much of the space was searched.
    - **Over MCP** every heavy tool (`simulate`, `run_study`, `size_design`, `get_specification`) has its own cap and returns `budget-exceeded` as data (ADR 0016 decision 6), on top of the session's limits. Tool results carry the disclaimer in a JSON field (decision 17), never in tool descriptions composed from document text.

17. **The disclaimer** (drafted by the agent as the maintainer decided on 2026-10-10; he may reword it at M9 acceptance, T9.12b).
    - **What it covers**: that manufakture calculates by the methods and inputs each record shows; that it never certifies a design as safe or compliant with any standard; that catalog data is typical and unverified unless marked; that a machine which carries load or stores energy needs review by a qualified engineer before it is built or used; and that the software comes without warranty under GPL-3.0-or-later. The long form adds the models' limits and the user's responsibility for safety factors and targets.
    - **Short form**, one constant `DISCLAIMER_SHORT` exported from `packages/domain-mech/src/disclaimer.ts`:

      > manufakture calculates by the methods and inputs shown in each record; it does not certify a design as safe or compliant with any standard. Catalog data is typical and unverified unless marked. Have a qualified engineer review any machine that carries load or stores energy before building or using it. Provided without warranty under GPL-3.0-or-later.

    - **Where the short form appears**: the mech panels (once per document, and always in their help); every specification (mechanical, electrical, calculation report, verification test plan, control specification, hazard analysis) on its first page and in its footer; the title block of every block diagram, wiring diagram and schematic sheet; every BOM and harness CSV with mech lines; the KiCad netlist's title block comment; the review bundle's mech summary; and a `disclaimer` field in the results of `get_requirements_status`, `simulate`, `get_checks`, `run_study`, `size_design` and `get_specification`. Construction's disclaimer is separate and unchanged; a document using both domains shows each where its own domain's output appears.
    - **The long form** opens `docs/user/mechanical.md` (T9.1e), drafted here in construction's style:

      > ## Calculates, never certifies
      >
      > manufakture calculates how a machine you design behaves: forces, torques, speeds, currents, temperatures, stresses, deflections, bearing life and battery energy. It shows how it got every number. It does not decide whether your machine is safe.
      >
      > - **Every number shows its working.** Each result is a calculation record that names its method, its formula, every input and where that input came from, its assumptions and its published source. A result is only as good as its inputs and its method's assumptions.
      > - **Margins against your factors, not verdicts.** Strength and life are reported as a value and a factor against a safety factor you chose ("von Mises 182 MPa, yield 415 MPa, factor 2.28 against your 2.0"). Below your factor is a warning. Choosing the factors is your engineering judgement; manufakture ships none.
      > - **Targets are yours.** Against requirements you set, results say "meets" or "misses" and by how much. A design that meets every requirement is not thereby safe.
      > - **No certification and no compliance check.** Nothing manufakture shows or exports means that a design is safe, certified, or compliant with a standard or a regulation. Where it names a standard (such as ISO 20957, IEC 60335, IEC 62133 or UN 38.3), it is a place for you to look; no text of any standard is shipped or used.
      > - **Catalog data is typical and unverified unless marked.** Part ratings come from published datasheets and are marked unverified until someone checks them against the maker's current document. Datasheets differ in their conventions and change between editions; check the parts you buy.
      > - **The models have limits.** The hand calculations are textbook methods, exact only for their stated assumptions. The simulation is a lumped model with one degree of freedom. Stress analysis is linear, elastic and isotropic: it does not model the layers of a printed part, the grain of wood, contact, large deflections or cracks, and stresses at sharp corners and point supports grow without limit as the mesh is refined. The absence of a warning says nothing about a design.
      > - **Load and stored energy can hurt people.** A machine that carries load or stores energy (a cable under tension, a raised mass, a spinning rotor, a spring, a battery) can injure when it fails. Have a qualified engineer review it before you build or use it, and test the built machine as its verification test plan describes, with guards in place.
      >
      > manufakture is free software under the GNU General Public License, version 3 or later (see [LICENSE](../../LICENSE)), and comes with no warranty, to the extent permitted by applicable law; sections 15 and 16 of the license say so in full. This page describes what the software does; it is not legal advice.
      >
      > A short form of this notice appears in the mechanical panels, on every specification, on every diagram and schematic sheet, in every BOM, harness and netlist export, and in the results of the mechanical MCP tools.

18. **Standards are named, never copied.** Specifications name the standards of T9.0c (ISO 20957, IEC 60335 and UL 1647, IEC 62133-2, UN 38.3, the IATA lithium battery rules, CISPR 14 and IEC 61000) by number and scope as places for the builder to look. No standard's text, table or limit value is shipped or used as data; a touch-temperature or accuracy limit is a requirement the user types.

19. **Firmware is specified, not written** (plan decision 9). The control specification states laws, limits, loop rates, sensor resolutions and fault responses; manufakture generates no microcontroller code.

20. **What M9 does not do.** Certify, approve or check compliance of anything; ship safety factors, standard values or vendor data beyond representative entries; scrape vendor sites; PCB layout, footprint libraries, circuit simulation, import of KiCad symbol libraries, nested schematic sheets; coupling mates and kinematic drivers in assemblies; dynamics beyond one degree of freedom, modal and vibration analysis, fatigue FEA, contact, nonlinear and orthotropic materials, thermal FEA; field weakening in the simulation; FEA or simulation on the sync server; firmware code; costs with supplier prices; pneumatics and hydraulics.

## Alternatives considered

- **`domains.mech` for everything.** No format bump and no core vocabulary. But requirements, load cases, drivetrains and studies name instances, mates and faces and take variables, which ADR 0013 decision 3 keeps out of domain data, and M7's id remap and variable rename could not reach them. Rejected for the typed section (decision 2), as `print` and `cam` were.
- **A required `mech` section, like `print` and `cam`.** Every document would carry an empty section and change bytes on migration. Rejected for an optional one, like `scripts` and `drawings`.
- **User materials in `mech`.** Mass properties and `Part.material` are core's, and a woodworking document should be able to use a custom species without the mechanical domain. Rejected for core's `materials` (decision 4).
- **Physical kinds with a display-unit default for bare numbers**, as lengths have. A bare `200` would mean lbf in one document and N in another, which would need a new entry-unit field per kind in every `StoredExpression`. Rejected: bare numbers are an error in physical fields (decision 3).
- **Torque as N·m/rad**, keeping angle a strict dimension everywhere. Correct in principle, but `22 N*m` would not be a torque and every catalog field would need `/rad`. Rejected for SI's rad = 1 in physical kinds.
- **Pass and fail against default factors the app picks.** Friendlier, and it claims more than the app knows. Rejected by the maintainer (decision 6).
- **Snapshotting catalog entries into the document on use.** Documents would be self-contained, but every use would copy the whole entry, two uses of one part could drift apart, and corrections would never reach anyone. Rejected for pinned `{ id, version }` references with every version kept (decision 7); editing an entry copies it into the document, which covers self-contained use when wanted.
- **Storing motor constants only in the internal convention.** Simpler, but the user types what the datasheet says, and a wrong guess at the convention is a silent factor of two in copper loss. Rejected: entered value and convention are stored, and the normalisation is shown (decision 8).
- **One `RegenWarning` code per check.** Discoverable in the type, but the union would grow with every check task and each new code is a change for every consumer. Rejected for `mech-check` with a check id (decision 15).
- **FEA on the sync server, or a server fallback.** Contradicts M7's "the server never computes geometry", and the spike shows the browser is fast enough. Rejected by the maintainer (decision 13).
- **The prebuilt gmsh npm package.** Ships Blossom, whose permission is limited to use within gmsh and is not GPL-compatible. Rejected for a build in this repository without it.
- **CalculiX built to WebAssembly.** Fortran with SPOOLES and ARPACK, far more work than the spike's whole solver, which already met every target. Rejected.
- **fTetWild as the mesher.** 5 to 20 times slower and only approximates the boundary. Kept as a later fallback for broken imported geometry, not shipped in M9.
- **Electrical system design without schematics** (the plan's decision 8). Decided against by the maintainer: schematic capture is in M9 (decision 12).
- **Importing KiCad's symbol libraries.** Large and familiar, but under CC-BY-SA 4.0 with an exception, which would need its own licence review and attribution in every exported sheet. Rejected for a small library drawn here; KiCad receives our netlist instead.
- **A separate electrical domain.** The simulation needs the motor, controller and pack together, and domains may not import each other. Rejected (decision 1).

## Consequences

- **The plan changes**: decision 8 is amended (schematic capture in M9, decision 12); its three open questions are answered (judgement: numbers and margins only, decision 6; electrical depth: schematics in, decision 12; FEA: browser only, decision 13); decision 4's record is `packages/calc`'s as built (decision 5); T9.12b starts from the drafted disclaimer instead of a blank page.
- **One format bump in T9.1e** carries `mech` (with diagram layout, schematics, symbols, check overrides, spec notes, hazards and test bands), core `materials` and `units.quantities`. The `mech.placeholder` params are versioned by the domain and need no bump. T9.1a and T9.1b land code and data that the bump then exposes; T9.1b's schema for user materials is T9.1e's.
- **`packages/units`** gains three dimension exponents, 26 kinds, an explicit unit list, affine temperature and the bare-number rule, README first; golden logs must replay unchanged. The bare-number rule goes beyond ADR 0005 decision 5 (bare numbers mean the display unit): it holds for physical kinds only, and the README states the exception. **`packages/takeoff`** gains a mass unit and optional `ratings` and `alternates` on rows. **`packages/regen`** gains the mech evaluation hook and six warning codes; **`packages/session`** gains `where: 'mech'` and an optional `check` on `ErrorLine`. All additive.
- **ADR 0006** gains the gmsh amendment in T9.6a before any FEA ships. No other new runtime dependency is planned for M9; the simulation, the checks, the netlist writer and the solver are our own code.
- **ADR 0013** is extended, not changed: the evaluation hook extends decision 5's two-step form from translators to a post-regen stage, in the same registry and containment, and `./files` covers the writers. **ADR 0015** is unchanged; its decision 8 still governs construction. **ADR 0016**'s limits apply to sessions, with decision 16's caps on top; new tools follow its add-only rule and golden.
- **Wording is a review item for every M9 task**: no "safe", "certified", "compliant", "pass", "fail" or "OK" in any mech record, label, export or tool result; "meets" and "misses" only for requirement results.
- **Documents may hold work they cannot run.** A study or a long load case in a shared document never runs until someone asks, and an unknown catalog entry is a visible warning, never a guessed number.

## Implementation consequences

Changes to planned tasks:

- **T9.1a**: decision 3 (kinds, syntax, rad = 1 in physical kinds, affine temperature, bare-number error); the per-kind display units schema is T9.1e's.
- **T9.1b**: decision 4; the `materials` schema lands in T9.1e's bump.
- **T9.1e**: the whole `mech` section of decision 2 including `Component.layout`, `schematics`, `symbols`, `checks`, `specNotes`, `hazards` and `testBands`, core `materials`, `units.quantities`, the `mech.placeholder` extension type (its params versioned by the domain, outside the bump), the size limits of decision 16, and `docs/user/mechanical.md` opening with the long form of decision 17.
- **T9.2a**: decision 7 (entries, `CatalogRef`, versions, migrations, BOM rows); **T9.2b**: decision 8's conventions and conversion tests.
- **T9.5a**: decision 15 (evaluation hook, warnings, `ErrorLine`).
- **T9.6a**: decision 13, including the gmsh build without Blossom and the ADR 0006 amendment.
- **T9.9b** depends also on T9.7f and T9.7g (the electrical specification includes the schematics and the netlist). **T9.10a** depends also on T9.7g and adds `get_schematic` and a `kicad-netlist` export kind. **T9.11a** draws one board's schematic (the controller interface board) and exports its netlist. **T9.12a** depends also on T9.7e (it reviews the pin-table CSV import) and T9.7g (it reviews the netlist and board BOM export). **T9.13** depends on the new tasks.

New tasks for schematic capture:

| Task  | Wave | Title                                                | Scope                                                                                                                                                                                                                                                                                       | Depends on   | Security review |
| ----- | ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- |
| T9.7d | 7    | Schematic model, connectivity and the symbol library | The built-in symbols of decision 12 as versioned data; derived nets from wires, junctions, labels, power symbols and ports; port links to `mech.electrical` terminals; designators; commands' domain validation; tests on hand-drawn fixtures. Shapes come from T9.1e's bump                | T9.1e, T9.7a |                 |
| T9.7e | 8    | Schematic editor                                     | A schematic workspace: sheets, place and rotate symbols, draw wires on the grid, junctions, labels, power symbols, ports, no-connects, notes, designator annotation, undo; user symbols as a generic box from a pin table (typed or pasted CSV) and a small symbol editor; Playwright tests | T9.7d        | yes (CSV)       |
| T9.7f | 8    | Electrical rules check                               | The ERC of decision 12 (pin-type matrix, unconnected pins, undriven power nets, single-pin nets, lone labels, duplicate designators, port and net-class consistency with the system level), reported as `erc` warnings through regen, `get_errors` and the editor                           | T9.7d, T9.5a |                 |
| T9.7g | 8    | Schematic sheets, KiCad netlist and board BOM        | Sheets through `packages/drawing` as PDF and SVG with title block and disclaimer; the KiCad netlist (`version "E"`) checked against a KiCad-written fixture, with every document string escaped; a per-board BOM CSV; Node entry points in `domain-mech/files` for MCP `export`             | T9.7d, T9.7b | yes (export)    |

## Questions for the maintainer

1. **Starting safety factors.** As decided here, a new design starts with no safety factors: you are asked for them, and a check without one shows its factor with nothing to compare it to. The alternative is to prefill suggestions (for example 2 on yield and 1.5 on fatigue) that you confirm or change, which is quicker but puts the app's numbers in front of yours. Assumed: blank.
2. **FEA from an agent.** "Browser only" is read as "on your own machine, never on the sync server", so an agent's local session (which already runs the geometry kernel) may run a stress study when asked. The alternative is to keep FEA to the browser tab only, so an agent can set studies up but a person must run them. Assumed: the local session may run them.
