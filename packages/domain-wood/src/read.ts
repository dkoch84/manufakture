// Readers for the JSON a domain stores (extension params, domain data). They moved to the shared
// `@manufakture/stock` with the `stock` namespace (T6.1a), so every domain reads the same way;
// re-exported here.

export {
  constantLength,
  fail,
  isObject,
  ok,
  onlyKeys,
  own,
  readConstantLength,
  readEnum,
  readId,
  readStoredExpression,
  type LengthOptions,
  type Path,
  type Read,
} from '@manufakture/stock';
