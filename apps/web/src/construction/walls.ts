// The Wall tool's logic, free of React: a path in plan on the active level, drawn by typed lengths
// in 90 degree steps (how framers lay out: "16 feet, turn left, 12 feet") or by clicked points
// snapped to wall ends, to square from the last point and to a grid; closing it makes a building
// outline. Then the wall feature (`construction.wall`, ADR 0015 decision 2) and the command that
// adds it, and the per-wall framing settings.
//
// A wall's framing lies left of its path and its exterior is on the right (the domain's default
// justification), so a closed outline is turned counter-clockwise before it is stored: the
// framing then sits inside the outline and the sheathing outside, whichever way it was drawn.
//
// Everything is bounded by the domain's own limits (points, coordinates, segment lengths), and
// every loop here is linear in the points of the path or the walls of the part.

import {
  previewIds,
  type Command,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import {
  MAX_COORDINATE,
  MAX_LAYER_JOIN_WALLS,
  MAX_SEGMENT_LENGTH,
  MAX_WALL_HEIGHT,
  MAX_WALL_POINTS,
  MIN_SPACING,
  WALL_SCHEMA_VERSION,
  WALL_TYPE,
  readWallParams,
  type ConstructionSettings,
  type WallMetadata,
  type WallParams,
} from '@manufakture/domain-construction';
import type { Variables } from '../sketcher/values';
import type { MemberSetView } from '../viewport/members';
import { checkLength, coordinateExpression } from './lengths';
import { omit } from './kinds';
import { isOpening, isWall, makesBodies } from './settings';

export type P2 = readonly [number, number];

/** A direction in plan, in degrees counter-clockwise from +X: the 90 degree steps. */
export type Direction = 0 | 90 | 180 | 270;
export const DIRECTIONS: readonly Direction[] = [0, 90, 180, 270];

/** How each direction is named in the tool (plan view: +X right, +Y up). */
export const DIRECTION_LABELS: Record<Direction, string> = {
  0: 'Right (+X)',
  90: 'Up (+Y)',
  180: 'Left (-X)',
  270: 'Down (-Y)',
};

const UNIT: Record<Direction, P2> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

/** The point `length` from `from` in direction `dir`. */
export function step(from: P2, dir: Direction, length: number): P2 {
  const u = UNIT[dir];
  return [from[0] + u[0] * length, from[1] + u[1] * length];
}

/** Turning left or right from a direction. */
export function turn(dir: Direction, side: 'left' | 'right'): Direction {
  return ((dir + (side === 'left' ? 90 : 270)) % 360) as Direction;
}

/** The 90 degree direction from `a` to `b`, or null when the segment is not square to the axes. */
export function directionOf(a: P2, b: P2, tolerance = 1e-6): Direction | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.abs(dy) <= tolerance && dx > tolerance) return 0;
  if (Math.abs(dy) <= tolerance && dx < -tolerance) return 180;
  if (Math.abs(dx) <= tolerance && dy > tolerance) return 90;
  if (Math.abs(dx) <= tolerance && dy < -tolerance) return 270;
  return null;
}

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** How close two path points must be to count as the same, mm. */
export const SAME_POINT = 0.5;

// Snapping ------------------------------------------------------------------------------------

export type SnapKind = 'endpoint' | 'square' | 'grid' | 'none';

export interface SnapContext {
  /** The last point of the path being drawn, for square (90 degree) snapping. */
  from?: P2 | undefined;
  /** Wall ends on the level and the path's own points. */
  endpoints: readonly P2[];
  /** Grid spacing, mm; 0: no grid. */
  grid: number;
  /** How far a snap reaches, mm. */
  tolerance: number;
}

/**
 * Snap a clicked point: to a wall end within reach first; else square to the last point (the
 * nearer axis through it, when the click is within reach of it), with the length along it on the
 * grid; else to the grid.
 */
export function snapPoint(raw: P2, ctx: SnapContext): { point: P2; kind: SnapKind } {
  let best: P2 | null = null;
  let bestD = ctx.tolerance;
  for (const p of ctx.endpoints) {
    const d = dist(raw, p);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  if (best !== null) return { point: [best[0], best[1]], kind: 'endpoint' };
  const g = (v: number) => (ctx.grid > 0 ? Math.round(v / ctx.grid) * ctx.grid : v);
  if (ctx.from) {
    const f = ctx.from;
    const dx = Math.abs(raw[0] - f[0]);
    const dy = Math.abs(raw[1] - f[1]);
    if (dy <= ctx.tolerance || dx <= ctx.tolerance) {
      // Along the nearer axis, by a whole number of grid steps from the last point.
      if (dy <= dx) return { point: [f[0] + g(raw[0] - f[0]), f[1]], kind: 'square' };
      return { point: [f[0], f[1] + g(raw[1] - f[1])], kind: 'square' };
    }
  }
  if (ctx.grid > 0) return { point: [g(raw[0]), g(raw[1])], kind: 'grid' };
  return { point: raw, kind: 'none' };
}

/** The grid the Wall tool snaps to: 1" in inch and foot documents, 10 mm otherwise. */
export function gridFor(units: DisplayUnits): number {
  const u = units.length.unit;
  return u === 'ft-in' || u === 'in-fraction' || u === 'in' ? 25.4 : u === 'ft' ? 304.8 : 10;
}

/** Ends of the part's walls on a level (from their regen metadata), for snapping. */
export function wallEnds(metadata: readonly WallMetadata[], level: string): P2[] {
  const out: P2[] = [];
  for (const m of metadata) {
    if (m.level !== level) continue;
    for (const p of m.points) out.push([p[0], p[1]]);
  }
  return out;
}

// The path ------------------------------------------------------------------------------------

/** The path being drawn: its points in plan, mm. The first is the start. */
export interface WallDraft {
  points: readonly P2[];
  closed: boolean;
}

/** Twice the signed area of a closed path (positive: counter-clockwise). */
export function signedArea2(points: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/**
 * The path as stored: a last point back on the first closes the loop (and is dropped), a closed
 * loop is turned counter-clockwise (framing inside), and every limit is checked.
 */
export function finishPath(draft: WallDraft):
  | { ok: true; points: P2[]; closed: boolean; reversed: boolean }
  | {
      ok: false;
      message: string;
    } {
  let points = [...draft.points];
  let closed = draft.closed;
  if (points.length >= 3 && dist(points[0]!, points.at(-1)!) <= SAME_POINT) {
    points = points.slice(0, -1);
    closed = true;
  }
  if (points.length > MAX_WALL_POINTS) {
    return {
      ok: false,
      message: `A wall has at most ${MAX_WALL_POINTS} points; split it into two walls.`,
    };
  }
  const least = closed ? 3 : 2;
  if (points.length < least) {
    return {
      ok: false,
      message: closed
        ? 'A closed wall needs at least three points.'
        : 'A wall needs at least two points.',
    };
  }
  for (const p of points) {
    if (!(Math.abs(p[0]) <= MAX_COORDINATE && Math.abs(p[1]) <= MAX_COORDINATE)) {
      return {
        ok: false,
        message: `Keep the wall within ${MAX_COORDINATE / 1000} m of the origin.`,
      };
    }
  }
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const d = dist(points[i]!, points[(i + 1) % points.length]!);
    if (d <= SAME_POINT) return { ok: false, message: `Segment ${i + 1} has no length.` };
    if (d > MAX_SEGMENT_LENGTH) {
      return {
        ok: false,
        message: `Segment ${i + 1} is longer than ${MAX_SEGMENT_LENGTH / 1000} m.`,
      };
    }
  }
  let reversed = false;
  if (closed && signedArea2(points) < 0) {
    points = [points[0]!, ...points.slice(1).reverse()];
    reversed = true;
  }
  return { ok: true, points, closed, reversed };
}

/** Segment lengths of a path, mm (a closed path's last segment back to its start included). */
export function segmentLengths(points: readonly P2[], closed: boolean): number[] {
  const n = closed ? points.length : points.length - 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(dist(points[i]!, points[(i + 1) % points.length]!));
  return out;
}

// The feature ---------------------------------------------------------------------------------

export interface WallInput {
  level: string;
  wallType: string;
  points: readonly P2[];
  closed: boolean;
  /**
   * The part's walls as regen last built them (id and metadata), for the layer joins: the new
   * wall names in `dependsOn` the earlier walls it meets.
   */
  others?: readonly { id: string; meta: WallMetadata }[];
}

/** The most walls a wall names in `dependsOn` to join its layers with (the domain's bound). */
export { MAX_LAYER_JOIN_WALLS };

/** Whether `p` lies on the path (within `SAME_POINT`). Linear in the path's segments. */
function onPath(p: P2, points: readonly P2[], closed: boolean): boolean {
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    const along = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
    const off = -(p[0] - a[0]) * uy + (p[1] - a[1]) * ux;
    if (Math.abs(off) <= SAME_POINT && along >= -SAME_POINT && along <= len + SAME_POINT) {
      return true;
    }
  }
  return false;
}

/** The open, joinable ends of a path (none for a closed one). */
function pathEnds(
  points: readonly P2[],
  closed: boolean,
  free: { start: boolean; end: boolean } = { start: false, end: false },
): P2[] {
  if (closed || points.length < 2) return [];
  const out: P2[] = [];
  if (!free.start) out.push(points[0]!);
  if (!free.end) out.push(points.at(-1)!);
  return out;
}

/**
 * The walls on `level` a new path meets, as the domain joins layers (ADR 0015, `layerJoins`): an
 * open end of one on the other's path (an L or a tee). In the order given (feature order), at
 * most `MAX_LAYER_JOIN_WALLS`; the work is linear in the walls times both paths' points (each
 * at most `MAX_WALL_POINTS`).
 */
export function meetingWalls(
  path: { points: readonly P2[]; closed: boolean },
  level: string,
  others: readonly { id: string; meta: WallMetadata }[],
): string[] {
  const out: string[] = [];
  const mine = pathEnds(path.points, path.closed);
  for (const { id, meta } of others) {
    if (out.length >= MAX_LAYER_JOIN_WALLS) break;
    if (meta.level !== level || meta.points.length < 2) continue;
    const theirs = pathEnds(meta.points, meta.closed, meta.free);
    const meets =
      mine.some((p) => onPath(p, meta.points, meta.closed)) ||
      theirs.some((p) => onPath(p, path.points, path.closed));
    if (meets) out.push(id);
  }
  return out;
}

export type FeatureBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; message: string };

/** The rollback bar of a part: new features go there. */
export function barOf(part: Part): number {
  return part.rollbackIndex ?? part.features.length;
}

/** "Wall 3", "Window 2": counted per part studio, skipping names already taken. */
export function newFeatureName(
  part: Part,
  word: string,
  matches: (f: Part['features'][number]) => boolean,
): string {
  const names = new Set(part.features.map((f) => f.name));
  let n = part.features.filter(matches).length + 1;
  while (names.has(`${word} ${n}`)) n++;
  return `${word} ${n}`;
}

/** A new wall on a path drawn on a level. */
export function buildWall(
  doc: ManufaktureDocument,
  partId: string,
  settings: ConstructionSettings | undefined,
  input: WallInput,
): FeatureBuild {
  const part = doc.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, message: 'The part studio is gone.' };
  if (!settings?.levels.some((l) => l.id === input.level)) {
    return { ok: false, message: 'Choose a level.' };
  }
  const type = settings.wallTypes.find((t) => t.id === input.wallType);
  if (!type) return { ok: false, message: 'Choose a wall type (make one in Wall types first).' };
  const path = finishPath({ points: input.points, closed: input.closed });
  if (!path.ok) return path;
  const expressions: Record<string, StoredExpression> = {};
  path.points.forEach((p, i) => {
    expressions[`x${i + 1}`] = coordinateExpression(p[0], doc.units);
    expressions[`y${i + 1}`] = coordinateExpression(p[1], doc.units);
  });
  const params = {
    level: input.level,
    wallType: input.wallType,
    points: path.points.length,
    ...(path.closed ? { closed: true } : {}),
  };
  const checked = readWallParams(params, WALL_SCHEMA_VERSION);
  if (!checked.ok) return { ok: false, message: checked.message };
  // Earlier walls only (before the rollback bar, where the new wall goes) that it meets.
  const earlier = new Set(
    part.features
      .slice(0, barOf(part))
      .filter(isWall)
      .map((f) => f.id),
  );
  const dependsOn = meetingWalls(
    path,
    input.level,
    (input.others ?? []).filter((o) => earlier.has(o.id)),
  );
  const id = previewIds(part.nextIds, 'extension')[0]!;
  const name = newFeatureName(part, 'Wall', isWall);
  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: false,
    extension: WALL_TYPE,
    schemaVersion: WALL_SCHEMA_VERSION,
    dependsOn,
    references: [],
    expressions,
    params,
    ...(makesBodies(type) ? { operation: 'new' as const } : {}),
  };
  return {
    ok: true,
    feature,
    command: { type: 'addFeature', partId, feature },
    label: `Add ${name}`,
  };
}

// Per-wall framing settings ---------------------------------------------------------------------

/** The per-wall framing form: empty text or `''` choices keep the level's or type's default. */
export interface WallFramingForm {
  height: string;
  spacing: string;
  layoutFrom: '' | 'start' | 'end';
  bottomPlates: '' | '1' | '2' | '3';
  topPlates: '' | '1' | '2' | '3';
  kings: '' | '1' | '2' | '3' | '4';
  cornerStyle: '' | 'two-stud' | 'three-stud' | 'ladder';
  blocking: '' | 'none' | 'mid-height';
}

export function framingFormOf(wall: ExtensionFeature): WallFramingForm {
  const f = (wall.params.framing ?? {}) as Record<string, unknown>;
  const text = (k: string) =>
    typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '';
  return {
    height: wall.expressions.height?.source ?? '',
    spacing: wall.expressions.spacing?.source ?? '',
    layoutFrom: text('layoutFrom') as WallFramingForm['layoutFrom'],
    bottomPlates: text('bottomPlates') as WallFramingForm['bottomPlates'],
    topPlates: text('topPlates') as WallFramingForm['topPlates'],
    kings: text('kings') as WallFramingForm['kings'],
    cornerStyle: text('cornerStyle') as WallFramingForm['cornerStyle'],
    blocking: text('blocking') as WallFramingForm['blocking'],
  };
}

/** The edit of one wall's framing settings, or the field errors. */
export function buildWallFraming(
  doc: ManufaktureDocument,
  partId: string,
  wallId: string,
  form: WallFramingForm,
  variables: Variables,
):
  | { ok: true; command: Command | null; label: string }
  | { ok: false; errors: Record<string, string> } {
  const part = doc.parts.find((p) => p.id === partId);
  const wall = part?.features.find((f) => f.id === wallId);
  if (!part || !wall || !isWall(wall)) return { ok: false, errors: { form: 'That wall is gone.' } };
  const errors: Record<string, string> = {};
  const expressions: Record<string, StoredExpression> = { ...wall.expressions };
  delete expressions.height;
  delete expressions.spacing;
  if (form.height.trim() !== '') {
    const r = checkLength(form.height, doc.units, variables);
    if (!r.ok) errors.height = r.message;
    else if (r.value > MAX_WALL_HEIGHT) errors.height = `At most ${MAX_WALL_HEIGHT / 1000} m.`;
    else expressions.height = r.expression;
  }
  if (form.spacing.trim() !== '') {
    const r = checkLength(form.spacing, doc.units, variables, {
      min: { value: MIN_SPACING, text: `${MIN_SPACING} mm` },
    });
    if (!r.ok) errors.spacing = r.message;
    else expressions.spacing = r.expression;
  }
  const framing: Record<string, string | number> = {};
  if (form.layoutFrom !== '') framing.layoutFrom = form.layoutFrom;
  if (form.cornerStyle !== '') framing.cornerStyle = form.cornerStyle;
  if (form.blocking !== '') framing.blocking = form.blocking;
  for (const k of ['bottomPlates', 'topPlates', 'kings'] as const) {
    if (form[k] !== '') framing[k] = Number(form[k]);
  }
  const restParams = omit(wall.params as Record<string, unknown>, 'framing');
  const params = {
    ...restParams,
    ...(Object.keys(framing).length > 0 ? { framing } : {}),
  } as ExtensionFeature['params'];
  const checked = readWallParams(params as never, wall.schemaVersion);
  if (!checked.ok) errors.form = checked.message;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const feature: ExtensionFeature = { ...wall, expressions, params };
  const label = `Set the framing of ${wall.name}`;
  if (JSON.stringify(feature) === JSON.stringify(wall)) return { ok: true, command: null, label };
  return { ok: true, command: { type: 'editFeature', partId, feature }, label };
}

/** The walls of a part, with the openings each hosts (by `dependsOn`), in feature order. */
export function wallsOf(part: Part): { wall: ExtensionFeature; openings: ExtensionFeature[] }[] {
  const out = new Map<string, { wall: ExtensionFeature; openings: ExtensionFeature[] }>();
  for (const f of part.features) if (isWall(f)) out.set(f.id, { wall: f, openings: [] });
  for (const f of part.features) {
    if (!isOpening(f)) continue;
    for (const d of f.dependsOn) out.get(d)?.openings.push(f);
  }
  return [...out.values()];
}

/** The path's points (mm) from its start and steps (typed lengths, or clicked points). */
export type PathStep =
  { kind: 'typed'; dir: Direction; length: number; text: string } | { kind: 'point'; p: P2 };

export function pathPoints(start: P2, steps: readonly PathStep[]): P2[] {
  const out: P2[] = [start];
  for (const s of steps) out.push(s.kind === 'point' ? s.p : step(out.at(-1)!, s.dir, s.length));
  return out;
}

/** Member counts by role, in first-seen order, and the total. */
export function roleCounts(set: MemberSetView | undefined): {
  total: number;
  roles: [string, number][];
} {
  if (!set) return { total: 0, roles: [] };
  const counts = new Map<string, number>();
  for (const m of set.members) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  return { total: set.members.length, roles: [...counts] };
}

export type { WallParams };
