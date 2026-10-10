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
construction domains. The evaluation hook (checks, the simulation; T9.5a) and the
`mech.placeholder` extension type (T9.2a) join it later.

## Review

`mechDataSummariser` describes a change of `domains.mech` (a start lists both factors, set or not)
and `mechSectionSummariser` a change of the `mech` section, by collection and id, ending with the
notice. `@manufakture/review` calls both for the bundle's `mech` entry.

## The notice

`DISCLAIMER_SHORT` (`src/disclaimer.ts`) is a **placeholder** the agent drafted
(`DISCLAIMER_IS_PLACEHOLDER`); the maintainer may reword it at M9 acceptance (T9.12b, task #1269).
Keep it and the long form in `docs/user/mechanical.md` saying the same thing.

## Dependencies

`@manufakture/core` and `@manufakture/units` at run time; `@manufakture/regen` for types only. ADR
0017 decision 1 also allows `@manufakture/calc` (formulas) and `@manufakture/takeoff` (BOM lines),
which join with the tasks that use them.
