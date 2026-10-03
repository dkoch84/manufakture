// A small generation for the preview's tests: a 60 x 40 x 10 mm stock, the WCS on its top
// front-left corner, and two operations with hand-made toolpaths (a rectangle with a plunge, and a
// circle with a helical ramp), packed as the CAM worker returns them.

import {
  packToolpath,
  wcsFrame,
  type CamOperationResult,
  type OperationInput,
  type Setup,
  type Tool,
  type Toolpath,
  type Wcs,
} from '@manufakture/cam';
import type { GeneratedToolpaths } from './job';

export const flat6: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
};

export const vbit: Tool = {
  id: 'tool#2',
  name: '90 degree V-bit',
  kind: 'vbit',
  diameter: 12,
  fluteLength: 8,
  flutes: 2,
  angle: Math.PI / 2,
};

/** The rectangle: rapid down to 2, plunge to -2, four cuts, rapid up. Seven moves. */
export const rectangle: Toolpath = {
  start: [10, 10, 5],
  entries: [
    { kind: 'rapid', op: 'profile#1', pass: 0, to: [10, 10, 2] },
    { kind: 'linear', op: 'profile#1', pass: 0, to: [10, 10, -2], feed: 300, feedClass: 'plunge' },
    { kind: 'linear', op: 'profile#1', pass: 0, to: [50, 10, -2], feed: 1000, feedClass: 'cut' },
    { kind: 'linear', op: 'profile#1', pass: 0, to: [50, 30, -2], feed: 1000, feedClass: 'cut' },
    { kind: 'linear', op: 'profile#1', pass: 0, to: [10, 30, -2], feed: 1000, feedClass: 'cut' },
    { kind: 'linear', op: 'profile#1', pass: 0, to: [10, 10, -2], feed: 1000, feedClass: 'cut' },
    { kind: 'rapid', op: 'profile#1', pass: 0, to: [10, 10, 5] },
  ],
};

/** The circle about (30, 20), radius 5: a helical ramp turn down to -1, a full circle, up. */
export const circle: Toolpath = {
  start: [35, 20, 5],
  entries: [
    { kind: 'rapid', op: 'pocket#1', pass: 0, to: [35, 20, 1] },
    {
      kind: 'arc',
      op: 'pocket#1',
      pass: 0,
      to: [35, 20, -1],
      center: [30, 20],
      direction: 'ccw',
      fullCircle: true,
      feed: 500,
      feedClass: 'ramp',
    },
    {
      kind: 'arc',
      op: 'pocket#1',
      pass: 0,
      to: [35, 20, -1],
      center: [30, 20],
      direction: 'ccw',
      fullCircle: true,
      feed: 1000,
      feedClass: 'cut',
    },
    { kind: 'rapid', op: 'pocket#1', pass: 0, to: [35, 20, 5] },
  ],
};

const wcs: Wcs = { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } };
const stock = { min: [0, 0, 0] as const, max: [60, 40, 10] as const, material: 'plywood' };

function operation(id: string, name: string, tool: Tool): OperationInput {
  return {
    id,
    kind: 'profile',
    name,
    tool,
    feeds: { spindle: 18000, cut: 1000, plunge: 300 },
  } as unknown as OperationInput;
}

/** The evaluated setup: stock in the setup frame from (0, 0, 0), so machine = model - (0, 0, 10). */
export function fixtureSetup(): Setup {
  const frame = wcsFrame(wcs, stock);
  if (!frame.ok) throw new Error(frame.error.message);
  return {
    id: 'setup#1',
    name: 'Setup 1',
    stock,
    wcs,
    frame: frame.value,
    heights: { clearance: 10, retract: 3 },
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    operations: [operation('profile#1', 'Outline', flat6), operation('pocket#1', 'Bore', vbit)],
  };
}

function ok(id: string, toolpath: Toolpath): CamOperationResult {
  return {
    id,
    kind: 'profile',
    key: id,
    cached: false,
    ms: 1,
    ok: true,
    toolpath: packToolpath(toolpath),
    warnings: [],
  };
}

/** Both operations generated; `failed` makes the second an error instead. */
export function fixtureGeneration(options: { failed?: boolean } = {}): GeneratedToolpaths {
  return {
    setupId: 'setup#1',
    setup: fixtureSetup(),
    rapidRate: 5000,
    operations: [
      ok('profile#1', rectangle),
      options.failed
        ? {
            id: 'pocket#1',
            kind: 'profile',
            key: 'pocket#1',
            cached: false,
            ms: 1,
            ok: false,
            error: { code: 'invalid-input', message: 'No loops.' },
          }
        : ok('pocket#1', circle),
    ],
  };
}
