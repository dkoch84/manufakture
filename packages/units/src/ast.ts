import type { Dimension } from './dimension';
import type { UnitDefinition } from './units';

/** Every node records the source range it was parsed from (UTF-16 offsets, `end` exclusive). */
interface Span {
  readonly start: number;
  readonly end: number;
  /**
   * Set on the root of an AST from `parseExpression` whose reading depends on the parse mode (a
   * compound unit after a length unit, a rate, `rpm`): whether it was parsed for a physical
   * field. Absent elsewhere. A plain field, so a cloned or serialised tree keeps it.
   */
  readonly parsedPhysical?: boolean;
}

/** A bare number (or `pi`). Dimensionless until context says otherwise. */
export interface NumberNode extends Span {
  readonly type: 'number';
  readonly value: number;
}

/**
 * A number with a unit, including compound imperial forms like `3' 4-1/2"` and compound units
 * like `22 N*m`. Value in internal units (mm, rad, min, kg, A, K).
 */
export interface MeasureNode extends Span {
  readonly type: 'measure';
  readonly value: number;
  readonly dimension: Dimension;
  /**
   * A lone `degC` or `degF` value: `value` is the temperature difference in kelvin, and
   * `value + offset` the absolute temperature. Which one applies depends on the use (README,
   * "Temperature").
   */
  readonly offset?: number;
  /**
   * A physical literal's value in SI, rounded once from the number typed (`1 kgf` is exactly
   * 9.80665), which a physical field reads instead of converting `value` back.
   */
  readonly si?: number;
}

/** A variable reference: `#thickness` (`hashed`) or `thickness`. */
export interface VariableNode extends Span {
  readonly type: 'variable';
  readonly name: string;
  readonly hashed: boolean;
}

/** A unit applied to a parenthesised expression: `(a + 2)mm`. */
export interface UnitNode extends Span {
  readonly type: 'unit';
  readonly operand: Expression;
  readonly unit: UnitDefinition;
}

export interface UnaryNode extends Span {
  readonly type: 'unary';
  readonly op: '-' | '+';
  readonly operand: Expression;
}

export type BinaryOperator = '+' | '-' | '*' | '/' | '^';

export interface BinaryNode extends Span {
  readonly type: 'binary';
  readonly op: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface CallNode extends Span {
  readonly type: 'call';
  readonly name: string;
  /** Range of the function name alone. */
  readonly nameEnd: number;
  readonly args: readonly Expression[];
}

/**
 * A roof pitch `rise:run`, an angle of `atan(rise / run)`. Both sides are lengths or bare
 * numbers (README, "Roof pitch").
 */
export interface PitchNode extends Span {
  readonly type: 'pitch';
  readonly rise: Expression;
  readonly run: Expression;
}

/** A percent slope `25%`, the angle `atan(25 / 100)`. Only valid in slope fields. */
export interface PercentNode extends Span {
  readonly type: 'percent';
  readonly operand: Expression;
}

/**
 * A quoted face name, an argument of `distance(...)` or `angle(...)`, which measure the model
 * (`MEASURE_FUNCTION_NAMES`). It has no value of its own.
 */
export interface StringNode extends Span {
  readonly type: 'string';
  readonly value: string;
}

export type Expression =
  | NumberNode
  | StringNode
  | MeasureNode
  | VariableNode
  | UnitNode
  | UnaryNode
  | BinaryNode
  | CallNode
  | PitchNode
  | PercentNode;
