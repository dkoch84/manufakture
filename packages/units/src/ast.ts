import type { Dimension } from './dimension';
import type { UnitDefinition } from './units';

/** Every node records the source range it was parsed from (UTF-16 offsets, `end` exclusive). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** A bare number (or `pi`). Dimensionless until context says otherwise. */
export interface NumberNode extends Span {
  readonly type: 'number';
  readonly value: number;
}

/** A number with a unit, including compound imperial forms like `3' 4-1/2"`. Value in mm / rad. */
export interface MeasureNode extends Span {
  readonly type: 'measure';
  readonly value: number;
  readonly dimension: Dimension;
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

export type Expression =
  | NumberNode
  | MeasureNode
  | VariableNode
  | UnitNode
  | UnaryNode
  | BinaryNode
  | CallNode
  | PitchNode
  | PercentNode;
