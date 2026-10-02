// Shared helpers for the sheet and stick packers.

/**
 * Lengths closer than this are equal. The packers are unit-agnostic; 1e-6 is far below a saw's
 * precision in millimetres and in inches, and far above float64 noise for sheet-sized numbers.
 */
export const EPS = 1e-6;

/** Why a part (or some copies of it) could not be placed. */
export type UnplacedReason =
  /** The part's size is not a positive finite number. */
  | 'invalid'
  /** No stock can hold the part, even an empty one (after trims, grain and the stage limit). */
  | 'does-not-fit'
  /** Some stock could hold the part, but every such stock's quantity is used up. */
  | 'out-of-stock';

export interface Unplaced {
  partId: string;
  /** How many copies of the part were not placed. */
  quantity: number;
  reason: UnplacedReason;
}

/** Progress after one attempt, yielded by the step-wise packers. */
export interface Progress {
  /** Attempts finished so far. */
  attempt: number;
  /** Attempts planned in total. */
  total: number;
}

/** mulberry32: a small, fast, seeded generator. Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A copy of `items` with a few nearby elements swapped: the perturbation the random attempts
 * apply to the best rule's part order.
 */
export function perturb<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  if (out.length < 2) return out;
  const swaps = Math.max(1, Math.round(out.length / 4));
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(random() * out.length);
    const j = Math.min(out.length - 1, i + 1 + Math.floor(random() * 3));
    const t = out[i]!;
    out[i] = out[j]!;
    out[j] = t;
  }
  return out;
}

/** Lexicographic comparison of two score vectors (smaller is better). */
export function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9 * Math.max(1, Math.abs(a[i] ?? 0), Math.abs(b[i] ?? 0))) return d;
  }
  return 0;
}

export function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function isNonNegativeFinite(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** Valid quantity: a non-negative integer. */
export function isQuantity(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** Yields to the event loop, so a worker can receive a cancel message between attempts. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
