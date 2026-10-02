// The operation registry: how operations plug into the CAM worker (T5.1g). Each operation kind
// (profile, pocket, facing, drill, V-carve, surfacing; T5.2b to T5.2f and T5.5a) registers one
// generator, and the worker dispatches on `OperationInput.kind`. The worker knows nothing about
// any particular operation.
//
// A generator turns one evaluated operation into a toolpath. It is plain code on plain data and
// may be synchronous, but a generator that can run long (a big pocket, a 3D finish) must be
// `async` and `await context.checkpoint()` between passes, rings or raster lines: that is where
// a newer request cancels it (ADR 0007 decision 4; a single long call cannot be cancelled midway).
// Expected failures (a tool too large for a region, an empty result) are returned as
// `{ ok: false, error }`; a throw is treated as a bug and reported as an `internal` error value.
//
// **Only what the cache key holds may shape the output** (`cache/key.ts`, ADR 0014 decision 9),
// or a cache hit would serve a stale toolpath. A generator may read its own operation (except
// `name`), the setup's stock, WCS, frame, heights, id and machine id, and `context.machine`. It
// must not read the setup's `operations` (its sibling operations), `setup.name`, `setup.post`
// or its operation's `name`: none of these are in the key. A generator that ever needs one of
// them (a name written into a comment, say) must add it to `toolpathKey` and bump
// `CAM_IMPLEMENTATION_VERSION` in the same change.

import type { Toolpath } from '../ir';
import type { CamResult, OperationInput, OperationKind, Setup } from '../types';

/** What a generator returns on success. */
export interface GeneratedToolpath {
  readonly toolpath: Toolpath;
  /** Non-fatal notes for the operation's row in the UI (a pass skipped, a tab dropped). */
  readonly warnings?: readonly CamWarning[];
}

export interface CamWarning {
  readonly code: string;
  readonly message: string;
}

/** Thrown by `checkpoint()` when the request was superseded; the worker catches it. */
export class CamCancelled extends Error {
  constructor() {
    super('superseded by a newer CAM request');
    this.name = 'CamCancelled';
  }
}

/** What every piece of work in the worker gets: its generation and the way to be cancelled. */
export interface WorkContext {
  /** The request's generation. */
  readonly generation: number;
  /** True once a newer request or a `cancel` has superseded this one. */
  readonly cancelled: boolean;
  /**
   * Call between passes. Yields to the event loop once the current time slice is used up, so a
   * newer request can arrive, and throws `CamCancelled` if this request is now stale. A generator
   * that catches errors must let `CamCancelled` through.
   */
  checkpoint(): Promise<void>;
}

export interface OperationContext extends WorkContext {
  /** The setup the operation belongs to (stock, WCS, heights). */
  readonly setup: Setup;
  /** The machine table row the setup uses (T5.1d), as the request sent it; hashed into keys. */
  readonly machine?: unknown;
}

export type OperationOfKind<K extends OperationKind> = Extract<OperationInput, { kind: K }>;

export type OperationGenerator<I extends OperationInput = OperationInput> = (
  input: I,
  context: OperationContext,
) => CamResult<GeneratedToolpath> | Promise<CamResult<GeneratedToolpath>>;

export class OperationRegistry {
  private readonly generators = new Map<OperationKind, OperationGenerator>();

  /** Register the generator for `kind`, replacing any earlier one. */
  register<K extends OperationKind>(
    kind: K,
    generator: OperationGenerator<OperationOfKind<K>>,
  ): this {
    this.generators.set(kind, generator as OperationGenerator);
    return this;
  }

  unregister(kind: OperationKind): boolean {
    return this.generators.delete(kind);
  }

  get(kind: OperationKind): OperationGenerator | undefined {
    return this.generators.get(kind);
  }

  has(kind: OperationKind): boolean {
    return this.generators.has(kind);
  }

  /** The registered kinds, in registration order. */
  kinds(): OperationKind[] {
    return [...this.generators.keys()];
  }
}

/**
 * The registry the worker entry (`@manufakture/cam/worker`) serves. Operations register here as
 * they land (`builtin.ts`); a host with operations of its own registers them before the worker
 * handles its first message, as apps/web's regen worker does for domains.
 */
export const defaultOperations = new OperationRegistry();
