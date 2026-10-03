// What the IFC writer takes: a building as plain data, lengths in millimetres (ADR 0005). The
// shapes follow the construction domain's regen results so a caller passes them through: a wall
// is its feature id plus its `WallMetadata` fields, an opening its id plus `OpeningMetadata`
// fields, and a member is regen's `MemberData` (`packages/regen/src/members.ts`) as it stands.
// This package imports neither: the types are structural.
//
// Everything here is document-derived, so `checkIfcBuilding` bounds every list and number before
// the writer loops over anything; a hostile document is refused with an `IfcExportError`.

/** A length unit the file is written in (a document's `LengthUnit`; `ft-in` documents use `ft`). */
export type IfcLengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** Millimetres per unit. */
export const IFC_UNIT_MM: Readonly<Record<IfcLengthUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export type IfcVec3 = readonly [number, number, number];
export type IfcVec2 = readonly [number, number];

export interface IfcLevelInput {
  readonly id: string;
  readonly name: string;
  /** Elevation of the level, mm. */
  readonly elevation: number;
}

/** One layer of a wall, as `LayerMetadata` reports it. */
export interface IfcWallLayerInput {
  readonly id: string;
  readonly kind: 'siding' | 'sheathing' | 'framing' | 'drywall';
  /** Its extent across the path, mm, positive to the left of the path. */
  readonly t: readonly [number, number];
}

/** A wall: its feature id and name, and the `WallMetadata` fields the writer reads. */
export interface IfcWallInput {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  /** Elevation of the wall's base, mm. */
  readonly base: number;
  readonly height: number;
  /** The path in plan, mm; a closed path joins its last point to its first. */
  readonly points: readonly IfcVec2[];
  readonly closed: boolean;
  /** The framing's thickness, mm: the band `[0, thickness]` when no layer says otherwise. */
  readonly thickness: number;
  /** Exterior to interior. */
  readonly layers?: readonly IfcWallLayerInput[];
}

/** An opening: its feature id and name, and the `OpeningMetadata` fields the writer reads. */
export interface IfcOpeningInput {
  readonly id: string;
  readonly name?: string;
  /** The host wall's id. */
  readonly wall: string;
  readonly type: 'door' | 'window' | 'opening';
  /** 1-based segment of the host wall. */
  readonly segment: number;
  /** Centre of the rough opening along the segment, from its first point, mm. */
  readonly position: number;
  readonly width: number;
  readonly height: number;
  /** Bottom of the rough opening above the wall's base, mm. */
  readonly sill: number;
}

/**
 * A floor: its subfloor as a slab whose top is `top`, `thickness` deep, over `outline`. With no
 * thickness (a floor without subfloor) the slab has no body and only holds the floor's members.
 */
export interface IfcFloorInput {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  /** The slab's outline in plan, mm, counter-clockwise or clockwise, not closed. */
  readonly outline: readonly IfcVec2[];
  /** Elevation of the slab's top, mm. */
  readonly top: number;
  readonly thickness?: number;
}

/** A placed plane: points `origin + u x + v y` (x and y orthonormal), mm. */
export interface IfcPlaneInput {
  readonly origin: IfcVec3;
  readonly x: IfcVec3;
  readonly y: IfcVec3;
}

/** A sheet of a roof (its sheathing on one plane): an outline in its plane, extruded along z. */
export interface IfcSheetInput {
  readonly id: string;
  readonly placement: IfcPlaneInput;
  /** In the placement's (x, y), mm. */
  readonly outline: readonly IfcVec2[];
  readonly thickness: number;
}

export type IfcRoofKind = 'gable' | 'hip' | 'shed' | 'flat';

export interface IfcRoofInput {
  readonly id: string;
  readonly name?: string;
  readonly level: string;
  readonly kind?: IfcRoofKind;
  readonly sheets?: readonly IfcSheetInput[];
}

/** A framing member: regen's `MemberData` (cuts are not written; members are their blanks). */
export interface IfcMemberInput {
  readonly id: string;
  /** A wall, opening, floor or roof id. */
  readonly owner: string;
  readonly role: string;
  readonly stock: { readonly name: string; readonly width: number; readonly depth: number };
  readonly length: number;
  /** The blank is `origin + a x + b y + c z`, a in [0, length], b in [0, width], c in [0, depth]. */
  readonly placement: IfcPlaneInput;
}

export interface IfcBuildingInput {
  /** The document's id: GlobalIds derive from it and the element ids. */
  readonly documentId: string;
  /** The project's and file's name (the document's name). */
  readonly name: string;
  /** The building's name; `name` when absent. */
  readonly buildingName?: string;
  readonly unit: IfcLengthUnit;
  /** The "not an engineering tool" text (`DISCLAIMER_SHORT`), written into the file header. */
  readonly disclaimer: string;
  readonly levels: readonly IfcLevelInput[];
  readonly walls?: readonly IfcWallInput[];
  readonly openings?: readonly IfcOpeningInput[];
  readonly floors?: readonly IfcFloorInput[];
  readonly roofs?: readonly IfcRoofInput[];
  readonly members?: readonly IfcMemberInput[];
}

// Bounds ---------------------------------------------------------------------------------------

export const MAX_IFC_LEVELS = 200;
export const MAX_IFC_WALLS = 10_000;
export const MAX_IFC_WALL_POINTS = 1_000;
export const MAX_IFC_LAYERS = 16;
export const MAX_IFC_OPENINGS = 10_000;
/** Openings on one wall segment: the layer strips grow with their square. */
export const MAX_IFC_OPENINGS_PER_SEGMENT = 200;
export const MAX_IFC_FLOORS = 1_000;
export const MAX_IFC_ROOFS = 1_000;
export const MAX_IFC_SHEETS = 1_000;
export const MAX_IFC_OUTLINE_POINTS = 10_000;
/** Regen allows 50,000 members a group; a whole building gets four times that. */
export const MAX_IFC_MEMBERS = 200_000;
/**
 * The most work one export may do: every entity written, every box asked for (cached or not),
 * every reference placed in a representation, aggregation or containment list, and every 64
 * characters of a label count one. The counts above bound each list, but not their products
 * (openings times segments times layers, repeated geometry referenced over and over), so this
 * is what bounds the file: at most a few hundred bytes a unit, so a few hundred megabytes in
 * the worst case; the 200,000-member building the counts allow needs about 2,700,000.
 */
export const MAX_IFC_WORK = 3_000_000;
/** Largest coordinate, mm (1,000 km): regen bounds member coordinates at 1 km. */
export const MAX_IFC_COORDINATE = 1e9;
/** Largest size (length, height, width, thickness), mm. */
export const MAX_IFC_SIZE = 1e7;
/** Longest id, characters (ids feed the GlobalId hash and become tags). */
export const MAX_IFC_ID = 512;

export class IfcExportError extends Error {
  override readonly name = 'IfcExportError';
}

const fail = (message: string): never => {
  throw new IfcExportError(message);
};

/** No lone surrogates (`String.prototype.isWellFormed`, which the ES2023 lib does not type). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const isWellFormed = (s: string): boolean => !LONE_SURROGATE.test(s);

/**
 * An id: 1 to `MAX_IFC_ID` characters of well-formed UTF-16. Ids are hashed into GlobalIds as
 * UTF-8, and the encoder turns every lone surrogate into U+FFFD, so two ids differing only in
 * lone surrogates would collide.
 */
function checkId(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_IFC_ID) {
    return fail(`${what}: expected an id of 1 to ${MAX_IFC_ID} characters`);
  }
  if (!isWellFormed(v)) return fail(`${what}: the id is not well-formed text`);
  return v;
}

/** Text, or absent when `optional`. */
function text(v: unknown, what: string, optional = false): void {
  if (optional && v === undefined) return;
  if (typeof v !== 'string') fail(`${what}: expected text`);
}

function checkList<T>(v: readonly T[] | undefined, max: number, what: string): readonly T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return fail(`${what}: expected a list`);
  if (v.length > max) return fail(`${what}: at most ${max} are allowed, got ${v.length}`);
  return v;
}

function coord(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_IFC_COORDINATE) {
    return fail(`${what}: expected a finite coordinate within ${MAX_IFC_COORDINATE} mm`);
  }
  return v;
}

function size(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= min || v > MAX_IFC_SIZE) {
    return fail(`${what}: expected a size above ${min} mm and at most ${MAX_IFC_SIZE} mm`);
  }
  return v;
}

function vec(v: unknown, n: 2 | 3, what: string): void {
  if (!Array.isArray(v) || v.length !== n) return fail(`${what}: expected ${n} coordinates`);
  for (let i = 0; i < n; i++) coord(v[i], what);
}

function plane(p: IfcPlaneInput | undefined, what: string): void {
  if (p === null || typeof p !== 'object') return fail(`${what}: expected a placement`);
  vec(p.origin, 3, `${what} origin`);
  vec(p.x, 3, `${what} x`);
  vec(p.y, 3, `${what} y`);
  const [x, y] = [p.x, p.y];
  const lx = Math.hypot(...x);
  const ly = Math.hypot(...y);
  const dot = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  if (Math.abs(lx - 1) > 1e-3 || Math.abs(ly - 1) > 1e-3 || Math.abs(dot) > 1e-3) {
    fail(`${what}: x and y must be orthonormal`);
  }
}

function outline(points: readonly IfcVec2[], what: string): void {
  checkList(points, MAX_IFC_OUTLINE_POINTS, `${what} outline`);
  if (points.length < 3) fail(`${what}: an outline needs at least 3 points`);
  for (const p of points) vec(p, 2, `${what} outline`);
}

function unique(seen: Set<string>, id: string, what: string): void {
  if (seen.has(id)) fail(`${what}: the id "${id}" is used twice`);
  seen.add(id);
}

/**
 * Checks a building before it is written: list lengths, ids, finite and bounded numbers,
 * orthonormal placements, references (levels, walls, owners) that exist. Throws an
 * `IfcExportError` naming the first problem.
 */
export function checkIfcBuilding(b: IfcBuildingInput): void {
  if (b === null || typeof b !== 'object') fail('expected a building');
  checkId(b.documentId, 'the document');
  text(b.name, 'the name');
  text(b.buildingName, 'the building name', true);
  if (typeof b.disclaimer !== 'string' || b.disclaimer.trim() === '') {
    fail('the disclaimer: expected the "not an engineering tool" text');
  }
  if (!Object.hasOwn(IFC_UNIT_MM, b.unit)) fail(`the unit: "${String(b.unit)}" is not one`);

  const levels = checkList(b.levels, MAX_IFC_LEVELS, 'levels');
  if (levels.length === 0) fail('levels: a building needs at least one level');
  const levelIds = new Set<string>();
  for (const l of levels) {
    unique(levelIds, checkId(l.id, 'a level'), 'levels');
    text(l.name, `level ${l.id} name`);
    coord(l.elevation, `level ${l.id} elevation`);
  }
  const level = (id: string, what: string) => {
    if (!levelIds.has(id)) fail(`${what}: no level "${id}"`);
  };

  const owners = new Set<string>();
  const walls = checkList(b.walls, MAX_IFC_WALLS, 'walls');
  const wallSegments = new Map<string, number>();
  for (const w of walls) {
    const what = `wall ${checkId(w.id, 'a wall')}`;
    unique(owners, w.id, 'walls, openings, floors and roofs');
    text(w.name, `${what} name`, true);
    level(w.level, what);
    coord(w.base, `${what} base`);
    size(w.height, `${what} height`);
    size(w.thickness, `${what} thickness`);
    const points = checkList(w.points, MAX_IFC_WALL_POINTS, `${what} points`);
    if (points.length < 2) fail(`${what}: a wall needs at least 2 points`);
    for (const p of points) vec(p, 2, `${what} points`);
    const count = w.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i]!;
      const c = points[(i + 1) % points.length]!;
      if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-6)
        fail(`${what}: segment ${i + 1} has no length`);
    }
    wallSegments.set(w.id, count);
    const layers = checkList(w.layers, MAX_IFC_LAYERS, `${what} layers`);
    const layerIds = new Set<string>();
    for (const l of layers) {
      unique(layerIds, checkId(l.id, `${what} layer`), `${what} layers`);
      if (!['siding', 'sheathing', 'framing', 'drywall'].includes(l.kind)) {
        fail(`${what} layer ${l.id}: unknown kind`);
      }
      if (!Array.isArray(l.t) || l.t.length !== 2)
        fail(`${what} layer ${l.id}: expected [from, to]`);
      coord(l.t[0], `${what} layer ${l.id}`);
      coord(l.t[1], `${what} layer ${l.id}`);
      if (!(l.t[1] > l.t[0])) fail(`${what} layer ${l.id}: expected from < to`);
    }
  }

  const openings = checkList(b.openings, MAX_IFC_OPENINGS, 'openings');
  const perSegment = new Map<string, number>();
  for (const o of openings) {
    const what = `opening ${checkId(o.id, 'an opening')}`;
    unique(owners, o.id, 'walls, openings, floors and roofs');
    text(o.name, `${what} name`, true);
    const segments = wallSegments.get(o.wall);
    if (segments === undefined) fail(`${what}: no wall "${o.wall}"`);
    if (!['door', 'window', 'opening'].includes(o.type)) fail(`${what}: unknown type`);
    if (!Number.isInteger(o.segment) || o.segment < 1 || o.segment > segments!) {
      fail(`${what}: the wall has no segment ${String(o.segment)}`);
    }
    coord(o.position, `${what} position`);
    size(o.width, `${what} width`);
    size(o.height, `${what} height`);
    coord(o.sill, `${what} sill`);
    const key = `${o.wall}\u0000${o.segment}`;
    const n = (perSegment.get(key) ?? 0) + 1;
    if (n > MAX_IFC_OPENINGS_PER_SEGMENT) {
      fail(`${what}: at most ${MAX_IFC_OPENINGS_PER_SEGMENT} openings on one wall segment`);
    }
    perSegment.set(key, n);
  }

  for (const f of checkList(b.floors, MAX_IFC_FLOORS, 'floors')) {
    const what = `floor ${checkId(f.id, 'a floor')}`;
    unique(owners, f.id, 'walls, openings, floors and roofs');
    text(f.name, `${what} name`, true);
    level(f.level, what);
    outline(f.outline, what);
    coord(f.top, `${what} top`);
    if (f.thickness !== undefined) size(f.thickness, `${what} thickness`);
  }

  let sheets = 0;
  for (const r of checkList(b.roofs, MAX_IFC_ROOFS, 'roofs')) {
    const what = `roof ${checkId(r.id, 'a roof')}`;
    unique(owners, r.id, 'walls, openings, floors and roofs');
    text(r.name, `${what} name`, true);
    level(r.level, what);
    if (r.kind !== undefined && !['gable', 'hip', 'shed', 'flat'].includes(r.kind)) {
      fail(`${what}: unknown kind`);
    }
    const ids = new Set<string>();
    for (const s of checkList(r.sheets, MAX_IFC_SHEETS, `${what} sheets`)) {
      const sw = `${what} sheet ${checkId(s.id, `${what} sheet`)}`;
      unique(ids, s.id, `${what} sheets`);
      plane(s.placement, sw);
      outline(s.outline, sw);
      size(s.thickness, `${sw} thickness`);
      if (++sheets > MAX_IFC_SHEETS) fail(`roof sheets: at most ${MAX_IFC_SHEETS} are allowed`);
    }
  }

  const memberIds = new Set<string>();
  for (const m of checkList(b.members, MAX_IFC_MEMBERS, 'members')) {
    const owner = checkId(m.owner, 'a member owner');
    const what = `member ${owner}:${checkId(m.id, 'a member')}`;
    unique(memberIds, `${owner}:${m.id}`, 'members');
    if (!owners.has(owner)) fail(`${what}: no wall, opening, floor or roof "${owner}"`);
    if (typeof m.role !== 'string' || m.role.length === 0 || m.role.length > 64) {
      fail(`${what}: expected a role`);
    }
    if (m.stock === null || typeof m.stock !== 'object' || typeof m.stock.name !== 'string') {
      fail(`${what}: expected a stock`);
    }
    size(m.stock.width, `${what} stock width`);
    size(m.stock.depth, `${what} stock depth`);
    size(m.length, `${what} length`);
    plane(m.placement, what);
  }
}
