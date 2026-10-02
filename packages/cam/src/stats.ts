// IR statistics and bounds (M5 plan, T5.1c). Lengths in mm, times in minutes (the internal time
// unit, `@manufakture/units`). Times are estimates: every move runs at its programmed feed or the
// rapid rate from its first instant, with no acceleration, so a real machine takes longer.

import { arcBounds, arcLength } from './arc';
import type { Arc3 } from './arc';
import { FEED_CLASSES } from './ir';
import type { FeedClass, Toolpath } from './ir';
import { err, ok } from './types';
import type { Box3, CamResult, Vec3 } from './types';

export interface ToolpathStats {
  /** Length of every feed move (linear and arc, any feed class), mm. */
  readonly cutLength: number;
  /** Feed move length per feed class, mm. */
  readonly lengthByClass: Readonly<Record<FeedClass, number>>;
  /** Length of rapid moves, mm (straight lines, as Grbl moves). */
  readonly rapidLength: number;
  readonly moveCount: number;
  readonly toolChanges: number;
  /**
   * An ESTIMATE of the run time, minutes: feed moves at their feed, rapids at the rapid rate,
   * dwells as written, no acceleration, no tool change or spindle spin-up time. A feed of zero
   * gives Infinity; run `validateToolpath` first.
   */
  readonly estimate: {
    readonly feedMinutes: number;
    readonly rapidMinutes: number;
    readonly dwellMinutes: number;
    readonly totalMinutes: number;
  };
}

export interface StatsOptions {
  /** The machine's rapid rate, mm/min, greater than zero (the machine table's, T5.1d). */
  readonly rapidRate: number;
}

export function toolpathStats(toolpath: Toolpath, options: StatsOptions): CamResult<ToolpathStats> {
  if (!(options.rapidRate > 0) || !Number.isFinite(options.rapidRate)) {
    return err('invalid-input', 'The rapid rate must be greater than zero.');
  }
  const lengthByClass = Object.fromEntries(FEED_CLASSES.map((c) => [c, 0])) as Record<
    FeedClass,
    number
  >;
  let rapidLength = 0;
  let feedMinutes = 0;
  let dwellSeconds = 0;
  let moveCount = 0;
  let toolChanges = 0;
  let pos = toolpath.start;
  for (const e of toolpath.entries) {
    switch (e.kind) {
      case 'rapid':
        rapidLength += distance(pos, e.to);
        pos = e.to;
        moveCount++;
        break;
      case 'linear':
      case 'arc': {
        const len = e.kind === 'linear' ? distance(pos, e.to) : arcLength(arcFrom(pos, e));
        lengthByClass[e.feedClass] += len;
        feedMinutes += len / e.feed;
        pos = e.to;
        moveCount++;
        break;
      }
      case 'dwell':
        dwellSeconds += e.seconds;
        break;
      case 'toolChange':
        toolChanges++;
        break;
      case 'spindle':
      case 'comment':
      case 'cycle':
      case 'cycleEnd':
        break;
    }
  }
  const cutLength = FEED_CLASSES.reduce((sum, c) => sum + lengthByClass[c], 0);
  const rapidMinutes = rapidLength / options.rapidRate;
  const dwellMinutes = dwellSeconds / 60;
  return ok({
    cutLength,
    lengthByClass,
    rapidLength,
    moveCount,
    toolChanges,
    estimate: {
      feedMinutes,
      rapidMinutes,
      dwellMinutes,
      totalMinutes: feedMinutes + rapidMinutes + dwellMinutes,
    },
  });
}

export interface ToolpathBounds {
  /** Every position the tool centre passes, rapids and the start position included. */
  readonly all: Box3;
  /** Feed moves only (what can touch material); undefined when there are none. */
  readonly feed: Box3 | undefined;
}

/**
 * Bounds of the tool's control point (the tip centre), with arcs' true extremes (helices
 * included), not just their end points. Add the tool's radius for the swept outline.
 */
export function toolpathBounds(toolpath: Toolpath): ToolpathBounds {
  const all = new BoxBuilder();
  const feed = new BoxBuilder();
  let pos = toolpath.start;
  all.add(pos);
  for (const e of toolpath.entries) {
    if (e.kind === 'rapid') {
      all.add(e.to);
      pos = e.to;
    } else if (e.kind === 'linear') {
      feed.add(pos);
      feed.add(e.to);
      all.add(e.to);
      pos = e.to;
    } else if (e.kind === 'arc') {
      const box = arcBounds(arcFrom(pos, e));
      feed.addBox(box);
      all.addBox(box);
      pos = e.to;
    }
  }
  return { all: all.box()!, feed: feed.box() };
}

/** The arc an IR arc move describes from position `from`. */
export function arcFrom(
  from: Vec3,
  move: { to: Vec3; center: Arc3['center']; direction: Arc3['direction']; fullCircle: boolean },
): Arc3 {
  return {
    start: from,
    end: move.to,
    center: move.center,
    direction: move.direction,
    fullCircle: move.fullCircle,
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

class BoxBuilder {
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];
  private empty = true;

  add(p: Vec3): void {
    this.empty = false;
    for (let i = 0; i < 3; i++) {
      this.min[i] = Math.min(this.min[i]!, p[i]!);
      this.max[i] = Math.max(this.max[i]!, p[i]!);
    }
  }

  addBox(b: Box3): void {
    this.add(b.min);
    this.add(b.max);
  }

  box(): Box3 | undefined {
    if (this.empty) return undefined;
    return {
      min: [this.min[0]!, this.min[1]!, this.min[2]!],
      max: [this.max[0]!, this.max[1]!, this.max[2]!],
    };
  }
}
