export const packageName = '@manufakture/units';

export type {
  BinaryNode,
  BinaryOperator,
  CallNode,
  Expression,
  MeasureNode,
  NumberNode,
  UnaryNode,
  UnitNode,
  VariableNode,
} from './ast';
export {
  ANGLE,
  DIMENSIONLESS,
  LENGTH,
  angleQuantity,
  describeDimension,
  dimensionsEqual,
  lengthQuantity,
  numberQuantity,
  type Dimension,
  type Quantity,
  type QuantityKind,
} from './dimension';
export {
  FUNCTION_NAMES,
  evaluate,
  evaluateParsed,
  evaluateParsedQuantity,
  evaluateQuantity,
  parseAngle,
  parseLength,
  type EvaluateOptions,
  type EvaluationContext,
  type VariableLookup,
} from './evaluate';
export {
  formatAngle,
  formatLength,
  formatNumber,
  type AngleFormat,
  type DecimalLengthFormat,
  type FractionDenominator,
  type FractionalLengthFormat,
  type LengthFormat,
} from './format';
export { CONSTANT_NAMES, MAX_NESTING, MAX_TREE_DEPTH, parseExpression } from './parser';
export {
  collectReferences,
  findReferences,
  isValidVariableName,
  type VariableReference,
} from './references';
export type { Result, UnitsError, UnitsErrorCode } from './result';
export {
  MM_PER_FOOT,
  MM_PER_INCH,
  RAD_PER_DEG,
  angleUnitFactor,
  fromMillimetres,
  fromRadians,
  lengthUnitFactor,
  toMillimetres,
  toRadians,
  type AngleUnit,
  type LengthUnit,
} from './units';
