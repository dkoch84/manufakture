// SVG outlines (M5 T5.8, ADR 0012 decision 7): the region loops of an outline entity whose
// source is SVG artwork. The paths come from the document, which is untrusted on every load, so
// everything here is bounded: the commands of one outline by `MAX_SVG_OUTLINE_COMMANDS` (core
// refuses more at load, and caps all the SVG outlines of a sketch together; this package does
// not), and the work of all the conversions of one outline by one shared `OutlineBudget`. A
// caller converting many outlines passes one budget for all of them (regen does, one per regen
// pass; the sketcher one per preview pass), so many outlines that are each costly cannot add up.
//
// Each path is first converted alone with its own fill rule, which makes clean loops (outer ones
// counter-clockwise, holes clockwise), and those loops are then converted together under the
// nonzero rule, which merges what overlaps: the union of every path's filled area, as the file
// draws it. An evenodd path whose holes run the same way as its outline, or two paths drawn in
// opposite directions, come out right this way, where one nonzero pass over the raw paths would not.
//
// Results are cached per paths array (a document keeps the same array until the source changes)
// and scale, so a regen that only moves the anchor, or another regen of an unchanged sketch,
// converts nothing again. A result refused because a shared budget ran out is not cached: it
// says nothing about the outline itself.

import type { PathCommand, SvgOutlinePath, Vec2 } from './model';
import {
  OutlineBudget,
  outlinePartsRegions,
  outlineRegions,
  type OutlineLoop,
  type OutlinePartIssue,
  type OutlinePartsResult,
} from './outline';

/** Most path commands one SVG outline may have (core refuses more when a document loads). */
export const MAX_SVG_OUTLINE_COMMANDS = 100_000;

/** Scales kept per paths array: the last few, for a scale being typed or a variable edited. */
const CACHED_SCALES = 4;

const cache = new WeakMap<readonly SvgOutlinePath[], Map<number, OutlinePartsResult>>();

function tooComplex(message: string): OutlinePartsResult {
  return {
    regions: [],
    issues: [{ code: 'too-complex', severity: 'error', message, parts: [], contours: [] }],
  };
}

/** A clean loop of `outlineRegions` as path commands. */
function loopCommands(loop: OutlineLoop, out: PathCommand[]): void {
  const first = loop.segments[0];
  if (!first) return;
  const startOf = (s: OutlineLoop['segments'][number]): Vec2 =>
    s.kind === 'bezier' ? s.points[0]! : s.start;
  out.push({ kind: 'moveTo', to: startOf(first) });
  for (const s of loop.segments) {
    if (s.kind === 'bezier') {
      const p = s.points;
      if (p.length === 3) out.push({ kind: 'quadTo', control: p[1]!, to: p[2]! });
      else out.push({ kind: 'cubicTo', control1: p[1]!, control2: p[2]!, to: p[3]! });
    } else {
      // No arcs: `outlineRegions` makes them only when asked.
      out.push({ kind: 'lineTo', to: s.end });
    }
  }
  out.push({ kind: 'close' });
}

function scaled(commands: readonly PathCommand[], k: number): PathCommand[] {
  if (k === 1) return commands as PathCommand[];
  const p = (v: Vec2): Vec2 => [v[0] * k, v[1] * k];
  return commands.map((c): PathCommand => {
    switch (c.kind) {
      case 'close':
        return c;
      case 'moveTo':
      case 'lineTo':
        return { kind: c.kind, to: p(c.to) };
      case 'quadTo':
        return { kind: 'quadTo', control: p(c.control), to: p(c.to) };
      case 'cubicTo':
        return {
          kind: 'cubicTo',
          control1: p(c.control1),
          control2: p(c.control2),
          to: p(c.to),
        };
    }
  });
}

/**
 * The regions of an SVG outline's paths at `scale`, in the outline's own frame (the anchor at
 * the origin, unturned), ready for `placeOutline` with each path's index as its `glyph`. Issues
 * name paths by index (`parts`). An `error` issue means no regions.
 */
export function svgOutlineRegions(
  paths: readonly SvgOutlinePath[],
  scale: number,
  options: { budget?: OutlineBudget } = {},
): OutlinePartsResult {
  if (!(Number.isFinite(scale) && scale > 0)) {
    return tooComplex(`The scale must be a number above 0, not ${scale}.`);
  }
  const known = cache.get(paths)?.get(scale);
  if (known) return known;

  let commands = 0;
  for (const p of paths) commands += p.commands.length;
  let result: OutlinePartsResult;
  if (commands > MAX_SVG_OUTLINE_COMMANDS) {
    result = tooComplex(
      `The artwork has ${commands.toLocaleString('en')} path commands, more than the ${MAX_SVG_OUTLINE_COMMANDS.toLocaleString('en')} an outline may have.`,
    );
  } else {
    result = convert(paths, scale, options.budget ?? new OutlineBudget());
  }
  if (options.budget?.exhausted && result.issues.some((i) => i.code === 'too-complex')) {
    // Refused for the shared budget, which other outlines spent too: not this outline's result.
    return result;
  }

  let byScale = cache.get(paths);
  if (!byScale) {
    byScale = new Map();
    cache.set(paths, byScale);
  }
  if (byScale.size >= CACHED_SCALES) byScale.delete(byScale.keys().next().value!);
  byScale.set(scale, result);
  return result;
}

function convert(
  paths: readonly SvgOutlinePath[],
  scale: number,
  budget: OutlineBudget,
): OutlinePartsResult {
  // One budget for every call: many small paths cannot add up to unbounded work.
  const issues: OutlinePartIssue[] = [];
  const clean: PathCommand[][] = [];
  for (const [part, path] of paths.entries()) {
    const own = outlineRegions(scaled(path.commands, scale), { fillRule: path.fillRule, budget });
    for (const issue of own.issues) {
      // Touching and merging are reported again, between paths too, by the second pass.
      if (issue.code === 'touching' || issue.code === 'merged') continue;
      issues.push({
        ...issue,
        parts: [part],
        contours: issue.contours.map((c): [number, number] => [part, c]),
      });
    }
    const out: PathCommand[] = [];
    for (const r of own.regions) {
      loopCommands(r.outer, out);
      for (const h of r.holes) loopCommands(h, out);
    }
    clean.push(out);
  }
  if (issues.some((i) => i.severity === 'error')) return { regions: [], issues: grouped(issues) };
  const merged = outlinePartsRegions(clean, { budget });
  return { regions: merged.regions, issues: grouped([...issues, ...merged.issues]) };
}

/** Contours (or places) a grouped issue names; the rest are counted. */
export const SVG_ISSUE_EXAMPLES = 3;

/** The lead of a grouped issue for `n` (formatted, above 1) issues of a code. */
const GROUP_LEADS: Partial<Record<OutlinePartIssue['code'], (n: string) => string>> = {
  'open-contour': (n) =>
    `${n} contours do not end where they start; they are closed with straight segments`,
  'empty-contour': (n) => `${n} contours enclose no area; they are ignored`,
  touching: (n) =>
    `Loops of the outline touch at a single point in ${n} places; they are kept as separate loops, but a solid made from them is non-manifold there`,
  merged: (n) => `Contours that cross or touch were merged into one outline in ${n} places`,
};

/**
 * One issue per code and severity, however many contours have it: artwork of 30,000 open
 * subpaths makes one warning with a count and a few examples, not 30,000 (each of which regen
 * would send and the sketcher would list).
 */
function grouped(issues: readonly OutlinePartIssue[]): OutlinePartIssue[] {
  const byCode = new Map<string, OutlinePartIssue[]>();
  for (const issue of issues) {
    const key = `${issue.code}|${issue.severity}`;
    const list = byCode.get(key);
    if (list) list.push(issue);
    else byCode.set(key, [issue]);
  }
  const out: OutlinePartIssue[] = [];
  for (const list of byCode.values()) {
    const first = list[0]!;
    if (list.length === 1) {
      out.push(first);
      continue;
    }
    const n = list.length;
    const lead =
      GROUP_LEADS[first.code]?.(n.toLocaleString('en')) ??
      `${first.message.replace(/\.$/, '')} (${n.toLocaleString('en')} times)`;
    const examples: string[] = [];
    const contours: [number, number][] = [];
    for (const issue of list) {
      const c = issue.contours[0];
      if (!c) continue;
      const text = `shape ${c[0] + 1} contour ${c[1]}`;
      if (examples.includes(text)) continue;
      examples.push(text);
      contours.push(c);
      if (examples.length === SVG_ISSUE_EXAMPLES) break;
    }
    const rest = n - examples.length;
    const message =
      examples.length === 0
        ? `${lead}.`
        : `${lead}, for example ${examples.join(', ')}${rest > 0 ? `, and ${rest.toLocaleString('en')} more` : ''}.`;
    out.push({
      code: first.code,
      severity: first.severity,
      message,
      parts: [...new Set(contours.map(([part]) => part))],
      contours,
      ...(first.point ? { point: first.point } : {}),
    });
  }
  return out.map(trimmed);
}

/**
 * An issue naming at most `SVG_ISSUE_EXAMPLES` paths and contours, the true number of paths in
 * `partCount`: one crossing, touching or too-complex issue may involve every path of the artwork,
 * and regen names each path it lists.
 */
function trimmed(issue: OutlinePartIssue): OutlinePartIssue {
  if (issue.parts.length <= SVG_ISSUE_EXAMPLES && issue.contours.length <= SVG_ISSUE_EXAMPLES) {
    return issue;
  }
  return {
    ...issue,
    parts: issue.parts.slice(0, SVG_ISSUE_EXAMPLES),
    contours: issue.contours.slice(0, SVG_ISSUE_EXAMPLES),
    ...(issue.parts.length > SVG_ISSUE_EXAMPLES
      ? { partCount: issue.partCount ?? issue.parts.length }
      : {}),
  };
}

/** The paths an issue names, 1-based, as "1, 2, 3 and 19,997 more"; '' for none. */
export function svgIssueShapes(issue: Pick<OutlinePartIssue, 'parts' | 'partCount'>): string {
  if (issue.parts.length === 0) return '';
  const listed = issue.parts.map((p) => p + 1).join(', ');
  const more = (issue.partCount ?? issue.parts.length) - issue.parts.length;
  return more > 0 ? `${listed} and ${more.toLocaleString('en')} more` : listed;
}
