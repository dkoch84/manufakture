// The IR validator (M5 plan, T5.1c; ADR 0014 decisions 10 and 12). Operations and linking run it
// in tests, and the post runs it before writing anything: an IR that fails it is a bug in the
// code that produced it, never something to write out.

import { radiusAbout } from './arc';
import type { DrillCycle, IrEntry, Toolpath } from './ir';
import type { Vec2, Vec3 } from './types';
import { isFiniteVec } from './vec';

export type IrIssueCode =
  /** A coordinate, centre, feed or rpm that is NaN or infinite. */
  | 'non-finite'
  /** A move whose `op` is empty or whose `pass` is not a whole number of at least zero. */
  | 'bad-tag'
  /** A feed move with a feed of zero or less. */
  | 'zero-feed'
  /** A feed move while the spindle is off (it starts off). */
  | 'spindle-off'
  /** A feed move before any tool change: no tool is known. */
  | 'no-tool'
  /** A spindle start with an rpm of zero or less. */
  | 'spindle-rpm'
  /** A spindle entry whose state is not `cw`, `ccw` or `off`. */
  | 'spindle-state'
  /** A tool change while the spindle runs. */
  | 'tool-change-spindle-on'
  /** A dwell of less than zero seconds. */
  | 'dwell'
  /** An arc whose start lies on its centre. */
  | 'arc-zero-radius'
  /** An arc whose start and end radii differ by more than the tolerance. */
  | 'arc-radius'
  /** An arc whose start and end coincide in XY without `fullCircle`: Grbl would cut a full turn. */
  | 'arc-degenerate'
  /** A `fullCircle` arc whose end is not back at its start in XY. */
  | 'arc-full-circle-open'
  /** A `cycle` inside another, a `cycleEnd` with no open `cycle`, or a `cycle` never closed. */
  | 'cycle-pairing'
  /** A cycle whose numbers do not make a hole: bottom not below top, top above retract, ... */
  | 'cycle-invalid'
  /** Inside a cycle: an entry other than a rapid, a straight feed or a dwell, or a move off `at`. */
  | 'cycle-content'
  /** A cycle whose group does not start or end at its `at` on its `retract` plane. */
  | 'cycle-position';

export interface IrIssue {
  readonly code: IrIssueCode;
  /** Index into `toolpath.entries`. */
  readonly index: number;
  /** The entry's operation id, when it has one. */
  readonly op?: string;
  readonly message: string;
}

/**
 * Default tolerance, mm, for arc consistency: start and end radius, and start equal to end. A
 * tenth of Grbl's 0.005 mm radius check (error 33); arcs from the refit (ADR 0014 decision 12)
 * have their ends projected onto the exact circle, so they agree to far better than this.
 */
export const DEFAULT_ARC_TOLERANCE = 0.0005;

export interface ValidateOptions {
  readonly arcTolerance?: number;
}

/** Every problem in the toolpath, in entry order; an empty list means it is valid. */
export function validateToolpath(
  toolpath: Toolpath,
  options: ValidateOptions = {},
): readonly IrIssue[] {
  const tol = options.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
  const issues: IrIssue[] = [];
  let spindleOn = false;
  let tool: string | undefined;
  let pos = toolpath.start;
  /** The open canned cycle, if any, and its marker's index. */
  let cycle: { drill: DrillCycle; index: number; sound: boolean } | undefined;
  if (!isFiniteVec(toolpath.start)) {
    issues.push({ code: 'non-finite', index: -1, message: 'The start position is not finite.' });
  }

  toolpath.entries.forEach((e: IrEntry, index) => {
    const report = (code: IrIssueCode, message: string): void => {
      issues.push({ code, index, message, ...(e.op !== undefined ? { op: e.op } : {}) });
    };
    const inside = ['rapid', 'linear', 'dwell', 'cycle', 'cycleEnd'];
    if (cycle && !inside.includes(e.kind)) {
      report('cycle-content', `A ${e.kind} entry inside a canned cycle.`);
    }
    switch (e.kind) {
      case 'rapid':
      case 'linear':
      case 'arc': {
        if (!e.op || !Number.isInteger(e.pass) || e.pass < 0) {
          report('bad-tag', 'A move needs an operation id and a whole pass number of 0 or more.');
        }
        if (!isFiniteVec(e.to)) {
          report('non-finite', 'The move target is not finite.');
          return; // the position is unknown from here; keep the last good one
        }
        if (cycle?.sound && e.kind !== 'arc' && !sameXY(e.to, cycle.drill.at, tol)) {
          report('cycle-content', 'A move inside a canned cycle leaves the hole centre.');
        }
        if (e.kind !== 'rapid') {
          if (!Number.isFinite(e.feed)) report('non-finite', 'The feed is not finite.');
          else if (e.feed <= 0)
            report('zero-feed', `A ${e.feedClass} move has a feed of ${e.feed}.`);
          if (tool === undefined) report('no-tool', 'A feed move comes before any tool change.');
          if (!spindleOn) report('spindle-off', 'A feed move runs with the spindle off.');
        }
        if (e.kind === 'arc') checkArc(e, pos, tol, report);
        pos = e.to;
        return;
      }
      case 'spindle': {
        const state: string = e.state;
        if (state !== 'cw' && state !== 'ccw' && state !== 'off') {
          report('spindle-state', `Unknown spindle state '${state}'.`);
        } else if (e.state === 'off') {
          spindleOn = false;
        } else if (!Number.isFinite(e.rpm)) {
          report('non-finite', 'The spindle speed is not finite.');
        } else if (e.rpm <= 0) {
          report('spindle-rpm', `The spindle starts at ${e.rpm} rpm.`);
        } else {
          spindleOn = true;
        }
        return;
      }
      case 'toolChange':
        if (spindleOn)
          report('tool-change-spindle-on', `Tool change to ${e.tool} with the spindle on.`);
        tool = e.tool;
        return;
      case 'dwell':
        if (e.pass !== undefined && !(Number.isInteger(e.pass) && e.pass >= 0)) {
          report('bad-tag', 'A dwell pass must be a whole number of 0 or more.');
        }
        if (!Number.isFinite(e.seconds)) report('non-finite', 'The dwell time is not finite.');
        else if (e.seconds < 0) report('dwell', `A dwell of ${e.seconds} s.`);
        return;
      case 'comment':
        return;
      case 'cycle': {
        if (cycle) {
          report(
            'cycle-pairing',
            `A canned cycle opens inside the one opened at entry ${cycle.index}.`,
          );
        }
        const problem = cycleProblem(e.drill);
        if (problem) report(problem.code, problem.message);
        else if (!sameXY(pos, e.drill.at, tol) || Math.abs(pos[2] - e.drill.retract) > tol) {
          report(
            'cycle-position',
            'A canned cycle starts away from its hole centre on its retract plane.',
          );
        }
        cycle = { drill: e.drill, index, sound: problem === undefined };
        return;
      }
      case 'cycleEnd':
        if (!cycle) {
          report('cycle-pairing', 'A canned cycle end with no cycle open.');
          return;
        }
        if (
          cycle.sound &&
          (!sameXY(pos, cycle.drill.at, tol) || Math.abs(pos[2] - cycle.drill.retract) > tol)
        ) {
          report(
            'cycle-position',
            'A canned cycle ends away from its hole centre on its retract plane.',
          );
        }
        cycle = undefined;
        return;
    }
  });
  if (cycle) {
    const at = toolpath.entries[cycle.index]!;
    issues.push({
      code: 'cycle-pairing',
      index: cycle.index,
      message: 'A canned cycle is never closed.',
      ...(at.op !== undefined ? { op: at.op } : {}),
    });
  }
  return issues;
}

const sameXY = (p: Vec2 | Vec3, q: Vec2, tol: number): boolean =>
  Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;

/** What is wrong with a cycle's numbers, if anything. */
function cycleProblem(d: DrillCycle): { code: IrIssueCode; message: string } | undefined {
  const values = [d.top, d.bottom, d.retract, d.peck ?? 1, d.dwell ?? 0];
  if (!isFiniteVec(d.at) || !values.every(Number.isFinite)) {
    return { code: 'non-finite', message: 'A canned cycle has a number that is not finite.' };
  }
  if (!(d.bottom < d.top)) {
    return {
      code: 'cycle-invalid',
      message: `A canned cycle's bottom ${d.bottom} is not below its top ${d.top}.`,
    };
  }
  if (d.top > d.retract) {
    return {
      code: 'cycle-invalid',
      message: `A canned cycle's top ${d.top} is above its retract plane ${d.retract}.`,
    };
  }
  if (d.peck !== undefined && !(d.peck > 0)) {
    return { code: 'cycle-invalid', message: `A canned cycle has a peck of ${d.peck} mm.` };
  }
  if (d.dwell !== undefined && !(d.dwell > 0)) {
    return { code: 'cycle-invalid', message: `A canned cycle has a dwell of ${d.dwell} s.` };
  }
  return undefined;
}

function checkArc(
  arc: Extract<IrEntry, { kind: 'arc' }>,
  from: readonly [number, number, number],
  tol: number,
  report: (code: IrIssueCode, message: string) => void,
): void {
  if (!isFiniteVec(arc.center)) {
    report('non-finite', 'The arc centre is not finite.');
    return;
  }
  const r0 = radiusAbout(arc.center, from);
  const r1 = radiusAbout(arc.center, arc.to);
  if (r0 <= tol) {
    report('arc-zero-radius', 'The arc starts on its centre.');
    return;
  }
  if (Math.abs(r1 - r0) > tol) {
    report(
      'arc-radius',
      `The arc's end radius ${r1} differs from its start radius ${r0} by more than ${tol} mm.`,
    );
  }
  const chord = Math.hypot(arc.to[0] - from[0], arc.to[1] - from[1]);
  if (arc.fullCircle && chord > tol) {
    report('arc-full-circle-open', 'A full-circle arc does not end where it starts.');
  } else if (!arc.fullCircle && chord <= tol) {
    report(
      'arc-degenerate',
      'An arc ends where it starts but is not marked as a full circle; a controller would cut a full turn.',
    );
  }
}
