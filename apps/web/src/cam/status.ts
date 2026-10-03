// What the operation list shows per operation (M5 plan, T5.3a): its geometry status from the last
// geometry request (`ok` when the stage resolved its sources and evaluated its numbers; `error`
// with the stage's messages; the sources to re-pick), the outcome of the last generation, and a
// stale mark when the operation's inputs changed since its toolpath was generated (the stage's
// per-operation key moved; ADR 0014 decision 8), and the workspace's own advice on the setup's
// order (a 3D finish with nothing roughing before it).

import type { CamOperation, CamSetup } from '@manufakture/core';
import type { CamGeometryResult, CamOperationResult } from '@manufakture/regen';

/** One operation's toolpath, as the last generation left it. */
export interface GeneratedOutcome {
  /** The geometry key the toolpath was generated from. */
  readonly key: string;
  readonly ok: boolean;
  readonly message?: string;
  readonly warnings: readonly string[];
  /** Served from the CAM worker's cache. */
  readonly cached?: boolean;
}

export type OperationState = 'suppressed' | 'pending' | 'ok' | 'error' | 'unavailable';

export interface OperationStatus {
  readonly state: OperationState;
  /** Shown under the row and in its tooltip. */
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Indices of geometry sources to pick again (lost or ambiguous). */
  readonly repick: readonly number[];
  /** The toolpath: none yet, generated, or failed. */
  readonly toolpath: 'none' | 'generated' | 'failed';
  /** Generated from inputs that have changed since. */
  readonly stale: boolean;
}

export const STATE_LABELS: Readonly<Record<OperationState, string>> = {
  suppressed: 'Suppressed',
  pending: 'Resolving geometry',
  ok: 'Geometry resolved',
  error: 'Error',
  unavailable: 'Geometry not available here',
};

/**
 * Why a parallel 3D finish needs a roughing before it, or null: a finish with no z-level roughing
 * (unsuppressed) earlier in its setup takes the stock from the top down to the part in single
 * passes, and its default boundary (the part's extent) drops the tool to the part's lowest point
 * wherever the part does not fill it.
 */
export function roughingWarning(
  setup: Pick<CamSetup, 'operations'>,
  op: CamOperation,
): string | null {
  if (op.kind !== 'surface3d' || op.suppressed || (op.strategy ?? 'parallel') !== 'parallel') {
    return null;
  }
  const at = setup.operations.findIndex((o) => o.id === op.id);
  const roughed = setup.operations
    .slice(0, Math.max(0, at))
    .some((o) => o.kind === 'surface3d' && !o.suppressed && o.strategy === 'zlevel');
  return roughed
    ? null
    : 'Nothing roughs before this finish: it takes the stock from the top down to the part in one pass, and goes down to the lowest point wherever the part does not fill its boundary. Add a z-level roughing before it, unless the stock is already close to the part.';
}

/**
 * The status of `op` from the geometry reply for its setup (null while none has arrived, or
 * `available` false where there is no regen worker) and the last generation's outcomes. With its
 * `setup`, the workspace's advice on the setup's order (`roughingWarning`) is among the warnings.
 */
export function operationStatus(
  op: CamOperation,
  geometry: CamGeometryResult | null,
  generated: ReadonlyMap<string, GeneratedOutcome>,
  available = true,
  setup?: Pick<CamSetup, 'operations'>,
): OperationStatus {
  const advice = setup ? roughingWarning(setup, op) : null;
  const status = rawStatus(op, geometry, generated, available);
  return advice ? { ...status, warnings: [...status.warnings, advice] } : status;
}

function rawStatus(
  op: CamOperation,
  geometry: CamGeometryResult | null,
  generated: ReadonlyMap<string, GeneratedOutcome>,
  available: boolean,
): OperationStatus {
  const done = generated.get(op.id);
  const base = {
    errors: [] as string[],
    warnings: [] as string[],
    repick: [] as number[],
    toolpath:
      done === undefined
        ? ('none' as const)
        : done.ok
          ? ('generated' as const)
          : ('failed' as const),
    stale: false,
  };
  if (op.suppressed) return { ...base, state: 'suppressed' };
  if (!available) return { ...base, state: 'unavailable' };
  const result = geometry?.operations.find((o) => o.operationId === op.id);
  if (!geometry || !result) return { ...base, state: 'pending' };
  const stale = done !== undefined && done.key !== result.key;
  const warnings = [...result.warnings.map((w) => w.message), ...(done?.warnings ?? [])];
  const errors = result.errors.map((e) => e.message);
  if (done && !done.ok && !stale && done.message) errors.push(done.message);
  const repick = repicks(result);
  if (result.status === 'error' || geometry.status === 'error') {
    const setupErrors = geometry.status === 'error' ? geometry.errors.map((e) => e.message) : [];
    return {
      ...base,
      state: 'error',
      errors: [...setupErrors, ...errors],
      warnings,
      repick,
      stale,
    };
  }
  return { ...base, state: 'ok', errors, warnings, repick, stale };
}

/** Sources the stage could not find or tell apart, by index into the operation's geometry. */
export function repicks(result: CamOperationResult): number[] {
  const out = new Set<number>();
  for (const e of result.errors) {
    if (
      (e.code === 'reference-lost' || e.code === 'reference-ambiguous') &&
      e.source !== undefined
    ) {
      out.add(e.source);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Whether the setup's WCS face is lost (re-pick it in the setup panel). */
export function wcsLost(geometry: CamGeometryResult | null): string | null {
  if (!geometry) return null;
  const e = geometry.errors.find(
    (x) => x.code === 'reference-lost' || x.code === 'reference-ambiguous' || x.code === 'setup',
  );
  return e ? e.message : null;
}
