// The floor framing generator (M6 plan, T6.2b): joists, rims, blocking and optional skids for a
// rectangular or rectilinear floor outline, as member data, and the subfloor as a sheet layer for
// the takeoff. Deterministic and pure; millimetres inside (ADR 0005).
//
// The app is not an engineering tool (ADR 0015 decision 8): the joist stock, rim stock, spacing,
// direction and skids are the user's choices. The generator lays members out by the geometric
// rules the settings name and checks no span, load or building code; its warnings are layout
// warnings.

import { MM_PER_INCH } from '@manufakture/units';
import type { Vec2, Vec3 } from '../geom';
import { memberFullId } from '../member-ids';
import type { Member, Role, StockRef } from '../members';
import { overlaps, splice, subtract, type Interval } from './intervals';
import { FramingInputError, type MemberOverride, type OverrideReport } from './wall';

// Member ids ---------------------------------------------------------------------------------
//
// Floor members, owned by the floor feature (ADR 0015 decision 6). `<p>` is the piece along the
// span when a band of joists is split by the outline (a U-shaped floor): the first piece has no
// suffix, later ones `:2`, `:3`, ...
//
//   j<k>[:<p>]        layout slot k: j0 flush at the end layout starts from, j<k> centred on
//                     `layoutOrigin + k x spacing`, the last flush at the far end
//   f<n>[:<p>]        the flush joist under the n-th inner edge of the outline parallel to the
//                     joists (an L or U floor), numbered along the layout
//   w<i>a, w<i>b      the doubled joists under the i-th parallel wall, numbered along the layout;
//   [:<p>]            `a` is the one nearer the layout's start
//   rim<n>[:<p>]      the rim on the n-th outline edge across the joists, numbered along the span
//                     and then along the layout; `:<p>` is a splice piece
//   block<r>:<n>      blocking row r, block n along the layout
//   skid<n>           skid n along the span

const N = '[1-9][0-9]*';
const N2 = '(?:[2-9]|[1-9][0-9]+)';
const PIECE = `(?::(${N2}))?`;

/** A parsed floor member id. `piece` counts from 1 (the unsuffixed first piece). */
export type FloorMemberId =
  | { readonly form: 'joist'; readonly slot: number; readonly piece: number }
  | { readonly form: 'flush'; readonly n: number; readonly piece: number }
  | {
      readonly form: 'doubled';
      readonly wall: number;
      readonly side: 'a' | 'b';
      readonly piece: number;
    }
  | { readonly form: 'rim'; readonly n: number; readonly piece: number }
  | { readonly form: 'block'; readonly row: number; readonly n: number }
  | { readonly form: 'skid'; readonly n: number };

const JOIST_ID = new RegExp(`^j(0|${N})${PIECE}$`);
const FLUSH_ID = new RegExp(`^f(${N})${PIECE}$`);
const DOUBLED_ID = new RegExp(`^w(${N})([ab])${PIECE}$`);
const RIM_ID = new RegExp(`^rim(${N})${PIECE}$`);
const BLOCK_ID = new RegExp(`^block(${N}):(${N})$`);
const SKID_ID = new RegExp(`^skid(${N})$`);

const pieceOf = (s: string | undefined) => (s === undefined ? 1 : Number(s));

/** Parses a floor's own member id; undefined when it is none of the floor forms above. */
export function parseFloorMemberId(id: string): FloorMemberId | undefined {
  let m = JOIST_ID.exec(id);
  if (m) return { form: 'joist', slot: Number(m[1]), piece: pieceOf(m[2]) };
  m = FLUSH_ID.exec(id);
  if (m) return { form: 'flush', n: Number(m[1]), piece: pieceOf(m[2]) };
  m = DOUBLED_ID.exec(id);
  if (m)
    return {
      form: 'doubled',
      wall: Number(m[1]),
      side: m[2] as 'a' | 'b',
      piece: pieceOf(m[3]),
    };
  m = RIM_ID.exec(id);
  if (m) return { form: 'rim', n: Number(m[1]), piece: pieceOf(m[2]) };
  m = BLOCK_ID.exec(id);
  if (m) return { form: 'block', row: Number(m[1]), n: Number(m[2]) };
  m = SKID_ID.exec(id);
  if (m) return { form: 'skid', n: Number(m[1]) };
  return undefined;
}

const withPiece = (base: string, piece: number) => (piece === 1 ? base : `${base}:${piece}`);

/** The id text of a parsed floor member id; round-trips with `parseFloorMemberId`. */
export function formatFloorMemberId(p: FloorMemberId): string {
  switch (p.form) {
    case 'joist':
      return withPiece(`j${p.slot}`, p.piece);
    case 'flush':
      return withPiece(`f${p.n}`, p.piece);
    case 'doubled':
      return withPiece(`w${p.wall}${p.side}`, p.piece);
    case 'rim':
      return withPiece(`rim${p.n}`, p.piece);
    case 'block':
      return `block${p.row}:${p.n}`;
    case 'skid':
      return `skid${p.n}`;
  }
}

// Input --------------------------------------------------------------------------------------

/**
 * Blocking rows between joists: none, one at mid-span (the middle of each bay's joist overlap),
 * or centred at the given distances along the span from the outline's start (its least extent
 * along the joist direction).
 */
export type FloorBlocking =
  | { readonly kind: 'none' }
  | { readonly kind: 'mid-span' }
  | { readonly kind: 'at'; readonly positions: readonly number[] };

/**
 * Skids (or beams) under the joists, running across them. `count` skids spread evenly across the
 * span with the outer two flush with the outline, unless `positions` gives their centres along the
 * span from the outline's start. Each runs the outline's extent along the layout plus `overhang`
 * at both ends. They stand on edge (the stock's depth up), under the joists.
 */
export interface SkidSettings {
  readonly stock: StockRef;
  readonly count: number;
  readonly overhang?: number;
  readonly positions?: readonly number[];
}

export interface FloorSettings {
  readonly joistStock: StockRef;
  /** Rim (band) joists; the joist stock when absent. */
  readonly rimStock: StockRef;
  /** On centre. */
  readonly spacing: number;
  /** As a wall's: slot k is centred on `layoutOrigin + k x spacing`, brought into (-spacing, 0]. */
  readonly layoutOrigin: number;
  readonly layoutFrom: 'start' | 'end';
  readonly blocking: FloorBlocking;
  /** Lengths joist and rim stock are sold in: longer rims are spliced, longer joists warn. */
  readonly stockLengths: readonly number[];
  /** A pair of joists under each wall that runs along the joists. */
  readonly doubleUnderWalls: boolean;
  readonly skids?: SkidSettings;
  /** The subfloor's sheet stock (`width` is its thickness), reported for the takeoff. */
  readonly subfloor?: StockRef;
}

export type FloorSettingsInput = Pick<FloorSettings, 'joistStock'> &
  Partial<Omit<FloorSettings, 'joistStock'>>;

/** A wall standing on the floor, by its centre line in plan (the feature layer resolves it). */
export interface FloorWall {
  /** The wall's feature id, for messages. */
  readonly id: string;
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface FrameFloorInput {
  /** The floor's feature id: the owner of every member. */
  readonly floor: string;
  /**
   * The outline in plan, a simple polygon (either winding) whose edges run along or across the
   * joists: a rectangle, or an L, T or U shape. Not closed (the last point is not the first).
   */
  readonly outline: readonly Vec2[];
  /** The direction the joists span, in plan. Need not be a unit vector. */
  readonly direction: Vec2;
  /** Elevation of the bottom of the joists and rims. Default 0. */
  readonly elevation?: number;
  readonly settings: FloorSettingsInput;
  /** Walls on the floor; those running along the joists get doubled joists. */
  readonly walls?: readonly FloorWall[];
  /**
   * Openings in the floor (stairs). Out of scope in M6 (ADR 0015 decision 12): any opening is
   * refused with a `FramingInputError`.
   */
  readonly openings?: readonly unknown[];
  /** Overrides of the floor's members, keyed by local id (`j3`, `rim1`). `move` is along the layout. */
  readonly overrides?: readonly MemberOverride[];
}

// Output -------------------------------------------------------------------------------------

export type FloorWarningCode =
  | 'wall-not-parallel'
  | 'wall-outside-floor'
  | 'framing-conflict'
  | 'longer-than-stock'
  | 'blocking-row-outside'
  | 'skid-outside'
  | 'override-lost';

/** A layout warning: what the generator could not lay out as asked. Never a structural assessment. */
export interface FloorWarning {
  readonly code: FloorWarningCode;
  readonly kind: 'rule-of-thumb' | 'layout';
  readonly message: string;
  /** The wall a `wall-*` warning is about. */
  readonly wall?: string;
  /** A full member id (`extension#9:j3`). */
  readonly member?: string;
  /** Where along the span (blocking rows, skids), mm. */
  readonly at?: number;
}

/** The subfloor as a sheet layer, for the takeoff (the layer body is the feature's, T6.1c). */
export interface SubfloorReport {
  readonly stock: StockRef;
  /** The outline in plan, counter-clockwise, as framed. */
  readonly outline: Vec2[];
  /** mm². */
  readonly area: number;
  /** Bottom and top elevation of the sheets. */
  readonly z: Interval;
}

export interface FloorFraming {
  readonly members: Member[];
  readonly warnings: FloorWarning[];
  readonly overrides: OverrideReport[];
  /** Elevation of the top of the framing (the subfloor's underside). */
  readonly top: number;
  readonly subfloor?: SubfloorReport;
}

// Defaults -----------------------------------------------------------------------------------

const IN = MM_PER_INCH;

/** Defaults for everything but the joist stock (the user's choice). Sources are in the README. */
export const DEFAULT_FLOOR_SETTINGS: Omit<FloorSettings, 'joistStock' | 'rimStock'> = {
  spacing: 16 * IN,
  layoutOrigin: 0,
  layoutFrom: 'start',
  blocking: { kind: 'none' },
  stockLengths: [8, 10, 12, 14, 16, 18, 20].map((ft) => ft * 12 * IN),
  doubleUnderWalls: true,
};

// Generator ----------------------------------------------------------------------------------

const EPS = 1e-6;
/** Overlap below this is touching, mm. */
const TOUCH = 0.01;
/** Members shorter than this are not emitted, mm. */
const MIN_MEMBER = 1;
/** A flush joist this close to a layout joist is that joist, mm. */
const SAME_JOIST = 3;
/** Outline points closer than this are one point; edges within this of square are square, mm. */
const SNAP = 0.01;
/** A wall within this angle of the joists runs along them (sine). */
const PARALLEL = 1e-3;

const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;

export function resolveFloorSettings(input: FloorSettingsInput): FloorSettings {
  const s: FloorSettings = {
    ...DEFAULT_FLOOR_SETTINGS,
    rimStock: input.joistStock,
    ...input,
  };
  const fail = (msg: string) => {
    throw new FramingInputError(msg);
  };
  checkStock(s.joistStock, 'Joist stock');
  checkStock(s.rimStock, 'Rim stock');
  if (s.subfloor) checkStock(s.subfloor, 'Subfloor stock');
  if (!(s.spacing > s.joistStock.width)) fail('Joist spacing must be wider than a joist.');
  if (!Number.isFinite(s.layoutOrigin)) fail('The layout origin must be a number.');
  if (s.stockLengths.length === 0 || !s.stockLengths.every((l) => l > 0))
    fail('Stock lengths must be given and above 0.');
  if (s.blocking.kind === 'at' && !s.blocking.positions.every(Number.isFinite))
    fail('Blocking positions must be numbers.');
  if (s.skids) {
    const k = s.skids;
    checkStock(k.stock, 'Skid stock');
    if (!(Number.isInteger(k.count) && k.count >= 1 && k.count <= 20))
      fail('Skids must be 1 to 20.');
    if (!(k.overhang === undefined || (Number.isFinite(k.overhang) && k.overhang >= 0)))
      fail('The skid overhang cannot be negative.');
    if (k.positions && (k.positions.length !== k.count || !k.positions.every(Number.isFinite)))
      fail('Skid positions must be numbers, one per skid.');
  }
  return { ...s, layoutOrigin: normalOrigin(s.layoutOrigin, s.spacing) };
}

function normalOrigin(origin: number, spacing: number): number {
  let o = origin % spacing;
  if (o > EPS) o -= spacing;
  if (Math.abs(o) <= EPS || Math.abs(o + spacing) <= EPS) return 0;
  return o;
}

function checkStock(stock: StockRef, what: string): void {
  if (!(stock.width > 0 && stock.depth > 0))
    throw new FramingInputError(`${what} needs a width and depth above 0.`);
}

/** A point in the joist frame: `u` along the span, `v` along the layout. */
type UV = readonly [number, number];

/** An outline edge in the joist frame, interior on its left (the outline is counter-clockwise). */
interface Edge {
  readonly a: UV;
  readonly b: UV;
  /** `across` edges have constant u (rims stand on them); `along` edges constant v. */
  readonly kind: 'across' | 'along';
}

/** A band of joists across the layout, `[v0, v1]`, before it is cut into pieces by the outline. */
interface Band {
  readonly v: Interval;
  /** The joists of one piece of the band: one, or two side by side for a doubled pair. */
  readonly make: (piece: number) => Array<{ id: string; v: Interval }>;
  /** Lower value is placed first; layout joists last. */
  readonly priority: number;
  readonly label: string;
  /** Layout joists give way silently; the others warn. */
  readonly layout: boolean;
  /** The wall a doubled pair is under. */
  readonly wall?: string;
}

/** Frames a floor: its members, layout warnings, override results and the subfloor layer. */
export function frameFloor(input: FrameFloorInput): FloorFraming {
  const st = resolveFloorSettings(input.settings);
  const owner = input.floor;
  if (!FEATURE_ID.test(owner))
    throw new FramingInputError(`Floor id "${owner}" is not a feature id.`);
  if ((input.openings ?? []).length > 0)
    throw new FramingInputError(
      'Floor openings (stairs) are not framed in this version; frame the opening by hand.',
    );
  const elevation = input.elevation ?? 0;
  if (!Number.isFinite(elevation)) throw new FramingInputError('The elevation must be a number.');
  const [dx, dy] = input.direction;
  const dl = Math.hypot(dx, dy);
  if (!(dl > EPS) || !Number.isFinite(dl))
    throw new FramingInputError('The joist direction needs a length.');
  const U: Vec2 = [dx / dl, dy / dl];
  const V: Vec2 = [-U[1], U[0]];
  const toUV = (p: Vec2): UV => [p[0] * U[0] + p[1] * U[1], p[0] * V[0] + p[1] * V[1]];
  const toPlan = (u: number, v: number): Vec2 => [u * U[0] + v * V[0], u * U[1] + v * V[1]];

  const poly = rectilinear(
    input.outline.map((p) => {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
        throw new FramingInputError('The floor outline has a coordinate that is not a number.');
      return toUV(p);
    }),
  );
  const edges = edgesOf(poly);
  const jw = st.joistStock.width;
  const rw = st.rimStock.width;
  const shortest = Math.min(...edges.map((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])));
  if (shortest < 2 * Math.max(jw, rw) - EPS)
    throw new FramingInputError('An edge of the floor outline is shorter than two joists.');

  const us = poly.map((p) => p[0]);
  const vs = poly.map((p) => p[1]);
  const umin = Math.min(...us);
  const umax = Math.max(...us);
  const vmin = Math.min(...vs);
  const vmax = Math.max(...vs);
  const fromEnd = st.layoutFrom === 'end';
  /** Distance along the layout from where it starts, for numbering. */
  const ell = (v: number) => (fromEnd ? vmax - v : v - vmin);

  const warnings: FloorWarning[] = [];
  const full = (id: string) => memberFullId({ owner, id });
  const out: Member[] = [];
  const box = (
    id: string,
    role: Role,
    stock: StockRef,
    kind: 'span' | 'across',
    u: Interval,
    v: Interval,
    z: Interval,
  ): Member => {
    // `span`: along u, thin face along v, depth up (x = U, y = V, z = up).
    // `across`: along v, thin face along u, depth up (x = V, y = -U, z = up).
    const o = kind === 'span' ? toPlan(u[0], v[0]) : toPlan(u[1], v[0]);
    const x: Vec3 = kind === 'span' ? [U[0], U[1], 0] : [V[0], V[1], 0];
    const y: Vec3 = kind === 'span' ? [V[0], V[1], 0] : [-U[0], -U[1], 0];
    return {
      id,
      owner,
      role,
      stock,
      length: kind === 'span' ? u[1] - u[0] : v[1] - v[0],
      placement: { origin: [o[0], o[1], elevation + z[0]], x, y },
      cuts: [],
    };
  };

  // Rims on every edge across the joists, full length, interior side.
  const rims = edges
    .filter((e) => e.kind === 'across')
    .map((e) => {
      const u = e.a[0];
      const up = e.b[1] > e.a[1];
      // Counter-clockwise: going up (+v) the interior is at lower u.
      const band: Interval = up ? [u - rw, u] : [u, u + rw];
      const v: Interval = up ? [e.a[1], e.b[1]] : [e.b[1], e.a[1]];
      return { u: band, v };
    })
    .sort((p, q) => p.u[0] - q.u[0] || ell(p.v[0]) - ell(q.v[0]));
  for (let i = 0; i < rims.length; i++)
    for (let j = i + 1; j < rims.length; j++)
      if (overlaps(rims[i]!.u, rims[j]!.u, TOUCH) && overlaps(rims[i]!.v, rims[j]!.v, TOUCH))
        throw new FramingInputError('The floor is too narrow for its rims.');
  const maxStock = Math.max(...st.stockLengths);
  const rimDepth = st.rimStock.depth;
  rims.forEach((r, i) => {
    const pieces = splice([r.v], maxStock, [], 0).pieces;
    const ordered = fromEnd ? [...pieces].reverse() : pieces;
    ordered.forEach((p, k) =>
      out.push(
        box(
          formatFloorMemberId({ form: 'rim', n: i + 1, piece: k + 1 }),
          'rim',
          st.rimStock,
          'across',
          r.u,
          p,
          [0, rimDepth],
        ),
      ),
    );
  });

  // Joist bands: the layout's end slots and the inner edges along the joists first, then the
  // doubled joists under walls, then the layout.
  const bands: Band[] = [];
  const slots = layoutSlots(vmax - vmin, jw, st).map((s) => ({
    k: s.k,
    v: (fromEnd ? [vmax - s.l[1], vmax - s.l[0]] : [vmin + s.l[0], vmin + s.l[1]]) as Interval,
    centred: s.centred,
  }));
  const slotId = (k: number, v: Interval) => (piece: number) => [
    { id: formatFloorMemberId({ form: 'joist', slot: k, piece }), v },
  ];
  const usedSlots = new Set<number>();
  for (const s of slots)
    if (!s.centred) {
      bands.push({
        v: s.v,
        make: slotId(s.k, s.v),
        priority: 0,
        label: `joist j${s.k}`,
        layout: false,
      });
      usedSlots.add(s.k);
    }
  const inner = new Map<string, Interval>();
  for (const e of edges) {
    if (e.kind !== 'along') continue;
    const v = e.a[1];
    if (Math.abs(v - vmin) < SNAP || Math.abs(v - vmax) < SNAP) continue;
    // Counter-clockwise: going +u the interior is at higher v.
    const band: Interval = e.b[0] > e.a[0] ? [v, v + jw] : [v - jw, v];
    inner.set(band[0].toFixed(3), band);
  }
  const innerBands = [...inner.values()].sort((p, q) => ell(p[0]) - ell(q[0]) || p[0] - q[0]);
  let fn = 0;
  for (const band of innerBands) {
    const same = slots.find(
      (s) => s.centred && !usedSlots.has(s.k) && Math.abs(s.v[0] - band[0]) < SAME_JOIST,
    );
    if (same) {
      usedSlots.add(same.k);
      bands.push({
        v: band,
        make: slotId(same.k, band),
        priority: 0,
        label: `joist j${same.k}`,
        layout: false,
      });
    } else {
      const n = ++fn;
      bands.push({
        v: band,
        make: (piece) => [{ id: formatFloorMemberId({ form: 'flush', n, piece }), v: band }],
        priority: 0,
        label: `flush joist f${n}`,
        layout: false,
      });
    }
  }
  if (st.doubleUnderWalls) {
    const walls: Array<{ wall: FloorWall; c: number }> = [];
    for (const w of input.walls ?? []) {
      const a = toUV(w.start);
      const b = toUV(w.end);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (![a[0], a[1], b[0], b[1]].every(Number.isFinite) || !(len > EPS))
        throw new FramingInputError(`Wall ${w.id} needs a start and an end.`);
      if (Math.abs(b[1] - a[1]) / len > PARALLEL) {
        if (Math.abs(b[1] - a[1]) / len < 1 - PARALLEL)
          warnings.push({
            code: 'wall-not-parallel',
            kind: 'layout',
            message: `Wall ${w.id} runs neither along nor across the joists; it gets no doubled joists.`,
            wall: w.id,
          });
        continue;
      }
      walls.push({ wall: w, c: (a[1] + b[1]) / 2 });
    }
    walls
      .sort((p, q) => ell(p.c) - ell(q.c) || p.wall.id.localeCompare(q.wall.id))
      .forEach(({ wall, c }, i) => {
        const lo: Interval = [c - jw, c];
        const hi: Interval = [c, c + jw];
        const [a, b] = fromEnd ? [hi, lo] : [lo, hi];
        const id = (side: 'a' | 'b', piece: number) =>
          formatFloorMemberId({ form: 'doubled', wall: i + 1, side, piece });
        bands.push({
          v: [c - jw, c + jw],
          make: (piece) => [
            { id: id('a', piece), v: a },
            { id: id('b', piece), v: b },
          ],
          priority: 1,
          label: `the doubled joists under wall ${wall.id}`,
          layout: false,
          wall: wall.id,
        });
      });
  }
  for (const s of slots)
    if (s.centred && !usedSlots.has(s.k))
      bands.push({
        v: s.v,
        make: slotId(s.k, s.v),
        priority: 2,
        label: `joist j${s.k}`,
        layout: true,
      });

  // Cut each band into pieces inside the outline and between the rims, then place it unless it
  // runs into a band placed before it.
  const joists: Array<{ id: string; u: Interval; v: Interval }> = [];
  const piecesOf = (v: Interval): Interval[] => {
    let parts = coverage(poly, v);
    for (const r of rims)
      if (overlaps(r.v, v, TOUCH)) parts = parts.flatMap(([a, b]) => subtract(a, b, [r.u], 0));
    return parts.filter(([a, b]) => b - a >= MIN_MEMBER);
  };
  const placedBands: Array<{ v: Interval; pieces: Interval[] }> = [];
  for (const band of [...bands].sort((p, q) => p.priority - q.priority)) {
    const pieces = piecesOf(band.v);
    const skip = (code: FloorWarningCode, message: string) => {
      if (!band.layout)
        warnings.push({ code, kind: 'layout', message, ...(band.wall ? { wall: band.wall } : {}) });
    };
    if (pieces.length === 0) {
      skip('wall-outside-floor', `${cap(band.label)} would fall outside the floor; left out.`);
      continue;
    }
    const clash = placedBands.some(
      (p) =>
        overlaps(p.v, band.v, TOUCH) &&
        p.pieces.some((a) => pieces.some((b) => overlaps(a, b, TOUCH))),
    );
    if (clash) {
      skip('framing-conflict', `${cap(band.label)} run into other joists; left out.`);
      continue;
    }
    placedBands.push({ v: band.v, pieces });
    pieces.forEach((u, i) => {
      for (const j of band.make(i + 1)) joists.push({ id: j.id, u, v: j.v });
    });
  }
  const kept = joists.sort((p, q) => ell(p.v[0]) - ell(q.v[0]) || p.u[0] - q.u[0]);
  const jd = st.joistStock.depth;
  for (const j of kept) {
    out.push(box(j.id, 'joist', st.joistStock, 'span', j.u, j.v, [0, jd]));
    if (j.u[1] - j.u[0] > maxStock + EPS)
      warnings.push({
        code: 'longer-than-stock',
        kind: 'layout',
        message: `Joist ${j.id} is longer than the longest stock length.`,
        member: full(j.id),
      });
  }

  // Blocking rows: between joists next to each other along the layout whose spans overlap.
  const positions =
    st.blocking.kind === 'at' ? [...st.blocking.positions].sort((a, b) => a - b) : [];
  const rows: Array<(bay: Interval) => number | undefined> =
    st.blocking.kind === 'none'
      ? []
      : st.blocking.kind === 'mid-span'
        ? [(bay) => (bay[0] + bay[1]) / 2]
        : positions.map((p) => {
            const u = umin + p;
            return (bay) =>
              u - jw / 2 >= bay[0] - EPS && u + jw / 2 <= bay[1] + EPS ? u : undefined;
          });
  const byV = [...kept].sort((p, q) => p.v[0] - q.v[0] || p.u[0] - q.u[0]);
  rows.forEach((at, r) => {
    const blocks: Array<{ u: Interval; v: Interval }> = [];
    for (let i = 0; i < byV.length; i++) {
      const a = byV[i]!;
      // Every joist above whose span overlaps this one's, over the part of the overlap with no
      // joist between them: a full-span joist under a U's two arms has a bay up into each arm.
      for (const b of byV.slice(i + 1)) {
        if (b.v[0] < a.v[1] - TOUCH || !overlaps(b.u, a.u, TOUCH)) continue;
        const v: Interval = [a.v[1], b.v[0]];
        if (v[1] - v[0] < MIN_MEMBER) continue;
        const between = kept
          .filter((k) => k !== a && k !== b && overlaps(k.v, v, TOUCH))
          .map((k) => k.u);
        const lo = Math.max(a.u[0], b.u[0]);
        const hi = Math.min(a.u[1], b.u[1]);
        for (const bay of subtract(lo, hi, between, TOUCH)) {
          const c = at(bay);
          if (c === undefined) continue;
          const u: Interval = [c - jw / 2, c + jw / 2];
          if (u[0] < bay[0] - EPS || u[1] > bay[1] + EPS) continue;
          // Inside the outline (a U floor's two arms are not one bay) and clear of other joists.
          if (!coverage(swap(poly), u).some(([p, q]) => p <= v[0] + EPS && q >= v[1] - EPS))
            continue;
          if (
            kept.some(
              (k) => k !== a && k !== b && overlaps(k.u, u, TOUCH) && overlaps(k.v, v, TOUCH),
            )
          )
            continue;
          blocks.push({ u, v });
        }
      }
    }
    if (blocks.length === 0 && st.blocking.kind === 'at')
      warnings.push({
        code: 'blocking-row-outside',
        kind: 'layout',
        message: 'A blocking row falls in no bay between joists; it is left out.',
        at: positions[r]!,
      });
    blocks
      .sort((p, q) => ell(p.v[0]) - ell(q.v[0]) || p.u[0] - q.u[0])
      .forEach((b, n) =>
        out.push(
          box(
            formatFloorMemberId({ form: 'block', row: r + 1, n: n + 1 }),
            'blocking',
            st.joistStock,
            'across',
            b.u,
            b.v,
            [0, jd],
          ),
        ),
      );
  });

  // Skids under the joists, across them.
  if (st.skids) {
    const k = st.skids;
    const sw = k.stock.width;
    const overhang = k.overhang ?? 0;
    const centres =
      k.positions?.map((p) => umin + p) ??
      (k.count === 1
        ? [(umin + umax) / 2]
        : Array.from(
            { length: k.count },
            (_, i) => umin + sw / 2 + (i * (umax - umin - sw)) / (k.count - 1),
          ));
    const placed: Interval[] = [];
    [...centres]
      .sort((a, b) => a - b)
      .forEach((c, i) => {
        const u: Interval = [c - sw / 2, c + sw / 2];
        const along = coverage(swap(poly), u);
        const id = formatFloorMemberId({ form: 'skid', n: i + 1 });
        if (along.length === 0 || placed.some((p) => overlaps(p, u, TOUCH))) {
          warnings.push({
            code: 'skid-outside',
            kind: 'layout',
            message: `Skid ${i + 1} is outside the floor or on another skid; it is left out.`,
            member: full(id),
            at: c - umin,
          });
          return;
        }
        placed.push(u);
        const v: Interval = [
          Math.min(...along.map((a) => a[0])) - overhang,
          Math.max(...along.map((a) => a[1])) + overhang,
        ];
        out.push(box(id, 'skid', k.stock, 'across', u, v, [-k.stock.depth, 0]));
        if (v[1] - v[0] > maxStock + EPS)
          warnings.push({
            code: 'longer-than-stock',
            kind: 'layout',
            message: `Skid ${i + 1} is longer than the longest stock length.`,
            member: full(id),
          });
      });
  }

  const applied = applyOverrides(owner, out, input.overrides ?? [], [V[0], V[1], 0], warnings);
  const top = elevation + Math.max(jd, rimDepth);
  const subfloor: SubfloorReport | undefined = st.subfloor
    ? {
        stock: st.subfloor,
        outline: poly.map((p) => toPlan(p[0], p[1])),
        area: area(poly),
        z: [top, top + st.subfloor.width],
      }
    : undefined;
  return {
    members: applied.members,
    warnings,
    overrides: applied.reports,
    top,
    ...(subfloor ? { subfloor } : {}),
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The outline cleaned (repeated and collinear points dropped), counter-clockwise, with every edge
 * along u or v snapped exactly. Refuses fewer than four corners, an edge at an angle to the
 * joists, and a self-intersecting outline.
 */
function rectilinear(raw: readonly UV[]): UV[] {
  let pts: UV[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > SNAP) pts.push(p);
  }
  while (
    pts.length > 1 &&
    Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]) <= SNAP
  )
    pts.pop();
  const kindOf = (a: UV, b: UV): 'across' | 'along' => {
    const du = Math.abs(b[0] - a[0]);
    const dv = Math.abs(b[1] - a[1]);
    if (du <= SNAP) return 'across';
    if (dv <= SNAP) return 'along';
    throw new FramingInputError(
      'Every edge of the floor outline must run along or across the joists.',
    );
  };
  // Merge collinear runs (two edges of one kind in a row).
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      if (kindOf(a, b) === kindOf(b, c)) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (pts.length < 4) throw new FramingInputError('The floor outline needs at least four corners.');
  if (area(pts) < 0) pts = pts.reverse();
  // Snap: every corner takes its u from the across edge and its v from the along edge it joins.
  const n = pts.length;
  const snapped: UV[] = pts.map((p, i) => {
    const prev = pts[(i + n - 1) % n]!;
    const next = pts[(i + 1) % n]!;
    const [acrossNb, alongNb] = kindOf(prev, p) === 'across' ? [prev, next] : [next, prev];
    return [(p[0] + acrossNb[0]) / 2, (p[1] + alongNb[1]) / 2];
  });
  const edges = edgesOf(snapped);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (touches(edges[i]!, edges[j]!))
        throw new FramingInputError('The floor outline crosses or touches itself.');
    }
  return snapped;
}

function edgesOf(poly: readonly UV[]): Edge[] {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    return { a, b, kind: Math.abs(b[0] - a[0]) <= SNAP ? 'across' : 'along' };
  });
}

function touches(e: Edge, f: Edge): boolean {
  const box = (x: Edge) => ({
    u: [Math.min(x.a[0], x.b[0]), Math.max(x.a[0], x.b[0])] as Interval,
    v: [Math.min(x.a[1], x.b[1]), Math.max(x.a[1], x.b[1])] as Interval,
  });
  const p = box(e);
  const q = box(f);
  return (
    Math.min(p.u[1], q.u[1]) - Math.max(p.u[0], q.u[0]) >= -SNAP &&
    Math.min(p.v[1], q.v[1]) - Math.max(p.v[0], q.v[0]) >= -SNAP
  );
}

/** Signed area (positive counter-clockwise). */
function area(poly: readonly UV[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The polygon with u and v swapped (still a valid polygon, opposite winding). */
function swap(poly: readonly UV[]): UV[] {
  return poly.map((p) => [p[1], p[0]]);
}

/** The u-intervals inside the polygon at height v (the line must miss every corner). */
function slice(poly: readonly UV[], v: number): Interval[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a[1] > v !== b[1] > v) xs.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}

/** The u-intervals where the whole band `[v0, v1]` is inside the polygon. */
function coverage(poly: readonly UV[], band: Interval): Interval[] {
  const breaks = [
    band[0],
    band[1],
    ...poly.map((p) => p[1]).filter((v) => v > band[0] + EPS && v < band[1] - EPS),
  ].sort((a, b) => a - b);
  let acc: Interval[] | undefined;
  for (let i = 0; i + 1 < breaks.length; i++) {
    if (breaks[i + 1]! - breaks[i]! <= EPS) continue;
    const s = slice(poly, (breaks[i]! + breaks[i + 1]!) / 2);
    acc = acc === undefined ? s : intersect(acc, s);
  }
  return acc ?? slice(poly, (band[0] + band[1]) / 2);
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const p of a)
    for (const q of b) {
      const lo = Math.max(p[0], q[0]);
      const hi = Math.min(p[1], q[1]);
      if (hi - lo > EPS) out.push([lo, hi]);
    }
  return out.sort((p, q) => p[0] - q[0]);
}

/**
 * Layout slots along a run of length L, in distances from where layout starts: slot 0 flush, slot
 * k centred on `layoutOrigin + k x spacing`, the last flush at the far end (as a wall's studs).
 */
function layoutSlots(
  L: number,
  w: number,
  st: FloorSettings,
): Array<{ k: number; l: Interval; centred: boolean }> {
  const out: Array<{ k: number; l: Interval; centred: boolean }> = [
    { k: 0, l: [0, w], centred: false },
  ];
  const kLast = Math.max(0, Math.floor((L - 1.5 * w - st.layoutOrigin) / st.spacing + EPS));
  for (let k = 1; k <= kLast; k++) {
    const c = st.layoutOrigin + k * st.spacing;
    if (c - w / 2 < w - EPS) continue;
    out.push({ k, l: [c - w / 2, c + w / 2], centred: true });
  }
  out.push({ k: kLast + 1, l: [L - w, L], centred: false });
  return out;
}

function applyOverrides(
  owner: string,
  members: Member[],
  overrides: readonly MemberOverride[],
  dir: Vec3,
  warnings: FloorWarning[],
): { members: Member[]; reports: OverrideReport[] } {
  const byId = new Map(members.map((m, i) => [m.id, i]));
  const out: (Member | undefined)[] = [...members];
  const reports: OverrideReport[] = [];
  const deleted = new Set<string>();
  for (const o of overrides) {
    if (o.move !== undefined && !Number.isFinite(o.move))
      throw new FramingInputError(
        `The move in the override of ${o.id} on ${owner} is not a number.`,
      );
    const i = byId.get(o.id);
    const m = i === undefined ? undefined : out[i];
    if (i === undefined || m === undefined) {
      const why = deleted.has(o.id)
        ? 'an earlier override of the same member deletes it.'
        : 'the floor no longer has that member.';
      reports.push({ owner, id: o.id, status: 'lost' });
      warnings.push({
        code: 'override-lost',
        kind: 'layout',
        message: `The override of ${o.id} on ${owner} is lost: ${why}`,
        member: memberFullId({ owner, id: o.id }),
      });
      continue;
    }
    reports.push({ owner, id: o.id, status: 'applied' });
    if (o.delete) {
      out[i] = undefined;
      deleted.add(o.id);
      continue;
    }
    let next: Member = m;
    if (o.stock) {
      checkStock(o.stock, `The override of ${o.id} on ${owner}`);
      next = { ...next, stock: o.stock };
    }
    if (o.move !== undefined && o.move !== 0) {
      const p = next.placement;
      next = {
        ...next,
        placement: {
          ...p,
          origin: [p.origin[0] + dir[0] * o.move, p.origin[1] + dir[1] * o.move, p.origin[2]],
        },
      };
    }
    out[i] = next;
  }
  return { members: out.filter((m): m is Member => m !== undefined), reports };
}
