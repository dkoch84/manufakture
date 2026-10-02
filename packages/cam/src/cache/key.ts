// Toolpath cache keys (ADR 0014 decision 9): equal keys mean equal toolpaths, so an entry never
// needs invalidating by hand and a missing entry is only ever a miss. The app computes the keys
// to mark operations stale (ADR 0014 decision 8) and sends them with each request; the CAM
// worker computes the same key itself when a request carries none.

import type { OperationInput, Setup } from '../types';
import { hashValue } from './hash';

/**
 * Bump with any change to CAM code that can change a toolpath (an operation, linking, the offset
 * engine's tolerances or scale), so toolpaths computed by older code are never served.
 */
export const CAM_IMPLEMENTATION_VERSION = 1;

/** The polygon library build every 2D toolpath goes through (packages/cam/package.json). */
export const POLYGON_LIBRARY = 'clipper2-ts@2.0.1-18';

/**
 * The drop-cutter build for `surface3d` (ADR 0014 decision 13): this package's own TypeScript
 * drop-cutter, versioned here until T5.5a gives it a version of its own.
 */
export const DROP_CUTTER = 'manufakture-drop-cutter@1';

export interface ToolpathKeyVersions {
  readonly implementation: number;
  readonly polygonLibrary: string;
  /** Hashed only into `surface3d` keys. */
  readonly dropCutter: string;
}

export const DEFAULT_KEY_VERSIONS: ToolpathKeyVersions = {
  implementation: CAM_IMPLEMENTATION_VERSION,
  polygonLibrary: POLYGON_LIBRARY,
  dropCutter: DROP_CUTTER,
};

export interface ToolpathKeyInput {
  /** The evaluated operation, its tool, feeds and extracted geometry included; not its `name`. */
  readonly operation: OperationInput;
  /**
   * The evaluated setup: stock, WCS, frame, heights, id and machine id. Its `operations`, `name`
   * and `post` are not hashed.
   */
  readonly setup: Setup;
  /** The machine table row the setup uses (T5.1d), when the caller has it. */
  readonly machine?: unknown;
}

/**
 * The cache key of one operation's toolpath: a hash of the evaluated operation without its name
 * (its geometry is part of it, so an edit elsewhere on the part that leaves its loops alone still
 * hits), the setup without its operation list, name and post, the machine row, and the versions
 * that can change the output.
 */
export function toolpathKey(
  input: ToolpathKeyInput,
  versions: ToolpathKeyVersions = DEFAULT_KEY_VERSIONS,
): string {
  // What generators may not read (worker/registry.ts) stays out, so renaming an operation or a
  // setup, or switching posts, keeps every toolpath.
  const setup: Record<string, unknown> = { ...input.setup };
  delete setup.operations;
  delete setup.name;
  delete setup.post;
  const operation: Record<string, unknown> = { ...input.operation };
  delete operation.name;
  const used: Record<string, unknown> = { ...versions };
  if (input.operation.kind !== 'surface3d') delete used.dropCutter;
  return hashValue({
    versions: used,
    operation,
    setup,
    machine: input.machine,
  });
}
