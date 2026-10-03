// Chained dimension strings (M6 plan T6.4a): a row of consecutive linear dimensions along one
// line, as framers and architects write them along a wall (corner to rough opening to rough
// opening to corner), with the overall dimension in a second row outside it, and optional layout
// marks (an X at each stud) on the first row.
//
// A chain arrives as already-projected points in view coordinates, like a linear dimension. Every
// span is laid out by `layoutDimension`, so a chain looks exactly like the single dimensions next
// to it; the extension line a span shares with its neighbour is drawn once. Placement is the M4
// rule: a fixed offset from the points, with collision nudging only. A value that does not fit
// between its terminators goes past them (as for a single dimension), and a value that would then
// overlap the one before it is nudged across the dimension line, a text row further for each
// value already there, at most `MAX_NUDGE` rows: the usual staggered string.
//
// Chains are derived, never stored (ADR 0015): regen computes them from wall, opening and member
// data at every drawing request.

import {
  DEFAULT_DIMENSION_STYLE,
  estimateTextWidth,
  layoutDimension,
  type DimensionStyle,
} from './dimension';
import type { DisplayItem, DrawingWarning, TextItem } from './display';
import type { ValueFormat } from './format';
import {
  add,
  applyPoint,
  distance,
  dot,
  mul,
  normalize,
  perp,
  sub,
  type Transform2,
  type Vec2,
} from './geometry';

/** The most points one chain lays out; more is a warning and the chain is not drawn. */
export const MAX_CHAIN_POINTS = 1_000;
/** The most layout marks one chain draws; more is a warning and the marks are not drawn. */
export const MAX_CHAIN_MARKS = 5_000;
/** How many text rows a value may be nudged outwards to clear the one before it. */
export const MAX_NUDGE = 3;
/** Points closer than this (view units) are one point of the chain. */
const SAME = 1e-6;

export interface ChainDimensionInput {
  /** The owner of every item (`chain#wall-1`, or a domain's id). */
  readonly id: string;
  /** The view the points are in. */
  readonly view: string;
  /** As for a linear dimension: what each span measures. */
  readonly kind: 'horizontal' | 'vertical' | 'aligned';
  /**
   * The points in order along the line, view coordinates (model mm). For `aligned`, the line runs
   * from the first point to the last. Repeated points are dropped.
   */
  readonly points: readonly Vec2[];
  /**
   * Paper mm from the points to the first row, as a linear dimension's `offset`: positive above
   * (horizontal), right (vertical) or to the left of the first point to the last (aligned).
   */
  readonly offset: number;
  /** The overall dimension in a second row. Default: when the chain has more than one span. */
  readonly overall?: boolean;
  /** Paper mm from the first row to the second. Default `2 x textHeight + 2 x textGap + 1`. */
  readonly rowGap?: number;
  /** Layout marks on the first row (an X at each point's foot), view coordinates. */
  readonly marks?: readonly Vec2[];
  readonly format?: ValueFormat;
}

/** The chain's points with repeats dropped, in order. */
function distinct(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (out.length === 0 || distance(out[out.length - 1]!, p) > SAME) out.push(p);
  }
  return out;
}

/** The measuring direction of a chain on paper, or null when it has none. */
function direction(kind: ChainDimensionInput['kind'], first: Vec2, last: Vec2): Vec2 | null {
  if (kind === 'horizontal') return [1, 0];
  if (kind === 'vertical') return [0, 1];
  const d = sub(last, first);
  return Math.hypot(d[0], d[1]) > 0 ? normalize(d) : null;
}

/**
 * The values of a chain's spans, model mm, in order: what each consecutive pair of its points
 * measures (`horizontal` |dx|, `vertical` |dy|, `aligned` the distance along the first to last
 * point). Repeated points are dropped first, so no span is zero.
 */
export function chainSpans(kind: ChainDimensionInput['kind'], points: readonly Vec2[]): number[] {
  const p = distinct(points.slice(0, MAX_CHAIN_POINTS));
  if (p.length < 2) return [];
  const d = direction(kind, p[0]!, p[p.length - 1]!);
  if (d === null) return [];
  const out: number[] = [];
  for (let i = 1; i < p.length; i++) out.push(Math.abs(dot(sub(p[i]!, p[i - 1]!), d)));
  return out;
}

function overlaps(placed: readonly [number, number] | undefined, lo: number, hi: number): boolean {
  return placed !== undefined && placed[0] < hi && lo < placed[1];
}

/**
 * Lays out a chain: the first row (one linear dimension per span, all on one line), the overall
 * row, and the layout marks, in paper mm. Spans that measure nothing along the line (two points
 * one above the other in a horizontal chain) are skipped. A chain with fewer than two distinct
 * points, or over the bounds, is a `degenerate-dimension` warning.
 */
export function layoutChain(
  chain: ChainDimensionInput,
  transform: Transform2,
  format: ValueFormat = {},
  style: DimensionStyle = DEFAULT_DIMENSION_STYLE,
): { items: DisplayItem[]; warnings: DrawingWarning[] } {
  const warn = (message: string) => ({
    items: [],
    warnings: [
      {
        code: 'degenerate-dimension' as const,
        subject: chain.id,
        message: `${chain.id}: ${message}`,
      },
    ],
  });
  if (chain.points.length > MAX_CHAIN_POINTS) {
    return warn(`a chain has at most ${MAX_CHAIN_POINTS} points`);
  }
  if ((chain.marks?.length ?? 0) > MAX_CHAIN_MARKS) {
    return warn(`a chain has at most ${MAX_CHAIN_MARKS} layout marks`);
  }
  const P = (v: Vec2) => applyPoint(transform, v);
  // Values are measured in view coordinates (model mm); the layout is on paper.
  const model = distinct(chain.points);
  const points = model.map(P);
  if (model.length < 2) return warn('a chain needs two different points');
  const dir = direction(chain.kind, model[0]!, model[model.length - 1]!);
  if (dir === null) return warn('the chain has no direction');
  // As `layoutDimension`'s linear rule: positive offsets go up, right, or to the left of dir.
  const n: Vec2 = chain.kind === 'vertical' ? [1, 0] : perp(dir);
  const outward = chain.offset >= 0 ? 1 : -1;
  const heights = points.map((p) => dot(p, n));
  const far = outward > 0 ? Math.max(...heights) : Math.min(...heights);
  const level = far + chain.offset;
  const fmt = chain.format ?? format;
  const owner = chain.id;

  const items: DisplayItem[] = [];
  const seen = new Set<string>();
  const key = (it: DisplayItem) =>
    it.kind === 'line'
      ? `l${it.a[0].toFixed(6)},${it.a[1].toFixed(6)},${it.b[0].toFixed(6)},${it.b[1].toFixed(6)}`
      : null;
  const push = (list: readonly DisplayItem[]) => {
    for (const it of list) {
      const k = key(it);
      if (k !== null) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      items.push(it);
    }
  };
  /** One linear dimension of the chain between two paper points with its line at `at`. */
  const span = (a: Vec2, b: Vec2, at: number, value: number): DisplayItem[] => {
    // `layoutDimension` puts the line `offset` past the nearer anchor's height (the higher one
    // for a positive offset): give it what lands the line exactly at `at`.
    const ha = dot(a, n);
    const hb = dot(b, n);
    const offset = outward > 0 ? at - Math.max(ha, hb) : at - Math.min(ha, hb);
    const { items: out } = layoutDimension(
      { id: owner, view: chain.view, kind: chain.kind, points: [a, b], offset, value },
      { scale: 1, offset: [0, 0] },
      fmt,
      style,
    );
    return out;
  };

  // The first row, with the values nudged clear of one another: a value that overlaps the last
  // one placed on its row moves out a row. Linear: each row remembers only its last value.
  const row = style.textHeight + 2 * style.textGap;
  const last: (readonly [number, number] | undefined)[] = [];
  let nudged = 0;
  for (let i = 1; i < points.length; i++) {
    const value = Math.abs(dot(sub(model[i]!, model[i - 1]!), dir));
    if (value <= SAME) continue;
    for (const it of span(points[i - 1]!, points[i]!, level, value)) {
      if (it.kind !== 'text') {
        push([it]);
        continue;
      }
      const half = estimateTextWidth(it.text, it.height) / 2 + style.textGap;
      const c = dot(it.at, dir);
      const lo = c - half;
      const hi = c + half;
      let k = 0;
      while (k < MAX_NUDGE && overlaps(last[k], lo, hi)) k++;
      last[k] = [lo, hi];
      if (k === 0) {
        items.push(it);
        continue;
      }
      // Nudged to the other side of the dimension line (the side text does not read on), a row
      // further for each level: a staggered string.
      const up: Vec2 = [-Math.sin(it.rotation), Math.cos(it.rotation)];
      const shift = mul(up, -k * row);
      if (dot(shift, n) * outward > 0) nudged = Math.max(nudged, k);
      items.push({ ...it, at: add(it.at, shift) } as TextItem);
    }
  }

  // The overall row, outside every nudged value.
  const overall = chain.overall ?? points.length > 2;
  if (overall) {
    const gap = chain.rowGap ?? 2 * style.textHeight + 2 * style.textGap + 1;
    const at = level + outward * (gap + nudged * row);
    const value = Math.abs(dot(sub(model[model.length - 1]!, model[0]!), dir));
    push(span(points[0]!, points[points.length - 1]!, at, value));
  }

  // Layout marks: a small X on the first row at each mark's foot.
  const size = style.tickLength / 2;
  for (const m of chain.marks ?? []) {
    const p = P(m);
    const q = add(p, mul(n, level - dot(p, n)));
    const u = normalize(add(dir, n));
    const v = normalize(sub(dir, n));
    items.push({
      kind: 'line',
      layer: 'dimension',
      a: sub(q, mul(u, size)),
      b: add(q, mul(u, size)),
      owner,
    });
    items.push({
      kind: 'line',
      layer: 'dimension',
      a: sub(q, mul(v, size)),
      b: add(q, mul(v, size)),
      owner,
    });
  }
  return { items, warnings: [] };
}
