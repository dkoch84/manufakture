// The G-code engine (M5 plan, T5.4a; ADR 0014 decision 10): turns a toolpath IR into the lines of
// one or more G-code files for a dialect described as data. It tracks modal state (repeated G0/G1
// and F words are omitted), writes XY arcs as G2/G3 with incremental IJ after checking each one the
// way Grbl will see it, converts to inches under G20, and refuses (an error value, never output)
// whatever the dialect does not allow.

import { MM_PER_INCH } from '@manufakture/units';
import { angleAbout, arcSweep, radiusAbout } from '../arc';
import type { ArcMove, CycleStart, IrEntry, Toolpath, ToolChange } from '../ir';
import { err, ok } from '../types';
import type { CamErrorCode, CamResult, Heights, Vec2, Vec3 } from '../types';
import { DEFAULT_ARC_TOLERANCE, validateToolpath } from '../validate';
import {
  checkTemplateWords,
  codeWords,
  compileDialect,
  isCompiledDialect,
  normalizeCode,
  toolChangeProblem,
} from './dialect';
import { MAX_G64_P } from './dialect';
import type {
  CompiledDialect,
  Dialect,
  PostUnits,
  TemplateLine,
  TemplateSection,
  ToolChangeStyle,
} from './dialect';
import { commentLines, formatNumber } from './format';
import { GRBL_CHECK_OFFSETS, RADIUS_MARGIN, grblArcCheck } from './grbl-arc';

/**
 * The refit tolerance, mm (ADR 0014 decision 12): how far a written path may stray from the
 * intended one. An arc whose sagitta is at most a twentieth of it is written as a line, and an
 * arc that cannot be written as an arc is written as lines within it.
 */
export const DEFAULT_POST_TOLERANCE = 0.002;
/** An arc whose written chord is shorter than this many output steps is written as lines. */
export const MIN_ARC_CHORD_STEPS = 10;
/** An arc whose radius is smaller than this many output steps is written as lines. */
export const MIN_ARC_RADIUS_STEPS = 10;
/** An arc with a sagitta at most this fraction of the tolerance is written as one line. */
export const LINE_SAGITTA_FRACTION = 1 / 20;
/** The most lines one arc may become; more is refused. */
export const MAX_ARC_SEGMENTS = 10000;
/**
 * The most lines one job may become, over all its files; more is refused. A job is held to about
 * `REQUEST_MAX_MOVES` (10 million) entries by the CAM worker, but an entry can become many lines
 * (an arc written as lines, a tool change template), and every line is a string held at once.
 */
export const POST_MAX_LINES = 2e7;
/** The largest angle one line of a linearised arc spans, radians. */
const MAX_SEGMENT_ANGLE = Math.PI / 2;

export interface PostJob {
  readonly toolpath: Toolpath;
  /** Job (document) name, for `{job}`. */
  readonly job: string;
  /** Setup name, for `{setup}`. */
  readonly setup?: string;
  /** Date text, for `{date}`; the caller formats it, so output is reproducible. */
  readonly date?: string;
  /** Where to zero X, Y and Z (the setup's WCS origin) in words, for `{origin}`. */
  readonly origin?: string;
  /**
   * The router's speed dial, from the machine profile, when the spindle is a router whose speed
   * is set by hand. Each spindle start then gets a comment naming the nearest setting.
   */
  readonly spindleDial?: readonly DialSetting[];
  /**
   * The setup's heights, machine Z; `retract` must not be above `clearance`. Every file, and every
   * move after an `M0` or `M6` tool change, starts with a rapid straight up (or down) to the
   * clearance height.
   */
  readonly heights: Heights;
}

/** One setting of a router's speed dial. */
export interface DialSetting {
  /** As printed on the dial: `3`, `3.5`. */
  readonly setting: string;
  /** rpm, greater than zero. */
  readonly rpm: number;
}

export interface PostOptions {
  /** `mm` (G21, the default) or `inch` (G20). */
  readonly units?: PostUnits;
  /** Overrides the dialect's tool change style; the dialect must have its codes. */
  readonly toolChange?: ToolChangeStyle;
  /** Overrides the dialect's one-file-per-tool default. */
  readonly splitPerTool?: boolean;
  /** Refit tolerance, mm; `DEFAULT_POST_TOLERANCE` when absent. */
  readonly tolerance?: number;
  /** The IR validator's arc tolerance, mm; `DEFAULT_ARC_TOLERANCE` when absent. */
  readonly arcTolerance?: number;
  /** Work offsets the Grbl arc check runs at; `GRBL_CHECK_OFFSETS` when absent. */
  readonly checkOffsets?: readonly Vec2[];
  /**
   * Write the IR's drill cycles as G81 (straight) or G83 (peck) canned cycles; the dialect must
   * have `cannedCycles`. A cycle with a dwell is still written as moves. False when absent.
   */
  readonly cannedCycles?: boolean;
  /** Overrides the dialect's `toolLengthOffset` (`G43 H<n>` after each `M6 T<n>`). */
  readonly toolLengthOffset?: boolean;
  /**
   * The most lines the job may become (internal, for tests): `POST_MAX_LINES`, or a lower value;
   * a larger one is clamped to `POST_MAX_LINES`.
   */
  readonly maxLines?: number;
}

export interface PostFile {
  /** From 1. */
  readonly index: number;
  /** The tool ids this file uses, in order. */
  readonly tools: readonly string[];
  readonly lines: readonly string[];
  /** The lines joined with newlines, ending with one. */
  readonly text: string;
}

export interface PostStats {
  /** IR arcs (or half circles) written as G2/G3. */
  readonly arcs: number;
  /** IR arcs (or half circles) written as G1 lines instead. */
  readonly arcsAsLines: number;
  /** Full circles written as two half arcs. */
  readonly fullCirclesSplit: number;
}

export interface PostOutput {
  readonly files: readonly PostFile[];
  readonly stats: PostStats;
}

/** Thrown inside the engine and turned into an error value at its edge. */
class Refusal extends Error {
  constructor(
    readonly code: CamErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: CamErrorCode, message: string): never {
  throw new Refusal(code, message);
}

/**
 * Write `job.toolpath` as G-code for `dialect`. The toolpath must pass `validateToolpath`. Returns
 * the files (one per tool when splitting) or the first reason it cannot be written.
 */
export function postProcess(
  job: PostJob,
  dialect: Dialect | CompiledDialect,
  options: PostOptions = {},
): CamResult<PostOutput> {
  try {
    const checked = isCompiledDialect(dialect) ? ok(dialect) : compileDialect(dialect);
    if (!checked.ok) return checked;
    return ok(run(job, checked.value, options));
  } catch (e) {
    if (e instanceof Refusal) return err(e.code, e.message);
    // Malformed input that slipped past the checks (a getter that throws, say): still an error
    // value, never an exception and never output.
    return err('invalid-input', `The job cannot be written: ${String(e)}`);
  }
}

interface ToolInfo {
  readonly change: ToolChange;
  readonly rpm?: number;
  readonly feed?: number;
}

interface FilePlan {
  readonly entries: IrEntry[];
  readonly tools: ToolInfo[];
}

function run(job: PostJob, d: CompiledDialect, options: PostOptions): PostOutput {
  const units = options.units ?? 'mm';
  if (units !== 'mm' && units !== 'inch') refuse('invalid-input', `Unknown units '${units}'.`);
  const unitsCode = units === 'mm' ? 'G21' : 'G20';
  if (!d.gCodes.has(unitsCode)) {
    refuse('unsupported', `The ${d.dialect.name} post cannot write ${unitsCode} (${units}).`);
  }
  const style = options.toolChange ?? d.dialect.toolChange;
  const styleProblem = toolChangeProblem(style, d.mCodes);
  if (styleProblem) refuse('unsupported', styleProblem);
  const split = options.splitPerTool ?? d.dialect.splitPerTool;
  const cycles = options.cannedCycles ?? false;
  if (cycles && !d.dialect.cannedCycles) {
    refuse('unsupported', `The ${d.dialect.name} post has no canned cycles.`);
  }
  const lengthOffset = options.toolLengthOffset ?? d.dialect.toolLengthOffset ?? false;
  if (lengthOffset && (style !== 'm6' || !d.gCodes.has('G43'))) {
    refuse(
      'unsupported',
      `A tool length offset (G43 H) needs G43 and the m6 tool change; the ${d.dialect.name} post is writing '${style}'.`,
    );
  }
  const tolerance = options.tolerance ?? DEFAULT_POST_TOLERANCE;
  if (!(tolerance > 0) || tolerance > 0.1) {
    refuse('invalid-input', 'The tolerance must be greater than 0 and at most 0.1 mm.');
  }
  const arcTolerance = options.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
  if (!(arcTolerance > 0) || !Number.isFinite(arcTolerance)) {
    refuse('invalid-input', 'The arc tolerance must be greater than 0.');
  }
  const { clearance, retract } = job.heights;
  if (!Number.isFinite(clearance) || !Number.isFinite(retract)) {
    refuse('invalid-input', 'The clearance and retract heights must be finite.');
  }
  if (retract > clearance) {
    refuse(
      'invalid-input',
      `The retract height ${retract} mm is above the clearance ${clearance} mm.`,
    );
  }
  const dial = checkDial(job.spindleDial);
  const offsets = options.checkOffsets ?? GRBL_CHECK_OFFSETS;
  if (offsets.length === 0 || !offsets.every((o) => o.every(Number.isFinite))) {
    refuse('invalid-input', 'The check offsets must be a non-empty list of finite points.');
  }

  const issues = validateToolpath(job.toolpath, { arcTolerance });
  if (issues.length > 0) {
    const first = issues[0]!;
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
    refuse(
      'invalid-input',
      `The toolpath is invalid at entry ${first.index}: ${first.message}${more}`,
    );
  }
  for (const e of job.toolpath.entries) {
    if (
      e.kind === 'toolChange' &&
      e.diameter !== undefined &&
      !(e.diameter > 0 && Number.isFinite(e.diameter))
    ) {
      refuse('invalid-input', `Tool ${e.tool} has a diameter of ${e.diameter}.`);
    }
  }

  const plans = planFiles(job.toolpath.entries, split);
  if (style === 'none') {
    for (const plan of plans) {
      if (plan.tools.length > 1) {
        refuse(
          'unsupported',
          `The ${d.dialect.name} post has no tool change, and the job uses ${plan.tools.length} tools in one file: split it per tool.`,
        );
      }
    }
  }

  const stats = { arcs: 0, arcsAsLines: 0, fullCirclesSplit: 0 };
  const asked = options.maxLines;
  const budget = {
    lines: 0,
    max:
      typeof asked === 'number' && Number.isFinite(asked) && asked > 0
        ? Math.min(Math.floor(asked), POST_MAX_LINES)
        : POST_MAX_LINES,
  };
  let irPos: Vec3 = job.toolpath.start;
  const files: PostFile[] = plans.map((plan, n) => {
    const w = new FileWriter({
      d,
      job,
      units,
      style,
      tolerance,
      offsets,
      stats,
      budget,
      cycles,
      lengthOffset,
      fileIndex: n + 1,
      fileCount: plans.length,
      plan,
      irPos,
      ...(dial !== undefined ? { dial } : {}),
    });
    const lines = w.write();
    irPos = w.irPos;
    return {
      index: n + 1,
      tools: plan.tools.map((t) => t.change.tool),
      lines,
      text: lines.join('\n') + '\n',
    };
  });
  return { files, stats };
}

/**
 * Split the entries into files: one file, or a new file at every tool change after the first
 * when splitting. Comments just before a tool change go with the new tool.
 */
function planFiles(entries: readonly IrEntry[], split: boolean): FilePlan[] {
  const plans: FilePlan[] = [{ entries: [], tools: [] }];
  for (const [i, e] of entries.entries()) {
    let plan = plans[plans.length - 1]!;
    if (e.kind === 'toolChange') {
      if (split && plan.tools.length > 0) {
        let keep = plan.entries.length;
        while (keep > 0 && plan.entries[keep - 1]!.kind === 'comment') keep--;
        const next: FilePlan = { entries: plan.entries.splice(keep), tools: [] };
        plans.push(next);
        plan = next;
      }
      plan.tools.push(toolInfo(e, entries.slice(i + 1)));
    }
    plan.entries.push(e);
  }
  return plans;
}

/** The first spindle speed and the first cutting feed after a tool change, before the next. */
function toolInfo(change: ToolChange, after: readonly IrEntry[]): ToolInfo {
  let rpm: number | undefined;
  let cutFeed: number | undefined;
  let anyFeed: number | undefined;
  for (const e of after) {
    if (e.kind === 'toolChange') break;
    if (e.kind === 'spindle' && e.state !== 'off' && rpm === undefined) rpm = e.rpm;
    if (e.kind === 'linear' || e.kind === 'arc') {
      anyFeed ??= e.feed;
      if (e.feedClass === 'cut') cutFeed ??= e.feed;
    }
  }
  const feed = cutFeed ?? anyFeed;
  return { change, ...(rpm !== undefined ? { rpm } : {}), ...(feed !== undefined ? { feed } : {}) };
}

type Axis = 'x' | 'y' | 'z';
const AXES: readonly Axis[] = ['x', 'y', 'z'];

interface WriterInput {
  readonly d: CompiledDialect;
  readonly job: PostJob;
  readonly units: PostUnits;
  readonly style: ToolChangeStyle;
  readonly tolerance: number;
  readonly offsets: readonly Vec2[];
  /** Write drill cycles as G81/G83. */
  readonly cycles: boolean;
  /** Write `G43 H<n>` after each `M6 T<n>`. */
  readonly lengthOffset: boolean;
  readonly stats: { arcs: number; arcsAsLines: number; fullCirclesSplit: number };
  /** Lines written so far over all the job's files, and the most allowed. */
  readonly budget: { lines: number; readonly max: number };
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly plan: FilePlan;
  readonly irPos: Vec3;
  /** The job's spindle dial, checked and copied by `checkDial`. */
  readonly dial?: readonly DialSetting[];
}

/**
 * A checked copy of a spindle dial table, read once (so a getter cannot hand the writer a
 * different value later), or undefined when there is none.
 */
function checkDial(dial: unknown): readonly DialSetting[] | undefined {
  if (dial === undefined) return undefined;
  const bad = (): never =>
    refuse(
      'invalid-input',
      'The spindle dial must be a non-empty list of { setting, rpm }: setting text and a positive rpm.',
    );
  if (!Array.isArray(dial) || dial.length === 0) bad();
  const copy: DialSetting[] = [];
  for (let i = 0; i < (dial as unknown[]).length; i++) {
    const entry: unknown = (dial as unknown[])[i];
    if (typeof entry !== 'object' || entry === null) bad();
    const { setting, rpm } = entry as Record<string, unknown>;
    if (typeof setting !== 'string' || setting.trim() === '') bad();
    if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0) bad();
    copy.push({ setting: setting as string, rpm: rpm as number });
  }
  return copy;
}

/** Writes one file, tracking modal state from the first line to the last. */
class FileWriter {
  private readonly lines: string[] = [];
  private readonly d: CompiledDialect;
  private readonly k: number;
  private readonly coord: number;
  private readonly feedDecimals: number;
  private readonly step: number;
  /** The last written X, Y and Z words (output units); absent while unknown. */
  private pos: Partial<Record<Axis, string>> = {};
  private motion: string | undefined;
  private feed: string | undefined;
  private spindleOn = false;
  /** True at the start of the file and after an M0 or M6 tool change. */
  private needSafeStart = true;
  /** True for the first rapid after a safe start: it is split into Z and XY. */
  private firstRapid = false;
  private tool: ToolInfo | undefined;
  private toolsSeen = 0;
  /** True between a cycle marker written as a canned cycle and its end: the moves are skipped. */
  private inCycle = false;
  /** The controller's arc radius rule in mm, when the dialect has one. */
  private readonly arcLimit: number | undefined;
  /** The index in the plan's entries of the entry being written; -1 before the first. */
  private cursor = -1;
  private modal: { units?: string; distance?: boolean; plane?: boolean; feedMode?: boolean } = {};
  irPos: Vec3;

  constructor(private readonly input: WriterInput) {
    this.d = input.d;
    this.k = input.units === 'inch' ? 1 / MM_PER_INCH : 1;
    const decimals =
      input.units === 'inch' ? input.d.dialect.decimals.inch : input.d.dialect.decimals.mm;
    this.coord = decimals.coordinate;
    this.feedDecimals = decimals.feed;
    this.step = 10 ** -this.coord;
    this.irPos = input.irPos;
    this.tool = input.plan.tools[0];
    const limit = input.d.dialect.arcRadiusTolerance;
    this.arcLimit =
      limit === undefined
        ? undefined
        : input.units === 'inch'
          ? limit.inch * MM_PER_INCH
          : limit.mm;
  }

  write(): string[] {
    const { d, plan } = this.input;
    if (d.dialect.programDelimiter) this.add('%');
    this.template('header');
    for (const t of plan.tools) this.template('tool', t);
    this.preamble();
    for (const [i, e] of plan.entries.entries()) {
      this.cursor = i;
      this.entry(e);
    }
    this.cursor = plan.entries.length;
    this.retract();
    if (this.spindleOn) this.spindle({ kind: 'spindle', state: 'off' });
    this.template('footer');
    if (d.dialect.programDelimiter) this.add('%');
    return this.lines;
  }

  // -------------------------------------------------------------------------------------------
  // Lines and words

  private emit(line: string): void {
    const max = this.d.dialect.maxLineLength;
    if (line.length > max) {
      refuse('unsupported', `The line '${line}' is longer than ${max} characters.`);
    }
    this.add(line);
  }

  /** Adds `line`, refusing the job once it passes its line budget. */
  private add(line: string): void {
    const budget = this.input.budget;
    if (++budget.lines > budget.max) {
      refuse(
        'invalid-input',
        `The job would be more than ${budget.max} lines of G-code, the most one export may write. Split the setup, or use larger tools, stepdowns or stepovers.`,
      );
    }
    this.lines.push(line);
  }

  private needG(code: string, why: string): void {
    if (!this.d.gCodes.has(code)) {
      refuse(
        'unsupported',
        `The ${this.d.dialect.name} post does not allow ${code}, needed for ${why}.`,
      );
    }
  }

  private needM(code: string, why: string): void {
    if (!this.d.mCodes.has(code)) {
      refuse(
        'unsupported',
        `The ${this.d.dialect.name} post does not allow ${code}, needed for ${why}.`,
      );
    }
  }

  /** A length in mm as an output word value. */
  private coordWord(mm: number): string {
    const text = formatNumber(mm * this.k, this.coord);
    if (text === undefined) refuse('invalid-input', `The coordinate ${mm} mm cannot be written.`);
    return text;
  }

  /** A feed in mm/min as an F value, greater than zero once written. */
  private feedWord(mmPerMin: number): string {
    const text = formatNumber(mmPerMin * this.k, this.feedDecimals);
    if (text === undefined || !(Number(text) > 0)) {
      refuse('invalid-input', `The feed ${mmPerMin} mm/min cannot be written as a positive F.`);
    }
    return text;
  }

  /** `text` as sanitised comment lines. */
  private comment(text: string): void {
    for (const l of commentLines(text, this.d.dialect.maxLineLength)) this.emit(l);
  }

  // -------------------------------------------------------------------------------------------
  // Templates and the modal preamble

  private template(section: TemplateSection, tool: ToolInfo | undefined = this.tool): void {
    for (const line of this.d.templates[section]) this.templateLine(line, section, tool);
  }

  private templateLine(
    line: TemplateLine,
    section: TemplateSection,
    tool: ToolInfo | undefined,
  ): void {
    if (line.kind === 'comment') {
      const text = line.parts
        .map((p) => (typeof p === 'string' ? p : (this.variable(p.variable, tool) ?? 'unknown')))
        .join('');
      for (const l of commentLines(text, this.d.dialect.maxLineLength)) this.emit(l);
      return;
    }
    const text = line.parts
      .map((p) => {
        if (typeof p === 'string') return p;
        const value = this.variable(p.variable, tool);
        if (value === undefined) {
          refuse(
            'unsupported',
            `The ${section} template needs {${p.variable}}, which has no value here.`,
          );
        }
        return value;
      })
      .join('')
      .trim()
      .replace(/\s+/g, ' ');
    const maxP = Math.min(MAX_G64_P, this.input.tolerance * this.k);
    const problem = checkTemplateWords(text, section, this.d.gCodes, this.d.mCodes, {
      maxP,
      maxTool: this.d.maxToolNumber,
    });
    if (problem) refuse('invalid-dialect', `The ${section} template writes '${text}': ${problem}`);
    for (const w of codeWords(text) ?? []) {
      const code = normalizeCode(`${w.letter}${w.value}`, 'G');
      if (code === 'G20' || code === 'G21') {
        if (code !== (this.input.units === 'mm' ? 'G21' : 'G20')) {
          refuse(
            'invalid-dialect',
            `The ${section} template writes ${code} in a ${this.input.units} file.`,
          );
        }
        this.modal.units = code;
      } else if (code === 'G90') this.modal.distance = true;
      else if (code === 'G17') this.modal.plane = true;
      else if (code === 'G94') this.modal.feedMode = true;
    }
    this.emit(text);
    // A template code line may change modes the engine relies on (G80 cancels the motion mode),
    // so forget the remembered position, motion and feed and start the next move from the
    // clearance height again.
    this.forget();
  }

  /** Forget the written position and modes: the next move starts with a safe start. */
  private forget(): void {
    this.pos = {};
    this.motion = undefined;
    this.feed = undefined;
    this.needSafeStart = true;
    this.firstRapid = false;
  }

  /**
   * A rapid straight up to the safe height (`safeHeight`), when the tool is known to be below it.
   * The next rapid then starts from there like the first rapid of a file: up before across, or
   * across before down, never diagonally down.
   */
  private retract(): void {
    const z = this.pos.z;
    const safe = this.safeHeight();
    if (z !== undefined && Number(z) < Number(this.coordWord(safe))) {
      this.move('G0', [undefined, undefined, safe], undefined, true);
      this.firstRapid = true;
    }
  }

  /**
   * The height a safe start or a retract goes to: the clearance, or the next rapid's Z when that
   * is higher, so the file never goes to the clearance and then climbs again.
   */
  private safeHeight(): number {
    const clearance = this.input.job.heights.clearance;
    const entries = this.input.plan.entries;
    for (let i = Math.max(0, this.cursor); i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind === 'rapid') return Math.max(clearance, e.to[2]);
      if (e.kind === 'linear' || e.kind === 'arc') break;
    }
    return clearance;
  }

  /** A template variable's text, or undefined when it has no value here. */
  private variable(name: string, tool: ToolInfo | undefined): string | undefined {
    const { job, units, d, fileIndex, fileCount, plan } = this.input;
    const num = (v: number | undefined, decimals: number): string | undefined =>
      v === undefined ? undefined : formatNumber(v, decimals);
    switch (name) {
      case 'tool': {
        const n = tool?.change.number;
        return n !== undefined && Number.isInteger(n) && n >= 0 ? num(n, 0) : undefined;
      }
      case 'tool_name':
        return tool?.change.name;
      case 'tool_diameter':
        return num(
          tool?.change.diameter === undefined ? undefined : tool.change.diameter * this.k,
          this.coord,
        );
      case 'rpm':
        return num(tool?.rpm, d.dialect.decimals.spindle);
      case 'feed':
        return num(tool?.feed === undefined ? undefined : tool.feed * this.k, this.feedDecimals);
      case 'job':
        return job.job;
      case 'setup':
        return job.setup;
      case 'date':
        return job.date;
      case 'origin':
        return job.origin;
      case 'post':
        return d.dialect.name;
      case 'units':
        return units;
      case 'units_code':
        return units === 'mm' ? 'G21' : 'G20';
      case 'file_index':
        return String(fileIndex);
      case 'file_count':
        return String(fileCount);
      case 'tool_count':
        return String(plan.tools.length);
    }
    return undefined;
  }

  /** The modes every move relies on, for whichever the header did not set. */
  private preamble(): void {
    const words: string[] = [];
    if (this.modal.units === undefined) words.push(this.input.units === 'mm' ? 'G21' : 'G20');
    if (!this.modal.distance) words.push('G90');
    if (!this.modal.plane) words.push('G17');
    if (!this.modal.feedMode && this.d.gCodes.has('G94')) words.push('G94');
    if (words.length > 0) this.emit(words.join(' '));
    if (this.d.dialect.pathBlending) {
      // The largest P the output can hold that is not over the tolerance, in output units.
      const p = formatNumber(Math.floor(this.input.tolerance * this.k * 1e6) / 1e6, 6);
      if (p === undefined || !(Number(p) > 0)) {
        refuse('invalid-input', `The tolerance ${this.input.tolerance} mm cannot be a G64 P.`);
      }
      this.needG('G64', 'path blending');
      this.emit(`G64 P${p}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Entries

  private entry(e: IrEntry): void {
    if (this.inCycle) {
      // Inside a group written as one canned cycle: the moves are the controller's to make.
      if (e.kind === 'cycleEnd') this.endCycle();
      else if (e.kind === 'rapid' || e.kind === 'linear' || e.kind === 'arc') this.irPos = e.to;
      return;
    }
    switch (e.kind) {
      case 'comment':
        for (const l of commentLines(e.text, this.d.dialect.maxLineLength)) this.emit(l);
        return;
      case 'toolChange':
        this.toolChange(e);
        return;
      case 'spindle':
        this.spindle(e);
        return;
      case 'dwell':
        this.dwell(e.seconds);
        return;
      case 'cycle':
        // Written as a canned cycle when asked and possible; otherwise the expanded moves
        // between the markers are written as they are.
        if (this.input.cycles) this.inCycle = this.cycle(e);
        return;
      case 'cycleEnd':
        return;
      case 'rapid':
        this.rapid(e.to);
        this.irPos = e.to;
        return;
      case 'linear':
        if (this.needSafeStart || this.firstRapid) this.feedFirst();
        this.move('G1', e.to, e.feed);
        this.irPos = e.to;
        return;
      case 'arc':
        if (this.needSafeStart || this.firstRapid) this.feedFirst();
        this.arc(this.irPos, e);
        this.irPos = e.to;
        return;
    }
  }

  private feedFirst(): never {
    refuse(
      'invalid-input',
      'A feed move comes first after a file start or tool change; the first move must be a rapid.',
    );
  }

  private toolChange(e: ToolChange): void {
    const first = this.toolsSeen === 0;
    this.toolsSeen++;
    this.tool = this.input.plan.tools[this.toolsSeen - 1] ?? { change: e };
    this.retract();
    this.template('toolChange');
    const style = this.input.style;
    if (style === 'none') {
      if (!first) refuse('unsupported', `The ${this.d.dialect.name} post has no tool change.`);
    } else if (style === 'm0-pause') {
      // The operator loads a file's first tool before starting it, so only later tools pause.
      if (!first) {
        this.needM('M0', 'a tool change pause');
        // The operator acts during the pause, so everything they need is written before it.
        const dial = this.input.dial;
        const rpm = this.tool?.rpm;
        if (dial !== undefined && rpm !== undefined) this.comment(dialComment(dial, rpm));
        this.comment(
          dial !== undefined
            ? 'Pause: turn the router off, change the bit, re-zero Z or keep the same stick-out, set the dial, turn the router on, then resume'
            : 'Pause: stop the spindle, change the tool, re-zero Z or keep the same stick-out, then resume',
        );
        this.emit('M0');
      }
    } else {
      this.needM('M6', 'a tool change');
      const n = e.number;
      if (n === undefined || !Number.isInteger(n) || n < 0) {
        refuse('unsupported', `Tool ${e.tool} (${e.name}) needs a tool number for M6.`);
      }
      if (n > this.d.maxToolNumber) {
        refuse(
          'unsupported',
          `Tool ${e.tool} (${e.name}) has the number ${n}, above the ${this.d.maxToolNumber} the ${this.d.dialect.name} post takes in a T word: give it a smaller number.`,
        );
      }
      this.emit(`M6 T${n}`);
      if (this.input.lengthOffset) {
        this.needG('G43', 'a tool length offset');
        this.emit(`G43 H${n}`);
      }
    }
    if (style !== 'none' && !first) {
      // The machine may have moved, and senders may reset modes: start over from a safe height.
      this.forget();
    }
    if (this.needSafeStart) this.safeStart();
  }

  /**
   * A rapid straight to the clearance height (or the next rapid's Z when higher) before anything
   * else moves or spins.
   */
  private safeStart(): void {
    this.move('G0', [undefined, undefined, this.safeHeight()], undefined, true);
    this.needSafeStart = false;
    this.firstRapid = true;
  }

  private spindle(e: Extract<IrEntry, { kind: 'spindle' }>): void {
    if (e.state === 'off') {
      this.needM('M5', 'stopping the spindle');
      // Never stop the spindle with the tool in the work: rise to the retract height first.
      const z = this.pos.z;
      const retract = this.input.job.heights.retract;
      if (z !== undefined && Number(z) < Number(this.coordWord(retract))) {
        this.move('G0', [undefined, undefined, retract], undefined, true);
        this.firstRapid = true;
      }
      this.emit('M5');
      this.spindleOn = false;
      return;
    }
    const state: string = e.state;
    if (state !== 'cw' && state !== 'ccw') {
      refuse('invalid-input', `Unknown spindle state '${state}'.`);
    }
    const code = state === 'cw' ? 'M3' : 'M4';
    this.needM(code, state === 'cw' ? 'the spindle' : 'a counter-clockwise spindle');
    const s = formatNumber(e.rpm, this.d.dialect.decimals.spindle);
    if (s === undefined || !(Number(s) > 0)) {
      refuse('invalid-input', `The spindle speed ${e.rpm} rpm cannot be written as a positive S.`);
    }
    const dial = this.input.dial;
    if (dial !== undefined) this.comment(dialComment(dial, Number(s)));
    this.emit(`${code} S${s}`);
    this.spindleOn = true;
  }

  /**
   * Write a drill cycle group as one G81 or G83 line; false, writing nothing, when it must stay
   * moves: a dwell (G82's P unit differs between controllers), no feed in the group, or the tool
   * not written at the hole centre on the retract plane. `G99` returns to the R plane, where the
   * IR's group ends. The controller measures G83's pecks from R, not from the cycle's `top`, and
   * backs off its own distance between pecks (LinuxCNC: 0.254 mm), so its first peck is shorter
   * by the gap between them; the depth reached is the same.
   */
  private cycle(e: CycleStart): boolean {
    const c = e.drill;
    if (c.dwell !== undefined || this.needSafeStart || this.firstRapid) return false;
    const entries = this.input.plan.entries;
    let feed: number | undefined;
    for (let i = this.cursor + 1; i < entries.length; i++) {
      const x = entries[i]!;
      if (x.kind === 'cycleEnd') break;
      if (x.kind === 'linear') {
        feed = x.feed;
        break;
      }
    }
    if (feed === undefined) return false;
    const x = this.coordWord(c.at[0]);
    const y = this.coordWord(c.at[1]);
    const r = this.coordWord(c.retract);
    if (this.pos.x !== x || this.pos.y !== y || this.pos.z !== r) return false;
    const code = c.peck === undefined ? 'G81' : 'G83';
    this.needG(code, 'a drilling cycle');
    this.needG('G99', 'a drilling cycle');
    this.needG('G80', 'ending a drilling cycle');
    const words = ['G99', code, `X${x}`, `Y${y}`, `Z${this.coordWord(c.bottom)}`, `R${r}`];
    if (c.peck !== undefined) {
      const q = formatNumber(c.peck * this.k, this.coord);
      if (q === undefined || !(Number(q) > 0)) {
        refuse('invalid-input', `The peck ${c.peck} mm cannot be written as a positive Q.`);
      }
      words.push(`Q${q}`);
    }
    const f = this.feedWord(feed);
    if (f !== this.feed) {
      words.push(`F${f}`);
      this.feed = f;
    }
    this.emit(words.join(' '));
    this.motion = code;
    return true;
  }

  /** After a canned cycle: back on the R plane over the hole, and the cycle cancelled. */
  private endCycle(): void {
    this.inCycle = false;
    this.emit('G80');
    this.motion = undefined;
  }

  private dwell(seconds: number): void {
    if (seconds === 0) return;
    this.needG('G4', 'a dwell');
    const value = this.d.dialect.dwellUnit === 'seconds' ? seconds : seconds * 1000;
    const p = formatNumber(value, this.d.dialect.decimals.dwell);
    if (p === undefined) refuse('invalid-input', `The dwell ${seconds} s cannot be written.`);
    if (Number(p) > 0) this.emit(`G4 P${p}`);
  }

  private rapid(to: Vec3): void {
    const clearance = this.input.job.heights.clearance;
    if (this.needSafeStart) this.safeStart();
    if (this.firstRapid) {
      this.firstRapid = false;
      // From the clearance height: up first, or across first and then down.
      if (to[2] >= clearance) {
        this.move('G0', [undefined, undefined, to[2]]);
        this.move('G0', [to[0], to[1], undefined]);
      } else {
        this.move('G0', [to[0], to[1], undefined]);
        this.move('G0', [undefined, undefined, to[2]]);
      }
      return;
    }
    // A rapid that comes down while it moves across, below the clearance, could drive the tool
    // into the stock or a clamp on the way: the IR must go across first, then down.
    const z0 = this.pos.z;
    const zText = this.coordWord(to[2]);
    if (
      to[2] < clearance &&
      z0 !== undefined &&
      Number(zText) < Number(z0) &&
      (this.coordWord(to[0]) !== this.pos.x || this.coordWord(to[1]) !== this.pos.y)
    ) {
      refuse(
        'invalid-input',
        `A rapid to (${to.join(', ')}) comes down while it moves across, below the clearance; rapid across first, then down.`,
      );
    }
    this.move('G0', to);
  }

  /**
   * A straight move to `to` (undefined axes stay), writing only the words that change. A move
   * that changes no written word is dropped.
   */
  private move(
    code: 'G0' | 'G1',
    to: readonly [number | undefined, number | undefined, number | undefined],
    feed?: number,
    explicit = false,
  ): void {
    const words: string[] = [];
    const next: Partial<Record<Axis, string>> = {};
    AXES.forEach((axis, i) => {
      const v = to[i];
      if (v === undefined) return;
      const text = this.coordWord(v);
      if (text !== this.pos[axis]) {
        words.push(`${axis.toUpperCase()}${text}`);
        next[axis] = text;
      }
    });
    if (words.length === 0) return;
    if (explicit || code !== this.motion) words.unshift(code);
    if (feed !== undefined) {
      const f = this.feedWord(feed);
      if (f !== this.feed) {
        words.push(`F${f}`);
        this.feed = f;
      }
    }
    this.emit(words.join(' '));
    this.motion = code;
    Object.assign(this.pos, next);
  }

  // -------------------------------------------------------------------------------------------
  // Arcs

  private arc(from: Vec3, a: ArcMove): void {
    const sweep = arcSweep({
      start: from,
      end: a.to,
      center: a.center,
      direction: a.direction,
      fullCircle: a.fullCircle,
    });
    if (a.fullCircle) {
      if (this.d.dialect.fullCircles === 'single' && this.tryArc(from, a, 2 * Math.PI, true))
        return;
      this.input.stats.fullCirclesSplit++;
      const r = radiusAbout(a.center, from);
      const mAngle = angleAbout(a.center, from) + (a.direction === 'ccw' ? Math.PI : -Math.PI);
      const mid: Vec3 = [
        a.center[0] + r * Math.cos(mAngle),
        a.center[1] + r * Math.sin(mAngle),
        (from[2] + a.to[2]) / 2,
      ];
      this.arcPiece(from, { ...a, to: mid, fullCircle: false }, Math.PI);
      this.arcPiece(mid, { ...a, fullCircle: false }, Math.PI);
      return;
    }
    this.arcPiece(from, a, sweep);
  }

  private arcPiece(from: Vec3, a: ArcMove, sweep: number): void {
    if (!this.tryArc(from, a, sweep, false)) this.linearise(from, a, sweep);
  }

  /**
   * Write `a` as one G2/G3 if every rule allows it (ADR 0014 decision 10); false, writing
   * nothing, when it must be lines instead.
   */
  private tryArc(from: Vec3, a: ArcMove, sweep: number, full: boolean): boolean {
    const sx = this.pos.x;
    const sy = this.pos.y;
    if (sx === undefined || sy === undefined) return false;
    const r = radiusAbout(a.center, from);
    const step = this.step;
    if (r * this.k < MIN_ARC_RADIUS_STEPS * step) return false;
    const ex = full ? sx : this.coordWord(a.to[0]);
    const ey = full ? sy : this.coordWord(a.to[1]);
    if (!full) {
      if (ex === sx && ey === sy) return false;
      const chord = Math.hypot(Number(ex) - Number(sx), Number(ey) - Number(sy));
      if (chord < MIN_ARC_CHORD_STEPS * step) return false;
      if (sagitta(r, sweep) <= this.input.tolerance * LINE_SAGITTA_FRACTION) return false;
    }
    for (const ij of this.ijCandidates(a.center, [sx, sy], [ex, ey])) {
      const check = grblArcCheck(
        {
          start: [sx, sy],
          end: [ex, ey],
          ij,
          inches: this.input.units === 'inch',
          direction: a.direction,
          sweep,
        },
        this.input.offsets,
      );
      if (!check.ok) continue;
      if (this.arcLimit !== undefined && check.exactDeltaR > RADIUS_MARGIN * this.arcLimit)
        continue;
      const code = a.direction === 'cw' ? 'G2' : 'G3';
      this.needG(code, 'an arc');
      const words = [code, `X${ex}`, `Y${ey}`];
      const z = this.coordWord(a.to[2]);
      if (z !== this.pos.z) words.push(`Z${z}`);
      words.push(`I${ij[0]}`, `J${ij[1]}`);
      const f = this.feedWord(a.feed);
      if (f !== this.feed) {
        words.push(`F${f}`);
        this.feed = f;
      }
      this.emit(words.join(' '));
      this.motion = code;
      this.pos = { x: ex, y: ey, z };
      this.input.stats.arcs++;
      return true;
    }
    return false;
  }

  /**
   * The written I and J to try, best first: each rounded down and up from the exact centre
   * offset, ordered by how little the written start and end radii then differ, then by distance
   * from the exact centre.
   */
  private ijCandidates(
    center: Vec2,
    start: readonly [string, string],
    end: readonly [string, string],
  ): [string, string][] {
    const sx = Number(start[0]);
    const sy = Number(start[1]);
    const ex = Number(end[0]);
    const ey = Number(end[1]);
    const i = center[0] * this.k - sx;
    const j = center[1] * this.k - sy;
    const round = (v: number): string[] => {
      const lo = Math.floor(v / this.step);
      const out = [lo, lo + 1].map((n) => formatNumber(n * this.step, this.coord));
      return [...new Set(out.filter((t): t is string => t !== undefined))];
    };
    const list: { ij: [string, string]; delta: number; off: number }[] = [];
    for (const ti of round(i)) {
      for (const tj of round(j)) {
        const ci = Number(ti);
        const cj = Number(tj);
        const delta = Math.abs(Math.hypot(ex - sx - ci, ey - sy - cj) - Math.hypot(ci, cj));
        list.push({ ij: [ti, tj], delta, off: Math.hypot(ci - i, cj - j) });
      }
    }
    list.sort((a, b) => a.delta - b.delta || a.off - b.off);
    return list.map((c) => c.ij);
  }

  /** `a` as G1 lines whose chords stay within the tolerance of the arc. */
  private linearise(from: Vec3, a: ArcMove, sweep: number): void {
    this.input.stats.arcsAsLines++;
    const r = radiusAbout(a.center, from);
    const tol = this.input.tolerance;
    const maxAngle = Math.min(MAX_SEGMENT_ANGLE, tol < r ? 2 * Math.acos(1 - tol / r) : Math.PI);
    const n = Math.max(1, Math.ceil(sweep / maxAngle - 1e-9));
    if (n > MAX_ARC_SEGMENTS) {
      refuse(
        'unsupported',
        `An arc of radius ${r} mm would need ${n} lines; it cannot be written.`,
      );
    }
    const a0 = angleAbout(a.center, from);
    const sign = a.direction === 'ccw' ? 1 : -1;
    for (let s = 1; s <= n; s++) {
      if (s === n) {
        this.move('G1', a.to, a.feed);
      } else {
        const t = s / n;
        const angle = a0 + sign * sweep * t;
        this.move(
          'G1',
          [
            a.center[0] + r * Math.cos(angle),
            a.center[1] + r * Math.sin(angle),
            from[2] + (a.to[2] - from[2]) * t,
          ],
          a.feed,
        );
      }
    }
  }
}

/**
 * The comment naming the dial setting nearest to `rpm` (the first of equally near ones), with
 * the setting's own speed and, when that differs, the speed asked for.
 */
export function dialComment(dial: readonly DialSetting[], rpm: number): string {
  let best = dial[0]!;
  for (const s of dial) if (Math.abs(s.rpm - rpm) < Math.abs(best.rpm - rpm)) best = s;
  const n = (v: number): string => formatNumber(v, 0) ?? String(v);
  const at = `Router dial ${best.setting.trim()}: ${n(best.rpm)} rpm`;
  return best.rpm === rpm ? at : `${at}, nearest to ${n(rpm)} rpm`;
}

/** Greatest distance between an arc of radius `r` and sweep `sweep` and its chord. */
export function sagitta(r: number, sweep: number): number {
  return r * (1 - Math.cos(sweep / 2));
}
