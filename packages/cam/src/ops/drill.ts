// The drill operation (M5 plan, T5.2e; ADR 0014): make the holes the model already knows about.
// A hole the tool matches is drilled straight down, or in pecks, as plain G0 and G1 moves (Grbl
// has no canned cycles) wrapped in `cycle` markers a post with canned cycles may collapse. A hole
// larger than an end mill is bored: a helix down to the bottom on rings from the inside out, and
// a finishing circle at the bottom. Holes are visited in nearest-neighbour order.
//
// The README's "Drill operation" section describes the moves, the heights and the warnings.

import type { DrillCycle, IrEntry } from '../ir';
import { stockTopZ } from '../job';
import type { CamWarning, GeneratedToolpath, OperationContext } from '../worker/registry';
import {
  err,
  ok,
  type CamResult,
  type DrillInput,
  type MachineDrillPoint,
  type Tool,
  type Vec2,
  type Vec3,
} from '../types';
import { operationMoveCap, withMoveBudget } from './budget';
import { ENTRY_MIN_ANGLE, helixTooLong, helixTurns } from './entry';
import { Emitter, PROFILE_SAFE_ABOVE } from './profile';

/**
 * Fields of a drill operation that `DrillInput` (types.ts) does not have yet. All optional; the
 * core schema and `DrillInput` should take them over.
 */
export interface DrillExtras {
  /**
   * How far below a through hole's bottom the tool goes beyond its tip length, mm, zero or more.
   * Default `DRILL_BREAKTHROUGH_MARGIN`.
   */
  readonly breakthrough?: number;
  /**
   * How much larger than the tool a hole may be and still be drilled straight, mm, zero or more.
   * Larger holes are bored with an end mill. Default `DRILL_MATCH_TOLERANCE`.
   */
  readonly matchTolerance?: number;
  /** The slope of a bore's helix at the hole wall, radians, in (0, 90 degrees]. Default 3 degrees. */
  readonly helixAngle?: number;
  /**
   * Radial step between the rings of a bore wider than twice the tool, as a fraction of the tool
   * diameter, in (0, 1]. Default `DRILL_BORE_STEPOVER`.
   */
  readonly boreStepover?: number;
}

/** A drill operation as the generator reads it. */
export type DrillOperation = DrillInput & DrillExtras;

/** Rapids stop this far above the stock top, mm, and pecks re-enter this far above the last depth. */
export const DRILL_SAFE_ABOVE = PROFILE_SAFE_ABOVE;

/** A peck re-enters the hole by a rapid to this far above the depth the last peck reached, mm. */
export const DRILL_PECK_CLEARANCE = 0.5;

/**
 * Default extra depth below a through hole, mm, past the tool's tip length: the part's bottom face
 * is cut cleanly even with the stock's bottom a little off. Goes into the spoilboard.
 */
export const DRILL_BREAKTHROUGH_MARGIN = 0.5;

/**
 * A breakthrough into a cavity (`MachineDrillPoint.clearBelow`) stops this far above the
 * cavity's floor, mm, so the tool never marks the material under it.
 */
export const DRILL_CAVITY_CLEARANCE = 0.2;

/**
 * A drill (not a bore) entering a mouth tilted more than this from square (radians, 20 degrees)
 * gets a `sloped-entry` warning: the point walks on the slope.
 */
export const DRILL_SLOPED_ENTRY = (20 * Math.PI) / 180;

/** Default for `matchTolerance`, mm. */
export const DRILL_MATCH_TOLERANCE = 0.05;

/**
 * The smallest helix radius a bore uses, mm. A hole less than twice this over the tool's diameter
 * is drilled straight whatever `matchTolerance` says: a smaller ring is no cut, and its arcs fall
 * below the arc checks of the validator and of Grbl.
 */
export const DRILL_MIN_BORE_RADIUS = 0.025;

/** A hole smaller than the tool by more than this, mm, is an error (rounding of inch sizes). */
export const DRILL_UNDERSIZE_TOLERANCE = 0.01;

/** Default helix angle of a bore, radians (3 degrees). */
export const DRILL_HELIX_ANGLE = (3 * Math.PI) / 180;

/** Default `boreStepover`. */
export const DRILL_BORE_STEPOVER = 0.5;

/**
 * The most rings one bore may have. Far above any real bore (a 100 mm hole with a 3 mm end mill
 * at the default stepover has 32); above it the operation is refused.
 */
export const DRILL_MAX_BORE_RINGS = 1000;

/**
 * The most pecks one hole may take. Far above any real hole (50 mm deep in 0.5 mm pecks is 100);
 * a peck depth so small that a hole needs more is refused before any depth is listed.
 */
export const DRILL_MAX_PECKS = 10000;

/**
 * The point angle assumed for a `drill` tool without one, radians: 118 degrees, the common
 * twist drill point.
 */
export const DRILL_DEFAULT_POINT_ANGLE = (118 * Math.PI) / 180;

/** Holes whose centres are this close, mm, and whose diameters agree this well are one hole. */
const SAME_HOLE = 1e-3;

const EPS = 1e-9;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): boolean => finite(v) && v > 0;
const nonNegative = (v: unknown): boolean => finite(v) && v >= 0;
const fmt = (v: number, d = 3): string => String(Math.round(v * 10 ** d) / 10 ** d + 0);
const where = (p: MachineDrillPoint): string => `(${fmt(p.at[0])}, ${fmt(p.at[1])})`;

/**
 * How far the tool's lowest point is below where its full diameter starts, mm: a drill's point
 * cone, a ball's radius, a bull nose's corner radius, nothing for a flat end mill.
 */
export function toolTipLength(tool: Tool): number {
  const r = tool.diameter / 2;
  switch (tool.kind) {
    case 'drill':
    case 'vbit': {
      const angle = tool.angle ?? DRILL_DEFAULT_POINT_ANGLE;
      return angle > 0 && angle < Math.PI ? r / Math.tan(angle / 2) : 0;
    }
    case 'ball':
      return r;
    case 'bull':
      return tool.cornerRadius ?? 0;
    default:
      return 0;
  }
}

function checkInput(op: DrillOperation): string | undefined {
  if (!positive(op.tool.diameter)) return 'The tool diameter must be greater than zero.';
  if (!positive(op.feeds.plunge)) return 'The plunge feed must be greater than zero.';
  if (!positive(op.feeds.cut)) return 'The cutting feed must be greater than zero.';
  if (op.feeds.ramp !== undefined && !positive(op.feeds.ramp)) {
    return 'The ramp feed must be greater than zero.';
  }
  if (op.peck !== undefined && !positive(op.peck))
    return 'The peck depth must be greater than zero.';
  if (op.dwell !== undefined && !nonNegative(op.dwell)) return 'The dwell must be zero or more.';
  if (op.breakthrough !== undefined && !nonNegative(op.breakthrough)) {
    return 'The breakthrough must be zero or more.';
  }
  if (op.matchTolerance !== undefined && !nonNegative(op.matchTolerance)) {
    return 'The match tolerance must be zero or more.';
  }
  const angle = op.helixAngle;
  if (
    angle !== undefined &&
    !(finite(angle) && angle >= ENTRY_MIN_ANGLE - 1e-12 && angle <= Math.PI / 2)
  ) {
    return 'The helix angle must be at least 0.5 and at most 90 degrees.';
  }
  const s = op.boreStepover;
  if (s !== undefined && !(finite(s) && s > 0 && s <= 1)) {
    return 'The bore stepover must be greater than 0 and at most 1 (a fraction of the tool diameter).';
  }
  for (const p of op.points) {
    if (!finite(p.at[0]) || !finite(p.at[1])) return 'A hole position is not finite.';
    if (!finite(p.depth.top) || !finite(p.depth.bottom))
      return `The hole at ${where(p)} has a depth that is not finite.`;
    if (!(p.depth.top > p.depth.bottom))
      return `The hole at ${where(p)} has its bottom at or above its top.`;
    if (p.clearBelow !== undefined && !nonNegative(p.clearBelow)) {
      return `The hole at ${where(p)} has a clear height below it that is not zero or more.`;
    }
    if (p.entryTilt !== undefined && !nonNegative(p.entryTilt)) {
      return `The hole at ${where(p)} has an entry tilt that is not zero or more.`;
    }
    if (!positive(p.diameter))
      return `The hole at ${where(p)} has a diameter that is not greater than zero.`;
  }
  return undefined;
}

/**
 * Points at the same place with the same diameter merged: the deepest bottom, the highest top,
 * the highest cavity floor under the exit (`clearBelow` measured from the merged bottom) and the
 * steepest mouth (`entryTilt`).
 */
function mergeSame(points: readonly MachineDrillPoint[]): {
  points: MachineDrillPoint[];
  /** Merged holes where one source's bottom is already below another's cavity floor. */
  belowFloor: MachineDrillPoint[];
} {
  const out: MachineDrillPoint[] = [];
  const belowFloor = new Set<number>();
  for (const p of points) {
    const i = out.findIndex(
      (q) =>
        Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]) <= SAME_HOLE &&
        Math.abs(q.diameter - p.diameter) <= SAME_HOLE,
    );
    if (i < 0) {
      out.push(p);
      continue;
    }
    const q = out[i]!;
    const through = q.through === true || p.through === true;
    const bottom = Math.min(q.depth.bottom, p.depth.bottom);
    // The most cautious of each: the highest cavity floor under the exit (as a clear height
    // below the merged bottom), and the steepest mouth.
    const floors = [q, p].flatMap((x) =>
      x.clearBelow === undefined ? [] : [x.depth.bottom - x.clearBelow],
    );
    const tilts = [q, p].flatMap((x) => (x.entryTilt === undefined ? [] : [x.entryTilt]));
    if (floors.length > 0 && bottom < Math.max(...floors) - 1e-9) belowFloor.add(i);
    const { clearBelow: _c, entryTilt: _t, ...rest } = q;
    void _c;
    void _t;
    out[i] = {
      ...rest,
      depth: { top: Math.max(q.depth.top, p.depth.top), bottom },
      ...(through ? { through } : {}),
      ...(floors.length > 0 ? { clearBelow: Math.max(0, bottom - Math.max(...floors)) } : {}),
      ...(tilts.length > 0 ? { entryTilt: Math.max(...tilts) } : {}),
    };
  }
  return { points: out, belowFloor: [...belowFloor].map((i) => out[i]!) };
}

/** Nearest-neighbour order, from the hole nearest `from`. */
export function nearestNeighbourOrder<T extends { readonly at: Vec2 }>(
  points: readonly T[],
  from: Vec2 = [0, 0],
): T[] {
  const left = [...points];
  const out: T[] = [];
  let cur = from;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((p, i) => {
      const d = Math.hypot(p.at[0] - cur[0], p.at[1] - cur[1]);
      if (d < bestD - EPS) {
        best = i;
        bestD = d;
      }
    });
    const [p] = left.splice(best, 1);
    out.push(p!);
    cur = p!.at;
  }
  return out;
}

type Plan =
  | { readonly kind: 'drill'; readonly point: MachineDrillPoint; readonly bottom: number }
  | {
      readonly kind: 'bore';
      readonly point: MachineDrillPoint;
      readonly bottom: number;
      /** Helix radii of the tool centre, inside out; the last is the finishing radius. */
      readonly radii: readonly number[];
    };

/** How far below a through hole's bottom the tool goes when nothing is in the way, mm. */
const breakthroughOf = (op: DrillOperation): number =>
  toolTipLength(op.tool) + (op.breakthrough ?? DRILL_BREAKTHROUGH_MARGIN);

/** The breakthrough for `p`: `extra`, capped above the floor of a cavity under the exit. */
const extraFor = (p: MachineDrillPoint, extra: number): number =>
  p.clearBelow === undefined
    ? extra
    : Math.min(extra, Math.max(0, p.clearBelow - DRILL_CAVITY_CLEARANCE));

/** How each hole is made, or the error for the holes the tool cannot make. */
function plan(op: DrillOperation, points: readonly MachineDrillPoint[]): CamResult<Plan[]> {
  const tool = op.tool;
  const d = tool.diameter;
  const r = d / 2;
  const tolerance = op.matchTolerance ?? DRILL_MATCH_TOLERANCE;
  const extra = breakthroughOf(op);
  const step = (op.boreStepover ?? DRILL_BORE_STEPOVER) * d;
  const small = points.filter((p) => p.diameter < d - DRILL_UNDERSIZE_TOLERANCE);
  if (small.length > 0) {
    const list = small.map((p) => `${fmt(p.diameter)} mm at ${where(p)}`).join(', ');
    return err(
      'invalid-input',
      `${op.id}: ${small.length === 1 ? 'a hole is' : `${small.length} holes are`} smaller than the ${fmt(d)} mm tool: ${list}.`,
    );
  }
  const plans: Plan[] = [];
  const big: MachineDrillPoint[] = [];
  for (const p of points) {
    const bottom = p.through ? p.depth.bottom - extraFor(p, extra) : p.depth.bottom;
    if (p.diameter <= d + Math.max(tolerance, 2 * DRILL_MIN_BORE_RADIUS)) {
      if (tool.kind === 'vbit' || tool.kind === 'engraver') {
        return err('invalid-input', `${op.id}: a ${tool.kind} cannot drill holes.`);
      }
      plans.push({ kind: 'drill', point: p, bottom });
      continue;
    }
    if (tool.kind !== 'flat' && tool.kind !== 'ball' && tool.kind !== 'bull') {
      big.push(p);
      continue;
    }
    const outer = (p.diameter - d) / 2;
    // Rings inside out, the innermost within the tool radius so no core is left standing.
    const inner = Math.min(outer, 0.9 * r);
    const n = outer > inner ? Math.ceil((outer - inner) / step - 1e-9) : 0;
    if (!(n <= DRILL_MAX_BORE_RINGS)) {
      return err(
        'invalid-input',
        `${op.id}: boring the ${fmt(p.diameter)} mm hole at ${where(p)} with the ${fmt(d)} mm tool needs ${n} rings; at most ${DRILL_MAX_BORE_RINGS} are allowed. Use a larger tool or bore stepover.`,
      );
    }
    const radii = Array.from({ length: n + 1 }, (_, k) =>
      k === n ? outer : inner + ((outer - inner) * k) / n,
    );
    plans.push({ kind: 'bore', point: p, bottom, radii });
  }
  if (big.length > 0) {
    const list = big.map((p) => `${fmt(p.diameter)} mm at ${where(p)}`).join(', ');
    return err(
      'invalid-input',
      `${op.id}: the ${fmt(d)} mm ${tool.kind} is smaller than ${big.length === 1 ? 'a hole' : `${big.length} holes`} (${list}): bore ${big.length === 1 ? 'it' : 'them'} with an end mill.`,
    );
  }
  return ok(plans);
}

class DrillCutter {
  readonly em: Emitter;
  readonly warnings: CamWarning[] = [];
  private readonly warned = new Set<string>();
  /** Where material may start: the stock top, or a hole's top when that is higher. */
  private readonly startZ: number;
  readonly retractZ: number;
  readonly clearanceZ: number;
  /** Where the bore's rapids stop above the material, at most `retractZ`. */
  private readonly approachZ: number;

  constructor(
    private readonly op: DrillOperation,
    context: OperationContext,
    first: Vec2,
  ) {
    const tops = op.points.map((p) => p.depth.top);
    this.startZ = Math.max(stockTopZ(context.setup), ...tops);
    const heights = context.setup.heights;
    this.retractZ = Math.max(heights.retract, this.startZ + DRILL_SAFE_ABOVE);
    this.clearanceZ = Math.max(heights.clearance, this.retractZ);
    this.approachZ = this.startZ + DRILL_SAFE_ABOVE;
    this.em = new Emitter(
      op.id,
      op.feeds,
      [first[0], first[1], this.clearanceZ],
      operationMoveCap(context),
    );
  }

  once(code: string, message: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.warnings.push({ code, message });
  }

  private push(entry: IrEntry): void {
    this.em.push(entry);
  }

  /** Over `xy` at the retract height: up to it first, never across below it. */
  private over(xy: Vec2): void {
    const em = this.em;
    if (em.cur[2] < this.retractZ - EPS) em.rapid([em.cur[0], em.cur[1], this.retractZ]);
    em.rapid([xy[0], xy[1], em.cur[2]]);
    em.rapid([xy[0], xy[1], this.retractZ]);
  }

  /**
   * Straight or peck drilling, wrapped in a `cycle` marker. Returns why the hole is refused (it
   * needs more than `DRILL_MAX_PECKS` pecks), with nothing emitted for it.
   */
  drill(p: MachineDrillPoint, bottom: number): string | undefined {
    const em = this.em;
    const op = this.op;
    const at = p.at;
    const top = this.startZ;
    const depths: number[] = [];
    if (op.peck !== undefined) {
      const peck = op.peck;
      // Counted before any depth is listed, and each depth taken from the top by its index: a
      // running `z -= peck` stalls once the peck is below the rounding step of z.
      const pecks = Math.ceil((top - bottom) / peck);
      if (!(pecks <= DRILL_MAX_PECKS)) {
        return `the hole at ${where(p)} is ${fmt(top - bottom)} mm deep and needs ${pecks} pecks of ${fmt(peck, 6)} mm; at most ${DRILL_MAX_PECKS} are allowed. Use a larger peck depth.`;
      }
      for (let k = 1; k <= pecks; k++) {
        const z = top - k * peck;
        if (!(z > bottom + EPS)) break;
        depths.push(z);
      }
    }
    this.over(at);
    depths.push(bottom);
    const dwell = op.dwell !== undefined && op.dwell > 0 ? op.dwell : undefined;
    const drill: DrillCycle = {
      at: [at[0], at[1]],
      top,
      bottom,
      retract: this.retractZ,
      ...(depths.length > 1 ? { peck: op.peck! } : {}),
      ...(dwell !== undefined ? { dwell } : {}),
    };
    this.push({ kind: 'cycle', drill, op: op.id });
    depths.forEach((z, k) => {
      if (k > 0) {
        em.pass++;
        em.rapid([at[0], at[1], depths[k - 1]! + DRILL_PECK_CLEARANCE]);
      }
      em.linear([at[0], at[1], z], 'plunge');
      if (k < depths.length - 1) em.rapid([at[0], at[1], this.retractZ]);
    });
    if (dwell !== undefined) this.push({ kind: 'dwell', seconds: dwell, op: op.id, pass: em.pass });
    em.rapid([at[0], at[1], this.retractZ]);
    this.push({ kind: 'cycleEnd', op: op.id });
    em.pass++;
    return undefined;
  }

  /**
   * A helical bore on `radii` (inside out), each to the bottom with a level turn there. Returns
   * why the bore is refused (a ring's helix has too many turns), with nothing emitted for it.
   */
  bore(p: MachineDrillPoint, bottom: number, radii: readonly number[]): string | undefined {
    const em = this.em;
    const op = this.op;
    const c = p.at;
    const r = op.tool.diameter / 2;
    const angle = op.helixAngle ?? DRILL_HELIX_ANGLE;
    const ccw = true; // climb milling with an M3 spindle on the wall of a hole
    const drop = this.startZ - bottom;
    for (const rh of radii) {
      // The slope is the angle at the hole wall, where the tool's edge cuts.
      const turns = helixTurns(drop, rh + r, angle);
      const tooLong = helixTooLong(turns, drop, rh + r, angle);
      if (tooLong) return `the bore at ${where(p)}: ${tooLong}`;
    }
    radii.forEach((rh, k) => {
      const start: Vec2 = [c[0] + rh, c[1]];
      if (k === 0) {
        this.over(start);
      } else {
        // Straight up inside the bore just made, then across above the stock.
        em.rapid([em.cur[0], em.cur[1], this.approachZ]);
        em.rapid([start[0], start[1], this.approachZ]);
      }
      if (em.cur[2] > this.approachZ + EPS) em.rapid([start[0], start[1], this.approachZ]);
      em.linear([start[0], start[1], this.startZ], 'plunge');
      const turns = helixTurns(drop, rh + r, angle);
      for (let t = 1; t <= turns; t++) {
        const z = t === turns ? bottom : this.startZ - (drop * t) / turns;
        em.arc([start[0], start[1], z], c, ccw, 'ramp', true);
      }
      // A level turn flattens the helix's sloped floor; on the last ring it is the finishing circle.
      em.arc([start[0], start[1], bottom], c, ccw, 'cut', true);
      em.pass++;
    });
    // Off the wall to the centre before going up.
    em.pass--;
    em.linear([c[0], c[1], bottom], 'cut');
    em.rapid([c[0], c[1], this.retractZ]);
    em.pass++;
    return undefined;
  }

  result(start: Vec3): GeneratedToolpath {
    const em = this.em;
    em.pass = Math.max(0, em.pass - 1);
    em.rapid([em.cur[0], em.cur[1], this.clearanceZ]);
    const toolpath = { start, entries: em.entries };
    return this.warnings.length > 0 ? { toolpath, warnings: this.warnings } : { toolpath };
  }

  /** The deepest the tool reaches below the start of material. */
  depthWarning(plans: readonly Plan[]): void {
    let deepest = Infinity;
    for (const p of plans) deepest = Math.min(deepest, p.bottom);
    const depth = this.startZ - deepest;
    if (depth > this.op.tool.fluteLength) {
      this.once(
        'depth-exceeds-flutes',
        `The deepest hole goes ${fmt(depth)} mm below the stock top but the tool's flutes are ${fmt(this.op.tool.fluteLength)} mm long.`,
      );
    }
  }
}

/**
 * Generates a drill operation's toolpath (registered as the `drill` generator). Holes in
 * nearest-neighbour order from the WCS origin; each peck and each bore ring is one `pass`.
 */
export async function generateDrill(
  input: DrillInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  return withMoveBudget(input.id, () => drillToolpath(input, context));
}

async function drillToolpath(
  input: DrillInput,
  context: OperationContext,
): Promise<CamResult<GeneratedToolpath>> {
  const op = input as DrillOperation;
  const problem = checkInput(op);
  if (problem) return err('invalid-input', `${op.id}: ${problem}`);
  if (op.points.length === 0) return err('invalid-input', `${op.id}: the operation has no holes.`);
  const merged = mergeSame(op.points);
  const plans = plan(op, nearestNeighbourOrder(merged.points));
  if (!plans.ok) return plans;

  const first = plans.value[0]!;
  const firstXY: Vec2 =
    first.kind === 'bore'
      ? [first.point.at[0] + first.radii[0]!, first.point.at[1]]
      : first.point.at;
  const cutter = new DrillCutter(op, context, firstXY);
  const start: Vec3 = [firstXY[0], firstXY[1], cutter.clearanceZ];
  cutter.depthWarning(plans.value);
  if (merged.belowFloor.length > 0) {
    cutter.once(
      'merged-below-floor',
      `${merged.belowFloor.length === 1 ? 'A hole is' : `${merged.belowFloor.length} holes are`} given twice, and one already goes below the cavity floor the other found under its exit (${merged.belowFloor.map((p) => where(p)).join(', ')}): it cuts into that floor, and gets no breakthrough.`,
    );
  }
  const extra = breakthroughOf(op);
  const capped = plans.value.filter(
    (p) =>
      p.point.through === true &&
      extraFor(p.point, extra) < extra - 1e-9 &&
      !merged.belowFloor.includes(p.point),
  );
  if (capped.length > 0) {
    const list = capped
      .map((p) => `${where(p.point)} by ${fmt(extraFor(p.point, extra))} of ${fmt(extra)} mm`)
      .join(', ');
    cutter.once(
      'breakthrough-capped',
      `${capped.length === 1 ? 'A through hole opens' : `${capped.length} through holes open`} into a cavity with material below, so the tool goes through only ${list}; a pointed tool leaves the exit undersize there.`,
    );
  }
  const sloped = plans.value.filter(
    (p) => p.kind === 'drill' && (p.point.entryTilt ?? 0) > DRILL_SLOPED_ENTRY,
  );
  if (sloped.length > 0) {
    cutter.once(
      'sloped-entry',
      `${sloped.length === 1 ? 'A hole is' : `${sloped.length} holes are`} drilled into a sloped surface (${sloped.map((p) => `${where(p.point)} at ${fmt(((p.point.entryTilt ?? 0) * 180) / Math.PI, 1)} degrees`).join(', ')}): spot it or mill it flat first.`,
    );
  }
  for (const p of plans.value) {
    await context.checkpoint();
    const refused =
      p.kind === 'drill'
        ? cutter.drill(p.point, p.bottom)
        : cutter.bore(p.point, p.bottom, p.radii);
    if (refused) return err('invalid-input', `${op.id}: ${refused}`);
  }
  return ok(cutter.result(start));
}
