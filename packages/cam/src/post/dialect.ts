// The post-processor dialect record (M5 plan, T5.4a; ADR 0014 decision 10): what a controller
// accepts, as plain data. A user post is a dialect record a user may download and share, so it is
// only ever read, never run: templates substitute named variables from a fixed list, and anything
// unknown or malformed is refused when the record is loaded.

import { err, ok } from '../types';
import type { CamResult } from '../types';
import { MAX_DECIMALS } from './format';

/**
 * How a tool change is written. `none`: the controller has no tool change, so a file holds one
 * tool (the job is split per tool). `m0-pause`: an `M0` program pause with comments, after which
 * the operator changes the tool and re-zeroes Z. `m6`: `M6 T<n>` at every tool change.
 */
export type ToolChangeStyle = 'none' | 'm0-pause' | 'm6';

export const TOOL_CHANGE_STYLES: readonly ToolChangeStyle[] = ['none', 'm0-pause', 'm6'];

/** Output units: G21 millimetres or G20 inches. */
export type PostUnits = 'mm' | 'inch';

/** Decimals for the words of one unit system. */
export interface UnitDecimals {
  /** X, Y, Z, I, J: 3 in millimetres and 4 in inches is usual. */
  readonly coordinate: number;
  /** F, in mm/min or in/min. */
  readonly feed: number;
}

export interface DialectDecimals {
  readonly mm: UnitDecimals;
  readonly inch: UnitDecimals;
  /** S, rpm. */
  readonly spindle: number;
  /** G4's P, in the dialect's dwell unit. */
  readonly dwell: number;
}

/**
 * Template lines, each either a comment line (starts with `(` and ends with `)`, no other
 * parentheses) or a code line (words such as `G90 G94`). `{name}` substitutes a variable from
 * `TEMPLATE_VARIABLES`; nothing else is interpreted.
 */
export interface DialectTemplates {
  /** At the top of every file. */
  readonly header: readonly string[];
  /** Once per tool used in the file, after the header (a tool list). */
  readonly tool: readonly string[];
  /** At every tool change, before the change command (also for each file's first tool). */
  readonly toolChange: readonly string[];
  /** At the end of every file. */
  readonly footer: readonly string[];
}

export interface Dialect {
  /** Lower case letters, digits and hyphens: `grbl`, `carbide-motion`. */
  readonly id: string;
  readonly name: string;
  /** Every G code the controller accepts, as `G0`, `G91.1` (leading zeros are ignored). */
  readonly gCodes: readonly string[];
  /** Every M code the controller accepts, as `M3`. */
  readonly mCodes: readonly string[];
  /** The default tool change style; a post call may pick another the codes allow. */
  readonly toolChange: ToolChangeStyle;
  /** Write one file per tool by default. */
  readonly splitPerTool: boolean;
  /**
   * Whether the controller accepts canned drilling cycles (G81, G83). Recorded for the drill
   * posts; the IR has no cycle markers yet, so the engine writes drilling as G0 and G1 moves.
   */
  readonly cannedCycles: boolean;
  /** An intended full circle as two half arcs (the safe default) or as one arc. */
  readonly fullCircles: 'halves' | 'single';
  /** Comment syntax. Only parenthesised comments are written. */
  readonly comments: 'parentheses';
  /** The longest line, characters, newline not counted: 80 for Grbl's line buffer. */
  readonly maxLineLength: number;
  /** Write a `%` line before and after the program (LinuxCNC, Mach3). */
  readonly programDelimiter: boolean;
  /** G4's P unit. */
  readonly dwellUnit: 'seconds' | 'milliseconds';
  readonly decimals: DialectDecimals;
  readonly templates: DialectTemplates;
}

/** What a variable holds, which decides where it may appear. */
export type VariableKind = 'number' | 'text' | 'code';

/**
 * The fixed variable list. `number` variables may appear in code and comment lines, `code`
 * variables (a whole G word) in code lines, `text` variables in comment lines only, so no user
 * text ever reaches a code line.
 */
export const TEMPLATE_VARIABLES: Readonly<Record<string, VariableKind>> = {
  /** Tool number (`T`). */
  tool: 'number',
  /** Tool name. */
  tool_name: 'text',
  /** Tool cutting diameter, in output units. */
  tool_diameter: 'number',
  /** First spindle speed of the tool, rpm. */
  rpm: 'number',
  /** First cutting feed of the tool, output units per minute. */
  feed: 'number',
  /** Job (document) name. */
  job: 'text',
  /** Setup name. */
  setup: 'text',
  /** Date text, as the caller gives it. */
  date: 'text',
  /** The post's name. */
  post: 'text',
  /** `mm` or `inch`. */
  units: 'text',
  /** `G21` or `G20`. */
  units_code: 'code',
  /** This file's number, from 1. */
  file_index: 'number',
  /** How many files the job writes. */
  file_count: 'number',
  /** How many tools this file uses. */
  tool_count: 'number',
};

/** G codes a template may write: settings only, never a motion or a change of distance mode. */
export const TEMPLATE_G_CODES: readonly string[] = [
  'G17',
  'G20',
  'G21',
  'G40',
  'G49',
  'G54',
  'G55',
  'G56',
  'G57',
  'G58',
  'G59',
  'G61',
  'G64',
  'G80',
  'G90',
  'G91.1',
  'G94',
];

/**
 * G codes a template may write only in the header, before any move: a work offset changes what
 * every remembered position means.
 */
export const HEADER_ONLY_G_CODES: readonly string[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];

/**
 * The largest G64 P (path blending tolerance) a template may write, in the file's units. Checked
 * against the post's tolerance again when the file is written.
 */
export const MAX_G64_P = 0.1;

/** M codes a template may write. `M2` and `M30` (program end) only in the footer. */
export const TEMPLATE_M_CODES: readonly string[] = ['M0', 'M1', 'M2', 'M5', 'M8', 'M9', 'M30'];

/** Codes the engine itself always needs. */
export const REQUIRED_G_CODES: readonly string[] = ['G0', 'G1', 'G2', 'G3', 'G17', 'G90'];

export type TemplateSection = keyof DialectTemplates;

export const TEMPLATE_SECTIONS: readonly TemplateSection[] = [
  'header',
  'tool',
  'toolChange',
  'footer',
];

/** A template line, split into literal text and variable names. */
export interface TemplateLine {
  readonly kind: 'comment' | 'code';
  readonly parts: readonly (string | { readonly variable: string })[];
}

/** A checked dialect: the record plus its parsed templates and normalised code sets. */
export interface CompiledDialect {
  readonly dialect: Dialect;
  readonly gCodes: ReadonlySet<string>;
  readonly mCodes: ReadonlySet<string>;
  readonly templates: Readonly<Record<TemplateSection, readonly TemplateLine[]>>;
}

const DIALECT_KEYS = [
  'id',
  'name',
  'gCodes',
  'mCodes',
  'toolChange',
  'splitPerTool',
  'cannedCycles',
  'fullCircles',
  'comments',
  'maxLineLength',
  'programDelimiter',
  'dwellUnit',
  'decimals',
  'templates',
] as const;

/** `G01` to `G1`, `g91.1` to `G91.1`; undefined when `code` is not a G or M code. */
export function normalizeCode(code: string, letter: 'G' | 'M'): string | undefined {
  const m = /^([GgMm])0*(\d+(?:\.\d+)?)$/.exec(code.trim());
  if (!m || m[1]!.toUpperCase() !== letter) return undefined;
  const number = m[2]!.includes('.') ? m[2]! : String(Number(m[2]));
  return `${letter}${number}`;
}

/** A word in a code line: a letter and a number (`G21`, `T201`, `P0.01`). */
const WORD = /^([A-Z])([+-]?\d+(?:\.\d+)?)$/;

/** Split a code line into words; undefined when any token is not a word. */
export function codeWords(line: string): { letter: string; value: string }[] | undefined {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const words: { letter: string; value: string }[] = [];
  for (const t of tokens) {
    const m = WORD.exec(t);
    if (!m) return undefined;
    words.push({ letter: m[1]!, value: m[2]! });
  }
  return words;
}

/**
 * Check a dialect record and parse its templates. Use it on anything loaded from a file: every
 * field is checked, unknown fields and unknown variables are errors.
 */
export function compileDialect(input: unknown): CamResult<CompiledDialect> {
  let copy: unknown;
  try {
    // A plain data copy: getters, prototypes and later changes to `input` cannot reach it.
    copy = JSON.parse(JSON.stringify(input)) as unknown;
  } catch {
    return err('invalid-dialect', 'A dialect must be plain data (JSON).');
  }
  const result = compileCopy(copy);
  if (result.ok) {
    deepFreeze(result.value.dialect);
    COMPILED.add(result.value);
  }
  return result;
}

/** Compiled dialects made by `compileDialect`, and only those. */
const COMPILED = new WeakSet<object>();

/** True for a `CompiledDialect` that `compileDialect` made; anything else must be compiled. */
export function isCompiledDialect(value: unknown): value is CompiledDialect {
  return typeof value === 'object' && value !== null && COMPILED.has(value);
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}

function compileCopy(input: unknown): CamResult<CompiledDialect> {
  const bad = (message: string): CamResult<CompiledDialect> => err('invalid-dialect', message);
  if (!isRecord(input)) return bad('A dialect must be an object.');
  for (const key of Object.keys(input)) {
    if (!(DIALECT_KEYS as readonly string[]).includes(key)) return bad(`Unknown field '${key}'.`);
  }
  const d = input as Partial<Record<(typeof DIALECT_KEYS)[number], unknown>>;
  if (typeof d.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id)) {
    return bad('The id must be lower case letters, digits and single hyphens.');
  }
  if (typeof d.name !== 'string' || d.name.trim() === '') return bad('The name must be text.');

  const gCodes = codeSet(d.gCodes, 'G');
  if (typeof gCodes === 'string') return bad(gCodes);
  const mCodes = codeSet(d.mCodes, 'M');
  if (typeof mCodes === 'string') return bad(mCodes);
  for (const code of REQUIRED_G_CODES) {
    if (!gCodes.has(code)) return bad(`The engine needs ${code}, which gCodes lacks.`);
  }
  if (!gCodes.has('G20') && !gCodes.has('G21')) return bad('gCodes needs G21 or G20.');

  if (!TOOL_CHANGE_STYLES.includes(d.toolChange as ToolChangeStyle)) {
    return bad(`toolChange must be one of ${TOOL_CHANGE_STYLES.join(', ')}.`);
  }
  const style = d.toolChange as ToolChangeStyle;
  const styleProblem = toolChangeProblem(style, mCodes);
  if (styleProblem) return bad(styleProblem);
  for (const key of ['splitPerTool', 'cannedCycles', 'programDelimiter'] as const) {
    if (typeof d[key] !== 'boolean') return bad(`${key} must be true or false.`);
  }
  if (d.fullCircles !== 'halves' && d.fullCircles !== 'single') {
    return bad("fullCircles must be 'halves' or 'single'.");
  }
  if (d.comments !== 'parentheses') return bad("comments must be 'parentheses'.");
  if (
    typeof d.maxLineLength !== 'number' ||
    !Number.isInteger(d.maxLineLength) ||
    d.maxLineLength < 40 ||
    d.maxLineLength > 255
  ) {
    return bad('maxLineLength must be a whole number from 40 to 255.');
  }
  if (d.dwellUnit !== 'seconds' && d.dwellUnit !== 'milliseconds') {
    return bad("dwellUnit must be 'seconds' or 'milliseconds'.");
  }
  const decimalsProblem = checkDecimals(d.decimals);
  if (decimalsProblem) return bad(decimalsProblem);

  if (!isRecord(d.templates)) return bad('templates must be an object.');
  const templates = {} as Record<TemplateSection, TemplateLine[]>;
  for (const key of Object.keys(d.templates)) {
    if (!(TEMPLATE_SECTIONS as readonly string[]).includes(key)) {
      return bad(`Unknown template section '${key}'.`);
    }
  }
  for (const section of TEMPLATE_SECTIONS) {
    const lines = d.templates[section];
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
      return bad(`templates.${section} must be a list of lines.`);
    }
    const parsed: TemplateLine[] = [];
    for (const [n, text] of (lines as string[]).entries()) {
      const line = parseTemplateLine(text);
      if (typeof line === 'string') return bad(`templates.${section}[${n}]: ${line}`);
      if (line.kind === 'code') {
        const problem = checkTemplateWords(
          literalCode(line, gCodes),
          section,
          gCodes,
          mCodes,
          true,
        );
        if (problem) return bad(`templates.${section}[${n}]: ${problem}`);
      }
      parsed.push(line);
    }
    templates[section] = parsed;
  }
  return ok(Object.freeze({ dialect: input as unknown as Dialect, gCodes, mCodes, templates }));
}

/** Why `style` cannot be written with `mCodes`, or undefined when it can. */
export function toolChangeProblem(
  style: ToolChangeStyle,
  mCodes: ReadonlySet<string>,
): string | undefined {
  if (style === 'm0-pause' && !mCodes.has('M0')) return 'The m0-pause tool change needs M0.';
  if (style === 'm6' && !mCodes.has('M6')) return 'The m6 tool change needs M6.';
  return undefined;
}

/** Parse one template line; a string is the reason it is malformed. */
export function parseTemplateLine(text: string): TemplateLine | string {
  if (/[^\x20-\x7e]/.test(text)) return 'only printable ASCII is allowed.';
  const trimmed = text.trim();
  if (trimmed === '') return 'a line must not be empty.';
  let kind: TemplateLine['kind'] = 'code';
  let body = trimmed;
  if (trimmed.startsWith('(')) {
    if (!trimmed.endsWith(')')) return 'a comment line must end with ).';
    body = trimmed.slice(1, -1);
    if (/[()]/.test(body)) return 'a comment must not hold parentheses.';
    kind = 'comment';
  } else if (/[();%]/.test(trimmed)) {
    return 'a code line must not hold a comment, ; or %.';
  }
  const parts: (string | { variable: string })[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    const name = m[1]!;
    const varKind = TEMPLATE_VARIABLES[name];
    if (varKind === undefined || !Object.hasOwn(TEMPLATE_VARIABLES, name)) {
      return `unknown variable {${name}}.`;
    }
    if (kind === 'code' && varKind === 'text') {
      return `the text variable {${name}} may appear only in a comment line.`;
    }
    if (kind === 'comment' && varKind === 'code') {
      return `the code variable {${name}} may appear only in a code line.`;
    }
    if (kind === 'code') {
      const before = body.slice(0, m.index);
      if (varKind === 'number' && !/(^|\s)T$/.test(before)) {
        return `the number variable {${name}} may appear only as a tool number, T{${name}}.`;
      }
      if (varKind === 'code' && !/(^|\s)$/.test(before)) {
        return `the code variable {${name}} must stand alone as a word.`;
      }
    }
    parts.push({ variable: name });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  if (parts.some((p) => typeof p === 'string' && /[{}]/.test(p))) return 'unbalanced { or }.';
  return { kind, parts };
}

/** A code line's literal text with each variable replaced by a placeholder word. */
function literalCode(line: TemplateLine, gCodes: ReadonlySet<string>): string {
  const unitsCode = gCodes.has('G21') ? 'G21' : 'G20';
  return line.parts
    .map((p) =>
      typeof p === 'string' ? p : TEMPLATE_VARIABLES[p.variable] === 'code' ? unitsCode : '1',
    )
    .join('');
}

/**
 * Why the words of a template code line are not allowed, or undefined when they are. With
 * `placeholders`, variables have been replaced by stand-ins (load time); without, the line is the
 * substituted text (write time).
 */
export function checkTemplateWords(
  text: string,
  section: TemplateSection,
  gCodes: ReadonlySet<string>,
  mCodes: ReadonlySet<string>,
  placeholders = false,
  maxP = MAX_G64_P,
): string | undefined {
  const words = codeWords(text);
  if (!words || words.length === 0) return 'a code line must be words such as G90 or M5.';
  const hasG64 = words.some((w) => w.letter === 'G' && normalizeCode(`G${w.value}`, 'G') === 'G64');
  const pWords = words.filter((w) => w.letter === 'P');
  if (hasG64 && pWords.length !== 1) {
    return 'G64 needs exactly one P (without it, LinuxCNC blends paths without a tolerance).';
  }
  for (const w of words) {
    const word = `${w.letter}${w.value}`;
    if (w.letter === 'G') {
      const code = normalizeCode(word, 'G');
      if (!code || !TEMPLATE_G_CODES.includes(code)) return `a template may not write ${word}.`;
      if (!gCodes.has(code)) return `${code} is not in the dialect's gCodes.`;
      if (HEADER_ONLY_G_CODES.includes(code) && section !== 'header') {
        return `${code} changes the work offset, so it may appear only in the header.`;
      }
    } else if (w.letter === 'M') {
      const code = normalizeCode(word, 'M');
      if (!code || !TEMPLATE_M_CODES.includes(code)) return `a template may not write ${word}.`;
      if (!mCodes.has(code)) return `${code} is not in the dialect's mCodes.`;
      if ((code === 'M2' || code === 'M30') && section !== 'footer') {
        return `${code} ends the program, so it may appear only in the footer.`;
      }
    } else if (w.letter === 'T') {
      if (section !== 'toolChange') return 'a T word may appear only in the toolChange template.';
      if (!placeholders && !/^\d+$/.test(w.value)) return `${word} is not a whole tool number.`;
    } else if (w.letter === 'P') {
      if (!hasG64) return 'a P word may appear only with G64.';
      const p = Number(w.value);
      if (!(p > 0) || p > maxP) return `G64 P must be greater than 0 and at most ${maxP}.`;
    } else {
      return `a template may not write a ${w.letter} word.`;
    }
  }
  return undefined;
}

function codeSet(value: unknown, letter: 'G' | 'M'): Set<string> | string {
  const field = letter === 'G' ? 'gCodes' : 'mCodes';
  if (!Array.isArray(value)) return `${field} must be a list of codes.`;
  const set = new Set<string>();
  for (const code of value) {
    const n = typeof code === 'string' ? normalizeCode(code, letter) : undefined;
    if (!n) return `${field} holds '${String(code)}', which is not a ${letter} code.`;
    set.add(n);
  }
  return set;
}

function checkDecimals(value: unknown): string | undefined {
  const isDecimals = (v: unknown): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_DECIMALS;
  const msg = `decimals must be whole numbers from 0 to ${MAX_DECIMALS}: { mm: { coordinate, feed }, inch: { coordinate, feed }, spindle, dwell }.`;
  if (!isRecord(value)) return msg;
  if (Object.keys(value).some((k) => !['mm', 'inch', 'spindle', 'dwell'].includes(k))) return msg;
  for (const unit of ['mm', 'inch'] as const) {
    const u = value[unit];
    if (!isRecord(u) || Object.keys(u).some((k) => k !== 'coordinate' && k !== 'feed')) return msg;
    if (!isDecimals(u.coordinate) || !isDecimals(u.feed)) return msg;
    if ((u.coordinate as number) < 2) return 'Coordinates need at least 2 decimals.';
  }
  if (!isDecimals(value.spindle) || !isDecimals(value.dwell)) return msg;
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
