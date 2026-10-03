// A small generation for the export's tests: 100 x 60 x 10 mm plywood, the WCS on its top
// front-left corner, two numbered tools and three operations with hand-made toolpaths, in this
// order: a shallow square with the flat end mill (`Clean`), a square with the V-bit (`Recess`),
// and a square through the stock with the flat end mill again (`Outline`). Unordered, the job
// changes tools three times (flat, V-bit, flat); grouped by tool, twice, with the through-cut
// moved ahead of the V-bit's cut.

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
import type { GeneratedToolpaths } from '../preview/job';

export const flat: Tool = {
  id: 'tool#1',
  name: '#201 1/4" flat',
  kind: 'flat',
  number: 201,
  diameter: 6.35,
  fluteLength: 19,
  flutes: 2,
};

export const vbit: Tool = {
  id: 'tool#2',
  name: '#302 60 deg V-bit',
  kind: 'vbit',
  number: 302,
  diameter: 12.7,
  fluteLength: 10,
  flutes: 2,
  angle: Math.PI / 3,
};

export const STOCK = { min: [0, 0, 0], max: [100, 60, 10], material: 'plywood' } as const;
/** The stock in WCS coordinates (the origin on its top front-left corner). */
export const STOCK_WCS = { min: [0, 0, -10], max: [100, 60, 0] } as const;

/** A square of side `size` from (x, y), plunged to `z`, starting and ending 5 mm above the top. */
export function square(op: string, x: number, y: number, size: number, z: number): Toolpath {
  const at = (px: number, py: number, pz: number) => [px, py, pz] as [number, number, number];
  const cut = (px: number, py: number) =>
    ({ kind: 'linear', op, pass: 0, to: at(px, py, z), feed: 1000, feedClass: 'cut' }) as const;
  return {
    start: at(x, y, 5),
    entries: [
      { kind: 'rapid', op, pass: 0, to: at(x, y, 2) },
      { kind: 'linear', op, pass: 0, to: at(x, y, z), feed: 300, feedClass: 'plunge' },
      cut(x + size, y),
      cut(x + size, y + size),
      cut(x, y + size),
      cut(x, y),
      { kind: 'rapid', op, pass: 0, to: at(x, y, 5) },
    ],
  };
}

const wcs: Wcs = { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } };

function operation(id: string, name: string, tool: Tool, spindle: number): OperationInput {
  return {
    id,
    kind: 'pocket',
    name,
    tool,
    feeds: { spindle, cut: 1000, plunge: 300 },
    loops: [],
    depth: { top: 0, bottom: -1 },
    stepdown: 1,
    stepover: 0.4,
    finishAllowance: 0,
    entry: { kind: 'plunge' },
    climb: true,
  };
}

export const TOOLPATHS: Readonly<Record<string, Toolpath>> = {
  'pocket#1': square('pocket#1', 70, 30, 10, -1),
  'pocket#2': square('pocket#2', 60, 10, 10, -2),
  'profile#1': square('profile#1', 10, 10, 30, -10),
};

export function exportSetup(tools: { flat?: Tool; vbit?: Tool } = {}): Setup {
  const f = tools.flat ?? flat;
  const v = tools.vbit ?? vbit;
  const frame = wcsFrame(wcs, STOCK);
  if (!frame.ok) throw new Error(frame.error.message);
  return {
    id: 'setup#1',
    name: 'Top',
    stock: STOCK,
    wcs,
    frame: frame.value,
    heights: { clearance: 15, retract: 5 },
    machine: 'shapeoko-5-pro-4x4',
    post: 'carbide-motion',
    operations: [
      operation('pocket#1', 'Clean', f, 18000),
      operation('pocket#2', 'Recess', v, 24000),
      { ...operation('profile#1', 'Outline', f, 18000), kind: 'profile' } as OperationInput,
    ],
  };
}

function result(id: string): CamOperationResult {
  return {
    id,
    kind: 'pocket',
    key: id,
    cached: false,
    ms: 1,
    ok: true,
    toolpath: packToolpath(TOOLPATHS[id]!),
    warnings: [],
  };
}

/** Every operation generated; `failed` names one whose generation failed instead. */
export function exportGeneration(
  options: { failed?: string; tools?: { flat?: Tool; vbit?: Tool } } = {},
): GeneratedToolpaths {
  const setup = exportSetup(options.tools);
  return {
    setupId: 'setup#1',
    setup,
    rapidRate: 5000,
    operations: setup.operations.map((op) =>
      op.id === options.failed
        ? {
            id: op.id,
            kind: op.kind,
            key: op.id,
            cached: false,
            ms: 1,
            ok: false,
            error: { code: 'invalid-input', message: 'The tool does not fit inside the profile.' },
          }
        : result(op.id),
    ),
  };
}

/** The document's operations matching the generation (names, order, none suppressed). */
export const DOC_OPERATIONS = [
  { id: 'pocket#1', name: 'Clean', suppressed: false },
  { id: 'pocket#2', name: 'Recess', suppressed: false },
  { id: 'profile#1', name: 'Outline', suppressed: false },
];
