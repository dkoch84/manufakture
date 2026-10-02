// The GRBL post-processor (M5 plan, T5.4b): the `grbl` dialect for Grbl 1.1, the firmware of the
// Shapeoko 4 (and the base of the Shapeoko 5 Pro's grblHAL). Dialect data on top of the engine
// in `writer.ts`; this file holds no G-code logic of its own.
//
// What Grbl 1.1 takes is read from `grbl/gcode.c`, `gcode.h` and `protocol.h` (gnea/grbl, the
// v1.1 command list): no M6 (error 20), no canned cycles, T at most 255 (error 38, and only
// parsed, never acted on), lines under 80 characters, IJK arcs.

import type { CamResult } from '../types';
import { compileDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

/**
 * The `grbl` dialect record. `gCodes` and `mCodes` are everything Grbl 1.1 accepts in its
 * default build (M7 only when compiled in, so not listed); the engine writes only G0 to G4, G17,
 * G20 or G21, G90, G94, M0, M3, M5 and M30 of them. No tool change command: a job with several
 * tools is one file per tool, or one file with an `M0` pause per change (`postGrbl`'s
 * `multiTool: 'pause'`).
 */
export const GRBL_DIALECT: Dialect = {
  id: 'grbl',
  name: 'Grbl 1.1',
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
    'G80',
    'G90',
    'G91',
    'G91.1',
    'G92',
    'G92.1',
    'G93',
    'G94',
  ],
  mCodes: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M8', 'M9', 'M30'],
  toolChange: 'none',
  splitPerTool: true,
  cannedCycles: false,
  fullCircles: 'halves',
  comments: 'parentheses',
  // protocol.c keeps at most LINE_BUFFER_SIZE - 1 = 79 characters of a line (spaces and comments
  // are not counted) and fails a longer one with error 11; 79 for the whole line is safe.
  maxLineLength: 79,
  programDelimiter: false,
  dwellUnit: 'seconds',
  decimals: {
    mm: { coordinate: 3, feed: 0 },
    inch: { coordinate: 4, feed: 1 },
    spindle: 0,
    dwell: 3,
  },
  maxToolNumber: 255,
  templates: {
    // The engine's modes line follows the tool list: `G21 G90 G17 G94` (or G20).
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

function compileGrbl(): CompiledDialect {
  const compiled = compileDialect(GRBL_DIALECT);
  // The record above is constant; a failure here is a bug in it, caught by the tests.
  if (!compiled.ok) throw new Error(`The grbl dialect is invalid: ${compiled.error.message}`);
  return compiled.value;
}

/** `GRBL_DIALECT`, checked and frozen once. */
export const GRBL: CompiledDialect = compileGrbl();

/**
 * How a job with several tools is written for Grbl: `files`, one file per tool (the default; the
 * operator loads each tool and sets Z zero before running its file), or `pause`, one file with an
 * `M0` and a comment at each change.
 */
export type GrblMultiTool = 'files' | 'pause';

export interface GrblOptions extends Omit<PostOptions, 'toolChange' | 'splitPerTool'> {
  readonly multiTool?: GrblMultiTool;
}

/** Write `job` for Grbl 1.1: `postProcess` with the `grbl` dialect. */
export function postGrbl(job: PostJob, options: GrblOptions = {}): CamResult<PostOutput> {
  const { multiTool = 'files', ...rest } = options;
  const pause = multiTool === 'pause';
  return postProcess(job, GRBL, {
    ...rest,
    toolChange: pause ? 'm0-pause' : 'none',
    splitPerTool: !pause,
  });
}
