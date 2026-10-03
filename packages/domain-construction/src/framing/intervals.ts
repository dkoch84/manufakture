// Intervals along a member's run and plate splicing. Pure helpers, mm.

export type Interval = readonly [number, number];

const EPS = 1e-6;

/** `[a, b]` less the given holes, dropping pieces shorter than `minLength`. */
export function subtract(
  a: number,
  b: number,
  holes: readonly Interval[],
  minLength = EPS,
): Interval[] {
  let parts: Interval[] = [[a, b]];
  for (const [h0, h1] of holes) {
    parts = parts.flatMap(([p0, p1]): Interval[] => {
      if (h1 <= p0 + EPS || h0 >= p1 - EPS) return [[p0, p1]];
      const out: Interval[] = [];
      if (h0 > p0) out.push([p0, h0]);
      if (h1 < p1) out.push([h1, p1]);
      return out;
    });
  }
  return parts.filter(([p0, p1]) => p1 - p0 >= minLength);
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
