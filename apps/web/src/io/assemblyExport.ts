// Exporting an assembly (M2 plan, T2.3f): its parts placed where regen solved its instances.
// Each part is written once, however many instances show it: STEP as an assembly of located
// components (the kernel's XCAF writer), 3MF as one object per body with one build item per
// instance, STL as every instance's meshes moved into place and merged. Kept free of React, like
// `actions.ts`.
//
// The kernel holds every instance body under its instance view id (`<assembly>/<instance>/<body>`,
// all sharing their part's shape), so a part is meshed or written through its first instance.

import { findPart, type ManufaktureDocument, type Pose } from '@manufakture/core';
import {
  EXPORT_TOLERANCES,
  NotWatertightError,
  deflectionOf,
  export3mfAssembly,
  exportStlAssembly,
  fileName,
  type ExportAssembly,
  type ExportTolerancePreset,
} from '@manufakture/io';
import type { StepAssemblyLayout } from '@manufakture/kernel';
import type { AssemblyResult } from '@manufakture/regen';
import { bodyName, instanceViewId } from '../model/bodies';
import type { ModelState } from '../model/model';
import type { ActionResult, ExportChoice, ExportFormat, ExportedFile } from './actions';
import type { Exchanger } from './exchange';
import { MIME, formatBytes } from './files';

/** What an assembly export writes, worked out from the document and the last regen. */
export interface AssemblyExportPlan {
  /** The assembly's name: the STEP assembly product, the 3MF title and the file name. */
  name: string;
  /** One body per distinct part body: the instance body the kernel holds it as, and its name. */
  bodies: ExportChoice[];
  /** Each part once: its name and its bodies, by index in `bodies`. */
  parts: { name: string; bodies: number[] }[];
  /** Each instance written: its part (index in `parts`), its name and its solved pose. */
  instances: { part: number; name: string; pose: Pose }[];
  /** Instances left out because regen could not build them. */
  skipped: string[];
}

/**
 * The plan for exporting assembly `assemblyId` of `doc` as regen last solved it (`model`).
 * Suppressed instances are left out; so are instances that failed (named in `skipped`). Two
 * instances show the same part when they have the same source and the same bodies.
 */
export function assemblyExportPlan(
  doc: ManufaktureDocument,
  assemblyId: string,
  model: Pick<ModelState, 'parts' | 'assemblies' | 'sources'>,
): ActionResult<AssemblyExportPlan> {
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  const result: AssemblyResult | undefined = model.assemblies.find(
    (a) => a.assemblyId === assemblyId,
  );
  if (!assembly) return { ok: false, message: `There is no assembly ${assemblyId}.` };
  if (!result) return { ok: false, message: `${assembly.name} has not been solved yet.` };
  const plan: AssemblyExportPlan = {
    name: assembly.name,
    bodies: [],
    parts: [],
    instances: [],
    skipped: [],
  };
  const partByKey = new Map<string, number>();
  const usedNames = new Set<string>();
  const unique = (name: string) => {
    let out = name;
    for (let n = 2; usedNames.has(out); n++) out = `${name} (${n})`;
    usedNames.add(out);
    return out;
  };
  for (const inst of result.instances) {
    const stored = assembly.instances.find((x) => x.id === inst.instanceId);
    if (!stored || stored.suppressed || inst.status === 'suppressed') continue;
    if (inst.status !== 'ok' || inst.bodies.length === 0) {
      plan.skipped.push(stored.name);
      continue;
    }
    const sourceKey =
      'part' in inst.source ? `part:${inst.source.part}` : `source:${inst.source.source}`;
    const key = `${sourceKey}\n${inst.bodies.join('\n')}`;
    let part = partByKey.get(key);
    if (part === undefined) {
      const named = partNames(doc, model, inst.source);
      if (named === null) {
        plan.skipped.push(stored.name);
        continue;
      }
      const first = plan.bodies.length;
      for (const bodyId of inst.bodies) {
        plan.bodies.push({
          id: instanceViewId(assemblyId, inst.instanceId, bodyId),
          name: named.body(bodyId),
        });
      }
      part = plan.parts.length;
      plan.parts.push({
        name: unique(named.part),
        bodies: inst.bodies.map((_, k) => first + k),
      });
      partByKey.set(key, part);
    }
    plan.instances.push({ part, name: stored.name, pose: inst.transform });
  }
  if (plan.instances.length === 0) {
    return {
      ok: false,
      message:
        plan.skipped.length > 0
          ? `None of the instances of ${assembly.name} could be built.`
          : `${assembly.name} has no instances to export.`,
    };
  }
  return { ok: true, value: plan, message: '' };
}

/** A part's product name and its bodies' names, for an instance's source; null when unknown. */
function partNames(
  doc: ManufaktureDocument,
  model: Pick<ModelState, 'parts' | 'sources'>,
  source: AssemblyResult['instances'][number]['source'],
): { part: string; body: (bodyId: string) => string } | null {
  if ('part' in source) {
    const part = findPart(doc, source.part);
    const bodies = model.parts.find((p) => p.partId === source.part)?.bodies;
    if (!part || !bodies) return null;
    return {
      part: part.name,
      body: (bodyId) => {
        const own = part.bodies.find((b) => b.id === bodyId)?.name;
        const index = bodies.findIndex((b) => b.bodyId === bodyId);
        return own ?? bodyName(part, Math.max(index, 0), bodies.length);
      },
    };
  }
  const pinned = model.sources.find((x) => x.key === source.source);
  if (!pinned) return null;
  // A part of this document in another configuration row: named like the part, with the row.
  const part = pinned.local ? findPart(doc, pinned.partId) : undefined;
  if (part) {
    const name = pinned.row === undefined ? part.name : `${part.name} (${pinned.row.name})`;
    return {
      part: name,
      body: (bodyId) => {
        const own = part.bodies.find((b) => b.id === bodyId)?.name;
        const index = pinned.bodies.findIndex((b) => b.bodyId === bodyId);
        return own ?? bodyName({ name }, Math.max(index, 0), pinned.bodies.length);
      },
    };
  }
  const row = pinned.row === undefined ? '' : `, ${pinned.row.name}`;
  const name = `${pinned.documentName} (${pinned.versionName}${row})`;
  return {
    part: name,
    body: (bodyId) =>
      bodyName(
        { name },
        Math.max(
          pinned.bodies.findIndex((b) => b.bodyId === bodyId),
          0,
        ),
        pinned.bodies.length,
      ),
  };
}

/**
 * Write the assembly a plan describes: STEP (an assembly of placed parts), 3MF (an object per
 * body, a build item per instance) or STL (every instance placed, merged into one file). One
 * file per body is not offered for an assembly. Meshes are tessellated once per part body, at
 * `tolerance`, and must be watertight.
 */
export async function exportAssembly(
  exchanger: Exchanger,
  format: ExportFormat,
  plan: AssemblyExportPlan,
  options: { tolerance?: ExportTolerancePreset } = {},
): Promise<ActionResult<ExportedFile[]>> {
  if (format === 'stl-each') {
    return { ok: false, message: 'An assembly is exported as one file: choose STL, 3MF or STEP.' };
  }
  const ids = plan.bodies.map((b) => b.id);
  const names = new Map(plan.bodies.map((b) => [b.id, b.name]));
  let file: ExportedFile;
  if (format === 'step') {
    const layout: StepAssemblyLayout = {
      name: plan.name,
      parts: plan.parts,
      instances: plan.instances,
    };
    const step = await exchanger.exportStep(ids, names, layout);
    if (!step.ok) return step;
    file = { name: fileName(plan.name, 'step'), bytes: step.value, type: MIME.step };
  } else {
    const deflection = deflectionOf(EXPORT_TOLERANCES[options.tolerance ?? 'normal']);
    const meshes = await exchanger.tessellate(ids, deflection, names);
    if (!meshes.ok) return meshes;
    const assembly: ExportAssembly = {
      bodies: meshes.value,
      parts: plan.parts,
      instances: plan.instances.map((i) => ({ part: i.part, name: i.name, placement: i.pose })),
    };
    try {
      file =
        format === '3mf'
          ? {
              name: fileName(plan.name, '3mf'),
              bytes: export3mfAssembly(assembly, { title: plan.name }),
              type: MIME['3mf'],
            }
          : { ...exportStlAssembly(assembly, { fileName: plan.name }), type: MIME.stl };
    } catch (e) {
      if (e instanceof NotWatertightError) return { ok: false, message: e.message };
      throw e;
    }
  }
  const count = plan.instances.length;
  const left =
    plan.skipped.length > 0 ? ` Left out (could not be built): ${plan.skipped.join(', ')}.` : '';
  return {
    ok: true,
    value: [file],
    message: `Exported ${file.name} (${formatBytes(file.bytes.length)}): ${count} ${count === 1 ? 'instance' : 'instances'} of ${plan.parts.length} ${plan.parts.length === 1 ? 'part' : 'parts'}.${left}`,
  };
}
