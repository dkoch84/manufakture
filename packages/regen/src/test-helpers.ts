// Test-only fixtures; not exported from the package. Documents are built through core commands,
// so they are valid and their id counters are real.

import { createHash } from 'node:crypto';
import {
  applyCommand,
  createDocument,
  serialize,
  type Command,
  type DerivedFeature,
  type DerivedSource,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
  type Instance,
  type ManufaktureDocument,
  type Mate,
  type MateConnector,
  type Pose,
  type SketchFeature,
  type SketchPlane,
  type StoredExpression,
} from '@manufakture/core';

export const PART = 'part#1';

export function mm(source: string | number): StoredExpression {
  return { source: String(source), lengthUnit: 'mm', angleUnit: 'deg' };
}

export function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export const XY: SketchPlane = {
  type: 'plane',
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

/**
 * A fully constrained rectangle from the origin: e1 along +x (front, y = 0), e2 up the right
 * side, e3 back, e4 left. Constraint and entity ids start at `first`.
 */
export function rectangle(
  id: string,
  options: {
    width: string;
    depth: string;
    plane?: SketchPlane;
    at?: [number, number];
    ids?: [string, string, string, string];
    firstConstraint?: number;
  },
): SketchFeature {
  const [x, y] = options.at ?? [0, 0];
  const w = 40;
  const d = 30;
  const [a, b, c, e] = options.ids ?? ['e1', 'e2', 'e3', 'e4'];
  let k = options.firstConstraint ?? 1;
  const kid = () => `k${k++}`;
  const anchor: SketchFeature['constraints'] =
    options.at === undefined
      ? [{ id: kid(), kind: 'coincident', a: { entity: a, at: 'start' }, b: { entity: '@origin' } }]
      : [{ id: kid(), kind: 'fix', point: { entity: a, at: 'start' } }];
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: options.plane ?? XY,
    entities: [
      { id: a, kind: 'line', construction: false, start: [x, y], end: [x + w, y] },
      { id: b, kind: 'line', construction: false, start: [x + w, y], end: [x + w, y + d] },
      { id: c, kind: 'line', construction: false, start: [x + w, y + d], end: [x, y + d] },
      { id: e, kind: 'line', construction: false, start: [x, y + d], end: [x, y] },
    ],
    constraints: [
      { id: kid(), kind: 'coincident', a: { entity: a, at: 'end' }, b: { entity: b, at: 'start' } },
      { id: kid(), kind: 'coincident', a: { entity: b, at: 'end' }, b: { entity: c, at: 'start' } },
      { id: kid(), kind: 'coincident', a: { entity: c, at: 'end' }, b: { entity: e, at: 'start' } },
      { id: kid(), kind: 'coincident', a: { entity: e, at: 'end' }, b: { entity: a, at: 'start' } },
      { id: kid(), kind: 'horizontal', line: a },
      { id: kid(), kind: 'horizontal', line: c },
      { id: kid(), kind: 'vertical', line: b },
      { id: kid(), kind: 'vertical', line: e },
      ...anchor,
      {
        id: kid(),
        kind: 'distance',
        a: { entity: a, at: 'start' },
        b: { entity: a, at: 'end' },
        value: mm(options.width),
      },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: b, at: 'start' },
        b: { entity: b, at: 'end' },
        value: mm(options.depth),
      },
    ],
  };
}

export function extrude(
  id: string,
  sketch: string,
  distance: string,
  operation: ExtrudeFeature['operation'] = 'new',
): ExtrudeFeature {
  return {
    id,
    kind: 'extrude',
    name: id,
    suppressed: false,
    profile: { sketch },
    operation,
    extent: { type: 'blind', distance: mm(distance) },
    reverse: false,
  };
}

export function fillet(
  id: string,
  faces: [string, string],
  radius: string,
  refId = 'r1',
): FilletFeature {
  return {
    id,
    kind: 'fillet',
    name: id,
    suppressed: false,
    edges: [{ id: refId, ref: { faces: [...faces].sort() } }],
    radius: mm(radius),
  };
}

export function add(feature: Feature, index?: number): Command {
  return index === undefined
    ? { type: 'addFeature', partId: PART, feature }
    : { type: 'addFeature', partId: PART, feature, index };
}

export function setVariable(name: string, source: string): Command {
  return { type: 'setVariable', name, expression: mm(source) };
}

export function build(commands: readonly Command[]): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Test' });
  for (const c of commands) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

export function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

/**
 * The block of the acceptance test: a 40 x 30 rectangle (`width`, `depth`), extruded 20 mm, one
 * vertical edge (front right, between the sides swept by e1 and e2) filleted by `radius`, which
 * nothing else reads.
 */
export function block(): ManufaktureDocument {
  return build([
    setVariable('width', '40'),
    setVariable('depth', '30'),
    setVariable('radius', '3mm'),
    add(rectangle('sketch#1', { width: 'width', depth: 'depth' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    add(fillet('fillet#1', ['extrude#1:side:e1', 'extrude#1:side:e2'], 'radius')),
  ]);
}

export function statuses(result: {
  parts: { features: { featureId: string; status: string }[] }[];
}): Record<string, string> {
  return Object.fromEntries(result.parts[0]!.features.map((f) => [f.featureId, f.status]));
}

/**
 * Two bodies side by side: body `extrude#1` (a `w1` x 30 x 20 block from sketch#1) and body
 * `extrude#2` (a `w2` x 30 x 20 block from sketch#2, 100 mm along x), each with a vertical
 * front-right edge filleted by its own radius (`r1`, `r2`). Everything after extrude#2 is
 * appended by `more`, before the fillets.
 */
export function twoBodies(more: readonly Command[] = []): ManufaktureDocument {
  return build([
    setVariable('w1', '40'),
    setVariable('w2', '40'),
    setVariable('r1', '3mm'),
    setVariable('r2', '2mm'),
    add(rectangle('sketch#1', { width: 'w1', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    add(
      rectangle('sketch#2', {
        width: 'w2',
        depth: '30',
        at: [100, 0],
        ids: ['e5', 'e6', 'e7', 'e8'],
        firstConstraint: 12,
      }),
    ),
    add(extrude('extrude#2', 'sketch#2', '20')),
    ...more,
    add(fillet('fillet#1', ['extrude#1:side:e1', 'extrude#1:side:e2'], 'r1')),
    add(fillet('fillet#2', ['extrude#2:side:e5', 'extrude#2:side:e6'], 'r2', 'r2')),
  ]);
}

/** A 10 x 10 pocket sketch on the XY plane at `at`, for cuts in `twoBodies`; `n` numbers its ids. */
export function pocket(id: string, at: [number, number], n = 0): SketchFeature {
  const e = 9 + 4 * n;
  return rectangle(id, {
    width: '10',
    depth: '10',
    at,
    ids: [`e${e}`, `e${e + 1}`, `e${e + 2}`, `e${e + 3}`],
    firstConstraint: 23 + 11 * n,
  });
}

/** A pin of `data` (a source document's text), with its real size and hash. */
export function pinText(data: string, partId = PART): DerivedSource {
  return {
    documentId: 'doc-src',
    documentName: 'Source',
    versionId: 'v-1',
    versionName: 'One',
    partId,
    size: Buffer.byteLength(data, 'utf8'),
    sha256: createHash('sha256').update(data).digest('hex'),
    data,
  };
}

export const pin = (source: ManufaktureDocument, partId = PART) =>
  pinText(serialize(source), partId);

export function derivedOf(
  id: string,
  source: DerivedSource,
  extra: Partial<DerivedFeature> = {},
): DerivedFeature {
  return {
    id,
    kind: 'derived',
    name: id,
    suppressed: false,
    source,
    placement: {
      translation: [mm('0'), mm('0'), mm('0')],
      rotation: [mm('0'), mm('0'), mm('0')],
    },
    operation: 'new',
    ...extra,
  };
}

// Assemblies -----------------------------------------------------------------------------------

export const IDENTITY_POSE: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
export const LID = 'part#2';
export const ASSEMBLY = 'assembly#1';

/** A part-studio feature for a part other than `PART`. */
export function addTo(partId: string, feature: Feature): Command {
  return { type: 'addFeature', partId, feature };
}

export function instance(
  id: string,
  source: Instance['source'],
  extra: Partial<Instance> = {},
): Instance {
  return {
    id,
    name: id,
    source,
    fixed: false,
    suppressed: false,
    pose: IDENTITY_POSE,
    ...extra,
  };
}

/** A connector at the midpoint of the edge between two faces. */
export function midpoint(
  id: string,
  instanceId: string,
  refId: string,
  faces: [string, string],
  extra: Partial<MateConnector> = {},
): MateConnector {
  return {
    id,
    instance: instanceId,
    inference: 'midpoint',
    origin: { id: refId, ref: { faces: [...faces].sort() } },
    ...extra,
  } as MateConnector;
}

/** A connector at the centroid of a face. */
export function centroid(
  id: string,
  instanceId: string,
  refId: string,
  face: string,
  extra: Partial<MateConnector> = {},
): MateConnector {
  return {
    id,
    instance: instanceId,
    inference: 'centroid',
    origin: { id: refId, ref: { face } },
    ...extra,
  } as MateConnector;
}

export function mate(
  id: string,
  kind: Mate['kind'],
  a: MateConnector,
  b: MateConnector,
  extra: Partial<Mate> = {},
): Mate {
  return { id, name: id, kind, a, b, suppressed: false, ...extra };
}

/**
 * A box and a lid, with the hinge along their back edges: part#1 is a 40 x 30 x 20 box, part#2
 * a 40 x `lidDepth` x 5 lid (both rectangles from the origin: e1 front, e2 right, e3 back, e4
 * left). Assembly#1 holds the box (inst#1, fixed) and the lid (inst#2, at the origin), and
 * mate#1, a revolute between the box's top back edge and the lid's bottom back edge, flipped so
 * the lid lies on the box at angle 0.
 */
export function boxAndLid(): ManufaktureDocument {
  return build([
    setVariable('lidDepth', '30'),
    add(rectangle('sketch#1', { width: '40', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    { type: 'addPart', partId: LID, name: 'Lid' },
    addTo(LID, rectangle('sketch#1', { width: '40', depth: 'lidDepth' })),
    addTo(LID, extrude('extrude#1', 'sketch#1', '5')),
    { type: 'addAssembly', assemblyId: ASSEMBLY, name: 'Box' },
    {
      type: 'addInstance',
      assemblyId: ASSEMBLY,
      instance: instance('inst#1', { part: PART }, { fixed: true }),
    },
    { type: 'addInstance', assemblyId: ASSEMBLY, instance: instance('inst#2', { part: LID }) },
    {
      type: 'addMate',
      assemblyId: ASSEMBLY,
      mate: hinge(),
    },
  ]);
}

/** The hinge of `boxAndLid`: a revolute between the back edges. */
export function hinge(extra: Partial<MateConnector> = {}): Mate {
  return mate(
    'mate#1',
    'revolute',
    midpoint('mc#1', 'inst#1', 'r1', ['extrude#1:cap:end', 'extrude#1:side:e3']),
    midpoint('mc#2', 'inst#2', 'r2', ['extrude#1:cap:start', 'extrude#1:side:e3'], {
      flip: true,
      ...extra,
    }),
  );
}
