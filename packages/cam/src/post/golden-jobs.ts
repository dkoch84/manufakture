// The fixture jobs every post's golden files are written from (T5.4b, T5.4c): hand-made IR, so
// the posts do not wait for the operations. Each post writes the same jobs into `test/<post>/`
// (`grbl.test.ts`, `goldens.test.ts`), so the dialects can be compared file by file, and the
// golden runner (`test/goldens.test.ts`) checks every file with `verifyGcode`. Test data: only
// tests import this module, and it is not exported from the package.

import { isMove } from '../ir';
import type {
  ArcMove,
  DrillCycle,
  FeedClass,
  IrEntry,
  LinearMove,
  RapidMove,
  ToolChange,
} from '../ir';
import type { Toolpath as IrToolpath } from '../ir';
import { COMPACT_ROUTER_DIAL } from '../library/machines';
import type { CamResult, Vec2, Vec3 } from '../types';
import { postCarbideMotion } from './carbide-motion';
import type { CarbideMotionOptions } from './carbide-motion';
import { postGrblHal } from './grblhal';
import type { GrblHalOptions } from './grblhal';
import { postLinuxCnc } from './linuxcnc';
import type { LinuxCncOptions } from './linuxcnc';
import { postMach3 } from './mach3';
import type { Mach3Options } from './mach3';
import { GCODE_FILE_EXTENSION } from './naming';
import type { PostJob, PostOutput } from './writer';

// The router dial in the jobs is the Carbide Compact Router's: the machine profiles' table
// (`library/machines.ts`, cited to Carbide 3D's product page there), so the goldens use the same
// numbers the app does.

export const ORIGIN = 'stock top, front left corner';
export const CLEARANCE = 15;
export const RETRACT = 5;

export const FLAT: ToolChange = {
  kind: 'toolChange',
  tool: 'tool#1',
  number: 201,
  name: '#201 1/4" flat end mill',
  diameter: 6.35,
};
// Tool number 302 is above Grbl's 255: the grbl post writes no T word, so it only appears in
// comments, where Grbl does not read it.
export const VBIT: ToolChange = {
  kind: 'toolChange',
  tool: 'tool#2',
  number: 302,
  name: '#302 60 deg V-bit',
  diameter: 12.7,
};
export const DRILL: ToolChange = {
  kind: 'toolChange',
  tool: 'tool#3',
  number: 3,
  name: '3 mm drill',
  diameter: 3,
};

export const CUT = 1000;
export const PLUNGE = 300;

/** IR builder: moves tagged with an operation and pass, the position tracked for arcs. */
export class Ir {
  readonly entries: IrEntry[] = [];
  op = '';
  pass = 0;

  tool(change: ToolChange, rpm: number): this {
    this.entries.push(
      { ...change, op: this.op },
      { kind: 'spindle', state: 'cw', rpm, op: this.op },
    );
    return this;
  }

  stop(): this {
    this.entries.push({ kind: 'spindle', state: 'off', op: this.op });
    return this;
  }

  comment(text: string): this {
    this.entries.push({ kind: 'comment', text, op: this.op });
    return this;
  }

  rapid(x: number, y: number, z: number): this {
    const e: RapidMove = { kind: 'rapid', to: [x, y, z], op: this.op, pass: this.pass };
    this.entries.push(e);
    return this;
  }

  line(x: number, y: number, z: number, feed = CUT, feedClass: FeedClass = 'cut'): this {
    const e: LinearMove = {
      kind: 'linear',
      to: [x, y, z],
      feed,
      feedClass,
      op: this.op,
      pass: this.pass,
    };
    this.entries.push(e);
    return this;
  }

  arc(
    to: Vec3,
    center: Vec2,
    direction: 'cw' | 'ccw',
    extra: Partial<Pick<ArcMove, 'fullCircle' | 'feed' | 'feedClass'>> = {},
  ): this {
    this.entries.push({
      kind: 'arc',
      to,
      center,
      direction,
      fullCircle: false,
      feed: CUT,
      feedClass: 'cut',
      op: this.op,
      pass: this.pass,
      ...extra,
    });
    return this;
  }

  dwell(seconds: number): this {
    this.entries.push({ kind: 'dwell', seconds, op: this.op });
    return this;
  }

  /** Opens a canned-cycle group: the moves up to `cycleEnd` are the drilling of one hole. */
  cycle(drill: DrillCycle): this {
    this.entries.push({ kind: 'cycle', drill, op: this.op });
    return this;
  }

  cycleEnd(): this {
    this.entries.push({ kind: 'cycleEnd', op: this.op });
    return this;
  }
}

export const R = FLAT.diameter! / 2;
export const W = 60;
export const H = 40;

/**
 * An outside profile of the W x H rectangle at the origin, climb milled (clockwise around the
 * outside), the tool centre R off the sides with arcs about the corners. From (W/2, -R), the
 * middle of the front side. `tabs` lifts the tool to `tabTop` over two tabs, one on the front
 * side and one on the back, 5 mm wide, with 1 mm ramps either side.
 */
export function outsideLap(ir: Ir, z: number, tabs?: { top: number }): void {
  const y0 = -R;
  const y1 = H + R;
  const half = (5 + FLAT.diameter!) / 2;
  if (tabs) {
    // Front side, right to left, tab centred at x = 15.
    ir.line(15 + half + 1, y0, z)
      .line(15 + half, y0, tabs.top, CUT, 'ramp')
      .line(15 - half, y0, tabs.top)
      .line(15 - half - 1, y0, z, CUT, 'ramp');
  }
  ir.line(0, y0, z).arc([-R, 0, z], [0, 0], 'cw').line(-R, H, z).arc([0, y1, z], [0, H], 'cw');
  if (tabs) {
    // Back side, left to right, tab centred at x = 30.
    ir.line(30 - half - 1, y1, z)
      .line(30 - half, y1, tabs.top, CUT, 'ramp')
      .line(30 + half, y1, tabs.top)
      .line(30 + half + 1, y1, z, CUT, 'ramp');
  }
  ir.line(W, y1, z)
    .arc([W + R, H, z], [W, H], 'cw')
    .line(W + R, 0, z)
    .arc([W, -R, z], [W, 0], 'cw')
    .line(W / 2, y0, z);
}

/** The profile operation: two depth steps through 6.5 mm, tabs 2 mm high on the last. */
export function profileOp(ir: Ir): void {
  ir.op = 'profile#1';
  ir.comment('Profile: outline, outside, 2 passes, 2 tabs');
  ir.pass = 0;
  ir.rapid(W / 2, -R, RETRACT).line(W / 2, -R, -3.25, PLUNGE, 'plunge');
  outsideLap(ir, -3.25);
  ir.pass = 1;
  ir.line(W / 2, -R, -6.5, PLUNGE, 'plunge');
  outsideLap(ir, -6.5, { top: -4.5 });
}

/**
 * A 40 x 30 mm pocket 3 mm deep centred at (100, 15): a helical entry of four turns (radius 2 mm,
 * 1 mm a turn) with a flat turn at the bottom, then rectangular rings from the inside out with a
 * 2.5 mm stepover.
 */
export function pocketOp(ir: Ir): void {
  const cx = 100;
  const cy = 15;
  const z = -3;
  ir.op = 'pocket#1';
  ir.comment('Pocket: 40 x 30 mm, 3 mm deep, helical entry');
  ir.pass = 0;
  ir.rapid(cx + 2, cy, RETRACT).rapid(cx + 2, cy, 1);
  for (const turnZ of [0, -1, -2, -3]) {
    ir.arc([cx + 2, cy, turnZ], [cx, cy], 'ccw', {
      fullCircle: true,
      feed: PLUNGE,
      feedClass: 'ramp',
    });
  }
  ir.arc([cx + 2, cy, z], [cx, cy], 'ccw', { fullCircle: true });
  for (let k = 3; k >= 0; k--) {
    const hx = 20 - R - k * 2.5;
    const hy = 15 - R - k * 2.5;
    ir.pass = 3 - k;
    ir.line(cx + hx, cy, z)
      .line(cx + hx, cy + hy, z)
      .line(cx - hx, cy + hy, z)
      .line(cx - hx, cy - hy, z)
      .line(cx + hx, cy - hy, z)
      .line(cx + hx, cy, z);
  }
}

/** The drill fixtures' R plane: where each hole's cycle starts and ends, 1 mm above the stock. */
export const DRILL_R = 1;
/** How far above the last peck the drill comes back down by rapid. */
export const PECK_CLEARANCE = 0.2;

/**
 * Drill `points` from the stock top to `bottom`, each hole wrapped in a canned-cycle marker as the
 * drill operation (T5.2e) writes it: a rapid over the hole at the retract height and down to the
 * R plane, then feeds in pecks of `peck` from the stock top (straight down without), the dwell at
 * the bottom, and back to the R plane; up to the retract height between holes.
 */
export function drillHoles(
  ir: Ir,
  points: readonly Vec2[],
  hole: { readonly bottom: number; readonly peck?: number; readonly dwell?: number },
): void {
  const top = 0;
  for (const [n, [x, y]] of points.entries()) {
    ir.pass = n;
    ir.rapid(x, y, RETRACT).rapid(x, y, DRILL_R);
    const depths: number[] = [];
    if (hole.peck !== undefined) {
      for (let z = top - hole.peck; z > hole.bottom + 1e-9; z -= hole.peck) depths.push(z);
    }
    depths.push(hole.bottom);
    ir.cycle({
      at: [x, y],
      top,
      bottom: hole.bottom,
      retract: DRILL_R,
      ...(depths.length > 1 ? { peck: hole.peck! } : {}),
      ...(hole.dwell !== undefined ? { dwell: hole.dwell } : {}),
    });
    let previous = DRILL_R;
    for (const depth of depths) {
      // Back down by rapid to just above the last peck, then feed on.
      if (previous < DRILL_R) ir.rapid(x, y, previous + PECK_CLEARANCE);
      ir.line(x, y, depth, 150, 'plunge');
      // A dwell at the bottom of the hole, then out.
      if (depth === hole.bottom && hole.dwell !== undefined) ir.dwell(hole.dwell);
      ir.rapid(x, y, DRILL_R);
      previous = depth;
    }
    ir.cycleEnd();
    if (n < points.length - 1) ir.rapid(x, y, RETRACT);
  }
}

const PECK_HOLES: readonly Vec2[] = [
  [10, 10],
  [50, 10],
  [30, 30],
];

/**
 * Peck drilling at three points, 8 mm deep in 3 mm pecks with a dwell at the bottom: a cycle no
 * post writes as G83 (it has a dwell), so every post writes the moves.
 */
export function drillOp(ir: Ir): void {
  ir.op = 'drill#1';
  ir.comment('Drill: 3 holes, 8 mm deep, 3 mm pecks');
  drillHoles(ir, PECK_HOLES, { bottom: -8, peck: 3, dwell: 0.5 });
}

/**
 * Three straight holes 4 mm deep and three peck holes 8 mm deep in 3 mm pecks, no dwell: a post
 * with canned cycles writes them as G81 and G83.
 */
export function drillCyclesOp(ir: Ir): void {
  ir.op = 'drill#2';
  ir.comment('Drill: 3 holes, 4 mm deep');
  drillHoles(
    ir,
    [
      [70, 35],
      [90, 35],
      [110, 35],
    ],
    { bottom: -4 },
  );
  ir.op = 'drill#3';
  ir.comment('Drill: 3 holes, 8 mm deep, 3 mm pecks');
  ir.rapid(110, 35, RETRACT);
  drillHoles(ir, PECK_HOLES, { bottom: -8, peck: 3 });
}

/** V-carving with the 60 degree V-bit: a line and an arc, 1 mm deep. */
export function vcarveOp(ir: Ir): void {
  ir.op = 'vcarve#1';
  ir.comment('V-carve: line and arc, 1 mm deep');
  ir.pass = 0;
  ir.rapid(10, 20, RETRACT)
    .line(10, 20, -1, 200, 'plunge')
    .line(25, 20, -1, 800)
    .arc([35, 20, -1], [30, 20], 'cw', { feed: 800 })
    .line(50, 20, -1, 800);
}

/**
 * Each tool's operations, as linking (T5.2g) will join them: the tool change and spindle start,
 * the operations, a rapid straight up to the clearance from where the last cut ended, the spindle
 * stop.
 */
export function toolpath(...tools: [ToolChange, number, (ir: Ir) => void][]): IrToolpath {
  const ir = new Ir();
  for (const [n, [change, rpm, op]] of tools.entries()) {
    if (n > 0) ir.comment(`Next: ${change.name}`);
    ir.tool(change, rpm);
    op(ir);
    const last = ir.entries.findLast((e) => isMove(e));
    if (last === undefined || !isMove(last)) throw new Error('an operation needs a move');
    ir.rapid(last.to[0], last.to[1], CLEARANCE);
    ir.stop();
  }
  return { start: [0, 0, CLEARANCE], entries: ir.entries };
}

export const PROFILE = toolpath([FLAT, 18000, profileOp]);
export const POCKET = toolpath([FLAT, 18000, pocketOp]);
export const DRILLING = toolpath([DRILL, 12000, drillOp]);
export const TWO_TOOLS = toolpath([FLAT, 18000, profileOp], [VBIT, 24500, vcarveOp]);
export const DRILLING_CYCLES = toolpath([DRILL, 12000, drillCyclesOp]);

/**
 * The V-bit as tool 2: for controllers whose T word stops at 255 (Mach3), which refuse #302's
 * catalogue number.
 */
export const VBIT_2: ToolChange = { ...VBIT, number: 2 };
export const TWO_TOOLS_VBIT_2 = toolpath([FLAT, 18000, profileOp], [VBIT_2, 24500, vcarveOp]);

/** The fixture job; `dial: false` leaves out the router dial table. */
export function job(tp: IrToolpath, over: Partial<PostJob> = {}, dial = true): PostJob {
  return {
    toolpath: tp,
    job: 'Plywood sign',
    setup: 'Top',
    date: '2026-10-02',
    origin: ORIGIN,
    heights: { clearance: CLEARANCE, retract: RETRACT },
    ...(dial ? { spindleDial: COMPACT_ROUTER_DIAL } : {}),
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// The goldens of the posts T5.4c added, run by `goldens.test.ts`

/** One golden: a fixture job written with some options into `files` files. */
export interface Golden<O> {
  readonly name: string;
  readonly job: PostJob;
  readonly options?: O;
  readonly files: number;
}

/** `test/<dir>/`, where a post's goldens live. */
export function goldenDir(dir: string): string {
  return new URL(`../../test/${dir}/`, import.meta.url).pathname;
}

/** The path of file `index` of `count` of golden `name`: `name.nc`, or `name-2.nc` when split. */
export function goldenPath(dir: string, name: string, index: number, count: number): string {
  const suffix = count > 1 ? `-${index}` : '';
  return `${goldenDir(dir)}${name}${suffix}.${GCODE_FILE_EXTENSION}`;
}

/** `post`'s output, or a thrown error naming the refusal (tests only). */
export function posted<O>(
  post: (job: PostJob, options?: O) => CamResult<PostOutput>,
  job: PostJob,
  options?: O,
): PostOutput {
  const r = post(job, options);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** A post and its goldens, in `test/<dir>/`. */
export interface GoldenSuite<O> {
  readonly dir: string;
  readonly post: (job: PostJob, options?: O) => CamResult<PostOutput>;
  readonly goldens: readonly Golden<O>[];
}

/** The jobs every `M6 T<n>` post writes, in one file each. */
function m6Goldens<O extends { readonly units?: 'mm' | 'inch'; readonly cannedCycles?: boolean }>(
  cycles: boolean,
  twoTools: IrToolpath,
): Golden<O>[] {
  return [
    { name: 'profile-tabs', job: job(PROFILE), files: 1 },
    { name: 'profile-tabs-inch', job: job(PROFILE), options: { units: 'inch' } as O, files: 1 },
    // No dial table: the spindle line has no router comment.
    { name: 'pocket', job: job(POCKET, {}, false), files: 1 },
    // A dwell at the bottom of each peck hole: written as moves by every post.
    { name: 'drilling', job: job(DRILLING), files: 1 },
    {
      name: 'drilling-cycles',
      job: job(DRILLING_CYCLES),
      ...(cycles ? { options: { cannedCycles: true } as O } : {}),
      files: 1,
    },
    { name: 'two-tools', job: job(twoTools), files: 1 },
  ];
}

export const CARBIDE_MOTION_GOLDEN_SUITE: GoldenSuite<CarbideMotionOptions> = {
  dir: 'carbide-motion',
  post: postCarbideMotion,
  goldens: m6Goldens<CarbideMotionOptions>(false, TWO_TOOLS),
};

export const GRBLHAL_GOLDEN_SUITE: GoldenSuite<GrblHalOptions> = {
  dir: 'grblhal',
  post: postGrblHal,
  goldens: [
    { name: 'profile-tabs', job: job(PROFILE), files: 1 },
    { name: 'profile-tabs-inch', job: job(PROFILE), options: { units: 'inch' }, files: 1 },
    { name: 'pocket', job: job(POCKET, {}, false), files: 1 },
    { name: 'drilling', job: job(DRILLING), files: 1 },
    {
      name: 'drilling-cycles',
      job: job(DRILLING_CYCLES),
      options: { cannedCycles: true },
      files: 1,
    },
    { name: 'two-tools-files', job: job(TWO_TOOLS), files: 2 },
    { name: 'two-tools-pause', job: job(TWO_TOOLS), options: { multiTool: 'pause' }, files: 1 },
    { name: 'two-tools-m6', job: job(TWO_TOOLS), options: { multiTool: 'm6' }, files: 1 },
  ],
};

export const LINUXCNC_GOLDEN_SUITE: GoldenSuite<LinuxCncOptions> = {
  dir: 'linuxcnc',
  post: postLinuxCnc,
  goldens: m6Goldens<LinuxCncOptions>(true, TWO_TOOLS),
};

/** Mach3's T stops at 255, so its two-tool job numbers the V-bit 2. */
export const MACH3_GOLDEN_SUITE: GoldenSuite<Mach3Options> = {
  dir: 'mach3',
  post: postMach3,
  goldens: m6Goldens<Mach3Options>(true, TWO_TOOLS_VBIT_2),
};
