// The Issues list of the print workspace (M3 plan, T3.1d): what may print badly, from the checks in
// `@manufakture/print`. Bed fit, overhangs and holes are cheap and run here on the main thread
// (ADR 0012 decision 5); wall thickness and gaps come from the print-analysis worker's reply.
// Each issue names the bodies and faces it is about, so a click can select and frame them, and
// carries its worst value. Lists only what applies: an empty list means nothing was found, which
// the panel says in the "may print badly, never will fail" wording of ADR 0012 decision 3.
//
// Overhangs are measured on the placed body with the bed at z = 0 (`bedZ: 0`), so a body of a
// several-body item that does not reach the bed is not taken for resting on it.

import type { DisplayUnits } from '@manufakture/core';
import {
  OVERHANG_CLASSES,
  analyzeHoles,
  classifyOverhangs,
  type BedFitResult,
  type OverhangResult,
  type PrintAnalysisBodyResult,
  type ThicknessIssue,
} from '@manufakture/print';
import { formatKind } from '../components/expression';
import type { ResolvedItem, ResolvedSetup } from './resolve';
import { printViewId } from './resolve';

export type IssueKind =
  'bedFit' | 'overhang' | 'belowMinFeature' | 'thinWall' | 'narrowGap' | 'smallHole' | 'teardrop';

/** The order kinds are listed in, worst first. */
export const ISSUE_ORDER: readonly IssueKind[] = [
  'bedFit',
  'overhang',
  'belowMinFeature',
  'thinWall',
  'narrowGap',
  'smallHole',
  'teardrop',
];

export const ISSUE_TITLES: Readonly<Record<IssueKind, string>> = {
  bedFit: 'Does not fit the bed',
  overhang: 'Overhang',
  belowMinFeature: 'Too thin to print',
  thinWall: 'Thin wall',
  narrowGap: 'Narrow gap',
  smallHole: 'Small hole',
  teardrop: 'Horizontal hole: teardrop or support',
};

/** Faces of one drawn body: a print view id and 1-based face indices (all faces when empty). */
export interface IssueTarget {
  viewId: string;
  faces: number[];
}

export interface PrintIssue {
  /** Stable while the issue is the same issue: kind, item and what it is about. */
  key: string;
  kind: IssueKind;
  itemId: string;
  /** The item's label. */
  item: string;
  /** The worst value, formatted: `0.50 mm`, `90.00°`, `x 20.00 mm`. */
  worst: string;
  /** One line on what was found. */
  detail: string;
  /** What a click selects and frames; copy 0 of the item. */
  targets: IssueTarget[];
}

/** Overhang classes per body of copy 0 of each item, by print view id. */
export type OverhangMap = ReadonlyMap<string, OverhangResult>;

/** The overhang classes of every drawn body of copy 0 (the copies are the same shape). */
export function overhangsOf(resolved: ResolvedSetup): Map<string, OverhangResult> {
  const out = new Map<string, OverhangResult>();
  for (const item of resolved.items) {
    const copy = item.copies[0];
    if (!copy) continue;
    for (const b of item.bodies) {
      out.set(
        printViewId(item.item.id, copy.copy, b.sourceId),
        classifyOverhangs(b.input.mesh, {
          placement: copy.placement,
          threshold: resolved.overhang,
          bedZ: 0,
        }),
      );
    }
  }
  return out;
}

const OVERHANG = OVERHANG_CLASSES.indexOf('overhang');
const FLAT = OVERHANG_CLASSES.indexOf('downwardFlat');

function areaText(mm2: number, units: DisplayUnits): string {
  const inch =
    units.length.unit === 'in' ||
    units.length.unit === 'ft-in' ||
    units.length.unit === 'in-fraction';
  return inch ? `${(mm2 / 645.16).toFixed(3)} in²` : `${mm2.toFixed(1)} mm²`;
}

const length = (mm: number, units: DisplayUnits) => formatKind(mm, 'length', units);
const angle = (rad: number, units: DisplayUnits) => formatKind(rad, 'angle', units);

/**
 * Why a bed fit fails, in words, and its worst value. An item too big for the usable area is
 * only said to be too big: the excluded areas its centred spot also overlaps are beside the
 * point, since it fits nowhere. The excluded areas are named only for an item small enough that
 * no spot clear of them was found.
 */
export function bedFitReasons(
  fit: BedFitResult,
  units: DisplayUnits,
): { worst: string; reasons: string[] } {
  const axes = (['x', 'y', 'z'] as const).filter((a) => fit.overshoot[a] > 0);
  const parts = axes.map((a) => `${a} ${length(fit.overshoot[a], units)}`);
  const reasons: string[] = [];
  if (parts.length > 0) reasons.push(`too big by ${parts.join(', ')}`);
  else if (fit.exclusions.length > 0) {
    reasons.push(`no spot clear of ${fit.exclusions.map((e) => e.name.toLowerCase()).join(', ')}`);
  }
  if (fit.region.area.length === 0) reasons.push('the nozzles it needs share no printable area');
  if (fit.region.unknownNozzles.length > 0) reasons.push('it needs a nozzle the printer lacks');
  return {
    worst: parts.join(', ') || (fit.exclusions.length > 0 ? 'excluded area' : ''),
    reasons,
  };
}

function bedFitIssue(item: ResolvedItem, units: DisplayUnits): PrintIssue | null {
  const fit = item.fit;
  if (!fit || fit.fits) return null;
  const { worst, reasons } = bedFitReasons(fit, units);
  const copy = item.copies[0]?.copy ?? 0;
  return {
    key: `bedFit:${item.item.id}`,
    kind: 'bedFit',
    itemId: item.item.id,
    item: item.label,
    worst,
    detail: `${reasons.join('; ')}.`,
    targets: item.bodies.map((b) => ({
      viewId: printViewId(item.item.id, copy, b.sourceId),
      faces: [],
    })),
  };
}

function overhangIssue(
  item: ResolvedItem,
  overhangs: OverhangMap,
  threshold: number,
  units: DisplayUnits,
): PrintIssue | null {
  const copy = item.copies[0];
  if (!copy) return null;
  let area = 0;
  let worst = -Infinity;
  const targets: IssueTarget[] = [];
  for (const b of item.bodies) {
    const viewId = printViewId(item.item.id, copy.copy, b.sourceId);
    const r = overhangs.get(viewId);
    if (!r) continue;
    const faces: number[] = [];
    if (r.faces.length > 0) {
      for (const f of r.faces) {
        const a = f.areas.overhang + f.areas.downwardFlat;
        if (a <= 0) continue;
        area += a;
        worst = Math.max(worst, f.maxAngle);
        faces.push(f.face);
      }
    } else {
      // No face ids: count the triangles.
      for (let k = 0; k < r.classes.length; k++) {
        if (r.classes[k] === OVERHANG || r.classes[k] === FLAT)
          worst = Math.max(worst, r.angles[k]!);
      }
    }
    if (faces.length > 0) targets.push({ viewId, faces });
  }
  if (targets.length === 0) return null;
  const flat = worst >= Math.PI / 2 - 1e-6;
  return {
    key: `overhang:${item.item.id}`,
    kind: 'overhang',
    itemId: item.item.id,
    item: item.label,
    worst: angle(worst, units),
    detail:
      `${areaText(area, units)} steeper than ${angle(threshold, units)} from vertical` +
      (flat ? ', including flat ceilings that need a bridge or support.' : '.'),
    targets,
  };
}

const THICKNESS_DETAIL: Record<'belowMinFeature' | 'thinWall' | 'narrowGap', string> = {
  belowMinFeature: 'thinner than the slicer prints at all',
  thinWall: 'thinner than two lines',
  narrowGap: 'a gap narrower than the minimum, which may fuse',
};

function thicknessIssues(
  item: ResolvedItem,
  { bodies, issues, meshes }: ThicknessReply,
  minimum: { minFeature: number; minWall: number; minGap: number },
  units: DisplayUnits,
): PrintIssue[] {
  const copy = item.copies[0];
  if (!copy) return [];
  const ids = new Map(
    item.bodies.map((b) => [printViewId(item.item.id, copy.copy, b.sourceId), b] as const),
  );
  const out: PrintIssue[] = [];
  for (const kind of ['belowMinFeature', 'thinWall', 'narrowGap'] as const) {
    let worst = Infinity;
    let area = 0;
    const byView = new Map<string, number[]>();
    for (const issue of issues) {
      if (issue.kind !== kind) continue;
      const viewId = bodies[issue.body]?.id;
      const body = viewId === undefined ? undefined : ids.get(viewId);
      if (viewId === undefined || !body || meshes[issue.body] !== body.input.mesh) continue;
      worst = Math.min(worst, issue.value);
      area += issue.area;
      const faces = byView.get(viewId) ?? [];
      if (issue.face > 0) faces.push(issue.face);
      byView.set(viewId, faces);
    }
    if (byView.size === 0) continue;
    const limit =
      kind === 'belowMinFeature'
        ? minimum.minFeature
        : kind === 'thinWall'
          ? minimum.minWall
          : minimum.minGap;
    out.push({
      key: `${kind}:${item.item.id}`,
      kind,
      itemId: item.item.id,
      item: item.label,
      worst: length(worst, units),
      detail: `${areaText(area, units)} ${THICKNESS_DETAIL[kind]} (${length(limit, units)}).`,
      targets: [...byView].map(([viewId, faces]) => ({ viewId, faces })),
    });
  }
  return out;
}

function holeIssues(
  item: ResolvedItem,
  thresholds: { minHole: number; teardrop: number },
  units: DisplayUnits,
): PrintIssue[] {
  const copy = item.copies[0];
  if (!copy) return [];
  const out: PrintIssue[] = [];
  for (const b of item.bodies) {
    const topology = b.input.topology;
    if (!topology) continue;
    const viewId = printViewId(item.item.id, copy.copy, b.sourceId);
    const report = analyzeHoles(topology, {
      placement: copy.placement,
      thresholds,
      names: { faceNames: b.input.mesh.faceNames, names: b.input.names },
    });
    for (const issue of report.issues) {
      const d = length(issue.diameter, units);
      out.push({
        key: `${issue.kind}:${item.item.id}:${b.bodyId}:${issue.faces.join(',')}`,
        kind: issue.kind,
        itemId: item.item.id,
        item: item.label,
        worst: d,
        detail:
          issue.kind === 'smallHole'
            ? `A ${d} hole, below the minimum of ${length(issue.minimum, units)}: it may close up.`
            : `A ${d} hole lying horizontal, above ${length(issue.teardrop, units)}: its top needs a teardrop shape or support.`,
        targets: [{ viewId, faces: issue.faces }],
      });
    }
  }
  return out;
}

/** The analysis worker's reply as the issue list needs it. */
export interface ThicknessReply {
  bodies: readonly PrintAnalysisBodyResult[];
  issues: readonly ThicknessIssue[];
  /**
   * Per body, in order: the mesh object its values were computed on. A body whose drawn mesh is
   * another object now (an edit, or the export mesh replacing the coarse one) is left out until
   * the next reply: its per-triangle values and face numbers belong to the old mesh.
   */
  meshes: readonly object[];
}

/** Every issue of a resolved setup, worst kind first, items in setup order within a kind. */
export function printIssues(
  resolved: ResolvedSetup,
  overhangs: OverhangMap,
  thickness: ThicknessReply | null,
  units: DisplayUnits,
): PrintIssue[] {
  if (!resolved.printer) return [];
  const all: PrintIssue[] = [];
  for (const item of resolved.items) {
    const fit = bedFitIssue(item, units);
    if (fit) all.push(fit);
    const overhang = overhangIssue(item, overhangs, resolved.overhang, units);
    if (overhang) all.push(overhang);
    if (thickness) {
      all.push(...thicknessIssues(item, thickness, resolved.thresholds, units));
    }
    all.push(...holeIssues(item, resolved.thresholds, units));
  }
  return all
    .map((issue, i) => ({ issue, i }))
    .sort(
      (a, b) => ISSUE_ORDER.indexOf(a.issue.kind) - ISSUE_ORDER.indexOf(b.issue.kind) || a.i - b.i,
    )
    .map((x) => x.issue);
}
