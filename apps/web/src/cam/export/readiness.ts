// What a setup needs before it can be exported (M5 plan, T5.4e), from the Manufacture workspace's
// state: every operation generated from its current inputs, none with an error. The export itself
// is `@manufakture/cam/export`'s; this judges whether the workspace's last generation may go to it.

import type { GeneratedToolpaths } from '@manufakture/cam/export';
import type { CamOperation, CamSetup } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { operationStatus, type GeneratedOutcome } from '../status';

/** An operation that stops the export, and why. */
export interface ExportBlocker {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface ExportReadiness {
  /** Operations with an error: the export refuses until they are fixed or suppressed. */
  readonly blocked: readonly ExportBlocker[];
  /** Operations to generate first: never generated, or generated from inputs that changed. */
  readonly stale: readonly string[];
  /** Why the export cannot run at all (no operation to cut, say); null when it can. */
  readonly message: string | null;
  /**
   * The geometry is not known to be the current document's (an edit since, or no reply yet):
   * every operation counts as stale until a reply for the document as it is now arrives.
   */
  readonly pending: boolean;
}

/**
 * What the setup needs before it can be exported, from the workspace's state: the last geometry
 * reply, the last generation's outcomes and toolpaths, and whether there is a geometry stage at
 * all (`available`). Suppressed operations are left out. `current` says whether `geometry` was
 * resolved for the document as it is now; when it was not (the document changed since, and the
 * reply for the edit has not come), every operation is pending: an edit to the stock, heights,
 * feeds or model may change any of them, and their keys cannot tell until the new reply.
 */
export function exportReadiness(
  setup: Pick<CamSetup, 'id' | 'operations'>,
  geometry: CamGeometryResult | null,
  generated: ReadonlyMap<string, GeneratedOutcome>,
  toolpaths: GeneratedToolpaths | null,
  available: boolean,
  current = true,
): ExportReadiness {
  const active = setup.operations.filter((op) => !op.suppressed);
  if (active.length === 0) {
    return {
      blocked: [],
      stale: [],
      pending: false,
      message:
        setup.operations.length === 0
          ? 'This setup has no operations to export.'
          : 'Every operation of this setup is suppressed: nothing to export.',
    };
  }
  const unavailable =
    'Toolpaths need the geometry kernel and the CAM worker, which are not running here.';
  if (!current) {
    return {
      blocked: [],
      stale: active.map((op) => op.id),
      message: available ? null : unavailable,
      pending: true,
    };
  }
  const shownGeometry = geometry?.setupId === setup.id ? geometry : null;
  const results = toolpaths?.setupId === setup.id ? toolpaths.operations : [];
  const blocked: ExportBlocker[] = [];
  const stale: string[] = [];
  for (const op of active) {
    const status = operationStatus(op, shownGeometry, generated, available);
    if (status.state === 'error') {
      blocked.push(blocker(op, status.errors.join(' ') || 'Its geometry has an error.'));
      continue;
    }
    const result = results.find((r) => r.id === op.id);
    if (status.toolpath === 'failed' && !status.stale) {
      const outcome = generated.get(op.id);
      blocked.push(blocker(op, outcome?.message ?? 'Its toolpath could not be generated.'));
    } else if (
      status.state === 'pending' ||
      status.toolpath === 'none' ||
      status.stale ||
      result === undefined
    ) {
      stale.push(op.id);
    } else if (!result.ok) {
      blocked.push(blocker(op, result.error.message));
    }
  }
  const message = stale.length > 0 && !available ? unavailable : null;
  return { blocked, stale, message, pending: false };
}

function blocker(op: CamOperation, message: string): ExportBlocker {
  return { id: op.id, name: op.name, message };
}
