// The kernel's error model (ADR 0007, decision 5). Inside the worker the
// synchronous kernel throws `KernelError`; everything that crosses the worker
// boundary carries a `KernelFailure`, which is plain data.

/**
 * - `kernel`: OCCT failed or refused the operation (the `FeatureError` code of ADR 0007).
 * - `invalid-op`: the op is malformed (unknown name, wrong argument types, bad reference).
 * - `invalid-argument`: well formed, but a value is out of range (a zero radius, a zero-length extrusion).
 * - `unknown-shape`: a shape id that is not live (released, never issued, or from before a recycle).
 * - `dependency`: an input refers to an earlier op of the same batch that failed.
 * - `fatal`: the wasm instance aborted; it is recycled and every shape id it held is gone.
 */
export type KernelFailureCode =
  'kernel' | 'invalid-op' | 'invalid-argument' | 'unknown-shape' | 'dependency' | 'fatal';

export interface KernelFailure {
  code: KernelFailureCode;
  /** The kernel operation, for example `fillet`. */
  operation: string;
  message: string;
  /** Decoded OCCT exception type, for example `StdFail_NotDone`. */
  occtType?: string;
  /** Decoded OCCT exception message. */
  occtMessage?: string;
  /** The feature the op was run for, when the caller said. */
  featureId?: string;
}

export interface KernelErrorDetails {
  code?: KernelFailureCode;
  occtType?: string;
  occtMessage?: string;
  featureId?: string;
}

/** Thrown by the synchronous kernel for every failure. */
export class KernelError extends Error {
  readonly code: KernelFailureCode;
  readonly operation: string;
  readonly occtType: string | undefined;
  readonly occtMessage: string | undefined;
  readonly featureId: string | undefined;
  /** The message without the operation prefix. */
  readonly detail: string;

  constructor(operation: string, message: string, details: KernelErrorDetails = {}) {
    super(`${operation}: ${message}`);
    this.name = 'KernelError';
    this.operation = operation;
    this.code = details.code ?? 'kernel';
    this.occtType = details.occtType;
    this.occtMessage = details.occtMessage;
    this.featureId = details.featureId;
    this.detail = message;
  }

  toFailure(featureId?: string): KernelFailure {
    const failure: KernelFailure = {
      code: this.code,
      operation: this.operation,
      message: this.detail,
    };
    if (this.occtType !== undefined) failure.occtType = this.occtType;
    if (this.occtMessage !== undefined) failure.occtMessage = this.occtMessage;
    const feature = featureId ?? this.featureId;
    if (feature !== undefined) failure.featureId = feature;
    return failure;
  }
}

/** A wasm trap (abort, unreachable, out of bounds): the instance cannot be trusted any more. */
export function isFatalWasmError(error: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError;
}
