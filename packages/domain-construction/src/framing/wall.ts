// The wall framing generator (M6 plan, T6.2a): the framing of a wall, from its geometry and
// settings, as member data. Deterministic and pure; millimetres inside (ADR 0005).
//
// The app is not an engineering tool (ADR 0015 decision 8): every size here is the user's choice, the
// generator lays members out by the geometric rules the settings name, and its warnings are
// layout warnings. Nothing here checks loads, spans or a building code.

import { MM_PER_INCH } from '@manufakture/units';
import type { Vec2, Vec3 } from '../geom';
import { memberFullId, memberIds, type CornerMemberName, type TeeMemberName } from '../member-ids';
import type { Member, Role, StockRef } from '../members';
import { overlaps, splice, subtract, type Interval } from './intervals';

// Input --------------------------------------------------------------------------------------

/**
 * Where the framing sits across the wall's reference line (start to end): `left` puts it on the
 * left of the line looking from start to end, `right` on the right, `center` centred on it.
 */
export type Justification = 'left' | 'center' | 'right';

/**
 * How a wall end meets another wall. The segment's `start` and `end` are the framed ends: at an L
 * corner the wall that runs through reaches the corner's outside, the butting wall stops at the
 * through wall's face; at a T the butting wall stops at the other wall's face. The feature layer
 * works these out from the wall graph.
 * - `free`: nothing meets it.
 * - `L` with `through: true`: this wall runs through; it carries the corner framing of the corner
 *   style, and its cap plate stops `otherThickness` short so the other wall's cap laps over it.
 * - `L` with `through: false`, and `T`: this wall butts into the other one; its cap plate runs
 *   `otherThickness` past the end, over the other wall.
 */
export type WallJoin =
  | { readonly kind: 'free' }
  | { readonly kind: 'L'; readonly through: boolean; readonly otherThickness: number }
  | { readonly kind: 'T'; readonly otherThickness: number };

/** A header: its stock, plies side by side across the wall, an optional spacer, its jacks. */
export interface HeaderSpec {
  readonly stock: StockRef;
  readonly plies: number;
  /** A strip between the first and second ply (1/2" plywood in a 2x4 wall), ripped to the header's depth. */
  readonly spacer?: StockRef;
  /** Jack studs under each end. */
  readonly jacks: number;
}

/** A row of the user's header rules table: openings up to `maxWidth` get `header` (ADR 0015 decision 7). */
export interface HeaderRule {
  readonly maxWidth: number;
  readonly header: HeaderSpec;
}

/** A door or window in the wall, by rough opening. */
export interface WallOpening {
  /** The opening's feature id (`extension#7`): the owner of its members (ADR 0015 decision 6). */
  readonly id: string;
  /** Centre of the rough opening along the segment, from the segment's start. */
  readonly position: number;
  readonly width: number;
  readonly height: number;
  /**
   * Height of the rough opening's bottom above the wall's base (the bottom of the bottom plate).
   * 0 is a door: the bottom plate is cut out across the rough opening. Above 0 is a window with a
   * rough sill.
   */
  readonly sill: number;
  /** The header, when the opening sets its own; otherwise a header rule or the default applies. */
  readonly header?: HeaderSpec;
  /** King studs each side; the settings' `kings` when absent. */
  readonly kings?: number;
  /** Jack studs each side; the header's `jacks` when absent. */
  readonly jacks?: number;
  /** Overrides of the opening's own members, keyed by local id (`king-l`, `header`). */
  readonly overrides?: readonly MemberOverride[];
}

/** Another wall's end meeting this wall's side (this wall is the host of a T intersection). */
export interface WallTee {
  /** Centre of the meeting wall's thickness along this segment, from its start. */
  readonly at: number;
  readonly otherThickness: number;
}

export interface WallSegment {
  /** Framed start and end of the reference line, in plan. */
  readonly start: Vec2;
  readonly end: Vec2;
  /** Elevation of the bottom of the bottom plate. Default 0. */
  readonly base?: number;
  /** From the bottom of the bottom plate to the top of the top plate. */
  readonly height: number;
  /** The framed thickness; must equal the stud stock's depth. */
  readonly thickness: number;
  readonly justification: Justification;
  readonly joins?: { readonly start?: WallJoin; readonly end?: WallJoin };
  readonly openings?: readonly WallOpening[];
  readonly tees?: readonly WallTee[];
}

/**
 * Corner and tee framing in the wall that runs through (the butting wall always ends in its own
 * end stud). Measured from the corner's outside:
 * - `two-stud`: the end stud (outside nailer) and a `corner` stud just past the other wall's
 *   inside face (drywall nailer), as Part 1 describes. At a tee: a stud each side of the meeting
 *   wall.
 * - `three-stud`: as `two-stud` plus a `corner-2` stud against the end stud (a nailer for the
 *   butting wall's end stud). At a tee: plus a stud centred on the meeting wall.
 * - `ladder`: the end stud and a `corner` stud a stud width past the other wall's inside face,
 *   with flat `backing` blocks between them at `ladderSpacing`. At a tee: the two flanking studs
 *   with backing between them.
 */
export type CornerStyle = 'two-stud' | 'three-stud' | 'ladder';

/** Blocking rows between studs: none, one at mid-height, or centred at the given heights above the base. */
export type BlockingRows =
  | { readonly kind: 'none' }
  | { readonly kind: 'mid-height' }
  | { readonly kind: 'heights'; readonly heights: readonly number[] };

export interface WallSettings {
  readonly studStock: StockRef;
  /** On centre. */
  readonly spacing: number;
  /**
   * Where slot 0's centre line would be, measured from the end layout starts at. 0 puts slot k's
   * centre at k x spacing, so 4' sheet edges land on stud centres. Only its remainder by the
   * spacing matters: `resolveWallSettings` brings it into (-spacing, 0], so an origin of a
   * spacing or more leaves no gap between s0 and s1 and one layout has one set of slot ids.
   */
  readonly layoutOrigin: number;
  readonly layoutFrom: 'start' | 'end';
  readonly bottomPlates: number;
  readonly topPlates: number;
  readonly cornerStyle: CornerStyle;
  readonly blocking: BlockingRows;
  /** Least distance between splices of different plate courses. */
  readonly spliceOffset: number;
  /** Lengths plate stock is sold in; plates longer than the longest are spliced. */
  readonly plateStockLengths: readonly number[];
  /**
   * Precut stud lengths: a stud within 0.5 mm of one is made exactly that length, so the takeoff
   * can match it to the precut stock.
   */
  readonly precutLengths: readonly number[];
  /** Vertical spacing of ladder backing rows. */
  readonly ladderSpacing: number;
  /** King studs each side of an opening. */
  readonly kings: number;
  /** The wall type's header, used when no rule matches (ADR 0015 decision 7). */
  readonly defaultHeader: HeaderSpec;
  /** The user's header rules; empty in a new document (ADR 0015 decision 7). */
  readonly headerRules: readonly HeaderRule[];
}

export type WallSettingsInput = Pick<WallSettings, 'studStock' | 'defaultHeader'> &
  Partial<Omit<WallSettings, 'studStock' | 'defaultHeader'>>;

/**
 * A per-member override (ADR 0015 decision 6), a param of the member's owner keyed by local id:
 * delete the member, change its stock, or move it along the wall (`move`, mm, positive towards
 * the segment's end).
 */
export interface MemberOverride {
  readonly id: string;
  readonly delete?: boolean;
  readonly stock?: StockRef;
  readonly move?: number;
}

export interface FrameWallInput {
  /**
   * The wall's feature id: the `owner` of its layout, plate, corner, tee and blocking members.
   * Opening members are owned by their opening.
   */
  readonly wall: string;
  readonly segments: readonly WallSegment[];
  readonly settings: WallSettingsInput;
  /** Overrides of the wall's own members, keyed by local id (`s12`, `top1:2`). */
  readonly overrides?: readonly MemberOverride[];
}

// Output -------------------------------------------------------------------------------------

export type WallWarningCode =
  | 'no-header-rule'
  | 'opening-outside-wall'
  | 'openings-overlap'
  | 'opening-does-not-fit'
  | 'header-wider-than-wall'
  | 'spacer-does-not-fit'
  | 'framing-conflict'
  | 'splice-offset'
  | 'blocking-row-outside'
  | 'blocking-row-overlap'
  | 'override-lost';

/**
 * A layout warning. `rule-of-thumb` ones are framing practice the layout departs from (labelled
 * as such wherever shown); `layout` ones say what the generator could not lay out as asked.
 * None of them is a structural assessment.
 */
export interface FramingWarning {
  readonly code: WallWarningCode;
  readonly kind: 'rule-of-thumb' | 'layout';
  readonly message: string;
  /** 1-based segment. */
  readonly segment?: number;
  readonly opening?: string;
  /** A full member id (`extension#3:s12`, `extension#7:king-l`). */
  readonly member?: string;
  /** Where along the segment (splices) or above the base (blocking rows), mm. */
  readonly at?: number;
}

/** Which header an opening got and where it came from (ADR 0015 decision 7). */
export interface OpeningReport {
  readonly id: string;
  readonly segment: number;
  readonly header: {
    readonly source: 'opening' | 'rule' | 'default';
    /** Index into `headerRules` when `source` is `rule`. */
    readonly rule?: number;
    readonly stock: string;
    readonly plies: number;
    readonly jacks: number;
  };
  readonly kings: number;
  /** False when the opening could not be framed (see the warnings). */
  readonly framed: boolean;
}

export interface OverrideReport {
  /** The feature whose params hold the override: the wall or one of its openings. */
  readonly owner: string;
  /** The local member id the override names. */
  readonly id: string;
  readonly status: 'applied' | 'lost';
}

export interface WallFraming {
  readonly members: Member[];
  readonly warnings: FramingWarning[];
  readonly openings: OpeningReport[];
  readonly overrides: OverrideReport[];
}

/** Input the generator cannot frame at all (not a layout warning). */
export class FramingInputError extends Error {
  override readonly name = 'FramingInputError';
}

// Defaults -----------------------------------------------------------------------------------

const IN = MM_PER_INCH;

/**
 * Defaults for everything but the stud stock and the default header (the user's choices). Their
 * sources are in the README: common practice and the 2021 IRC as summarised in the M6 plan,
 * Part 1, partly unverified.
 */
export const DEFAULT_WALL_SETTINGS: Omit<WallSettings, 'studStock' | 'defaultHeader'> = {
  spacing: 16 * IN,
  layoutOrigin: 0,
  layoutFrom: 'start',
  bottomPlates: 1,
  topPlates: 2,
  cornerStyle: 'two-stud',
  blocking: { kind: 'none' },
  spliceOffset: 24 * IN,
  plateStockLengths: [8, 10, 12, 14, 16].map((ft) => ft * 12 * IN),
  precutLengths: [92.625 * IN, 104.625 * IN],
  ladderSpacing: 24 * IN,
  kings: 1,
  headerRules: [],
};

// Generator ----------------------------------------------------------------------------------

/** Geometric tolerance, mm. */
const EPS = 1e-6;
/** Overlap below this is touching, mm. */
const TOUCH = 0.01;
/** A precut length matches within this, mm. */
const PRECUT_TOLERANCE = 0.5;
/** Members shorter than this are not emitted (a cripple of no length), mm. */
const MIN_MEMBER = 1;
/** A corner stud this close to a layout stud is that stud, mm. */
const SAME_STUD = 3;

const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;

type Orientation = 'flat' | 'vertical' | 'edge';
type Axis = 0 | 1 | 2; // s (along), t (across), z (up)
/** Member local x and y as signed wall axes; z follows. */
const ORIENT: Record<Orientation, { x: [Axis, 1 | -1]; y: [Axis, 1 | -1]; z: [Axis, 1 | -1] }> = {
  // Plates, sills, blocking: along the wall, thin face up, wide face across.
  flat: { x: [0, 1], y: [2, 1], z: [1, -1] },
  // Studs: up, thin face along the wall, wide face across.
  vertical: { x: [2, 1], y: [0, 1], z: [1, 1] },
  // Headers: along the wall, thin face across, wide face up.
  edge: { x: [0, 1], y: [1, 1], z: [2, 1] },
};

export function resolveWallSettings(input: WallSettingsInput): WallSettings {
  const s: WallSettings = { ...DEFAULT_WALL_SETTINGS, ...input };
  const fail = (msg: string) => {
    throw new FramingInputError(msg);
  };
  checkStock(s.studStock, 'Stud stock');
  checkHeader(s.defaultHeader, 'The default header');
  s.headerRules.forEach((r, i) => {
    if (!(r.maxWidth > 0)) fail(`Header rule ${i + 1} needs a width above 0.`);
    checkHeader(r.header, `Header rule ${i + 1}`);
  });
  if (!(s.spacing > s.studStock.width)) fail('Stud spacing must be wider than a stud.');
  if (!Number.isFinite(s.layoutOrigin)) fail('The layout origin must be a number.');
  if (!isCount(s.bottomPlates, 1, 3)) fail('Bottom plates must be 1 to 3.');
  if (!isCount(s.topPlates, 1, 3)) fail('Top plates must be 1 to 3.');
  if (!isCount(s.kings, 1, 4)) fail('Kings must be 1 to 4.');
  if (!(s.spliceOffset >= 0)) fail('The splice offset cannot be negative.');
  if (s.plateStockLengths.length === 0 || !s.plateStockLengths.every((l) => l > 0))
    fail('Plate stock lengths must be given and above 0.');
  if (!(s.ladderSpacing > s.studStock.width))
    fail('Ladder spacing must be more than a stud width.');
  if (s.blocking.kind === 'heights' && !s.blocking.heights.every(Number.isFinite))
    fail('Blocking heights must be numbers.');
  return { ...s, layoutOrigin: normalOrigin(s.layoutOrigin, s.spacing) };
}

/**
 * The layout origin brought into (-spacing, 0]. Only its remainder by the spacing places studs;
 * in that range slot 1 is the first centred stud after the start, so an origin of a spacing or
 * more leaves no gap between s0 and s1, and one layout has one set of slot ids.
 */
function normalOrigin(origin: number, spacing: number): number {
  let o = origin % spacing;
  if (o > EPS) o -= spacing;
  if (Math.abs(o) <= EPS || Math.abs(o + spacing) <= EPS) return 0;
  return o;
}

function isCount(n: number, lo: number, hi: number): boolean {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

function checkStock(stock: StockRef, what: string): void {
  if (!(stock.width > 0 && stock.depth > 0))
    throw new FramingInputError(`${what} needs a width and depth above 0.`);
}

function checkHeader(h: HeaderSpec, what: string): void {
  checkStock(h.stock, `${what}'s stock`);
  if (h.spacer) checkStock(h.spacer, `${what}'s spacer`);
  if (!isCount(h.plies, 1, 4)) throw new FramingInputError(`${what} needs 1 to 4 plies.`);
  if (!isCount(h.jacks, 1, 4)) throw new FramingInputError(`${what} needs 1 to 4 jacks.`);
}

/** Frames a wall: its members, layout warnings, the header each opening used, and override results. */
export function frameWall(input: FrameWallInput): WallFraming {
  const settings = resolveWallSettings(input.settings);
  if (input.segments.length === 0)
    throw new FramingInputError('A wall needs at least one segment.');
  const openingIds = new Set<string>();
  for (const seg of input.segments)
    for (const o of seg.openings ?? []) {
      if (!FEATURE_ID.test(o.id))
        throw new FramingInputError(`Opening id "${o.id}" is not a feature id.`);
      if (openingIds.has(o.id))
        throw new FramingInputError(`Opening "${o.id}" appears twice in the wall.`);
      openingIds.add(o.id);
    }

  const members: Member[] = [];
  const warnings: FramingWarning[] = [];
  const openings: OpeningReport[] = [];
  const dirOf = new Map<string, Vec3>();
  input.segments.forEach((seg, i) => {
    const framed = frameSegment(input.wall, seg, i + 1, settings, warnings, openings);
    for (const m of framed.members) {
      members.push(m);
      dirOf.set(memberFullId(m), framed.dir);
    }
  });

  // The wall's overrides first, then each opening's, in the order the openings are given.
  const overrides: Array<{ owner: string; o: MemberOverride }> = [
    ...(input.overrides ?? []).map((o) => ({ owner: input.wall, o })),
    ...input.segments.flatMap((seg) =>
      (seg.openings ?? []).flatMap((op) => (op.overrides ?? []).map((o) => ({ owner: op.id, o }))),
    ),
  ];
  const unframed = new Set(openings.filter((o) => !o.framed).map((o) => o.id));
  const applied = applyOverrides(input.wall, unframed, members, overrides, dirOf, warnings);
  return { members: applied.members, warnings, openings, overrides: applied.reports };
}

function applyOverrides(
  wall: string,
  unframed: ReadonlySet<string>,
  members: Member[],
  overrides: ReadonlyArray<{ owner: string; o: MemberOverride }>,
  dirOf: ReadonlyMap<string, Vec3>,
  warnings: FramingWarning[],
): { members: Member[]; reports: OverrideReport[] } {
  const byId = new Map(members.map((m, i) => [memberFullId(m), i]));
  const out: (Member | undefined)[] = [...members];
  const reports: OverrideReport[] = [];
  const deleted = new Set<string>();
  for (const { owner, o } of overrides) {
    const full = memberFullId({ owner, id: o.id });
    const i = byId.get(full);
    const m = i === undefined ? undefined : out[i];
    if (i === undefined || m === undefined) {
      const why = deleted.has(full)
        ? 'an earlier override of the same member deletes it.'
        : unframed.has(owner)
          ? 'the opening is not framed.'
          : `${owner === wall ? 'the wall' : 'the opening'} no longer has that member.`;
      reports.push({ owner, id: o.id, status: 'lost' });
      warnings.push({
        code: 'override-lost',
        kind: 'layout',
        message: `The override of ${o.id} on ${owner} is lost: ${why}`,
        ...(owner === wall ? {} : { opening: owner }),
        member: full,
      });
      continue;
    }
    reports.push({ owner, id: o.id, status: 'applied' });
    if (o.delete) {
      out[i] = undefined;
      deleted.add(full);
      continue;
    }
    let next: Member = m;
    if (o.stock) {
      checkStock(o.stock, `The override of ${o.id} on ${owner}`);
      next = { ...next, stock: o.stock };
    }
    if (o.move !== undefined && o.move !== 0) {
      const d = dirOf.get(full)!;
      const p = next.placement;
      next = {
        ...next,
        placement: {
          ...p,
          origin: [
            p.origin[0] + d[0] * o.move,
            p.origin[1] + d[1] * o.move,
            p.origin[2] + d[2] * o.move,
          ],
        },
      };
    }
    out[i] = next;
  }
  return { members: out.filter((m): m is Member => m !== undefined), reports };
}

interface Accepted {
  readonly o: WallOpening;
  readonly header: HeaderSpec;
  readonly jacks: number;
  readonly kings: number;
  /** Rough opening along the wall. */
  readonly ro: Interval;
  /** Kings' outer faces. */
  readonly zone: Interval;
  readonly door: boolean;
}

/** A corner or tee's members, placed or dropped together. */
interface FixedGroup {
  readonly label: string;
  /** Extent along the wall, for blocking rows to stay out of. */
  readonly zone: Interval;
  readonly studs: Array<{ id: string; s: Interval }>;
  readonly backing: Array<{ id: string; s: Interval; z: Interval }>;
  /** Where the cap plate stops so the meeting wall's cap laps in (tees). */
  readonly capGap?: Interval;
}

function frameSegment(
  wall: string,
  seg: WallSegment,
  index: number,
  st: WallSettings,
  warnings: FramingWarning[],
  reports: OpeningReport[],
): { members: Member[]; dir: Vec3 } {
  const where = `Wall segment ${index}`;
  const sw = st.studStock.width;
  const T = st.studStock.depth;
  const dx = seg.end[0] - seg.start[0];
  const dy = seg.end[1] - seg.start[1];
  const L = Math.hypot(dx, dy);
  const base = seg.base ?? 0;
  if (
    ![seg.start[0], seg.start[1], seg.end[0], seg.end[1], base, seg.height].every(Number.isFinite)
  )
    throw new FramingInputError(`${where} has a coordinate that is not a number.`);
  if (L < 2 * sw + EPS) throw new FramingInputError(`${where} is too short to frame.`);
  if (Math.abs(seg.thickness - T) > 0.01)
    throw new FramingInputError(`${where} is not as thick as its stud stock is deep.`);
  const zbot = st.bottomPlates * sw;
  let studLen = seg.height - (st.bottomPlates + st.topPlates) * sw;
  if (!(studLen > sw)) throw new FramingInputError(`${where} is too low for its plates.`);
  const precut = st.precutLengths.find((p) => Math.abs(p - studLen) <= PRECUT_TOLERANCE);
  if (precut !== undefined) studLen = precut;
  const studTop = zbot + studLen;

  const dir: Vec3 = [dx / L, dy / L, 0];
  const nrm: Vec3 = [-dir[1], dir[0], 0];
  const t0 = seg.justification === 'left' ? 0 : seg.justification === 'right' ? -T : -T / 2;
  const across: Interval = [t0, t0 + T];
  const world = (s: number, t: number, z: number): Vec3 => [
    seg.start[0] + s * dir[0] + t * nrm[0],
    seg.start[1] + s * dir[1] + t * nrm[1],
    base + z,
  ];
  const AX: Vec3[] = [dir, nrm, [0, 0, 1]];
  /** A member of the wall, or of the opening `owner` when given. */
  const box = (
    id: string,
    role: Role,
    stock: StockRef,
    o: Orientation,
    s: Interval,
    t: Interval,
    z: Interval,
    owner = wall,
  ): Member => {
    const ranges = [s, t, z];
    const spec = ORIENT[o];
    const at: [number, number, number] = [s[0], t[0], z[0]];
    for (const [axis, sign] of [spec.x, spec.y, spec.z])
      at[axis] = sign > 0 ? ranges[axis]![0] : ranges[axis]![1];
    const signed = ([axis, sign]: [Axis, 1 | -1]): Vec3 => {
      const v = AX[axis]!;
      return [v[0] * sign, v[1] * sign, v[2] * sign];
    };
    const xr = ranges[spec.x[0]]!;
    return {
      id,
      owner,
      role,
      stock,
      length: xr[1] - xr[0],
      placement: { origin: world(at[0], at[1], at[2]), x: signed(spec.x), y: signed(spec.y) },
      cuts: [],
    };
  };
  const warn = (w: Omit<FramingWarning, 'segment'>) => warnings.push({ ...w, segment: index });

  // Openings: resolve headers, check fit, accept in order along the wall.
  const accepted: Accepted[] = [];
  const sorted = [...(seg.openings ?? [])].sort((a, b) => a.position - b.position);
  for (const o of sorted) {
    const resolved = resolveHeader(o, st);
    const jacks = o.jacks ?? resolved.header.jacks;
    const kings = o.kings ?? st.kings;
    const report = (framed: boolean): OpeningReport => ({
      id: o.id,
      segment: index,
      header: {
        source: resolved.source,
        ...(resolved.rule === undefined ? {} : { rule: resolved.rule }),
        stock: resolved.header.stock.name,
        plies: resolved.header.plies,
        jacks,
      },
      kings,
      framed,
    });
    if (resolved.source === 'default' && st.headerRules.length > 0)
      warn({
        code: 'no-header-rule',
        kind: 'layout',
        message: `Opening ${o.id} is wider than every header rule; it uses the wall type's default header.`,
        opening: o.id,
      });
    const skip = (code: WallWarningCode, message: string) => {
      warn({ code, kind: 'layout', message, opening: o.id });
      reports.push(report(false));
    };
    if (!isCount(jacks, 1, 4) || !isCount(kings, 1, 4))
      throw new FramingInputError(`Opening ${o.id} needs 1 to 4 jacks and kings.`);
    if (
      ![o.position, o.width, o.height, o.sill].every(Number.isFinite) ||
      o.width <= 0 ||
      o.height <= 0 ||
      o.sill < 0
    )
      throw new FramingInputError(
        `Opening ${o.id} needs a position, a width and height above 0 and a sill of 0 or more.`,
      );
    const ro: Interval = [o.position - o.width / 2, o.position + o.width / 2];
    const side = (jacks + kings) * sw;
    const zone: Interval = [ro[0] - side, ro[1] + side];
    if (zone[0] < -EPS || zone[1] > L + EPS) {
      skip(
        'opening-outside-wall',
        `Opening ${o.id} and its kings do not fit inside the wall; it is not framed.`,
      );
      continue;
    }
    if (accepted.some((a) => overlaps(a.zone, zone, TOUCH))) {
      skip(
        'openings-overlap',
        `Opening ${o.id}'s framing overlaps another opening's; it is not framed.`,
      );
      continue;
    }
    const door = o.sill <= EPS;
    const head = o.sill + o.height;
    const headerTop = head + resolved.header.stock.depth;
    if (!door && o.sill - sw < zbot - EPS) {
      skip(
        'opening-does-not-fit',
        `Opening ${o.id}'s sill is too low for a rough sill on the bottom plate; it is not framed.`,
      );
      continue;
    }
    if (headerTop > studTop + EPS) {
      skip(
        'opening-does-not-fit',
        `Opening ${o.id}'s header does not fit under the top plates; it is not framed.`,
      );
      continue;
    }
    accepted.push({ o, header: resolved.header, jacks, kings, ro, zone, door });
    reports.push(report(true));
  }

  // Corner and tee framing, in the wall that runs through.
  const fixed: FixedGroup[] = [];
  const joins = seg.joins ?? {};
  for (const end of ['start', 'end'] as const) {
    const j = joins[end];
    if (j?.kind !== 'L' || !j.through) continue;
    checkThickness(j.otherThickness, where);
    // Built in distances from this end, then mirrored at the end.
    const at = (e: Interval): Interval => (end === 'start' ? e : [L - e[1], L - e[0]]);
    const T2 = j.otherThickness;
    const local: Array<{ id: string; e: Interval; z?: Interval }> = [];
    const cid = (name: CornerMemberName) => memberIds.corner(index, end, name);
    if (st.cornerStyle === 'ladder') {
      local.push({ id: cid('corner'), e: [T2 + sw, T2 + 2 * sw] });
      ladderRows(zbot, studTop, sw, st.ladderSpacing).forEach((z, r) =>
        local.push({ id: cid(`backing${r + 1}`), e: [sw, T2 + sw], z }),
      );
    } else {
      if (T2 < sw - EPS)
        warn({
          code: 'framing-conflict',
          kind: 'layout',
          message: `The corner at the ${end} of the wall is too thin for a corner stud; none is added.`,
        });
      else local.push({ id: cid('corner'), e: [T2, T2 + sw] });
      if (st.cornerStyle === 'three-stud') {
        if (2 * sw <= T2 + EPS) local.push({ id: cid('corner-2'), e: [sw, 2 * sw] });
        else
          warn({
            code: 'framing-conflict',
            kind: 'layout',
            message: `The corner at the ${end} of the wall has no room for a third stud.`,
          });
      }
    }
    const reach = Math.max(sw, ...local.map((x) => x.e[1]));
    fixed.push({
      label: `the corner at the ${end} of the wall`,
      zone: at([0, reach]),
      studs: local.filter((x) => !x.z).map((x) => ({ id: x.id, s: at(x.e) })),
      backing: local.flatMap((x) => (x.z ? [{ id: x.id, s: at(x.e), z: x.z }] : [])),
    });
  }
  (seg.tees ?? []).forEach((tee, i) => {
    checkThickness(tee.otherThickness, where);
    const half = tee.otherThickness / 2;
    const tid = (name: TeeMemberName) => memberIds.tee(index, i + 1, name);
    const studs = [
      { id: tid('corner-l'), s: [tee.at - half - sw, tee.at - half] as Interval },
      { id: tid('corner-r'), s: [tee.at + half, tee.at + half + sw] as Interval },
    ];
    const backing: Array<{ id: string; s: Interval; z: Interval }> = [];
    if (st.cornerStyle === 'three-stud' && tee.otherThickness >= sw - EPS)
      studs.push({ id: tid('corner-c'), s: [tee.at - sw / 2, tee.at + sw / 2] });
    if (st.cornerStyle === 'ladder')
      ladderRows(zbot, studTop, sw, st.ladderSpacing).forEach((z, r) =>
        backing.push({ id: tid(`backing${r + 1}`), s: [tee.at - half, tee.at + half], z }),
      );
    const zone: Interval = [tee.at - half - sw, tee.at + half + sw];
    if (zone[0] < -EPS || zone[1] > L + EPS) {
      warn({
        code: 'framing-conflict',
        kind: 'layout',
        message: `Tee ${i + 1} is outside the wall; it gets no framing.`,
      });
      return;
    }
    fixed.push({
      label: `tee ${i + 1}`,
      zone,
      studs,
      backing,
      capGap: [tee.at - half, tee.at + half],
    });
  });
  // A corner or tee that runs into an opening's framing, or an earlier corner or tee, is dropped.
  const placedFixed: FixedGroup[] = [];
  for (const g of fixed) {
    const parts = [...g.studs.map((x) => x.s), ...g.backing.map((x) => x.s)];
    const clash =
      accepted.some((a) => parts.some((p) => overlaps(p, a.zone, TOUCH))) ||
      placedFixed.some((f) => overlaps(f.zone, g.zone, TOUCH));
    if (clash) {
      warn({
        code: 'framing-conflict',
        kind: 'layout',
        message: `The framing of ${g.label} runs into other framing; it is left out.`,
      });
      continue;
    }
    placedFixed.push(g);
  }

  // Layout studs on their slots.
  const slots = layoutSlots(L, sw, st);
  const fixedStuds = placedFixed.flatMap((g) => g.studs);
  const fixedBacking = placedFixed.flatMap((g) => g.backing);
  const droppedFixed = new Set<string>();
  const studs: Array<{ id: string; k: number; s: Interval }> = [];
  for (const slot of slots) {
    if (accepted.some((a) => overlaps(slot.s, a.zone, TOUCH))) continue;
    const same = fixedStuds.find((f) => Math.abs(f.s[0] - slot.s[0]) < SAME_STUD);
    if (same) droppedFixed.add(same.id);
    else if (
      fixedStuds.some((f) => overlaps(f.s, slot.s, TOUCH)) ||
      fixedBacking.some((b) => overlaps(b.s, slot.s, TOUCH))
    )
      continue;
    studs.push({ id: memberIds.slot(index, slot.k), k: slot.k, s: slot.s });
  }

  const out: Member[] = [];
  const stud = st.studStock;

  // Plates.
  const doors = accepted.filter((a) => a.door).map((a) => a.ro);
  const maxStock = Math.max(...st.plateStockLengths);
  const spliceWarn = (plate: string, at: number[]) => {
    for (const p of at)
      warn({
        code: 'splice-offset',
        kind: 'rule-of-thumb',
        message: `A ${plate} plate splice is closer to a splice in the course below than the splice offset.`,
        at: p,
      });
  };
  let below: number[] = [];
  for (let c = 1; c <= st.bottomPlates; c++) {
    const z: Interval = [(c - 1) * sw, c * sw];
    const r = splice(subtract(0, L, doors, MIN_MEMBER), maxStock, below, st.spliceOffset);
    spliceWarn('bottom', r.tooClose);
    r.pieces.forEach((p, i) =>
      out.push(
        box(memberIds.plate(index, 'bottom', c, i + 1), 'bottom-plate', stud, 'flat', p, across, z),
      ),
    );
    below = [...below, ...r.splices];
  }
  const lap = (j: WallJoin | undefined): number => {
    if (!j || j.kind === 'free') return 0;
    return j.kind === 'L' && j.through ? -j.otherThickness : j.otherThickness;
  };
  below = [];
  for (let c = 1; c <= st.topPlates; c++) {
    const z: Interval = [studTop + (c - 1) * sw, studTop + c * sw];
    const cap = c === st.topPlates && st.topPlates >= 2;
    const runs = cap
      ? subtract(
          -lap(joins.start),
          L + lap(joins.end),
          placedFixed.flatMap((g) => (g.capGap ? [g.capGap] : [])),
          MIN_MEMBER,
        )
      : [[0, L] as Interval];
    const r = splice(runs, maxStock, below, st.spliceOffset);
    spliceWarn('top', r.tooClose);
    r.pieces.forEach((p, i) =>
      out.push(
        box(memberIds.plate(index, 'top', c, i + 1), 'top-plate', stud, 'flat', p, across, z),
      ),
    );
    below = [...below, ...r.splices];
  }

  // Studs, corners and tees.
  const full: Interval = [zbot, studTop];
  for (const s of studs) out.push(box(s.id, 'stud', stud, 'vertical', s.s, across, full));
  for (const f of fixedStuds)
    if (!droppedFixed.has(f.id)) out.push(box(f.id, 'corner', stud, 'vertical', f.s, across, full));
  for (const b of fixedBacking) out.push(box(b.id, 'backing', stud, 'flat', b.s, across, b.z));

  // Openings.
  for (const a of accepted) {
    const id = a.o.id;
    const head = a.o.sill + a.o.height;
    const h = a.header;
    const headerTop = head + h.stock.depth;
    for (const [side, sign] of [
      ['l', -1],
      ['r', 1],
    ] as const) {
      const edge = sign < 0 ? a.ro[0] : a.ro[1];
      const piece = (n: number): Interval =>
        sign < 0 ? [edge - n * sw, edge - (n - 1) * sw] : [edge + (n - 1) * sw, edge + n * sw];
      for (let n = 1; n <= a.jacks; n++)
        out.push(
          box(
            memberIds.opening({ form: 'jack', side, n }),
            'jack',
            stud,
            'vertical',
            piece(n),
            across,
            [zbot, head],
            id,
          ),
        );
      for (let n = 1; n <= a.kings; n++)
        out.push(
          box(
            memberIds.opening({ form: 'king', side, n }),
            'king',
            stud,
            'vertical',
            piece(a.jacks + n),
            across,
            full,
            id,
          ),
        );
    }
    // Header plies across the wall: the first on the low face, the spacer next to it, the rest
    // against the far face.
    const span: Interval = [a.ro[0] - a.jacks * sw, a.ro[1] + a.jacks * sw];
    const w = h.stock.width;
    const plyWidth = h.plies * w;
    if (plyWidth > T + EPS)
      warn({
        code: 'header-wider-than-wall',
        kind: 'layout',
        message: `Opening ${id}'s header plies are wider than the wall is thick.`,
        opening: id,
      });
    const zh: Interval = [head, headerTop];
    for (let p = 1; p <= h.plies; p++) {
      const t: Interval =
        p === 1 ? [t0, t0 + w] : [t0 + T - (h.plies - p + 1) * w, t0 + T - (h.plies - p) * w];
      out.push(
        box(
          memberIds.opening({ form: 'header', n: p }),
          'header',
          h.stock,
          'edge',
          span,
          t,
          zh,
          id,
        ),
      );
    }
    if (h.spacer && h.plies >= 2) {
      const gap = T - plyWidth;
      if (h.spacer.width > gap + EPS)
        warn({
          code: 'spacer-does-not-fit',
          kind: 'layout',
          message: `Opening ${id}'s header spacer is thicker than the room between its plies; it is left out.`,
          opening: id,
        });
      else {
        const spacer: StockRef = { ...h.spacer, depth: h.stock.depth };
        out.push(
          box(
            memberIds.opening({ form: 'spacer' }),
            'header-spacer',
            spacer,
            'edge',
            span,
            [t0 + w, t0 + w + h.spacer.width],
            zh,
            id,
          ),
        );
      }
    }
    // Rough sill and cripples on layout.
    if (!a.door) {
      out.push(
        box(
          memberIds.opening({ form: 'sill' }),
          'rough-sill',
          stud,
          'flat',
          a.ro,
          across,
          [a.o.sill - sw, a.o.sill],
          id,
        ),
      );
    }
    const centred = slots.filter((x) => x.centred);
    if (studTop - headerTop >= MIN_MEMBER) {
      centred
        .filter((x) => x.s[0] >= span[0] - EPS && x.s[1] <= span[1] + EPS)
        .sort((p, q) => p.s[0] - q.s[0])
        .forEach((x, i) =>
          out.push(
            box(
              memberIds.opening({ form: 'cripple', where: 'above', n: i + 1 }),
              'cripple',
              stud,
              'vertical',
              x.s,
              across,
              [headerTop, studTop],
              id,
            ),
          ),
        );
    }
    if (!a.door && a.o.sill - sw - zbot >= MIN_MEMBER) {
      centred
        .filter((x) => x.s[0] >= a.ro[0] - EPS && x.s[1] <= a.ro[1] + EPS)
        .sort((p, q) => p.s[0] - q.s[0])
        .forEach((x, i) =>
          out.push(
            box(
              memberIds.opening({ form: 'cripple', where: 'below', n: i + 1 }),
              'cripple',
              stud,
              'vertical',
              x.s,
              across,
              [zbot, a.o.sill - sw],
              id,
            ),
          ),
        );
    }
  }

  // Blocking rows between full-height studs, outside openings, corners and tees.
  const rows = blockingRows(st.blocking, zbot, studTop, sw, (h, code) =>
    warn({
      code,
      kind: 'layout',
      message:
        code === 'blocking-row-outside'
          ? 'A blocking row is outside the studs; it is left out.'
          : 'A blocking row overlaps the row below it; it is left out.',
      at: h,
    }),
  );
  if (rows.length > 0) {
    const verticals = out
      .filter((m) => m.role === 'stud' || m.role === 'king' || m.role === 'corner')
      .map((m) => alongOf(m, seg.start, dir))
      .sort((p, q) => p[0] - q[0]);
    const keepOut = [...accepted.map((a) => a.zone), ...placedFixed.map((g) => g.zone)];
    rows.forEach((z, r) => {
      let n = 0;
      for (let i = 0; i + 1 < verticals.length; i++) {
        const bay: Interval = [verticals[i]![1], verticals[i + 1]![0]];
        if (bay[1] - bay[0] < MIN_MEMBER) continue;
        if (keepOut.some((k) => bay[0] >= k[0] - EPS && bay[1] <= k[1] + EPS)) continue;
        out.push(box(memberIds.block(index, r + 1, ++n), 'blocking', stud, 'flat', bay, across, z));
      }
    });
  }

  return { members: out, dir };
}

function resolveHeader(
  o: WallOpening,
  st: WallSettings,
): { header: HeaderSpec; source: 'opening' | 'rule' | 'default'; rule?: number } {
  if (o.header) {
    checkHeader(o.header, `Opening ${o.id}'s header`);
    return { header: o.header, source: 'opening' };
  }
  let best: number | undefined;
  st.headerRules.forEach((r, i) => {
    if (
      r.maxWidth + EPS >= o.width &&
      (best === undefined || r.maxWidth < st.headerRules[best]!.maxWidth)
    )
      best = i;
  });
  if (best !== undefined)
    return { header: st.headerRules[best]!.header, source: 'rule', rule: best };
  return { header: st.defaultHeader, source: 'default' };
}

interface Slot {
  readonly k: number;
  readonly s: Interval;
  /** On a layout centre (not the stud flush with either end). */
  readonly centred: boolean;
}

/**
 * Layout slots: slot 0 flush with the end layout starts from, slot k (k >= 1) centred on
 * `layoutOrigin + k x spacing`, the last flush with the far end and numbered after the last centred
 * slot that fits. Centred slots that would overlap either end stud are left out (the end stud
 * stands there).
 */
function layoutSlots(L: number, sw: number, st: WallSettings): Slot[] {
  const fromEnd = st.layoutFrom === 'end';
  const map = (u: Interval): Interval => (fromEnd ? [L - u[1], L - u[0]] : u);
  const out: Slot[] = [{ k: 0, s: map([0, sw]), centred: false }];
  const kLast = Math.max(0, Math.floor((L - 1.5 * sw - st.layoutOrigin) / st.spacing + EPS));
  for (let k = 1; k <= kLast; k++) {
    const c = st.layoutOrigin + k * st.spacing;
    if (c - sw / 2 < sw - EPS) continue;
    out.push({ k, s: map([c - sw / 2, c + sw / 2]), centred: true });
  }
  out.push({ k: kLast + 1, s: map([L - sw, L]), centred: false });
  return out;
}

function ladderRows(zbot: number, studTop: number, sw: number, spacing: number): Interval[] {
  const out: Interval[] = [];
  for (let c = zbot + spacing; c + sw / 2 <= studTop - sw / 2 + EPS; c += spacing)
    out.push([c - sw / 2, c + sw / 2]);
  return out;
}

function blockingRows(
  rows: BlockingRows,
  zbot: number,
  studTop: number,
  sw: number,
  outside: (h: number, code: 'blocking-row-outside' | 'blocking-row-overlap') => void,
): Interval[] {
  const centres =
    rows.kind === 'none'
      ? []
      : rows.kind === 'mid-height'
        ? [(zbot + studTop) / 2]
        : [...rows.heights].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (const c of centres) {
    const row: Interval = [c - sw / 2, c + sw / 2];
    if (row[0] < zbot - EPS || row[1] > studTop + EPS) outside(c, 'blocking-row-outside');
    else if (out.some((r) => overlaps(r, row, TOUCH))) outside(c, 'blocking-row-overlap');
    else out.push(row);
  }
  return out;
}

/** A vertical member's extent along the wall (its local y runs along the wall). */
function alongOf(m: Member, start: Vec2, dir: Vec3): Interval {
  const o = m.placement.origin;
  const s = (o[0] - start[0]) * dir[0] + (o[1] - start[1]) * dir[1];
  return [s, s + m.stock.width];
}

function checkThickness(t: number, where: string): void {
  if (!(t > 0)) throw new FramingInputError(`${where} meets a wall with no thickness.`);
}
