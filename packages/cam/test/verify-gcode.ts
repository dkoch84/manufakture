// The G-code verifier (M5 plan, T5.4d): reads a finished G-code file with `gcode-toolpath`
// (cncjs, MIT, a development dependency), a parser we did not write, and checks it against the
// dialect it was written for, the stock and the machine. A test utility: the post's own tests and
// the golden runner use it; nothing in `src/` imports it.
//
// What it checks, line by line:
//
// - the text: line length (the dialect's `maxLineLength`), printable ASCII only, none of Grbl's
//   real-time characters (`?`, `!`, `~`), parenthesised comments only, unnested, and none a
//   controller would read as a command (`(MSG, ...)`);
// - the words: G and M codes in the dialect's lists, only the letters the engine writes (T only
//   where tool changes are `m6`), one of each letter a line, numbers of at most 8 digits;
// - tool changes in the dialect's style: `M6 T<n>` with the spindle off for `m6`, an `M0` with
//   the spindle off for `m0-pause`, neither (and no T word) for `none`;
// - spindle and feed: no feed move with the spindle off or at 0 rpm, every F positive, no feed
//   move before an F;
// - arcs: Grbl 1.1's radius rule and angular travel on the written words (`grblArcCheck`), and
//   no full circle where the dialect writes full circles as halves; and the dialect's own radius
//   rule (`arcRadiusTolerance`, Mach3) when it has one;
// - tool length offsets: `G43 H<n>` only in an `m6` file, after an `M6`, naming the tool in the
//   spindle; path blending: `G64` only with a P of at most the tolerance;
// - canned cycles (G81, G83, with G98 or G99; G80 cancels): expanded into the moves the
//   controller makes, as LinuxCNC documents them (preliminary motion to the R plane, pecks of Q
//   from R backing off 0.254 mm or 0.01 in, the retract), which are then checked like any move;
// - every move, arcs by their true extremes: inside the machine travel from the WCS origin (or,
//   with no origin given, spanning no more than the travel on any axis), never lower than the
//   stock bottom minus the through-cut allowance; and every feed move that reaches the stock top
//   or below inside the stock outline grown by the tool radius and the lead-in allowance.
//
// Positions are millimetres in the WCS (the file's coordinates; G20 files are converted by the
// parser). The verifier models only the G codes the engine writes (`MODELLED_G_CODES`); any other
// G code is reported as unsupported rather than passed unchecked, and a modelled code outside the
// dialect's list is only a `word` issue (its effect is not modelled for that file).

import Toolpath from 'gcode-toolpath';
import { arcBounds, arcSweep } from '../src/arc';
import { compileDialect, isCompiledDialect, normalizeCode } from '../src/post/dialect';
import type { CompiledDialect, Dialect, ToolChangeStyle } from '../src/post/dialect';
import { MAX_NUMBER_DIGITS, isCommentCommand } from '../src/post/format';
import { MM_PER_INCH } from '@manufakture/units';
import { grblArcCheck, grblRadiusAllowance } from '../src/post/grbl-arc';
import { err, ok } from '../src/types';
import type { Box3, CamResult, Tool, Vec2, Vec3 } from '../src/types';

/**
 * The machine data the verifier needs: the travel per axis, mm. A machine profile (T5.1d) can be
 * passed as it is, as long as it has `travel`.
 */
export interface VerifyMachine {
  readonly name?: string;
  /** Travel along X, Y and Z, mm, each positive. */
  readonly travel: Vec3;
}

/** A tool as the verifier needs it: its diameter, and its number for `M6 T<n>` dialects. */
export type VerifyTool = Pick<Tool, 'diameter'> & Partial<Pick<Tool, 'number' | 'name'>>;

export interface VerifyOptions {
  /** The dialect the file was written for, as a record or compiled. */
  readonly dialect: Dialect | CompiledDialect;
  /** The stock, a box in WCS coordinates, mm. */
  readonly stock: Box3;
  readonly machine: VerifyMachine;
  /**
   * The file's tools. For `m6` files they are matched by number; otherwise they are the tools in
   * the order the file uses them: the first until the first `M0` change, then the next.
   */
  readonly tools: readonly VerifyTool[];
  /**
   * Where the WCS origin sits inside the machine's travel, mm from the travel's lowest corner on
   * each axis (X left, Y front, Z lowest). With an origin every point is checked against
   * [0, travel]; without one, only the file's span on each axis is.
   */
  readonly origin?: Vec3;
  /** The tool change style the file was written with; the dialect's default when absent. */
  readonly toolChange?: ToolChangeStyle;
  /** The position before the first line, WCS mm; unknown when absent (axes become known as written). */
  readonly start?: Vec3;
  /** How far beyond the stock outline, past the tool radius, a feed move may go (leads), mm. Default 0. */
  readonly leadInAllowance?: number;
  /** How far below the stock bottom a cut may go (into the spoilboard), mm. Default 0. */
  readonly throughCutAllowance?: number;
  /** Slack on every bounds check for the output rounding, mm. Default 0.002. */
  readonly tolerance?: number;
}

export type GcodeIssueCode =
  /** A line over the dialect's `maxLineLength`. */
  | 'line-length'
  /** A character that is not printable ASCII, or a real-time command character. */
  | 'character'
  /** A comment that is malformed, of the wrong style, or readable as a controller command. */
  | 'comment'
  /** Text that is not a sequence of words. */
  | 'syntax'
  /** A G or M code outside the dialect's lists, a letter the engine never writes, a repeated letter. */
  | 'word'
  /** A number with more digits than a controller reads. */
  | 'number'
  /** A tool change not in the dialect's style, or a tool the options do not know. */
  | 'tool-change'
  /** A feed move with the spindle off or at 0 rpm. */
  | 'spindle'
  /** An F that is not positive, or a feed move before any F. */
  | 'feed'
  /** An arc failing Grbl's radius rule (error 33). */
  | 'arc-radius'
  /** An arc whose angular travel, as Grbl computes it, is not the arc's geometry. */
  | 'arc-travel'
  /** A full circle in a dialect that writes full circles as two halves. */
  | 'full-circle'
  /** An arc from an unknown position, or without I and J. */
  | 'arc'
  /** A move outside the machine travel. */
  | 'travel'
  /** A feed move outside the stock outline grown by the tool radius and the lead-in allowance. */
  | 'stock'
  /** A move below the stock bottom minus the through-cut allowance. */
  | 'depth'
  /** A canned cycle without its words (Z, R, Q for G83), from an unknown position, or a bad Q. */
  | 'cycle'
  /** A G64 without a P, or with a P over the tolerance. */
  | 'path'
  /** A G code the verifier does not model (G91, G92, G28, G53, G18, G93, ...). */
  | 'unsupported';

export interface GcodeIssue {
  /** Line number from 1. */
  readonly line: number;
  readonly code: GcodeIssueCode;
  readonly message: string;
}

export interface GcodeReport {
  /** True when there are no issues. */
  readonly ok: boolean;
  readonly issues: readonly GcodeIssue[];
  /** Lines in the file. */
  readonly lines: number;
  /** The box of every move (arcs by their true extremes), WCS mm; undefined until all axes are known. */
  readonly extents: Box3 | undefined;
  /** The box of the feed moves (G1, G2, G3). */
  readonly cuttingExtents: Box3 | undefined;
  /** Moves by kind. */
  readonly moves: { readonly rapid: number; readonly linear: number; readonly arc: number };
  /** Tool changes: `M6` lines for `m6`, `M0` pauses for `m0-pause`. */
  readonly toolChanges: number;
  /** The units the file selects (G21, G20), if any. */
  readonly units: 'mm' | 'inch' | undefined;
}

/**
 * The letters the engine writes besides G and M; T only where tool changes are `m6`, H only with
 * G43, R and Q only in a canned cycle.
 */
const LETTERS = new Set(['X', 'Y', 'Z', 'I', 'J', 'F', 'S', 'P']);

/** The canned cycles the verifier expands. */
const CYCLES: ReadonlySet<string> = new Set(['G81', 'G83']);

/** Characters Grbl and grblHAL act on wherever they appear in the stream, comments included. */
const REAL_TIME = /[?!~]/;

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * The G codes whose effect the verifier models: motion G0 to G3, dwell G4, the XY plane G17,
 * units G20 and G21, the default work offset G54, absolute distance G90, incremental arc centres
 * G91.1 (the IJK mode it assumes) and units per minute G94; tool length offsets G43 H and G49
 * (which leave the program's coordinates as they are), path control G61 and G64 P (a corner
 * rounded by at most P), and the canned cycles G81 and G83 with G80, G98 and G99. Any other G
 * code (G91, G92, G28,
 * G53, G18, G93, G38.2, ...) changes positions, planes or feeds in ways the checks do not follow,
 * so it is an `unsupported` issue. G92 is left out on purpose: the parser applies its offset to
 * the positions it reports, but the arc check reads the written words, which it would not shift.
 */
const MODELLED_G_CODES: ReadonlySet<string> = new Set([
  'G0',
  'G1',
  'G2',
  'G3',
  'G4',
  'G17',
  'G20',
  'G21',
  'G43',
  'G49',
  'G54',
  'G61',
  'G64',
  'G80',
  'G81',
  'G83',
  'G90',
  'G91.1',
  'G94',
  'G98',
  'G99',
]);

interface Word {
  readonly letter: string;
  readonly text: string;
  readonly value: number;
}

/** A move's least and greatest value on one axis. */
interface Range {
  readonly lo: number;
  readonly hi: number;
}

interface Segment {
  readonly motion: string;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly center?: Vec2;
}

/** A running box over per-axis values. */
class Extents {
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];

  add(axis: number, value: number): void {
    if (value < this.min[axis]!) this.min[axis] = value;
    if (value > this.max[axis]!) this.max[axis] = value;
  }

  box(): Box3 | undefined {
    if (this.min.some((v) => !Number.isFinite(v))) return undefined;
    return { min: [...this.min] as unknown as Vec3, max: [...this.max] as unknown as Vec3 };
  }
}

/**
 * Check a G-code file. Returns an error only for bad options (an invalid dialect, a travel or
 * stock that is not a box, no tools); everything wrong with the file is an issue in the report.
 */
export function verifyGcode(text: string, options: VerifyOptions): CamResult<GcodeReport> {
  let dialect: CompiledDialect;
  if (isCompiledDialect(options.dialect)) {
    dialect = options.dialect;
  } else {
    const compiled = compileDialect(options.dialect);
    if (!compiled.ok) return err(compiled.error.code, compiled.error.message);
    dialect = compiled.value;
  }
  const { stock, machine, tools } = options;
  const finite = (v: Vec3 | undefined): boolean => v === undefined || v.every(Number.isFinite);
  if (!machine.travel.every((t) => Number.isFinite(t) && t > 0)) {
    return err('invalid-input', 'The machine travel must be positive on every axis.');
  }
  if (!finite(stock.min) || !finite(stock.max) || stock.min.some((v, i) => v > stock.max[i]!)) {
    return err('invalid-input', 'The stock must be a box with min at most max.');
  }
  if (!finite(options.origin) || !finite(options.start)) {
    return err('invalid-input', 'The origin and start must be finite.');
  }
  if (tools.length === 0 || !tools.every((t) => Number.isFinite(t.diameter) && t.diameter >= 0)) {
    return err('invalid-input', 'At least one tool with a diameter is needed.');
  }
  const leadIn = options.leadInAllowance ?? 0;
  const throughCut = options.throughCutAllowance ?? 0;
  const tol = options.tolerance ?? 0.002;
  if (![leadIn, throughCut, tol].every((v) => Number.isFinite(v) && v >= 0)) {
    return err('invalid-input', 'The allowances and tolerance must be zero or more.');
  }
  const style = options.toolChange ?? dialect.dialect.toolChange;

  const issues: GcodeIssue[] = [];
  let lineNo = 0;
  const issue = (code: GcodeIssueCode, message: string): void => {
    issues.push({ line: lineNo, code, message });
  };

  // The parser we did not write: one line at a time, so every move it reports belongs to the
  // line just given to it. Its modal state (units, motion, spindle) carries across calls.
  const segments: Segment[] = [];
  const reader = new Toolpath({
    position: options.start
      ? { x: options.start[0], y: options.start[1], z: options.start[2] }
      : { x: 0, y: 0, z: 0 },
    addLine: (modal, start, end) =>
      segments.push({
        motion: modal.motion,
        start: [start.x, start.y, start.z],
        end: [end.x, end.y, end.z],
      }),
    addArcCurve: (modal, start, end, center) =>
      segments.push({
        motion: modal.motion,
        start: [start.x, start.y, start.z],
        end: [end.x, end.y, end.z],
        center: [center.x, center.y],
      }),
  });

  // State from our own reading of the words, which the parser does not keep.
  const known = [
    options.start !== undefined,
    options.start !== undefined,
    options.start !== undefined,
  ];
  const lastWord: Record<'X' | 'Y', string | undefined> = { X: undefined, Y: undefined };
  let motion: string | undefined;
  let inches = false;
  let units: GcodeReport['units'];
  let feed: number | undefined;
  let rpm = 0;
  let spindleOn = false;
  let toolIndex = 0;
  let activeTool: VerifyTool | undefined = style === 'm6' ? undefined : tools[0];
  let toolChanges = 0;
  /** The position after the last move, WCS mm, per axis; undefined while unknown. */
  const cur: (number | undefined)[] = options.start ? [...options.start] : [];
  /** Canned cycles: the return mode, the sticky words (file units), the Z the series began at. */
  let returnMode: 'G98' | 'G99' | undefined;
  const sticky: Partial<Record<'Z' | 'R' | 'Q', number>> = {};
  let initialZ: number | undefined;
  const arcLimit = dialect.dialect.arcRadiusTolerance;
  const moves = { rapid: 0, linear: 0, arc: 0 };
  const all = new Extents();
  const cutting = new Extents();
  const spanReported = [false, false, false];

  const lines = text.split('\n');
  // A file ending in a newline has no line after it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const [n, raw] of lines.entries()) {
    lineNo = n + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > dialect.dialect.maxLineLength) {
      issue(
        'line-length',
        `${line.length} characters, over the dialect's ${dialect.dialect.maxLineLength}.`,
      );
    }
    if (/[^\x20-\x7e]/.test(line)) issue('character', 'A character that is not printable ASCII.');
    if (REAL_TIME.test(line)) issue('character', 'A real-time command character (?, ! or ~).');
    if (line.trim() === '%') {
      if (!dialect.dialect.programDelimiter) issue('syntax', 'A % line in a dialect without one.');
      continue;
    }

    // Comments out, words in.
    const code = stripComments(line, issue);
    const words = readWords(code, issue);
    if (words === undefined) continue;

    const letters = new Map<string, Word>();
    const gCodes: string[] = [];
    const mCodes: string[] = [];
    for (const w of words) {
      if (w.letter === 'G' || w.letter === 'M') {
        const c = normalizeCode(`${w.letter}${w.text}`, w.letter);
        const list = w.letter === 'G' ? dialect.gCodes : dialect.mCodes;
        if (c === undefined || !list.has(c)) {
          issue('word', `${w.letter}${w.text} is not in the dialect's ${w.letter} codes.`);
        }
        if (c !== undefined) (w.letter === 'G' ? gCodes : mCodes).push(c);
        continue;
      }
      const contextual = w.letter === 'H' || w.letter === 'R' || w.letter === 'Q';
      if (!contextual && !LETTERS.has(w.letter) && !(w.letter === 'T' && style === 'm6')) {
        issue('word', `The ${w.letter} word is not one this dialect's files use.`);
      }
      if (letters.has(w.letter)) issue('word', `Two ${w.letter} words on one line.`);
      letters.set(w.letter, w);
    }
    /** This line's G codes that the dialect has, whose effect is modelled. */
    const has = (g: string): boolean => gCodes.includes(g) && dialect.gCodes.has(g);
    for (const w of words) {
      const digits = w.text.replace(/[^0-9]/g, '').replace(/^0+/, '');
      if (digits.length > MAX_NUMBER_DIGITS) {
        issue('number', `${w.letter}${w.text} has more than ${MAX_NUMBER_DIGITS} digits.`);
      }
    }

    // Modal state. A G code the dialect accepts but the verifier does not model is reported,
    // never silently passed (one outside the dialect is already a `word` issue).
    const wasCycle = motion !== undefined && CYCLES.has(motion);
    for (const g of gCodes) {
      if (g === 'G0' || g === 'G1' || g === 'G2' || g === 'G3') motion = g;
      if (g === 'G20') [inches, units] = [true, 'inch'];
      if (g === 'G21') [inches, units] = [false, 'mm'];
      if (dialect.gCodes.has(g)) {
        if (g === 'G80') motion = 'G80';
        if (CYCLES.has(g)) motion = g;
        if (g === 'G98' || g === 'G99') returnMode = g;
      }
      if (dialect.gCodes.has(g) && !MODELLED_G_CODES.has(g)) {
        issue('unsupported', `${g} is not modelled by the verifier, so the file is not verified.`);
      }
    }
    const inCycle = motion !== undefined && CYCLES.has(motion);
    // H, R and Q only where they mean something.
    for (const [letter, ok, where] of [
      ['H', has('G43'), 'with G43'],
      ['R', inCycle, 'in a canned cycle'],
      ['Q', inCycle && motion === 'G83', 'in a G83 cycle'],
    ] as const) {
      if (letters.has(letter) && !ok) {
        issue('word', `The ${letter} word is not one this dialect's files use, except ${where}.`);
      }
    }
    const k = inches ? MM_PER_INCH : 1;
    if (has('G64')) {
      const p = letters.get('P');
      if (p === undefined) {
        issue('path', 'A G64 without P blends corners with no bound on the path error.');
      } else if (!(p.value > 0) || p.value * k > tol + 1e-9) {
        issue('path', `G64 P${p.text} is not greater than 0 and at most ${fmt(tol)} mm.`);
      }
    }
    const f = letters.get('F');
    if (f) {
      if (!(f.value > 0)) issue('feed', `F${f.text} is not a positive feed.`);
      else feed = f.value;
    }
    const s = letters.get('S');
    if (s) rpm = s.value;

    // Tool changes, before this line's spindle words take effect.
    const t = letters.get('T');
    if (mCodes.includes('M6')) {
      if (style !== 'm6') {
        issue('tool-change', `An M6 in a file whose tool changes are '${style}'.`);
      } else {
        toolChanges++;
        if (spindleOn) issue('tool-change', 'An M6 with the spindle on.');
        if (t === undefined) issue('tool-change', 'An M6 without a T word.');
        else {
          if (!Number.isInteger(t.value) || t.value < 0 || t.value > dialect.maxToolNumber) {
            issue(
              'tool-change',
              `T${t.text} is not a tool number from 0 to ${dialect.maxToolNumber}.`,
            );
          }
          activeTool = tools.find((x) => x.number === t.value);
          if (activeTool === undefined) issue('tool-change', `Tool ${t.text} is not in the job.`);
        }
      }
    } else if (t !== undefined && style !== 'm6') {
      issue('tool-change', `A T word in a file whose tool changes are '${style}'.`);
    }
    if (mCodes.includes('M0')) {
      if (style === 'none') {
        issue('tool-change', "An M0 pause in a file whose tool changes are 'none' (one tool).");
      } else if (style === 'm0-pause') {
        toolChanges++;
        if (spindleOn) issue('tool-change', 'An M0 tool change with the spindle on.');
        toolIndex++;
        activeTool = tools[toolIndex];
        if (activeTool === undefined) {
          issue('tool-change', `Tool change ${toolIndex} has no tool in the options.`);
        }
      }
    }
    if (has('G43')) {
      const h = letters.get('H');
      if (style !== 'm6') {
        issue(
          'tool-change',
          `A G43 tool length offset in a file whose tool changes are '${style}'.`,
        );
      } else if (h === undefined) {
        issue('tool-change', 'A G43 without an H word.');
      } else if (activeTool === undefined || activeTool.number !== h.value) {
        issue('tool-change', `G43 H${h.text} is not the tool the last M6 loaded.`);
      }
    }
    if (mCodes.includes('M3') || mCodes.includes('M4')) spindleOn = true;
    // M2 and M30 end the program, which stops the spindle (Grbl's `gc_execute_line`).
    if (mCodes.some((m) => m === 'M5' || m === 'M2' || m === 'M30')) spindleOn = false;

    // Arcs, on the written words, before the parser moves on.
    const knownBefore = [...known];
    const hasAxis = AXES.some((a) => letters.has(a));
    const isArc =
      (motion === 'G2' || motion === 'G3') && (hasAxis || letters.has('I') || letters.has('J'));
    if (isArc) {
      checkArc({
        letters,
        lastWord,
        knownXY: known[0]! && known[1]!,
        startXY: options.start ? [options.start[0], options.start[1]] : undefined,
        inches,
        direction: motion === 'G2' ? 'cw' : 'ccw',
        fullCirclesAsHalves: dialect.dialect.fullCircles === 'halves',
        ...(arcLimit !== undefined ? { limit: inches ? arcLimit.inch : arcLimit.mm } : {}),
        issue,
      });
    }
    for (const [i, a] of AXES.entries()) if (letters.has(a)) known[i] = true;
    if (letters.has('X')) lastWord.X = letters.get('X')!.text;
    if (letters.has('Y')) lastWord.Y = letters.get('Y')!.text;

    segments.length = 0;
    const hasCycleCode = gCodes.some((g) => CYCLES.has(g));
    if (motion === 'G80' && hasAxis && !gCodes.some((g) => /^G[0-3]$/.test(g))) {
      issue('word', 'Axis words with no motion mode: G80 cancelled it.');
    } else if (inCycle && (hasCycleCode || hasAxis)) {
      // A canned cycle: the parser does not know them, so it reads the moves the controller makes.
      if (hasCycleCode && !wasCycle) initialZ = cur[2];
      for (const a of ['Z', 'R', 'Q'] as const) {
        const w = letters.get(a);
        if (w) sticky[a] = w.value;
      }
      const expanded = expandCycle({
        code: motion!,
        letters,
        cur,
        k,
        sticky,
        returnMode,
        initialZ,
        issue,
      });
      if (expanded !== undefined) {
        known.fill(true);
        reader.loadFromStringSync(expanded.join('\n'));
      }
    } else {
      reader.loadFromStringSync(line);
    }

    for (const seg of segments) {
      const feedMove = seg.motion === 'G1' || seg.motion === 'G2' || seg.motion === 'G3';
      const arc = (seg.motion === 'G2' || seg.motion === 'G3') && seg.center !== undefined;
      if (seg.motion === 'G0') moves.rapid++;
      else if (seg.motion === 'G1') moves.linear++;
      else if (arc) moves.arc++;
      else continue;

      if (feedMove) {
        if (!spindleOn) issue('spindle', `A ${seg.motion} feed move with the spindle off.`);
        else if (!(rpm > 0)) issue('spindle', `A ${seg.motion} feed move at ${rpm} rpm.`);
        if (feed === undefined) issue('feed', `A ${seg.motion} feed move before any F.`);
      }

      // The move's range on each axis known at its ends; arcs by their true extremes.
      const ranges: (Range | undefined)[] = [undefined, undefined, undefined];
      const put = (axis: number, v: number): void => {
        const r = ranges[axis];
        ranges[axis] = r ? { lo: Math.min(r.lo, v), hi: Math.max(r.hi, v) } : { lo: v, hi: v };
      };
      if (arc && knownBefore[0] && knownBefore[1]) {
        const chord = Math.hypot(seg.end[0] - seg.start[0], seg.end[1] - seg.start[1]);
        const box = arcBounds({
          start: seg.start,
          end: seg.end,
          center: seg.center!,
          direction: seg.motion === 'G2' ? 'cw' : 'ccw',
          fullCircle: chord < 1e-9,
        });
        for (const axis of [0, 1]) {
          put(axis, box.min[axis]!);
          put(axis, box.max[axis]!);
        }
      } else {
        for (const axis of [0, 1]) {
          if (knownBefore[axis]) put(axis, seg.start[axis]!);
          if (known[axis]) put(axis, seg.end[axis]!);
        }
      }
      if (knownBefore[2]) put(2, seg.start[2]);
      if (known[2]) put(2, seg.end[2]);

      for (const [axis, range] of ranges.entries()) {
        if (!range) continue;
        all.add(axis, range.lo);
        all.add(axis, range.hi);
        if (feedMove) {
          cutting.add(axis, range.lo);
          cutting.add(axis, range.hi);
        }

        // Machine travel.
        const name = 'XYZ'[axis]!;
        const travel = machine.travel[axis]!;
        if (options.origin) {
          const mLo = options.origin[axis]! + range.lo;
          const mHi = options.origin[axis]! + range.hi;
          if (mLo < -tol || mHi > travel + tol) {
            issue(
              'travel',
              `${name} reaches ${fmt(mLo < -tol ? mLo : mHi)} mm of the machine's 0 to ${fmt(travel)} mm travel.`,
            );
          }
        } else {
          const span = all.max[axis]! - all.min[axis]!;
          if (!spanReported[axis] && span > travel + tol) {
            spanReported[axis] = true;
            issue(
              'travel',
              `The file spans ${fmt(span)} mm in ${name}, over the machine's ${fmt(travel)} mm travel.`,
            );
          }
        }
      }

      // Depth: nothing below the stock bottom minus the through-cut allowance.
      const z = ranges[2];
      if (z && z.lo < stock.min[2] - throughCut - tol) {
        issue(
          'depth',
          `Z ${fmt(z.lo)} is below the stock bottom ${fmt(stock.min[2])} minus the ${fmt(throughCut)} mm through-cut allowance.`,
        );
      }

      // The stock outline, for feed moves at or below the stock top.
      if (feedMove && (!z || z.lo <= stock.max[2] + tol)) {
        const r = (activeTool?.diameter ?? 0) / 2;
        const grow = r + leadIn + tol;
        for (const axis of [0, 1]) {
          const range = ranges[axis];
          if (!range) continue;
          const below = range.lo < stock.min[axis]! - grow;
          if (below || range.hi > stock.max[axis]! + grow) {
            issue(
              'stock',
              `${'XY'[axis]} ${fmt(below ? range.lo : range.hi)} is outside the stock ${fmt(stock.min[axis]!)} to ${fmt(stock.max[axis]!)} grown by the tool radius ${fmt(r)} and the lead-in allowance ${fmt(leadIn)}.`,
            );
          }
        }
      }
    }
    const last = segments[segments.length - 1];
    if (last) for (const i of [0, 1, 2]) if (known[i]) cur[i] = last.end[i];
  }

  return ok({
    ok: issues.length === 0,
    issues,
    lines: lines.length,
    extents: all.box(),
    cuttingExtents: cutting.box(),
    moves,
    toolChanges,
    units,
  });
}

/** `line` without its comments; reports comments that are malformed or read as commands. */
function stripComments(
  line: string,
  issue: (code: GcodeIssueCode, message: string) => void,
): string {
  let code = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === ';') {
      issue('comment', 'A ; comment; the dialect writes parenthesised comments only.');
      break;
    }
    if (c === ')') {
      issue('comment', 'A ) without a (.');
      i++;
      continue;
    }
    if (c !== '(') {
      code += c;
      i++;
      continue;
    }
    const close = line.indexOf(')', i + 1);
    if (close < 0) {
      issue('comment', 'A ( without a ).');
      break;
    }
    const body = line.slice(i + 1, close);
    if (body.includes('(')) issue('comment', 'A nested comment.');
    if (isCommentCommand(body)) issue('comment', `A comment a controller may run: (${body}).`);
    i = close + 1;
    // Keep words on either side apart.
    code += ' ';
  }
  return code;
}

/** The words of a code line, or undefined (reported) when it is not a sequence of words. */
function readWords(
  code: string,
  issue: (code: GcodeIssueCode, message: string) => void,
): Word[] | undefined {
  const words: Word[] = [];
  const re = /\s*([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*/y;
  let i = 0;
  const rest = code.trimEnd();
  while (i < rest.length) {
    re.lastIndex = i;
    const m = re.exec(rest);
    if (!m) {
      if (rest.slice(i).trim() === '') break;
      issue('syntax', `'${rest.slice(i).trim()}' is not a word (a capital letter and a number).`);
      return undefined;
    }
    words.push({ letter: m[1]!, text: m[2]!, value: Number(m[2]) });
    i = re.lastIndex;
  }
  return words;
}

interface CycleInput {
  /** `G81` or `G83`. */
  readonly code: string;
  readonly letters: ReadonlyMap<string, Word>;
  /** The position before the line, WCS mm. */
  readonly cur: readonly (number | undefined)[];
  /** Millimetres per file unit. */
  readonly k: number;
  /** Z, R and Q as last written, file units. */
  readonly sticky: Readonly<Partial<Record<'Z' | 'R' | 'Q', number>>>;
  readonly returnMode: 'G98' | 'G99' | undefined;
  /** Z where the series of cycles began, mm (G98 returns to it). */
  readonly initialZ: number | undefined;
  readonly issue: (code: GcodeIssueCode, message: string) => void;
}

/**
 * A G81 or G83 line as the G0 and G1 lines (file units) of the controller's own moves, as LinuxCNC
 * documents them (Mach3 and grblHAL follow the same NIST RS274NGC cycles): up to R when below it,
 * across at the current height, down to R; G81 feeds to Z; G83 feeds by Q from R, rapids out to
 * R and back down to 0.254 mm (0.01 in) above the last depth, until Z; then out to R (G99), or to
 * the higher of R and the Z the series began at (G98). Undefined (reported) when it cannot run.
 */
function expandCycle(c: CycleInput): string[] | undefined {
  const { sticky, k } = c;
  if (sticky.Z === undefined || sticky.R === undefined) {
    c.issue('cycle', `A ${c.code} without Z and R.`);
    return undefined;
  }
  if (c.returnMode === undefined) {
    c.issue(
      'cycle',
      `A ${c.code} with no G98 or G99: where it retracts is the controller's default.`,
    );
    return undefined;
  }
  if (c.cur.length < 3 || c.cur.some((v) => v === undefined)) {
    c.issue('cycle', `A ${c.code} from a position the file has not set.`);
    return undefined;
  }
  const q = sticky.Q;
  if (c.code === 'G83' && !(q !== undefined && q > 0)) {
    c.issue('cycle', 'A G83 without a positive Q.');
    return undefined;
  }
  const bottom = sticky.Z;
  const r = sticky.R;
  if (!(bottom < r)) {
    c.issue('cycle', `A ${c.code} whose Z ${bottom} is not below its R ${r}.`);
    return undefined;
  }
  const n = (v: number): string => String(Number(v.toFixed(9)));
  const x = c.letters.get('X')?.value ?? c.cur[0]! / k;
  const y = c.letters.get('Y')?.value ?? c.cur[1]! / k;
  let z = c.cur[2]! / k;
  const out: string[] = [];
  if (z < r) {
    out.push(`G0 Z${n(r)}`);
    z = r;
  }
  out.push(`G0 X${n(x)} Y${n(y)}`);
  if (z > r) out.push(`G0 Z${n(r)}`);
  if (c.code === 'G81') {
    out.push(`G1 Z${n(bottom)}`);
  } else {
    const backOff = k === 1 ? 0.254 : 0.01;
    for (let depth = r; ;) {
      const target = Math.max(bottom, depth - q!);
      out.push(`G1 Z${n(target)}`);
      if (target <= bottom) break;
      out.push(`G0 Z${n(r)}`, `G0 Z${n(target + backOff)}`);
      depth = target;
    }
  }
  const initial = c.initialZ === undefined ? r : c.initialZ / k;
  out.push(`G0 Z${n(c.returnMode === 'G99' ? r : Math.max(r, initial))}`);
  return out;
}

interface ArcInput {
  readonly letters: ReadonlyMap<string, Word>;
  readonly lastWord: Readonly<Record<'X' | 'Y', string | undefined>>;
  readonly knownXY: boolean;
  /** The options' start position, mm, for an arc before the file writes X and Y. */
  readonly startXY: Vec2 | undefined;
  readonly inches: boolean;
  readonly direction: 'cw' | 'ccw';
  readonly fullCirclesAsHalves: boolean;
  /** The dialect's own radius rule, file units (`arcRadiusTolerance`); Grbl's alone when absent. */
  readonly limit?: number;
  readonly issue: (code: GcodeIssueCode, message: string) => void;
}

/** Grbl's arc checks on the written words of one arc line. */
function checkArc(a: ArcInput): void {
  const { letters, lastWord, issue } = a;
  if (!letters.has('I') && !letters.has('J')) {
    issue('arc', 'An arc without I or J (the engine writes IJK arcs only).');
    return;
  }
  const k = a.inches ? MM_PER_INCH : 1;
  const fromStart = (axis: 0 | 1): string | undefined =>
    a.startXY === undefined ? undefined : String(a.startXY[axis] / k);
  const sx = lastWord.X ?? fromStart(0);
  const sy = lastWord.Y ?? fromStart(1);
  if (!a.knownXY || sx === undefined || sy === undefined) {
    issue('arc', 'An arc from a position the file has not set.');
    return;
  }
  const start = [sx, sy] as const;
  const end = [letters.get('X')?.text ?? sx, letters.get('Y')?.text ?? sy] as const;
  const ij = [letters.get('I')?.text ?? '0', letters.get('J')?.text ?? '0'] as const;
  // The sweep the written numbers describe, in exact arithmetic.
  const s: Vec3 = [Number(start[0]) * k, Number(start[1]) * k, 0];
  const e: Vec3 = [Number(end[0]) * k, Number(end[1]) * k, 0];
  const center: Vec2 = [s[0] + Number(ij[0]) * k, s[1] + Number(ij[1]) * k];
  const full = Math.hypot(e[0] - s[0], e[1] - s[1]) < 1e-9;
  const sweep = arcSweep({ start: s, end: e, center, direction: a.direction, fullCircle: full });
  const check = grblArcCheck({
    start,
    end,
    ij,
    inches: a.inches,
    direction: a.direction,
    sweep: full ? 2 * Math.PI : sweep,
  });
  // Grbl's own rule on the radii it computes (`check.radiusOk` also holds the engine's stricter
  // margin, which is the writer's business, not a firmware limit).
  const r = Math.hypot(Number(ij[0]), Number(ij[1])) * k;
  if (check.deltaR > grblRadiusAllowance(r)) {
    issue(
      'arc-radius',
      `The end point's radius differs from the start's by ${fmt(check.deltaR, 4)} mm (Grbl error 33).`,
    );
  }
  if (a.limit !== undefined && check.exactDeltaR > a.limit * k + 1e-12) {
    issue(
      'arc-radius',
      `The end point's radius differs from the start's by ${fmt(check.exactDeltaR, 4)} mm, over the controller's ${fmt(a.limit * k, 4)} mm.`,
    );
  }
  if (!check.travelOk) {
    issue(
      'arc-travel',
      `Grbl's angular travel ${fmt(check.travel, 4)} rad is not the arc's ${fmt(sweep, 4)} rad.`,
    );
  }
  if (full && a.fullCirclesAsHalves) {
    issue(
      'full-circle',
      'A full circle in one arc; the dialect writes full circles as two halves.',
    );
  }
}

function fmt(v: number, decimals = 3): string {
  return String(Number(v.toFixed(decimals)));
}
