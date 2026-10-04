// Publishing a view (M7 plan, T7.3a): the shown part studio's bodies, or the shown assembly with
// its parts placed, as a `.mfkview` bundle (io README, "Published views") that a viewer opens
// without the kernel. Written from the current regen result: the meshes and names the viewport
// already holds, so nothing is tessellated again and it works offline. Volumes are the kernel's
// exact ones where the Measure tool can give them, else the mesh's; masses follow from the
// body's material. With Include source, the document goes in as a `.mfk`. Kept free of React,
// like `actions.ts`.

import { findMaterial, findPart, massGrams, type ManufaktureDocument } from '@manufakture/core';
import {
  MFKVIEW_EXTENSION,
  MFKVIEW_MIME,
  MfkviewError,
  fileName,
  meshProperties,
  placementMatrix,
  writeMfkview,
  type MfkviewInput,
  type MfkviewMaterial,
  type MfkviewMesh,
} from '@manufakture/io';
import { UNNAMED } from '@manufakture/kernel';
import type { Measurer } from '../measure/measurer';
import { assemblyBodies } from '../assembly/assembly';
import { parseInstanceViewId, type PartBody } from '../model/bodies';
import type { ModelState } from '../model/model';
import type { BodyInput } from '../viewport/bodies';
import { isPlaceholderName } from '../viewport/naming';
import type { ActionResult, ExportedFile } from './actions';
import { assemblyExportPlan } from './assemblyExport';
import { formatBytes } from './files';

/** One body to publish: its viewport body (mesh, names), and what the manifest says of it. */
export interface PublishBody {
  /** Its viewport id, which the Measure tool knows it by. */
  viewId: string;
  name: string;
  color: string | null;
  /** A core material id, or null. */
  material: string | null;
  view: BodyInput;
}

/** What a published view holds, worked out from the document and the last regen. */
export interface PublishPlan {
  /** The part studio's or the assembly's name: the file name. */
  name: string;
  kind: 'part' | 'assembly';
  bodies: PublishBody[];
  parts: { name: string; bodies: number[] }[];
  instances: { name: string; part: number; transform: number[] }[];
  /** Instances left out because regen could not build them. */
  skipped: string[];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * The plan for the part studio shown: its bodies that are not hidden, as one part placed once at
 * the identity.
 */
export function partPublishPlan(
  doc: ManufaktureDocument,
  partId: string,
  bodies: readonly PartBody[],
): ActionResult<PublishPlan> {
  const part = findPart(doc, partId);
  const shown = bodies.filter((b) => !b.hidden);
  if (!part || shown.length === 0) {
    return {
      ok: false,
      message:
        bodies.length > 0
          ? 'Every body is hidden: show one to publish it.'
          : 'There is nothing to publish.',
    };
  }
  return {
    ok: true,
    message: '',
    value: {
      name: part.name,
      kind: 'part',
      bodies: shown.map((b) => ({
        viewId: b.viewId,
        name: b.name,
        color: b.color,
        material: b.material,
        view: b.view,
      })),
      parts: [{ name: part.name, bodies: shown.map((_, i) => i) }],
      instances: [{ name: part.name, part: 0, transform: [...IDENTITY] }],
      skipped: [],
    },
  };
}

/**
 * The plan for assembly `assemblyId` as regen last solved it: each part once (as the assembly
 * export plans it), every instance placed by its solved pose, never by a drag or an explosion
 * in progress.
 */
export function assemblyPublishPlan(
  doc: ManufaktureDocument,
  assemblyId: string,
  model: Pick<ModelState, 'parts' | 'assemblies' | 'sources'>,
): ActionResult<PublishPlan> {
  const plan = assemblyExportPlan(doc, assemblyId, model);
  if (!plan.ok) return plan;
  const views = new Map(assemblyBodies(doc, assemblyId, model).map((b) => [b.id, b]));
  const assembly = doc.assemblies.find((a) => a.id === assemblyId)!;
  const bodies: PublishBody[] = [];
  for (const b of plan.value.bodies) {
    const view = views.get(b.id);
    const parsed = parseInstanceViewId(b.id);
    if (!view || !parsed) return { ok: false, message: `${b.name} has no mesh to publish.` };
    // A part of this document carries its body's material (its own, else the part's).
    const stored = assembly.instances.find((x) => x.id === parsed.instanceId);
    const part = stored && 'part' in stored.source ? findPart(doc, stored.source.part) : undefined;
    const props = part?.bodies.find((p) => p.id === parsed.bodyId);
    bodies.push({
      viewId: b.id,
      name: b.name,
      color: view.color ?? null,
      material: props?.material ?? part?.material ?? null,
      view,
    });
  }
  return {
    ok: true,
    message: '',
    value: {
      name: plan.value.name,
      kind: 'assembly',
      bodies,
      parts: plan.value.parts,
      instances: plan.value.instances.map((i) => ({
        name: i.name,
        part: i.part,
        transform: placementMatrix(i.pose),
      })),
      skipped: plan.value.skipped,
    },
  };
}

/** A viewport body's mesh with its names as strings; unnamed and placeholder slots are null. */
export function publishedMesh(view: BodyInput): MfkviewMesh {
  const name = (slot: number) => {
    if (slot === UNNAMED) return null;
    const n = view.names[slot];
    return n === undefined || isPlaceholderName(n) ? null : n;
  };
  const m = view.mesh;
  return {
    positions: m.positions,
    normals: m.normals,
    indices: m.indices,
    faceRanges: m.faceRanges,
    edgePositions: m.edgePositions,
    edgeRanges: m.edgeRanges,
    faceNames: Array.from(m.faceNames, name),
    edgeNames: Array.from(m.edgeNames, name),
  };
}

/** The body's volume: the kernel's exact one when the Measure tool has it, else the mesh's. */
async function volumeOf(
  body: PublishBody,
  mesh: MfkviewMesh,
  measurer: Measurer | null,
): Promise<number | null> {
  if (measurer) {
    try {
      const r = await measurer.measure(body.viewId, [], true);
      const v = r?.ok ? r.result.body?.volume : null;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    } catch {
      // The mesh's volume below.
    }
  }
  const v = Math.abs(meshProperties(mesh).volume);
  return Number.isFinite(v) ? v : null;
}

/**
 * Write the `.mfkview` a plan describes. `source`: the document as a `.mfk`, when the author
 * ticked Include source. `displayUnits`: the document's length unit, for the viewer's readouts.
 */
export async function publishView(
  plan: PublishPlan,
  options: {
    displayUnits?: string;
    source?: Uint8Array | null;
    measurer?: Measurer | null;
  } = {},
): Promise<ActionResult<ExportedFile[]>> {
  const bodies: MfkviewInput['bodies'][number][] = [];
  for (const b of plan.bodies) {
    const mesh = publishedMesh(b.view);
    const found = b.material === null ? undefined : findMaterial(b.material);
    const material: MfkviewMaterial | null = found
      ? { id: found.id, name: found.name, density: found.density }
      : null;
    const volume = await volumeOf(b, mesh, options.measurer ?? null);
    bodies.push({
      name: b.name,
      color: b.color,
      material,
      volume,
      mass: volume !== null && material ? massGrams(volume, material.density) : null,
      mesh,
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = await writeMfkview({
      name: plan.name,
      kind: plan.kind,
      ...(options.displayUnits ? { displayUnits: options.displayUnits } : {}),
      bodies,
      parts: plan.parts,
      instances: plan.instances,
      source: options.source ?? null,
    });
  } catch (e) {
    if (e instanceof MfkviewError) return { ok: false, message: e.message };
    throw e;
  }
  const file: ExportedFile = {
    name: fileName(plan.name, MFKVIEW_EXTENSION),
    bytes,
    type: MFKVIEW_MIME,
  };
  const n = plan.bodies.length;
  const what =
    plan.kind === 'assembly'
      ? `${plan.instances.length} ${plan.instances.length === 1 ? 'instance' : 'instances'} of ${plan.parts.length} ${plan.parts.length === 1 ? 'part' : 'parts'}`
      : `${n} ${n === 1 ? 'body' : 'bodies'}`;
  const left =
    plan.skipped.length > 0 ? ` Left out (could not be built): ${plan.skipped.join(', ')}.` : '';
  const source = options.source ? ', with its source' : '';
  return {
    ok: true,
    value: [file],
    message: `Published ${file.name} (${formatBytes(bytes.length)}): ${what}${source}.${left}`,
  };
}
