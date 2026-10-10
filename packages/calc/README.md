# @manufakture/calc

The engineering formula library behind the mechanical checks (M9 plan, task T9.1d, decisions 1, 2
and 4). Pure functions over SI numbers that return **calc records**: one result with its method,
formula, inputs, assumptions and published sources. It has no domain vocabulary (no motors, spools
or cable trainers), so any domain package may use it.

Plain TypeScript under GPL-3.0-or-later, with no dependencies.

## What it does not do

It calculates and shows its working; it never certifies. A strength or life result is stated as a
factor against a factor **you** chose ("von Mises 182 MPa, yield 415 MPa, factor 2.28 against your
2.0"), and falling short of it is a `warning`. No record calls a design safe, passing, failing,
certified or compliant with a standard; the test suite checks every record's wording for those
words. The formulas are textbook hand calculations, exact only for their stated assumptions, and
the people who build the thing remain responsible for checking it.

## The record

```ts
interface CalcRecord {
  id: string; // e.g. 'shaft.fatigue-goodman'; callers may override it per location
  title: string;
  method: string; // how it was computed, in words
  formula: string;
  inputs: CalcInput[]; // { name, symbol, value (SI or null), unit, source }
  result: number | null; // SI; null when an input is missing or out of range
  unit: string;
  derived: CalcValue[]; // intermediate values: { name, symbol, value, unit }
  limit?: number; // your limit, when you gave one
  limitKind?: 'at-least' | 'at-most';
  margin?: number; // room against the limit as a fraction of it; negative means not met
  assumptions: string[];
  sources: CalcSource[]; // { title, locator }: book and equation or table
  status: 'ok' | 'warning' | 'unknown';
  missing?: string[]; // the inputs that were missing, when 'unknown' for that reason
  note?: string; // why 'unknown' otherwise (outside a fit's range, invalid geometry)
}
```

A margin is a fraction of the limit, so a limit that is not above zero states none: the record
keeps its result and is `unknown` with a note, rather than reporting an infinite margin as room to
spare (`marginOf` returns NaN for it).

Every parameter takes a bare number (its source is then "given"), a `Given` (`{ value, source }`),
or nothing. A missing required input makes the record `unknown` and names the input; an input with a
default (a stress-concentration factor of 1, 90 % reliability) shows the default and says so in its
source. `fromRecord(r)` and `fromDerived(r, symbol)` pass one record's numbers into the next, citing
the record, so a chain of records reads as a calculation report.

```ts
import { fromRecord, given, shaftStress, strengthFactor } from '@manufakture/calc';

const stress = shaftStress({ M: 80, T: 44, d: 0.02, Kf: 1.7 }, { id: 'shaft.stress@bearing-A' });
const factor = strengthFactor({
  stress: fromRecord(stress),
  strength: given(415e6, 'material steel-1045, yield'),
  requiredFactor: given(2, 'your default factor'),
});
// von Mises 180 MPa: factor.result 2.31, factor.margin 0.15, factor.status 'ok'
```

All values are SI: metres, newtons, pascals, newton-metres, radians, rad/s, seconds, kelvin, watts,
volts, amperes, ohms. Converting to display units is the caller's job (`@manufakture/units`).

## Methods and sources

| Area                 | Functions                                                                                                                                                         | Sources                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Factors              | `strengthFactor`, `loadFactor`                                                                                                                                    | Shigley 10th ed. Sec. 1-10                                                                          |
| Beams                | `cantileverPointLoad`, `cantileverUniformLoad`, `simplySupportedCentreLoad`, `simplySupportedUniformLoad`                                                         | Roark 7th ed. Table 8.1; Shigley Table A-9                                                          |
| Shafts               | `shaftStress` (von Mises), `shaftFatigueFactor` (DE-Goodman, DE-Gerber, DE-ASME elliptic, DE-Soderberg), `shaftTwist`                                             | Shigley 10th ed. Sec. 7-4, Eqs. (7-8) to (7-15)                                                     |
| Critical speed       | `uniformShaftCriticalSpeed`, `rayleighCriticalSpeed`, `dunkerleyCriticalSpeed`                                                                                    | Shigley 10th ed. Eqs. (7-22), (7-23), (7-32)                                                        |
| Fatigue              | `marinEnduranceLimit` (ka to kf), `fatigueNotchFactor` (Neuber), `sizeFactor`, `temperatureFactor`, `reliabilityFactor`                                           | Shigley 11th ed. Eqs. (6-10) to (6-36), Table 6-2; 10th ed. Eq. (6-27)                              |
| Stress concentration | `shoulderFilletKt`, `grooveKt`, `holeInPlateKt`, `keyseatKt`                                                                                                      | Pilkey, Formulas for Stress, Strain, and Structural Matrices, Table 6-1 (fits of Peterson's charts) |
| Bearings             | `equivalentDynamicLoad`, `deepGrooveEquivalentLoad`, `bearingRatingLife`, `reliabilityLifeFactor` (a1), `isoLifeModificationFactor` (aISO), `bearingStaticFactor` | ISO 281:2007; ISO 76; Shigley 10th ed. Table 11-1                                                   |
| Bolted joints        | `tensileStressArea`, `preloadFromTorque` (VDI 2230), `preloadFromTorqueNutFactor`, `boltStiffness`, `frustumStiffness`, `memberStiffness`, `seriesStiffness`      | VDI 2230 Part 1; Shigley 10th ed. Eqs. (8-17) to (8-22), (8-27); ISO 898-1                          |
| Joint factors        | `separationFactor`, `slipFactor`, `boltProofFactor`, `boltOverloadFactor`                                                                                         | Shigley 10th ed. Eqs. (8-28) to (8-30); VDI 2230 step R12                                           |
| Threads              | `threadStrippingFactor` (external and internal shear areas)                                                                                                       | FED-STD-H28/2B; Machinery's Handbook                                                                |
| Gears                | `lewisFormFactor`, `velocityFactor` (Barth), `lewisBendingStress`, `elasticCoefficient`, `hertzContactStress`                                                     | Shigley 10th ed. Table 14-2, Eqs. (14-6) to (14-14)                                                 |
| Belts                | `beltWrapAngle`, `beltCentrifugalTension`, `flatBeltTensions`, `synchronousBeltTensionFactor`, `synchronousBeltToothFactor`                                       | Shigley 10th ed. Sec. 17-2, Eq. (17-1); Gates synchronous belt design manual                        |
| Thick cylinders      | `lameStresses`                                                                                                                                                    | Shigley 10th ed. Eqs. (3-49), (3-50)                                                                |
| Wiring               | `awgDiameter`, `awgArea`, `conductorResistance`, `wireAmpacityTable`, `wireAmpacityHeatBalance`, `voltageDrop`, `jouleHeating`                                    | ASTM B258; NBS Handbook 100; NFPA 70 Table 310.16 (copper); Incropera                               |
| Thermal              | `firstOrderTemperature` (one lumped RC to ambient)                                                                                                                | Incropera, lumped capacitance                                                                       |

Fits are used only inside their published ranges (the stress-concentration fits, the Neuber
constant, the size and temperature factors, a1); outside them the record is `unknown` with a note
rather than an extrapolated number. The NEC ampacity table is for building wire (30 °C ambient, up
to three conductors in a raceway); the record says so, and `wireAmpacityHeatBalance` covers a bare
conductor in air.

## Tests

Each function is tested against a published worked solution where one could be checked: the
examples in Pilkey's Table 6-1 chapter, the Shigley solutions manuals (10th ed. chapters 3, 4, 7, 8,
11, 14 and 17; 11th ed. chapter 6), the ISO 281 a1 table, the NEC ampacity table and the NBS copper
wire table, each named with its book and problem number. Where no published example was available
to check, the test computes the expected value independently and its name says "closed-form check,
not a textbook example".

```sh
./node_modules/.bin/vitest run --project packages packages/calc
```
