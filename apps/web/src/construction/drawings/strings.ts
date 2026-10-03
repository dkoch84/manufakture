// A construction view's dimension strings in the drawing workspace (M6 plan T6.4b; ADR 0015
// decision 11): strings are derived by the domain at every request and never stored, so a user
// who wants one gone hides it (the view's params list it in `hide`), and a user who wants to edit
// one converts it: the string becomes ordinary dimensions, one per span and its overall, measured
// between layer corners (vertices of the wall layer bodies the view projects), placed where the
// string was, and the string is hidden in the same undo step. They then follow the model by name
// like any dimension (a moved door moves its jamb corners) and can be dragged, re-picked or deleted.
//
// A framing elevation projects no bodies (its members are drawn from data), so its strings have
// nothing to measure from: they can be hidden, not converted. The same holds for a string point
// with no layer corner on it (a wall with no sheathing): the conversion says which point.
//
// Bounds: a string converts to at most `MAX_CONVERTED` dimensions; the view's corners are sorted
// once and each point's candidates found by binary search, at most `MAX_CANDIDATES` kept.

import {
  DIMENSION_COUNTER,
  isDomainViewSource,
  previewIds,
  type Command,
  type Dimension,
  type DimensionRef,
  type DomainViewSource,
  type Drawing,
  type DrawingView,
  type Sheet,
} from '@manufakture/core';
import { DEFAULT_DIMENSION_STYLE } from '@manufakture/drawing';
import { readViewParams } from '@manufakture/domain-construction';
import type { DrawingViewResult } from '@manufakture/regen';
import { linearOffset, scaleFactorOf, viewToPaper, type Vec2 } from '../../drawing/model';
import { CONSTRUCTION_DOMAIN } from '../kinds';

/** The most dimensions one conversion makes. */
export const MAX_CONVERTED = 200;
/** The most layer corners a view's conversion looks at. */
const MAX_CORNERS = 100_000;
/** Candidate corners kept per string point. */
const MAX_CANDIDATES = 64;
/** How near (model mm) a corner must be to a string point along the string, and across it. */
const TOLERANCE = 0.05;

type Vec3 = readonly [number, number, number];
type Chain = NonNullable<DrawingViewResult['chains']>[number];

/** The view's source when it is a construction view, else null. */
export function constructionSource(view: DrawingView): DomainViewSource | null {
  return isDomainViewSource(view.source) && view.source.domain === CONSTRUCTION_DOMAIN
    ? view.source
    : null;
}

/** The ids of the strings a construction view hides. */
export function hiddenStrings(view: DrawingView): readonly string[] {
  const source = constructionSource(view);
  if (!source) return [];
  const p = readViewParams(source.params, source.schemaVersion);
  return p.ok ? p.value.hide : [];
}

/** A string's id as the view's params name it: the chain id without its `<view id>/` prefix. */
export function stringId(view: Pick<DrawingView, 'id'>, chain: Pick<Chain, 'id'>): string {
  const prefix = `${view.id}/`;
  return chain.id.startsWith(prefix) ? chain.id.slice(prefix.length) : chain.id;
}

/** What a string is, in words: `extension#1:s1:openings` as `Front, segment 1: rough openings`. */
export function stringLabel(id: string, names: ReadonlyMap<string, string>): string {
  const parts = id.split(':');
  const feature = names.get(parts[0]!) ?? parts[0]!;
  const what: Record<string, string> = {
    centres: 'opening centres',
    openings: 'rough openings',
    overall: 'overall',
    along: 'along the wall',
    up: 'up the side',
    eave: 'along the eave',
    end: 'across the gable end',
    pitch: 'pitch',
  };
  const seg = parts.find((p) => /^s\d+$/.test(p));
  const kind = parts.slice(1).find((p) => !/^s\d+$/.test(p));
  return [feature, seg ? `segment ${seg.slice(1)}` : null, kind ? (what[kind] ?? kind) : null]
    .filter(Boolean)
    .join(', ');
}

/** The view with its params' `hide` list changed: `id` hidden or shown. Null when it is not ours. */
function withHidden(
  view: DrawingView,
  ids: readonly string[],
  hidden: boolean,
): DrawingView | null {
  const source = constructionSource(view);
  if (!source) return null;
  const before = hiddenStrings(view);
  const hide = hidden
    ? [...before, ...ids.filter((id) => !before.includes(id))]
    : before.filter((id) => !ids.includes(id));
  const params: Record<string, unknown> = { ...source.params };
  if (hide.length > 0) params.hide = hide;
  else delete params.hide;
  return { ...view, source: { ...source, params: params as DomainViewSource['params'] } };
}

/** The command that hides (or shows again) strings of a construction view. */
export function hideStringsCommand(
  drawing: Drawing,
  sheet: Sheet,
  view: DrawingView,
  ids: readonly string[],
  hidden: boolean,
): { command: Command; label: string } | null {
  const next = withHidden(view, ids, hidden);
  if (!next) return null;
  const what = ids.length === 1 ? ids[0]! : `${ids.length} strings`;
  return {
    command: { type: 'editView', drawingId: drawing.id, sheetId: sheet.id, view: next },
    label: `${hidden ? 'Hide' : 'Show'} ${what} in ${view.id}`,
  };
}

interface Corner {
  ref: DimensionRef;
  /** Along the string, across it, and the depth towards the viewer, model mm. */
  along: number;
  across: number;
  depth: number;
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/** The first index of `sorted` (by `along`) at or past `x`. */
function lowerBound(sorted: readonly Corner[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.along < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Conversion =
  | { ok: true; command: Command; label: string; dimensionIds: string[] }
  | { ok: false; message: string };

/**
 * The command that turns a construction view's string into ordinary dimensions and hides the
 * string (one undo step). `viewResult` is the view as regen last drew it, with picking data.
 */
export function convertStringCommand(
  drawing: Drawing,
  sheet: Sheet,
  view: DrawingView,
  viewResult: DrawingViewResult | undefined,
  chainId: string,
): Conversion {
  if (!constructionSource(view))
    return { ok: false, message: `${view.id} is not a construction view.` };
  const chain = viewResult?.chains?.find((c) => c.id === chainId);
  const id = stringId(view, { id: chainId });
  if (!viewResult || !chain) return { ok: false, message: `${id} is not drawn in ${view.id} now.` };
  const s = scaleFactorOf(viewResult);
  const pick = viewResult.pick;
  if (s === null) return { ok: false, message: `The scale of ${view.id} does not evaluate.` };
  if (!pick || pick.items.length === 0) {
    return {
      ok: false,
      message: `${view.id} draws no layer bodies to measure from (a framing elevation draws its members from data): hide the string instead.`,
    };
  }
  // The string's points, repeats dropped, and its direction in the view.
  const points: Vec2[] = [];
  for (const p of chain.points)
    if (points.length === 0 || Math.hypot(...sub2(p, points[points.length - 1]!)) > 1e-6)
      points.push(p);
  if (points.length < 2) return { ok: false, message: `${id} has no length to convert.` };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let dir: Vec2;
  if (chain.kind === 'horizontal') dir = [1, 0];
  else if (chain.kind === 'vertical') dir = [0, 1];
  else {
    const d = sub2(last, first);
    const n = Math.hypot(d[0], d[1]);
    dir = [d[0] / n, d[1] / n];
  }
  const across: Vec2 = [-dir[1], dir[0]];
  const overall = chain.overall ?? points.length > 2;
  const spans = points.length - 1 + (overall ? 1 : 0);
  if (spans > MAX_CONVERTED)
    return { ok: false, message: `${id} has ${spans} spans; at most ${MAX_CONVERTED} convert.` };

  // Every layer corner of the view, in the string's terms, sorted along it.
  const f = pick.frame;
  const corners: Corner[] = [];
  for (const item of pick.items) {
    const target = {
      body: item.body,
      ...(item.instance === undefined ? {} : { instance: [item.instance] }),
    };
    for (const v of item.vertices) {
      if (corners.length >= MAX_CORNERS) break;
      const p = v.point as Vec3;
      const o = f.origin as Vec3;
      const r: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const at: Vec2 = [
        r[0] * f.x[0] + r[1] * f.x[1] + r[2] * f.x[2],
        r[0] * f.y[0] + r[1] * f.y[1] + r[2] * f.y[2],
      ];
      corners.push({
        ref: { vertex: v.ref, ...target } as DimensionRef,
        along: dot2(at, dir),
        across: dot2(at, across),
        depth: r[0] * f.z[0] + r[1] * f.z[1] + r[2] * f.z[2],
      });
    }
  }
  corners.sort((a, b) => a.along - b.along);
  const line = dot2(first, across);
  const candidates = points.map((p) => {
    const at = dot2(p, dir);
    const out: Corner[] = [];
    for (let i = lowerBound(corners, at - TOLERANCE); i < corners.length; i++) {
      const c = corners[i]!;
      if (c.along > at + TOLERANCE) break;
      out.push(c);
    }
    // The nearest the string's line first.
    out.sort((a, b) => Math.abs(a.across - line) - Math.abs(b.across - line));
    return out.slice(0, MAX_CANDIDATES);
  });
  const missing = candidates.findIndex((c) => c.length === 0);
  if (missing >= 0) {
    return {
      ok: false,
      message: `Point ${missing + 1} of ${id} has no layer corner to measure from: hide the string instead.`,
    };
  }

  /** The two corners a span measures between: on one line square to the string when aligned. */
  const pair = (i: number, j: number): [Corner, Corner] | null => {
    let best: { a: Corner; b: Corner; score: number } | null = null;
    for (const a of candidates[i]!)
      for (const b of candidates[j]!) {
        if (chain.kind === 'aligned' && Math.abs(a.across - b.across) > TOLERANCE) continue;
        // Same depth first (no foreshortening warning), then nearest the string's line.
        const score =
          (Math.abs(a.depth - b.depth) > TOLERANCE ? 1e9 : 0) +
          Math.abs(a.across - line) +
          Math.abs(b.across - line);
        if (!best || score < best.score) best = { a, b, score };
      }
    return best ? [best.a, best.b] : null;
  };

  // Where the string's rows are on paper (as `packages/drawing` lays a chain out): the first row
  // `offset` past the farthest point on its side, the overall a row gap further.
  const paper = (v: Vec2) => viewToPaper(view, s, v);
  const n: Vec2 = chain.kind === 'vertical' ? [1, 0] : across;
  const outward = chain.offset >= 0 ? 1 : -1;
  const heights = points.map((p) => dot2(paper(p), n));
  const level = (outward > 0 ? Math.max(...heights) : Math.min(...heights)) + chain.offset;
  const style = DEFAULT_DIMENSION_STYLE;
  const gap = chain.rowGap ?? 2 * style.textHeight + 2 * style.textGap + 1;
  const kind = chain.kind;

  const ids = previewIds(drawing.nextIds, DIMENSION_COUNTER, spans);
  const dimensions: Dimension[] = [];
  const spanList: [number, number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) spanList.push([i, i + 1, level]);
  if (overall) spanList.push([0, points.length - 1, level + outward * gap]);
  for (const [k, [i, j, row]] of spanList.entries()) {
    const got = pair(i, j);
    if (!got) {
      return {
        ok: false,
        message: `${id}: no two layer corners measure from point ${i + 1} to point ${j + 1}.`,
      };
    }
    const [a, b] = got;
    // Anchors on paper as regen will project them (the corners), and the pointer on the row.
    const pa = paper(add(scaleAlong(dir, a.along), scaleAlong(across, a.across)));
    const pb = paper(add(scaleAlong(dir, b.along), scaleAlong(across, b.across)));
    const pointer: Vec2 = add(pa, scaleAlong(n, row - dot2(pa, n)));
    dimensions.push({
      id: ids[k]!,
      view: view.id,
      kind,
      refs: [a.ref, b.ref],
      offset: linearOffset(kind, pa, pb, pointer),
    });
  }
  const hide = hideStringsCommand(drawing, sheet, view, [id], true)!;
  return {
    ok: true,
    command: {
      type: 'batch',
      commands: [
        ...dimensions.map((dimension): Command => ({
          type: 'addDimension',
          drawingId: drawing.id,
          sheetId: sheet.id,
          dimension,
        })),
        hide.command,
      ],
    },
    label: `Convert ${id} in ${view.id} to dimensions`,
    dimensionIds: ids,
  };
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scaleAlong = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
