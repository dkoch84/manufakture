/** Broad category of an error, so the UI can style or react to it without parsing messages. */
export type UnitsErrorCode =
  /** Malformed input: unexpected character, missing operand, unbalanced parenthesis. */
  | 'syntax'
  /** A unit name after a number that is not a known unit. */
  | 'unknown-unit'
  /** A variable reference the lookup could not resolve. */
  | 'unknown-variable'
  /** A call to a function that does not exist. */
  | 'unknown-function'
  /** A function called with the wrong number of arguments. */
  | 'arity'
  /** Incompatible dimensions, e.g. `length + angle` or an area where a length is expected. */
  | 'dimension'
  /** A mathematically invalid operation: division by zero, `sqrt` of a negative, non-finite result. */
  | 'domain'
  /** `distance(...)` or `angle(...)` whose measurement failed: a face that is not found. */
  | 'measure'
  /**
   * `distance(...)` or `angle(...)` where the model has not been measured (no `measure` lookup,
   * or none that answers this call): not wrong, only not known here.
   */
  | 'not-measured';

/**
 * An error with the source range it refers to. `start` and `end` are UTF-16 offsets into the
 * input string (the same indices `String.prototype.slice` uses); `end` is exclusive. The range is
 * never empty unless the input itself is empty.
 */
export interface UnitsError {
  readonly code: UnitsErrorCode;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

/** Every fallible function in this package returns a `Result` rather than throwing. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: UnitsError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: UnitsErrorCode,
  message: string,
  start: number,
  end: number,
): Result<T> {
  return { ok: false, error: { code, message, start, end } };
}
