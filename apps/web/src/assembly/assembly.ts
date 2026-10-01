// The assembly workspace's logic, free of React (M2 plan, T2.3e): which bodies the viewport shows
// for an assembly and where, what a pick on an instance becomes as a mate connector, the mate
// form and the commands it makes, inserting instances, and the rows of the mates list.
//
// Instances share their part's body meshes (regen sends no meshes per instance): each instance
// body is the part body's viewport input under the instance view id
// `<assembly id>/<instance id>/<body id>`, with the instance's solved transform. A pick on one
// returns the name in the part's own mesh, so what a click names never depends on where the
// instance is.
//
// Solves and drags run in the regen worker (`Assembler`); nothing here solves anything.

import {
  ASSEMBLY_COUNTER,
  CONNECTOR_COUNTER,
  INSTANCE_COUNTER,
  MATE_COUNTER,
  findPart,
  previewIds,
  type Assembly,
  type Command,
  type ConnectorInference,
  type DerivedSource,
  type DisplayUnits,
  type EdgeRef,
  type FaceRef,
  type Instance,
  type InstanceSource,
  type ManufaktureDocument,
  type Mate,
  type MateConnector,
  type Pose,
  type VertexRef,
} from '@manufakture/core';
import type { Vec3 } from '@manufakture/kernel';
import type { AssemblyResult, DragResult, MateResult } from '@manufakture/regen';
import { checkExpression } from '../features/forms';
import { bodyColor, instanceViewId, parseInstanceViewId } from '../model/bodies';
import type { ModelState } from '../model/model';
import type { Variables } from '../sketcher/values';
import type { GeometryRef } from '../state/selection';
import type { BodyInput } from '../viewport/bodies';

/** Previews and drags of assemblies, in the regen worker (the scene loader's). */
export interface Assembler {
  /** Solve assembly `assemblyId` of a document not committed yet (a mate dialog's preview). */
  solve(document: ManufaktureDocument, assemblyId: string): Promise<AssemblyResult | null>;
  /**
   * One step of dragging an instance: `point` (in the instance's coordinates) toward `position`
   * (world). Coalesced in the worker: superseded steps resolve to null.
   */
  drag(
    assemblyId: string,
    instanceId: string,
    target: { point: Vec3; position: Vec3 },
  ): Promise<DragResult | null>;
  /** A drag that was not committed: the next one starts from the last regen's poses again. */
  endDrag?(assemblyId: string): void;
}

export type MateKind = Mate['kind'];

export const MATE_KIND_LABELS: Readonly<Record<MateKind, string>> = {
  fastened: 'Fastened',
  revolute: 'Revolute',
  slider: 'Slider',
  planar: 'Planar',
  cylindrical: 'Cylindrical',
  ball: 'Ball',
};

/** What each kind leaves free, for the dialog. */
export const MATE_KIND_HINTS: Readonly<Record<MateKind, string>> = {
  fastened: 'Nothing moves between the two connectors.',
  revolute: 'Turns about the z axis of the connectors.',
  slider: 'Moves along the z axis of the connectors.',
  planar: 'Moves in the xy plane of the connectors and turns about z.',
  cylindrical: 'Moves along and turns about the z axis of the connectors.',
  ball: 'Turns any way about the connectors origin.',
};

export const IDENTITY_POSE: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** The name a new assembly gets: "Assembly n", after its id `assembly#n`. */
export function newAssemblyName(assemblyId: string): string {
  const n = /#(\d+)$/.exec(assemblyId)?.[1];
  return n ? `Assembly ${n}` : 'Assembly';
}

/** The command that adds a new, empty assembly (it becomes the active tab). */
export function addAssemblyCommand(doc: ManufaktureDocument): {
  command: Command;
  label: string;
} {
  const [id] = previewIds(doc.nextIds, ASSEMBLY_COUNTER);
  const name = newAssemblyName(id!);
  return { command: { type: 'addAssembly', assemblyId: id!, name }, label: `Add ${name}` };
}

// The viewport --------------------------------------------------------------------------------

/**
 * The viewport bodies of assembly `assemblyId`: every body each instance shows, sharing its
 * part's mesh, placed by the instance's solved transform, or by `poses` where given (a drag or
 * a preview in progress). Suppressed and hidden instances are not drawn. Instances regen has
 * not placed yet (just inserted) appear with the next regen.
 */
export function assemblyBodies(
  doc: ManufaktureDocument,
  assemblyId: string,
  model: Pick<ModelState, 'parts' | 'assemblies' | 'sources'>,
  poses: ReadonlyMap<string, Pose> = new Map(),
): BodyInput[] {
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  const result = model.assemblies.find((a) => a.assemblyId === assemblyId);
  if (!assembly || !result) return [];
  const out: BodyInput[] = [];
  for (const inst of result.instances) {
    const stored = assembly.instances.find((x) => x.id === inst.instanceId);
    if (!stored || stored.suppressed || inst.status === 'suppressed') continue;
    const transform = poses.get(inst.instanceId) ?? inst.transform;
    const source =
      'part' in inst.source
        ? model.parts.find((p) => p.partId === (inst.source as { part: string }).part)?.bodies
        : model.sources.find((x) => x.key === (inst.source as { source: string }).source)?.bodies;
    if (!source) continue;
    const part = 'part' in inst.source ? findPart(doc, inst.source.part) : undefined;
    source.forEach((b, i) => {
      if (!inst.bodies.includes(b.bodyId)) return;
      const props = part?.bodies.find((p) => p.id === b.bodyId);
      out.push({
        id: instanceViewId(assemblyId, inst.instanceId, b.bodyId),
        mesh: b.view.mesh,
        names: b.view.names,
        topology: b.view.topology ?? null,
        color: bodyColor(props, i),
        transform,
      });
    });
  }
  return out;
}

/** The instance a viewport body belongs to, in assembly `assemblyId`; null for any other body. */
export function instanceOf(viewId: string, assemblyId: string): string | null {
  const parsed = parseInstanceViewId(viewId);
  return parsed && parsed.assemblyId === assemblyId ? parsed.instanceId : null;
}

// Connectors ----------------------------------------------------------------------------------

/**
 * The points a connector can take on picked geometry, the default first: a planar face's
 * centroid; the centre of a cylinder, cone or sphere (or its centroid); a circular edge's centre
 * (or its midpoint); any other edge's midpoint; a vertex.
 */
export function inferencesFor(
  kind: 'face' | 'edge' | 'vertex',
  geometry: string | null,
): ConnectorInference[] {
  if (kind === 'vertex') return ['vertex'];
  if (kind === 'face') {
    return geometry === 'cylinder' || geometry === 'cone' || geometry === 'sphere'
      ? ['centre', 'centroid']
      : ['centroid'];
  }
  return geometry === 'circle' ? ['centre', 'midpoint'] : ['midpoint'];
}

export const INFERENCE_LABELS: Readonly<Record<ConnectorInference, string>> = {
  centroid: 'Centroid',
  centre: 'Centre',
  midpoint: 'Midpoint',
  vertex: 'Vertex',
};

/** The 1-based face, edge or vertex a geometry reference names on its body, or null. */
export function subShapeOf(body: BodyInput, geo: GeometryRef): number | null {
  if (geo.kind === 'vertex') {
    const n = Number(/vertex:(\d+)$/.exec(geo.name)?.[1]);
    return Number.isInteger(n) && n >= 1 && n <= (body.topology?.vertices.length ?? 0) ? n : null;
  }
  const slot = body.names.indexOf(geo.name);
  if (slot < 0) return null;
  const slots = geo.kind === 'face' ? body.mesh.faceNames : body.mesh.edgeNames;
  const i = slots.indexOf(slot);
  return i < 0 ? null : i + 1;
}

/** The surface or curve type of a picked face or edge (`plane`, `circle`, ...), from topology. */
export function geometryOf(body: BodyInput, kind: 'face' | 'edge' | 'vertex', index: number) {
  if (kind === 'face') return body.topology?.faces[index - 1]?.surface ?? null;
  if (kind === 'edge') return body.topology?.edges[index - 1]?.curve ?? null;
  return null;
}

/**
 * Where a connector with `inference` sits on sub-shape `index` of `body`, in the body's own
 * coordinates, from the mesh's topology: for showing it before regen finds the exact frame.
 * Null when the topology does not say.
 */
export function connectorPoint(
  body: BodyInput,
  kind: 'face' | 'edge' | 'vertex',
  index: number,
  inference: ConnectorInference,
): Vec3 | null {
  const topology = body.topology;
  if (!topology) return null;
  if (kind === 'vertex') return topology.vertices[index - 1]?.point ?? null;
  if (kind === 'face') return topology.faces[index - 1]?.centroid ?? null;
  const edge = topology.edges[index - 1];
  if (!edge) return null;
  if (inference !== 'centre') return edge.midpoint;
  // A circle through three points of the edge's polyline: first, middle and last.
  const first = body.mesh.edgeRanges[(index - 1) * 2]!;
  const count = body.mesh.edgeRanges[(index - 1) * 2 + 1]!;
  if (count < 3) return edge.midpoint;
  const at = (k: number): Vec3 => {
    const p = body.mesh.edgePositions.subarray((first + k) * 3, (first + k) * 3 + 3);
    return [p[0]!, p[1]!, p[2]!];
  };
  // A closed circle repeats its first point last: take a third of the way round instead.
  const closed = edge.vertices.length === 1;
  const a = at(0);
  const b = at(Math.floor((count - 1) / (closed ? 3 : 2)));
  const c = at(closed ? Math.floor((2 * (count - 1)) / 3) : count - 1);
  return circumcentre(a, b, c) ?? edge.midpoint;
}

/** The centre of the circle through three points, or null when they are in a line. */
export function circumcentre(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-18) return null;
  // a + ((|ac|^2 (n x ab)) + (|ab|^2 (ac x n))) / (2 |n|^2)
  const t1 = scale(cross(n, ab), dot(ac, ac));
  const t2 = scale(cross(ac, n), dot(ab, ab));
  return add(a, scale(add(t1, t2), 1 / (2 * nn)));
}

/** One end of a mate as the dialog holds it: picked geometry on an instance and its rule. */
export interface ConnectorChoice {
  instanceId: string;
  /** The instance view id of the body it was picked on. */
  viewId: string;
  kind: 'face' | 'edge' | 'vertex';
  /** 1-based face, edge or vertex on that body, for showing it. */
  index: number;
  /** The reference to store, in the instance's part's names. */
  ref: FaceRef | EdgeRef | VertexRef;
  inference: ConnectorInference;
  /** The rules the geometry allows, the default first. */
  inferences: readonly ConnectorInference[];
}

export type ChoiceOutcome = { ok: true; choice: ConnectorChoice } | { ok: false; message: string };

/** What the dialog needs to turn a pick into a stored reference. */
export interface ConnectorContext {
  assemblyId: string;
  bodies: readonly BodyInput[];
  /** The kernel's references for edges and vertices (`Referencer`). */
  edge(viewId: string, index: number): Promise<{ ok: true; value: FaceRef | EdgeRef } | Fail>;
  vertex(viewId: string, index: number): Promise<{ ok: true; value: VertexRef } | Fail>;
}

type Fail = { ok: false; message: string };

/** Turn a pick on an instance into a connector choice with its default rule. */
export async function choiceFromPick(
  geo: GeometryRef,
  ctx: ConnectorContext,
): Promise<ChoiceOutcome> {
  const instanceId = instanceOf(geo.bodyId, ctx.assemblyId);
  const body = ctx.bodies.find((b) => b.id === geo.bodyId);
  if (instanceId === null || !body) {
    return { ok: false, message: 'Pick a face, edge or vertex of an instance.' };
  }
  if (geo.kind !== 'vertex' && geo.placeholder) {
    return { ok: false, message: `That ${geo.kind} has no stable name to refer to.` };
  }
  const index = subShapeOf(body, geo);
  if (index === null) return { ok: false, message: `That ${geo.kind} is not on the instance.` };
  const inferences = inferencesFor(geo.kind, geometryOf(body, geo.kind, index));
  let ref: FaceRef | EdgeRef | VertexRef;
  if (geo.kind === 'face') ref = { face: geo.name };
  else {
    const r =
      geo.kind === 'edge' ? await ctx.edge(geo.bodyId, index) : await ctx.vertex(geo.bodyId, index);
    if (!r.ok) return r;
    ref = r.value;
  }
  return {
    ok: true,
    choice: {
      instanceId,
      viewId: geo.bodyId,
      kind: geo.kind,
      index,
      ref,
      inference: inferences[0]!,
      inferences,
    },
  };
}

/** A connector stored in a mate, as the dialog shows it again when the mate is edited. */
export function choiceFromConnector(
  c: MateConnector,
  assemblyId: string,
  bodies: readonly BodyInput[],
): ConnectorChoice {
  const kind: ConnectorChoice['kind'] =
    c.inference === 'vertex' ? 'vertex' : 'face' in c.origin.ref ? 'face' : 'edge';
  // Find it on a shown body of the instance, for the marker; index 0 when it is not found.
  let viewId = '';
  let index = 0;
  for (const b of bodies) {
    if (instanceOf(b.id, assemblyId) !== c.instance) continue;
    viewId ||= b.id;
    const name =
      kind === 'face' ? (c.origin.ref as FaceRef).face : kind === 'edge' ? edgeName(c, b) : null;
    if (name === null) continue;
    const slot = b.names.indexOf(name);
    const slots = kind === 'face' ? b.mesh.faceNames : b.mesh.edgeNames;
    const i = slot < 0 ? -1 : slots.indexOf(slot);
    if (i >= 0) {
      viewId = b.id;
      index = i + 1;
      break;
    }
  }
  const geometry =
    viewId && index > 0
      ? geometryOf(
          bodies.find((b) => b.id === viewId)!,
          kind,
          index,
        )
      : null;
  const inferences = inferencesFor(kind, geometry);
  return {
    instanceId: c.instance,
    viewId,
    kind,
    index,
    ref: c.origin.ref,
    inference: c.inference,
    inferences: inferences.includes(c.inference) ? inferences : [c.inference, ...inferences],
  };
}

/** The mesh's name of an edge a connector names by its two faces, if the body has it. */
function edgeName(c: MateConnector, body: BodyInput): string | null {
  const faces = [...(c.origin.ref as EdgeRef).faces].sort();
  if (faces.length !== 2 || !body.topology) return null;
  const faceName = (f: number) => body.names[body.mesh.faceNames[f - 1]!];
  const edge = body.topology.edges.find((e) => {
    const names = e.faces.map(faceName).sort();
    return names.length === 2 && names[0] === faces[0] && names[1] === faces[1];
  });
  if (!edge) return null;
  return body.names[body.mesh.edgeNames[edge.index - 1]!] ?? null;
}

/** A short label for a connector choice: instance, what it is on, the rule. */
export function choiceLabel(choice: ConnectorChoice, assembly: Assembly | undefined): string {
  const name =
    assembly?.instances.find((x) => x.id === choice.instanceId)?.name ?? choice.instanceId;
  const ref = choice.ref;
  const what =
    'face' in ref
      ? ref.face
      : choice.kind === 'edge'
        ? ref.faces.join(' | ')
        : ref.faces.join(' & ');
  return `${name}: ${INFERENCE_LABELS[choice.inference].toLowerCase()} of ${what}`;
}

// The mate form ------------------------------------------------------------------------------

export interface MateForm {
  kind: MateKind;
  name: string;
  a: ConnectorChoice | null;
  b: ConnectorChoice | null;
  /** On the second connector: turn its z axis round. */
  flip: boolean;
  /** On the second connector: quarter turns about z. */
  rotate: 0 | 1 | 2 | 3;
  /**
   * Where the second instance goes relative to the first connector: along its x, y and z, and a
   * turn about its z. Stored as the first connector's offset, which moves the frame the second
   * connector is placed on.
   */
  offset: { x: string; y: string; z: string; angle: string };
  /** Revolute (angles) and slider (lengths) only; empty: no bound. */
  limits: { min: string; max: string };
}

const NO_OFFSET = { x: '0', y: '0', z: '0', angle: '0' };

export function newMateForm(kind: MateKind = 'fastened'): MateForm {
  return {
    kind,
    name: '',
    a: null,
    b: null,
    flip: false,
    rotate: 0,
    offset: { ...NO_OFFSET },
    limits: { min: '', max: '' },
  };
}

/** The form of a stored mate, for editing it. */
export function mateFormOf(mate: Mate, assemblyId: string, bodies: readonly BodyInput[]): MateForm {
  const off = mate.a.offset;
  return {
    kind: mate.kind,
    name: mate.name,
    a: choiceFromConnector(mate.a, assemblyId, bodies),
    b: choiceFromConnector(mate.b, assemblyId, bodies),
    flip: mate.b.flip ?? false,
    rotate: mate.b.rotate ?? 0,
    offset: off
      ? {
          x: off.translation[0].source,
          y: off.translation[1].source,
          z: off.translation[2].source,
          angle: off.rotation[2].source,
        }
      : { ...NO_OFFSET },
    limits: { min: mate.limits?.min?.source ?? '', max: mate.limits?.max?.source ?? '' },
  };
}

export function hasLimits(kind: MateKind): boolean {
  return kind === 'revolute' || kind === 'slider';
}

export type MateBuild =
  | { ok: true; mate: Mate; command: Command; label: string }
  | {
      ok: false;
      errors: Partial<
        Record<
          | keyof MateForm
          | 'offset.x'
          | 'offset.y'
          | 'offset.z'
          | 'offset.angle'
          | 'limits.min'
          | 'limits.max',
          string
        >
      >;
    };

/**
 * The mate a filled form makes, and the command that adds it (or edits `existing`, keeping its
 * ids). New ids come from the assembly's counters. Field errors are keyed by form field.
 */
export function buildMate(
  form: MateForm,
  ctx: {
    assembly: Assembly;
    units: DisplayUnits;
    variables: Variables;
    existing?: Mate;
  },
): MateBuild {
  const errors: Extract<MateBuild, { ok: false }>['errors'] = {};
  if (!form.a) errors.a = 'Pick the first connector.';
  if (!form.b) errors.b = 'Pick the second connector.';
  if (form.a && form.b && form.a.instanceId === form.b.instanceId) {
    errors.b = 'The two connectors must be on different instances.';
  }
  const { units, variables } = ctx;
  const value = (
    key: 'offset.x' | 'offset.y' | 'offset.z' | 'offset.angle' | 'limits.min' | 'limits.max',
    text: string,
    kind: 'length' | 'angle',
  ) => {
    const r = checkExpression(text, kind, units, variables);
    if (!r.ok) {
      errors[key] = r.message;
      return null;
    }
    return r;
  };
  const off = form.offset;
  const ox = value('offset.x', off.x, 'length');
  const oy = value('offset.y', off.y, 'length');
  const oz = value('offset.z', off.z, 'length');
  const oa = value('offset.angle', off.angle, 'angle');
  let limits: Mate['limits'];
  if (hasLimits(form.kind)) {
    const kind = form.kind === 'revolute' ? 'angle' : 'length';
    const min = form.limits.min.trim() === '' ? null : value('limits.min', form.limits.min, kind);
    const max = form.limits.max.trim() === '' ? null : value('limits.max', form.limits.max, kind);
    if (min && max && min.value > max.value) {
      errors['limits.max'] = 'The maximum must not be below the minimum.';
    }
    if (min || max) {
      limits = {};
      if (min) limits.min = min.expression;
      if (max) limits.max = max.expression;
    }
  }
  if (Object.keys(errors).length > 0 || !form.a || !form.b || !ox || !oy || !oz || !oa) {
    return { ok: false, errors };
  }

  const { assembly, existing } = ctx;
  const counters = assembly.nextIds;
  const [mateId] = existing ? [existing.id] : previewIds(counters, MATE_COUNTER);
  const fresh = previewIds(counters, CONNECTOR_COUNTER, 2);
  const refs = previewIds(counters, 'r', 2);
  const ids = {
    a: existing
      ? { id: existing.a.id, ref: existing.a.origin.id }
      : { id: fresh[0]!, ref: refs[0]! },
    b: existing
      ? { id: existing.b.id, ref: existing.b.origin.id }
      : { id: fresh[1]!, ref: refs[1]! },
  };
  // What the dialog does not show (a flip or turns of the first connector, an offset of the
  // second, rotations about x and y of the first's offset) is kept from the mate being edited.
  const connector = (side: 'a' | 'b', choice: ConnectorChoice): MateConnector => {
    const kept = existing?.[side];
    const c = {
      id: ids[side].id,
      instance: choice.instanceId,
      inference: choice.inference,
      origin: { id: ids[side].ref, ref: choice.ref },
    } as MateConnector;
    if (side === 'a') {
      if (kept?.flip) c.flip = true;
      if (kept?.rotate !== undefined) c.rotate = kept.rotate;
      const zero = { ...oa.expression, source: '0' };
      const [rx, ry] = kept?.offset?.rotation ?? [zero, zero];
      const turned = [rx, ry].some((e) => !/^\s*0*(\.0*)?\s*$/.test(e.source));
      const moved = [ox, oy, oz, oa].some((v) => v.value !== 0);
      if (moved || turned) {
        c.offset = {
          translation: [ox.expression, oy.expression, oz.expression],
          rotation: [rx, ry, oa.expression],
        };
      }
    } else {
      if (form.flip) c.flip = true;
      if (form.rotate !== 0) c.rotate = form.rotate;
      if (kept?.offset) c.offset = kept.offset;
    }
    return c;
  };
  const n = Number(/#(\d+)$/.exec(mateId!)?.[1] ?? '1');
  const name = form.name.trim() || existing?.name || `${MATE_KIND_LABELS[form.kind]} ${n}`;
  const mate: Mate = {
    id: mateId!,
    name,
    kind: form.kind,
    a: connector('a', form.a),
    b: connector('b', form.b),
    suppressed: existing?.suppressed ?? false,
    ...(limits ? { limits } : {}),
  };
  return existing
    ? {
        ok: true,
        mate,
        command: { type: 'editMate', assemblyId: assembly.id, mate },
        label: `Edit ${existing.name}`,
      }
    : {
        ok: true,
        mate,
        command: { type: 'addMate', assemblyId: assembly.id, mate },
        label: `Add ${name}`,
      };
}

/**
 * The mate command with the poses a solve moved, as one undo step: the mate and where its
 * instances went (M2 plan, T2.3b: commit poses after mate edits, never per frame).
 */
export function withPoses(
  command: Command,
  assemblyId: string,
  moved: Readonly<Record<string, Pose>>,
): Command {
  if (Object.keys(moved).length === 0) return command;
  return {
    type: 'batch',
    commands: [command, { type: 'setPoses', assemblyId, poses: { ...moved } }],
  };
}

/** The poses of the instances a solve moved, from its result. */
export function movedPoses(result: AssemblyResult | null | undefined): Record<string, Pose> {
  const out: Record<string, Pose> = {};
  for (const inst of result?.instances ?? []) if (inst.moved) out[inst.instanceId] = inst.transform;
  return out;
}

// Inserting ----------------------------------------------------------------------------------

/**
 * The command that inserts an instance of `source` into `assembly`, last, at the origin. The
 * first instance of an assembly is fixed, so the others have something to be mated to.
 */
export function insertCommand(
  assembly: Assembly,
  source: InstanceSource,
  name: string,
): { command: Command; label: string; instanceId: string } {
  const [id] = previewIds(assembly.nextIds, INSTANCE_COUNTER);
  const instance: Instance = {
    id: id!,
    name: uniqueName(
      name,
      assembly.instances.map((x) => x.name),
    ),
    source,
    fixed: assembly.instances.length === 0,
    suppressed: false,
    pose: IDENTITY_POSE,
  };
  return {
    command: { type: 'addInstance', assemblyId: assembly.id, instance },
    label: `Insert ${instance.name}`,
    instanceId: id!,
  };
}

/** `base` followed by the lowest number no name in `taken` has: "Lid 1", "Lid 2". */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** What an instance shows, for the list: its part, or the pinned part with its version. */
export function sourceLabel(doc: ManufaktureDocument, source: InstanceSource): string {
  if ('part' in source) return findPart(doc, source.part)?.name ?? source.part;
  const pin = source as DerivedSource;
  return `${pin.partId} of ${pin.documentName} at ${pin.versionName}`;
}

// The mates list -----------------------------------------------------------------------------

export type MateRowStatus = MateResult['status'] | 'pending';

export interface MateRow {
  id: string;
  name: string;
  kind: MateKind;
  suppressed: boolean;
  status: MateRowStatus;
  /** Why it is not ok, in a sentence: the solver's message, regen's error, or the group's. */
  message: string | null;
  /** The newest mate of a conflicting or redundant group it is in: the one to change. */
  blamed: boolean;
}

/** The rows of the mates list, in creation order, with what the last solve said of each. */
export function mateRows(assembly: Assembly, result: AssemblyResult | undefined): MateRow[] {
  return assembly.mates.map((mate) => {
    const r = result?.mates.find((m) => m.mateId === mate.id);
    const groups = [...(result?.conflicting ?? []), ...(result?.redundant ?? [])];
    const group = groups.find((g) => g.mates.includes(mate.id));
    const message = r
      ? r.status === 'error'
        ? (r.errors[0]?.message ?? r.message ?? null)
        : r.status === 'ok'
          ? (r.warnings[0]?.message ?? null)
          : (group?.message ?? r.message ?? null)
      : null;
    return {
      id: mate.id,
      name: mate.name,
      kind: mate.kind,
      suppressed: mate.suppressed,
      status: r ? r.status : 'pending',
      message,
      blamed: group?.blame === mate.id,
    };
  });
}

/** The assembly's state in a line: its degrees of freedom, or why there are none to count. */
export function assemblySummary(result: AssemblyResult | undefined): string {
  if (!result) return 'Solving...';
  if (result.outcome === 'conflicting' || result.dof === null) {
    return result.message ?? 'Mates conflict: change or suppress the mate marked to blame.';
  }
  const dof =
    result.dof === 0
      ? 'Fully constrained'
      : `${result.dof} degree${result.dof === 1 ? '' : 's'} of freedom`;
  return result.outcome === 'invalid' && result.message ? `${dof}. ${result.message}` : dof;
}

/** Instances that mates connect, so deleting them is refused: the mates' names, per instance. */
export function instanceBlockers(assembly: Assembly): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of assembly.mates) {
    for (const id of new Set([m.a.instance, m.b.instance])) {
      out.set(id, [...(out.get(id) ?? []), m.name]);
    }
  }
  return out;
}

// Small vectors ------------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
