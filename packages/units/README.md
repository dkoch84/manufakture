# @manufakture/units

Every numeric input in manufakture goes through this package: parsing lengths and angles in
metric and imperial notation, feed rates and spindle speeds for CAM, the physical quantities of
mechanical and electrical design (forces, torques, power, voltages, temperatures; see
[Physical quantities](#physical-quantities)), formatting them for display, and evaluating
expressions with named variables and dimensional analysis. It is plain TypeScript with no
dependencies.

## Internal units

| Quantity      | Internal unit                | Default display              |
| ------------- | ---------------------------- | ---------------------------- |
| length        | millimetres (float64)        | document unit                |
| angle         | radians                      | degrees                      |
| time          | minutes                      | n/a                          |
| feed          | millimetres per minute       | document length unit per min |
| spindle speed | revolutions per minute (rpm) | rpm                          |
| number        | plain number, no unit        | n/a                          |
| physical      | coherent SI (kg, N, N·m, …)  | per kind, see below          |

Every function that returns a length returns millimetres. Every function that returns an angle
returns radians. A feed rate is millimetres per minute and a spindle speed is revolutions per
minute, the units G-code and the CAM package work in. The physical kinds (force, torque, power,
temperature and the rest) evaluate to coherent SI: kg, N, N·m, m/s, rad/s, W, J, V, A, Ω, H, C,
K, Pa, Hz and s, which is what `packages/calc` takes. A `Quantity` (a variable's value, or what
`evaluateQuantity` returns) keeps every dimension in the internal base units (mm, rad, min, kg,
A, K); `quantityToSI` and `quantityFromSI` convert, and nothing converts by hand.

## Errors

Nothing throws on bad input. Fallible functions return a `Result<T>`:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: UnitsError };

interface UnitsError {
  code: UnitsErrorCode; // 'syntax' | 'unknown-unit' | 'unknown-variable' | 'unknown-function'
  //                       | 'arity' | 'dimension' | 'domain' | 'measure' | 'not-measured'
  message: string; // for example "Cannot add a length and an angle"
  start: number; // UTF-16 offset into the input, inclusive
  end: number; // exclusive; source.slice(start, end) is the text to highlight
}
```

The range is empty only when the input is empty or blank. Other errors point at the offending
part of the input:

| Error                               | What is highlighted                   |
| ----------------------------------- | ------------------------------------- |
| unknown variable, unit or function  | the name                              |
| dangling operator (`2 +`)           | the operator                          |
| unclosed parenthesis                | the `(`                               |
| `length + angle`                    | the whole `+` expression              |
| wrong result kind (area for length) | the whole expression, without padding |
| division by zero                    | the divisor                           |
| bad function argument               | that argument                         |

A parenthesised sub-expression's range includes its parentheses.

## Units

| Kind          | Spellings (word units are case-insensitive)                                     |
| ------------- | ------------------------------------------------------------------------------- |
| length        | `mm`, `cm`, `m`, `in` `inch` `inches` `"` `″`, `ft` `foot` `feet` `'` `′`, `yd` |
| angle         | `deg` `°`, `rad`                                                                |
| time          | `min`, `s`                                                                      |
| spindle speed | `rpm`                                                                           |

A unit goes directly after a number, with or without a space: `12mm`, `12 mm`, `1.5"`. It can
also follow a closing parenthesis: `(a + 2)mm`. A unit binds only to the number right before it,
so `2^3mm` is `2^(3mm)`, which is an error, and `x/2in` is `x / (2in)`.

**Bare numbers** (no unit) are dimensionless. Where the context needs a length or an angle, they
are read in the document's display unit (`lengthUnit`, `angleUnit`). Where it needs a feed, they
are display length units per minute (`600` is 600 mm/min in a millimetre document and 600 in/min
under `in`, `ft-in` or `in-fraction`); where it needs a spindle speed, they are rpm. This
applies:

- to the final result, so `12` in a length field with display unit `in` is 12 inches;
- to a bare operand of `+`, `-`, `min`, `max`, `atan2` or a `round` step whose other operand is
  a length, angle, feed or spindle speed, so `thickness + 3` means 3 display units;
- to the argument of `sin`, `cos` and `tan`, so `sin(30)` is `sin(30°)` when the display angle
  unit is degrees. Write `sin((pi/6)rad)` for radians.

Bare numbers are not converted in `*`, `/` or `^`: `2 * thickness` is twice the thickness.

### Feed rates and spindle speeds

A feed rate is a length per time and a spindle speed is "per time" (revolutions are not a
dimension). They are written as a unit per minute, or as a division by a time:

| Input           | Value          |
| --------------- | -------------- |
| `1000mm/min`    | 1000 mm/min    |
| `40in/min`      | 1016 mm/min    |
| `1.5 m/min`     | 1500 mm/min    |
| `25mm / 1s`     | 1500 mm/min    |
| `18000rpm`      | 18000 rpm      |
| `12000/min`     | 12000 rpm      |
| `1/8"/min`      | 3.175 mm/min   |
| `(a + 2)mm/min` | `a + 2` mm/min |

1. **Per-minute literal**: a number with or without a unit (or a parenthesised value with a
   unit), followed with no spaces by `/min`, is one literal, like a fraction literal. `/min`
   therefore binds to that number only: `x / 2mm/min` is `x / (2 mm/min)`, `x/2/min` is
   `x / (2/min)` (x times half a minute), and `1/2/min` is half a revolution per minute. A power
   applies to the whole literal: `1000mm/min^2` is `(1000mm/min)^2`.
2. **`min` is the minute** wherever it is not followed by `(`. `min` cannot be a variable name
   (it is a function), so `1000 mm / min` (with spaces), `x / min` and `5 min` are all minutes,
   while `min(a, b)` is always the function. After a number, `5 min (3)` is a syntax error, as
   for any unit followed by `(`.
3. **Seconds have no per-time form.** A variable may be called `s`, and `100mm/s` has always
   meant `100mm` divided by that variable, so it still does. Attach `s` to a number and divide
   by it instead: `25mm / 1s` or `25mm/(1s)` (both 1500 mm/min). In a physical field (a speed,
   say) `5 m/s` is a compound unit ([Physical fields](#physical-fields) rule 2); feed fields keep
   this rule.
4. `s` and `rpm` are units only after a number or a closing parenthesis (`30s`, `18000 rpm`,
   `(n)rpm`); written alone they are variable names, as before.
5. **Case**: after a number, `min`, `s` and `rpm` are case-insensitive like every word unit
   (`5MIN`, `18000RPM`). Standalone and after `/`, only lowercase `min` is the minute, because
   `MIN` is a valid variable name: `100mm/MIN` divides by a variable called `MIN`, as it always
   did.

Dimensional analysis treats time as a third dimension, so `#chipload * #flutes * #rpm` (a length
times a number times a spindle speed) is a feed, and `#feed / #rpm` is a length per revolution.
`1000mm/min + 5mm` is an error. A time on its own (`5 min`) is a valid intermediate value, but
there is no expected kind for it yet.

### Fractions, mixed numbers and feet-inches

Imperial notation uses `-`, `/` and spaces, which are also arithmetic. These rules decide which
meaning applies:

1. **Fraction literal**: `INT/INT` with no spaces around the slash, followed by a unit, is one
   number. `1/8"` is an eighth of an inch, not `1 / (8")`. With spaces, `1 / 8"` is division and
   gives 1/length. Without a unit, `1/2` is ordinary division; the value is the same, but
   precedence applies (`2^1/2` is `(2^1)/2`).
2. **Mixed number with a space**: `INT INT/INT` is one number, with or without a unit: `4 1/2"`
   and `4 1/2` are both 4.5. Two numbers next to each other can mean nothing else, so this is
   never ambiguous.
3. **Mixed number with a hyphen**: `INT-INT/INT` with no spaces is one number when a unit
   follows: `4-1/2"` is 4.5 inches and `10-1/2mm` is 10.5 mm. Without a unit, `4-1/2` could be
   4.5 or 3.5, so it is a `syntax` error: "Ambiguous: write '4 1/2', '4-1/2"' or '4 - 1/2'".
   Inside the inches part of a feet-inches value (rule 4) the inch unit is implied, so it is
   allowed there.
4. **Feet-inches**: after a foot value (`'`, `ft`, `foot`, `feet`), a number that follows
   directly, after whitespace, or after a hyphen with no spaces is the inches part. The inch mark
   is optional there, and fractions and hyphenated mixed numbers need no unit:
   `3' 4-1/2"`, `3'4-1/2"`, `3' 4 1/2"`, `3'-4"`, `3'-4`, `3' 4`, `3ft 4.5in`, `3ft4in`, and
   `3' 1/2"` all work. This follows architectural drawings, where `5'-6"` means 5 ft 6 in.
   To subtract, put spaces around the minus: `3' - 2"` is 34 inches. A minus that touches only
   the second number (`3' -2"`) also subtracts. A hyphen before a non-inch unit subtracts:
   `3'-2mm`.
5. **Sign**: a leading minus applies to the whole compound value: `-3' 4"` is −40 inches.
6. **Literals bind first**: a compound literal is read in full before any operator, so
   `3' 2 * 2` is `(3' 2") * 2`, which is 76 inches.

## Physical quantities

The mechanical domain ([ADR 0017](../../docs/adr/0017-mechanical-domain.md), decision 3) types
forces, torques, speeds, power, energy, electrical and thermal values through this package. Each
is a **physical kind**: a field states one, and its value evaluates to coherent SI.

### Kinds

| Kind                  | SI value | Dimension                | Units                                |
| --------------------- | -------- | ------------------------ | ------------------------------------ |
| `mass`                | kg       | mass                     | `kg g lb oz`                         |
| `force`               | N        | mass·length/time²        | `N kN lbf ozf kgf`                   |
| `torque`              | N·m      | mass·length²/time²       | `N*m Nm kN*m lbf*ft lbf*in ozf*in`   |
| `energy`              | J        | mass·length²/time²       | `J kJ Wh kWh`                        |
| `speed`               | m/s      | length/time              | `m/s mm/s km/h ft/s mph`             |
| `angularSpeed`        | rad/s    | angle/time               | `rad/s rpm deg/s`                    |
| `acceleration`        | m/s²     | length/time²             | `m/s^2 gn`                           |
| `power`               | W        | mass·length²/time³       | `W kW hp`                            |
| `voltage`             | V        | power/current            | `V mV kV`                            |
| `current`             | A        | current                  | `A mA`                               |
| `resistance`          | Ω        | voltage/current          | `ohm Ω mohm kohm mΩ kΩ`              |
| `inductance`          | H        | voltage·time/current     | `H mH uH µH`                         |
| `charge`              | C        | current·time             | `C Ah mAh`                           |
| `temperature`         | K        | temperature (absolute)   | `K degC degF °C °F ℃ ℉`              |
| `temperatureDelta`    | K        | temperature (difference) | `K degC degF °C °F ℃ ℉`              |
| `pressure`            | Pa       | force/length²            | `Pa kPa MPa GPa psi ksi bar`         |
| `stiffness`           | N/m      | force/length             | `N/m N/mm lbf/in`                    |
| `rotationalStiffness` | N·m/rad  | torque/angle             | `N*m/rad`, any torque unit per `rad` |
| `inertia`             | kg·m²    | mass·length²             | `kg*m^2 g*cm^2 lb*in^2`              |
| `frequency`           | Hz       | 1/time                   | `Hz kHz`                             |
| `time`                | s        | time                     | `s ms min h`                         |
| `torqueConstant`      | N·m/A    | torque/current           | `N*m/A`                              |
| `velocityConstant`    | rad/s/V  | angular speed/voltage    | `rpm/V`                              |
| `thermalResistance`   | K/W      | temperature/power        | `K/W`                                |
| `heatCapacity`        | J/K      | energy/temperature       | `J/K`                                |
| `linearDensity`       | kg/m     | mass/length              | `kg/m lb/ft`                         |

- `Dimension` has three more exponents, `mass`, `current` and `temperature`, optional like
  `time`: absent means 0, and the package sets them only when they are not zero, so every
  dimension that existed before looks exactly as it did.
- Torque and energy share a dimension, as do speed and feed, and frequency and spindle speed; the
  field's kind decides what the value means and how it is shown. `22 N*m` in an energy field is
  22 J.
- `km` (kilometre), `h` (hour), `ms` (millisecond) and `gn` (standard gravity, 9.80665 m/s²) are
  units too. `g` is the gram, never gravity.
- **The list is explicit.** There is no rule that puts an SI prefix on any unit, so `min`, `mm`
  and `ms` never collide, and a unit not in the table is an `unknown-unit` error. The new units
  are case-sensitive (`mA` and `MPa` are different things); the length, angle and time units of
  [Units](#units) stay case-insensitive.
- `°C` and `°F` are one unit when the letter follows the `°` with no space; a lone `°` is still
  the degree of angle. `Ω` (also the ohm sign), `µ` (also `μ`), `℃` and `℉` are accepted in unit
  names, and `·` is accepted as
  `*` (`N·m`).
- `lbf` is 4.4482216152605 N, `lb` 0.45359237 kg, `hp` the mechanical horsepower (745.7 W),
  `psi` 1 lbf/in², `ksi` 1000 psi, `kgf` 9.80665 N.

### Physical fields

A **physical field** is one whose expected kind is one of the kinds above, or any evaluation
with `physical: true` in its context (for a variable of the mechanical domain whose kind is
inferred). Four rules hold there and nowhere else, so no expression stored before them reads
differently:

1. **Bare numbers are an error.** `200` in a force field is a `dimension` error, "A force needs a
   unit: write 200 N or 200 lbf". So is a bare operand of `+`, `-`, `min`, `max`, `atan2` or a
   `round` step (`#force + 5`), and a bare argument of `sin`, `cos` and `tan` ("write 30° or 30
   rad"). Bare numbers still multiply, divide and raise (`2 * #force`, `#torque / 0.025 m`).
   This is an exception to [ADR 0005](../../docs/adr/0005-units.md) decision 5, where bare
   numbers mean the display unit: a physical value is never typed in a display unit, so a stored
   expression's meaning never depends on a display preference, and `StoredExpression` needs no
   entry unit for it. `number` fields (ratios, efficiencies, counts, factors) are unchanged, and
   so is every length, angle, feed and spindle speed field.
2. **Compound units.** A unit followed with no spaces by `*`, `·` or `/` and another unit, or by
   `^` and a whole number, continues the unit: `22 N*m`, `5 m/s`, `9.81 m/s^2`, `0.5 kg*m^2`,
   `20 W/(m*degC)`, `100 N/mm^2`, `rpm/V`. Parentheses group units the same way. The compound
   binds to its number like a single unit: `2 / 4 m/s` is 2 divided by 4 m/s, and `2 mm^2` is two
   square millimetres. A number followed with no spaces by `/` and a unit is a rate:
   `50/s` is 50 Hz. With spaces it is arithmetic again: `5 m / s` divides by a variable `s`.
3. **`rpm` is an angular speed**, 2π rad per minute, so `573 rpm` is 60 rad/s and
   `22 N*m * 573 rpm` is a power. In a spindle speed field `rpm` keeps its meaning (revolutions
   per minute, no angle).
4. **Radians are dimensionless** (SI's rad = 1): where the expected kind is a physical kind, the
   angle exponent is ignored when the result is compared with it, so `22 N*m * 60 rad/s` is a
   power and `#power / #torque` is an angular speed in rad/s. The geometric kinds (`length`,
   `angle`, …) keep checking angle as before. One exception: a `frequency` field refuses a value
   with an angle, since `573 rpm` read as 60 Hz would be wrong by 2π; write `Hz`, or divide an
   angular speed by `(2*pi)rad`. The other way round, `10 Hz` in an angular speed field is
   10 rad/s, as SI reads it; write `rpm` or `rad/s` there.

Outside physical fields (a length or `number` field, or a variable of type "any") the new units
work too, but a compound unit is read only when it starts with one of the new units: `22 N*m`
and `1.7 Ah` are a torque and a charge anywhere, while `5 m/s` and `2mm^2` keep their old
reading (`5 m` divided by a variable `s`, and `(2mm)^2`), and `rpm` stays a spindle speed. An AST
from `parseExpression` records which reading it was parsed with, in a `parsedPhysical` field of its
root (set only when the mode changes the reading, and kept by a cloned or serialised tree): parse
with `{ physical: true }` before evaluating in a physical field (`evaluate` does this itself), or
the evaluation is a `syntax` error rather than a silently different value. A cache of parsed
expressions or references must therefore key on the mode as well as the source.

A physical literal keeps its SI value from the number typed, and a physical field computes its
SI result alongside the internal one through signs, `+`, `-`, `*`, `/` and `^`, so `1 kgf` is
exactly 9.80665 N, `10 µH` exactly 1e-5 H and `22 N*m / 25 mm` exactly 880 N. Functions and
temperatures convert the internal value instead (`-40degC` is 233.14999999999998 K, one
rounding off, since 273.15 has no exact binary value).

Dimension checking works through any expression: `22 N*m / 25 mm` is a force (880 N),
`57.6 V * 1.7 Ah` an energy (97.92 Wh), `22 N*m / (0.5 N*m/A)` a current (44 A), and
`(44 A)^2 * 0.08 ohm` a power. `#torque + #force` is a `dimension` error, "Cannot add a torque
or an energy and a force".

### Temperature

Temperatures are affine: 0 °C is 273.15 K, not 0 K. The `temperature` kind is an absolute
temperature and `temperatureDelta` a difference, both in kelvin.

- `25degC` in a `temperature` field is 298.15 K; in a `temperatureDelta` field it is 25 K.
  `77degF` is 298.15 K or 25 K the same way. `K` is the same number either way.
- An absolute temperature may only stand alone, have a difference added or subtracted
  (`#ambient + 40 K`, `#ambient + 40degC`), or be subtracted from another absolute temperature,
  which gives a difference (`#winding - #ambient`). Anything else is a `dimension` error: two
  absolute temperatures added, an absolute temperature multiplied, divided, raised to a power or
  negated.
- A `degC` or `degF` literal is either until its use decides: alone it is whatever the field
  needs, and with an absolute temperature added or subtracted it is a difference
  (`#ambient + 40degC`, `#ambient - 5degC`). `-40degC` is 233.15 K.
- **Two literals are two absolute temperatures.** `80degC - 20degC` is a difference of 60 K, so
  `rise = 80degC - 20degC` works as `#ambient + #rise` and `#heatCapacity * #rise`, and a
  temperature field refuses it. Two literals cannot be added as absolute temperatures either:
  `20degC + 5degC` is 25 K, a difference, and an error in a temperature field (write
  `#ambient + 5 K`, or `20degC + 5 K`). A literal and a kelvin value keep the flexible reading:
  `25degC - 5 K` is 20 °C in a temperature field and 20 K in a difference field.
- Inside a compound unit a temperature unit is a difference: `20 W/(m*degC)` is 20 W/(m·K), and
  `2 K/W` the same as `2 degC/W`.
- In `min`, `max`, `round`, `floor` and `ceil` a `degC` or `degF` value is absolute; a rounding
  step is a difference (`round(#t, 5 K)`). Other functions refuse absolute temperatures.
  `round(#t)` with no step rounds in kelvin, not in the display unit: 298.15 K (25 °C) rounds to
  298 K (24.85 °C). Give a step to round to whole degrees of a scale, and note that a step rounds
  to multiples of it in kelvin too.
- Outside a temperature field (a variable of type "any") a lone `25degC` is the absolute
  temperature 298.15 K, and `evaluateQuantity` marks it `absolute: true`; a known difference
  (`#t1 - #t2`, `2 * 5degC`) is marked `absolute: false`, and a plain kelvin value (`5 K`) is not
  marked. A variable's `Quantity` is read the same way: `physicalQuantity('temperature', …)` is
  absolute, `physicalQuantity('temperatureDelta', …)` a difference.

### Display units per kind

A physical value is shown in one unit per kind. The document will store the user's choice per
kind (`units.quantities`, ADR 0017's T9.1e); until then, and for any kind without a choice, the
unit system follows the document's length format: SI for `mm`, `cm` and `m`, US customary for
`in`, `ft`, `ft-in` and `in-fraction`.

| Kind                  | SI default | US default   | Other display units              |
| --------------------- | ---------- | ------------ | -------------------------------- |
| `mass`                | `kg`       | `lb`         | `g`, `oz`                        |
| `force`               | `N`        | `lbf`        | `kN`, `ozf`, `kgf`               |
| `torque`              | `N·m`      | `lbf·ft`     | `kN·m`, `lbf·in`, `ozf·in`       |
| `energy`              | `J`        | `J`          | `kJ`, `Wh`, `kWh`                |
| `speed`               | `m/s`      | `mph`        | `mm/s`, `km/h`, `ft/s`           |
| `angularSpeed`        | `rpm`      | `rpm`        | `rad/s`, `deg/s`                 |
| `acceleration`        | `m/s^2`    | `ft/s^2`     | `gn`                             |
| `power`               | `W`        | `W`          | `kW`, `hp`                       |
| `voltage`             | `V`        | `V`          | `mV`, `kV`                       |
| `current`             | `A`        | `A`          | `mA`                             |
| `resistance`          | `Ω`        | `Ω`          | `mohm`, `kohm`                   |
| `inductance`          | `mH`       | `mH`         | `H`, `µH`                        |
| `charge`              | `Ah`       | `Ah`         | `C`, `mAh`                       |
| `temperature`         | `°C`       | `°F`         | `K`                              |
| `temperatureDelta`    | `K`        | `°F`         | `°C`                             |
| `pressure`            | `MPa`      | `psi`        | `Pa`, `kPa`, `GPa`, `ksi`, `bar` |
| `stiffness`           | `N/mm`     | `lbf/in`     | `N/m`                            |
| `rotationalStiffness` | `N·m/rad`  | `lbf·ft/rad` |                                  |
| `inertia`             | `kg·m^2`   | `lb·in^2`    | `g·cm^2`                         |
| `frequency`           | `Hz`       | `Hz`         | `kHz`                            |
| `time`                | `s`        | `s`          | `ms`, `min`, `h`                 |
| `torqueConstant`      | `N·m/A`    | `N·m/A`      |                                  |
| `velocityConstant`    | `rpm/V`    | `rpm/V`      |                                  |
| `thermalResistance`   | `K/W`      | `K/W`        |                                  |
| `heatCapacity`        | `J/K`      | `J/K`        |                                  |
| `linearDensity`       | `kg/m`     | `lb/ft`      |                                  |

```ts
type UnitSystem = 'si' | 'us';
type QuantityDisplayUnits = Partial<Record<PhysicalKind, string>>; // the stored choice, per kind

unitSystemOf(lengthFormatUnit): UnitSystem // 'us' for in, ft, ft-in, in-fraction
displayUnitsOf(kind): readonly string[] // every display unit of a kind, default first
defaultDisplayUnit(kind, system): string
resolveDisplayUnit(kind, preferences, lengthFormatUnit): string // the choice if valid, else the default
formatQuantity(si, kind, { unit?, decimals? }): string // `890.0 N`, `16.23 lbf·ft`, `25.0 °C`
toDisplayUnit(si, kind, unit): number // 890 N in lbf: 200.08
fromDisplayUnit(value, kind, unit): number // 200 lbf in N: 889.64
```

`formatQuantity` writes fixed decimals (a default per unit, or `decimals`), a space and the unit,
and handles `-0` and non-finite values like `formatLength`. A unit the kind does not have falls
back to the SI default. The output parses back, in a field of the same kind, to the displayed
value: `25.0 °C` in a temperature field is 298.15 K, and `9.0 °F` in a difference field 5 K.

## Expressions

```
expression := slope (('+' | '-') slope)*
slope      := term (':' term | '%')?         a pitch or a percent slope, never chained
term       := unary (('*' | '/') unary)*
unary      := ('-' | '+') unary | power
power      := primary ('^' unary)?           right-associative: 2^3^2 = 2^9
primary    := number-literal | '(' expression ')' unit? | #name | name | name '(' args ')'
            | '"' face-name '"'              only as an argument (after '(' or ',')
```

- Precedence from lowest to highest: `+ -`, then the pitch colon `:` and the percent sign `%`,
  then `* /`, then unary minus, then `^`. So `-2^2 = -4` and `2^-1 = 0.5`. See
  [Roof pitch and slopes](#roof-pitch-and-slopes) for `:` and `%`. `×` and the Unicode minus `−` are accepted too.
- Numbers: `12`, `1.5`, `.5`, `1e3`. A literal too large for a float64 (`1e400`, `1e308ft`) is
  a `domain` error "Number is too large". A number and a name glued together must be a unit:
  `2pi` is an error that suggests `2*pi`.
- **Variables**: `#thickness` or `thickness`. Names match `[A-Za-z_][A-Za-z0-9_]*` and are case
  sensitive. A name followed by `(` is always a function call. After a number, a name is a unit
  if it is one, so `2 in` is two inches while `2 * in` uses a variable called `in`.
- **Constants**: `pi`. `#pi` refers to a variable named `pi` instead.
- **Functions**:

  | Function                                | Arguments                 | Result         |
  | --------------------------------------- | ------------------------- | -------------- |
  | `min(a, …)`, `max(a, …)`                | 1 or more, same dimension | same           |
  | `abs(x)`                                | any                       | same           |
  | `sqrt(x)`                               | any, not negative         | half exponents |
  | `sin`, `cos`, `tan`                     | angle (or bare number)    | number         |
  | `asin`, `acos`, `atan`                  | number                    | angle          |
  | `atan2(y, x)`                           | same dimension            | angle          |
  | `round(x)`, `floor(x)`, `ceil(x)`       | any                       | same           |
  | `round(x, step)`, `floor(…)`, `ceil(…)` | same dimension            | same           |

  With one argument, `round`, `floor` and `ceil` work in the display unit when the value is a
  length or an angle: `round(2.4in)` is `2in` when the display unit is inches and `61mm` when it
  is millimetres, and `round(29.6deg)` is `30deg` when angles display in degrees. A feed rounds
  to whole display length units per minute (`round(1016.3mm/min)` is `40 in/min` under inches)
  and a spindle speed to whole rpm. Any other
  value (a number, an area) is rounded as it is, in internal units. With a step they round
  to a multiple of it: `round(width, 1/16")`. `round` rounds halves away from zero.

- **Measuring the model**: `distance("a", "b")` is a length and `angle("a", "b")` an angle,
  where `a` and `b` are face names. They are read from the context's `measure` lookup (regen
  answers it from the part's geometry; see `docs/agents/authoring.md`, "Measured variables"). A
  `"` right after `(` or `,` opens a quoted name; anywhere else it is still the inch mark, so no
  expression that parsed before reads differently. A quoted name is only an argument of these
  two. With no `measure` lookup, or none that answers, the call is a `not-measured` error; a
  measurement that failed (a face not found) is a `measure` error with its message. `distance`
  and `angle` are not in `FUNCTION_NAMES` and stay valid variable names: written bare they are the
  variable, followed by `(` always the call.

### Roof pitch and slopes

A roof pitch `p/12` is `p` units of rise per 12 units of run, the angle `atan(p / 12)`: `4/12` is
18.435°, `6/12` is 26.565° and `12/12` is 45°. Since `6/12` is also a division, which meaning
applies depends on the field.

1. **`rise:run` is a pitch in any expression.** `6:12` is `atan(6/12)`, an angle. Both sides are
   lengths or bare numbers: `7.5:12`, `#rise:#run`, `6in:1ft`. A bare side next to a length is
   read in the display length unit, so `#rise:12` in an inch document is 12 inches of run. The
   colon binds looser than `*`, `/` and `^` and tighter than `+` and `-`, so `#rise*2:12` is
   `(#rise*2):12`, `6:24/2` is `6:12`, and `6:12 + 2°` adds two degrees to the pitch. A unary
   minus belongs to the rise: `-6:12` is a negative pitch. It does not chain: `1:2:3` is a
   `syntax` error. The run must be greater than zero, and sides that are angles or other
   dimensions are a `dimension` error.
2. **A pitch is an angle.** In a length or number field, `6:12` is a `dimension` error, "A pitch
   is an angle, but a length is expected". Inside an expression it is an angle like any other:
   `tan(6:12)` is 0.5 in a number field.
3. **`6/12` is a pitch only in slope fields.** A slope field is an angle field that a roof or ramp
   feature marks with `slope: true` ([Evaluating](#evaluating)). There, a division of two bare
   numbers is a pitch when it is the whole input or an operand of `+` or `-` (with or without a
   sign or parentheses): `6/12`, `7.5/12`, `-6/12`, `(6/12)`, `3*2/12`, and `6/12 + 2°` is
   28.565°. Everywhere else `6/12` is ordinary division, so in a plain angle field it is still 0.5
   of the display angle unit (half a degree), as it always was, and `6/12 + 2°` is 2.5°. Inside a
   product or a function argument it divides as usual in a slope field too: `2*(6/12)` is the
   number 1, so an ambiguity error (rule 4), not a doubled pitch; write `2*(6:12)`. A division whose operands have a dimension divides as
   usual (`53.13°/2` is an angle); a ratio of two lengths (`#rise/#run`) is an error that
   suggests `#rise:#run`.
4. **A bare number is ambiguous in a slope field.** `30` could be 30° or a 30/12 pitch, so it is a
   `dimension` error, "Ambiguous: write 30° or 30/12". The rule covers the same places as rule 3:
   the whole input and every operand of `+` and `-`, and the error highlights the operand without
   a unit. So `30 + 2°`, `6:12 - 2` and `6/12 + 1` are errors at `30`, `2` and `1`, and `2*15` is
   an error at `2*15`. (In a plain angle field those operands still take the display angle unit:
   `30 + 2°` is 32°.) Anything with an angle unit is an angle as before: `26.57°`, `0.5rad`,
   `atan2(6, 12)`, `6:12`. Inside a function argument a bare number keeps its usual reading, as
   the function defines it (`atan2(6, 12)`, `round(6:12, 1)`).
5. **Percent slopes**, in slope fields only. `25%` is a slope of 25 percent, the angle
   `atan(25 / 100)` (14.036°); it is the pitch `25:100`, and displays as `3/12`. The percent sign
   sits at the same level as the colon and applies to the whole term before it: `2*12.5%` is 25%,
   and `#grade%` takes a number variable as percent. A percent combines with `+` and `-` like any
   angle (`25% + 2°`, `6:12 - 25%`), and inside parentheses or function arguments
   (`(25%)*2`, `max(25%, 4:12)`). These are errors:
   - `%` outside a slope field, including plain angle, length and number fields and
     `evaluateQuantity`: "A percent is a slope, and is allowed only in a slope field" (`syntax`).
   - `25%*2` and `25%/2`: write `(25%)*2`, or put the factor first (`2*12.5%`).
   - A percent of a value with a dimension (`25mm%`), `25%%`, and mixing the two notations
     (`25%:4`, `6:12%`).
   - A percent of a division of bare numbers, `6/12%` or `50/2%`: in a slope field that division
     is already a pitch, so it is a `syntax` error, "In a slope field rise/run is already a
     pitch: write it without % (6/12), or as a percent (50%)". Write `6/12`, or the percent
     itself (`50%`, `25%`).

Which fields are slope fields is fixed by each feature's schema, and a stored expression keeps
its source text, so no existing `6/12` changes meaning.

### Dimensional analysis

Every value has a dimension: exponents of length, angle and time, and of mass, current and
temperature for the [physical kinds](#physical-quantities). `thickness * width` is an
area, `sqrt(area)` is a length, `1 / thickness` is 1/length. Angle is its own dimension, so
`thickness * slope` is length·angle, not a length. Time is the third: a feed is length/time and a
spindle speed 1/time.

- `+`, `-`, `min`, `max`, `atan2` and a `round` step need operands of the same dimension, apart
  from the bare-number rule above. `thickness + 30deg` is an error.
- `^` needs a dimensionless exponent and scales the base's dimension.
- A unit can be applied only to a dimensionless value: `(2mm)in` is an error.
- The caller states the expected kind (`length`, `angle`, `feed`, `spindleSpeed`, `number` or a
  physical kind), and the result must match it exactly (a physical kind ignores the angle
  exponent, [Physical fields](#physical-fields) rule 4). `thickness * thickness` in a length field is an error,
  and so is `1000mm` in a feed field ("Expected a feed rate (length/time) but got a length").
- Every intermediate result is checked. A non-finite value (`10^400`, `1e300 * 1e300`) is a
  `domain` error at the operation that produced it, even when later operations would hide it
  (`1 / 10^400`, `min(1e200 * 1e200, 5)`). Division by zero is a `domain` error at the divisor.
- Results are never `-0`. `-0`, `0 * -1` and similar give `+0`.

### Limits

Parentheses, signs, function calls and powers may nest at most `MAX_NESTING` (256) levels deep.
The syntax tree as a whole, including chained operators (`a + b + c + …`), may be at most
`MAX_TREE_DEPTH` (1024) levels deep. Deeper input gives a `syntax` error instead of overflowing
the call stack.

## API

```ts
import {
  evaluate,
  parseLength,
  parseAngle,
  parseFeed,
  parseSpindleSpeed,
  evaluateQuantity,
  parseExpression,
  evaluateParsed,
  evaluateParsedQuantity,
  findReferences,
  collectReferences,
  isValidVariableName,
  formatLength,
  formatAngle,
  formatNumber,
  formatFeed,
  formatSpindleSpeed,
  slopeDisplayUnit,
  lengthQuantity,
  angleQuantity,
  numberQuantity,
  timeQuantity,
  feedQuantity,
  spindleSpeedQuantity,
  // physical quantities
  PHYSICAL_KINDS,
  isPhysicalKind,
  physicalQuantity,
  quantityToSI,
  quantityFromSI,
  formatQuantity,
  unitSystemOf,
  displayUnitsOf,
  defaultDisplayUnit,
  resolveDisplayUnit,
  toDisplayUnit,
  fromDisplayUnit,
} from '@manufakture/units';
```

### Evaluating

```ts
evaluate(source: string, options: EvaluateOptions): Result<number>

interface EvaluateOptions {
  expected: 'length' | 'angle' | 'feed' | 'spindleSpeed' | 'number' | PhysicalKind;
  lengthUnit?: 'mm' | 'cm' | 'm' | 'in' | 'ft'; // bare-number length unit (and feed unit per min), default 'mm'
  angleUnit?: 'deg' | 'rad'; // bare-number angle unit, default 'deg'
  variables?: (name: string) => Quantity | undefined; // name has no '#'
  slope?: boolean; // a slope field: pitch `6/12`, percent `25%`, bare numbers ambiguous (with expected 'angle' only)
  physical?: boolean; // the physical-field rules for any kind; implied by a physical `expected`
}

interface Quantity {
  value: number; // internal units: mm, rad, min, kg, A, K
  dimension: Dimension; // { length, angle, time?, mass?, current?, temperature? }, absent means 0
  absolute?: boolean; // a temperature: true absolute, false a difference, absent either
}
```

The result is in millimetres, radians, mm/min, rpm or a plain number, or SI for a physical kind. Build lookup values with
`lengthQuantity(mm)`, `angleQuantity(rad)`, `numberQuantity(n)`, `timeQuantity(minutes)`,
`feedQuantity(mmPerMinute)` and `spindleSpeedQuantity(rpm)`, and a physical value with
`physicalQuantity(kind, si)` (`physicalQuantity('force', 890)`; a `temperature` is marked
absolute). `quantityToSI(q)` gives a `Quantity`'s value in SI, and `quantityFromSI(si, dimension)`
the internal value of an SI one. `time` is optional in `Dimension` so
that dimensions written before it existed (`{ length: 2, angle: 0 }`) stay valid; the package
only sets it when it is not zero, so lengths and angles look exactly as they did.

```ts
const vars = new Map([['thickness', lengthQuantity(19.05)]]);
evaluate('2*#thickness + 1/8"', {
  expected: 'length',
  lengthUnit: 'in',
  variables: (n) => vars.get(n),
});
// { ok: true, value: 41.275 }
```

And for a feed:

```ts
const vars = new Map([
  ['chipload', lengthQuantity(0.05)],
  ['flutes', numberQuantity(2)],
  ['rpm', spindleSpeedQuantity(18000)],
]);
evaluate('#chipload * #flutes * #rpm', { expected: 'feed', variables: (n) => vars.get(n) });
// { ok: true, value: 1800 } (mm/min)
```

- `parseLength(source, unit = 'mm')` is `evaluate` with `expected: 'length'` and no variables.
- `parseAngle(source, unit = 'deg')` is the same for angles, and returns radians.
- `parseFeed(source, unit = 'mm')` returns mm/min; bare numbers are `unit` per minute (pass
  `'in'` under `ft-in` and `in-fraction`, as for lengths).
- `parseSpindleSpeed(source)` returns rpm; bare numbers are rpm.
- `parseQuantity(source, kind)` is `evaluate` with `expected: kind` and no variables: for a
  physical kind it returns SI (`parseQuantity('200 lbf', 'force')` is 889.64).
- `evaluateQuantity(source, context)` returns a `Quantity` without an expected kind, and leaves
  bare numbers dimensionless. Use it where the kind is inferred, for example variables of type
  "any".
- `parseExpression(source, { physical? })` returns the AST (`Expression`). Parsing needs no
  context beyond whether the field is physical, so an AST can be cached and evaluated many times with `evaluateParsed(ast, options)` or
  `evaluateParsedQuantity(ast, context)`.
- `FUNCTION_NAMES` and `CONSTANT_NAMES` list the built-in names, for autocompletion.
  `MAX_NESTING` and `MAX_TREE_DEPTH` are the parser limits described above.

### Variable references (for the variables table)

```ts
findReferences(source: string, options?: { physical?: boolean }): Result<VariableReference[]>
collectReferences(ast: Expression): VariableReference[]

interface VariableReference { name: string; hashed: boolean; start: number; end: number }
```

These return every variable an expression mentions, in source order and including duplicates.
They fail only on syntax errors, so a dependency graph and cycle detection can be built before
anything is evaluated. Bare `pi` is a constant and is not reported.

`findMeasures(source)` and `collectMeasures(ast)` return every `distance(...)` and `angle(...)`
call with its quoted face names and the range of each name's text (inside the quotes), so the
faces an expression measures can be listed without evaluating anything.

`isValidVariableName(name)` checks that `name` is an identifier that is not a function or
constant name.

### Formatting

```ts
formatLength(mm: number, format?: LengthFormat): string
```

| Format                                       | Example output | Notes                                       |
| -------------------------------------------- | -------------- | ------------------------------------------- |
| `{ unit: 'mm', decimals?: 2 }` (the default) | `12.50 mm`     | `cm` 3, `m` 4 default decimals              |
| `{ unit: 'in', decimals?: 3 }`               | `1.500"`       |                                             |
| `{ unit: 'ft', decimals?: 4 }`               | `3.2500'`      |                                             |
| `{ unit: 'ft-in', denominator?: 16 }`        | `3' 4-1/2"`    | `1' 0"` for whole feet, `4-1/2"` below 1 ft |
| `{ unit: 'in-fraction', denominator?: 16 }`  | `40-1/2"`      | woodworking style, no feet                  |

- `denominator` is 1, 2, 4, …, 128 (1/16, 1/32 and 1/64 are the usual choices). The value is
  rounded once to the nearest `1/denominator` inch, then split into feet, inches and fraction.
  Inches that round up to 12 therefore carry into the next foot (`11-63/64"` at 1/16 becomes
  `1' 0"`). Fractions are reduced (`8/16` becomes `1/2`).
- Negative values get one leading minus (`-3' 4-1/2"`). Values that round to zero never show
  `-0`.
- A `denominator` that is not one of these values at runtime (for example from untyped
  JavaScript or a stored setting) falls back to 16.
- Output always parses back with `parseLength` to the displayed value.
- `NaN`, `Infinity` and `-Infinity` give the fixed strings `'NaN'`, `'Infinity'` and
  `'-Infinity'`, with no unit, in every format. These do not parse as values. The same applies
  to `formatAngle` and `formatNumber`.

`formatAngle(rad, { unit?: 'deg' | 'rad', decimals? })` gives `45.00°` or `0.7854 rad`.

`formatAngle(rad, { unit: 'pitch', run?: 12, decimals?: 2, slope? })` writes a roof pitch. The
rise gets `decimals` digits with trailing zeros dropped (`6/12`, `7.5/12`, `6.13/12`), never a
hyphenated fraction, since `7-1/2/12` could not parse back. With `slope: true` it writes `6/12`,
otherwise `6:12`. The formatter cannot tell a slope field from an angle field, so pass `slope`
from the same field option as `EvaluateOptions.slope`: then the output parses back to the
displayed value. Angles steeper than 89.9° either way fall back to degrees (`89.95°`, `90.00°`),
since the rise grows without bound near 90° (89.9° is already `6875.49/12`), and a `run`
that is not a positive finite number falls back to 12.

`slopeDisplayUnit(lengthFormatUnit, angleUnit = 'deg')` gives the default display of a slope
field: `'pitch'` in documents whose length format is `ft-in` or `in-fraction`, and the
document's angle unit otherwise (metric roofs are usually given in degrees). The user can switch.

```ts
formatFeed(mmPerMinute: number, format?: FeedFormat): string
formatSpindleSpeed(rpm: number, decimals = 0): string

interface FeedFormat {
  unit?: LengthFormat['unit']; // the document's length format unit, default 'mm'
  decimals?: number; // defaults: mm 0, cm 1, m 3, in 1, ft 2
}
```

`formatFeed` writes the document's length unit per minute: `1000 mm/min`, `39.4 in/min`,
`3.28 ft/min`. Feeds are not written as fractions, so `ft-in` and `in-fraction` give decimal
`in/min`. `formatSpindleSpeed(18000)` gives `18000 rpm`. Both parse back to the displayed value
(with `parseFeed` and `parseSpindleSpeed`), whatever the display unit, and handle `-0` and
non-finite values like `formatLength`.
`formatNumber(value, decimals = 3)` gives a fixed-point number.

### Conversions

`MM_PER_INCH`, `MM_PER_FOOT`, `RAD_PER_DEG`, `SECONDS_PER_MINUTE`, `toMillimetres(value, unit)`,
`fromMillimetres(mm, unit)`, `toRadians(value, unit)`, `fromRadians(rad, unit)`,
`lengthUnitFactor(unit)`, `angleUnitFactor(unit)`.

## Not yet supported

- Display units per kind stored in the document (`units.quantities`): the record shape
  (`QuantityDisplayUnits`) and its resolution are here, the schema is ADR 0017's T9.1e.
- Prefixes other than the listed spellings (`mN`, `MW`, `nF`), and units of capacitance,
  conductance or magnetic flux.
- Comparison and conditional operators.
- Locale decimal commas. The comma separates function arguments.
