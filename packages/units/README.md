# @manufakture/units

Every numeric input in manufakture goes through this package: parsing lengths and angles in
metric and imperial notation, formatting them for display, and evaluating expressions with named
variables and dimensional analysis. It is plain TypeScript with no dependencies.

## Internal units

| Quantity | Internal unit         | Default display |
| -------- | --------------------- | --------------- |
| length   | millimetres (float64) | document unit   |
| angle    | radians               | degrees         |
| number   | plain number, no unit | n/a             |

Every function that returns a length returns millimetres. Every function that returns an angle
returns radians.

## Errors

Nothing throws on bad input. Fallible functions return a `Result<T>`:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: UnitsError };

interface UnitsError {
  code: UnitsErrorCode; // 'syntax' | 'unknown-unit' | 'unknown-variable' | 'unknown-function'
  //                       | 'arity' | 'dimension' | 'domain'
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

| Kind   | Spellings (word units are case-insensitive)                                     |
| ------ | ------------------------------------------------------------------------------- |
| length | `mm`, `cm`, `m`, `in` `inch` `inches` `"` `″`, `ft` `foot` `feet` `'` `′`, `yd` |
| angle  | `deg` `°`, `rad`                                                                |

A unit goes directly after a number, with or without a space: `12mm`, `12 mm`, `1.5"`. It can
also follow a closing parenthesis: `(a + 2)mm`. A unit binds only to the number right before it,
so `2^3mm` is `2^(3mm)`, which is an error, and `x/2in` is `x / (2in)`.

**Bare numbers** (no unit) are dimensionless. Where the context needs a length or an angle, they
are read in the document's display unit (`lengthUnit`, `angleUnit`). This applies:

- to the final result, so `12` in a length field with display unit `in` is 12 inches;
- to a bare operand of `+`, `-`, `min`, `max`, `atan2` or a `round` step whose other operand is
  a length or angle, so `thickness + 3` means 3 display units;
- to the argument of `sin`, `cos` and `tan`, so `sin(30)` is `sin(30°)` when the display angle
  unit is degrees. Write `sin((pi/6)rad)` for radians.

Bare numbers are not converted in `*`, `/` or `^`: `2 * thickness` is twice the thickness.

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

## Expressions

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/') unary)*
unary      := ('-' | '+') unary | power
power      := primary ('^' unary)?           right-associative: 2^3^2 = 2^9
primary    := number-literal | '(' expression ')' unit? | #name | name | name '(' args ')'
```

- Precedence from lowest to highest: `+ -`, then `* /`, then unary minus, then `^`. So
  `-2^2 = -4` and `2^-1 = 0.5`. `×` and the Unicode minus `−` are accepted too.
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
  is millimetres, and `round(29.6deg)` is `30deg` when angles display in degrees. Any other
  value (a number, an area) is rounded as it is, in internal units. With a step they round
  to a multiple of it: `round(width, 1/16")`. `round` rounds halves away from zero.

### Dimensional analysis

Every value has a dimension: exponents of length and angle. `thickness * width` is an area,
`sqrt(area)` is a length, `1 / thickness` is 1/length. Angle is its own dimension, so
`thickness * slope` is length·angle, not a length.

- `+`, `-`, `min`, `max`, `atan2` and a `round` step need operands of the same dimension, apart
  from the bare-number rule above. `thickness + 30deg` is an error.
- `^` needs a dimensionless exponent and scales the base's dimension.
- A unit can be applied only to a dimensionless value: `(2mm)in` is an error.
- The caller states the expected kind (`length`, `angle` or `number`), and the result must match
  it exactly. `thickness * thickness` in a length field is an error.
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
  lengthQuantity,
  angleQuantity,
  numberQuantity,
} from '@manufakture/units';
```

### Evaluating

```ts
evaluate(source: string, options: EvaluateOptions): Result<number>

interface EvaluateOptions {
  expected: 'length' | 'angle' | 'number';
  lengthUnit?: 'mm' | 'cm' | 'm' | 'in' | 'ft'; // bare-number length unit, default 'mm'
  angleUnit?: 'deg' | 'rad'; // bare-number angle unit, default 'deg'
  variables?: (name: string) => Quantity | undefined; // name has no '#'
}

interface Quantity {
  value: number; // internal units
  dimension: { length: number; angle: number };
}
```

The result is in millimetres, radians or a plain number. Build lookup values with
`lengthQuantity(mm)`, `angleQuantity(rad)` and `numberQuantity(n)`:

```ts
const vars = new Map([['thickness', lengthQuantity(19.05)]]);
evaluate('2*#thickness + 1/8"', {
  expected: 'length',
  lengthUnit: 'in',
  variables: (n) => vars.get(n),
});
// { ok: true, value: 41.275 }
```

- `parseLength(source, unit = 'mm')` is `evaluate` with `expected: 'length'` and no variables.
- `parseAngle(source, unit = 'deg')` is the same for angles, and returns radians.
- `evaluateQuantity(source, context)` returns a `Quantity` without an expected kind, and leaves
  bare numbers dimensionless. Use it where the kind is inferred, for example variables of type
  "any".
- `parseExpression(source)` returns the AST (`Expression`). Parsing needs no context, so an AST
  can be cached and evaluated many times with `evaluateParsed(ast, options)` or
  `evaluateParsedQuantity(ast, context)`.
- `FUNCTION_NAMES` and `CONSTANT_NAMES` list the built-in names, for autocompletion.
  `MAX_NESTING` and `MAX_TREE_DEPTH` are the parser limits described above.

### Variable references (for the variables table)

```ts
findReferences(source: string): Result<VariableReference[]>
collectReferences(ast: Expression): VariableReference[]

interface VariableReference { name: string; hashed: boolean; start: number; end: number }
```

These return every variable an expression mentions, in source order and including duplicates.
They fail only on syntax errors, so a dependency graph and cycle detection can be built before
anything is evaluated. Bare `pi` is a constant and is not reported.

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
`formatNumber(value, decimals = 3)` gives a fixed-point number.

### Conversions

`MM_PER_INCH`, `MM_PER_FOOT`, `RAD_PER_DEG`, `toMillimetres(value, unit)`,
`fromMillimetres(mm, unit)`, `toRadians(value, unit)`, `fromRadians(rad, unit)`,
`lengthUnitFactor(unit)`, `angleUnitFactor(unit)`.

## Not yet supported

- **Roof pitch notation** (`6/12` as an angle input) is deferred to M6 (construction). For now,
  write the angle as `atan2(6, 12)` or `atan(6/12)`. When it is added, pitch notation should
  apply only to angle fields, so `6/12` keeps its meaning as division everywhere else.
- Comparison and conditional operators.
- Locale decimal commas. The comma separates function arguments.
