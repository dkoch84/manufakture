// Generate on demand (M5 plan, T5.3a; ADR 0014 decisions 7 and 8; moved from the app in M8 plan
// T8.1b): the geometry stage's reply for one setup (regen: sources resolved on the final body,
// expressions evaluated, depths in machine Z) turned into `packages/cam`'s evaluated `Setup` (stock
// box, WCS frame, loops and drill points in machine coordinates, the body's mesh for a 3D
// surfacing), which the CAM worker generates. Only operations whose geometry resolved go to the
// worker; the others keep the stage's errors. A V-carve with a clearing tool goes as two
// operations, its clearing first. Nothing here evaluates an expression or resolves a name: the
// stage did both.

import {
  boundsInSetup,
  drillPointToMachine,
  meshToMachine,
  planarLoopsToMachine,
  setupRotation,
  stockFromBounds,
  stockFromSize,
  wcsFrame,
  wcsOriginInSetup,
  type Loop2,
  type MachineDrillPoint,
  type Mesh,
  type OperationInput,
  type VCarveClearing,
  type VCarveClearingInput,
  type VCarveOperation,
  type Setup,
  type Stock,
  type WcsFrame,
} from '../index';
import type { CamGeometryResult, CamOperationResult, CamSourceResult } from '@manufakture/regen';

/**
 * A V-carve with a clearing tool is generated as two operations (T5.5b): its clearing, with the
 * end mill and this suffix on the V-carve's id, then the carve itself. The clearing has no row of
 * its own in the document; the workspace reports it on its V-carve (`documentOperation`).
 */
export const CLEARING_SUFFIX = '/clearing';

/** The document operation a generated operation id belongs to: a clearing's V-carve, else itself. */
export function documentOperation(id: string): string {
  return id.endsWith(CLEARING_SUFFIX) ? id.slice(0, -CLEARING_SUFFIX.length) : id;
}

/** How far, mm, the stock's machine Z range may be from the stage's before `setupInput` refuses. */
export const STOCK_Z_TOLERANCE = 1e-6;

export type SetupBuild =
  | {
      ok: true;
      setup: Setup;
      /** Operations whose geometry did not convert (not parallel, say), with why, by id. */
      failed: Readonly<Record<string, string>>;
    }
  | { ok: false; message: string };

/**
 * The stock box in the setup frame, from the body's model-space bounds and the values. It is the
 * box of the bounds' corners in the setup frame (`boundsInSetup`), the same box the geometry stage
 * measures the stock's Z range on (`stockZ`, and from it every machine-Z depth, hole depth and
 * source height). It never depends on the mesh: for a tilted face up the mesh's tight bounds are
 * shorter than the corners' box, so a stock from them would put machine Z 0 somewhere other than
 * the stage's, and every depth would cut by the difference. `setupInput` checks the two agree.
 */
export function stockOf(
  geometry: CamGeometryResult,
): { ok: true; stock: Stock } | { ok: false; message: string } {
  const values = geometry.setup;
  if (!values || !geometry.bounds)
    return { ok: false, message: 'The setup has no body to machine.' };
  const rotation = setupRotation(values.wcs.up);
  if (!rotation.ok) return { ok: false, message: rotation.error.message };
  const body = boundsInSetup(rotation.value, geometry.bounds);
  const s = values.stock;
  const r =
    s.kind === 'fromBody'
      ? stockFromBounds(body, s.margins, s.material)
      : stockFromSize(body, s.size, s.offset, s.material);
  return r.ok ? { ok: true, stock: r.value } : { ok: false, message: r.error.message };
}

/**
 * The stock's outline in machine XY, counter-clockwise: what a facing with no source faces. The
 * setup frame's axes are the machine's, so a machine point is a setup point less the WCS origin.
 */
export function stockOutline(stock: Stock, origin: readonly number[]): Loop2 {
  const [ox, oy] = origin as [number, number];
  const x0 = stock.min[0] - ox;
  const y0 = stock.min[1] - oy;
  const x1 = stock.max[0] - ox;
  const y1 = stock.max[1] - oy;
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return {
    segments: corners.map((start, i) => ({
      kind: 'line' as const,
      start,
      end: corners[(i + 1) % 4]!,
    })),
  };
}

function loopsOf(
  frame: WcsFrame,
  sources: readonly CamSourceResult[],
): { ok: true; loops: Loop2[] } | { ok: false; message: string } {
  const loops: Loop2[] = [];
  for (const s of sources) {
    if (s.kind !== 'face' && s.kind !== 'region') continue;
    const r = planarLoopsToMachine(frame, s.planar);
    if (!r.ok) return { ok: false, message: r.error.message };
    loops.push(...r.value.loops);
  }
  return { ok: true, loops };
}

function pointsOf(
  frame: WcsFrame,
  sources: readonly CamSourceResult[],
): { ok: true; points: MachineDrillPoint[] } | { ok: false; message: string } {
  const points: MachineDrillPoint[] = [];
  for (const s of sources) {
    if (s.kind !== 'hole' && s.kind !== 'holeWalls') continue;
    for (const p of s.points) {
      const r = drillPointToMachine(frame, p);
      if (!r.ok) return { ok: false, message: r.error.message };
      points.push(r.value);
    }
  }
  return { ok: true, points };
}

/**
 * One resolved operation as the CAM worker's input, or why it cannot be. `mesh` is the body's mesh
 * in machine coordinates, which a 3D surfacing machines (null when the stage sent none).
 */
export function operationInput(
  op: CamOperationResult,
  frame: WcsFrame,
  facingArea: Loop2,
  mesh: Mesh | null = null,
): { ok: true; input: OperationInput } | { ok: false; message: string } | null {
  const v = op.values;
  if (op.status !== 'ok' || v === null) return null;
  switch (v.kind) {
    case 'facing': {
      const l = loopsOf(frame, op.sources);
      if (!l.ok) return l;
      return { ok: true, input: { ...v, loops: l.loops.length > 0 ? l.loops : [facingArea] } };
    }
    case 'profile':
    case 'pocket':
    case 'vcarve': {
      const l = loopsOf(frame, op.sources);
      if (!l.ok) return l;
      return { ok: true, input: { ...v, loops: l.loops } as OperationInput };
    }
    case 'drill': {
      const p = pointsOf(frame, op.sources);
      if (!p.ok) return p;
      return { ok: true, input: { ...v, points: p.points } };
    }
    case 'surface3d': {
      if (!mesh || mesh.indices.length === 0) {
        return { ok: false, message: 'The body has no mesh to machine: generate again.' };
      }
      // Faces and regions, when picked, bound the surfacing in machine XY.
      const l = loopsOf(frame, op.sources);
      if (!l.ok) return l;
      return {
        ok: true,
        input: { ...v, mesh, ...(l.loops.length > 0 ? { boundary: l.loops } : {}) },
      };
    }
  }
}

/** A V-carve input with a clearing tool (the clearing comes from the core schema's extras). */
function hasClearing(
  input: OperationInput,
): input is VCarveOperation & { readonly clearing: VCarveClearing } {
  return input.kind === 'vcarve' && 'clearing' in input && input.clearing !== undefined;
}

/**
 * The clearing of a V-carve input that has a clearing tool, as an operation of its own to cut
 * before it (`CLEARING_SUFFIX`); null for any other input.
 */
export function clearingInput(input: OperationInput): VCarveClearingInput | null {
  if (!hasClearing(input)) return null;
  const { clearing, ...carve } = input;
  return {
    kind: 'vcarveClearing',
    id: `${input.id}${CLEARING_SUFFIX}`,
    name: `${input.name} (clearing)`,
    tool: clearing.tool,
    feeds: clearing.feeds,
    carve,
    stepdown: clearing.stepdown,
    stepover: clearing.stepover,
    ...(clearing.entry ? { entry: clearing.entry } : {}),
  };
}

/** The evaluated setup the CAM worker takes, with every operation whose geometry resolved. */
export function setupInput(
  geometry: CamGeometryResult,
  setup: { id: string; name: string },
): SetupBuild {
  const values = geometry.setup;
  if (geometry.status !== 'ok' || !values) {
    return {
      ok: false,
      message: geometry.errors[0]?.message ?? 'The setup could not be resolved.',
    };
  }
  const stock = stockOf(geometry);
  if (!stock.ok) return stock;
  const wcs = { up: values.wcs.up, origin: values.wcs.origin };
  const frame = wcsFrame(wcs, stock.stock);
  if (!frame.ok) return { ok: false, message: frame.error.message };
  const origin = wcsOriginInSetup(stock.stock, wcs.origin);
  // The stage gave every depth in machine Z measured from its own stock: refuse rather than cut
  // with depths whose zero is not this stock's.
  const top = stock.stock.max[2] - origin[2];
  const bottom = stock.stock.min[2] - origin[2];
  if (
    !(Math.abs(top - values.stockZ.top) <= STOCK_Z_TOLERANCE) ||
    !(Math.abs(bottom - values.stockZ.bottom) <= STOCK_Z_TOLERANCE)
  ) {
    return {
      ok: false,
      message: `The stock's machine Z range (${top.toFixed(6)} to ${bottom.toFixed(6)} mm) does not match the depths' (${values.stockZ.top.toFixed(6)} to ${values.stockZ.bottom.toFixed(6)} mm): generate again, and report this if it persists.`,
    };
  }
  const facingArea = stockOutline(stock.stock, origin);
  const operations: OperationInput[] = [];
  const failed: Record<string, string> = {};
  // The body's mesh in machine coordinates, once, for every 3D surfacing.
  let mesh: Mesh | null | undefined;
  const machineMesh = () =>
    (mesh ??= geometry.mesh ? meshToMachine(geometry.mesh, frame.value) : null);
  for (const op of geometry.operations) {
    const r = operationInput(
      op,
      frame.value,
      facingArea,
      op.kind === 'surface3d' ? machineMesh() : null,
    );
    if (r === null) continue;
    if (!r.ok) {
      failed[op.operationId] = r.message;
      continue;
    }
    const clearing = clearingInput(r.input);
    if (clearing) operations.push(clearing);
    operations.push(r.input);
  }
  return {
    ok: true,
    setup: {
      id: setup.id,
      name: setup.name,
      stock: stock.stock,
      wcs,
      frame: frame.value,
      heights: values.heights,
      machine: values.machine,
      post: values.post,
      operations,
    },
    failed,
  };
}
