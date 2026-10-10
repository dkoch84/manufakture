import type { Expression } from './ast';
import { FUNCTION_NAMES, MEASURE_FUNCTION_NAMES, type MeasureFunction } from './evaluate';
import { CONSTANT_NAMES, parseExpression, type ParseOptions } from './parser';
import { ok, type Result } from './result';

/** A variable mentioned in an expression. */
export interface VariableReference {
  /** Name without the `#`. */
  readonly name: string;
  /** Whether it was written `#name`. */
  readonly hashed: boolean;
  readonly start: number;
  readonly end: number;
}

function collect(node: Expression, out: VariableReference[]): void {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'measure':
      return;
    case 'variable':
      out.push({ name: node.name, hashed: node.hashed, start: node.start, end: node.end });
      return;
    case 'unit':
    case 'unary':
    case 'percent':
      collect(node.operand, out);
      return;
    case 'binary':
      collect(node.left, out);
      collect(node.right, out);
      return;
    case 'call':
      for (const a of node.args) collect(a, out);
      return;
    case 'pitch':
      collect(node.rise, out);
      collect(node.run, out);
      return;
  }
}

/** Every variable reference in a parsed expression, in source order (duplicates included). */
export function collectReferences(expression: Expression): VariableReference[] {
  const out: VariableReference[] = [];
  collect(expression, out);
  return out;
}

/**
 * Every variable reference in `source`, in source order (duplicates included). Fails only on
 * syntax errors. Pass `{ physical: true }` for a physical field, where `5 m/s` mentions no
 * variable `s`. Used for dependency graphs and cycle detection in the variables table.
 */
export function findReferences(
  source: string,
  options: ParseOptions = {},
): Result<VariableReference[]> {
  const parsed = parseExpression(source, options);
  return parsed.ok ? ok(collectReferences(parsed.value)) : parsed;
}

/** A face name quoted in an expression, with the range of its text (inside the quotes). */
export interface QuotedFace {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** A `distance(...)` or `angle(...)` in an expression. */
export interface MeasureReference {
  readonly fn: MeasureFunction;
  /** Its quoted face names, in order; a call written wrong may have other than two. */
  readonly faces: readonly QuotedFace[];
  readonly start: number;
  readonly end: number;
}

function collectMeasureCalls(node: Expression, out: MeasureReference[]): void {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'measure':
    case 'variable':
      return;
    case 'unit':
    case 'unary':
    case 'percent':
      collectMeasureCalls(node.operand, out);
      return;
    case 'binary':
      collectMeasureCalls(node.left, out);
      collectMeasureCalls(node.right, out);
      return;
    case 'pitch':
      collectMeasureCalls(node.rise, out);
      collectMeasureCalls(node.run, out);
      return;
    case 'call':
      if ((MEASURE_FUNCTION_NAMES as readonly string[]).includes(node.name)) {
        out.push({
          fn: node.name as MeasureFunction,
          faces: node.args
            .filter((a) => a.type === 'string')
            .map((a) => ({ name: a.value, start: a.start + 1, end: a.end - 1 })),
          start: node.start,
          end: node.end,
        });
        return;
      }
      for (const a of node.args) collectMeasureCalls(a, out);
      return;
  }
}

/** Every `distance(...)` and `angle(...)` in a parsed expression, in source order. */
export function collectMeasures(expression: Expression): MeasureReference[] {
  const out: MeasureReference[] = [];
  collectMeasureCalls(expression, out);
  return out;
}

/** Every `distance(...)` and `angle(...)` in `source`. Fails only on syntax errors. */
export function findMeasures(
  source: string,
  options: ParseOptions = {},
): Result<MeasureReference[]> {
  const parsed = parseExpression(source, options);
  return parsed.ok ? ok(collectMeasures(parsed.value)) : parsed;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `name` (without `#`) can be used as a variable name: an identifier that is not a
 * built-in constant (`pi`) or function name, so it can always be written without `#`. The
 * measuring functions (`distance`, `angle`) are not in that list: they came later, and a
 * variable of either name stays valid (written bare it is the variable; followed by `(` it is
 * always the call).
 */
export function isValidVariableName(name: string): boolean {
  return (
    VARIABLE_NAME.test(name) && !CONSTANT_NAMES.includes(name) && !FUNCTION_NAMES.includes(name)
  );
}
