// The Carbide Motion post-processor (M5 plan, T5.4c): the `carbide-motion` dialect, for Grbl
// 1.1 Shapeokos run from Carbide Motion, the sender Carbide 3D ships. Dialect data on top of the
// engine in `writer.ts`; this file holds no G-code logic of its own.
//
// Sources (read 2026-10-02):
// - Carbide 3D, "Supported G-codes and M-codes" (https://guides.carbide3d.com/faq/supported-gcodes/):
//   G0 to G4, G17 to G19, G20, G21, G28, G28.2, G90, G91; "G40, G43, G49 (Accepted but ignored)";
//   "G54-G59 (Accepted but ignored)", with "Carbide Motion uses work coordinate systems internal
//   and care must be taken when interacting with them"; M0, M1, M2, M30, M3, M5, M6 ("implemented
//   in Carbide Motion to facilitate the Nomad tool length sensor"), "M7, M9 (Accepted but
//   ignored)". The page dates from the Nomad and Shapeoko 3; it is taken as a floor.
// - Shapeoko CNC A to Z, "CAD, CAM and G-code"
//   (https://shapeokoenthusiasts.gitbook.io/shapeoko-cnc-a-to-z/cad-cam-tools): "M6 T112
//   corresponds to a Tool Change command ... On a Shapeoko ... this is ignored by the machine (but
//   used by Carbide Motion to trigger a user prompt)"; on a trim router, M3, M5 and S "have no
//   visible effect"; comments are in parentheses.
// - Carbide 3D, "BitSetter changes in Carbide Motion"
//   (https://carbide3d.com/blog/bitsetter-changes-carbide-motion/): with a BitSetter, Carbide Motion
//   measures each new tool at the change, so Z is zeroed once per job.
// - Carbide 3D community, "Tool naming on M6?" (https://community.carbide3d.com/t/tool-naming-on-m6/89851,
//   2025-05): Carbide Create 8 writes a `(TOOL <n>: <name>)` comment per tool, and Carbide Motion
//   names the tool at the M6 prompt from its own library by number.
//
// Not verified on a machine (M5 plan, T5.7b): whether Carbide Motion forwards a T word to Grbl,
// which refuses a T above 255 with error 38. Carbide Create's own library numbers its V-bits #301
// and #302 and writes them in `M6 T<n>`, which suggests Carbide Motion takes the line itself;
// `maxToolNumber` allows Carbide's three-digit catalogue numbers on that evidence.

import type { CamResult } from '../types';
import { compileDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

/**
 * The `carbide-motion` dialect record. `gCodes` and `mCodes` are Carbide 3D's list, less the work
 * offsets G54 to G59: Carbide Motion owns the work coordinates, so the post never selects one
 * (and writes no G10). No G94 and no G91.1 (not in the list; Grbl's defaults hold). `M6 T<n>` at
 * every tool change, the first included, in one file: Carbide Motion prompts for the tool and the
 * BitSetter measures it. G43 is accepted but ignored, so no tool length offset is written.
 */
export const CARBIDE_MOTION_DIALECT: Dialect = {
  id: 'carbide-motion',
  name: 'Carbide Motion',
  gCodes: [
    'G0',
    'G1',
    'G2',
    'G3',
    'G4',
    'G17',
    'G18',
    'G19',
    'G20',
    'G21',
    'G28',
    'G28.2',
    'G40',
    'G43',
    'G49',
    'G90',
    'G91',
  ],
  mCodes: ['M0', 'M1', 'M2', 'M3', 'M5', 'M6', 'M7', 'M9', 'M30'],
  toolChange: 'm6',
  splitPerTool: false,
  cannedCycles: false,
  fullCircles: 'halves',
  comments: 'parentheses',
  // The controller is Grbl 1.1: its 80-character line buffer (`protocol.h`) applies.
  maxLineLength: 79,
  programDelimiter: false,
  dwellUnit: 'seconds',
  decimals: {
    mm: { coordinate: 3, feed: 0 },
    inch: { coordinate: 4, feed: 1 },
    spindle: 0,
    dwell: 3,
  },
  // Carbide's catalogue numbers have three digits (#201, #302); unverified, see above.
  maxToolNumber: 999,
  templates: {
    header: [
      '(Job: {job})',
      '(Setup: {setup})',
      '(Posted {date} for {post}, {units})',
      '(Zero X, Y and Z at: {origin})',
      '(Tools in this file: {tool_count})',
    ],
    // Carbide Create 8's tool comment.
    tool: ['(TOOL {tool}: {tool_name}, diameter {tool_diameter} {units})'],
    toolChange: [
      '(TOOL {tool}: {tool_name})',
      '(Spindle {rpm} rpm, cutting feed {feed} {units}/min)',
    ],
    footer: ['M30'],
  },
};

function compileCarbideMotion(): CompiledDialect {
  const compiled = compileDialect(CARBIDE_MOTION_DIALECT);
  // The record above is constant; a failure here is a bug in it, caught by the tests.
  if (!compiled.ok) {
    throw new Error(`The carbide-motion dialect is invalid: ${compiled.error.message}`);
  }
  return compiled.value;
}

/** `CARBIDE_MOTION_DIALECT`, checked and frozen once. */
export const CARBIDE_MOTION: CompiledDialect = compileCarbideMotion();

/** Options for the Carbide Motion post: one file, `M6 T<n>` at each tool, no canned cycles. */
export type CarbideMotionOptions = Omit<
  PostOptions,
  'toolChange' | 'splitPerTool' | 'cannedCycles' | 'toolLengthOffset'
>;

/** Write `job` for Carbide Motion: `postProcess` with the `carbide-motion` dialect. */
export function postCarbideMotion(
  job: PostJob,
  options: CarbideMotionOptions = {},
): CamResult<PostOutput> {
  return postProcess(job, CARBIDE_MOTION, {
    ...options,
    toolChange: 'm6',
    splitPerTool: false,
    cannedCycles: false,
    toolLengthOffset: false,
  });
}
