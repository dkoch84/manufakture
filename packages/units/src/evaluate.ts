import type { BinaryNode, CallNode, Expression, PercentNode, PitchNode } from './ast';
import {
  ANGLE,
  DIMENSIONLESS,
  FEED,
  LENGTH,
  SPINDLE_SPEED,
  describeDimension,
  dimensionOfKind,
  dimensionsEqual,
  divideDimensions,
  isDimensionless,
  multiplyDimensions,
  powerDimension,
  type Dimension,
  type Quantity,
  type QuantityKind,
} from './dimension';
import { parseExpression } from './parser';
import { err, ok, type Result } from './result';
import { angleUnitFactor, lengthUnitFactor, type AngleUnit, type LengthUnit } from './units';

/** Resolves a variable name (without `#`) to its value, or `undefined` if it does not exist. */
export type VariableLookup = (name: string) => Quantity | undefined;

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
  /** Whether percent slopes are allowed (slope fields only). */
  readonly slope: boolean;
}

function environment(context: EvaluationContext, slope = false): Environment {
  return {
    lengthFactor: lengthUnitFactor(context.lengthUnit ?? 'mm'),
    angleFactor: angleUnitFactor(context.angleUnit ?? 'deg'),
    angleUnit: context.angleUnit ?? 'deg',
    variables: context.variables ?? (() => undefined),
    slope,
  };
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
  if (!isDimensionless(q.dimension)) return q;
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

function arg(args: readonly Quantity[], index: number): Quantity {
  return args[index] as Quantity;
}

/** Trig input: an angle, or a bare number read in the display angle unit. */
function angleArgument(node: CallNode, q: Quantity, env: Environment): Result<number> {
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
        const scale = displayFactor(x.dimension, env) ?? 1;
        return ok({ value: rounder(x.value / scale) * scale, dimension: x.dimension });
      }
      const pair = unify(x, arg(args, 1), env);
      if (pair === undefined) {
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

function evaluateCall(node: CallNode, env: Environment): Result<Quantity> {
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
  const args: Quantity[] = [];
  for (const a of node.args) {
    const value = evaluateNode(a, env);
    if (!value.ok) return value;
    args.push(value.value);
  }
  return spec.apply(args, node, env);
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
function addOrSubtract(
  node: BinaryNode,
  a: Quantity,
  b: Quantity,
  env: Environment,
): Result<Quantity> {
  const pair = unify(a, b, env);
  if (pair === undefined) {
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
  return ok({ value, dimension: x.dimension });
}

/**
 * Evaluates one node and rejects a non-finite result right there, so an overflow is reported
 * where it happens rather than disappearing later (`1/1e300^2` would otherwise give 0).
 */
function evaluateNode(node: Expression, env: Environment): Result<Quantity> {
  const result = evaluateUnchecked(node, env);
  if (result.ok && !Number.isFinite(result.value.value)) {
    return err('domain', 'Result is not a finite number', node.start, node.end);
  }
  return result;
}

function evaluateUnchecked(node: Expression, env: Environment): Result<Quantity> {
  switch (node.type) {
    case 'number':
      return ok({ value: node.value, dimension: DIMENSIONLESS });
    case 'measure':
      return ok({ value: node.value, dimension: node.dimension });
    case 'variable': {
      const value = env.variables(node.name);
      if (value === undefined) {
        const shown = node.hashed ? `#${node.name}` : node.name;
        return err('unknown-variable', `Unknown variable '${shown}'`, node.start, node.end);
      }
      return ok(value);
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
      return ok({ value: operand.value.value * node.unit.factor, dimension: node.unit.dimension });
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, env);
      if (!operand.ok || node.op === '+') return operand;
      return ok({ value: -operand.value.value, dimension: operand.value.dimension });
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
      switch (node.op) {
        case '+':
        case '-':
          return addOrSubtract(node, a, b, env);
        case '*':
          return ok({
            value: a.value * b.value,
            dimension: multiplyDimensions(a.dimension, b.dimension),
          });
        case '/':
          if (b.value === 0) {
            return err('domain', 'Division by zero', node.right.start, node.right.end);
          }
          return ok({
            value: a.value / b.value,
            dimension: divideDimensions(a.dimension, b.dimension),
          });
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
          return ok({ value, dimension: powerDimension(a.dimension, b.value) });
        }
      }
    }
  }
}

/** Results never carry `-0`, so `formatX` and equality checks need not care. */
function withoutNegativeZero(q: Quantity): Quantity {
  return q.value === 0 ? { value: 0, dimension: q.dimension } : q;
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

/** Evaluates an already-parsed expression without imposing an expected kind. */
export function evaluateParsedQuantity(
  expression: Expression,
  context: EvaluationContext = {},
): Result<Quantity> {
  const result = evaluateNode(expression, environment(context));
  return result.ok ? ok(withoutNegativeZero(result.value)) : result;
}

/**
 * Evaluates an already-parsed expression and checks it against `options.expected`. Returns the
 * value in internal units: millimetres, radians, mm/min, rpm, or a plain number.
 */
export function evaluateParsed(expression: Expression, options: EvaluateOptions): Result<number> {
  const slope = options.slope === true && options.expected === 'angle';
  const env = environment(options, slope);
  const result = slope ? evaluateSlope(expression, env) : evaluateNode(expression, env);
  if (!result.ok) return result;
  const target = dimensionOfKind(options.expected);
  const value = promote(result.value, target, env);
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
 * Useful for a variables table where the kind is inferred from the expression.
 */
export function evaluateQuantity(
  source: string,
  context: EvaluationContext = {},
): Result<Quantity> {
  const parsed = parseExpression(source);
  return parsed.ok ? evaluateParsedQuantity(parsed.value, context) : parsed;
}

/**
 * Parses and evaluates `source` as `options.expected`. Returns millimetres for lengths, radians
 * for angles, mm/min for feeds, rpm for spindle speeds and a plain number for numbers. A
 * dimensionless result is read in the display unit.
 */
export function evaluate(source: string, options: EvaluateOptions): Result<number> {
  const parsed = parseExpression(source);
  return parsed.ok ? evaluateParsed(parsed.value, options) : parsed;
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
