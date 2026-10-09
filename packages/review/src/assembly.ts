// An assembly drawn at a pose (the `render` tool's and the review bundle's assembly views): its
// instances at their solved poses, or with sliders and revolutes held at given values, or placed
// by hand, and what that pose does to the mates (coordinates, and warnings for a value past a
// limit, a pose off its mate, a value the solver could not hold), in mm and degrees. The pose
// comes from `@manufakture/regen`'s `poseAssembly` on the assembly's last solve; the scene from
// `@manufakture/render`'s `buildAssemblyScene`.

import type { ManufaktureDocument, Pose } from '@manufakture/core';
import {
  evaluateVariables,
  poseAssembly,
  resultSolverInput,
  type RegenResult,
} from '@manufakture/regen';
import {
  buildAssemblyScene,
  type AssemblySceneInstance,
  type CachedBodyMesh,
  type Scene,
} from '@manufakture/render';

const DEG = 180 / Math.PI;
/** Past this a pose is off its mate: mm, and degrees (as the interference check has it). */
const OFF_MATE_MM = 0.01;
const OFF_MATE_DEG = 0.01;

/** Which assembly to draw, and at what. */
export interface AssemblyAt {
  assemblyId: string;
  /**
   * Slider distances (mm) and revolute angles (degrees) by mate id, held by one solve from the
   * solved poses, every other mate kept. A value past the mate's limits is drawn and warned about.
   */
  mates?: Readonly<Record<string, number>>;
  /** Instances placed by hand (instance coordinates to world), after the mates' solve. */
  poses?: Readonly<Record<string, Pose>>;
}

/** What a pose does to a mate, in mm and degrees. */
export interface AssemblyPoseWarning {
  code: 'outside-limits' | 'off-mate' | 'not-reached';
  mateId: string;
  message: string;
  [key: string]: unknown;
}

/** An assembly as drawn: its mates' coordinates there, warnings, and instances left out. */
export interface PosedAssemblyView {
  assemblyId: string;
  /** Every solved mate's coordinates at the drawn poses (mm, degrees). */
  mates: {
    mateId: string;
    kind: string;
    coordinates: { name: string; value: number; unit: 'mm' | 'deg' }[];
  }[];
  warnings: AssemblyPoseWarning[];
  /** Instances not drawn: their source failed in the regen (see its errors). */
  skipped: string[];
}

export type AssemblySceneResult =
  | { ok: true; scene: Scene; posed: PosedAssemblyView }
  | { ok: false; code: 'not-found' | 'invalid-input' | 'missing-mesh'; message: string };

const fmt = (v: number, unit: 'mm' | 'deg'): string => `${v.toFixed(2)} ${unit}`;

/**
 * The scene of `at.assemblyId` of `document` at `at`, from `result` (the document's regen, with
 * meshes for every body drawn, or `bodyMeshes` for those it reports unchanged), and what the
 * pose does to the mates. Refused for an assembly that is not in both, a mate value while the
 * solve conflicts or is invalid, and what `poseAssembly` refuses.
 */
export function assemblyScene(
  document: ManufaktureDocument,
  result: Pick<RegenResult, 'names' | 'parts' | 'sources' | 'assemblies'>,
  at: AssemblyAt,
  bodyMeshes?: ReadonlyMap<string, CachedBodyMesh>,
): AssemblySceneResult {
  const assembly = document.assemblies.find((a) => a.id === at.assemblyId);
  const solved = result.assemblies.find((a) => a.assemblyId === at.assemblyId);
  if (assembly === undefined || solved === undefined) {
    return { ok: false, code: 'not-found', message: `There is no assembly ${at.assemblyId}.` };
  }
  const held = Object.entries(at.mates ?? {});
  if (held.length > 0 && solved.outcome !== 'solved') {
    return {
      ok: false,
      code: 'invalid-input',
      message: `The assembly's last solve is ${solved.outcome}${solved.message ? `: ${solved.message}` : ''}. Fix its mates (get_errors) before holding one at a value.`,
    };
  }
  const input = resultSolverInput(assembly, solved, evaluateVariables(document.variables));
  const kinds = new Map(input.mates.map((m) => [m.id, m.kind]));
  // Degrees in, radians to the solver.
  const values: Record<string, number> = {};
  for (const [id, v] of held) values[id] = kinds.get(id) === 'revolute' ? v / DEG : v;
  const posed = poseAssembly(input, {
    ...(held.length > 0 ? { mates: values } : {}),
    ...(at.poses !== undefined ? { poses: at.poses } : {}),
  });
  if (!posed.ok) return { ok: false, code: 'invalid-input', message: posed.message };

  const handPlaced = new Set(Object.keys(at.poses ?? {}));
  const warnings: AssemblyPoseWarning[] = [];
  for (const id of posed.value.notReached) {
    const unit = kinds.get(id) === 'revolute' ? 'deg' : 'mm';
    warnings.push({
      code: 'not-reached',
      mateId: id,
      value: at.mates![id]!,
      unit,
      message: `The solver could not hold ${id} at ${fmt(at.mates![id]!, unit)}, as inside a loop of mates: drawn where the solve left it.`,
    });
  }
  const mates: PosedAssemblyView['mates'] = [];
  for (const m of posed.value.mates) {
    mates.push({
      mateId: m.mateId,
      kind: m.kind,
      coordinates: m.coordinates.map((c) => ({
        name: c.name,
        value: c.angular ? c.value * DEG : c.value,
        unit: c.angular ? 'deg' : 'mm',
      })),
    });
    const past = m.outsideLimits;
    if (past !== null) {
      const unit = m.kind === 'revolute' ? 'deg' : 'mm';
      const k = m.kind === 'revolute' ? DEG : 1;
      warnings.push({
        code: 'outside-limits',
        mateId: m.mateId,
        bound: past.bound,
        limit: past.limit * k,
        value: past.value * k,
        unit,
        message: `Drawn with ${m.mateId} at ${fmt(past.value * k, unit)}, past its ${past.bound === 'max' ? 'maximum' : 'minimum'} of ${fmt(past.limit * k, unit)}: the mate cannot get there.`,
      });
    }
    const mate = input.mates.find((x) => x.id === m.mateId)!;
    if (!handPlaced.has(mate.a.instance) && !handPlaced.has(mate.b.instance)) continue;
    const angle = m.residual.angle * DEG;
    if (m.residual.position > OFF_MATE_MM || angle > OFF_MATE_DEG) {
      warnings.push({
        code: 'off-mate',
        mateId: m.mateId,
        position: m.residual.position,
        angle,
        message: `The poses do not keep ${m.mateId} (a ${m.kind}): its connectors are ${fmt(m.residual.position, 'mm')} and ${fmt(angle, 'deg')} from where it holds them.`,
      });
    }
  }

  const instances: AssemblySceneInstance[] = [];
  const skipped: string[] = [];
  for (const inst of solved.instances) {
    if (inst.status === 'suppressed') continue;
    if (inst.status !== 'ok') {
      skipped.push(inst.instanceId);
      continue;
    }
    instances.push({
      instanceId: inst.instanceId,
      source: inst.source,
      bodies: inst.bodies,
      pose: posed.value.poses[inst.instanceId] ?? inst.transform,
    });
  }
  const scene = buildAssemblyScene({
    result,
    instances,
    document,
    ...(bodyMeshes !== undefined ? { bodyMeshes } : {}),
  });
  if (!scene.ok) return { ok: false, code: 'missing-mesh', message: scene.error.message };
  return {
    ok: true,
    scene: scene.value,
    posed: { assemblyId: assembly.id, mates, warnings, skipped },
  };
}
