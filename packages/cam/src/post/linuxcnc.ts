// The LinuxCNC post-processor (M5 plan, T5.4c): the `linuxcnc` dialect. Dialect data on top of
// the engine in `writer.ts`; this file holds no G-code logic of its own.
//
// Sources (LinuxCNC documentation, read 2026-10-02):
// - "G-code overview" (https://linuxcnc.org/docs/html/gcode/overview.html): a file may be
//   demarcated by `%` lines ("optional if the file has an M2 or M30 in it, but is required if
//   not"); at most 256 characters a line; parenthesised and `;` comments, and the active comments
//   `(MSG,`, `(DEBUG,`, `(PRINT,`, `(LOG,`, `(LOGOPEN,`, `(PROBEOPEN` (the engine's comment
//   sanitiser defuses them); the order of execution selects the tool (T) before the change (M6),
//   and applies length compensation (G43) after it.
// - "G-codes" (https://linuxcnc.org/docs/html/gcode/g-code.html): G64 P is the path blending
//   tolerance ("G64 without P means to keep the best speed possible, no matter how far away from
//   the programmed point you end up"); "G43 Hn uses the offset for tool n"; G81 and G83 (G83
//   pecks by Q from the R plane, retracts to R, and comes back down to "the current hole bottom,
//   less .010 of an inch or 0.254 mm"); G99 retracts to R; G4 P is in seconds; a centre format arc
//   is refused when its radii differ by more than 0.5 mm, or by more than both 0.005 mm and 0.1%
//   of the radius, which is Grbl's rule.
// - "M-codes" (https://linuxcnc.org/docs/html/gcode/m-code.html): M6 changes to the tool the last
//   T selected; with `hal_manualtoolchange` it stops the spindle and prompts the operator.

import type { CamResult } from '../types';
import { compileDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

/**
 * The `linuxcnc` dialect record: `%` around the program, `G91.1` in the header (incremental IJ,
 * whatever the configuration's startup codes), `G64 P<tolerance>` after the modes line, `M6 T<n>`
 * and `G43 H<n>` at every tool change in one file. `gCodes` and `mCodes` are the codes of the
 * documentation's lists that matter to a 3-axis mill post, not every code LinuxCNC has.
 */
export const LINUXCNC_DIALECT: Dialect = {
  id: 'linuxcnc',
  name: 'LinuxCNC',
  gCodes: [
    'G0',
    'G1',
    'G2',
    'G3',
    'G4',
    'G10',
    'G17',
    'G18',
    'G19',
    'G20',
    'G21',
    'G28',
    'G28.1',
    'G30',
    'G30.1',
    'G38.2',
    'G38.3',
    'G38.4',
    'G38.5',
    'G40',
    'G41',
    'G42',
    'G43',
    'G43.1',
    'G49',
    'G53',
    'G54',
    'G55',
    'G56',
    'G57',
    'G58',
    'G59',
    'G61',
    'G61.1',
    'G64',
    'G73',
    'G80',
    'G81',
    'G82',
    'G83',
    'G85',
    'G86',
    'G89',
    'G90',
    'G90.1',
    'G91',
    'G91.1',
    'G92',
    'G92.1',
    'G92.2',
    'G92.3',
    'G93',
    'G94',
    'G95',
    'G98',
    'G99',
  ],
  mCodes: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M30', 'M60'],
  toolChange: 'm6',
  splitPerTool: false,
  cannedCycles: true,
  fullCircles: 'halves',
  comments: 'parentheses',
  // 256 characters a line; the dialect format's limit is 255.
  maxLineLength: 255,
  programDelimiter: true,
  dwellUnit: 'seconds',
  decimals: {
    mm: { coordinate: 3, feed: 0 },
    inch: { coordinate: 4, feed: 1 },
    spindle: 0,
    dwell: 3,
  },
  // A T word is the tool's number in the tool table; any whole number, up to the format's limit.
  maxToolNumber: 99999999,
  toolLengthOffset: true,
  pathBlending: true,
  templates: {
    header: [
      '(Job: {job})',
      '(Setup: {setup})',
      '(Posted {date} for {post}, {units})',
      '(Zero X, Y and Z at: {origin})',
      '(Tools in this file: {tool_count})',
      'G91.1',
    ],
    tool: ['(Tool {tool}: {tool_name}, diameter {tool_diameter} {units})'],
    toolChange: [
      '(Tool {tool}: {tool_name})',
      '(Spindle {rpm} rpm, cutting feed {feed} {units}/min)',
    ],
    footer: ['M30'],
  },
};

function compileLinuxCnc(): CompiledDialect {
  const compiled = compileDialect(LINUXCNC_DIALECT);
  // The record above is constant; a failure here is a bug in it, caught by the tests.
  if (!compiled.ok) throw new Error(`The linuxcnc dialect is invalid: ${compiled.error.message}`);
  return compiled.value;
}

/** `LINUXCNC_DIALECT`, checked and frozen once. */
export const LINUXCNC: CompiledDialect = compileLinuxCnc();

/** Options for the LinuxCNC post: one file with `M6 T<n>` and `G43 H<n>` at each tool. */
export interface LinuxCncOptions extends Omit<PostOptions, 'toolChange' | 'splitPerTool'> {
  /** Write drill cycles as G81 and G83 (see `PostOptions.cannedCycles`). False when absent. */
  readonly cannedCycles?: boolean;
}

/** Write `job` for LinuxCNC: `postProcess` with the `linuxcnc` dialect. */
export function postLinuxCnc(job: PostJob, options: LinuxCncOptions = {}): CamResult<PostOutput> {
  return postProcess(job, LINUXCNC, { ...options, toolChange: 'm6', splitPerTool: false });
}
