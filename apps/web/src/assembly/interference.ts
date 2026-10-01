// The interference check of the assembly workspace (M2 plan, T2.3d), free of React: what a check
// shows while it runs and after, its rows, and how the viewport marks the pair a row picks (both
// instances selected, the overlap's outline drawn over everything).
//
// The check itself runs in the regen worker (`Assembler.interference`), on demand only: the
// pairwise booleans are the costly part, so it is never part of a regen. Pairs arrive one at a
// time as the worker finds them.

import type { Assembly, DisplayUnits } from '@manufakture/core';
import { UNNAMED, type MeshData } from '@manufakture/kernel';
import type { AssemblyResult, InstanceInterference, InterferenceReport } from '@manufakture/regen';
import { formatVolumeIn } from '../measure/format';
import { geometryRef, type GeometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';
import { instanceOf } from './assembly';

/** What the Interference panel shows for one check. */
export interface InterferenceView {
  assemblyId: string;
  /** Numbers the checks, so pairs of a check that was replaced are dropped. */
  run: number;
  /**
   * `checking` until the report arrives; then the report's status, or `failed` when the worker
   * could not answer (`message` says why), or `superseded` when a regen came first.
   */
  status: 'checking' | InterferenceReport['status'] | 'failed' | 'superseded';
  /** The pairs found so far, in the order they arrived. */
  pairs: InstanceInterference[];
  /** Instances checked; null until the report arrives. */
  instances: number | null;
  /** Pairs whose bounding boxes overlap (each cost a boolean); null until the report arrives. */
  candidates: number | null;
  failures: InterferenceReport['failures'];
  /**
   * The model's result for the assembly when the check ended: when the model has another one, the
   * assembly changed since, and the list may be out of date.
   */
  basis: AssemblyResult | undefined;
  message?: string;
}

/** A fresh view for a check that has just been asked for. */
export function startedView(assemblyId: string, run: number): InterferenceView {
  return {
    assemblyId,
    run,
    status: 'checking',
    pairs: [],
    instances: null,
    candidates: null,
    failures: [],
    basis: undefined,
  };
}

/** The view once the report (or null: superseded) has arrived. */
export function finishedView(
  view: InterferenceView,
  report: InterferenceReport | null,
  basis: AssemblyResult | undefined,
): InterferenceView {
  if (report === null) return { ...view, status: 'superseded', basis };
  return {
    ...view,
    status: report.status,
    // The report lists every pair again; keep the streamed ones, which carry the meshes.
    pairs: report.pairs.map((p) => view.pairs.find((q) => q.a === p.a && q.b === p.b) ?? p),
    instances: report.instances.length,
    candidates: report.candidates,
    failures: report.failures,
    basis,
  };
}

/** The key of a pair: its two instance ids. */
export const pairKey = (pair: Pick<InstanceInterference, 'a' | 'b'>): string =>
  `${pair.a}/${pair.b}`;

export interface InterferenceRow {
  key: string;
  a: string;
  b: string;
  /** "Box 1 and Drawer 1". */
  label: string;
  volume: number;
  /** The volume in the document's units. */
  volumeText: string;
}

export function interferenceRows(
  assembly: Assembly | undefined,
  pairs: readonly InstanceInterference[],
  units: DisplayUnits,
): InterferenceRow[] {
  const name = (id: string) => assembly?.instances.find((x) => x.id === id)?.name ?? id;
  return pairs.map((p) => ({
    key: pairKey(p),
    a: p.a,
    b: p.b,
    label: `${name(p.a)} and ${name(p.b)}`,
    volume: p.volume,
    volumeText: formatVolumeIn(p.volume, units),
  }));
}

/** The line above the list: what the check is doing, or what it found. */
export function interferenceSummary(view: InterferenceView | null, changed: boolean): string {
  if (view === null) return 'Check which instances overlap, and by how much.';
  const n = view.pairs.length;
  const found = n === 0 ? 'no pair overlaps' : n === 1 ? '1 pair overlaps' : `${n} pairs overlap`;
  switch (view.status) {
    case 'checking':
      return n === 0 ? 'Checking...' : `Checking... ${found} so far.`;
    case 'cancelled':
      return `Stopped: ${found} so far.`;
    case 'stale':
      return 'The geometry kernel restarted: check again once the assembly is placed.';
    case 'superseded':
      return 'The assembly changed while it was checked: check again.';
    case 'failed':
      return `The check failed: ${view.message ?? 'unknown error'}.`;
    case 'done': {
      const what =
        n === 0
          ? `No interference between the ${view.instances ?? 0} instances.`
          : `${n === 1 ? '1 pair overlaps' : `${n} pairs overlap`}.`;
      return changed ? `${what} The assembly changed since: check again.` : what;
    }
  }
}

/**
 * Every named face of the instances `ids` (of assembly `assemblyId`), as selection items: the
 * pair a row of the panel picks is highlighted by selecting both instances, which recolours their
 * faces in place (no rebuild, the camera stays).
 */
export function instanceFaces(
  bodies: readonly BodyInput[],
  assemblyId: string,
  ids: readonly string[],
): GeometryRef[] {
  const out: GeometryRef[] = [];
  for (const b of bodies) {
    const inst = instanceOf(b.id, assemblyId);
    if (inst === null || !ids.includes(inst)) continue;
    b.mesh.faceNames.forEach((slot, i) => {
      const name = slot === UNNAMED ? undefined : b.names[slot];
      if (name !== undefined) {
        out.push(geometryRef('face', b.id, name, { fragile: b.mesh.faceFragile[i] === 1 }));
      }
    });
  }
  return out;
}

/** The overlap's edges as line segments (xyz xyz each), in world coordinates. */
export function overlapSegments(mesh: MeshData): [number, number, number][][] {
  const out: [number, number, number][][] = [];
  const p = mesh.edgePositions;
  for (let e = 0; e < mesh.edgeRanges.length / 2; e++) {
    const first = mesh.edgeRanges[2 * e]!;
    const count = mesh.edgeRanges[2 * e + 1]!;
    if (count < 2) continue;
    const line: [number, number, number][] = [];
    for (let k = first; k < first + count; k++)
      line.push([p[3 * k]!, p[3 * k + 1]!, p[3 * k + 2]!]);
    out.push(line);
  }
  return out;
}
