// The wall check around holes (#1210): after a part's features, the material radially outside
// each hole's wall is measured on the final bodies (the kernel's `holeWalls` op, walls.ts there),
// and a hole whose wall is thinner than its minimum at some point gets a `thin-wall` warning.
//
// The minimum, per hole and body:
// - a heat-set insert hole (`standard.purpose: 'heat-set-insert'`): the insert's `minWall` from
//   packages/print's insert table (CNC Kitchen's, 1.6 mm for M3);
// - any other hole: the largest minimum wall of the print setups that print the body (an item
//   naming the part, with no body or this body): the setup's own `minWall` where it evaluates, else
//   the nozzle's default (two line widths, 0.84 mm at 0.4 mm). A part no print setup prints has no
//   minimum for its plain holes, so they are not checked: a hole in a part that is machined, cut
//   from wood or bought has no printing wall to keep.
//
// Measured on the final bodies, so a later feature that cuts close to a hole is caught too, and
// only holes that built (status `ok`). This module is the part that needs no kernel: minimums,
// ranges and warnings. The engine sends the ops and keeps the results per body key.

import type { Feature, ManufaktureDocument, Part } from '@manufakture/core';
import { DEFAULT_WALL_RANGE, MAX_WALL_FACES, type HoleWall } from '@manufakture/kernel';
import { holeInsert } from '@manufakture/print/fits';
import { printThresholds } from '@manufakture/print/thresholds';
import type { RegenWarning } from './types';
import { evaluateField, type VariableValues } from './values';

export type HoleFeature = Extract<Feature, { kind: 'hole' }>;

/** A hole's minimum wall on one body, and where it comes from. */
export interface WallMinimum {
  /** mm. */
  minimum: number;
  source: Extract<RegenWarning, { code: 'thin-wall' }>['source'];
}

/** Walls within this of the minimum are at it, not under it (mm). */
export const WALL_TOLERANCE = 1e-6;

/** The largest minimum wall of the print setups printing `bodyId` of `part`, or null for none. */
export function printSetupMinimum(
  document: ManufaktureDocument,
  part: Part,
  bodyId: string,
  variables: VariableValues,
): WallMinimum | null {
  let best: WallMinimum | null = null;
  for (const setup of document.print.setups) {
    if (!setup.items.some((i) => i.part === part.id && (i.body ?? bodyId) === bodyId)) continue;
    const own = setup.thresholds?.minWall;
    const evaluated =
      own === undefined ? null : evaluateField(own, 'length', ['thresholds', 'minWall'], variables);
    const minimum =
      evaluated !== null && evaluated.ok ? evaluated.value : printThresholds(setup.nozzle).minWall;
    if (best === null || minimum > best.minimum) {
      best = { minimum, source: { kind: 'print-setup', setupId: setup.id } };
    }
  }
  return best;
}

/** The minimum wall of `hole` on `bodyId`, or null when it has none (it is then not checked). */
export function wallMinimum(
  document: ManufaktureDocument,
  part: Part,
  hole: HoleFeature,
  bodyId: string,
  variables: VariableValues,
): WallMinimum | null {
  const insert = holeInsert(hole.standard);
  if (insert !== undefined) {
    return { minimum: insert.minWall, source: { kind: 'insert', size: insert.size } };
  }
  return printSetupMinimum(document, part, bodyId, variables);
}

/** How far the kernel's rays reach for these minimums: twice the largest, at least the default. */
export function wallRange(minimums: Iterable<WallMinimum>): number {
  let range = DEFAULT_WALL_RANGE;
  for (const m of minimums) range = Math.max(range, 2 * m.minimum);
  return range;
}

const mm = (v: number) => `${Number(v.toFixed(3))} mm`;

/**
 * The `thin-wall` warnings of one hole on one body: per sketch point, the thinnest of its wall
 * faces (a wall split by a later cut, its pattern copies) when it is under the minimum, naming the
 * face when it is not the point's own. Points the kernel skipped (past `MAX_WALL_FACES` on the
 * body) get one `wall-unchecked` warning between them.
 */
export function thinWallWarnings(
  hole: HoleFeature,
  bodyId: string,
  walls: readonly HoleWall[],
  minimum: WallMinimum,
): RegenWarning[] {
  const thinnest = new Map<string, HoleWall>();
  const skipped = new Set<string>();
  for (const w of walls) {
    if (w.hole !== hole.id) continue;
    if (w.skipped === true) skipped.add(w.point);
    if (w.wall === null) continue;
    const known = thinnest.get(w.point);
    if (known === undefined || w.wall < known.wall!) thinnest.set(w.point, w);
  }
  const what =
    minimum.source.kind === 'insert'
      ? `the ${minimum.source.size} heat-set insert's minimum of ${mm(minimum.minimum)}`
      : `the minimum wall of ${minimum.source.setupId}, ${mm(minimum.minimum)}`;
  const order = (p: string) => {
    const i = hole.points.indexOf(p);
    return i < 0 ? hole.points.length : i;
  };
  const out: RegenWarning[] = [];
  for (const [point, w] of [...thinnest].sort((a, b) => order(a[0]) - order(b[0]))) {
    if (!(w.wall! < minimum.minimum - WALL_TOLERANCE)) continue;
    // A piece of a split wall, or a pattern copy's, is named: the point alone does not find it.
    const own = w.face === `${hole.id}:wall:${point}`;
    const at = `${hole.id} at ${point}${own ? '' : ` (face ${w.face})`} on ${bodyId}`;
    out.push({
      code: 'thin-wall',
      message:
        w.breakout === true
          ? `The hole ${at} breaks out of ${w.toFace}: it has no wall there, under ${what}`
          : `The wall around ${at} is ${mm(w.wall!)}, under ${what}${w.toFace === null ? '' : ` (to ${w.toFace})`}`,
      point,
      face: w.face,
      bodyId,
      wall: w.wall!,
      minimum: minimum.minimum,
      source: minimum.source,
      from: w.from!,
      to: w.to!,
      toFace: w.toFace,
      ...(w.breakout === true ? { breakout: true as const } : {}),
    });
  }
  if (skipped.size > 0) {
    const points = [...skipped].sort((a, b) => order(a) - order(b));
    out.push({
      code: 'wall-unchecked',
      message: `The wall around ${hole.id} at ${points.join(', ')} on ${bodyId} was not checked: ${bodyId} has more than ${MAX_WALL_FACES} hole walls to check`,
      bodyId,
      points,
    });
  }
  return out;
}
