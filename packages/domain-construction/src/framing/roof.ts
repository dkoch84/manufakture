// The roof framing generator (M6 plan, T6.2c): a gable or hip roof over a rectangular footprint,
// from a pitch and settings, as member data. Deterministic and pure; millimetres inside (ADR 0005).
//
// The app is not an engineering tool (ADR 0015 decision 8): rafter, ridge and hip sizes are the
// user's choice, the generator lays members out by the geometry of the pitch (M6 plan, Part 1,
// "Roof pitch math"), and its warnings are layout warnings, some labelled rules of thumb. Nothing
// here checks loads, spans or a building code.
//
// Coordinates. The generator works in the roof's own plan frame: `u` along the footprint's length,
// `v` across it, `z` up (elevation). The footprint is `u` in [0, length], `v` in [0, width], at the
// outside of the walls' top plates. Its four edges, counter-clockwise from the origin:
//
//   e1  v = 0       an eave on either kind; t runs along u
//   e2  u = length  a gable end, or a hip end eave; t runs along v
//   e3  v = width   an eave on either kind; t runs along u
//   e4  u = 0       a gable end, or a hip end eave; t runs along v
//
// Along every edge `t` is measured from its end with the smaller coordinate (end `a`); the other
// end is `b`. So slot k on e1 and slot k on e3 face each other, and a jack on one side of a hip
// pairs with the jack on the other side. Corners: c1 (0, 0), c2 (length, 0), c3 (length, width),
// c4 (0, width). Inside an edge's frame `r` is the plan distance inward from the wall line.

import { MM_PER_INCH } from '@manufakture/units';
import { dot, zAxis, type Placement, type Plane, type Vec2, type Vec3 } from '../geom';
import { memberFullId } from '../member-ids';
import type { Cut, Member, Role, StockRef } from '../members';
import { FramingInputError, type MemberOverride, type OverrideReport } from './wall';

// Member ids -----------------------------------------------------------------------------------
//
// Roof members, owned by the roof (gable studs included, since they are cut to the roof line and a
// change of pitch must re-run only the roof):
//
//   e<n>:c<k>          common rafter at slot k on eave edge n (gable: slot 0 flush with end a,
//                      slot k centred on k x spacing from end a, the last flush with end b; hip:
//                      slot 0 at the ridge end nearer end a, the last at the other ridge end, and
//                      on e2 and e4 the one king common `c0`)
//   e<n>:ja<k>, jb<k>  jack rafter k on a hip roof's edge n, k spacings from the ridge-end common
//                      towards end a or end b
//   e<n>:fly-a, fly-b  fly (barge) rafter of a gable's rake overhang, beyond end a or end b
//   e<n>:g<k>          gable stud k on gable end n, centred on the gable wall's layout position k
//   e<n>:sub:<p>       sub-fascia piece p along edge n
//   e<n>:fascia:<p>    fascia piece p along edge n
//   hip<c>             hip rafter at corner c
//   ridge:<p>          ridge board piece p
//   tie<k>             ceiling joist or rafter tie beside the common rafters at slot k (e1 and e3)
//
// Every id has one spelling: numbers have no leading zeros; pieces count from 1, slots from 0.

export type RoofEdge = 1 | 2 | 3 | 4;
export type RoofCorner = 1 | 2 | 3 | 4;

/** A parsed roof member id. */
export type RoofMemberId =
  | { readonly form: 'common'; readonly edge: RoofEdge; readonly slot: number }
  | {
      readonly form: 'jack';
      readonly edge: RoofEdge;
      readonly end: 'a' | 'b';
      readonly n: number;
    }
  | { readonly form: 'fly'; readonly edge: RoofEdge; readonly end: 'a' | 'b' }
  | { readonly form: 'gable-stud'; readonly edge: RoofEdge; readonly slot: number }
  | {
      readonly form: 'board';
      readonly edge: RoofEdge;
      readonly board: 'sub' | 'fascia';
      readonly piece: number;
    }
  | { readonly form: 'hip'; readonly corner: RoofCorner }
  | { readonly form: 'ridge'; readonly piece: number }
  | { readonly form: 'tie'; readonly slot: number };

const K0 = '(0|[1-9][0-9]*)';
const N1 = '([1-9][0-9]*)';
const COMMON = new RegExp(`^e([1-4]):c${K0}$`);
const JACK = new RegExp(`^e([1-4]):j([ab])${N1}$`);
const FLY = /^e([1-4]):fly-([ab])$/;
const GABLE = new RegExp(`^e([1-4]):g${K0}$`);
const BOARD = new RegExp(`^e([1-4]):(sub|fascia):${N1}$`);
const HIP = /^hip([1-4])$/;
const RIDGE = new RegExp(`^ridge:${N1}$`);
const TIE = new RegExp(`^tie${K0}$`);

/** Parses a roof's own member id; undefined when it is none of the roof forms. */
export function parseRoofMemberId(id: string): RoofMemberId | undefined {
  const edge = (s: string) => Number(s) as RoofEdge;
  let m = COMMON.exec(id);
  if (m) return { form: 'common', edge: edge(m[1]!), slot: Number(m[2]) };
  m = JACK.exec(id);
  if (m) return { form: 'jack', edge: edge(m[1]!), end: m[2] as 'a' | 'b', n: Number(m[3]) };
  m = FLY.exec(id);
  if (m) return { form: 'fly', edge: edge(m[1]!), end: m[2] as 'a' | 'b' };
  m = GABLE.exec(id);
  if (m) return { form: 'gable-stud', edge: edge(m[1]!), slot: Number(m[2]) };
  m = BOARD.exec(id);
  if (m)
    return {
      form: 'board',
      edge: edge(m[1]!),
      board: m[2] as 'sub' | 'fascia',
      piece: Number(m[3]),
    };
  m = HIP.exec(id);
  if (m) return { form: 'hip', corner: Number(m[1]) as RoofCorner };
  m = RIDGE.exec(id);
  if (m) return { form: 'ridge', piece: Number(m[1]) };
  m = TIE.exec(id);
  if (m) return { form: 'tie', slot: Number(m[1]) };
  return undefined;
}

/** The id text of a parsed roof member id; round-trips with `parseRoofMemberId`. */
export function formatRoofMemberId(p: RoofMemberId): string {
  switch (p.form) {
    case 'common':
      return `e${p.edge}:c${p.slot}`;
    case 'jack':
      return `e${p.edge}:j${p.end}${p.n}`;
    case 'fly':
      return `e${p.edge}:fly-${p.end}`;
    case 'gable-stud':
      return `e${p.edge}:g${p.slot}`;
    case 'board':
      return `e${p.edge}:${p.board}:${p.piece}`;
    case 'hip':
      return `hip${p.corner}`;
    case 'ridge':
      return `ridge:${p.piece}`;
    case 'tie':
      return `tie${p.slot}`;
  }
}

// Input --------------------------------------------------------------------------------------

export type RoofKind = 'gable' | 'hip';

/** A rafter tail: plumb (vertical, for a fascia) or square to the rafter. */
export type TailCut = 'plumb' | 'square';

/**
 * Ceiling joists or rafter ties beside the common rafter pairs. `every` picks every n-th eligible
 * pair, starting with the first: 1 is every pair, 2 every other one. On a gable the pairs over the
 * gable walls are not eligible; on a hip roof the eligible pairs are the commons between the ridge
 * ends. Rafter ties stand `height` above the top of the plates (to their underside); ceiling joists
 * sit on the plates.
 */
export type RoofTies =
  | { readonly kind: 'none' }
  | { readonly kind: 'ceiling-joists'; readonly stock: StockRef; readonly every: number }
  | {
      readonly kind: 'rafter-ties';
      readonly stock: StockRef;
      readonly every: number;
      readonly height: number;
    };

/**
 * Gable studs (gable roofs only): studs on the gable walls' layout, standing on their top plates
 * and cut to the underside of the end rafters (and of the ridge where they meet it).
 */
export interface GableStuds {
  /** The gable walls' stud stock; its depth is the walls' framed thickness. */
  readonly stock: StockRef;
  readonly spacing: number;
  /**
   * The centre of one layout position of each gable wall, measured along the end from v = 0
   * (e2 and e4 separately). Default 0, which puts stud k at k x spacing.
   */
  readonly origin?: { readonly e2?: number; readonly e4?: number };
}

export interface RoofSettings {
  readonly rafterStock: StockRef;
  readonly ridgeStock: StockRef;
  /** Hip rafter stock; a hip roof needs it. */
  readonly hipStock?: StockRef;
  /** Rafters on centre. */
  readonly spacing: number;
  /** Eave overhang in plan, from the wall line to the tail's outermost point. */
  readonly overhang: number;
  /** Gable rake overhang in plan, to the fly rafters' outer face; 0 for none. */
  readonly rakeOverhang: number;
  readonly tail: TailCut;
  readonly ties: RoofTies;
  readonly gableStuds?: GableStuds;
  /** A board on the plumb tail cuts (plumb tails only). */
  readonly subFascia?: StockRef;
  /** A board outside the sub-fascia, or on the tails when there is none (plumb tails only). */
  readonly fascia?: StockRef;
  /** Lengths the ridge and fascia boards are sold in; longer runs are spliced. */
  readonly stockLengths: readonly number[];
}

export type RoofSettingsInput = Pick<RoofSettings, 'rafterStock' | 'ridgeStock'> &
  Partial<Omit<RoofSettings, 'rafterStock' | 'ridgeStock'>>;

/** The rectangle the roof bears on: the outside line of the walls' top plates. */
export interface RoofFootprint {
  /** Corner c1, in plan. */
  readonly origin: Vec2;
  /** Plan angle of the length axis (edge e1), radians. Default 0. */
  readonly direction?: number;
  /** Along e1; on a hip roof at least the width (the ridge runs along the length). */
  readonly length: number;
  readonly width: number;
  /** Elevation of the top of the top plates: the birdsmouth seats sit here. */
  readonly plate: number;
  /** The walls' framed thickness: the birdsmouth seat's length in plan. */
  readonly wallThickness: number;
}

export interface FrameRoofInput {
  /** The roof's feature id: the owner of every member here, gable studs included. */
  readonly roof: string;
  readonly kind: RoofKind;
  /** Radians above horizontal; the feature layer parses `6/12` (ADR 0005 amendment). */
  readonly pitch: number;
  readonly footprint: RoofFootprint;
  readonly settings: RoofSettingsInput;
  /** Overrides of the roof's members, keyed by local id (`e1:c4`, `ridge:1`). */
  readonly overrides?: readonly MemberOverride[];
}

// Output -------------------------------------------------------------------------------------

export type RoofWarningCode =
  | 'birdsmouth-deep'
  | 'low-slope-no-ties'
  | 'ridge-shallow'
  | 'hip-above-plate'
  | 'tie-skipped'
  | 'override-lost';

/**
 * A layout warning, as the wall's: `rule-of-thumb` ones are framing practice the layout departs
 * from (labelled as such wherever shown); `layout` ones say what the generator could not lay out
 * as asked. None of them is a structural assessment.
 */
export interface RoofWarning {
  readonly code: RoofWarningCode;
  readonly kind: 'rule-of-thumb' | 'layout';
  readonly message: string;
  /** A full member id. */
  readonly member?: string;
  /** The role the warning is about (`common-rafter` covers the jacks too). */
  readonly role?: Role;
  /** The measured value, mm (a birdsmouth depth, a ridge depth). */
  readonly value?: number;
  /** What the rule of thumb compares it with, mm. */
  readonly limit?: number;
}

/**
 * The roof's hand-checkable numbers (M6 plan, Part 1, "Roof pitch math"), mm and radians. For
 * drawings and the info panel; members carry the same geometry.
 */
export interface RoofGeometry {
  readonly pitch: number;
  /** Rise per 12 of run: 6 for `6/12`. */
  readonly risePer12: number;
  /** Length along a common rafter per unit of run: `sqrt(12^2 + p^2) / 12`. */
  readonly commonFactor: number;
  /** Plan run of a common rafter: wall line to the ridge board's face. */
  readonly commonRun: number;
  /** `commonRun x commonFactor`: wall line to ridge face, along the rafter. */
  readonly commonLineLength: number;
  /** The overhang's run along the rafter: `overhang x commonFactor` (to the tail's outermost point). */
  readonly overhangLineLength: number;
  /** Plumb height of the rafter's top edge above the plates, at the wall line. */
  readonly heightAbovePlate: number;
  /** Top of the ridge board above the plates: `commonRun x rise / run + heightAbovePlate`. */
  readonly ridgeAbovePlate: number;
  /** Elevation of the top of the ridge board. */
  readonly ridgeTop: number;
  /** Plumb depth of the rafter's top cut: the ridge board's depth is compared with it. */
  readonly plumbCut: number;
  readonly birdsmouth: {
    /** Horizontal seat, the wall's thickness. */
    readonly seat: number;
    /** Vertical heel cut: `seat x tan(pitch)`. */
    readonly heel: number;
    /** Depth square to the rafter's edge: `seat x sin(pitch)`. */
    readonly depth: number;
  };
  /** Hip roofs. */
  readonly hip?: {
    readonly angle: number;
    /** Plan run along the hip's centre line, outside corner to where it meets the ridge end. */
    readonly run: number;
    readonly lineLength: number;
    /** Length along the hip per unit of common run: `sqrt(2 x 12^2 + p^2) / 12`. */
    readonly factor: number;
    /** How far the hip is lowered so its top corners lie in the roof planes. */
    readonly drop: number;
    /** Birdsmouth depth square to the hip's edge; 0 when it does not reach the plates. */
    readonly birdsmouthDepth: number;
  };
  /** Hip roofs: how much shorter each jack is than the one before (`spacing x commonFactor`). */
  readonly jackStep?: number;
}

export interface RoofFraming {
  readonly members: Member[];
  readonly warnings: RoofWarning[];
  readonly geometry: RoofGeometry;
  readonly overrides: OverrideReport[];
}

// Defaults -----------------------------------------------------------------------------------

const IN = MM_PER_INCH;

/**
 * Defaults for everything but the rafter, ridge and hip stock (the user's choices). Sources are in
 * the README: common practice, partly unverified.
 */
export const DEFAULT_ROOF_SETTINGS: Omit<
  RoofSettings,
  'rafterStock' | 'ridgeStock' | 'hipStock' | 'gableStuds' | 'subFascia' | 'fascia'
> = {
  spacing: 16 * IN,
  overhang: 12 * IN,
  rakeOverhang: 0,
  tail: 'plumb',
  ties: { kind: 'none' },
  stockLengths: [8, 10, 12, 14, 16].map((ft) => ft * 12 * IN),
};

// Generator ----------------------------------------------------------------------------------

/** Geometric tolerance, mm. */
const EPS = 1e-6;
/** Members shorter than this are not emitted, mm. */
const MIN_MEMBER = 1;
/** `atan(3/12)`: below it, with no ties, the low-slope rule of thumb applies. */
const THREE_IN_TWELVE = Math.atan(3 / 12);

const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;
const SQRT2 = Math.SQRT2;

export function resolveRoofSettings(input: RoofSettingsInput): RoofSettings {
  const s: RoofSettings = { ...DEFAULT_ROOF_SETTINGS, ...input };
  const fail = (msg: string): never => {
    throw new FramingInputError(msg);
  };
  checkStock(s.rafterStock, 'Rafter stock');
  checkStock(s.ridgeStock, 'Ridge stock');
  if (s.hipStock) checkStock(s.hipStock, 'Hip stock');
  if (s.subFascia) checkStock(s.subFascia, 'Sub-fascia stock');
  if (s.fascia) checkStock(s.fascia, 'Fascia stock');
  if (!(s.spacing > s.rafterStock.width)) fail('Rafter spacing must be wider than a rafter.');
  if (!(s.overhang >= 0) || !Number.isFinite(s.overhang)) fail('The overhang cannot be negative.');
  if (!(s.rakeOverhang >= 0) || !Number.isFinite(s.rakeOverhang))
    fail('The rake overhang cannot be negative.');
  if (s.rakeOverhang > 0 && s.rakeOverhang < s.rafterStock.width - EPS)
    fail('A rake overhang needs at least a rafter width, for its fly rafters.');
  if (s.tail !== 'plumb' && (s.subFascia || s.fascia))
    fail('A sub-fascia or fascia needs plumb rafter tails.');
  if (s.stockLengths.length === 0 || !s.stockLengths.every((l) => l > 0))
    fail('Stock lengths must be given and above 0.');
  if (s.ties.kind !== 'none') {
    checkStock(s.ties.stock, 'Tie stock');
    if (!Number.isInteger(s.ties.every) || s.ties.every < 1)
      fail('Ties go on every pair or every n-th pair: a whole number of 1 or more.');
    if (s.ties.kind === 'rafter-ties' && !(s.ties.height >= 0))
      fail('Rafter ties need a height of 0 or more above the plates.');
    if (!(s.spacing >= s.rafterStock.width + 2 * s.ties.stock.width))
      fail('Rafter spacing leaves no room for the ties between rafters.');
  }
  if (s.gableStuds) {
    checkStock(s.gableStuds.stock, 'Gable stud stock');
    if (!(s.gableStuds.spacing > s.gableStuds.stock.width))
      fail('Gable stud spacing must be wider than a stud.');
    for (const o of [s.gableStuds.origin?.e2, s.gableStuds.origin?.e4])
      if (o !== undefined && !Number.isFinite(o))
        fail('A gable stud layout origin must be a number.');
  }
  return s;
}

function checkStock(stock: StockRef, what: string): void {
  if (!(stock.width > 0 && stock.depth > 0))
    throw new FramingInputError(`${what} needs a width and depth above 0.`);
}

/** A member under construction, in the roof's own frame. */
interface Draft {
  readonly id: string;
  readonly role: Role;
  readonly stock: StockRef;
  readonly length: number;
  readonly placement: Placement;
  readonly cuts: Cut[];
  /** Plan direction an override's `move` follows (roof frame). */
  readonly along: Vec2;
}

interface EdgeFrame {
  readonly n: RoofEdge;
  /** End a, at t = 0. */
  readonly C: Vec2;
  /** Along the edge. */
  readonly T: Vec2;
  /** Inward. */
  readonly R: Vec2;
  /** The edge's length. */
  readonly E: number;
}

interface Ctx {
  readonly kind: RoofKind;
  readonly st: RoofSettings;
  readonly L: number;
  readonly W: number;
  readonly plate: number;
  /** Birdsmouth seat. */
  readonly s: number;
  readonly tan: number;
  readonly cos: number;
  readonly sin: number;
  /** Rafter width and depth, ridge width and depth. */
  readonly w: number;
  readonly d: number;
  readonly rw: number;
  readonly rd: number;
  readonly o: number;
  /** Common run. */
  readonly R: number;
  readonly hap: number;
  readonly ridgeTop: number;
  readonly edges: Record<RoofEdge, EdgeFrame>;
}

const v2 = {
  add: (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]],
  scale: (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k],
  dot: (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1],
};

/** A vertical half-space in plan: removed where `dot(n, p) >= k`. */
const planPlane = (n: Vec2, k: number): Plane => ({ n: [n[0], n[1], 0], k });

/** Frames a roof: its members, layout warnings, its hand-checkable geometry and override results. */
export function frameRoof(input: FrameRoofInput): RoofFraming {
  const st = resolveRoofSettings(input.settings);
  const ctx = context(input, st);
  const drafts: Draft[] = [];
  const warnings: RoofWarning[] = [];
  const full = (id: string) => memberFullId({ owner: input.roof, id });

  // Rafters, ridge and hips.
  const e1Slots = input.kind === 'gable' ? frameGable(ctx, drafts) : frameHip(ctx, drafts);
  const hipNotch = input.kind === 'hip' ? hipNumbers(ctx) : undefined;

  // Ties beside the common pairs on e1 and e3.
  frameTies(ctx, e1Slots, drafts, warnings, full);
  if (input.kind === 'gable' && st.gableStuds) frameGableStuds(ctx, st.gableStuds, drafts);
  frameBoards(ctx, drafts);

  // Rule-of-thumb and layout warnings (ADR 0015 decision 7).
  const bm = ctx.s * ctx.sin;
  if (bm > ctx.d / 3 + EPS)
    warnings.push({
      code: 'birdsmouth-deep',
      kind: 'rule-of-thumb',
      message:
        "Rule of thumb: the birdsmouth in the common and jack rafters is deeper than a third of the rafter's depth.",
      role: 'common-rafter',
      value: bm,
      limit: ctx.d / 3,
    });
  if (hipNotch && st.hipStock) {
    if (hipNotch.seat <= EPS)
      warnings.push({
        code: 'hip-above-plate',
        kind: 'layout',
        message:
          "The hip rafters do not reach the wall plates: they are shallower than the common rafters' height above the plates, so they get no birdsmouth.",
        role: 'hip-rafter',
      });
    else if (hipNotch.depth > st.hipStock.depth / 3 + EPS)
      warnings.push({
        code: 'birdsmouth-deep',
        kind: 'rule-of-thumb',
        message:
          "Rule of thumb: the birdsmouth in the hip rafters is deeper than a third of the hip's depth.",
        role: 'hip-rafter',
        value: hipNotch.depth,
        limit: st.hipStock.depth / 3,
      });
  }
  if (input.pitch < THREE_IN_TWELVE - EPS && st.ties.kind === 'none')
    warnings.push({
      code: 'low-slope-no-ties',
      kind: 'rule-of-thumb',
      message:
        'Rule of thumb: the roof is below 3/12 and has no ceiling joists or rafter ties; framers often use a ridge beam there instead of a ridge board (IRC R802.3).',
    });
  const plumbCut = ctx.d / ctx.cos;
  if (ctx.rd < plumbCut - EPS)
    warnings.push({
      code: 'ridge-shallow',
      kind: 'rule-of-thumb',
      message:
        "Rule of thumb: the ridge board is shallower than the rafters' plumb cut against it (IRC R802.3).",
      role: 'ridge',
      value: ctx.rd,
      limit: plumbCut,
    });

  const members = drafts.map((d) => toWorld(input, d));
  const along = new Map(drafts.map((d) => [d.id, d.along] as const));
  const applied = applyOverrides(input, members, along, warnings);
  return {
    members: applied.members,
    warnings,
    geometry: geometry(input, ctx, hipNotch),
    overrides: applied.reports,
  };
}

function context(input: FrameRoofInput, st: RoofSettings): Ctx {
  const fail = (msg: string): never => {
    throw new FramingInputError(msg);
  };
  if (!FEATURE_ID.test(input.roof)) fail(`Roof id "${input.roof}" is not a feature id.`);
  if (input.kind !== 'gable' && input.kind !== 'hip') fail('A roof is gable or hip.');
  const f = input.footprint;
  const L = f.length;
  const W = f.width;
  if (!(L > 0 && W > 0 && Number.isFinite(L) && Number.isFinite(W)))
    fail('The footprint needs a length and width above 0.');
  if (
    !Number.isFinite(f.plate) ||
    !Number.isFinite(f.origin[0]) ||
    !Number.isFinite(f.origin[1]) ||
    !Number.isFinite(f.direction ?? 0)
  )
    fail('The footprint needs a finite origin, direction and plate elevation.');
  const p = input.pitch;
  if (!(p > 0 && p < Math.PI / 2)) fail('The pitch must be above 0 and below 90 degrees.');
  if (input.kind === 'hip') {
    if (W > L + EPS)
      fail('A hip roof needs its length at least its width: give the longer side as the length.');
    if (!st.hipStock) fail('A hip roof needs hip stock.');
    if (st.ridgeStock.width < st.rafterStock.width - EPS)
      fail('A hip roof needs a ridge board at least as thick as a rafter.');
  }
  const s = f.wallThickness;
  if (!(s > 0)) fail('The wall thickness (the birdsmouth seat) must be above 0.');
  const tan = Math.tan(p);
  const cos = Math.cos(p);
  const sin = Math.sin(p);
  const w = st.rafterStock.width;
  const d = st.rafterStock.depth;
  const rw = st.ridgeStock.width;
  const rd = st.ridgeStock.depth;
  if (!(s * sin < d - EPS))
    fail('The birdsmouth would cut through the rafter: the seat is too long for the pitch.');
  const R = W / 2 - rw / 2;
  if (!(R > s + EPS)) fail('The roof is too narrow: the rafters do not reach past their seats.');
  // The rafter's top edge at the wall line, plumb above the plates (Part 1: the bottom edge meets
  // the plate's inside edge, so the heel is `seat x tan` and the top is `depth / cos` above it).
  const hap = d / cos - s * tan;
  const ridgeTop = f.plate + hap + R * tan;
  const edges: Record<RoofEdge, EdgeFrame> = {
    1: { n: 1, C: [0, 0], T: [1, 0], R: [0, 1], E: L },
    2: { n: 2, C: [L, 0], T: [0, 1], R: [-1, 0], E: W },
    3: { n: 3, C: [0, W], T: [1, 0], R: [0, -1], E: L },
    4: { n: 4, C: [0, 0], T: [0, 1], R: [1, 0], E: W },
  };
  if (st.ties.kind === 'rafter-ties' || st.ties.kind === 'ceiling-joists') {
    const h = st.ties.kind === 'rafter-ties' ? st.ties.height : 0;
    if (f.plate + h + st.ties.stock.depth > ridgeTop - rd + EPS)
      fail('The ties reach the ridge board: lower them.');
  }
  return {
    kind: input.kind,
    st,
    L,
    W,
    plate: f.plate,
    s,
    tan,
    cos,
    sin,
    w,
    d,
    rw,
    rd,
    o: st.overhang,
    R,
    hap,
    ridgeTop,
    edges,
  };
}

/** Blank start along the bottom edge, in r: the tail's outermost point is at r = -overhang. */
function tailStart(ctx: Ctx): number {
  return ctx.st.tail === 'plumb' ? -ctx.o : -ctx.o + ctx.d * ctx.sin;
}

interface SlopedSpec {
  readonly id: string;
  readonly role: Role;
  readonly stock: StockRef;
  /** Plan point on the centre line where r = 0. */
  readonly P: Vec2;
  /** Unit plan direction, up the slope. */
  readonly D: Vec2;
  readonly angle: number;
  /** Elevation of the bottom edge at r = 0. */
  readonly zb: number;
  /** Blank start: r of the bottom edge at local x = 0. */
  readonly r0: number;
  /** The greatest r of the kept member, on its top face (every top cut is plumb). */
  readonly rMax: number;
  /** Removed half-spaces, roof frame. */
  readonly cuts: readonly Plane[];
  readonly notch?: readonly [Plane, Plane];
  readonly along: Vec2;
}

/**
 * A sloped member (rafter, jack, hip): local x up the slope, y horizontal across it, z square to
 * its top edge, so its depth stands up. The blank runs from the bottom edge at `r0` to the top
 * face's farthest point.
 */
function sloped(sp: SlopedSpec): Draft | undefined {
  const c = Math.cos(sp.angle);
  const sn = Math.sin(sp.angle);
  const t = Math.tan(sp.angle);
  const { width: w, depth: d } = sp.stock;
  const y: Vec3 = [-sp.D[1], sp.D[0], 0];
  const x: Vec3 = [sp.D[0] * c, sp.D[1] * c, sn];
  const origin: Vec3 = [
    sp.P[0] + sp.r0 * sp.D[0] - (w / 2) * y[0],
    sp.P[1] + sp.r0 * sp.D[1] - (w / 2) * y[1],
    sp.zb + sp.r0 * t,
  ];
  const length = (sp.rMax - sp.r0 + d * sn) / c;
  if (!(length > MIN_MEMBER)) return undefined;
  return finish(
    {
      id: sp.id,
      role: sp.role,
      stock: sp.stock,
      length,
      placement: { origin, x, y },
      along: sp.along,
    },
    sp.cuts,
    sp.notch,
  );
}

/** A plane in the member's local frame. */
function localPlane(p: Placement, pl: Plane): Plane {
  const z = zAxis(p);
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return {
    n: [clean(dot(pl.n, p.x)), clean(dot(pl.n, p.y)), clean(dot(pl.n, z))],
    k: pl.k - dot(pl.n, p.origin),
  };
}

/**
 * Adds the cuts that remove something from the blank (ADR 0015 decision 4: a cut that removes
 * nothing is dropped). Undefined when a cut removes the whole blank.
 */
function finish(
  base: Omit<Draft, 'cuts'>,
  planes: readonly Plane[],
  notch?: readonly [Plane, Plane],
): Draft | undefined {
  const cuts: Cut[] = [];
  const corners: Vec3[] = [];
  for (const a of [0, base.length])
    for (const b of [0, base.stock.width])
      for (const c of [0, base.stock.depth]) corners.push([a, b, c]);
  for (const pl of planes) {
    const l = localPlane(base.placement, pl);
    const vals = corners.map((q) => dot(l.n, q) - l.k);
    if (vals.every((v) => v >= -EPS)) return undefined;
    if (vals.some((v) => v > EPS)) cuts.push({ kind: 'plane', n: l.n, k: l.k });
  }
  if (notch)
    cuts.push({
      kind: 'notch',
      a: localPlane(base.placement, notch[0]),
      b: localPlane(base.placement, notch[1]),
    });
  return { ...base, cuts };
}

/** A box member with no slope: local x along `x`, y along `y`, z up (`x cross y`). */
function board(
  id: string,
  role: Role,
  stock: StockRef,
  origin: Vec3,
  x: Vec3,
  y: Vec3,
  length: number,
  along: Vec2,
  planes: readonly Plane[] = [],
): Draft | undefined {
  if (!(length > MIN_MEMBER)) return undefined;
  return finish({ id, role, stock, length, placement: { origin, x, y }, along }, planes);
}

/** A rafter on an eave edge at t: a common, jack or fly rafter. */
function rafter(
  ctx: Ctx,
  e: EdgeFrame,
  t: number,
  id: string,
  role: Role,
  top: { rMax: number; cut: Plane },
  seat: boolean,
): Draft | undefined {
  const P = v2.add(e.C, v2.scale(e.T, t));
  const D = e.R;
  const DP = v2.dot(D, P);
  const cuts: Plane[] = [top.cut];
  if (ctx.st.tail === 'plumb') cuts.push(planPlane([-D[0], -D[1]], -DP + ctx.o));
  const notch: readonly [Plane, Plane] | undefined = seat
    ? [planPlane(D, DP), { n: [0, 0, -1], k: -ctx.plate }]
    : undefined;
  return sloped({
    id,
    role,
    stock: ctx.st.rafterStock,
    P,
    D,
    angle: Math.atan(ctx.tan),
    zb: ctx.plate - ctx.s * ctx.tan,
    r0: tailStart(ctx),
    rMax: top.rMax,
    cuts,
    ...(notch ? { notch } : {}),
    along: e.T,
  });
}

/** The plumb cut at the ridge face: removes r > common run. */
function ridgeCut(ctx: Ctx, e: EdgeFrame, t: number): { rMax: number; cut: Plane } {
  const P = v2.add(e.C, v2.scale(e.T, t));
  return { rMax: ctx.R, cut: planPlane(e.R, v2.dot(e.R, P) + ctx.R) };
}

/**
 * Gable layout along an eave, as the wall's: slot 0 flush at end a, slot k centred on k x spacing,
 * the last flush at end b. Centred slots that would overlap an end rafter are left out.
 */
function gableSlots(L: number, w: number, spacing: number): Slot[] {
  const out: Slot[] = [{ k: 0, t: w / 2 }];
  const kLast = Math.max(0, Math.floor((L - 1.5 * w) / spacing + EPS));
  for (let k = 1; k <= kLast; k++) {
    const c = k * spacing;
    if (c - w / 2 < w - EPS) continue;
    out.push({ k, t: c });
  }
  out.push({ k: kLast + 1, t: L - w / 2 });
  return out;
}

/** Common slots on e1/e3 (centres along u) with their slot numbers, for ties and splices. */
interface Slot {
  readonly k: number;
  readonly t: number;
}

interface Framed {
  /** Common slots on e1 (e3 has the same). */
  readonly commons: readonly Slot[];
  /** The u range ties may use. */
  readonly tieRange: readonly [number, number];
  /** u intervals rafters occupy along e1 (ties must stay out of them). */
  readonly occupied: Array<readonly [number, number]>;
}

function frameGable(ctx: Ctx, out: Draft[]): Framed {
  const { st, L, w } = ctx;
  const slots = gableSlots(L, w, st.spacing);
  const joints: number[] = [];
  for (const n of [1, 3] as const) {
    const e = ctx.edges[n];
    for (const { k, t } of slots)
      push(
        out,
        rafter(
          ctx,
          e,
          t,
          formatRoofMemberId({ form: 'common', edge: n, slot: k }),
          'common-rafter',
          ridgeCut(ctx, e, t),
          true,
        ),
      );
    if (st.rakeOverhang > 0) {
      const ta = -st.rakeOverhang + w / 2;
      const tb = L + st.rakeOverhang - w / 2;
      for (const [end, t] of [
        ['a', ta],
        ['b', tb],
      ] as const)
        push(
          out,
          rafter(
            ctx,
            e,
            t,
            formatRoofMemberId({ form: 'fly', edge: n, end }),
            'fly-rafter',
            ridgeCut(ctx, e, t),
            false,
          ),
        );
    }
  }
  for (const { t } of slots) joints.push(t);
  // The ridge board: from fly rafter to fly rafter, its top flush with the rafters' top corners.
  ridge(ctx, -st.rakeOverhang, L + st.rakeOverhang, joints, out);
  const gt = st.gableStuds?.stock.depth ?? 0;
  return {
    // The end slots stand over the gable walls (and their studs): no ties there.
    commons: slots.slice(1, -1),
    tieRange: [gt, L - gt],
    occupied: slots.map(({ t }) => [t - w / 2, t + w / 2] as const),
  };
}

function ridge(ctx: Ctx, a: number, b: number, joints: readonly number[], out: Draft[]): void {
  const { W, rw, rd } = ctx;
  splicePieces(a, b, Math.max(...ctx.st.stockLengths), joints).forEach(([p, q], i) =>
    push(
      out,
      board(
        formatRoofMemberId({ form: 'ridge', piece: i + 1 }),
        'ridge',
        ctx.st.ridgeStock,
        [p, W / 2 - rw / 2, ctx.ridgeTop - rd],
        [1, 0, 0],
        [0, 1, 0],
        q - p,
        [1, 0],
      ),
    ),
  );
}

/**
 * Pieces from a to b no longer than `max`, each splice at the farthest joint (a rafter centre)
 * that keeps the piece within `max`, or at `max` when no joint does.
 */
function splicePieces(
  a: number,
  b: number,
  max: number,
  joints: readonly number[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = a;
  while (b - s > max + EPS) {
    const fit = joints.filter(
      (j) => j > s + MIN_MEMBER && j <= s + max + EPS && j < b - MIN_MEMBER,
    );
    const j = fit.length > 0 ? Math.max(...fit) : s + max;
    out.push([s, j]);
    s = j;
  }
  out.push([s, b]);
  return out;
}

interface HipNumbers {
  readonly angle: number;
  readonly drop: number;
  /** Plan length of the hip's birdsmouth seat along its centre line; 0 or less: no birdsmouth. */
  readonly seat: number;
  readonly depth: number;
  readonly pcut: number;
  readonly qcut: number;
}

function hipNumbers(ctx: Ctx): HipNumbers {
  const hs = ctx.st.hipStock!;
  const angle = Math.atan(ctx.tan / SQRT2);
  // Dropped so the hip's top corners (half its width off the hip line) lie in the roof planes.
  const drop = ((hs.width / 2) * ctx.tan) / SQRT2;
  // Its top edge's centre follows the hip line at the commons' height above the plates; the bottom
  // edge reaches the plates `seat` in from the outside corner.
  const tanH = Math.tan(angle);
  const seat = (hs.depth / Math.cos(angle) + drop - ctx.hap) / tanH;
  return {
    angle,
    drop,
    seat,
    depth: seat > EPS ? seat * Math.sin(angle) : 0,
    // The hip stops at the ridge's end face (along u) and the king common's side face (along v).
    pcut: ctx.W / 2 - ctx.rw / 2,
    qcut: ctx.W / 2 - ctx.w / 2,
  };
}

function frameHip(ctx: Ctx, out: Draft[]): Framed {
  const { st, L, W, w } = ctx;
  const sp = st.spacing;
  const hs = st.hipStock!;
  const wh = hs.width;
  // Commons on e1 and e3: at each ridge end and on layout between them; one in the middle when the
  // ridge ends are closer than a rafter width.
  const ta = W / 2;
  const tb = L - W / 2;
  const commons1: number[] = [];
  if (tb - ta < w - EPS) commons1.push(L / 2);
  else {
    commons1.push(ta);
    for (let k = 1; ta + k * sp <= tb - w + EPS; k++) commons1.push(ta + k * sp);
    commons1.push(tb);
  }
  for (const n of [1, 2, 3, 4] as const) {
    const e = ctx.edges[n];
    const commons = n === 1 || n === 3 ? commons1 : [W / 2];
    const lo = n === 1 || n === 3 ? ta : W / 2;
    const hi = n === 1 || n === 3 ? tb : W / 2;
    commons.forEach((t, k) =>
      push(
        out,
        rafter(
          ctx,
          e,
          t,
          formatRoofMemberId({ form: 'common', edge: n, slot: k }),
          'common-rafter',
          ridgeCut(ctx, e, t),
          true,
        ),
      ),
    );
    // Jacks: on layout from the ridge-end commons out to each corner, cut against the hip's side.
    for (const end of ['a', 'b'] as const) {
      for (let k = 1; ; k++) {
        const t = end === 'a' ? lo - k * sp : hi + k * sp;
        if (end === 'a' ? t - w / 2 < -EPS : t + w / 2 > e.E + EPS) break;
        const rMax = (end === 'a' ? t : e.E - t) + w / 2 - wh / SQRT2;
        if (rMax <= ctx.s + EPS) break;
        const n2: Vec2 =
          end === 'a'
            ? [(e.R[0] - e.T[0]) / SQRT2, (e.R[1] - e.T[1]) / SQRT2]
            : [(e.R[0] + e.T[0]) / SQRT2, (e.R[1] + e.T[1]) / SQRT2];
        const k0 = v2.dot(n2, e.C) + (end === 'a' ? 0 : e.E / SQRT2) - wh / 2;
        push(
          out,
          rafter(
            ctx,
            e,
            t,
            formatRoofMemberId({ form: 'jack', edge: n, end, n: k }),
            'jack-rafter',
            { rMax, cut: planPlane(n2, k0) },
            true,
          ),
        );
      }
    }
  }

  // Hips from each outside corner to the ridge end, dropped, with a birdsmouth on the corner.
  const h = hipNumbers(ctx);
  const corners: Array<[RoofCorner, Vec2, Vec2, Vec2]> = [
    [1, [0, 0], [1, 0], [0, 1]],
    [2, [L, 0], [-1, 0], [0, 1]],
    [3, [L, W], [-1, 0], [0, -1]],
    [4, [0, W], [1, 0], [0, -1]],
  ];
  // Farthest plan r on the hip's top face inside both top cuts and its own width.
  const band = wh / SQRT2;
  const sum =
    Math.abs(h.qcut - h.pcut) <= band ? h.pcut + h.qcut : 2 * Math.min(h.pcut, h.qcut) + band;
  const rMax = sum / SQRT2;
  for (const [c, C, Pd, Qd] of corners) {
    const D: Vec2 = [(Pd[0] + Qd[0]) / SQRT2, (Pd[1] + Qd[1]) / SQRT2];
    const cuts: Plane[] = [
      planPlane([-Pd[0], -Pd[1]], -v2.dot(Pd, C) + ctx.o),
      planPlane([-Qd[0], -Qd[1]], -v2.dot(Qd, C) + ctx.o),
      planPlane(Pd, v2.dot(Pd, C) + h.pcut),
      planPlane(Qd, v2.dot(Qd, C) + h.qcut),
    ];
    const notch: readonly [Plane, Plane] | undefined =
      h.seat > EPS ? [planPlane(D, v2.dot(D, C)), { n: [0, 0, -1], k: -ctx.plate }] : undefined;
    push(
      out,
      sloped({
        id: formatRoofMemberId({ form: 'hip', corner: c }),
        role: 'hip-rafter',
        stock: hs,
        P: C,
        D,
        angle: h.angle,
        zb: ctx.plate + ctx.hap - h.drop - hs.depth / Math.cos(h.angle),
        r0: -ctx.o * SQRT2,
        rMax,
        cuts,
        ...(notch ? { notch } : {}),
        along: [1, 0],
      }),
    );
  }

  // The ridge board between the hips' ends: L - W plus one ridge thickness, so every common
  // (the king commons at its ends included) has the same run.
  ridge(ctx, W / 2 - ctx.rw / 2, L - W / 2 + ctx.rw / 2, commons1, out);
  return {
    commons: commons1.map((t, k) => ({ k, t })),
    tieRange: [W / 2 - ctx.rw / 2, L - W / 2 + ctx.rw / 2],
    occupied: commons1.map((t) => [t - w / 2, t + w / 2] as const),
  };
}

function frameTies(
  ctx: Ctx,
  framed: Framed,
  out: Draft[],
  warnings: RoofWarning[],
  full: (id: string) => string,
): void {
  const ties = ctx.st.ties;
  if (ties.kind === 'none') return;
  const { W, L, w, plate, hap, tan } = ctx;
  const ts = ties.stock;
  const h = ties.kind === 'rafter-ties' ? ties.height : 0;
  // Where the tie's underside meets the roof's top plane, from each eave (0 when it is below the
  // rafters' top at the wall line: then it runs to the wall's outside face).
  const vs = Math.max(0, (h - hap) / tan);
  const len = W - 2 * vs;
  const norm = Math.hypot(1, tan);
  // The roof's top planes on the e1 and e3 sides (removed above).
  const tops: Plane[] = [
    { n: [0, -tan / norm, 1 / norm], k: (plate + hap) / norm },
    { n: [0, tan / norm, 1 / norm], k: (plate + hap + W * tan) / norm },
  ];
  const taken: Array<readonly [number, number]> = [...framed.occupied];
  const [lo, hi] = framed.tieRange;
  const free = (iv: readonly [number, number]) =>
    iv[0] >= lo - EPS &&
    iv[1] <= hi + EPS &&
    taken.every((q) => iv[1] <= q[0] + EPS || iv[0] >= q[1] - EPS);
  framed.commons.forEach((slot, i) => {
    if (i % ties.every !== 0) return;
    const plus: readonly [number, number] = [slot.t + w / 2, slot.t + w / 2 + ts.width];
    const minus: readonly [number, number] = [slot.t - w / 2 - ts.width, slot.t - w / 2];
    const order = slot.t <= L / 2 ? [plus, minus] : [minus, plus];
    const iv = order.find(free);
    const id = formatRoofMemberId({ form: 'tie', slot: slot.k });
    if (!iv) {
      warnings.push({
        code: 'tie-skipped',
        kind: 'layout',
        message: `There is no room beside the common rafters at slot ${slot.k} for a tie; it is left out.`,
        member: full(id),
      });
      return;
    }
    taken.push(iv);
    // Along v, thin face along u, depth up: x = +v, y = -u, z = x cross y = up.
    push(
      out,
      board(
        id,
        ties.kind === 'rafter-ties' ? 'rafter-tie' : 'ceiling-joist',
        ts,
        [iv[1], vs, plate + h],
        [0, 1, 0],
        [-1, 0, 0],
        len,
        [1, 0],
        tops,
      ),
    );
  });
}

function frameGableStuds(ctx: Ctx, g: GableStuds, out: Draft[]): void {
  const { W, L, plate, tan, s, rw } = ctx;
  const sw = g.stock.width;
  const T = g.stock.depth;
  const norm = Math.hypot(1, tan);
  // The rafters' bottom planes on each side (removed above) and the ridge's underside.
  const zb = (v: number) => plate + (Math.min(v, W - v) - s) * tan;
  const sides: Plane[] = [
    { n: [0, -tan / norm, 1 / norm], k: (plate - s * tan) / norm },
    { n: [0, tan / norm, 1 / norm], k: (plate - s * tan + W * tan) / norm },
  ];
  const ridgeBottom = ctx.ridgeTop - ctx.rd;
  const r0 = W / 2 - rw / 2;
  const r1 = W / 2 + rw / 2;
  for (const n of [4, 2] as const) {
    const origin = n === 4 ? (g.origin?.e4 ?? 0) : (g.origin?.e2 ?? 0);
    let o = origin % g.spacing;
    if (o > EPS) o -= g.spacing;
    const uMax = n === 4 ? T : L;
    for (let k = 0; o + k * g.spacing - sw / 2 < W; k++) {
      const c = o + k * g.spacing;
      const a = c - sw / 2;
      const b = c + sw / 2;
      if (a < -EPS) continue;
      const underRidge = b > r0 + EPS && a < r1 - EPS;
      const top = (v: number) => Math.min(zb(v), underRidge ? ridgeBottom : Infinity) - plate;
      const short = Math.min(top(a), top(b));
      if (short < sw) continue;
      const probes = [a, b, W / 2].filter((v) => v >= a - EPS && v <= b + EPS);
      if (underRidge)
        for (const v of [s + (ridgeBottom - plate) / tan, W - s - (ridgeBottom - plate) / tan])
          if (v >= a && v <= b) probes.push(v);
      const len = Math.max(...probes.map(top));
      const planes = underRidge ? [...sides, { n: [0, 0, 1] as Vec3, k: ridgeBottom }] : sides;
      // Up, thin face along v, depth across the wall: x = up, y = +v, z = x cross y = -u.
      push(
        out,
        board(
          formatRoofMemberId({ form: 'gable-stud', edge: n, slot: k }),
          'gable-stud',
          g.stock,
          [uMax, a, plate],
          [0, 0, 1],
          [0, 1, 0],
          len,
          [0, 1],
          planes,
        ),
      );
    }
  }
}

/** Sub-fascia and fascia along the eaves, on the plumb tail cuts, tops flush with the rafters' tails. */
function frameBoards(ctx: Ctx, out: Draft[]): void {
  const { st, o } = ctx;
  if (!st.subFascia && !st.fascia) return;
  const edges: RoofEdge[] = ctx.kind === 'gable' ? [1, 3] : [1, 2, 3, 4];
  const zTop = ctx.plate + ctx.hap - o * ctx.tan;
  const max = Math.max(...st.stockLengths);
  const centres = rafterCentres(out, ctx);
  const layers: Array<{ board: 'sub' | 'fascia'; stock: StockRef; r: number }> = [];
  let r = -o;
  if (st.subFascia) {
    layers.push({ board: 'sub', stock: st.subFascia, r });
    r -= st.subFascia.width;
  }
  if (st.fascia) layers.push({ board: 'fascia', stock: st.fascia, r });
  for (const n of edges) {
    const e = ctx.edges[n];
    for (const layer of layers) {
      // Outer face at r - width. On a hip roof the long sides (e1, e3) run past the corners to
      // the boards' outer faces; the ends (e2, e4) butt in between them.
      const outer = layer.r - layer.stock.width;
      let a: number;
      let b: number;
      if (ctx.kind === 'gable') {
        a = -st.rakeOverhang;
        b = e.E + st.rakeOverhang;
      } else if (n === 1 || n === 3) {
        a = outer;
        b = e.E - outer;
      } else {
        a = layer.r;
        b = e.E - layer.r;
      }
      const y: Vec3 = [-e.T[1], e.T[0], 0]; // up cross along: so z is up
      const inward = y[0] * e.R[0] + y[1] * e.R[1] > 0;
      const rOrigin = inward ? outer : layer.r;
      splicePieces(a, b, max, centres[n]).forEach(([p, q], i) => {
        const P = v2.add(v2.add(e.C, v2.scale(e.T, p)), v2.scale(e.R, rOrigin));
        push(
          out,
          board(
            formatRoofMemberId({ form: 'board', edge: n, board: layer.board, piece: i + 1 }),
            layer.board === 'sub' ? 'sub-fascia' : 'fascia',
            layer.stock,
            [P[0], P[1], zTop - layer.stock.depth],
            [e.T[0], e.T[1], 0],
            y,
            q - p,
            e.T,
          ),
        );
      });
    }
  }
}

/** Rafter centres along each edge, read back from the rafters already framed. */
function rafterCentres(drafts: readonly Draft[], ctx: Ctx): Record<RoofEdge, number[]> {
  const out: Record<RoofEdge, number[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const d of drafts) {
    const p = parseRoofMemberId(d.id);
    if (!p || (p.form !== 'common' && p.form !== 'jack' && p.form !== 'fly')) continue;
    const e = ctx.edges[p.edge];
    // The centre line is half a width along y from the origin.
    const c: Vec2 = [
      d.placement.origin[0] + (d.stock.width / 2) * d.placement.y[0],
      d.placement.origin[1] + (d.stock.width / 2) * d.placement.y[1],
    ];
    out[p.edge].push(v2.dot(e.T, [c[0] - e.C[0], c[1] - e.C[1]]));
  }
  for (const n of [1, 2, 3, 4] as const) out[n].sort((a, b) => a - b);
  return out;
}

function push(out: Draft[], d: Draft | undefined): void {
  if (d) out.push(d);
}

/** From the roof's frame to the world: a rotation about z by the footprint's direction and a move. */
function toWorld(input: FrameRoofInput, d: Draft): Member {
  const f = input.footprint;
  const a = f.direction ?? 0;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const rot = (p: Vec3): Vec3 => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
  const o = rot(d.placement.origin);
  return {
    id: d.id,
    owner: input.roof,
    role: d.role,
    stock: d.stock,
    length: d.length,
    placement: {
      origin: [o[0] + f.origin[0], o[1] + f.origin[1], o[2]],
      x: rot(d.placement.x),
      y: rot(d.placement.y),
    },
    // Cuts are in the member's own frame, which a rigid motion does not change.
    cuts: d.cuts,
  };
}

function applyOverrides(
  input: FrameRoofInput,
  members: Member[],
  along: ReadonlyMap<string, Vec2>,
  warnings: RoofWarning[],
): { members: Member[]; reports: OverrideReport[] } {
  const owner = input.roof;
  const a = input.footprint.direction ?? 0;
  const byId = new Map(members.map((m, i) => [m.id, i]));
  const out: (Member | undefined)[] = [...members];
  const reports: OverrideReport[] = [];
  const deleted = new Set<string>();
  for (const o of input.overrides ?? []) {
    const i = byId.get(o.id);
    const m = i === undefined ? undefined : out[i];
    if (i === undefined || m === undefined) {
      const why = deleted.has(o.id)
        ? 'an earlier override of the same member deletes it.'
        : 'the roof no longer has that member.';
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
      const d = along.get(o.id)!;
      const wx = Math.cos(a) * d[0] - Math.sin(a) * d[1];
      const wy = Math.sin(a) * d[0] + Math.cos(a) * d[1];
      const p = next.placement;
      next = {
        ...next,
        placement: {
          ...p,
          origin: [p.origin[0] + wx * o.move, p.origin[1] + wy * o.move, p.origin[2]],
        },
      };
    }
    out[i] = next;
  }
  return { members: out.filter((m): m is Member => m !== undefined), reports };
}

function geometry(input: FrameRoofInput, ctx: Ctx, h: HipNumbers | undefined): RoofGeometry {
  const factor = 1 / ctx.cos;
  const g: RoofGeometry = {
    pitch: input.pitch,
    risePer12: 12 * ctx.tan,
    commonFactor: factor,
    commonRun: ctx.R,
    commonLineLength: ctx.R * factor,
    overhangLineLength: ctx.o * factor,
    heightAbovePlate: ctx.hap,
    ridgeAbovePlate: ctx.ridgeTop - ctx.plate,
    ridgeTop: ctx.ridgeTop,
    plumbCut: ctx.d / ctx.cos,
    birdsmouth: { seat: ctx.s, heel: ctx.s * ctx.tan, depth: ctx.s * ctx.sin },
  };
  if (!h) return g;
  const run = Math.min(h.pcut, h.qcut) * SQRT2;
  const lineLength = run / Math.cos(h.angle);
  return {
    ...g,
    hip: {
      angle: h.angle,
      run,
      lineLength,
      factor: lineLength / (run / SQRT2),
      drop: h.drop,
      birdsmouthDepth: h.depth,
    },
    jackStep: ctx.st.spacing * factor,
  };
}
