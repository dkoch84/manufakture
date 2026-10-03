// Intervals along a member's run and plate splicing. Pure helpers, mm.

export type Interval = readonly [number, number];

const EPS = 1e-6;

/**
 * `[a, b]` less the given holes, dropping pieces shorter than `minLength`. The pieces stay sorted
 * and apart while the holes run forwards, so each hole only cuts the run of pieces it reaches,
 * found by binary search: linear for holes given in order along the run (a wall's doors).
 */
export function subtract(
  a: number,
  b: number,
  holes: readonly Interval[],
  minLength = EPS,
): Interval[] {
  if (!holes.every(([h0, h1]) => h0 <= h1)) return subtractEach(a, b, holes, minLength);
  const parts: Interval[] = [[a, b]];
  for (const hole of holes) {
    const [h0, h1] = hole;
    // Pieces a hole leaves alone: those it ends before (a suffix) or starts after (a prefix).
    const i = firstIndex(parts.length, (k) => !(h0 >= parts[k]![1] - EPS));
    const j = firstIndex(parts.length, (k) => h1 <= parts[k]![0] + EPS);
    if (j <= i) continue;
    // At most two pieces are left: before the hole in the first piece, after it in the last.
    parts.splice(i, j - i, ...parts.slice(i, j).flatMap((p) => cutHole(p, hole)));
  }
  return parts.filter(([p0, p1]) => p1 - p0 >= minLength);
}

/** `subtract` hole by hole over every piece, for holes whose ends are reversed. */
function subtractEach(
  a: number,
  b: number,
  holes: readonly Interval[],
  minLength: number,
): Interval[] {
  let parts: Interval[] = [[a, b]];
  for (const hole of holes) parts = parts.flatMap((p) => cutHole(p, hole));
  return parts.filter(([p0, p1]) => p1 - p0 >= minLength);
}

function cutHole([p0, p1]: Interval, [h0, h1]: Interval): Interval[] {
  if (h1 <= p0 + EPS || h0 >= p1 - EPS) return [[p0, p1]];
  const out: Interval[] = [];
  if (h0 > p0) out.push([p0, h0]);
  if (h1 < p1) out.push([h1, p1]);
  return out;
}

/** The first of `0..n-1` where `pred` holds, or `n`; `pred` must be false then true. */
export function firstIndex(n: number, pred: (k: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Intervals sorted by start, with the highest end so far, for overlap and containment lookups in
 * logarithmic time plus the intervals near the one asked about. The answers are exactly those of
 * testing every interval.
 */
export class IntervalIndex {
  readonly #items: Interval[];
  readonly #reach: number[] = [];

  constructor(intervals: readonly Interval[]) {
    this.#items = [...intervals].sort((p, q) => p[0] - q[0]);
    let r = -Infinity;
    for (const it of this.#items) this.#reach.push((r = Math.max(r, it[1])));
  }

  /** Whether any interval `overlaps` `q` by more than `tol` (at least 0). */
  overlapsAny(q: Interval, tol: number): boolean {
    const items = this.#items;
    // An interval starting at or past q's end, or ending at or before its start, shares nothing.
    let k = firstIndex(items.length, (i) => items[i]![0] >= q[1]) - 1;
    for (; k >= 0 && this.#reach[k]! > q[0]; k--) if (overlaps(items[k]!, q, tol)) return true;
    return false;
  }

  /** Whether any interval holds `q` to within `eps` at each end. */
  containsAny(q: Interval, eps: number): boolean {
    const items = this.#items;
    const n = firstIndex(items.length, (i) => !(q[0] >= items[i]![0] - eps));
    return n > 0 && q[1] <= this.#reach[n - 1]! + eps;
  }
}

/** Whether two intervals share more than `tol` of length. */
export function overlaps(a: Interval, b: Interval, tol: number): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > tol;
}

export interface SpliceResult {
  /** The pieces of every interval, in order, each no longer than `maxLength`. */
  readonly pieces: Interval[];
  /** Where pieces of one interval butt (the splice joints). */
  readonly splices: number[];
  /** Splices that could not keep `offset` from every `avoid` position. */
  readonly tooClose: number[];
}

/**
 * Cuts each interval into pieces no longer than `maxLength` (the longest stock). Each splice is
 * placed as far along as it can go while staying at least `offset` from every position in
 * `avoid` (the splices of the courses below, R602.3.2's 24" as a layout rule) and leaving pieces
 * of at least `offset` where the run allows it. When no position keeps the offset, the splice
 * goes at the longest piece and is reported in `tooClose`.
 */
export function splice(
  intervals: readonly Interval[],
  maxLength: number,
  avoid: readonly number[],
  offset: number,
): SpliceResult {
  const pieces: Interval[] = [];
  const splices: number[] = [];
  const tooClose: number[] = [];
  const clear = (e: number) => avoid.every((p) => Math.abs(e - p) >= offset - EPS);
  for (const [a, b] of intervals) {
    let s = a;
    while (b - s > maxLength + EPS) {
      const hi = s + maxLength;
      const candidates = [hi, b - offset, ...avoid.flatMap((p) => [p - offset, p + offset])].filter(
        (e) => e > s + offset - EPS && e <= hi + EPS && e < b - EPS && clear(e),
      );
      // Prefer a splice that leaves a remainder of at least `offset`.
      const roomy = candidates.filter((e) => b - e >= offset - EPS);
      const pool = roomy.length > 0 ? roomy : candidates;
      let e: number;
      if (pool.length > 0) e = Math.max(...pool);
      else {
        e = hi;
        tooClose.push(e);
      }
      pieces.push([s, e]);
      splices.push(e);
      s = e;
    }
    pieces.push([s, b]);
  }
  return { pieces, splices, tooClose };
}
