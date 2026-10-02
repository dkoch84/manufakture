// The grblHAL post-processor (M5 plan, T5.4c): the `grblhal` dialect, for grblHAL controllers
// (the Shapeoko 5 Pro's board family). Dialect data on top of the engine in `writer.ts`; this file
// holds no G-code logic of its own.
//
// Sources (read 2026-10-02):
// - grblHAL/core README (https://github.com/grblHAL/core): canned cycles G73, G81 to G83, G85,
//   G86, G89 with G98 and G99; G43, G43.1, G43.2, G49; G54 to G59.3; M6 "in two modes (manual
//   with jogging or ATC)", which depends on the driver and its configuration.
// - grblHAL/core `grbl/gcode.c`, `config.h` and `protocol.h` at 451a539 (the core the grblHAL
//   Simulator pinned by CI's `gcode-validate` job builds): G43 without G43.1 is refused unless the
//   controller has a tool table (`grbl.tool_table.n_tools`, 0 in the default build); G61 is taken
//   but G64 only with `ENABLE_PATH_BLENDING` (off by default); a T word goes up to
//   `MAX_TOOL_NUMBER` (2147483647) without a tool table; `LINE_BUFFER_SIZE` is 257 (256
//   characters and the terminator); the IJK arc checks are Grbl 1.1's.
//
// Caveats, kept as footnotes of the cam README's dialect table: M6 needs a driver and
// configuration with a tool change mode and, for a manual change, a sender that handles grblHAL's
// tool change protocol, so the default is Grbl's (one file per tool, or an M0 pause); and G43 H
// needs a tool table, so it is written only when asked for.

import type { CamResult } from '../types';
import { compileDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

/**
 * The `grblhal` dialect record. `gCodes` and `mCodes` are those grblHAL's parser takes in a
 * default build that the engine or a template may write, Grbl 1.1's list plus the canned cycles,
 * G43, G98 and G99, and M6. No G64 (path blending is off by default). Tool changes as in Grbl by
 * default; `postGrblHal`'s `multiTool: 'm6'` writes `M6 T<n>`.
 */
export const GRBLHAL_DIALECT: Dialect = {
  id: 'grblhal',
  name: 'grblHAL',
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
    'G73',
    'G80',
    'G81',
    'G82',
    'G83',
    'G85',
    'G86',
    'G89',
    'G90',
    'G91',
    'G91.1',
    'G92',
    'G92.1',
    'G93',
    'G94',
    'G98',
    'G99',
  ],
  mCodes: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M8', 'M9', 'M30'],
  toolChange: 'none',
  splitPerTool: true,
  cannedCycles: true,
  fullCircles: 'halves',
  comments: 'parentheses',
  // `protocol.h`: 256 characters; the dialect format's limit is 255.
  maxLineLength: 255,
  programDelimiter: false,
  dwellUnit: 'seconds',
  decimals: {
    mm: { coordinate: 3, feed: 0 },
    inch: { coordinate: 4, feed: 1 },
    spindle: 0,
    dwell: 3,
  },
  // Without a tool table any T up to 2147483647 parses; the dialect format's limit is 99999999.
  maxToolNumber: 99999999,
  templates: {
    header: [
      '(Job: {job})',
      '(Setup: {setup})',
      '(Posted {date} for {post}, {units}, file {file_index} of {file_count})',
      '(Zero X, Y and Z at: {origin})',
      '(Tools in this file: {tool_count})',
    ],
    tool: ['(Tool {tool}: {tool_name}, diameter {tool_diameter} {units})'],
    toolChange: [
      '(Tool {tool}: {tool_name})',
      '(Spindle {rpm} rpm, cutting feed {feed} {units}/min)',
    ],
    footer: ['M30'],
  },
};

function compileGrblHal(): CompiledDialect {
  const compiled = compileDialect(GRBLHAL_DIALECT);
  // The record above is constant; a failure here is a bug in it, caught by the tests.
  if (!compiled.ok) throw new Error(`The grblhal dialect is invalid: ${compiled.error.message}`);
  return compiled.value;
}

/** `GRBLHAL_DIALECT`, checked and frozen once. */
export const GRBLHAL: CompiledDialect = compileGrblHal();

/**
 * How a job with several tools is written for grblHAL: `files` (one file per tool, the default)
 * or `pause` (an `M0` per change) as for Grbl, or `m6`, one file with `M6 T<n>` at every tool
 * change, for a controller whose driver and configuration have a tool change mode and whose
 * sender handles a manual one.
 */
export type GrblHalMultiTool = 'files' | 'pause' | 'm6';

export interface GrblHalOptions extends Omit<
  PostOptions,
  'toolChange' | 'splitPerTool' | 'toolLengthOffset'
> {
  readonly multiTool?: GrblHalMultiTool;
  /**
   * With `multiTool: 'm6'`, write `G43 H<n>` after each `M6 T<n>`: only for a controller with a
   * tool table holding every tool's length. False when absent.
   */
  readonly toolLengthOffset?: boolean;
  /** Write drill cycles as G81 and G83 (see `PostOptions.cannedCycles`). False when absent. */
  readonly cannedCycles?: boolean;
}

/** Write `job` for grblHAL: `postProcess` with the `grblhal` dialect. */
export function postGrblHal(job: PostJob, options: GrblHalOptions = {}): CamResult<PostOutput> {
  const { multiTool = 'files', toolLengthOffset = false, ...rest } = options;
  return postProcess(job, GRBLHAL, {
    ...rest,
    toolChange: multiTool === 'files' ? 'none' : multiTool === 'pause' ? 'm0-pause' : 'm6',
    splitPerTool: multiTool === 'files',
    toolLengthOffset,
  });
}
