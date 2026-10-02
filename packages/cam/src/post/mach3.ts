// The Mach3 post-processor (M5 plan, T5.4c): the `mach3` dialect, for Mach3Mill. Dialect data on
// top of the engine in `writer.ts`; this file holds no G-code logic of its own.
//
// Source: ArtSoft, "Using Mach3Mill", revision 1.84-A2, chapter 10 "G and M-code reference"
// (https://www.machsupport.com/wp-content/uploads/2013/02/Mach3Mill_1.84.pdf, read 2026-10-02):
// - 10.5: at most 256 characters a line; 10.5.5: "A line that starts with the percent
//   character, %, is treated as a comment", parenthesised comments that may not nest, `//` to
//   the end of a line, and `(MSG,` messages (the engine's comment sanitiser defuses them);
// - figure 10.4 and 10.7: the G and M codes below; 10.7.19: G61 exact stop and G64 constant
//   velocity, with no tolerance word;
// - 10.7.3.2: a centre format arc is an error when its radii differ by more than 0.0002 inch or
//   0.002 mm, much stricter than Grbl;
// - 10.7.4 and 10.1.9: G4's P is in seconds or milliseconds as Config > Logic sets ("G04 Dwell
//   param in Milliseconds");
// - 10.7.26: incremental IJ mode (G91.1) is a configuration setting too;
// - 10.8.3: M6 runs the M6Start macro and waits for Cycle Start (unless tool changes are set to be
//   ignored); 10.10.3: "The T word, itself, does not actually apply any offsets. Use G43", and "It
//   is an error if ... a T number larger than 255 is used".

import type { CamResult } from '../types';
import { compileDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

/**
 * The `mach3` dialect record: `%` around the program, `G91.1` in the header (Mach3 can be
 * configured for absolute IJ, which would misread every arc), `M6 T<n>` and `G43 H<n>` at every
 * tool change in one file, arcs within Mach3's 0.002 mm radius rule, dwells in seconds (a machine
 * set to milliseconds then dwells a thousandth as long, where the other way round it would dwell a
 * thousand times as long), no G64 (it has no tolerance in Mach3, so the machine's own mode holds).
 */
export const MACH3_DIALECT: Dialect = {
  id: 'mach3',
  name: 'Mach3',
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
    'G31',
    'G40',
    'G41',
    'G42',
    'G43',
    'G49',
    'G53',
    'G54',
    'G55',
    'G56',
    'G57',
    'G58',
    'G59',
    'G61',
    'G64',
    'G73',
    'G80',
    'G81',
    'G82',
    'G83',
    'G85',
    'G86',
    'G88',
    'G89',
    'G90',
    'G90.1',
    'G91',
    'G91.1',
    'G92',
    'G92.1',
    'G93',
    'G94',
    'G95',
    'G98',
    'G99',
  ],
  mCodes: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M30'],
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
  maxToolNumber: 255,
  toolLengthOffset: true,
  arcRadiusTolerance: { mm: 0.002, inch: 0.0002 },
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

function compileMach3(): CompiledDialect {
  const compiled = compileDialect(MACH3_DIALECT);
  // The record above is constant; a failure here is a bug in it, caught by the tests.
  if (!compiled.ok) throw new Error(`The mach3 dialect is invalid: ${compiled.error.message}`);
  return compiled.value;
}

/** `MACH3_DIALECT`, checked and frozen once. */
export const MACH3: CompiledDialect = compileMach3();

/** Options for the Mach3 post: one file with `M6 T<n>` and `G43 H<n>` at each tool. */
export interface Mach3Options extends Omit<PostOptions, 'toolChange' | 'splitPerTool'> {
  /** Write drill cycles as G81 and G83 (see `PostOptions.cannedCycles`). False when absent. */
  readonly cannedCycles?: boolean;
}

/** Write `job` for Mach3: `postProcess` with the `mach3` dialect. */
export function postMach3(job: PostJob, options: Mach3Options = {}): CamResult<PostOutput> {
  return postProcess(job, MACH3, { ...options, toolChange: 'm6', splitPerTool: false });
}
