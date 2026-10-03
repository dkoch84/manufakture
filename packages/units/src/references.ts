import type { Expression } from './ast';
import { FUNCTION_NAMES } from './evaluate';
import { CONSTANT_NAMES, parseExpression } from './parser';
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
 * syntax errors. Used for dependency graphs and cycle detection in the variables table.
 */
export function findReferences(source: string): Result<VariableReference[]> {
  const parsed = parseExpression(source);
  return parsed.ok ? ok(collectReferences(parsed.value)) : parsed;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `name` (without `#`) can be used as a variable name: an identifier that is not a
 * built-in constant (`pi`) or function name, so it can always be written without `#`.
 */
export function isValidVariableName(name: string): boolean {
  return (
    VARIABLE_NAME.test(name) && !CONSTANT_NAMES.includes(name) && !FUNCTION_NAMES.includes(name)
  );
}
