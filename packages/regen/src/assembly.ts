// Assemblies in regen (M2 plan, T2.3c): what an instance shows, where its mate connectors are,
// and what the mate solver (`packages/assembly`, ADR 0008) makes of it. The engine does the
// kernel work (building the parts, one `connector` op per body for the frames it has not found
// before) and calls these to turn connectors into the solver's plain input and the solver's
// report into an `AssemblyResult`. Everything here is pure and synchronous.
//
// A connector's frame comes from the kernel in the coordinates of its instance's part
// (`connectorFrame`, kernel README "Mate connectors"); `flip`, `rotate` and the evaluated
// `offset` are applied here, in the connector's own frame, in that order. A connector that does
// not resolve is an error on its mate, which then never reaches the solver: its instances are
// free of it, and the rest of the assembly still solves (M2 plan, T2.3c risks).

import {
  compose,
  coordinateAxes,
  posedMate,
  solveAtCoordinate,
  coordinateNames,
  frameAxes,
  isAngular,
  quatFromAxisAngle,
  type AssemblyInput,
  type AssemblyWarning,
  type DragReport,
  type FrameAxes,
  type LimitViolation,
  type MateInput,
  type MateKind,
  type SolveReport,
} from '@manufakture/assembly';
import {
  isPinnedSource,
  type Assembly,
  mateExpressions,
  type InstanceSource,
  type Mate,
  type MateConnector,
  type Pose,
  type Vec3,
} from '@manufakture/core';
import {
  connectorTarget,
  type ConnectorOrigin,
  type ConnectorReport,
  type Frame,
} from '@manufakture/kernel';
import { topoRef } from './translate';
import type {
  AssemblyResult,
  ConnectorResult,
  DragResult,
  InstanceResult,
  MateResult,
  ReferenceResolution,
  RegenError,
  RegenWarning,
} from './types';
import { evaluateField, pathKey, type VariableValues } from './values';

export { MAX_SWEEP_VALUES, sweepValues } from '@manufakture/assembly';

/**
 * The key an instance's source is built under: `part:<part id>` for a part of this document,
 * `source:<sha256>:<part id>` for a pinned part, each followed by `:row:<row id>` when the
 * instance names a configuration row. Instances with equal keys show the same bodies, so each
 * source is built once per regen in each row, and two instances at two rows get two builds.
 */
export function instanceSourceKey(source: InstanceSource): string {
  const row = source.configuration === undefined ? '' : `:row:${source.configuration}`;
  return isPinnedSource(source)
    ? `source:${source.sha256}:${source.partId}${row}`
    : `part:${(source as { part: string }).part}${row}`;
}

/** What the kernel's `connector` op finds a connector's frame on, in kernel form. */
export function connectorOrigin(c: MateConnector): ConnectorOrigin {
  if (c.inference === 'vertex') {
    const ref = c.origin.ref as { faces: string[]; ordinal?: number };
    return ref.ordinal === undefined
      ? { faces: [...ref.faces] }
      : { faces: [...ref.faces], ordinal: ref.ordinal };
  }
  return topoRef(c.origin.ref as Parameters<typeof topoRef>[0]);
}

/** A kernel frame (origin, x, normal) as a pose: x, y = normal x x, z = normal as columns. */
export function framePose(frame: Frame): Pose {
  const x = unit(frame.xDir);
  const z = unit(frame.normal);
  const y = cross(z, x);
  return { translation: [...frame.origin] as Vec3, rotation: matrixQuat(x, y, z) };
}

const HALF_TURN_X: Pose = { translation: [0, 0, 0], rotation: [1, 0, 0, 0] };

/** Rotation angles about the fixed x, y and z axes, in that order (Rz * Ry * Rx). */
function eulerFixed(rx: number, ry: number, rz: number): Pose['rotation'] {
  const qx = quatFromAxisAngle([1, 0, 0], rx);
  const qy = quatFromAxisAngle([0, 1, 0], ry);
  const qz = quatFromAxisAngle([0, 0, 1], rz);
  const r = compose(
    { translation: [0, 0, 0], rotation: qz },
    compose({ translation: [0, 0, 0], rotation: qy }, { translation: [0, 0, 0], rotation: qx }),
  );
  return r.rotation;
}

/**
 * A connector's frame in its instance's coordinates: the kernel's frame, then `flip` (a half
 * turn about x), `rotate` (quarter turns about z), then the offset (a rotation about the fixed
 * x, y and z axes, then a translation), each in the frame as it is by then.
 */
export function connectorPose(
  base: Pose,
  connector: Pick<MateConnector, 'flip' | 'rotate'>,
  offset: { translation: Vec3; rotation: Vec3 } | undefined,
): Pose {
  let out = base;
  if (connector.flip) out = compose(out, HALF_TURN_X);
  if (connector.rotate !== undefined) {
    const turn = quatFromAxisAngle([0, 0, 1], (connector.rotate * Math.PI) / 2);
    out = compose(out, { translation: [0, 0, 0], rotation: turn });
  }
  if (offset !== undefined) {
    const [rx, ry, rz] = offset.rotation;
    out = compose(out, { translation: offset.translation, rotation: eulerFixed(rx, ry, rz) });
  }
  return plain(out);
}

/** The evaluated numbers of a mate: connector offsets and limits, or why they do not evaluate. */
export interface MateValues {
  offsets: { a?: { translation: Vec3; rotation: Vec3 }; b?: { translation: Vec3; rotation: Vec3 } };
  limits?: { min?: number; max?: number };
  errors: RegenError[];
}

export function mateValues(mate: Mate, variables: VariableValues): MateValues {
  const values = new Map<string, number>();
  const errors: RegenError[] = [];
  for (const site of mateExpressions(mate)) {
    const expected = site.expected === 'angle' ? 'angle' : 'length';
    const r = evaluateField(site.expression, expected, site.path, variables);
    if (r.ok) values.set(pathKey(site.path), r.value);
    else errors.push(r.error);
  }
  const out: MateValues = { offsets: {}, errors };
  if (errors.length > 0) return out;
  for (const side of ['a', 'b'] as const) {
    if (mate[side].offset === undefined) continue;
    const get = (field: string, i: number) => values.get(`${side}.offset.${field}.${i}`) ?? 0;
    out.offsets[side] = {
      translation: [get('translation', 0), get('translation', 1), get('translation', 2)],
      rotation: [get('rotation', 0), get('rotation', 1), get('rotation', 2)],
    };
  }
  if (mate.limits !== undefined) {
    const limits: { min?: number; max?: number } = {};
    const min = values.get('limits.min');
    const max = values.get('limits.max');
    if (min !== undefined) limits.min = min;
    if (max !== undefined) limits.max = max;
    out.limits = limits;
  }
  return out;
}

/**
 * One report for a connector from the reports of every body its instance shows. Names are unique
 * across a part's bodies, so normally at most one body finds it, but descendants are not: a face
 * split since may live on in two bodies. So an exact match wins over any other; else a single
 * match by another rule (descendant, ancestor, ends, ordinal); several equally good matches on
 * different bodies are an ambiguity naming those bodies; then an ambiguity within one body; then
 * the loss with the fewest missing names.
 */
export function pickReport(
  reports: readonly { bodyId: string; report: ConnectorReport }[],
): ConnectorReport | undefined {
  const found = reports.filter(
    (r): r is { bodyId: string; report: Extract<ConnectorReport, { ok: true }> } => r.report.ok,
  );
  const exact = found.filter((r) => r.report.via === 'exact');
  const best = exact.length > 0 ? exact : found;
  if (best.length === 1) return best[0]!.report;
  if (best.length > 1) {
    const bodies = best.map((r) => r.bodyId).sort();
    return {
      ok: false,
      status: 'ambiguous',
      candidates: bodies,
      message: `it matches geometry on ${bodies.length} bodies (${bodies.join(', ')})`,
    };
  }
  const ambiguous = reports.find((r) => !r.report.ok && r.report.status === 'ambiguous');
  if (ambiguous !== undefined) return ambiguous.report;
  const lost = reports
    .map((r) => r.report)
    .filter((r): r is Extract<ConnectorReport, { status: 'lost' }> => !r.ok && r.status === 'lost');
  if (lost.length > 0) {
    return lost.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
  }
  return reports[0]?.report;
}

/** Why a connector has no frame, as an error on its mate with a re-pick prompt. */
export function connectorError(
  mate: Mate,
  side: 'a' | 'b',
  report: Exclude<ConnectorReport, { ok: true }> | undefined,
): RegenError {
  const c = mate[side];
  const referenceId = c.origin.id;
  const target = connectorTarget(connectorOrigin(c), c.inference);
  const hint = c.origin.lastResolved;
  const extra =
    hint === undefined ? {} : { lastResolved: { point: hint.point, direction: hint.direction } };
  const where = `Connector ${c.id} of ${mate.id} (on ${c.instance})`;
  if (report === undefined) {
    return {
      code: 'no-body',
      referenceId,
      message: `${where} has no body to sit on`,
    };
  }
  switch (report.status) {
    case 'lost':
      return {
        code: 'reference-lost',
        referenceId,
        target,
        missing: [...report.missing],
        message: `${where}: ${report.message}: re-pick it`,
        ...extra,
      };
    case 'ambiguous':
      return {
        code: 'reference-ambiguous',
        referenceId,
        target,
        candidates: [...report.candidates],
        message: `${where}: ${report.message}: re-pick it`,
        ...extra,
      };
    case 'unsuitable':
      return {
        code: 'invalid',
        referenceId,
        message: `${where}: ${report.message}: re-pick it`,
      };
    case 'no-body':
      return { code: 'no-body', referenceId, message: `${where}: ${report.message}` };
  }
}

/** How a found connector resolved, and the warnings that come with it. */
export function connectorResolution(
  mate: Mate,
  side: 'a' | 'b',
  report: Extract<ConnectorReport, { ok: true }>,
): { reference: ReferenceResolution; warnings: RegenWarning[] } {
  const c = mate[side];
  const referenceId = c.origin.id;
  const target = connectorTarget(connectorOrigin(c), c.inference);
  const reference = { referenceId, target, via: report.via, fragile: report.fragile };
  const warnings: RegenWarning[] = [];
  if (report.via !== 'exact' || report.fragile) {
    warnings.push({
      code: 'reference',
      ...reference,
      message: `Connector ${c.id} of ${mate.id}: ${target} resolved ${report.fragile ? 'by position' : `by ${report.via}`}: check it still points at the intended geometry`,
    });
  }
  if (!report.oriented) {
    warnings.push({
      code: 'direction',
      referenceId,
      target,
      message: `Connector ${c.id} of ${mate.id}: no naming rule orients ${target}, so an edit may turn it round: check it, and flip it if it points the wrong way`,
    });
  }
  return { reference, warnings };
}

/** A mate's solver input from its two connector poses and its evaluated values. */
export function mateInput(mate: Mate, a: Pose, b: Pose, values: MateValues): MateInput {
  const input: MateInput = {
    id: mate.id,
    kind: mate.kind,
    a: { instance: mate.a.instance, frame: a },
    b: { instance: mate.b.instance, frame: b },
  };
  if (values.limits !== undefined) input.limits = values.limits;
  return input;
}

/** Whether two poses differ by more than rounding. */
export function posesDiffer(p: Pose, q: Pose): boolean {
  for (let i = 0; i < 3; i++)
    if (Math.abs(p.translation[i]! - q.translation[i]!) > 1e-9) return true;
  // q and -q are the same rotation.
  const d = p.rotation.reduce((s, v, i) => s + v * q.rotation[i]!, 0);
  return 1 - Math.abs(d) > 1e-12;
}

/** Fill instance transforms and mate diagnostics from a solve. */
export function applyReport(
  result: AssemblyResult,
  report: SolveReport,
  stored: ReadonlyMap<string, Pose>,
): void {
  result.outcome = report.outcome;
  result.dof = report.dof;
  result.redundant = report.redundant;
  result.conflicting = report.conflicting;
  result.issues = report.issues;
  result.warnings = report.warnings;
  if (report.message !== undefined) result.message = report.message;
  for (const inst of result.instances) {
    const solved = report.poses[inst.instanceId];
    if (solved === undefined) continue;
    inst.transform = plain(solved);
    const before = stored.get(inst.instanceId);
    inst.moved = before !== undefined && posesDiffer(inst.transform, before);
  }
  for (const m of result.mates) {
    const r = report.mates[m.mateId];
    if (r === undefined || m.status === 'error') continue;
    m.status = r.status;
    m.coordinates = [...r.coordinates];
    m.residual = { ...r.residual };
    if (r.message !== undefined) m.message = r.message;
  }
  // A limit the stored poses passed is a warning on its mate, where errors lists read it.
  for (const w of report.warnings) {
    const limit = limitWarning(w);
    if (limit === undefined) continue;
    result.mates.find((m) => m.mateId === w.mateId)?.warnings.push(limit);
  }
}

/** A solver warning about a mate's limit as the mate's regen warning; undefined for others. */
export function limitWarning(w: AssemblyWarning): RegenWarning | undefined {
  if (w.code !== 'clamped' && w.code !== 'outside-limits') return undefined;
  if (w.bound === undefined || w.limit === undefined || w.value === undefined) return undefined;
  return {
    code: 'limit',
    message: w.message,
    clamped: w.code === 'clamped',
    bound: w.bound,
    limit: w.limit,
    value: w.value,
  };
}

/** One solved coordinate of a mate, named: a slider's `distance` (mm), a revolute's `angle`. */
export interface NamedCoordinate {
  name: string;
  /** Millimetres, or radians when `angular`. */
  value: number;
  angular: boolean;
}

/**
 * A mate's solved coordinates (`MateResult.coordinates`) with their names: revolute angle,
 * slider distance, planar x, y and angle, cylindrical distance and angle, ball rotation vector
 * x, y and z. Empty when the mate was not solved.
 */
export function namedCoordinates(
  kind: MateKind,
  coordinates: readonly number[],
): NamedCoordinate[] {
  const names = coordinateNames(kind);
  if (coordinates.length !== names.length) return [];
  return names.map((name, k) => ({ name, value: coordinates[k]!, angular: isAngular(kind, k) }));
}

/** A connector's resolved frame in world coordinates (mm): origin and unit axes. */
export interface ConnectorFrame extends FrameAxes {
  connectorId: string;
  instanceId: string;
}

/**
 * A mate's two connector frames in world coordinates at the solved instance poses, with flip,
 * rotate and offset applied: the frames the solver mates. A connector is null when it did not
 * resolve; undefined when the result has no such mate. `motion` names the axis of connector a's
 * frame each free coordinate runs along or turns about (a slider's distance: z).
 */
export function connectorFrames(
  result: AssemblyResult,
  mateId: string,
  kind: MateKind,
):
  | {
      a: ConnectorFrame | null;
      b: ConnectorFrame | null;
      motion: { coordinate: string; axis: 'x' | 'y' | 'z'; angular: boolean }[];
    }
  | undefined {
  const m = result.mates.find((x) => x.mateId === mateId);
  if (m === undefined) return undefined;
  const world = (c: ConnectorResult): ConnectorFrame | null => {
    if (c.frame === null) return null;
    const inst = result.instances.find((i) => i.instanceId === c.instanceId);
    if (inst === undefined) return null;
    return {
      connectorId: c.connectorId,
      instanceId: c.instanceId,
      ...frameAxes(compose(inst.transform, c.frame)),
    };
  };
  const axes = coordinateAxes(kind);
  return {
    a: world(m.connectors[0]),
    b: world(m.connectors[1]),
    motion: coordinateNames(kind).map((coordinate, k) => ({
      coordinate,
      axis: axes[k]!,
      angular: isAngular(kind, k),
    })),
  };
}

/**
 * The solved pose (instance coordinates to world) of every instance of an assembly's result that
 * is not suppressed, by instance id: where the solver put them, which may differ from the stored
 * poses (`moved`), for instance when a mate limit clamped them. What to draw or check the
 * assembly at.
 */
export function solvedPoses(result: AssemblyResult): Record<string, Pose> {
  const out: Record<string, Pose> = {};
  for (const i of result.instances) {
    if (i.status !== 'suppressed') out[i.instanceId] = plain(i.transform);
  }
  return out;
}

/**
 * The solver input an assembly's last regen solved, seeded at the solved poses: its unsuppressed
 * instances (fixed as the document says) and the mates that reached the solver, with the
 * connector frames regen resolved and the limits evaluated (revolute radians, slider mm). What a
 * sweep over a mate's travel, or a check of poses against the mates, starts from.
 */
export function resultSolverInput(
  assembly: Assembly,
  result: AssemblyResult,
  variables: VariableValues,
): AssemblyInput {
  const fixed = new Map(assembly.instances.map((i) => [i.id, i.fixed]));
  const instances = result.instances
    .filter((i) => i.status !== 'suppressed')
    .map((i) => ({
      id: i.instanceId,
      pose: plain(i.transform),
      fixed: fixed.get(i.instanceId) ?? false,
    }));
  const mates: MateInput[] = [];
  for (const mate of assembly.mates) {
    if (mate.suppressed) continue;
    const m = result.mates.find((x) => x.mateId === mate.id);
    if (m === undefined || m.status === 'error' || m.status === 'suppressed') continue;
    const [a, b] = m.connectors;
    if (a.frame === null || b.frame === null) continue;
    const values = mateValues(mate, variables);
    if (values.errors.length > 0) continue;
    mates.push(mateInput(mate, a.frame, b.frame, values));
  }
  return solverInput(instances, mates);
}

/** The instances' poses with one mate's coordinate at a value, or why not. */
export interface SweepStep {
  /** The coordinate asked for (revolute radians, slider mm). */
  value: number;
  /** The solved pose per instance id; null when the solver could not hold the mate there. */
  poses: Record<string, Pose> | null;
}

/**
 * The instances' poses at each of `values` of revolute or slider `mateId` (radians or mm), every
 * other mate kept: each step solves from the one before, so a loop of mates follows the motion.
 * A value the solver cannot hold the mate at (a mate inside a loop, where limits do not hold)
 * gets null poses.
 */
export function sweepPoses(
  input: AssemblyInput,
  mateId: string,
  values: readonly number[],
): SweepStep[] {
  const steps: SweepStep[] = [];
  let seed = input;
  for (const value of values) {
    const r = solveAtCoordinate(seed, mateId, value);
    if (!r.reached || r.report.outcome !== 'solved') {
      steps.push({ value, poses: null });
      continue;
    }
    const poses: Record<string, Pose> = {};
    for (const [id, pose] of Object.entries(r.report.poses)) poses[id] = plain(pose);
    steps.push({ value, poses });
    seed = {
      instances: seed.instances.map((i) => ({ ...i, pose: poses[i.id] ?? i.pose })),
      mates: seed.mates,
    };
  }
  return steps;
}

/** A mate checked at poses a caller gave: its coordinates there, and what it does not keep. */
export interface PosedMateCheck {
  mateId: string;
  kind: MateKind;
  /** The coordinates nearest the poses, named (radians and mm). */
  coordinates: NamedCoordinate[];
  /** How far the poses are from keeping the mate (mm, radians). */
  residual: { position: number; angle: number };
  /** A revolute's or slider's coordinate past one of its limits, else null. */
  outsideLimits: LimitViolation | null;
}

/**
 * Every mate of `input` read at `poses` (by instance id; an instance not given stays at its
 * seed pose): where a hand-made placement puts each mate, whether it keeps the mate and its
 * limits.
 */
export function posedMates(
  input: AssemblyInput,
  poses: Readonly<Record<string, Pose>>,
): PosedMateCheck[] {
  const at = new Map(input.instances.map((i) => [i.id, poses[i.id] ?? i.pose]));
  const out: PosedMateCheck[] = [];
  for (const mate of input.mates) {
    const a = at.get(mate.a.instance);
    const b = at.get(mate.b.instance);
    if (a === undefined || b === undefined) continue;
    const p = posedMate(mate, a, b);
    out.push({
      mateId: mate.id,
      kind: mate.kind,
      coordinates: namedCoordinates(mate.kind, p.coordinates),
      residual: p.residual,
      outsideLimits: p.outsideLimits,
    });
  }
  return out;
}

/** A drag step's result from the solver's report. */
export function dragResult(
  generation: number,
  assemblyId: string,
  instanceId: string,
  report: DragReport,
  stored: ReadonlyMap<string, Pose>,
): DragResult {
  const transforms: Record<string, Pose> = {};
  const moved: string[] = [];
  for (const [id, pose] of Object.entries(report.poses)) {
    transforms[id] = plain(pose);
    const before = stored.get(id);
    if (before !== undefined && posesDiffer(transforms[id], before)) moved.push(id);
  }
  const out: DragResult = {
    generation,
    assemblyId,
    instanceId,
    outcome: report.outcome,
    transforms,
    moved,
    target: { ...report.target },
    dof: report.dof,
    warnings: report.warnings,
  };
  if (report.message !== undefined) out.message = report.message;
  return out;
}

/** A fresh result for an assembly before anything is solved. */
export function emptyAssemblyResult(assemblyId: string): AssemblyResult {
  return {
    assemblyId,
    outcome: 'solved',
    dof: null,
    instances: [],
    mates: [],
    redundant: [],
    conflicting: [],
    issues: [],
    warnings: [],
    ms: 0,
  };
}

/** A mate's result before it is solved. */
export function emptyMateResult(mate: Mate): MateResult {
  const connector = (c: MateConnector): ConnectorResult => ({
    connectorId: c.id,
    instanceId: c.instance,
    frame: null,
    reference: null,
  });
  return {
    mateId: mate.id,
    status: mate.suppressed ? 'suppressed' : 'ok',
    coordinates: [],
    residual: null,
    connectors: [connector(mate.a), connector(mate.b)],
    errors: [],
    warnings: [],
  };
}

/** An instance's result before it is solved (the engine sets `source` to where it was built). */
export function emptyInstanceResult(
  id: string,
  source: InstanceSource,
  pose: Pose,
  suppressed: boolean,
): InstanceResult {
  return {
    instanceId: id,
    status: suppressed ? 'suppressed' : 'ok',
    source: isPinnedSource(source)
      ? { source: instanceSourceKey(source) }
      : { part: (source as { part: string }).part },
    bodies: [],
    transform: plain(pose),
    moved: false,
    errors: [],
    warnings: [],
  };
}

/** The solver's input, seeded with the stored poses (ADR 0008 decision 3). */
export function solverInput(
  instances: readonly { id: string; pose: Pose; fixed: boolean }[],
  mates: readonly MateInput[],
): AssemblyInput {
  return {
    instances: instances.map((x) => ({ id: x.id, pose: x.pose, fixed: x.fixed })),
    mates,
  };
}

// Small linear algebra -----------------------------------------------------------------------

function unit(v: readonly number[]): Vec3 {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The unit quaternion [x, y, z, w] of the rotation whose columns are x, y, z (Shepperd). */
function matrixQuat(x: Vec3, y: Vec3, z: Vec3): Pose['rotation'] {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** A pose with fresh plain arrays and a normalised quaternion, as core's schema wants. */
function plain(p: Pose): Pose {
  const n = Math.hypot(...p.rotation);
  const r = p.rotation;
  return {
    translation: [p.translation[0], p.translation[1], p.translation[2]],
    rotation: [r[0] / n, r[1] / n, r[2] / n, r[3] / n],
  };
}
