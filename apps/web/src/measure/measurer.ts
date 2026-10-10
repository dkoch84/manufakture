// How the measure tool reaches the kernel: a `Measurer` sends a `measure` op
// for one body to the worker (the scene loader provides it, since it knows
// which kernel shape each body is), and `measureTargets` turns the viewport's
// selection into the op's targets.

import type { BodyMeasure, Matrix3, MeasureResult, MeasureTarget } from '@manufakture/kernel';
import type { GeometryRef } from '../state/selection';
import { PLACEHOLDER_PREFIX } from '../viewport/naming';

/**
 * A body's properties as the measure tool shows them: the kernel's, or a
 * mesh body's, whose `volume` is null when the mesh does not enclose one (an
 * open or non-manifold STL), with a `note` saying why. A mesh body has no
 * volume inertia.
 */
export type BodyMeasurement = Omit<BodyMeasure, 'volume' | 'volumeInertia'> & {
  volume: number | null;
  volumeInertia?: Matrix3 | null;
  note?: string;
};

/** A measurement: the kernel's `MeasureResult`, or a mesh body's. */
export type Measurement = Omit<MeasureResult, 'body'> & { body: BodyMeasurement | null };

export type MeasureOutcome = { ok: true; result: Measurement } | { ok: false; message: string };

export interface Measurer {
  /**
   * Measure `targets` on body `bodyId`, and with `body` its mass properties.
   * Resolves to null when a newer request superseded this one.
   */
  measure(
    bodyId: string,
    targets: readonly MeasureTarget[],
    body: boolean,
  ): Promise<MeasureOutcome | null>;
}

const PLACEHOLDER = new RegExp(
  `^${PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(face|edge|vertex):(\\d+)$`,
);

/**
 * The kernel target for a selected face, edge or vertex. A name from the
 * naming layer goes by name; a viewport placeholder (`placeholder:face:3`,
 * every vertex for now) is the sub-shape's index, which is what it encodes.
 */
export function measureTarget(ref: GeometryRef): MeasureTarget {
  const m = PLACEHOLDER.exec(ref.name);
  if (m && m[1] === ref.kind) return { kind: ref.kind, index: Number(m[2]) };
  return { kind: ref.kind, name: ref.name };
}

export function measureTargets(refs: readonly GeometryRef[]): MeasureTarget[] {
  return refs.map(measureTarget);
}
