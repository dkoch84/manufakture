# 0005: Units: millimetres and radians inside, per-document display units outside

- Status: accepted, amended 2026-10-03
- Date: 2026-09-26

## Context

manufakture targets metric and imperial users: a Shapeoko CNC and a Bambu Lab printer ([product decisions](../decisions/0000-product-decisions.md)), and later woodworking and construction, where lengths are written as `3' 4-1/2"`. Every numeric field accepts an expression with named variables. The kernel ([ADR 0001](0001-kernel-wrapper.md), [T0.2](../spikes/T0.2-occt.md)) and the solver ([T0.4](../spikes/T0.4-planegcs.md), whose solved arc has start angle 0 and end angle pi/2) take plain numbers, so one internal convention is needed, and one place that turns text into those numbers.

That place already exists: [`packages/units`](../../packages/units/README.md) (task T1.1) parses and formats lengths and angles, evaluates expressions with variables and dimensional analysis, and never throws. This ADR records its conventions as project-wide decisions.

## Decision

1. **Internal units: millimetres as float64 for length, radians for angle.** This is what `packages/units` returns, what the document's evaluated values are in, and what `packages/kernel`, `packages/sketch` and `packages/regen` accept. No package converts units on its own; conversions go through `packages/units` (`toMillimetres`, `toRadians` and their inverses).
2. **All numeric input goes through `packages/units`.** No other parser of user-typed numbers exists in the codebase. Callers state the expected kind (`length`, `angle` or `number`), and a result of the wrong dimension is an error.
3. **Display units are a per-document setting**, stored in the document ([ADR 0004](0004-document-format.md)). Formatted output always parses back to the displayed value.
   - Length format: `mm` (the default for a new document), `cm`, `m`, `in`, `ft`, `ft-in` (`3' 4-1/2"`) or `in-fraction` (`40-1/2"`). The decimal formats take a number of decimals; the fractional ones take a denominator that is a power of two from 1 to 128 (16 by default).
   - Angle unit: degrees (the default) or radians.
4. **Expression syntax is the one in the [`packages/units` README](../../packages/units/README.md)**: `+ - * / ^`, parentheses, units after numbers or parentheses, fraction literals, mixed numbers, feet-inches compounds, the constant `pi`, the listed functions, and variables written `#name` or `name`. Dimensional analysis is always on: adding a length to an angle, or entering an area in a length field, is an error.
5. **Bare numbers mean the display unit**, where the context needs a length or angle (`12` in an inch document is 12 inches; `thickness + 3` adds 3 display units). Because that meaning depends on a setting, a stored expression carries the bare-number units it was entered under ([ADR 0004](0004-document-format.md), decision 7). Changing the display units changes how values are shown, never the geometry.
   - The bare-number length unit is always a `LengthUnit` (`'mm' | 'cm' | 'm' | 'in' | 'ft'`), passed to `packages/units` as `lengthUnit` (its default is `'mm'`). The package does not derive it from a display format: `LengthUnit` does not include the fractional formats, and `formatLength` takes them only as a separate `FractionalLengthFormat`.
   - Under a decimal format, it is the format's own unit.
   - Under `ft-in` and `in-fraction`, it is **`'in'`**. Both formats round to the nearest `1/denominator` inch and show inches and fractions of an inch (`ft-in` adds whole feet), so `12` is 12 inches and `4 1/2` is 4.5 inches in either; feet are always written with a mark (`3'`, `3ft`). A one-argument `round(x)` on a length therefore rounds to whole inches under both. Formatted output in these formats always carries its marks, so parsing it back does not depend on this choice.
6. **Errors are values.** Parsing and evaluation return a `Result` with a code and a source range; the UI highlights the range and shows the message. Nothing throws on bad input.
7. **Variables** are named by `isValidVariableName`. Their dependency graph and cycle detection use `findReferences` and `collectReferences`, which work before anything is evaluated.
8. **Roof pitch notation (`6/12` as an angle) is deferred to M6** (construction). When it comes, it applies to angle fields only, so `6/12` stays a division everywhere else. Until then, write `atan2(6, 12)`.

## Alternatives considered

- **An internal unit per document** (inches inside an imperial document). Every package would need to know the document's unit, and mixed-unit expressions and imports would convert twice. Rejected: one internal unit, conversion at the edges.
- **Degrees internally.** Friendlier to read in a debugger, but the solver's arcs are in radians and trigonometry is in radians; every call site would convert. Rejected.
- **Storing evaluated numbers instead of expressions.** Loses intent and variables (see [ADR 0004](0004-document-format.md)).
- **Storing expressions without their entry units.** A bare `12` would silently change from 12 mm to 12 inches when the display unit changes. Rejected.
- **Pitch notation now.** It collides with division, and nothing before M6 needs it.

## Consequences

- Imperial documents compute in millimetres like every other document; users only ever see their display units. Fractional display rounds once to the nearest `1/denominator` inch, so what is shown can differ from the stored value by up to half of that step.
- Anything the kernel or solver returns (measurements, dimensions) must be formatted with `formatLength` or `formatAngle` in the document's settings; no hand-written formatting.
- New syntax (comparisons, locale decimal commas, pitch) goes into `packages/units` first, with its own README section, before any UI uses it.

## Amendment: roof pitch notation and percent slopes (T6.0b)

Decision 8 deferred pitch notation to M6 and said it would apply to angle fields only, so that `6/12` stays a division everywhere else. T6.0b added it on 2026-10-03, following the M6 plan ([`docs/plans/m6.md`](../plans/m6.md), "Pitch notation in `packages/units`"). The decision stands; this records how it is carried out, and one addition. The full rules are in the [`packages/units` README](../../packages/units/README.md#roof-pitch-and-slopes).

- **`rise:run` is a pitch in any expression**, the angle `atan(rise / run)`. The colon was not a token before, so no existing input changes meaning. Both sides are lengths or bare numbers (`6:12`, `#rise:#run`). The colon binds looser than `*`, `/` and `^` and tighter than `+` and `-` (`6:24/2` is `6:12`; `6:12 + 2°` works) and does not chain (`1:2:3` is an error). A pitch is an angle, so in a length or number field it is a `dimension` error. Taking the colon for pitch means it is not available for ratios or times later; a future use would need a new ADR.
- **`6/12` is a pitch only in slope fields**, a narrower set than "angle fields": `EvaluateOptions.slope`, which roof and ramp features set on their pitch fields. There a division of two bare numbers is a pitch wherever it is the whole input or an operand of `+` or `-` (`6/12 + 2°` is 28.565°), and a bare number in those same places is an error at that operand ("Ambiguous: write 30° or 30/12", so `30 + 2°` is an error at `30`), the same stance as on `4-1/2`. The two halves cover the same places on purpose: a slope field never reads a unitless operand silently as degrees. Inside products and function arguments numbers keep their usual meaning (`2*(6/12)` is the number 1, so the ambiguity error; `2*(6:12)` doubles a pitch). In every other angle field `6/12` is still 0.5 of the display angle unit, as before. Which fields are slope fields is fixed by schemas that are new in M6, and stored expressions keep their source and entry units (decision 5, [ADR 0004](0004-document-format.md) decision 7), so no stored value changes meaning.
- **Formatting**: `formatAngle` takes `unit: 'pitch'` (`run`, default 12; `decimals` for the rise, trailing zeros dropped) and a `slope` option the caller passes from the same field option as evaluation: `6/12` with `slope: true`, `6:12` without, so the output always parses back to the displayed value (decision 3). Angles steeper than 89.9° fall back to degrees, since the rise grows without bound near 90°. Slope fields default to pitch display under `ft-in` and `in-fraction` and to the document's angle unit otherwise (`slopeDisplayUnit`), since metric roofs are usually given in degrees.
- **Addition: percent slopes, in slope fields only** (the project owner's decision during T6.0b). `25%` is a slope of 25 percent, `atan(25 / 100)`, the pitch `25:100`, and it displays as a pitch (`3/12`). `%` is a new token. It sits at the colon's level and applies to the whole term before it (`2*12.5%` is 25%); it combines with `+` and `-` like any angle and works inside parentheses (`(25%)*2`). Directly followed by `*`, `/` or `^`, applied to a value with a dimension, doubled, mixed with a colon, or applied to a bare division (`6/12%`, which is already a pitch there), it is an error. Outside slope fields, including plain angle fields, `%` is always an error, so it cannot be misread as "divide by 100" anywhere.
