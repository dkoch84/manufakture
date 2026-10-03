// Linking and job assembly (M5 plan, T5.2g; ADR 0014): a setup's operation toolpaths become one
// program, the IR the posts write (one file per tool where the dialect splits them). The README's
// "Linking and job assembly" section describes the rules; in short:
//
// - Operations run in the user's order, or grouped by tool (stable within a tool) on request.
//   Suppressed operations are left out; an operation with an error fails the whole job, naming
//   it, so an export never silently drops a cut.
// - Between operations the tool rises straight up to the clearance height, crosses there, and
//   comes down to where the next operation starts. Every tool change happens at the clearance
//   height: rise, spindle off, `toolChange`, spindle on, dwell.
// - Inside an operation the job only reorders pieces the operation exposes as independent (drill
//   holes in canned-cycle groups, or `pieces` an operation hands over): nearest neighbour from
//   where the tool is, kept only when it is shorter than the operation's own order. Between
//   pieces the tool crosses at the retract height when that is above the stock top, else at the
//   clearance height. Every other move of an operation is passed through as it was generated.
// - The program starts and ends at the clearance height.
//
// A rapid of the job's own never runs below the stock top while moving sideways: every crossing
// is at or above `stockTop + JOB_SAFE_ABOVE`, and the only moves below that are straight up out of
// the operation's own last cut. When unsure, the job uses the clearance height.

import type { IrEntry, RapidMove, Toolpath } from './ir';
import { isMove } from './ir';
import type { Sourced } from './library/types';
import { toolpathStats } from './stats';
import type { ToolpathStats } from './stats';
import type { CamError, Feeds, Setup, Tool, Vec3 } from './types';
import { validateToolpath } from './validate';
import type { CamOperationResult } from './worker/api';
import { unpackToolpath } from './worker/pack';
import type { CamWarning } from './worker/registry';

/** The `op` tag of the job's own moves between operations and pieces (`MoveTag.op`). */
export const JOB_LINK_OP = 'link';

/** The job's crossings stay at least this far above the stock top, mm (the operations' 0.5). */
export const JOB_SAFE_ABOVE = 0.5;

/**
 * The dwell after every spindle start or speed change, seconds, so the spindle is up to speed
 * before the first cut. A cautious choice, not a measured figure: no spin-up time was found
 * published for the Carbide Compact Router or the 65 mm VFD spindle.
 */
export const JOB_SPINDLE_DWELL: Sourced<number> = {
  value: 5,
  source:
    'No maker figure: the Carbide Compact Router and 65 mm VFD spindle product pages give no spin-up time (searched 2026-10-02).',
  verified: false,
  note: 'A cautious default; `JobOptions.spindleDwell` overrides it.',
};

const EPS = 1e-6;

/** An operation's generated outcome, as the CAM worker returns it (unpacked). */
export type JobOperationOutcome =
  | {
      readonly ok: true;
      readonly toolpath: Toolpath;
      readonly warnings?: readonly CamWarning[];
      /**
       * Optional: the operation's cut as independent pieces, in the operation's own order, that
       * may run in any order. When present they replace `toolpath` in the job. Each piece is a
       * toolpath of its own: it starts at `start`, at least `JOB_SAFE_ABOVE` above the stock top,
       * and may end anywhere the tool can rise straight up from.
       */
      readonly pieces?: readonly Toolpath[];
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** One operation as the job reads it. */
export interface JobOperation {
  /** The operation id, `profile#2`. */
  readonly id: string;
  /** For the operator comment in front of the operation; none when absent. */
  readonly name?: string;
  readonly tool: Tool;
  /** The spindle speed is read from here. */
  readonly feeds: Pick<Feeds, 'spindle'>;
  /** A suppressed operation is left out of the job, error or not. */
  readonly suppressed?: boolean;
  /**
   * The id of an operation that must run after this one, also when grouping by tool: a V-carve's
   * clearing, so the V-bit never cuts the whole floor. `jobOperations` sets it.
   */
  readonly before?: string;
  readonly result: JobOperationOutcome;
}

/** What the job needs of the setup. */
export type JobSetup = Pick<Setup, 'heights' | 'stock' | 'wcs'>;

export interface JobOptions {
  /**
   * Group operations by tool, tools in the order they are first used and each tool's operations
   * in the user's order. Default false: the user's order, with a tool change wherever it changes.
   */
  readonly groupByTool?: boolean;
  /** Reorder independent pieces (drill holes) nearest-neighbour first. Default true. */
  readonly reorder?: boolean;
  /** Seconds of dwell after each spindle start or speed change; default `JOB_SPINDLE_DWELL`. */
  readonly spindleDwell?: number;
  /** Where the tool is before the program; default the WCS origin at the clearance height. */
  readonly start?: Vec3;
  /** The machine's rapid rate, mm/min, for `Job.stats`; no statistics without it. */
  readonly rapidRate?: number;
}

/** Where an operation sits in the job's entries. */
export interface JobSpan {
  readonly op: string;
  readonly tool: string;
  /**
   * Entries `[from, to)`: from the operation's comment and the link that brings the tool to it
   * (after any tool change and spindle start) to its last entry.
   */
  readonly from: number;
  readonly to: number;
}

export interface JobWarning {
  /** The operation, for an operation's own warnings and the job's notes about one. */
  readonly op?: string;
  readonly code: string;
  readonly message: string;
}

export interface Job {
  readonly toolpath: Toolpath;
  /** The operations in the job's order. */
  readonly operations: readonly JobSpan[];
  /** Tool ids in the order of their tool changes (a tool can come back when not grouped). */
  readonly toolChanges: readonly string[];
  /** The operations' warnings, tagged with their ids, then the job's own. */
  readonly warnings: readonly JobWarning[];
  /** The whole program's statistics, when `rapidRate` was given. */
  readonly stats?: ToolpathStats;
  /** The heights the job used, machine Z: clearance raised above the stock top when needed. */
  readonly clearance: number;
  readonly retract: number;
}

/** An operation that stops the job. */
export interface JobFailure {
  readonly op: string;
  readonly code: string;
  readonly message: string;
}

export interface JobError extends CamError {
  /** Every operation that failed; empty when the job itself is the problem. */
  readonly failures: readonly JobFailure[];
}

export type JobResult =
  { readonly ok: true; readonly value: Job } | { readonly ok: false; readonly error: JobError };

/** The machine Z of the stock's top: 0 with the origin on top, the stock height on the bottom. */
export function stockTopZ(setup: Pick<Setup, 'stock' | 'wcs'>): number {
  return setup.wcs.origin.z === 'top' ? 0 : setup.stock.max[2] - setup.stock.min[2];
}

/** A run of entries that starts with the tool at `start` and leaves it at `end`. */
export interface JobPiece {
  readonly start: Vec3;
  readonly entries: readonly IrEntry[];
  readonly end: Vec3;
}

function endOf(start: Vec3, entries: readonly IrEntry[]): Vec3 {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (isMove(e)) return e.to;
  }
  return start;
}

const piece = (tp: Toolpath): JobPiece => ({
  start: tp.start,
  entries: tp.entries,
  end: endOf(tp.start, tp.entries),
});

/**
 * An operation made only of canned-cycle groups joined by rapids (and comments), as the drill
 * operation writes straight and peck drilling: each group is a whole hole that starts and ends on
 * its R plane over the hole, so the holes are independent. Comments before the first group stay
 * in front; a comment between groups goes with the group after it. Undefined for anything else
 * (bores, any feed or spindle entry outside a group), which then keeps its own order.
 */
export function cyclePieces(
  tp: Toolpath,
): { readonly prefix: readonly IrEntry[]; readonly pieces: readonly Toolpath[] } | undefined {
  const prefix: IrEntry[] = [];
  const pieces: Toolpath[] = [];
  let pending: IrEntry[] = [];
  let open: { start: Vec3; entries: IrEntry[] } | undefined;
  for (const e of tp.entries) {
    if (open) {
      open.entries.push(e);
      if (e.kind === 'cycleEnd') {
        pieces.push({ start: open.start, entries: open.entries });
        open = undefined;
      }
      continue;
    }
    if (e.kind === 'cycle') {
      const d = e.drill;
      open = { start: [d.at[0], d.at[1], d.retract], entries: [...pending, e] };
      pending = [];
    } else if (e.kind === 'comment') {
      (pieces.length === 0 ? prefix : pending).push(e);
    } else if (e.kind !== 'rapid') {
      return undefined;
    }
  }
  if (open || pieces.length < 2) return undefined;
  // Trailing comments: after the last piece.
  if (pending.length > 0) {
    const last = pieces[pieces.length - 1]!;
    pieces[pieces.length - 1] = { start: last.start, entries: [...last.entries, ...pending] };
  }
  return { prefix, pieces };
}

const dxy = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Total crossing distance in XY from `from` through the pieces in order. */
function tourLength(from: Vec3, pieces: readonly JobPiece[]): number {
  let total = 0;
  let cur = from;
  for (const p of pieces) {
    total += dxy(cur, p.start);
    cur = p.end;
  }
  return total;
}

/** Pieces up to this many get 2-opt improvement after the nearest-neighbour tour. */
export const JOB_TWO_OPT_LIMIT = 150;

/** The pieces nearest-neighbour first from `from`, ties to the earlier piece. */
function nearestFirst<P extends JobPiece>(from: Vec3, pieces: readonly P[]): P[] {
  const left = [...pieces];
  const out: P[] = [];
  let cur = from;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((p, i) => {
      const d = dxy(cur, p.start);
      if (d < bestD - 1e-9) {
        best = i;
        bestD = d;
      }
    });
    const [p] = left.splice(best, 1);
    out.push(p!);
    cur = p!.end;
  }
  return out;
}

/**
 * A short order for independent pieces, starting from `from`: the shortest of the given order,
 * its reverse and the nearest-neighbour tour, then improved by 2-opt (reversing runs of pieces
 * while that shortens the crossings) for up to `JOB_TWO_OPT_LIMIT` pieces. Never longer than the
 * given order, and the given order itself unless something is strictly shorter.
 */
export function orderPieces<P extends JobPiece>(from: Vec3, pieces: readonly P[]): P[] {
  const given = tourLength(from, pieces);
  let best = [...pieces];
  let bestLength = given;
  for (const candidate of [[...pieces].reverse(), nearestFirst(from, pieces)]) {
    const length = tourLength(from, candidate);
    if (length < bestLength - 1e-9) {
      best = candidate;
      bestLength = length;
    }
  }
  const n = best.length;
  if (n >= 3 && n <= JOB_TWO_OPT_LIMIT) {
    for (let round = 0, improved = true; improved && round < 20; round++) {
      improved = false;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const trial = [
            ...best.slice(0, i),
            ...best.slice(i, j + 1).reverse(),
            ...best.slice(j + 1),
          ];
          const length = tourLength(from, trial);
          if (length < bestLength - 1e-9) {
            best = trial;
            bestLength = length;
            improved = true;
          }
        }
      }
    }
  }
  return bestLength < given - 1e-9 ? best : [...pieces];
}

/**
 * Stable grouping by tool: tools in order of first use, each tool's operations in order. An
 * operation that must run after another (`before`) and that grouping would move ahead of it is
 * taken out of its group and cut right after that operation instead (one more tool change).
 */
function groupByTool(ops: readonly JobOperation[]): JobOperation[] {
  const groups = new Map<string, JobOperation[]>();
  for (const op of ops) {
    const g = groups.get(op.tool.id);
    if (g) g.push(op);
    else groups.set(op.tool.id, [op]);
  }
  const grouped = [...groups.values()].flat();
  const at = new Map(grouped.map((o, i) => [o.id, i]));
  // Operations grouping moved ahead of the one they must follow, by that one's id.
  const moved = new Map<string, JobOperation>();
  for (const op of grouped) {
    const next = op.before !== undefined ? at.get(op.before) : undefined;
    if (next !== undefined && next < at.get(op.id)!) moved.set(op.id, grouped[next]!);
  }
  if (moved.size === 0) return grouped;
  const held = new Set([...moved.values()].map((o) => o.id));
  const out: JobOperation[] = [];
  const place = (op: JobOperation): void => {
    out.push(op);
    const next = moved.get(op.id);
    if (next) place(next);
  };
  for (const op of grouped) if (!held.has(op.id)) place(op);
  return out;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Assembles a setup's operations into one program. Fails, naming every operation, when any
 * operation that is not suppressed has an error, has no spindle speed, or starts below the stock
 * top; fails when nothing is left to cut.
 */
export function assembleJob(
  setup: JobSetup,
  operations: readonly JobOperation[],
  options: JobOptions = {},
): JobResult {
  const fail = (message: string, failures: JobFailure[] = []): JobResult => ({
    ok: false,
    error: { code: 'invalid-input', message, failures },
  });
  const { heights } = setup;
  if (![heights.clearance, heights.retract].every(Number.isFinite)) {
    return fail('The clearance and retract heights must be finite.');
  }
  const dwell = options.spindleDwell ?? JOB_SPINDLE_DWELL.value;
  if (!(Number.isFinite(dwell) && dwell >= 0)) {
    return fail('The spindle dwell must be zero or more seconds.');
  }
  if (options.start && !options.start.every(Number.isFinite)) {
    return fail('The start position must be finite.');
  }
  const top = stockTopZ(setup);
  const safeZ = top + JOB_SAFE_ABOVE;
  const clearance = Math.max(heights.clearance, heights.retract, safeZ);
  // Within an operation: the retract height where it is above the stock top, else the clearance.
  const retract = heights.retract >= safeZ - EPS ? heights.retract : clearance;
  const warnings: JobWarning[] = [];
  if (heights.clearance < safeZ - EPS) {
    warnings.push({
      code: 'clearance-raised',
      message: `The clearance height ${heights.clearance} mm is not ${JOB_SAFE_ABOVE} mm above the stock top (${top} mm); the job crosses at ${clearance} mm.`,
    });
  }

  // Which operations run, and whether any of them fails.
  const active = operations.filter((op) => op.suppressed !== true);
  const failures: JobFailure[] = [];
  for (const op of active) {
    if (!op.result.ok) {
      failures.push({ op: op.id, code: op.result.error.code, message: op.result.error.message });
    } else if (!positive(op.feeds.spindle)) {
      failures.push({
        op: op.id,
        code: 'invalid-input',
        message: `${op.id}: the spindle speed must be greater than zero.`,
      });
    }
  }
  if (failures.length > 0) {
    const names = failures.map((f) => f.op).join(', ');
    return fail(
      `${failures.length === 1 ? 'An operation has' : `${failures.length} operations have`} an error (${names}); fix or suppress ${failures.length === 1 ? 'it' : 'them'} first.`,
      failures,
    );
  }

  const ordered = options.groupByTool ? groupByTool(active) : [...active];
  const reorder = options.reorder ?? true;
  const entries: IrEntry[] = [];
  const start: Vec3 = options.start ?? [0, 0, clearance];
  let cur: Vec3 = start;
  let tool: string | undefined;
  let rpm: number | undefined;
  const spans: JobSpan[] = [];
  const toolChanges: string[] = [];

  const rapid = (to: Vec3): void => {
    if (dxy(cur, to) <= EPS && Math.abs(cur[2] - to[2]) <= EPS) return;
    const move: RapidMove = { kind: 'rapid', to, op: JOB_LINK_OP, pass: 0 };
    entries.push(move);
    cur = to;
  };
  /** Straight up to `z` where the tool is, when below it. */
  const rise = (z: number): void => {
    if (cur[2] < z - EPS) rapid([cur[0], cur[1], z]);
  };
  /** Up to at least `z`, across, down to `to`. */
  const link = (to: Vec3, z: number): void => {
    if (dxy(cur, to) <= EPS) {
      // Straight up or down over the same point (a start is never below `safeZ`).
      rapid(to);
      return;
    }
    const travel = Math.max(z, cur[2], to[2]);
    rise(travel);
    rapid([to[0], to[1], travel]);
    rapid(to);
  };

  for (const op of ordered) {
    const result = op.result;
    if (!result.ok) continue; // checked above
    const own: Toolpath[] = result.pieces ? [...result.pieces] : [];
    let prefix: readonly IrEntry[] = [];
    if (!result.pieces) {
      const cycles = cyclePieces(result.toolpath);
      if (cycles) {
        prefix = cycles.prefix;
        for (const c of cycles.pieces) own.push(c);
      } else {
        own.push(result.toolpath);
      }
    }
    for (const w of result.warnings ?? []) warnings.push({ op: op.id, ...w });
    let pieces = own.map(piece).filter((p) => p.entries.some(isMove));
    if (pieces.length === 0) {
      warnings.push({
        op: op.id,
        code: 'empty-operation',
        message: `${op.id} has no moves; it is left out.`,
      });
      continue;
    }
    const low = pieces.find((p) => p.start[2] < safeZ - EPS || !p.start.every(Number.isFinite));
    if (low) {
      return fail(
        `${op.id} starts at Z ${low.start[2]} mm, not above the stock top (${top} mm): the job will not rapid down to it.`,
        [{ op: op.id, code: 'invalid-input', message: `${op.id} starts below the stock top.` }],
      );
    }

    // Tool change and spindle, at the clearance height.
    const rpmWanted = op.feeds.spindle;
    if (tool !== op.tool.id || rpm !== rpmWanted) {
      rise(clearance);
      if (tool !== op.tool.id) {
        if (rpm !== undefined) entries.push({ kind: 'spindle', state: 'off', op: op.id });
        entries.push({
          kind: 'toolChange',
          tool: op.tool.id,
          ...(op.tool.number !== undefined ? { number: op.tool.number } : {}),
          name: op.tool.name,
          diameter: op.tool.diameter,
          op: op.id,
        });
        toolChanges.push(op.tool.id);
        tool = op.tool.id;
      }
      entries.push({ kind: 'spindle', state: 'cw', rpm: rpmWanted, op: op.id });
      if (dwell > 0) entries.push({ kind: 'dwell', seconds: dwell, op: op.id });
      rpm = rpmWanted;
    }

    const from = entries.length;
    if (op.name) entries.push({ kind: 'comment', text: op.name, op: op.id });
    // Plain loops, not `push(...)`: spreading a large array overflows the call stack.
    for (const e of prefix) entries.push(e);
    if (reorder && pieces.length > 1) {
      // Order from where the tool will be over the first piece's area: here.
      pieces = orderPieces(cur, pieces);
    }
    pieces.forEach((p, k) => {
      // Between operations at the clearance; between pieces of one at the retract height.
      link(p.start, k === 0 ? clearance : retract);
      for (const e of p.entries) entries.push(e);
      cur = p.end;
    });
    spans.push({ op: op.id, tool: op.tool.id, from, to: entries.length });
  }

  if (spans.length === 0) return fail('Nothing to cut: every operation is suppressed or empty.');
  rise(clearance);
  if (rpm !== undefined) entries.push({ kind: 'spindle', state: 'off', op: spans.at(-1)!.op });

  const toolpath: Toolpath = { start, entries };
  const issues = validateToolpath(toolpath);
  if (issues.length > 0) {
    const first = issues[0]!;
    return fail(
      `The assembled job is invalid at entry ${first.index}${first.op ? ` (${first.op})` : ''}: ${first.message}`,
      first.op && first.op !== JOB_LINK_OP
        ? [{ op: first.op, code: 'invalid-toolpath', message: first.message }]
        : [],
    );
  }
  let stats: ToolpathStats | undefined;
  if (options.rapidRate !== undefined) {
    const s = toolpathStats(toolpath, { rapidRate: options.rapidRate });
    if (!s.ok) return fail(s.error.message);
    stats = s.value;
  }
  return {
    ok: true,
    value: {
      toolpath,
      operations: spans,
      toolChanges,
      warnings,
      ...(stats ? { stats } : {}),
      clearance,
      retract,
    },
  };
}

/**
 * The job's operations from a setup and the CAM worker's results for it (`generate`): every
 * operation of the setup, in its order, with its result unpacked. An operation with no result (not
 * generated yet) is an error of the job; `suppressed` names operations to leave out.
 */
export function jobOperations(
  setup: Pick<Setup, 'operations'>,
  results: readonly CamOperationResult[],
  suppressed: Iterable<string> = [],
): JobOperation[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const skip = new Set(suppressed);
  return setup.operations.map((op): JobOperation => {
    const r = byId.get(op.id);
    const result: JobOperationOutcome = !r
      ? { ok: false, error: { code: 'not-generated', message: `${op.id} has not been generated.` } }
      : r.ok
        ? { ok: true, toolpath: unpackToolpath(r.toolpath), warnings: r.warnings }
        : { ok: false, error: r.error };
    return {
      id: op.id,
      name: op.name,
      tool: op.tool,
      feeds: op.feeds,
      ...(skip.has(op.id) ? { suppressed: true } : {}),
      ...(op.kind === 'vcarveClearing' ? { before: op.carve.id } : {}),
      result,
    };
  });
}
