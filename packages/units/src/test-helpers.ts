import { expect } from 'vitest';
import type { Result, UnitsError } from './result';

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export function unwrapError<T>(result: Result<T>): UnitsError {
  expect(result.ok, `expected an error, got ${JSON.stringify(result)}`).toBe(false);
  return (result as { ok: false; error: UnitsError }).error;
}
