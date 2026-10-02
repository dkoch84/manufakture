// Dimension layout. Regen (T4.4e) resolves a dimension's model references and projects them with
// the view's frame, so a dimension arrives here as already-projected anchors in view coordinates
// (model millimetres): two points, a circle, two silhouette lines or two legs of an angle. This
// module turns one into display items in paper millimetres: extension lines with a gap and an
// overshoot, the dimension line, arrowheads or ticks, and the value as text.
//
// The geometry rules (where the dimension line goes, which way text reads, when arrows go
// outside) are below each function. Sizes are in `DimensionStyle`.

import {
  DIAMETER_SIGN,
  dimensionText,
  formatDimensionAngle,
  formatDimensionLength,
  type ValueFormat,
} from './format';
import type { DisplayItem, DrawingWarning, LayerName, TextAnchor } from './display';
import {
  add,
  applyPoint,
  distance,
  dot,
  length,
  mul,
  normalize,
  normalizeAngle,
  perp,
  polar,
  sub,
  type Transform2,
  type Vec2,
} from './geometry';

interface DimensionBase {
  /** `'dim#1'`. */
  readonly id: string;
  /** The view the anchors are in. */
  readonly view: string;
  /**
   * The value in model millimetres (radians for angles), when regen measured it on the model
   * (radius and diameter are true sizes). Default: measured from the projected anchors.
   */
  readonly value?: number;
  /** Text instead of the value; `<>` in it stands for the formatted value. */
  readonly text?: string;
  /** Per dimension display units (a metric dimension on an inch drawing, say). */
  readonly format?: ValueFormat;
}

/**
 * A linear dimension between two points. `horizontal` measures |dx|, `vertical` |dy| and
 * `aligned` the distance. `offset` (paper mm) is how far the dimension line clears the anchor
 * nearest it: positive above (horizontal), right (vertical), or to the left of the direction
 * from the first point to the second (aligned); negative on the other side.
 */
export interface LinearDimensionInput extends DimensionBase {
  readonly kind: 'horizontal' | 'vertical' | 'aligned';
  readonly points: readonly [Vec2, Vec2];
  readonly offset: number;
}

/**
 * A radius or diameter on a circle (or arc) seen face on. `angle` is the direction (radians,
 * view coordinates) from the centre to the point where the terminator touches the circle;
 * default pi / 4. `textSide` (radius only): `'outside'` (default) runs the leader on out of the
 * circle; `'inside'` runs it back through the centre, for a concave fillet whose outside is
 * material.
 */
export interface CircleDimensionInput extends DimensionBase {
  readonly kind: 'radius' | 'diameter';
  readonly circle: { readonly center: Vec2; readonly radius: number };
  readonly angle?: number;
  readonly textSide?: 'outside' | 'inside';
}

/**
 * A diameter of a cylinder seen across its axis: the two silhouette lines. Laid out as an
 * aligned dimension across them, `offset` (paper mm) along the lines from the middle of the
 * first; positive is up along the lines (right when they are horizontal), whatever the order of
 * each line's points. Where that puts the dimension line past the end of a line, an extension
 * line runs to it from that line's nearer end. The value is the distance from the first line to
 * the second line's first point; when the second line's ends lie at different distances (the
 * lines are not parallel) the dimension is still laid out, with a `degenerate-dimension` warning.
 */
export interface SilhouetteDiameterInput extends DimensionBase {
  readonly kind: 'diameter';
  readonly lines: readonly [readonly [Vec2, Vec2], readonly [Vec2, Vec2]];
  readonly offset?: number;
}

/**
 * The angle between two legs from `vertex` through `points[0]` and `points[1]`: the one under
 * pi, measured counter-clockwise from one leg to the other. `radius` (paper mm) is the arc's
 * distance from the vertex.
 */
export interface AngleDimensionInput extends DimensionBase {
  readonly kind: 'angle';
  readonly vertex: Vec2;
  readonly points: readonly [Vec2, Vec2];
  readonly radius: number;
}

export type DimensionInput =
  LinearDimensionInput | CircleDimensionInput | SilhouetteDiameterInput | AngleDimensionInput;

export interface DimensionStyle {
  /** `'arrow'`: filled arrowheads (ISO, ASME); `'tick'`: oblique strokes (architectural, woodworking). */
  readonly terminator: 'arrow' | 'tick';
  /** Arrowhead length and full width, paper mm. */
  readonly arrowLength: number;
  readonly arrowWidth: number;
  /** Tick stroke length, paper mm. */
  readonly tickLength: number;
  /** Gap between the feature and the start of an extension line, paper mm. */
  readonly extensionGap: number;
  /** How far an extension line runs past the dimension line, paper mm. */
  readonly extensionOvershoot: number;
  /** Text cap height and the gap between text and the dimension line, paper mm. */
  readonly textHeight: number;
  readonly textGap: number;
  /**
   * `'aligned'`: text along the dimension line, above it, readable from the bottom or the right
   * (ISO 129-1 as usually quoted); `'horizontal'`: always horizontal, in a break in the line
   * (ASME Y14.5's unidirectional system as usually quoted). Neither standard was read.
   */
  readonly textOrientation: 'aligned' | 'horizontal';
  /** Leader length out of a circle and the length of its horizontal shoulder, paper mm. */
  readonly leaderLength: number;
  readonly shoulderLength: number;
}

/**
 * Defaults, our choice: 3.5 mm text (a size from the ISO 3098 series as usually quoted), arrows
 * 3 mm long and 1 mm wide (a 3:1 head, as ASME Y14.5 is usually quoted), a 1 mm gap and 2 mm
 * overshoot on extension lines. Not checked against the standards.
 */
export const DEFAULT_DIMENSION_STYLE: DimensionStyle = {
  terminator: 'arrow',
  arrowLength: 3,
  arrowWidth: 1,
  tickLength: 3,
  extensionGap: 1,
  extensionOvershoot: 2,
  textHeight: 3.5,
  textGap: 1,
  textOrientation: 'aligned',
  leaderLength: 6,
  shoulderLength: 3,
};

/**
 * Estimated width of a line of text, paper mm: 0.6 cap heights per character, a rough average
 * for Helvetica's digits and marks. The writers use real fonts; this only decides whether text
 * fits between arrows and how wide a break to leave.
 */
export function estimateTextWidth(text: string, height: number): number {
  return [...text].length * height * 0.6;
}

const LAYER: LayerName = 'dimension';

interface Ctx {
  readonly style: DimensionStyle;
  readonly owner: string;
  readonly items: DisplayItem[];
}

function line(ctx: Ctx, a: Vec2, b: Vec2): void {
  ctx.items.push({ kind: 'line', layer: LAYER, a, b, owner: ctx.owner });
}

/** A terminator with its tip at `tip`, pointing along `dir` (a unit vector). */
function terminator(ctx: Ctx, tip: Vec2, dir: Vec2): void {
  const s = ctx.style;
  if (s.terminator === 'tick') {
    // An oblique stroke at 45 degrees to the dimension line, turned counter-clockwise.
    const d = normalize(add(dir, perp(dir)));
    const h = s.tickLength / 2;
    line(ctx, sub(tip, mul(d, h)), add(tip, mul(d, h)));
    return;
  }
  ctx.items.push(arrowhead(tip, dir, s, ctx.owner));
}

/** A filled arrowhead on the dimension layer, its tip at `tip`, pointing along unit `dir`. */
export function arrowhead(
  tip: Vec2,
  dir: Vec2,
  style: Pick<DimensionStyle, 'arrowLength' | 'arrowWidth'>,
  owner: string,
): DisplayItem {
  const base = sub(tip, mul(dir, style.arrowLength));
  const n = mul(perp(dir), style.arrowWidth / 2);
  return {
    kind: 'polyline',
    layer: LAYER,
    points: [tip, add(base, n), sub(base, n)],
    closed: true,
    fill: true,
    owner,
  };
}

/** Text reads left to right or bottom to top: a direction turned into (-pi/2, pi/2]. */
function readable(angle: number): number {
  let a = normalizeAngle(angle);
  if (a > Math.PI / 2 + 1e-9 && a <= (3 * Math.PI) / 2 + 1e-9) a -= Math.PI;
  else if (a > (3 * Math.PI) / 2 + 1e-9) a -= 2 * Math.PI;
  return a;
}

function text(
  ctx: Ctx,
  at: Vec2,
  value: string,
  rotation: number,
  anchor: TextAnchor,
  baseline: 'bottom' | 'middle',
): void {
  ctx.items.push({
    kind: 'text',
    layer: 'text',
    at,
    text: value,
    height: ctx.style.textHeight,
    rotation,
    anchor,
    baseline,
    owner: ctx.owner,
  });
}

/**
 * Lays out a dimension line from `q1` to `q2` (paper) with the value: terminators at both ends,
 * inside when the line has room for both and the text, otherwise outside pointing in, with the
 * line extended past each end. Text sits at the middle, above the line as it reads (or in a
 * break in it for horizontal text); when it does not fit between the terminators it goes past
 * `q2`, with the line run out under it.
 */
function dimensionLine(ctx: Ctx, q1: Vec2, q2: Vec2, value: string): void {
  const s = ctx.style;
  const span = distance(q1, q2);
  const d = normalize(sub(q2, q1));
  const term = s.terminator === 'arrow' ? s.arrowLength : 0;
  const textWidth = estimateTextWidth(value, s.textHeight);
  const horizontalText = s.textOrientation === 'horizontal';
  // Horizontal text across a line that is not horizontal needs room for its projection.
  const along = horizontalText
    ? Math.abs(d[0]) * textWidth + Math.abs(d[1]) * s.textHeight
    : textWidth;
  const inside = span >= 2 * term + 2 * s.textGap + (horizontalText ? along : 0);
  const textInside = span >= 2 * term + along + 2 * s.textGap;
  const mid = mul(add(q1, q2), 0.5);
  const rotation = horizontalText ? 0 : readable(Math.atan2(d[1], d[0]));
  const up = polar(rotation + Math.PI / 2);

  let textAt: Vec2;
  let lineEnd = q2;
  if (textInside) textAt = mid;
  else {
    const past = s.terminator === 'arrow' ? 2 * term : s.tickLength;
    textAt = add(q2, mul(d, past + s.textGap + along / 2));
    lineEnd = add(q2, mul(d, past + s.textGap + along));
  }
  if (horizontalText) {
    // A break in the line around the text.
    const half = along / 2 + s.textGap;
    const t = dot(sub(textAt, q1), d);
    const start = inside ? q1 : sub(q1, mul(d, 2 * term));
    const end = textInside ? (inside ? q2 : add(q2, mul(d, 2 * term))) : lineEnd;
    const t0 = dot(sub(start, q1), d);
    const t1 = dot(sub(end, q1), d);
    if (t - half > t0) line(ctx, start, add(q1, mul(d, t - half)));
    if (t + half < t1) line(ctx, add(q1, mul(d, t + half)), end);
    text(ctx, textAt, value, 0, 'middle', 'middle');
  } else {
    const start = inside ? q1 : sub(q1, mul(d, 2 * term));
    const end = textInside ? (inside ? q2 : add(q2, mul(d, 2 * term))) : lineEnd;
    line(ctx, start, end);
    text(ctx, add(textAt, mul(up, s.textGap)), value, rotation, 'middle', 'bottom');
  }
  if (inside) {
    terminator(ctx, q1, mul(d, -1));
    terminator(ctx, q2, d);
  } else {
    terminator(ctx, q1, d);
    terminator(ctx, q2, mul(d, -1));
  }
}

/** An extension line from a feature point `p` to the dimension line at `q`, both paper. */
function extensionLine(ctx: Ctx, p: Vec2, q: Vec2): void {
  const s = ctx.style;
  const v = sub(q, p);
  const l = length(v);
  if (l <= s.extensionGap) return;
  const u = mul(v, 1 / l);
  line(ctx, add(p, mul(u, s.extensionGap)), add(q, mul(u, s.extensionOvershoot)));
}

/**
 * An extension line along the segment `a`-`b` (paper) to `q`, a point on the segment's line,
 * when `q` lies beyond either end: from the nearer end, with the usual gap and overshoot.
 * Nothing when `q` is on the segment.
 */
function silhouetteExtension(ctx: Ctx, a: Vec2, b: Vec2, q: Vec2): void {
  const len = distance(a, b);
  if (len === 0) return;
  const t = dot(sub(q, a), mul(sub(b, a), 1 / len));
  if (t < 0) extensionLine(ctx, a, q);
  else if (t > len) extensionLine(ctx, b, q);
}

function linear(
  ctx: Ctx,
  kind: LinearDimensionInput['kind'],
  p1: Vec2,
  p2: Vec2,
  offset: number,
  value: string,
): boolean {
  const dir: Vec2 =
    kind === 'horizontal' ? [1, 0] : kind === 'vertical' ? [0, 1] : normalize(sub(p2, p1));
  if (length(dir) === 0) return false;
  // Positive offsets go up (horizontal), right (vertical) or to the left of p1 -> p2 (aligned).
  const n: Vec2 = kind === 'vertical' ? [1, 0] : perp(dir);
  const h1 = dot(p1, n);
  const h2 = dot(p2, n);
  const level = offset >= 0 ? Math.max(h1, h2) + offset : Math.min(h1, h2) + offset;
  const q1 = add(p1, mul(n, level - h1));
  const q2 = add(p2, mul(n, level - h2));
  if (distance(q1, q2) === 0) return false;
  extensionLine(ctx, p1, q1);
  extensionLine(ctx, p2, q2);
  // Order the line left to right (or bottom to top) so text past the end goes right or up.
  const forward = dot(sub(q2, q1), dir) >= 0;
  dimensionLine(ctx, forward ? q1 : q2, forward ? q2 : q1, value);
  return true;
}

/**
 * A leader from `from` (paper) out along `u` to a shoulder and the text. The shoulder runs
 * left or right, whichever way `u` points (right when straight up or down).
 */
function leaderText(ctx: Ctx, from: Vec2, u: Vec2, value: string): void {
  const s = ctx.style;
  const elbow = add(from, mul(u, s.leaderLength));
  const right = u[0] >= -1e-12;
  const shoulderEnd = add(elbow, [right ? s.shoulderLength : -s.shoulderLength, 0]);
  line(ctx, from, elbow);
  line(ctx, elbow, shoulderEnd);
  text(
    ctx,
    add(shoulderEnd, [right ? s.textGap : -s.textGap, 0]),
    value,
    0,
    right ? 'start' : 'end',
    'middle',
  );
}

function circleDimension(
  ctx: Ctx,
  c: Vec2,
  r: number,
  angle: number,
  kind: 'radius' | 'diameter',
  value: string,
  textSide: 'outside' | 'inside',
): void {
  const s = ctx.style;
  const u = polar(angle);
  const rim = add(c, mul(u, r));
  const term = s.terminator === 'arrow' ? s.arrowLength : s.tickLength;
  if (kind === 'radius' && textSide === 'inside') {
    // From the rim back to the centre, the terminator on the rim pointing out, the leader on
    // past the centre.
    line(ctx, rim, c);
    terminator(ctx, rim, u);
    leaderText(ctx, c, mul(u, -1), value);
    return;
  }
  if (kind === 'radius') {
    if (r >= 2 * term) {
      // From the centre out to the rim, the terminator on the rim pointing out, then the leader.
      line(ctx, c, rim);
      terminator(ctx, rim, u);
    } else {
      // Small radius: the terminator outside, pointing in at the rim.
      terminator(ctx, rim, mul(u, -1));
    }
    leaderText(ctx, rim, u, value);
    return;
  }
  const far = sub(c, mul(u, r));
  if (2 * r >= 3 * term) {
    // Across the circle through the centre, terminators on both rims pointing out.
    line(ctx, far, rim);
    terminator(ctx, rim, u);
    terminator(ctx, far, mul(u, -1));
  } else {
    // Small circle: one terminator outside, pointing in at the rim.
    terminator(ctx, rim, mul(u, -1));
  }
  leaderText(ctx, rim, u, value);
}

function angleDimension(
  ctx: Ctx,
  v: Vec2,
  a: Vec2,
  b: Vec2,
  radius: number,
  value: string,
): boolean {
  const s = ctx.style;
  const da = sub(a, v);
  const db = sub(b, v);
  if (length(da) === 0 || length(db) === 0 || radius <= 0) return false;
  const angleA = Math.atan2(da[1], da[0]);
  const angleB = Math.atan2(db[1], db[0]);
  // The sweep under pi, counter-clockwise from one leg to the other.
  let sw = normalizeAngle(angleB - angleA);
  const start = sw > Math.PI ? angleB : angleA;
  if (sw > Math.PI) sw = 2 * Math.PI - sw;
  if (sw === 0) return false;
  const end = start + sw;
  // Arrows go outside, pointing in, when the arc is too short for both; the arc then runs on
  // past each end under them. Ticks always fit.
  const term = s.terminator === 'arrow' ? s.arrowLength : 0;
  const inside = term === 0 || radius * sw >= 2 * term + 2 * s.textGap;
  // Extension lines along the legs when the arc lies beyond them.
  for (const [p, ang] of [
    [a, angleA],
    [b, angleB],
  ] as const) {
    const lp = distance(p, v);
    if (radius > lp + s.extensionGap)
      line(
        ctx,
        add(v, polar(ang, lp + s.extensionGap)),
        add(v, polar(ang, radius + s.extensionOvershoot)),
      );
  }
  const run = inside ? 0 : (2 * term) / radius;
  ctx.items.push({
    kind: 'arc',
    layer: LAYER,
    center: v,
    radius,
    start: start - run,
    end: end + run,
    owner: ctx.owner,
  });
  // Terminators tangent to the arc at both ends, pointing out of it (or into it from outside).
  const out = inside ? 1 : -1;
  terminator(ctx, add(v, polar(start, radius)), polar(start - (out * Math.PI) / 2));
  terminator(ctx, add(v, polar(end, radius)), polar(end + (out * Math.PI) / 2));
  const mid = start + sw / 2;
  const at = add(v, polar(mid, radius + s.textGap));
  if (s.textOrientation === 'horizontal') {
    const c = Math.cos(mid);
    const anchor: TextAnchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
    const lift = Math.sin(mid) < 0 ? -s.textHeight : 0;
    text(ctx, add(at, [0, lift]), value, 0, anchor, 'bottom');
  } else {
    const rotation = readable(mid - Math.PI / 2);
    // Reading upside down around the arc's bottom half: keep the text outside the arc.
    const flipped = Math.abs(normalizeAngle(rotation - (mid - Math.PI / 2))) > 1e-9;
    const textAt = flipped ? add(v, polar(mid, radius + s.textGap + s.textHeight)) : at;
    text(ctx, textAt, value, rotation, 'middle', 'bottom');
  }
  return true;
}

/** Relative difference between the silhouette lines' end distances still taken as parallel. */
const PARALLEL_TOLERANCE = 1e-6;

/** `u` or its reverse: the one pointing up, or right when `u` is horizontal. */
function towardsUpRight(u: Vec2): Vec2 {
  const up = Math.abs(u[1]) > 1e-12 ? u[1] > 0 : u[0] > 0;
  return up ? u : mul(u, -1);
}

/** Whether `a` to `b` runs left to right, or bottom to top when it is vertical. */
function leftToRight(a: Vec2, b: Vec2): boolean {
  const d = sub(b, a);
  return Math.abs(d[0]) > 1e-9 * length(d) ? d[0] > 0 : d[1] >= 0;
}

function lineDistance(l1: readonly [Vec2, Vec2], p: Vec2): number {
  const d = normalize(sub(l1[1], l1[0]));
  return Math.abs(dot(sub(p, l1[0]), perp(d)));
}

/**
 * The display items of one dimension, in paper millimetres, given its view's transform. Returns
 * a warning instead when the anchors are degenerate (coincident points, a zero radius).
 */
export function layoutDimension(
  dim: DimensionInput,
  transform: Transform2,
  format: ValueFormat = {},
  style: DimensionStyle = DEFAULT_DIMENSION_STYLE,
): { items: DisplayItem[]; warning?: DrawingWarning } {
  const ctx: Ctx = { style, owner: dim.id, items: [] };
  const fmt = dim.format ?? format;
  const degenerate = (why: string) => ({
    items: [],
    warning: {
      code: 'degenerate-dimension' as const,
      subject: dim.id,
      message: `${dim.id}: ${why}`,
    },
  });
  const P = (p: Vec2) => applyPoint(transform, p);

  switch (dim.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned': {
      const [a, b] = dim.points;
      const measured =
        dim.kind === 'horizontal'
          ? Math.abs(b[0] - a[0])
          : dim.kind === 'vertical'
            ? Math.abs(b[1] - a[1])
            : distance(a, b);
      const value = dimensionText(formatDimensionLength(dim.value ?? measured, fmt), dim.text);
      if (measured === 0 && dim.value === undefined) return degenerate('the two points coincide');
      if (!linear(ctx, dim.kind, P(a), P(b), dim.offset, value))
        return degenerate('the two points coincide');
      return { items: ctx.items };
    }
    case 'radius':
    case 'diameter': {
      if ('lines' in dim) {
        const [l1, l2] = dim.lines;
        const raw = normalize(sub(l1[1], l1[0]));
        if (length(raw) === 0) return degenerate('a silhouette line has no length');
        // Along the lines upwards (rightwards when they are horizontal), whichever way the first
        // line's points run, so the sign of `offset` does not depend on their order.
        const dir = towardsUpRight(raw);
        const m1 = mul(add(l1[0], l1[1]), 0.5);
        const gapBetween = lineDistance(l1, l2[0]);
        if (gapBetween === 0) return degenerate('the silhouette lines coincide');
        const gapAtEnd = lineDistance(l1, l2[1]);
        const warning =
          Math.abs(gapAtEnd - gapBetween) > PARALLEL_TOLERANCE * Math.max(1, gapBetween)
            ? {
                code: 'degenerate-dimension' as const,
                subject: dim.id,
                message:
                  `${dim.id}: the silhouette lines are not parallel ` +
                  `(${+gapBetween.toFixed(4)} and ${+gapAtEnd.toFixed(4)} apart at the second line's ends); ` +
                  `measured at its first end`,
              }
            : undefined;
        // The point on line 2 across from the middle of line 1.
        const side = dot(sub(l2[0], m1), perp(dir)) >= 0 ? 1 : -1;
        const m2 = add(m1, mul(perp(dir), side * gapBetween));
        const shift = mul(dir, (dim.offset ?? 0) / transform.scale);
        const value = dimensionText(
          DIAMETER_SIGN + formatDimensionLength(dim.value ?? gapBetween, fmt),
          dim.text,
        );
        // An aligned dimension across the lines, its line placed along them by `offset`.
        const q1 = P(add(m1, shift));
        const q2 = P(add(m2, shift));
        // Where `offset` takes the dimension line past the end of a silhouette line, an extension
        // line runs from that line's nearer end to it.
        silhouetteExtension(ctx, P(l1[0]), P(l1[1]), q1);
        silhouetteExtension(ctx, P(l2[0]), P(l2[1]), q2);
        const [from, to] = leftToRight(q1, q2) ? [q1, q2] : [q2, q1];
        dimensionLine(ctx, from, to, value);
        return warning ? { items: ctx.items, warning } : { items: ctx.items };
      }
      const r = dim.circle.radius;
      if (!(r > 0)) return degenerate('the circle has no radius');
      const model = dim.value ?? (dim.kind === 'radius' ? r : 2 * r);
      const value = dimensionText(
        (dim.kind === 'radius' ? 'R' : DIAMETER_SIGN) + formatDimensionLength(model, fmt),
        dim.text,
      );
      circleDimension(
        ctx,
        P(dim.circle.center),
        r * transform.scale,
        dim.angle ?? Math.PI / 4,
        dim.kind,
        value,
        dim.textSide ?? 'outside',
      );
      return { items: ctx.items };
    }
    case 'angle': {
      const da = sub(dim.points[0], dim.vertex);
      const db = sub(dim.points[1], dim.vertex);
      const measured = Math.abs(Math.atan2(da[0] * db[1] - da[1] * db[0], dot(da, db)));
      const value = dimensionText(formatDimensionAngle(dim.value ?? measured, fmt), dim.text);
      if (
        !angleDimension(ctx, P(dim.vertex), P(dim.points[0]), P(dim.points[1]), dim.radius, value)
      )
        return degenerate('a leg has no length or the legs are parallel');
      return { items: ctx.items };
    }
  }
}
