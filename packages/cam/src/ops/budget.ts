// The move budget every operation's toolpath is held to. A document can ask for a toolpath of
// any size (a tiny tool, a hair-thin stepdown, a shallow entry), and each move is an object of
// its own in the worker, so without a cap one untrusted .mfk could exhaust its memory. The
// shared `Emitter` checks the cap on every entry it adds; the generators turn the overflow into
// an `invalid-input` error and return no partial toolpath.

import { err, type CamResult } from '../types';
import type { OperationContext } from '../worker/registry';

/**
 * The most IR entries one operation's toolpath may hold. Far above any real job: a 300 mm square
 * part finished with a 6 mm ball at a 0.5 mm stepover emits well under half a million, and a
 * 1,200 mm sheet of outside profiles a few tens of thousands. Three million entries are a few
 * hundred MB in the worker; above that the operation is refused.
 */
export const OPERATION_MAX_MOVES = 3e6;

/** Thrown by the `Emitter` when a toolpath would pass its move cap; carries the cap. */
export class MoveBudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} moves`);
    this.name = 'MoveBudgetExceeded';
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The move cap for an operation run in `context`: `OPERATION_MAX_MOVES`, or the context's lower
 * `maxMoves` (internal, for tests); a larger value is clamped to `OPERATION_MAX_MOVES`.
 */
export function operationMoveCap(context: Pick<OperationContext, 'maxMoves'>): number {
  const m = context.maxMoves;
  return finite(m) && m > 0 ? Math.min(Math.floor(m), OPERATION_MAX_MOVES) : OPERATION_MAX_MOVES;
}

/** A move count for a message: `3 million`, or the plain number. */
export const moveCount = (n: number): string =>
  n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6} million` : String(n);

/** The error for an operation whose toolpath passed `limit` moves. */
export function tooManyMoves<T>(id: string, limit: number): CamResult<T> {
  return err(
    'invalid-input',
    `${id}: this operation would emit more than ${moveCount(limit)} moves, the most allowed. Use a larger tool, stepdown, stepover or entry angle.`,
  );
}

/**
 * Runs a generator body, turning a `MoveBudgetExceeded` thrown out of it into `tooManyMoves`.
 * Every other error (`CamCancelled` among them) goes through.
 */
export async function withMoveBudget<T>(
  id: string,
  run: () => CamResult<T> | Promise<CamResult<T>>,
): Promise<CamResult<T>> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof MoveBudgetExceeded) return tooManyMoves(id, e.limit);
    throw e;
  }
}
