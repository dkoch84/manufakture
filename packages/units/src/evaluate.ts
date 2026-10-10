import type { BinaryNode, CallNode, Expression, PercentNode, PitchNode } from './ast';
import {
  ANGLE,
  DIMENSIONLESS,
  FEED,
  LENGTH,
  PHYSICAL_KINDS,
  SPINDLE_SPEED,
  describeDimension,
  describeKind,
  dimensionOfKind,
  dimensionsEqual,
  dimensionsEqualIgnoringAngle,
  divideDimensions,
  hasPhysicalBase,
  isDimensionless,
  isPhysicalKind,
  isTemperature,
  multiplyDimensions,
  powerDimension,
  type Dimension,
  type PhysicalKind,
  type Quantity,
  type QuantityKind,
} from './dimension';
import { parseExpression, parsedPhysical } from './parser';
import { defaultDisplayUnit } from './quantities';
import { err, ok, type Result } from './result';
import { fromSI, siMagnitude, toSI } from './si';
import { angleUnitFactor, lengthUnitFactor, type AngleUnit, type LengthUnit } from './units';

/** Resolves a variable name (without `#`) to its value, or `undefined` if it does not exist. */
export type VariableLookup = (name: string) => Quantity | undefined;

/** The functions that measure the model: `distance(face, face)` and `angle(face, face)`. */
export type MeasureFunction = 'distance' | 'angle';

/** Names of the functions that measure the model. They are not in `FUNCTION_NAMES`. */
export const MEASURE_FUNCTION_NAMES: readonly MeasureFunction[] = ['distance', 'angle'];

/** A measurement an expression asks for: the function and its two face names. */
export interface MeasureRequest {
  readonly fn: MeasureFunction;
  readonly faces: readonly [string, string];
}

/**
 * Answers a measurement: the value (millimetres for `distance`, radians for `angle`), or why
 * there is none (a face that is not found). `undefined` when the model was not measured.
 */
export type MeasureLookup = (
  request: MeasureRequest,
) => { ok: true; value: number } | { ok: false; message: string } | undefined;

export interface EvaluationContext {
  /**
   * Unit that bare numbers are read in when a length is needed, and per minute when a feed is
   * needed. Default `'mm'`.
   */
  readonly lengthUnit?: LengthUnit;
  /** Unit that bare numbers are read in when an angle is needed. Default `'deg'`. */
  readonly angleUnit?: AngleUnit;
  /** Variable resolution. Without it every variable reference is an `unknown-variable` error. */
  readonly variables?: VariableLookup;
  /**
   * Measurements of the model, for `distance(...)` and `angle(...)`. Without it, or when it has
   * no answer, those calls are a `measure` error.
   */
  readonly measure?: MeasureLookup;
  /**
   * The physical-field rules (README, "Physical fields") for any expected kind, or for
   * `evaluateQuantity`: no bare numbers in display units, compound units after any unit, `rpm`
   * as an angular speed. Implied when the expected kind is a physical kind. Default `false`.
   */
  readonly physical?: boolean;
}

export interface EvaluateOptions extends EvaluationContext {
  /** What the input must evaluate to. */
  readonly expected: QuantityKind;
  /**
   * A slope field (a roof or ramp pitch): with `expected: 'angle'`, a division of two bare
   * numbers is a pitch (`6/12`) when it is the whole input or an operand of `+` or `-`, a percent
   * is a slope (`25%`), and a bare number in those places is an error because it could be degrees
   * or a rise. Ignored for other kinds. Default `false`.
   */
  readonly slope?: boolean;
}

interface Environment {
  readonly lengthFactor: number;
  readonly angleFactor: number;
  readonly angleUnit: AngleUnit;
  readonly variables: VariableLookup;
  readonly measure: MeasureLookup;
  /** Whether percent slopes are allowed (slope fields only). */
  readonly slope: boolean;
  /** A physical field: bare numbers never take a display unit. */
  readonly physical: boolean;
}

function environment(context: EvaluationContext, slope = false, physical = false): Environment {
  return {
    lengthFactor: lengthUnitFactor(context.lengthUnit ?? 'mm'),
    angleFactor: angleUnitFactor(context.angleUnit ?? 'deg'),
    angleUnit: context.angleUnit ?? 'deg',
    variables: context.variables ?? (() => undefined),
    measure: context.measure ?? (() => undefined),
    slope,
    physical,
  };
}

// --- temperatures and bare numbers in physical fields ---------------------------------------------

/**
 * How a temperature value is affine (README, "Temperature"). `absolute`: a temperature, `value` in
 * kelvin. `delta`: a difference. `either`: a `degC` or `degF` literal (or arithmetic on one) that
 * is a difference of `value` kelvin or the absolute temperature `value + offset`, whichever its
 * use needs. A value without one is a plain kelvin value, the same number either way.
 */
type Temp =
  | { readonly kind: 'absolute' }
  | { readonly kind: 'delta' }
  | { readonly kind: 'either'; readonly offset: number };

/**
 * An intermediate value: a quantity, how it is affine if it is a temperature, and its value in SI
 * computed alongside, so that a physical field returns `1 kgf` as exactly 9.80665 rather than
 * converting the internal value back (`si` is absent where it is not tracked: functions and
 * temperatures, which then convert `value`).
 */
interface Value extends Quantity {
  readonly temp?: Temp;
  readonly si?: number;
}

/** A plain value with its SI value, when known. */
function plain(value: number, dimension: Dimension, si: number | undefined): Value {
  return si === undefined ? { value, dimension } : { value, dimension, si };
}

const ABSOLUTE: Temp = { kind: 'absolute' };
const DELTA: Temp = { kind: 'delta' };

function withTemp(value: number, dimension: Dimension, temp: Temp | undefined): Value {
  if (temp === undefined || (temp.kind === 'either' && temp.offset === 0)) {
    return { value, dimension };
  }
  return { value, dimension, temp };
}

function isAbsolute(v: Value): boolean {
  return v.temp?.kind === 'absolute';
}

function isDelta(v: Value): boolean {
  return v.temp?.kind === 'delta';
}

/** The kelvin offset of an `either` value, 0 for anything else. */
function offsetOf(v: Value): number {
  return v.temp?.kind === 'either' ? v.temp.offset : 0;
}

/** `either` or plain: an `either` value with no offset is plain. */
function either(value: number, dimension: Dimension, offset: number): Value {
  return withTemp(value, dimension, { kind: 'either', offset });
}

/**
 * A value as a `Quantity`: an `either` temperature resolves to its absolute reading, and a
 * difference is marked `absolute: false`.
 */
function toQuantity(v: Value): Quantity {
  if (v.temp?.kind === 'absolute')
    return { value: v.value, dimension: v.dimension, absolute: true };
  if (v.temp?.kind === 'delta') return { value: v.value, dimension: v.dimension, absolute: false };
  if (v.temp?.kind === 'either') {
    return { value: v.value + v.temp.offset, dimension: v.dimension, absolute: true };
  }
  return { value: v.value, dimension: v.dimension };
}

/** `a + b` or `a - b` of two temperatures, one of them affine (README, "Temperature"). */
function temperatureSum(node: BinaryNode, a: Value, b: Value): Result<Value> {
  const d = a.dimension;
  if (node.op === '+') {
    if (isAbsolute(a) && isAbsolute(b)) {
      return err(
        'dimension',
        'Cannot add two absolute temperatures: add a temperature difference, or subtract them',
        node.start,
        node.end,
      );
    }
    const sum = a.value + b.value;
    if (isAbsolute(a) || isAbsolute(b)) return ok(withTemp(sum, d, ABSOLUTE));
    if (isDelta(a) || isDelta(b)) {
      const offset = isDelta(a) ? offsetOf(b) : offsetOf(a);
      return ok(offset === 0 ? withTemp(sum, d, DELTA) : either(sum, d, offset));
    }
    // Two `degC`/`degF` literals cannot both be absolute (ADR 0017: two absolute temperatures
    // added is an error), so their sum is a difference: `20degC + 5degC` is 25 K.
    if (offsetOf(a) !== 0 && offsetOf(b) !== 0) return ok(withTemp(sum, d, DELTA));
    return ok(either(sum, d, offsetOf(a) !== 0 ? offsetOf(a) : offsetOf(b)));
  }
  if (isAbsolute(a) && isAbsolute(b)) return ok(withTemp(a.value - b.value, d, DELTA));
  if (isAbsolute(a)) {
    // A difference, a plain kelvin value or a `degC` literal taken from an absolute temperature:
    // absolute in a temperature field; a literal with an offset could also be the other absolute.
    if (isDelta(b) || offsetOf(b) === 0) return ok(withTemp(a.value - b.value, d, ABSOLUTE));
    return ok(either(a.value - b.value - offsetOf(b), d, offsetOf(b)));
  }
  if (isAbsolute(b)) {
    if (isDelta(a)) {
      return err(
        'dimension',
        'Cannot subtract an absolute temperature from a temperature difference',
        node.start,
        node.end,
      );
    }
    return ok(withTemp(a.value + offsetOf(a) - b.value, d, DELTA));
  }
  if (isDelta(a)) return ok(withTemp(a.value - b.value, d, DELTA));
  if (isDelta(b) || offsetOf(b) === 0) return ok(either(a.value - b.value, d, offsetOf(a)));
  // Two `degC`/`degF` literals are two absolute temperatures, so the result is their difference
  // (`80degC - 20degC` is 60 K): a temperature field refuses it.
  if (offsetOf(a) !== 0) {
    return ok(withTemp(a.value + offsetOf(a) - b.value - offsetOf(b), d, DELTA));
  }
  return ok(either(a.value - b.value - offsetOf(b), d, offsetOf(b)));
}

/** The error for an absolute temperature used where only a difference can be. */
function absoluteMisuse(verb: string, span: Span): Result<never> {
  return err(
    'dimension',
    `Cannot ${verb} an absolute temperature: only a temperature difference can be (subtract two temperatures, or write it in K)`,
    span.start,
    span.end,
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `30°`, `5 N`: a number and a unit as the user would type them. */
function withUnit(n: string, unit: string): string {
  return unit === '°' ? `${n}°` : `${n} ${unit}`;
}

/** The physical kind a dimension is, for messages: exact first, then ignoring angle. */
function kindOfDimension(d: Dimension): PhysicalKind | undefined {
  const candidates = PHYSICAL_KINDS.filter((k) => k !== 'temperatureDelta');
  return (
    candidates.find((k) => dimensionsEqual(dimensionOfKind(k), d)) ??
    candidates.find((k) => dimensionsEqualIgnoringAngle(dimensionOfKind(k), d))
  );
}

/**
 * "A force needs a unit: write 200 N or 200 lbf", for a bare `value` where a quantity of `kind`
 * (or, without one, of dimension `d`) is needed.
 */
function needsUnit(value: number, kind: QuantityKind | undefined, d: Dimension): string {
  const n = String(Number(value.toPrecision(6)));
  const physical = kind !== undefined && isPhysicalKind(kind) ? kind : kindOfDimension(d);
  let what: string;
  let units: string[];
  if (physical !== undefined) {
    what = describeKind(physical);
    units = [defaultDisplayUnit(physical, 'si'), defaultDisplayUnit(physical, 'us')];
  } else if (dimensionsEqual(d, LENGTH)) {
    what = 'a length';
    units = ['mm', 'in'];
  } else if (dimensionsEqual(d, ANGLE)) {
    what = 'an angle';
    units = ['°', 'rad'];
  } else {
    return `Write a unit after ${n}: a bare number here has no unit`;
  }
  const choices = [...new Set(units)].map((u) => withUnit(n, u)).join(' or ');
  return `${capitalise(what)} needs a unit: write ${choices}`;
}

/**
 * In a physical field (or next to a physical quantity), a bare operand where a quantity is needed
 * is an error at that operand, with the units to write. `undefined` when that is not the case.
 */
function bareOperand(
  bare: Quantity,
  other: Quantity,
  span: Span,
  env: Environment,
): Result<never> | undefined {
  if (!isDimensionless(bare.dimension) || isDimensionless(other.dimension)) return undefined;
  if (!env.physical && !hasPhysicalBase(other.dimension)) return undefined;
  return err('dimension', needsUnit(bare.value, undefined, other.dimension), span.start, span.end);
}

/**
 * Display-unit factor that a bare number is scaled by when it stands for a value of dimension
 * `d`, or `undefined` if bare numbers do not stand for such values. A feed is display length
 * units per minute and a spindle speed rpm, which are already the internal time units.
 */
function displayFactor(d: Dimension, env: Environment): number | undefined {
  if (dimensionsEqual(d, LENGTH)) return env.lengthFactor;
  if (dimensionsEqual(d, ANGLE)) return env.angleFactor;
  if (dimensionsEqual(d, FEED)) return env.lengthFactor;
  if (dimensionsEqual(d, SPINDLE_SPEED)) return 1;
  return undefined;
}

/**
 * Reads a dimensionless value as a length, angle, feed or spindle speed in the display unit, so
 * `thickness + 3` and `sin(30)` mean 3 display units and 30 display-angle units. Other values are
 * returned unchanged.
 */
function promote(q: Quantity, target: Dimension, env: Environment): Quantity {
  if (env.physical || !isDimensionless(q.dimension)) return q;
  const factor = displayFactor(target, env);
  return factor === undefined ? q : { value: q.value * factor, dimension: target };
}

/** Brings two operands to a common dimension, or returns `undefined` if they are incompatible. */
function unify(a: Quantity, b: Quantity, env: Environment): [Quantity, Quantity] | undefined {
  const pa = promote(a, b.dimension, env);
  const pb = promote(b, a.dimension, env);
  return dimensionsEqual(pa.dimension, pb.dimension) ? [pa, pb] : undefined;
}

function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

type Rounder = (x: number) => number;

interface FunctionSpec {
  readonly minArgs: number;
  readonly maxArgs: number;
  apply(args: readonly Quantity[], node: CallNode, env: Environment): Result<Quantity>;
}

function argSpan(node: CallNode, index: number): [number, number] {
  const arg = node.args[index];
  return arg === undefined ? [node.start, node.end] : [arg.start, arg.end];
}

function spanOf([start, end]: [number, number]): Span {
  return { start, end };
}

function arg(args: readonly Quantity[], index: number): Quantity {
  return args[index] as Quantity;
}

/** Trig input: an angle, or a bare number read in the display angle unit. */
function angleArgument(node: CallNode, q: Quantity, env: Environment): Result<number> {
  if (env.physical && isDimensionless(q.dimension)) {
    return err('dimension', needsUnit(q.value, 'angle', ANGLE), ...argSpan(node, 0));
  }
  const angle = promote(q, ANGLE, env);
  if (!dimensionsEqual(angle.dimension, ANGLE)) {
    return err(
      'dimension',
      `${node.name}() expects an angle, got ${describeDimension(q.dimension)}`,
      ...argSpan(node, 0),
    );
  }
  return ok(angle.value);
}

function trig(fn: (x: number) => number): FunctionSpec {
  return {
    minArgs: 1,
    maxArgs: 1,
    apply(args, node, env) {
      const angle = angleArgument(node, arg(args, 0), env);
      if (!angle.ok) return angle;
      return ok({ value: fn(angle.value), dimension: DIMENSIONLESS });
    },
  };
}

function inverseTrig(fn: (x: number) => number, domain?: [number, number]): FunctionSpec {
  return {
    minArgs: 1,
    maxArgs: 1,
    apply(args, node) {
      const x = arg(args, 0);
      if (!isDimensionless(x.dimension)) {
        return err(
          'dimension',
          `${node.name}() expects a number, got ${describeDimension(x.dimension)}`,
          ...argSpan(node, 0),
        );
      }
      if (domain !== undefined && (x.value < domain[0] || x.value > domain[1])) {
        return err(
          'domain',
          `${node.name}() is only defined between ${domain[0]} and ${domain[1]}`,
          ...argSpan(node, 0),
        );
      }
      return ok({ value: fn(x.value), dimension: ANGLE });
    },
  };
}

function extremum(pick: (a: number, b: number) => number): FunctionSpec {
  return {
    minArgs: 1,
    maxArgs: Infinity,
    apply(args, node, env) {
      let acc = arg(args, 0);
      for (let i = 1; i < args.length; i++) {
        const pair = unify(acc, arg(args, i), env);
        if (pair === undefined) {
          const bare =
            bareOperand(arg(args, i), acc, spanOf(argSpan(node, i)), env) ??
            bareOperand(acc, arg(args, i), spanOf(argSpan(node, 0)), env);
          if (bare !== undefined) return bare;
          return err(
            'dimension',
            `${node.name}() arguments must have the same dimension: got ${describeDimension(acc.dimension)} and ${describeDimension(arg(args, i).dimension)}`,
            ...argSpan(node, i),
          );
        }
        acc = { value: pick(pair[0].value, pair[1].value), dimension: pair[0].dimension };
      }
      return ok(acc);
    },
  };
}

/**
 * `round(x)` rounds a length or angle in the display unit; `round(x, step)` rounds to a multiple
 * of `step` (e.g. `round(width, 1/16")`).
 */
function rounding(rounder: Rounder): FunctionSpec {
  return {
    minArgs: 1,
    maxArgs: 2,
    apply(args, node, env) {
      const x = arg(args, 0);
      if (args.length === 1) {
        if (env.physical || hasPhysicalBase(x.dimension)) {
          // No display unit for a physical value: round it in SI.
          const si = rounder(toSI(x.value, x.dimension));
          return ok({ value: fromSI(si, x.dimension), dimension: x.dimension });
        }
        const scale = displayFactor(x.dimension, env) ?? 1;
        return ok({ value: rounder(x.value / scale) * scale, dimension: x.dimension });
      }
      const pair = unify(x, arg(args, 1), env);
      if (pair === undefined) {
        const bare =
          bareOperand(arg(args, 1), x, spanOf(argSpan(node, 1)), env) ??
          bareOperand(x, arg(args, 1), spanOf(argSpan(node, 0)), env);
        if (bare !== undefined) return bare;
        return err(
          'dimension',
          `${node.name}() step must have the same dimension as the value: got ${describeDimension(x.dimension)} and ${describeDimension(arg(args, 1).dimension)}`,
          ...argSpan(node, 1),
        );
      }
      const [value, step] = pair;
      if (step.value === 0) {
        return err('domain', `${node.name}() step must not be zero`, ...argSpan(node, 1));
      }
      return ok({
        value: rounder(value.value / step.value) * step.value,
        dimension: value.dimension,
      });
    },
  };
}

const FUNCTIONS: ReadonlyMap<string, FunctionSpec> = new Map<string, FunctionSpec>([
  ['min', extremum(Math.min)],
  ['max', extremum(Math.max)],
  [
    'abs',
    {
      minArgs: 1,
      maxArgs: 1,
      apply: (args) =>
        ok({ value: Math.abs(arg(args, 0).value), dimension: arg(args, 0).dimension }),
    },
  ],
  [
    'sqrt',
    {
      minArgs: 1,
      maxArgs: 1,
      apply(args, node) {
        const x = arg(args, 0);
        if (x.value < 0) {
          return err('domain', 'sqrt() of a negative value', ...argSpan(node, 0));
        }
        return ok({ value: Math.sqrt(x.value), dimension: powerDimension(x.dimension, 0.5) });
      },
    },
  ],
  ['sin', trig(Math.sin)],
  ['cos', trig(Math.cos)],
  ['tan', trig(Math.tan)],
  ['asin', inverseTrig(Math.asin, [-1, 1])],
  ['acos', inverseTrig(Math.acos, [-1, 1])],
  ['atan', inverseTrig(Math.atan)],
  [
    'atan2',
    {
      minArgs: 2,
      maxArgs: 2,
      apply(args, node, env) {
        const pair = unify(arg(args, 0), arg(args, 1), env);
        if (pair === undefined) {
          const bare =
            bareOperand(arg(args, 1), arg(args, 0), spanOf(argSpan(node, 1)), env) ??
            bareOperand(arg(args, 0), arg(args, 1), spanOf(argSpan(node, 0)), env);
          if (bare !== undefined) return bare;
          return err(
            'dimension',
            `atan2() arguments must have the same dimension: got ${describeDimension(arg(args, 0).dimension)} and ${describeDimension(arg(args, 1).dimension)}`,
            ...argSpan(node, 1),
          );
        }
        return ok({ value: Math.atan2(pair[0].value, pair[1].value), dimension: ANGLE });
      },
    },
  ],
  ['round', rounding(roundHalfAwayFromZero)],
  ['floor', rounding(Math.floor)],
  ['ceil', rounding(Math.ceil)],
]);

/** Names of the built-in functions, e.g. for autocompletion. */
export const FUNCTION_NAMES: readonly string[] = [...FUNCTIONS.keys()];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * `distance("a", "b")` or `angle("a", "b")`: two quoted face names, answered by the context's
 * measurements. A distance is a length, an angle an angle.
 */
function evaluateMeasure(node: CallNode, fn: MeasureFunction, env: Environment): Result<Quantity> {
  if (node.args.length !== 2) {
    return err('arity', `${fn}() takes 2 arguments, got ${node.args.length}`, node.start, node.end);
  }
  const faces: string[] = [];
  for (const a of node.args) {
    if (a.type !== 'string') {
      return err(
        'syntax',
        `${fn}() takes two face names in double quotes, like ${fn}("extrude#1:cap:start", "extrude#1:cap:end")`,
        a.start,
        a.end,
      );
    }
    if (a.value.trim() === '') return err('syntax', 'Enter a face name', a.start, a.end);
    faces.push(a.value);
  }
  const answer = env.measure({ fn, faces: [faces[0]!, faces[1]!] });
  if (answer === undefined) {
    return err(
      'not-measured',
      `${fn}() measures the model, and the model has not been measured here`,
      node.start,
      node.end,
    );
  }
  if (!answer.ok) return err('measure', answer.message, node.start, node.end);
  return ok({ value: answer.value, dimension: fn === 'distance' ? LENGTH : ANGLE });
}

function evaluateCall(node: CallNode, env: Environment): Result<Quantity> {
  if ((MEASURE_FUNCTION_NAMES as readonly string[]).includes(node.name)) {
    return evaluateMeasure(node, node.name as MeasureFunction, env);
  }
  const spec = FUNCTIONS.get(node.name);
  if (spec === undefined) {
    return err('unknown-function', `Unknown function '${node.name}'`, node.start, node.nameEnd);
  }
  const count = node.args.length;
  if (count < spec.minArgs || count > spec.maxArgs) {
    const expected =
      spec.maxArgs === Infinity
        ? `at least ${plural(spec.minArgs, 'argument')}`
        : spec.minArgs === spec.maxArgs
          ? plural(spec.minArgs, 'argument')
          : `${spec.minArgs} to ${plural(spec.maxArgs, 'argument')}`;
    return err('arity', `${node.name}() takes ${expected}, got ${count}`, node.start, node.end);
  }
  const args: Value[] = [];
  for (const a of node.args) {
    const value = evaluateNode(a, env);
    if (!value.ok) return value;
    args.push(value.value);
  }
  if (!args.some((a) => a.temp !== undefined)) return spec.apply(args, node, env);
  return temperatureCall(node, spec, args, env);
}

const EXTREMA: ReadonlySet<string> = new Set(['min', 'max']);
const ROUNDING: ReadonlySet<string> = new Set(['round', 'floor', 'ceil']);

/**
 * A function of temperatures (README, "Temperature"): a `degC` or `degF` value is absolute, except
 * as a rounding step, which is a difference. `min` and `max` take absolute temperatures or
 * differences but not both, a rounding keeps its value absolute, and any other function refuses
 * an absolute temperature.
 */
function temperatureCall(
  node: CallNode,
  spec: FunctionSpec,
  raw: readonly Value[],
  env: Environment,
): Result<Value> {
  const args = raw.map((a, i): Value => {
    if (a.temp?.kind !== 'either') return a;
    if (ROUNDING.has(node.name) && i === 1) return withTemp(a.value, a.dimension, DELTA);
    return withTemp(a.value + a.temp.offset, a.dimension, ABSOLUTE);
  });
  const absolute = args.findIndex(isAbsolute);
  if (absolute < 0) {
    const result = spec.apply(args, node, env);
    if (!result.ok || !isTemperature(result.value.dimension)) return result;
    return ok(withTemp(result.value.value, result.value.dimension, DELTA));
  }
  if (EXTREMA.has(node.name)) {
    const other = args.findIndex((a) => !isAbsolute(a) && isTemperature(a.dimension));
    if (other >= 0) {
      return err(
        'dimension',
        `${node.name}() cannot compare an absolute temperature with a temperature difference`,
        ...argSpan(node, other),
      );
    }
  } else if (!ROUNDING.has(node.name) || absolute !== 0) {
    if (ROUNDING.has(node.name)) {
      return err(
        'dimension',
        `${node.name}() step must be a temperature difference, not an absolute temperature`,
        ...argSpan(node, absolute),
      );
    }
    return err(
      'dimension',
      `${node.name}() cannot take an absolute temperature`,
      ...argSpan(node, absolute),
    );
  }
  const result = spec.apply(args, node, env);
  if (!result.ok) return result;
  return ok(withTemp(result.value.value, result.value.dimension, ABSOLUTE));
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The angle of a pitch: `atan(rise / run)`. Rise and run are lengths or bare numbers; a bare one
 * next to a length is read in the display length unit. The run must be positive.
 */
function pitchAngle(
  rise: Quantity,
  run: Quantity,
  node: Span,
  runSpan: Span,
  env: Environment,
): Result<Quantity> {
  const pair = unify(rise, run, env);
  if (pair === undefined) {
    return err(
      'dimension',
      `A pitch's rise and run must have the same dimension: got ${describeDimension(rise.dimension)} and ${describeDimension(run.dimension)}`,
      node.start,
      node.end,
    );
  }
  const [r, h] = pair;
  if (!isDimensionless(r.dimension) && !dimensionsEqual(r.dimension, LENGTH)) {
    return err(
      'dimension',
      `A pitch's rise and run must be lengths or numbers, got ${describeDimension(r.dimension)}`,
      node.start,
      node.end,
    );
  }
  if (!(h.value > 0)) {
    return err('domain', "A pitch's run must be greater than zero", runSpan.start, runSpan.end);
  }
  return ok({ value: Math.atan2(r.value, h.value), dimension: ANGLE });
}

function evaluatePitch(node: PitchNode, env: Environment): Result<Quantity> {
  const rise = evaluateNode(node.rise, env);
  if (!rise.ok) return rise;
  const run = evaluateNode(node.run, env);
  if (!run.ok) return run;
  return pitchAngle(rise.value, run.value, node, node.run, env);
}

function evaluatePercent(node: PercentNode, env: Environment): Result<Quantity> {
  if (!env.slope) {
    return err(
      'syntax',
      'A percent is a slope, and is allowed only in a slope field',
      node.start,
      node.end,
    );
  }
  const pitch = bareDivision(node.operand, env);
  if (pitch !== undefined) {
    if (!pitch.ok) return pitch;
    return err(
      'syntax',
      'In a slope field rise/run is already a pitch: write it without % (6/12), or as a percent (50%)',
      node.start,
      node.end,
    );
  }
  const operand = evaluateNode(node.operand, env);
  if (!operand.ok) return operand;
  if (!isDimensionless(operand.value.dimension)) {
    return err(
      'dimension',
      `A percent slope needs a number, got ${describeDimension(operand.value.dimension)}`,
      node.start,
      node.end,
    );
  }
  return ok({ value: Math.atan(operand.value.value / 100), dimension: ANGLE });
}

/** `a + b` or `a - b` for the binary node `node`, bringing bare operands to a common dimension. */
function addOrSubtract(node: BinaryNode, a: Value, b: Value, env: Environment): Result<Value> {
  if (
    (a.temp !== undefined || b.temp !== undefined) &&
    isTemperature(a.dimension) &&
    isTemperature(b.dimension)
  ) {
    return temperatureSum(node, a, b);
  }
  const pair = unify(a, b, env);
  if (pair === undefined) {
    const bare = bareOperand(b, a, node.right, env) ?? bareOperand(a, b, node.left, env);
    if (bare !== undefined) return bare;
    const verb = node.op === '+' ? 'add' : 'subtract';
    const joiner = node.op === '+' ? 'and' : 'from';
    const [first, second] = node.op === '+' ? [a, b] : [b, a];
    return err(
      'dimension',
      `Cannot ${verb} ${describeDimension(first.dimension)} ${joiner} ${describeDimension(second.dimension)}`,
      node.start,
      node.end,
    );
  }
  const [x, y] = pair;
  const value = node.op === '+' ? x.value + y.value : x.value - y.value;
  // The SI value follows only when neither operand was promoted to a display unit.
  const tracked = x === a && y === b && a.si !== undefined && b.si !== undefined;
  const si = tracked ? (node.op === '+' ? a.si! + b.si! : a.si! - b.si!) : undefined;
  return ok(plain(value, x.dimension, si));
}

/**
 * Evaluates one node and rejects a non-finite result right there, so an overflow is reported
 * where it happens rather than disappearing later (`1/1e300^2` would otherwise give 0).
 */
function evaluateNode(node: Expression, env: Environment): Result<Value> {
  const result = evaluateUnchecked(node, env);
  if (result.ok && !Number.isFinite(result.value.value)) {
    return err('domain', 'Result is not a finite number', node.start, node.end);
  }
  return result;
}

function evaluateUnchecked(node: Expression, env: Environment): Result<Value> {
  switch (node.type) {
    case 'string':
      return err(
        'syntax',
        'A quoted face name is only an argument of distance() or angle()',
        node.start,
        node.end,
      );
    case 'number':
      return ok({ value: node.value, dimension: DIMENSIONLESS, si: node.value });
    case 'measure':
      if (node.offset !== undefined) return ok(either(node.value, node.dimension, node.offset));
      return ok(plain(node.value, node.dimension, node.si ?? toSI(node.value, node.dimension)));
    case 'variable': {
      const value = env.variables(node.name);
      if (value === undefined) {
        const shown = node.hashed ? `#${node.name}` : node.name;
        return err('unknown-variable', `Unknown variable '${shown}'`, node.start, node.end);
      }
      if (value.absolute !== undefined && isTemperature(value.dimension)) {
        return ok(withTemp(value.value, value.dimension, value.absolute ? ABSOLUTE : DELTA));
      }
      return ok(plain(value.value, value.dimension, toSI(value.value, value.dimension)));
    }
    case 'unit': {
      const operand = evaluateNode(node.operand, env);
      if (!operand.ok) return operand;
      if (!isDimensionless(operand.value.dimension)) {
        return err(
          'dimension',
          `Cannot apply unit '${node.unit.symbol}' to ${describeDimension(operand.value.dimension)}`,
          node.start,
          node.end,
        );
      }
      const value = operand.value.value * node.unit.factor;
      if (node.unit.offset !== undefined) {
        return ok(either(value, node.unit.dimension, node.unit.offset));
      }
      const si = siMagnitude(operand.value.value, node.unit.si);
      return ok({ value, dimension: node.unit.dimension, si });
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, env);
      if (!operand.ok || node.op === '+') return operand;
      const v = operand.value;
      if (isAbsolute(v)) return absoluteMisuse('negate', node);
      if (v.temp !== undefined) return ok(withTemp(-v.value, v.dimension, v.temp));
      return ok(plain(-v.value, v.dimension, v.si === undefined ? undefined : -v.si));
    }
    case 'call':
      return evaluateCall(node, env);
    case 'pitch':
      return evaluatePitch(node, env);
    case 'percent':
      return evaluatePercent(node, env);
    case 'binary': {
      const left = evaluateNode(node.left, env);
      if (!left.ok) return left;
      const right = evaluateNode(node.right, env);
      if (!right.ok) return right;
      const a = left.value;
      const b = right.value;
      if (node.op === '+' || node.op === '-') return addOrSubtract(node, a, b, env);
      if (isAbsolute(a) || isAbsolute(b)) {
        const verb = node.op === '*' ? 'multiply' : node.op === '/' ? 'divide' : 'raise';
        return absoluteMisuse(verb, isAbsolute(a) ? node.left : node.right);
      }
      const result = arithmetic(node, a, b);
      // A difference stays a difference through arithmetic (`2 * 5degC` is 10 K).
      if (!result.ok || (a.temp === undefined && b.temp === undefined)) return result;
      if (!isTemperature(result.value.dimension)) return result;
      return ok(withTemp(result.value.value, result.value.dimension, DELTA));
    }
  }
}

/** `*`, `/` and `^` of two evaluated operands (`+` and `-` are `addOrSubtract`). */
function arithmetic(node: BinaryNode, a: Value, b: Value): Result<Value> {
  const both = a.si !== undefined && b.si !== undefined;
  switch (node.op) {
    case '+':
    case '-':
      return err('syntax', 'Unexpected operator', node.start, node.end);
    case '*':
      return ok(
        plain(
          a.value * b.value,
          multiplyDimensions(a.dimension, b.dimension),
          both ? a.si! * b.si! : undefined,
        ),
      );
    case '/':
      if (b.value === 0) {
        return err('domain', 'Division by zero', node.right.start, node.right.end);
      }
      return ok(
        plain(
          a.value / b.value,
          divideDimensions(a.dimension, b.dimension),
          both && b.si !== 0 ? a.si! / b.si! : undefined,
        ),
      );
    case '^': {
      if (!isDimensionless(b.dimension)) {
        return err(
          'dimension',
          `An exponent must be a number, got ${describeDimension(b.dimension)}`,
          node.right.start,
          node.right.end,
        );
      }
      const value = Math.pow(a.value, b.value);
      if (Number.isNaN(value)) {
        return err('domain', 'Fractional power of a negative value', node.start, node.end);
      }
      const si = a.si === undefined ? undefined : Math.pow(a.si, b.value);
      return ok(plain(value, powerDimension(a.dimension, b.value), si));
    }
  }
}

/** Results never carry `-0`, so `formatX` and equality checks need not care. */
function withoutNegativeZero(q: Quantity): Quantity {
  return q.value === 0 ? { ...q, value: 0 } : q;
}

/**
 * If `node` is a division of two bare numbers (`6/12`, `#ratio*24/12`), the pitch it stands for
 * in a slope field; otherwise `undefined`. An error evaluating either side is returned as is.
 */
function bareDivision(node: Expression, env: Environment): Result<Quantity> | undefined {
  if (node.type !== 'binary' || node.op !== '/') return undefined;
  const rise = evaluateNode(node.left, env);
  if (!rise.ok) return rise;
  const run = evaluateNode(node.right, env);
  if (!run.ok) return run;
  if (!isDimensionless(rise.value.dimension) || !isDimensionless(run.value.dimension)) {
    return undefined;
  }
  return pitchAngle(rise.value, run.value, node, node.right, env);
}

/**
 * A slope field's expression, or an operand of `+`, `-` or a sign within it. A division of two
 * bare numbers is a pitch (`6/12`), anything else evaluates as usual, and a result without a
 * unit is an error at the operand that produced it: `30` in `30 + 2°` could be degrees or a rise.
 */
function evaluateSlope(node: Expression, env: Environment): Result<Quantity> {
  if (node.type === 'binary' && (node.op === '+' || node.op === '-')) {
    const left = evaluateSlope(node.left, env);
    if (!left.ok) return left;
    const right = evaluateSlope(node.right, env);
    if (!right.ok) return right;
    const result = addOrSubtract(node, left.value, right.value, env);
    if (result.ok && !Number.isFinite(result.value.value)) {
      return err('domain', 'Result is not a finite number', node.start, node.end);
    }
    return result;
  }
  if (node.type === 'unary') {
    const operand = evaluateSlope(node.operand, env);
    if (!operand.ok || node.op === '+') return operand;
    return ok({ value: -operand.value.value, dimension: operand.value.dimension });
  }
  const pitch = bareDivision(node, env);
  if (pitch !== undefined) return pitch;
  const result = evaluateNode(node, env);
  if (!result.ok || !isDimensionless(result.value.dimension)) return result;
  // A division reaching here had operands with dimensions (`#rise/#run`).
  if (node.type === 'binary' && node.op === '/') {
    return err(
      'dimension',
      'A ratio of lengths is not a slope: write it as rise:run',
      node.start,
      node.end,
    );
  }
  const n = String(Number(result.value.value.toPrecision(6)));
  const unit = env.angleUnit === 'rad' ? ' rad' : '°';
  return err('dimension', `Ambiguous: write ${n}${unit} or ${n}/12`, node.start, node.end);
}

function containsPitch(node: Expression): boolean {
  switch (node.type) {
    case 'pitch':
      return true;
    case 'string':
    case 'number':
    case 'measure':
    case 'variable':
      return false;
    case 'unit':
    case 'unary':
    case 'percent':
      return containsPitch(node.operand);
    case 'binary':
      return containsPitch(node.left) || containsPitch(node.right);
    case 'call':
      return node.args.some(containsPitch);
  }
}

/**
 * An AST parsed for the other mode reads differently (a compound unit, `rpm`), so evaluating it
 * would silently give another value: refuse instead.
 */
function checkMode(expression: Expression, physical: boolean): Result<never> | undefined {
  const parsed = parsedPhysical(expression);
  if (parsed === undefined || parsed === physical) return undefined;
  return err(
    'syntax',
    physical
      ? 'This expression was parsed for a field without a physical kind, where it reads differently: parse it with { physical: true }'
      : 'This expression was parsed for a physical field, where it reads differently: parse it without { physical: true }',
    expression.start,
    expression.end,
  );
}

/** Evaluates an already-parsed expression without imposing an expected kind. */
export function evaluateParsedQuantity(
  expression: Expression,
  context: EvaluationContext = {},
): Result<Quantity> {
  const physical = context.physical === true;
  const wrongMode = checkMode(expression, physical);
  if (wrongMode !== undefined) return wrongMode;
  const result = evaluateNode(expression, environment(context, false, physical));
  return result.ok ? ok(withoutNegativeZero(toQuantity(result.value))) : result;
}

/** The value of a physical field: checked against the kind, then in SI. */
function physicalResult(expression: Expression, v: Value, kind: PhysicalKind): Result<number> {
  const span = [expression.start, expression.end] as const;
  const target = dimensionOfKind(kind);
  if (isDimensionless(v.dimension)) {
    return err('dimension', needsUnit(v.value, kind, target), ...span);
  }
  if (!dimensionsEqualIgnoringAngle(v.dimension, target)) {
    return err(
      'dimension',
      `Expected ${describeKind(kind)} but got ${describeDimension(v.dimension)}`,
      ...span,
    );
  }
  if (kind === 'frequency' && Math.abs(v.dimension.angle) > 1e-9) {
    return err(
      'dimension',
      'An angular speed is not a frequency: write the frequency in Hz, or divide by (2*pi)rad',
      ...span,
    );
  }
  let value = v.value;
  if (kind === 'temperature') {
    if (isDelta(v)) {
      return err(
        'dimension',
        'Expected a temperature but got a temperature difference: add it to a temperature',
        ...span,
      );
    }
    value += offsetOf(v);
  } else if (kind === 'temperatureDelta' && isAbsolute(v)) {
    return err(
      'dimension',
      'Expected a temperature difference but got an absolute temperature: subtract another temperature from it',
      ...span,
    );
  }
  const si = v.temp === undefined && v.si !== undefined ? v.si : toSI(value, target);
  if (!Number.isFinite(si)) return err('domain', 'Result is not a finite number', ...span);
  return ok(si === 0 ? 0 : si);
}

/**
 * Evaluates an already-parsed expression and checks it against `options.expected`. Returns the
 * value in internal units (millimetres, radians, mm/min, rpm, or a plain number), or in SI for a
 * physical kind. Parse with `{ physical: true }` for a physical kind (or `options.physical`).
 */
export function evaluateParsed(expression: Expression, options: EvaluateOptions): Result<number> {
  const physicalKind = isPhysicalKind(options.expected);
  const physical = physicalKind || options.physical === true;
  const wrongMode = checkMode(expression, physical);
  if (wrongMode !== undefined) return wrongMode;
  const slope = options.slope === true && options.expected === 'angle' && !physical;
  const env = environment(options, slope, physical);
  const result = slope ? evaluateSlope(expression, env) : evaluateNode(expression, env);
  if (!result.ok) return result;
  if (isPhysicalKind(options.expected)) {
    return physicalResult(expression, result.value, options.expected);
  }
  const target = dimensionOfKind(options.expected);
  const value = promote(result.value, target, env);
  if (physical && isDimensionless(value.dimension) && !isDimensionless(target)) {
    return err(
      'dimension',
      needsUnit(value.value, options.expected, target),
      expression.start,
      expression.end,
    );
  }
  if (!dimensionsEqual(value.dimension, target) && dimensionsEqual(value.dimension, ANGLE)) {
    if (containsPitch(expression)) {
      return err(
        'dimension',
        `A pitch is an angle, but ${describeDimension(target)} is expected`,
        expression.start,
        expression.end,
      );
    }
  }
  if (!dimensionsEqual(value.dimension, target)) {
    return err(
      'dimension',
      `Expected ${describeDimension(target)} but got ${describeDimension(value.dimension)}`,
      expression.start,
      expression.end,
    );
  }
  // Promotion multiplies by a unit factor, which can itself overflow.
  if (!Number.isFinite(value.value)) {
    return err('domain', 'Result is not a finite number', expression.start, expression.end);
  }
  return ok(withoutNegativeZero(value).value);
}

/**
 * Evaluates `source` without imposing an expected kind: bare numbers stay dimensionless.
 * Useful for a variables table where the kind is inferred from the expression. A lone `25degC`
 * is an absolute temperature (`absolute: true`).
 */
export function evaluateQuantity(
  source: string,
  context: EvaluationContext = {},
): Result<Quantity> {
  const parsed = parseExpression(source, { physical: context.physical === true });
  return parsed.ok ? evaluateParsedQuantity(parsed.value, context) : parsed;
}

/**
 * Parses and evaluates `source` as `options.expected`. Returns millimetres for lengths, radians
 * for angles, mm/min for feeds, rpm for spindle speeds, a plain number for numbers and SI for a
 * physical kind. A dimensionless result is read in the display unit, except in a physical field,
 * where it is an error.
 */
export function evaluate(source: string, options: EvaluateOptions): Result<number> {
  const physical = isPhysicalKind(options.expected) || options.physical === true;
  const parsed = parseExpression(source, { physical });
  return parsed.ok ? evaluateParsed(parsed.value, options) : parsed;
}

/**
 * Parses a value of `kind` without variables: SI for a physical kind (`parseQuantity('200 lbf',
 * 'force')` is 889.64), internal units with bare numbers in millimetres and degrees otherwise.
 */
export function parseQuantity(source: string, kind: QuantityKind): Result<number> {
  return evaluate(source, { expected: kind });
}

/** Parses a length (or length expression without variables); bare numbers are in `unit`. */
export function parseLength(source: string, unit: LengthUnit = 'mm'): Result<number> {
  return evaluate(source, { expected: 'length', lengthUnit: unit });
}

/** Parses an angle (or angle expression without variables) to radians; bare numbers in `unit`. */
export function parseAngle(source: string, unit: AngleUnit = 'deg'): Result<number> {
  return evaluate(source, { expected: 'angle', angleUnit: unit });
}

/** Parses a feed rate to mm/min; bare numbers are `unit` per minute. */
export function parseFeed(source: string, unit: LengthUnit = 'mm'): Result<number> {
  return evaluate(source, { expected: 'feed', lengthUnit: unit });
}

/** Parses a spindle speed to rpm; bare numbers are rpm. */
export function parseSpindleSpeed(source: string): Result<number> {
  return evaluate(source, { expected: 'spindleSpeed' });
}
