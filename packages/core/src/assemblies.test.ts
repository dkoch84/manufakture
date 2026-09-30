import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import {
  CommandSchema,
  applyCommand,
  partInstances,
  rowInstances,
  variableUsers,
  type Command,
} from './commands';
import { deserialize, serialize } from './format';
import { instanceMates, isPinnedSource, mateExpressions, mateIds } from './features';
import { previewIds } from './ids';
import type { CoreErrorCode } from './result';
import {
  AssemblySchema,
  DocumentSchema,
  InstanceSchema,
  MateConnectorSchema,
  MateSchema,
  PoseSchema,
  type DerivedSource,
  type Instance,
  type ManufaktureDocument,
  type Mate,
  type MateConnector,
  type Pose,
} from './schema';
import { DocumentStore } from './store';
import { validateDocument } from './validate';
import { inlineVariable, renameVariable } from './variables';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';

/** Assemblies (format v7): schema, validation, commands and their inverses, blocking, changes. */

const A = 'assembly#1';
const IDENTITY: Pose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
const LIFTED: Pose = { translation: [0, 0, 6], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r.ok ? undefined : r.error;
}

/** Assemblies without their counters, which undo never moves back. */
function content(doc: ManufaktureDocument) {
  return doc.assemblies.map(({ nextIds: _n, ...rest }) => (void _n, rest));
}

/**
 * Applies `command`, then its inverse, then the inverse of that, checking each step: undo gives
 * back the assemblies and parts, except that no counter goes back, and redo gives back the result.
 */
function roundTrip(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const done = apply(doc, command);
  const undone = apply(done.document, done.inverse);
  expect(content(undone.document)).toEqual(content(doc));
  expect(undone.document.parts).toEqual(doc.parts);
  for (const a of undone.document.assemblies) {
    expect(a.nextIds).toEqual(
      done.document.assemblies.find((x) => x.id === a.id)?.nextIds ?? a.nextIds,
    );
  }
  const redone = apply(undone.document, undone.inverse);
  expect(redone.document.assemblies).toEqual(done.document.assemblies);
  return done.document;
}

function instance(id: string, part: string, extra: Partial<Instance> = {}): Instance {
  return {
    id,
    name: `Instance ${id.slice(5)}`,
    source: { part },
    fixed: false,
    suppressed: false,
    pose: IDENTITY,
    ...extra,
  };
}

function hingeConnector(): MateConnector {
  return {
    id: 'mc#1',
    instance: 'inst#1',
    inference: 'centre',
    origin: { id: 'r1', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e2'] } },
  };
}

function lidConnector(): MateConnector {
  return {
    id: 'mc#2',
    instance: 'inst#2',
    inference: 'centroid',
    origin: { id: 'r2', ref: { face: 'extrude#1:cap:start' } },
    flip: true,
    rotate: 2,
    offset: {
      translation: [mm('0'), mm('0'), mm('thickness / 2')],
      rotation: [mm('0'), mm('0'), mm('90deg')],
    },
  };
}

/** A connector at the centroid of a face. */
function atFace(id: string, instanceId: string, refId: string, face: string): MateConnector {
  return { id, instance: instanceId, inference: 'centroid', origin: { id: refId, ref: { face } } };
}

function hinge(extra: Partial<Mate> = {}): Mate {
  return {
    id: 'mate#1',
    name: 'Hinge',
    kind: 'revolute',
    a: hingeConnector(),
    b: lidConnector(),
    suppressed: false,
    limits: { min: mm('0deg'), max: mm('110deg') },
    ...extra,
  };
}

/** The bracket, a second part studio, an empty assembly. */
function withAssembly(): ManufaktureDocument {
  let doc = bracket();
  doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' }).document;
  doc = apply(doc, { type: 'addAssembly', assemblyId: A, name: 'Box' }).document;
  return deepFreeze(doc);
}

/** `withAssembly` with inst#1 (the bracket, fixed), inst#2 (the lid) and the hinge mate#1. */
function hinged(): ManufaktureDocument {
  let doc = withAssembly();
  doc = apply(doc, {
    type: 'addInstance',
    assemblyId: A,
    instance: instance('inst#1', PART, { fixed: true }),
  }).document;
  doc = apply(doc, {
    type: 'addInstance',
    assemblyId: A,
    instance: instance('inst#2', 'part#2'),
  }).document;
  doc = apply(doc, { type: 'addMate', assemblyId: A, mate: hinge() }).document;
  return deepFreeze(doc);
}

const assembly = (doc: ManufaktureDocument, i = 0) => doc.assemblies[i]!;

/** `doc` with a configuration table holding one row, `cfg#1`. */
function withRow(doc: ManufaktureDocument): ManufaktureDocument {
  return apply(doc, {
    type: 'setConfigRow',
    row: { id: 'cfg#1', name: 'Tall', values: {} },
  }).document;
}

function pinnedSource(): DerivedSource {
  return {
    documentId: 'doc-src',
    documentName: 'Hardware',
    versionId: 'v-1',
    versionName: 'Release 1',
    partId: 'part#1',
    configuration: 'cfg#2',
    size: 2,
    sha256: 'a'.repeat(64),
    data: '{}',
  };
}

describe('schema', () => {
  it('accepts every connector inference with its reference kind', () => {
    const connectors: MateConnector[] = [
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'centroid',
        origin: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
      },
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'centre',
        origin: { id: 'r1', ref: { face: 'revolve#1:side:e1' } },
      },
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'centre',
        origin: { id: 'r1', ref: { faces: ['a#1:x', 'b#1:y'] } },
      },
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'midpoint',
        origin: { id: 'r1', ref: { faces: ['a#1:x'], ends: ['c#1:z'], ordinal: 2 } },
      },
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'vertex',
        origin: {
          id: 'r1',
          ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1', 'extrude#1:side:e2'] },
          lastResolved: { point: [0, 0, 6], direction: [0, 0, 1] },
        },
      },
      {
        id: 'mc#1',
        instance: 'inst#1',
        inference: 'vertex',
        origin: { id: 'r1', ref: { faces: ['revolve#1:side:e1'], ordinal: 2 } },
      },
      lidConnector(),
    ];
    for (const c of connectors)
      expect(MateConnectorSchema.safeParse(c).success, c.inference).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a centroid of an edge', { ...hingeConnector(), inference: 'centroid' }],
    ['a midpoint of a face', { ...lidConnector(), inference: 'midpoint' }],
    [
      'a vertex with no faces',
      { ...hingeConnector(), inference: 'vertex', origin: { id: 'r1', ref: { faces: [] } } },
    ],
    ['a vertex given as a face', { ...lidConnector(), inference: 'vertex' }],
    [
      'a vertex ordinal of 0',
      {
        ...hingeConnector(),
        inference: 'vertex',
        origin: { id: 'r1', ref: { faces: ['a#1:x'], ordinal: 0 } },
      },
    ],
    [
      'a fractional vertex ordinal',
      {
        ...hingeConnector(),
        inference: 'vertex',
        origin: { id: 'r1', ref: { faces: ['a#1:x'], ordinal: 1.5 } },
      },
    ],
    ['an unknown inference', { ...hingeConnector(), inference: 'corner' }],
    ['rotate 4', { ...hingeConnector(), rotate: 4 }],
    ['rotate 0', { ...hingeConnector(), rotate: 0 }],
    [
      'an offset without a rotation',
      { ...hingeConnector(), offset: { translation: [mm('1'), mm('1'), mm('1')] } },
    ],
    ['a feature id as connector id', { ...hingeConnector(), id: 'extrude#1' }],
    [
      'a split reference id',
      { ...hingeConnector(), origin: { id: 'r1', ref: { face: 'x#1:y' } }, id: 'mc#1#a' },
    ],
    ['an unknown key', { ...hingeConnector(), color: '#ffffff' }],
    ['a 17-digit connector id', { ...hingeConnector(), id: `mc#${'1'.repeat(17)}` }],
  ])('refuses a connector with %s', (_label, value) => {
    expect(MateConnectorSchema.safeParse(value).success).toBe(false);
  });

  it('checks mate kinds and limits', () => {
    for (const kind of [
      'fastened',
      'revolute',
      'slider',
      'planar',
      'cylindrical',
      'ball',
    ] as const) {
      const { limits: _limits, ...rest } = hinge();
      void _limits;
      expect(MateSchema.safeParse({ ...rest, kind }).success, kind).toBe(true);
    }
    expect(MateSchema.safeParse(hinge({ kind: 'slider', limits: { max: mm('20') } })).success).toBe(
      true,
    );
    expect(MateSchema.safeParse(hinge({ kind: 'planar' })).success).toBe(false);
    expect(MateSchema.safeParse(hinge({ kind: 'fastened' })).success).toBe(false);
    expect(MateSchema.safeParse(hinge({ limits: {} })).success).toBe(false);
    expect(MateSchema.safeParse({ ...hinge(), kind: 'gear' }).success).toBe(false);
    expect(MateSchema.safeParse({ ...hinge(), name: '  ' }).success).toBe(false);
    expect(MateSchema.safeParse({ ...hinge(), name: 'x'.repeat(201) }).success).toBe(false);
  });

  it('checks poses: finite, with a unit quaternion', () => {
    expect(PoseSchema.safeParse(IDENTITY).success).toBe(true);
    expect(PoseSchema.safeParse(LIFTED).success).toBe(true);
    expect(PoseSchema.safeParse({ ...IDENTITY, rotation: [0, 0, 0, 2] }).success).toBe(false);
    expect(PoseSchema.safeParse({ ...IDENTITY, rotation: [0, 0, 0, 0] }).success).toBe(false);
    expect(PoseSchema.safeParse({ ...IDENTITY, rotation: [0, 0, 1] }).success).toBe(false);
    expect(PoseSchema.safeParse({ ...IDENTITY, translation: [0, 0, Infinity] }).success).toBe(
      false,
    );
    expect(PoseSchema.safeParse({ ...IDENTITY, translation: [0, NaN, 0] }).success).toBe(false);
    expect(PoseSchema.safeParse({ ...IDENTITY, scale: 1 }).success).toBe(false);
    expect(PoseSchema.safeParse({ ...IDENTITY, translation: [-1e9, 0, 1e9] }).success).toBe(true);
    const far = PoseSchema.safeParse({ ...IDENTITY, translation: [0, 1e9 + 1, 0] });
    expect(far.success).toBe(false);
    expect(far.error?.issues[0]?.path).toEqual(['translation', 1]);
  });

  it('accepts part and pinned instance sources, each with an optional configuration', () => {
    const cases: Instance['source'][] = [
      { part: PART },
      { part: PART, configuration: 'cfg#1' },
      pinnedSource(),
    ];
    for (const source of cases) {
      expect(InstanceSchema.safeParse(instance('inst#1', PART, { source })).success).toBe(true);
    }
    expect(isPinnedSource({ part: PART })).toBe(false);
    expect(isPinnedSource(pinnedSource())).toBe(true);
    const bad: unknown[] = [
      { part: '' },
      { part: 'x'.repeat(4097) },
      { part: PART, configuration: 'row1' },
      { part: PART, documentId: 'doc-src' },
      { ...pinnedSource(), size: 3 },
      { ...pinnedSource(), configuration: 'x' },
    ];
    for (const source of bad) {
      expect(InstanceSchema.safeParse(instance('inst#1', PART, { source } as never)).success).toBe(
        false,
      );
    }
  });

  it('checks instance fields and caps lists', () => {
    const ok = instance('inst#1', PART, { bodies: ['extrude#1', 'derived#1:from/extrude#2'] });
    expect(InstanceSchema.safeParse(ok).success).toBe(true);
    expect(InstanceSchema.safeParse({ ...ok, bodies: [] }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ...ok, bodies: ['nope'] }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ...ok, id: 'instance#1' }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ...ok, id: 'inst#0' }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ...ok, fixed: 'yes' }).success).toBe(false);
    const { pose: _pose, ...noPose } = ok;
    void _pose;
    expect(InstanceSchema.safeParse(noPose).success).toBe(false);
    const big = {
      id: A,
      name: 'Big',
      instances: Array.from({ length: 10_001 }, (_, i) => instance(`inst#${i + 1}`, PART)),
      mates: [],
      nextIds: {},
    };
    expect(AssemblySchema.safeParse(big).success).toBe(false);
    expect(AssemblySchema.safeParse({ ...big, instances: big.instances.slice(0, 3) }).success).toBe(
      true,
    );
    expect(AssemblySchema.safeParse({ ...big, instances: [], id: 'assembly#01' }).success).toBe(
      false,
    );
  });

  it('requires the assembly list in a version 7 document', () => {
    const { assemblies: _a, ...rest } = hinged();
    void _a;
    expect(DocumentSchema.safeParse(rest).success).toBe(false);
    expect(DocumentSchema.safeParse(hinged()).success).toBe(true);
  });
});

describe('validation', () => {
  type Mutable = { assemblies: Record<string, unknown>[]; nextIds: Record<string, number> };
  const broken = (change: (d: ManufaktureDocument & Mutable) => void) => {
    const d = clone(hinged()) as ManufaktureDocument & Mutable;
    change(d);
    return validateDocument(d);
  };
  const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

  it('accepts a valid assembly', () => {
    expect(validateDocument(hinged())).toEqual([]);
  });

  it.each<[string, (d: ManufaktureDocument & Mutable) => void, CoreErrorCode, RegExp]>([
    [
      'an assembly id past the counter',
      (d) => (d.nextIds.assembly = 1),
      'invalid-id',
      /Assembly id "assembly#1" was never allocated/,
    ],
    [
      'an assembly id used twice',
      (d) => {
        d.assemblies.push(clone(d.assemblies[0]!));
      },
      'duplicate',
      /Assembly id "assembly#1" is used twice/,
    ],
    [
      'an instance id past the counter',
      (d) => (d.assemblies[0]!.nextIds = { ...(d.assemblies[0]!.nextIds as object), inst: 2 }),
      'invalid-id',
      /"inst#2" in assembly assembly#1 was never allocated \(next is inst#2\)/,
    ],
    [
      'a mate id past the counter',
      (d) => (d.assemblies[0]!.nextIds = { ...(d.assemblies[0]!.nextIds as object), mate: 1 }),
      'invalid-id',
      /"mate#1" .* never allocated/,
    ],
    [
      'a connector id past the counter',
      (d) => (d.assemblies[0]!.nextIds = { ...(d.assemblies[0]!.nextIds as object), mc: 2 }),
      'invalid-id',
      /"mc#2" .* never allocated/,
    ],
    [
      'a reference id past the counter',
      (d) => (d.assemblies[0]!.nextIds = { ...(d.assemblies[0]!.nextIds as object), r: 2 }),
      'invalid-id',
      /"r2" .* never allocated \(next is r2\)/,
    ],
    [
      'a connector id used twice',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.id = 'mc#1'),
      'duplicate',
      /"mc#1" is used twice in assembly assembly#1/,
    ],
    [
      'a reference id used twice',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.origin.id = 'r1'),
      'duplicate',
      /"r1" is used twice/,
    ],
    [
      'an instance of a part that does not exist',
      (d) => ((d.assemblies[0]!.instances as Instance[])[1]!.source = { part: 'part#9' }),
      'dependency',
      /Instance inst#2 shows part part#9, which does not exist/,
    ],
    [
      'a body shown twice',
      (d) => ((d.assemblies[0]!.instances as Instance[])[1]!.bodies = ['extrude#1', 'extrude#1']),
      'duplicate',
      /listed twice in the bodies instance inst#2 shows/,
    ],
    [
      'a connector on a missing instance',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.instance = 'inst#9'),
      'dependency',
      /connects inst#9, which is not an instance of assembly assembly#1/,
    ],
    [
      'a mate of an instance with itself',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.instance = 'inst#1'),
      'dependency',
      /connects inst#1 to itself/,
    ],
    [
      'an offset naming an unknown variable',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.offset!.translation[2] = mm('depth')),
      'unknown-variable',
      /Unknown variable "depth"/,
    ],
    [
      'a limit that does not parse',
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.limits = { max: mm('90 +') }),
      'expression',
      /Invalid expression "90 \+"/,
    ],
  ])('refuses %s', (_label, change, code, message) => {
    const issues = broken(change);
    expect(codes(issues)).toContain(code);
    expect(issues.map((i) => i.message).join('\n')).toMatch(message);
  });

  it('reports paths into the assembly', () => {
    const issues = broken((d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.instance = 'inst#9'));
    expect(issues[0]!.path).toEqual(['assemblies', 0, 'mates', 0, 'b', 'instance']);
    const expr = broken(
      (d) => ((d.assemblies[0]!.mates as Mate[])[0]!.b.offset!.translation[2] = mm('depth')),
    );
    expect(expr[0]!.path).toEqual([
      'assemblies',
      0,
      'mates',
      0,
      'b',
      'offset',
      'translation',
      2,
      'source',
    ]);
  });

  it('refuses a local instance built in a configuration row that does not exist', () => {
    const issues = broken(
      (d) =>
        ((d.assemblies[0]!.instances as Instance[])[1]!.source = {
          part: 'part#2',
          configuration: 'cfg#1',
        }),
    );
    expect(issues.map((i) => [i.code, i.path.join('.')])).toEqual([
      ['not-found', 'assemblies.0.instances.1.source.configuration'],
    ]);
    const good = clone(withRow(hinged()));
    good.assemblies[0]!.instances[1]!.source = { part: 'part#2', configuration: 'cfg#1' };
    expect(deserialize(JSON.stringify(good)).ok).toBe(true);
  });

  it('does not check connector names or pinned sources against any part', () => {
    const issues = broken((d) => {
      const mate = (d.assemblies[0]!.mates as Mate[])[0]!;
      mate.a.origin = { id: 'r1', ref: { faces: ['nothing#9:here'] } };
      (d.assemblies[0]!.instances as Instance[])[1]!.source = pinnedSource();
      (d.assemblies[0]!.instances as Instance[])[0]!.bodies = ['mirror#4:image'];
    });
    expect(issues).toEqual([]);
  });
});

describe('assembly commands', () => {
  it('addAssembly allocates assembly#n from the document counter, never reusing one', () => {
    const doc = deepFreeze(bracket());
    expect(previewIds(doc.nextIds, 'assembly')).toEqual([A]);
    const next = roundTrip(doc, { type: 'addAssembly', assemblyId: A, name: '  Box ' });
    expect(next.assemblies).toEqual([
      { id: A, name: 'Box', instances: [], mates: [], nextIds: {} },
    ]);
    expect(next.nextIds.assembly).toBe(2);
    const two = apply(next, { type: 'addAssembly', assemblyId: 'assembly#2', name: 'B', index: 0 });
    expect(two.document.assemblies.map((a) => a.id)).toEqual(['assembly#2', A]);
    const deleted = apply(next, { type: 'deleteAssembly', assemblyId: A }).document;
    refused(deleted, { type: 'addAssembly', assemblyId: A, name: 'Again' }, 'id-reused');
    refused(next, { type: 'addAssembly', assemblyId: A, name: 'B' }, 'duplicate');
    refused(doc, { type: 'addAssembly', assemblyId: 'asm#1', name: 'B' }, 'invalid-id');
    refused(doc, { type: 'addAssembly', assemblyId: 'assembly#1', name: ' ' }, 'invalid-name');
    refused(doc, { type: 'addAssembly', assemblyId: A, name: 'x'.repeat(201) }, 'invalid-name');
    refused(doc, { type: 'addAssembly', assemblyId: A, name: 'B', index: 1 }, 'invalid-index');
  });

  it('renameAssembly trims, and undoes to the old name', () => {
    const next = roundTrip(withAssembly(), {
      type: 'renameAssembly',
      assemblyId: A,
      name: ' Lid ',
    });
    expect(assembly(next).name).toBe('Lid');
    refused(withAssembly(), { type: 'renameAssembly', assemblyId: A, name: '' }, 'invalid-name');
    refused(
      withAssembly(),
      { type: 'renameAssembly', assemblyId: 'assembly#2', name: 'X' },
      'not-found',
    );
  });

  it('deleteAssembly takes instances and mates with it; undo puts it all back', () => {
    const doc = hinged();
    const next = roundTrip(doc, { type: 'deleteAssembly', assemblyId: A });
    expect(next.assemblies).toEqual([]);
    const done = apply(doc, { type: 'deleteAssembly', assemblyId: A });
    expect(done.inverse).toEqual({ type: 'restoreAssembly', assembly: assembly(doc), index: 0 });
    expect(next.nextIds.assembly).toBe(2);
  });

  it('restoreAssembly needs an allocated, absent id', () => {
    const doc = hinged();
    refused(doc, { type: 'restoreAssembly', assembly: assembly(doc), index: 0 }, 'duplicate');
    const other = { ...assembly(doc), id: 'assembly#5' };
    refused(doc, { type: 'restoreAssembly', assembly: other, index: 0 }, 'invalid-id');
    const gone = apply(doc, { type: 'deleteAssembly', assemblyId: A }).document;
    refused(gone, { type: 'restoreAssembly', assembly: assembly(doc), index: 1 }, 'invalid-index');
  });
});

describe('instance commands', () => {
  it('addInstance allocates inst#n from the assembly counter and appends', () => {
    const doc = withAssembly();
    expect(previewIds(assembly(doc).nextIds, 'inst')).toEqual(['inst#1']);
    const next = roundTrip(doc, {
      type: 'addInstance',
      assemblyId: A,
      instance: instance('inst#1', PART, { fixed: true }),
    });
    expect(assembly(next).instances.map((i) => i.id)).toEqual(['inst#1']);
    expect(assembly(next).nextIds).toEqual({ inst: 2 });
    const after = apply(next, {
      type: 'addInstance',
      assemblyId: A,
      instance: instance('inst#5', 'part#2'),
    }).document;
    expect(assembly(after).nextIds).toEqual({ inst: 6 });
    // The same part more than once, and a pinned part.
    const pinned = apply(after, {
      type: 'addInstance',
      assemblyId: A,
      instance: instance('inst#6', PART, { source: pinnedSource() }),
    }).document;
    expect(assembly(pinned).instances.map((i) => i.id)).toEqual(['inst#1', 'inst#5', 'inst#6']);
  });

  it('addInstance refuses a used id, a missing part and a missing assembly', () => {
    const doc = hinged();
    const add = (inst: Instance, assemblyId = A): Command => ({
      type: 'addInstance',
      assemblyId,
      instance: inst,
    });
    refused(doc, add(instance('inst#2', PART)), 'duplicate');
    refused(doc, add(instance('inst#3', 'part#7')), 'dependency');
    refused(doc, add(instance('inst#3', PART), 'assembly#4'), 'not-found');
    const deleted = apply(
      apply(doc, { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' }).document,
      { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' },
    ).document;
    refused(deleted, add(instance('inst#2', PART)), 'id-reused');
  });

  it('editInstance changes only the fields given, and undoes each', () => {
    const doc = hinged();
    const next = roundTrip(doc, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      name: ' Lid ',
      fixed: true,
      suppressed: true,
      bodies: ['extrude#1'],
    });
    expect(assembly(next).instances[1]).toEqual({
      ...assembly(doc).instances[1],
      name: 'Lid',
      fixed: true,
      suppressed: true,
      bodies: ['extrude#1'],
    });
    const done = apply(doc, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      fixed: true,
    });
    expect(done.inverse).toEqual({
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      fixed: false,
    });
    const cleared = roundTrip(next, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      bodies: null,
    });
    expect('bodies' in assembly(cleared).instances[1]!).toBe(false);
  });

  it('editInstance changes the source: another part, a row, a pin', () => {
    const doc = hinged();
    const edit = (source: Instance['source']): Command => ({
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      source,
    });
    expect(assembly(roundTrip(doc, edit({ part: PART }))).instances[1]!.source).toEqual({
      part: PART,
    });
    // A row of this document's table: it must exist.
    refused(doc, edit({ part: 'part#2', configuration: 'cfg#1' }), 'not-found');
    const tabled = withRow(doc);
    const row = roundTrip(tabled, edit({ part: 'part#2', configuration: 'cfg#1' }));
    expect(assembly(row).instances[1]!.source).toEqual({ part: 'part#2', configuration: 'cfg#1' });
    refused(tabled, edit({ part: 'part#2', configuration: 'cfg#3' }), 'not-found');
    // A pinned source's row is a row of the source document: not checked here (cfg#2).
    expect(assembly(roundTrip(doc, edit(pinnedSource()))).instances[1]!.source).toEqual(
      pinnedSource(),
    );
    refused(doc, edit({ part: 'part#9' }), 'dependency');
    refused(doc, { ...edit({ part: PART }), instanceId: 'inst#9' } as Command, 'not-found');
    refused(
      doc,
      { type: 'editInstance', assemblyId: A, instanceId: 'inst#2', name: ' ' },
      'invalid-name',
    );
  });

  it('setPoses sets several poses as one step, and undo restores them all', () => {
    const doc = hinged();
    const moved: Pose = { translation: [10, -2, 3.5], rotation: [0, 0, 0, 1] };
    const command: Command = {
      type: 'setPoses',
      assemblyId: A,
      poses: { 'inst#2': LIFTED, 'inst#1': moved },
    };
    const next = roundTrip(doc, command);
    expect(assembly(next).instances.map((i) => i.pose)).toEqual([moved, LIFTED]);
    expect(apply(doc, command).inverse).toEqual({
      type: 'setPoses',
      assemblyId: A,
      poses: { 'inst#2': IDENTITY, 'inst#1': IDENTITY },
    });
    const store = unwrap(DocumentStore.create(doc));
    unwrap(store.execute(command, 'Drag'));
    expect(store.document).toEqual(next);
    unwrap(store.undo());
    expect(store.document).toEqual(doc);
  });

  it('setPoses refuses an unknown instance and a pose that is not a rotation', () => {
    const doc = hinged();
    const e = refused(
      doc,
      { type: 'setPoses', assemblyId: A, poses: { 'inst#1': IDENTITY, 'inst#7': IDENTITY } },
      'not-found',
    );
    expect(e?.path).toEqual(['poses', 'inst#7']);
    refused(
      doc,
      {
        type: 'setPoses',
        assemblyId: A,
        poses: { 'inst#1': { translation: [0, 0, 0], rotation: [1, 1, 0, 0] } },
      },
      'schema',
    );
  });

  it('deleteInstance is refused while a mate connects it', () => {
    const doc = hinged();
    const e = refused(
      doc,
      { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' },
      'dependency',
    );
    expect(e?.blockers).toEqual(['mate#1']);
    expect(e?.message).toMatch(/mate mate#1 connects it/);
    expect(instanceMates(assembly(doc), 'inst#1')).toEqual(['mate#1']);
    // Deleting the mate first, in the same batch, is one undo step.
    const next = roundTrip(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' },
        { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' },
      ],
    });
    expect(assembly(next).instances.map((i) => i.id)).toEqual(['inst#1']);
    expect(assembly(next).mates).toEqual([]);
    refused(doc, { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#9' }, 'not-found');
  });

  it('restoreInstance puts an instance back at its index, not under a fresh id', () => {
    const doc = hinged();
    const unmated = apply(doc, { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' }).document;
    const done = apply(unmated, { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#1' });
    expect(done.inverse).toEqual({
      type: 'restoreInstance',
      assemblyId: A,
      instance: assembly(doc).instances[0],
      index: 0,
    });
    const back = apply(done.document, done.inverse).document;
    expect(assembly(back).instances).toEqual(assembly(doc).instances);
    refused(
      unmated,
      { type: 'restoreInstance', assemblyId: A, instance: instance('inst#9', PART), index: 0 },
      'invalid-id',
    );
    refused(
      unmated,
      { type: 'restoreInstance', assemblyId: A, instance: assembly(doc).instances[0]!, index: 0 },
      'duplicate',
    );
  });
});

describe('mate commands', () => {
  it('addMate allocates the mate, connector and reference ids, and goes last', () => {
    const doc = hinged();
    expect(assembly(doc).nextIds).toEqual({ inst: 3, mate: 2, mc: 3, r: 3 });
    expect(mateIds(hinge())).toEqual(['mate#1', 'mc#1', 'r1', 'mc#2', 'r2']);
    const second: Mate = {
      id: 'mate#2',
      name: 'Rest',
      kind: 'planar',
      a: atFace('mc#3', 'inst#1', 'r3', 'extrude#1:cap:end'),
      b: atFace('mc#4', 'inst#2', 'r4', 'extrude#1:cap:end'),
      suppressed: false,
    };
    const next = roundTrip(doc, { type: 'addMate', assemblyId: A, mate: second });
    expect(assembly(next).mates.map((m) => m.id)).toEqual(['mate#1', 'mate#2']);
    expect(assembly(next).nextIds).toEqual({ inst: 3, mate: 3, mc: 5, r: 5 });
    expect(apply(doc, { type: 'addMate', assemblyId: A, mate: second }).inverse).toEqual({
      type: 'deleteMate',
      assemblyId: A,
      mateId: 'mate#2',
    });
  });

  it('addMate refuses reused ids, missing instances and a self-mate', () => {
    const doc = hinged();
    const add = (mate: Mate): Command => ({ type: 'addMate', assemblyId: A, mate });
    const fresh = (extra: Partial<Mate> = {}): Mate => ({
      ...hinge(),
      id: 'mate#2',
      a: atFace('mc#3', 'inst#1', 'r3', 'x#1:y'),
      b: atFace('mc#4', 'inst#2', 'r4', 'x#1:y'),
      ...extra,
    });
    expect(applyCommand(doc, add(fresh())).ok).toBe(true);
    refused(doc, add(hinge()), 'duplicate');
    refused(doc, add(fresh({ id: 'mate#1' })), 'duplicate');
    refused(doc, add(fresh({ a: atFace('mc#1', 'inst#1', 'r3', 'x#1:y') })), 'id-reused');
    refused(doc, add(fresh({ b: atFace('mc#4', 'inst#2', 'r2', 'x#1:y') })), 'id-reused');
    refused(doc, add(fresh({ b: atFace('mc#4', 'inst#8', 'r4', 'x#1:y') })), 'dependency');
    refused(doc, add(fresh({ b: atFace('mc#4', 'inst#1', 'r4', 'x#1:y') })), 'dependency');
    refused(doc, add(fresh({ b: atFace('mc#4', 'inst#2', 'r2#a', 'x#1:y') })), 'invalid-id');
    refused(doc, add(fresh({ kind: 'ball' })), 'schema');
    refused(doc, { type: 'addMate', assemblyId: 'assembly#3', mate: fresh() }, 'not-found');
  });

  it('editMate replaces a mate; new connector ids must be fresh, and undo puts the old one back', () => {
    const doc = hinged();
    const edited = hinge({
      kind: 'slider',
      limits: { max: mm('40') },
      b: {
        ...lidConnector(),
        id: 'mc#3',
        origin: { id: 'r3', ref: { faces: ['extrude#1:cap:end'] } },
        inference: 'midpoint',
      },
    });
    const next = roundTrip(doc, { type: 'editMate', assemblyId: A, mate: edited });
    expect(assembly(next).mates).toEqual([edited]);
    expect(assembly(next).nextIds).toEqual({ inst: 3, mate: 2, mc: 4, r: 4 });
    const done = apply(doc, { type: 'editMate', assemblyId: A, mate: edited });
    expect(done.inverse).toEqual({ type: 'restoreMate', assemblyId: A, mate: hinge(), index: 0 });
    // Undo keeps the counters: the ids the edit handed out stay used.
    const undone = apply(done.document, done.inverse).document;
    expect(assembly(undone).nextIds).toEqual({ inst: 3, mate: 2, mc: 4, r: 4 });
    refused(undone, { type: 'editMate', assemblyId: A, mate: edited }, 'id-reused');
    refused(doc, { type: 'editMate', assemblyId: A, mate: hinge({ id: 'mate#4' }) }, 'not-found');
    refused(
      doc,
      {
        type: 'editMate',
        assemblyId: A,
        mate: hinge({ b: { ...lidConnector(), instance: 'inst#1' } }),
      },
      'dependency',
    );
  });

  it('deleteMate and restoreMate', () => {
    const doc = hinged();
    const next = roundTrip(doc, { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' });
    expect(assembly(next).mates).toEqual([]);
    expect(assembly(next).nextIds).toEqual(assembly(doc).nextIds);
    refused(next, { type: 'addMate', assemblyId: A, mate: hinge() }, 'id-reused');
    refused(doc, { type: 'deleteMate', assemblyId: A, mateId: 'mate#2' }, 'not-found');
    refused(doc, { type: 'restoreMate', assemblyId: A, mate: hinge(), index: 1 }, 'invalid-index');
    refused(
      next,
      { type: 'restoreMate', assemblyId: A, mate: hinge({ id: 'mate#2' }), index: 0 },
      'invalid-id',
    );
    refused(next, { type: 'restoreMate', assemblyId: A, mate: hinge(), index: 3 }, 'invalid-index');
  });

  it('suppressMate', () => {
    const doc = hinged();
    const next = roundTrip(doc, {
      type: 'suppressMate',
      assemblyId: A,
      mateId: 'mate#1',
      suppressed: true,
    });
    expect(assembly(next).mates[0]!.suppressed).toBe(true);
    refused(
      doc,
      { type: 'suppressMate', assemblyId: A, mateId: 'mate#7', suppressed: true },
      'not-found',
    );
  });

  it('every command parses as a Command, so an op log can replay it', () => {
    const doc = hinged();
    const commands: Command[] = [
      { type: 'addAssembly', assemblyId: 'assembly#2', name: 'B' },
      { type: 'renameAssembly', assemblyId: A, name: 'C' },
      { type: 'setPoses', assemblyId: A, poses: { 'inst#2': LIFTED } },
      { type: 'suppressMate', assemblyId: A, mateId: 'mate#1', suppressed: true },
      { type: 'editInstance', assemblyId: A, instanceId: 'inst#1', bodies: null },
      { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' },
      { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' },
      { type: 'deleteAssembly', assemblyId: A },
    ];
    let current = doc;
    const inverses: Command[] = [];
    for (const c of commands) {
      const json = JSON.parse(JSON.stringify(c)) as unknown;
      expect(CommandSchema.safeParse(json).success, c.type).toBe(true);
      const done = apply(current, c);
      expect(CommandSchema.safeParse(JSON.parse(JSON.stringify(done.inverse))).success).toBe(true);
      inverses.push(done.inverse);
      current = done.document;
    }
    for (const inverse of inverses.reverse()) current = apply(current, inverse).document;
    expect(content(current)).toEqual(content(doc));
    expect({ ...current, assemblies: [], nextIds: {} }).toEqual({
      ...doc,
      assemblies: [],
      nextIds: {},
    });
    // assembly#2 was handed out once, so the counter stays past it.
    expect(current.nextIds).toEqual({ ...doc.nextIds, assembly: 3 });
  });
});

describe('blocking across the document', () => {
  it('deletePart is refused while any instance shows the part', () => {
    const doc = hinged();
    expect(partInstances(doc, 'part#2')).toEqual(['assembly#1/inst#2']);
    const e = refused(doc, { type: 'deletePart', partId: 'part#2' }, 'dependency');
    expect(e?.blockers).toEqual(['assembly#1/inst#2']);
    expect(e?.message).toMatch(/instance assembly#1\/inst#2 shows it/);
    // Instances in two assemblies are all named.
    let two = apply(doc, { type: 'addAssembly', assemblyId: 'assembly#2', name: 'B' }).document;
    two = apply(two, {
      type: 'addInstance',
      assemblyId: 'assembly#2',
      instance: instance('inst#1', 'part#2'),
    }).document;
    expect(refused(two, { type: 'deletePart', partId: 'part#2' }, 'dependency')?.blockers).toEqual([
      'assembly#1/inst#2',
      'assembly#2/inst#1',
    ]);
    // A pinned instance names no part of this document, so it does not block.
    const pinned = apply(doc, {
      type: 'batch',
      commands: [
        { type: 'editInstance', assemblyId: A, instanceId: 'inst#2', source: pinnedSource() },
        { type: 'deletePart', partId: 'part#2' },
      ],
    }).document;
    expect(pinned.parts.map((p) => p.id)).toEqual([PART]);
    // Removing the instances first, in one batch, works and undoes as one step.
    const next = roundTrip(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteMate', assemblyId: A, mateId: 'mate#1' },
        { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' },
        { type: 'deletePart', partId: 'part#2' },
      ],
    });
    expect(next.parts.map((p) => p.id)).toEqual([PART]);
  });

  it('renamePart is unaffected, and deleteFeature is not blocked by connectors', () => {
    const doc = hinged();
    expect(applyCommand(doc, { type: 'renamePart', partId: 'part#2', name: 'Top' }).ok).toBe(true);
    // A connector names extrude#1's faces, but a lost connector is a regen error, not a block.
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
        { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' },
        { type: 'deleteFeature', partId: PART, featureId: 'sketch#2' },
        { type: 'deleteFeature', partId: PART, featureId: 'extrude#1' },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('deleteConfigRow is refused while a local instance is built in the row', () => {
    const doc = withRow(hinged());
    const built = apply(doc, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      source: { part: 'part#2', configuration: 'cfg#1' },
    }).document;
    expect(rowInstances(built, 'cfg#1')).toEqual(['assembly#1/inst#2']);
    const e = refused(built, { type: 'deleteConfigRow', rowId: 'cfg#1' }, 'dependency');
    expect(e?.blockers).toEqual(['assembly#1/inst#2']);
    expect(e?.message).toMatch(/instance assembly#1\/inst#2 is built in it/);
    // Clearing the instance's row first, in one batch, works and undoes as one step.
    const next = roundTrip(built, {
      type: 'batch',
      commands: [
        { type: 'editInstance', assemblyId: A, instanceId: 'inst#2', source: { part: 'part#2' } },
        { type: 'deleteConfigRow', rowId: 'cfg#1' },
      ],
    });
    expect(next.configurations).toBeUndefined();
    // A pinned source naming a row with the same id does not block.
    const pinned = apply(doc, {
      type: 'editInstance',
      assemblyId: A,
      instanceId: 'inst#2',
      source: { ...pinnedSource(), configuration: 'cfg#1' },
    }).document;
    expect(rowInstances(pinned, 'cfg#1')).toEqual([]);
    expect(applyCommand(pinned, { type: 'deleteConfigRow', rowId: 'cfg#1' }).ok).toBe(true);
  });

  it('deleteVariable is refused while a connector offset or a limit reads it', () => {
    let doc = hinged();
    const e = refused(doc, { type: 'deleteVariable', name: 'thickness' }, 'variable-in-use');
    expect(e?.blockers).toContain('assembly#1/mate#1');
    doc = apply(doc, { type: 'setVariable', name: 'swing', expression: mm('100deg') }).document;
    doc = apply(doc, {
      type: 'editMate',
      assemblyId: A,
      mate: hinge({ limits: { max: mm('swing') } }),
    }).document;
    expect(variableUsers(doc, 'swing')).toEqual(['assembly#1/mate#1']);
    expect(
      mateExpressions(assembly(doc).mates[0]!).map((s) => [s.path.join('.'), s.expected]),
    ).toEqual([
      ['b.offset.translation.0', 'length'],
      ['b.offset.translation.1', 'length'],
      ['b.offset.translation.2', 'length'],
      ['b.offset.rotation.0', 'angle'],
      ['b.offset.rotation.1', 'angle'],
      ['b.offset.rotation.2', 'angle'],
      ['limits.max', 'angle'],
    ]);
  });

  it('renameVariable and inlineVariable rewrite connector offsets and limits', () => {
    let doc = hinged();
    doc = apply(doc, { type: 'setVariable', name: 'swing', expression: mm('100deg') }).document;
    doc = apply(doc, {
      type: 'editMate',
      assemblyId: A,
      mate: hinge({ limits: { min: mm('0deg'), max: mm('swing + 10deg') } }),
    }).document;
    const renamed = apply(doc, unwrap(renameVariable(doc, 'thickness', 'wall'))).document;
    expect(assembly(renamed).mates[0]!.b.offset!.translation[2].source).toBe('#wall / 2');
    const inlined = apply(doc, unwrap(inlineVariable(doc, 'swing', '100deg'))).document;
    expect(assembly(inlined).mates[0]!.limits!.max!.source).toBe('(100deg) + 10deg');
    expect(inlined.variables.some((v) => v.name === 'swing')).toBe(false);
  });
});

describe('changes', () => {
  it('reports a pose-only change as such, with no part to regenerate', () => {
    const doc = hinged();
    const next = apply(doc, {
      type: 'setPoses',
      assemblyId: A,
      poses: { 'inst#2': LIFTED },
    }).document;
    const change = diffDocuments(doc, next);
    expect(change.empty).toBe(false);
    expect(change.parts).toEqual([]);
    expect(change.assemblies).toEqual([
      {
        assemblyId: A,
        status: 'changed',
        nameChanged: false,
        instances: { added: [], removed: [], changed: [] },
        posed: ['inst#2'],
        mates: { added: [], removed: [], changed: [] },
        matesReordered: false,
        posesOnly: true,
      },
    ]);
  });

  it('reports mates and instances added, removed and changed, and not as pose-only', () => {
    const doc = hinged();
    const next = apply(doc, {
      type: 'batch',
      commands: [
        { type: 'suppressMate', assemblyId: A, mateId: 'mate#1', suppressed: true },
        { type: 'editInstance', assemblyId: A, instanceId: 'inst#1', fixed: false },
        { type: 'setPoses', assemblyId: A, poses: { 'inst#1': LIFTED } },
        { type: 'addInstance', assemblyId: A, instance: instance('inst#3', PART) },
      ],
    }).document;
    const [c] = diffDocuments(doc, next).assemblies;
    expect(c).toMatchObject({
      instances: { added: ['inst#3'], removed: [], changed: ['inst#1'] },
      posed: ['inst#1'],
      mates: { added: [], removed: [], changed: ['mate#1'] },
      posesOnly: false,
    });
    expect(diffDocuments(doc, next).parts).toEqual([]);
    const back = diffDocuments(next, doc).assemblies[0]!;
    expect(back.instances.removed).toEqual(['inst#3']);
  });

  it('reports added, removed and renamed assemblies', () => {
    const doc = hinged();
    const renamed = apply(doc, { type: 'renameAssembly', assemblyId: A, name: 'Z' }).document;
    expect(diffDocuments(doc, renamed).assemblies[0]).toMatchObject({
      status: 'changed',
      nameChanged: true,
      posesOnly: false,
    });
    const gone = apply(doc, { type: 'deleteAssembly', assemblyId: A }).document;
    expect(diffDocuments(doc, gone).assemblies[0]).toMatchObject({
      status: 'removed',
      instances: { removed: ['inst#1', 'inst#2'] },
      mates: { removed: ['mate#1'] },
    });
    expect(diffDocuments(gone, doc).assemblies[0]).toMatchObject({ status: 'added' });
    expect(diffDocuments(doc, doc).assemblies).toEqual([]);
  });

  it('lists a mate whose offset reads a changed variable, directly or through the active row', () => {
    const doc = hinged();
    const next = apply(doc, {
      type: 'setVariable',
      name: 'thickness',
      expression: mm('8mm'),
    }).document;
    expect(diffDocuments(doc, next).assemblies[0]).toMatchObject({
      mates: { changed: ['mate#1'] },
      posesOnly: false,
    });
    // An unrelated variable leaves the assembly alone.
    const other = apply(doc, { type: 'setVariable', name: 'gap', expression: mm('1') }).document;
    expect(diffDocuments(doc, other).assemblies).toEqual([]);
    // A configuration row that overrides `thickness`, made active.
    const table = apply(doc, {
      type: 'batch',
      commands: [
        {
          type: 'setConfigParameter',
          parameter: { id: 'cp#1', name: 'Wall', kind: 'variable', variable: 'thickness' },
        },
        {
          type: 'setConfigRow',
          row: { id: 'cfg#1', name: 'Thick', values: { 'cp#1': mm('9mm') } },
        },
      ],
    }).document;
    const active = apply(table, { type: 'setActiveConfiguration', rowId: 'cfg#1' }).document;
    expect(diffDocuments(table, active).assemblies[0]).toMatchObject({
      mates: { changed: ['mate#1'] },
    });
  });
});

describe('saving', () => {
  it('round trips an assembly, with its counters in canonical key order', () => {
    const doc = hinged();
    const shuffled: ManufaktureDocument = {
      ...doc,
      assemblies: [{ ...assembly(doc), nextIds: { r: 3, mc: 3, mate: 2, inst: 3 } }],
    };
    const text = serialize(shuffled);
    expect(text).toBe(serialize(doc));
    const loaded = unwrap(deserialize(text));
    expect(loaded.document).toEqual(doc);
    expect(loaded.migrated).toBe(false);
    const json = JSON.parse(text) as { assemblies: { nextIds: object }[] };
    expect(Object.keys(json.assemblies[0]!.nextIds)).toEqual(['inst', 'mate', 'mc', 'r']);
    expect(Object.keys(json)).toEqual([
      'format',
      'version',
      'namingScheme',
      'id',
      'name',
      'units',
      'variables',
      'parts',
      'assemblies',
      'nextIds',
    ]);
  });

  it('refuses to load an assembly that fails validation', () => {
    const d = clone(hinged());
    (d.assemblies[0]!.mates[0] as { b: { instance: string } }).b.instance = 'inst#1';
    const r = deserialize(JSON.stringify(d));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('dependency');
  });
});
