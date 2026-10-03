import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import {
  CommandSchema,
  applyCommand,
  partCamSetups,
  restoredDocument,
  variableCamUsers,
  variableUsers,
  type Command,
} from './commands';
import { createCamSetup, createDocument, findCamSetup, findCamTool } from './document';
import { deserialize, parseDocument, serialize } from './format';
import {
  camExpressions,
  camOperationIds,
  camSetupExpressions,
  camSetupIds,
  camSetupOwnExpressions,
  camToolExpressions,
  camToolUsers,
} from './features';
import type { CoreErrorCode } from './result';
import {
  CamDataSchema,
  CamOperationSchema,
  CamSetupSchema,
  CamToolSchema,
  DocumentSchema,
  MAX_CAM_EXPRESSION,
  MAX_CAM_OPERATIONS,
  MAX_CAM_SOURCES,
  type CamOperation,
  type CamSetup,
  type CamTool,
  type ManufaktureDocument,
  type StoredExpression,
} from './schema';
import { DocumentStore } from './store';
import { validateDocument } from './validate';
import { camVariableUses, inlineVariable, renameVariable, variableUses } from './variables';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';

/** CAM (format v14, ADR 0014): schema, validation, commands, variables, changes, saving. */

const S = 'setup#1';
const T = 'tool#1';
const deg = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r.ok ? undefined : r.error;
}

/**
 * Applies `command`, then its inverse, then the inverse of that: undo gives back the tools,
 * setups and parts, with the counters where `command` left them (ids are never handed out
 * twice), and redo gives back the result.
 */
function roundTrip(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const done = apply(doc, command);
  const undone = apply(done.document, done.inverse);
  expect(undone.document.cam.tools).toEqual(doc.cam.tools);
  expect(undone.document.cam.setups).toEqual(doc.cam.setups);
  expect(undone.document.parts).toEqual(doc.parts);
  expect(undone.document.cam.nextIds).toEqual(done.document.cam.nextIds);
  const redone = apply(undone.document, undone.inverse);
  expect(redone.document.cam).toEqual(done.document.cam);
  return done.document;
}

function tool(id: string, extra: Partial<CamTool> = {}): CamTool {
  return {
    id,
    name: '1/4" flat',
    kind: 'flat',
    number: 201,
    diameter: mm('1/4"'),
    fluteLength: mm('19'),
    flutes: 2,
    presets: [
      {
        material: 'plywood',
        spindle: mm('18000rpm'),
        feed: mm('1500mm/min'),
        plunge: mm('500mm/min'),
        stepdown: mm('2'),
        stepover: mm('0.4'),
      },
    ],
    source: { library: 'carbide3d', id: '201' },
    ...extra,
  } as CamTool;
}

function profile(id = 'profile#1', extra: Partial<CamOperation> = {}): CamOperation {
  return {
    id,
    kind: 'profile',
    name: 'Cut out',
    suppressed: false,
    tool: T,
    geometry: [{ kind: 'face', face: { id: 'r2', ref: { face: 'extrude#1:cap:end' } } }],
    feeds: { cut: mm('feed') },
    side: 'outside',
    depth: { kind: 'through', extra: mm('0.5') },
    tabs: { count: mm('4'), width: mm('6'), height: mm('2') },
    entry: { kind: 'ramp', angle: deg('3') },
    leadIn: { kind: 'arc', radius: mm('2') },
    leadOut: { kind: 'none' },
    climb: true,
    ...extra,
  } as CamOperation;
}

function pocket(id = 'pocket#1', extra: Partial<CamOperation> = {}): CamOperation {
  return {
    id,
    kind: 'pocket',
    name: 'Recess',
    suppressed: false,
    tool: T,
    geometry: [{ kind: 'region', sketch: 'sketch#2', entities: ['e1'] }],
    depth: { kind: 'blind', depth: mm('thickness / 2') },
    stepover: mm('0.45'),
    entry: { kind: 'helix', angle: deg('2'), radius: mm('1.5') },
    climb: true,
    ...extra,
  } as CamOperation;
}

function drill(id = 'drill#1', extra: Partial<CamOperation> = {}): CamOperation {
  return {
    id,
    kind: 'drill',
    name: 'Holes',
    suppressed: false,
    tool: T,
    geometry: [{ kind: 'hole', feature: 'hole#1' }],
    peck: mm('2'),
    dwell: mm('0.5'),
    ...extra,
  } as CamOperation;
}

function setup(extra: Partial<CamSetup> = {}): CamSetup {
  return {
    ...createCamSetup(S, 'Top', PART, 'shapeoko-5-pro-4x4', 'grbl'),
    wcs: {
      up: { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } },
      origin: { xy: 'front-left', z: 'top' },
    },
    ...extra,
  };
}

/**
 * The bracket with CAM: tool#1, and setup#1 on part#1 (WCS up from face r1) with a profile
 * (face r2, cut feed reading `feed`), a pocket (a sketch region, depth reading `thickness`) and a
 * drill (hole#1). A `feed` variable holds a feed rate.
 */
function machined(): ManufaktureDocument {
  let doc = apply(bracket(), {
    type: 'setVariable',
    name: 'feed',
    expression: mm('1200mm/min'),
  }).document;
  doc = apply(doc, { type: 'addCamTool', tool: tool(T) }).document;
  doc = apply(doc, {
    type: 'addCamSetup',
    setup: setup({ operations: [profile(), pocket(), drill()] }),
  }).document;
  return doc;
}

describe('schema', () => {
  it('accepts every tool kind, stock, WCS and operation kind', () => {
    const tools: CamTool[] = [
      tool('tool#1'),
      tool('tool#2', { kind: 'ball', number: 0 }),
      tool('tool#3', { kind: 'bull', cornerRadius: mm('1') }),
      tool('tool#4', { kind: 'vbit', angle: deg('60'), tipDiameter: mm('0.2') }),
      tool('tool#5', { kind: 'vbit', angle: deg('90') }),
      tool('tool#6', { kind: 'drill', angle: deg('118') }),
      tool('tool#7', { kind: 'drill' }),
      tool('tool#8', { kind: 'engraver', presets: [] }),
    ];
    for (const t of tools) expect([t.id, CamToolSchema.safeParse(t).success]).toEqual([t.id, true]);
    const { number: _n, source: _s, ...bare } = tool('tool#9');
    void _n;
    void _s;
    expect(CamToolSchema.safeParse(bare).success).toBe(true);

    const operations: CamOperation[] = [
      {
        id: 'facing#1',
        kind: 'facing',
        name: 'Face',
        suppressed: false,
        tool: T,
        geometry: [],
        depth: mm('0.5'),
        angle: deg('0'),
      },
      profile(),
      profile('profile#2', {
        side: 'on',
        depth: { kind: 'through' },
        entry: { kind: 'plunge' },
        leadIn: { kind: 'line', length: mm('3') },
        climb: false,
      } as Partial<CamOperation>),
      pocket(),
      pocket('pocket#2', {
        geometry: [{ kind: 'region', sketch: 'sketch#9' }],
        feeds: { spindle: mm('16000rpm'), plunge: mm('300mm/min'), ramp: mm('600mm/min') },
      }),
      drill(),
      drill('drill#2', { depth: { kind: 'blind', depth: mm('5') } } as Partial<CamOperation>),
      {
        id: 'vcarve#1',
        kind: 'vcarve',
        name: 'Letters',
        suppressed: true,
        tool: 'tool#4',
        geometry: [{ kind: 'region', sketch: 'sketch#3', entities: ['e1', 'e2#a'] }],
        maxDepth: mm('4'),
      },
      {
        id: 'surface3d#1',
        kind: 'surface3d',
        name: 'Finish',
        suppressed: false,
        tool: 'tool#2',
        geometry: [],
        stepover: mm('0.3'),
        angle: deg('45'),
        allowance: mm('0'),
      },
    ];
    for (const op of operations) {
      expect([op.id, CamOperationSchema.safeParse(op).success]).toEqual([op.id, true]);
    }
    const explicit = setup({
      body: 'pattern#2:i3',
      stock: {
        kind: 'explicit',
        size: { x: mm('100'), y: mm('60'), z: mm('3/4"') },
        offset: { x: mm('5'), y: mm('5'), z: mm('0') },
        material: 'plywood',
      },
      wcs: { up: { kind: 'axis', axis: '-y' }, origin: { xy: 'centre', z: 'bottom' } },
      operations,
    });
    expect(CamSetupSchema.safeParse(explicit).success).toBe(true);
    expect(CamDataSchema.safeParse({ tools: [], setups: [], nextIds: {} }).success).toBe(true);
    expect(
      CamDataSchema.safeParse({
        tools,
        setups: [explicit],
        nextIds: { tool: 10, setup: 2, r: 3, facing: 2, profile: 3, vcarve: 2, surface3d: 2 },
      }).success,
    ).toBe(true);
  });

  const toolRefusals: [string, unknown][] = [
    ['an id of another counter', tool('setup#1')],
    ['an id with too many digits', tool(`tool#${'9'.repeat(16)}`)],
    ['an id that is very long', tool(`tool#${'1'.repeat(5000)}`)],
    ['an empty name', tool(T, { name: ' ' })],
    ['a name over 200 characters', tool(T, { name: 'x'.repeat(201) })],
    ['an unknown kind', { ...tool(T), kind: 'router' }],
    ['a negative number', tool(T, { number: -1 })],
    ['a fractional number', tool(T, { number: 1.5 })],
    ['a huge number', tool(T, { number: 100_000 })],
    ['zero flutes', tool(T, { flutes: 0 })],
    ['too many flutes', tool(T, { flutes: 33 })],
    ['an infinite flute count', tool(T, { flutes: Infinity })],
    ['a NaN flute count', tool(T, { flutes: NaN })],
    ['a diameter that is a number', { ...tool(T), diameter: 6.35 }],
    ['a diameter with no units', { ...tool(T), diameter: { source: '6' } }],
    [
      'an expression over the length limit',
      tool(T, { diameter: mm('1'.repeat(MAX_CAM_EXPRESSION + 1)) }),
    ],
    ['a bull nose without a corner radius', tool(T, { kind: 'bull' })],
    ['a corner radius on a flat tool', tool(T, { cornerRadius: mm('1') })],
    ['a V-bit without an angle', tool(T, { kind: 'vbit' })],
    ['an angle on a ball tool', tool(T, { kind: 'ball', angle: deg('60') })],
    [
      'a tip diameter on a drill',
      tool(T, { kind: 'drill', angle: deg('118'), tipDiameter: mm('1') }),
    ],
    [
      'two presets for one material',
      tool(T, { presets: [...tool(T).presets, ...tool(T).presets] }),
    ],
    [
      'a preset material that is not an id',
      tool(T, { presets: [{ ...tool(T).presets[0]!, material: 'Baltic Birch' }] }),
    ],
    ['a preset with a field missing', { ...tool(T), presets: [{ material: 'mdf' }] }],
    ['a source library that is not an id', tool(T, { source: { library: 'My Tools', id: '1' } })],
    ['an unknown key', { ...tool(T), colour: '#ffffff' }],
  ];

  it.each(toolRefusals)('refuses a tool with %s', (_label, value) => {
    expect(CamToolSchema.safeParse(value).success).toBe(false);
  });

  const opRefusals: [string, unknown][] = [
    ['an id of another kind', profile('pocket#1')],
    ['an id of no kind', profile('cut#1')],
    ['a tool id that is not one', profile('profile#1', { tool: 'cutter' })],
    ['an unknown kind', { ...pocket(), kind: 'adaptive', id: 'adaptive#1' }],
    ['an unknown side', { ...profile(), side: 'left' }],
    ['no depth', (({ depth: _d, ...rest }) => (void _d, rest))(profile() as { depth: unknown })],
    ['an unknown depth', { ...profile(), depth: { kind: 'upToFace' } }],
    ['a blind depth without a depth', { ...profile(), depth: { kind: 'blind' } }],
    ['a helix without a radius', { ...pocket(), entry: { kind: 'helix', angle: deg('2') } }],
    ['a lead with an unknown kind', { ...profile(), leadIn: { kind: 'spiral' } }],
    ['empty feeds', profile('profile#1', { feeds: {} })],
    ['an unknown feed', { ...profile(), feeds: { rapid: mm('5000mm/min') } }],
    ['suppressed that is not a flag', { ...profile(), suppressed: 'no' }],
    ['a field of another kind', { ...drill(), side: 'outside' }],
    [
      'a face source on an edge',
      {
        ...profile(),
        geometry: [{ kind: 'face', face: { id: 'r2', ref: { faces: ['a', 'b'] } } }],
      },
    ],
    [
      'a face source with a bad reference id',
      { ...profile(), geometry: [{ kind: 'face', face: { id: 'e2', ref: { face: 'a' } } }] },
    ],
    [
      'a region of a feature that is not a sketch',
      { ...pocket(), geometry: [{ kind: 'region', sketch: 'extrude#1' }] },
    ],
    [
      'a region with no entities listed',
      { ...pocket(), geometry: [{ kind: 'region', sketch: 'sketch#2', entities: [] }] },
    ],
    [
      'a region entity that is not an entity id',
      { ...pocket(), geometry: [{ kind: 'region', sketch: 'sketch#2', entities: ['k1'] }] },
    ],
    [
      'a region entity id that is very long',
      {
        ...pocket(),
        geometry: [{ kind: 'region', sketch: 'sketch#2', entities: [`e1${'#a'.repeat(200)}`] }],
      },
    ],
    [
      'a hole source of a feature that is not a hole',
      { ...drill(), geometry: [{ kind: 'hole', feature: 'sketch#1' }] },
    ],
    ['a source of an unknown kind', { ...drill(), geometry: [{ kind: 'edge', edge: 'x' }] }],
    [
      'too many sources',
      {
        ...pocket(),
        geometry: Array.from({ length: MAX_CAM_SOURCES + 1 }, () => ({
          kind: 'region',
          sketch: 'sketch#2',
        })),
      },
    ],
    ['an unknown key', { ...drill(), speed: 1 }],
  ];

  it.each(opRefusals)('refuses an operation with %s', (_label, value) => {
    expect(CamOperationSchema.safeParse(value).success).toBe(false);
  });

  const setupRefusals: [string, unknown][] = [
    ['an id of another counter', setup({ id: 'print#1' })],
    ['an empty part', setup({ part: '' })],
    ['a part id that is very long', setup({ part: 'p'.repeat(5000) })],
    ['a body that is not a body id', setup({ body: 'Body 1' })],
    ['a machine id with capitals', setup({ machine: 'Shapeoko 5' })],
    ['a post id that is too long', setup({ post: 'g'.repeat(65) })],
    ['a stock of an unknown kind', { ...setup(), stock: { kind: 'cylinder' } }],
    [
      'a stock with a margin missing',
      { ...setup(), stock: { kind: 'fromBody', margins: { xMin: mm('1') } } },
    ],
    [
      'an unknown up axis',
      { ...setup(), wcs: { ...setup().wcs, up: { kind: 'axis', axis: 'z' } } },
    ],
    [
      'an unknown origin corner',
      { ...setup(), wcs: { ...setup().wcs, origin: { xy: 'middle', z: 'top' } } },
    ],
    ['heights with retract missing', { ...setup(), heights: { clearance: mm('10') } }],
    ['no operations list', (({ operations: _o, ...rest }) => (void _o, rest))(setup())],
    ['an unknown key', { ...setup(), fixture: 'vise' }],
  ];

  it.each(setupRefusals)('refuses a setup with %s', (_label, value) => {
    expect(CamSetupSchema.safeParse(value).success).toBe(false);
  });

  const sectionRefusals: [string, unknown][] = [
    ['an unknown counter', { tools: [], setups: [], nextIds: { part: 2 } }],
    ['a counter at zero', { tools: [], setups: [], nextIds: { tool: 0 } }],
    ['a fractional counter', { tools: [], setups: [], nextIds: { tool: 1.5 } }],
    ['an unsafe counter', { tools: [], setups: [], nextIds: { tool: 2 ** 60 } }],
    ['no tools list', { setups: [], nextIds: {} }],
    ['an unknown key', { tools: [], setups: [], nextIds: {}, machines: [] }],
    [
      'more operations than the limit across setups',
      {
        tools: [],
        setups: [0, 1].map((i) =>
          setup({
            id: `setup#${i + 1}`,
            operations: Array.from({ length: MAX_CAM_OPERATIONS / 2 + 1 }, (_, k) =>
              drill(`drill#${i * 10_000 + k + 1}`, { geometry: [] }),
            ),
          }),
        ),
        nextIds: {},
      },
    ],
  ];

  it.each(sectionRefusals)('refuses a section with %s', (_label, value) => {
    expect(CamDataSchema.safeParse(value).success).toBe(false);
  });

  it('requires the CAM section in a version 14 document', () => {
    const { cam: _cam, ...rest } = bracket();
    void _cam;
    expect(DocumentSchema.safeParse(rest).success).toBe(false);
    expect(DocumentSchema.safeParse(machined()).success).toBe(true);
  });

  it('refuses a crafted file through the loader as a schema error, never a crash', () => {
    const crafted = JSON.parse(serialize(machined())) as { cam: Record<string, unknown> };
    for (const bad of [
      null,
      [],
      'cam',
      { ...crafted.cam, tools: 'x' },
      { ...crafted.cam, setups: [{ id: 'setup#1' }] },
      { ...crafted.cam, nextIds: { r: -1 } },
      { ...crafted.cam, tools: [{ ...tool(T), flutes: Number.POSITIVE_INFINITY }] },
    ]) {
      const r = parseDocument({ ...crafted, cam: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('schema');
    }
  });
});

describe('generic views', () => {
  it('lists ids and expressions with the kind each expects', () => {
    const doc = machined();
    const s = doc.cam.setups[0]!;
    expect(camSetupIds(s)).toEqual([S, 'r1', 'profile#1', 'r2', 'pocket#1', 'drill#1']);
    expect(camOperationIds(s.operations[0]!)).toEqual(['profile#1', 'r2']);
    expect(
      camToolExpressions(doc.cam.tools[0]!).map((x) => [x.path.join('.'), x.expected]),
    ).toEqual([
      ['diameter', 'length'],
      ['fluteLength', 'length'],
      ['presets.0.spindle', 'spindleSpeed'],
      ['presets.0.feed', 'feed'],
      ['presets.0.plunge', 'feed'],
      ['presets.0.stepdown', 'length'],
      ['presets.0.stepover', 'number'],
    ]);
    expect(camExpressions(s.operations[0]!).map((x) => [x.path.join('.'), x.expected])).toEqual([
      ['feeds.cut', 'feed'],
      ['depth.extra', 'length'],
      ['tabs.count', 'number'],
      ['tabs.width', 'length'],
      ['tabs.height', 'length'],
      ['entry.angle', 'angle'],
      ['leadIn.radius', 'length'],
    ]);
    expect(camExpressions(s.operations[1]!).map((x) => [x.path.join('.'), x.expected])).toEqual([
      ['depth.depth', 'length'],
      ['stepover', 'number'],
      ['entry.angle', 'angle'],
      ['entry.radius', 'length'],
    ]);
    expect(camExpressions(s.operations[2]!).map((x) => [x.path.join('.'), x.expected])).toEqual([
      ['peck', 'length'],
      ['dwell', 'number'],
    ]);
    expect(camSetupOwnExpressions(s).map((x) => x.path.join('.'))).toEqual([
      'stock.margins.xMin',
      'stock.margins.xMax',
      'stock.margins.yMin',
      'stock.margins.yMax',
      'stock.margins.top',
      'stock.margins.bottom',
      'heights.clearance',
      'heights.retract',
    ]);
    expect(camSetupExpressions(s).map((x) => x.path.join('.'))).toContain(
      'operations.1.depth.depth',
    );
    expect(camToolUsers(doc.cam, T)).toEqual([`${S}/profile#1`, `${S}/pocket#1`, `${S}/drill#1`]);
    expect(findCamSetup(doc, S)?.name).toBe('Top');
    expect(findCamTool(doc, T)?.number).toBe(201);
    expect(findCamTool(doc, 'tool#2')).toBeUndefined();
  });
});

describe('validation', () => {
  it('accepts unknown machines and posts, and bodies, faces, sketches and holes that do not exist', () => {
    const doc = clone(machined());
    const s = doc.cam.setups[0]!;
    s.machine = 'machine-from-the-future';
    s.post = 'linuxcnc';
    s.body = 'extrude#99';
    s.stock = { ...s.stock, material: 'unobtainium' };
    s.operations[0]!.geometry = [
      { kind: 'face', face: { id: 'r2', ref: { face: 'nothing#7:cap:end' } } },
    ];
    s.operations[1]!.geometry = [{ kind: 'region', sketch: 'sketch#42', entities: ['e99'] }];
    s.operations[2]!.geometry = [{ kind: 'hole', feature: 'hole#9' }];
    expect(validateDocument(doc)).toEqual([]);
    expect(unwrap(deserialize(serialize(doc))).document).toEqual(doc);
  });

  const broken: [string, (doc: ManufaktureDocument) => void, CoreErrorCode, unknown[]][] = [
    [
      'a setup of a part that does not exist',
      (d) => (d.cam.setups[0]!.part = 'part#9'),
      'dependency',
      ['cam', 'setups', 0, 'part'],
    ],
    [
      'an operation whose tool is not in the tools',
      (d) => (d.cam.setups[0]!.operations[1]!.tool = 'tool#7'),
      'dependency',
      ['cam', 'setups', 0, 'operations', 1, 'tool'],
    ],
    [
      'a tool id never allocated',
      (d) => (d.cam.tools[0]!.id = 'tool#2'),
      'invalid-id',
      ['cam', 'tools', 0, 'id'],
    ],
    [
      'a setup id never allocated',
      (d) => (d.cam.setups[0]!.id = 'setup#5'),
      'invalid-id',
      ['cam', 'setups', 0, 'id'],
    ],
    [
      'an operation id never allocated',
      (d) => (d.cam.setups[0]!.operations[2]!.id = 'drill#2'),
      'invalid-id',
      ['cam', 'setups', 0, 'operations', 2, 'id'],
    ],
    [
      'an operation kind never counted',
      (d) => {
        d.cam.setups[0]!.operations[0]!.geometry = [];
        d.cam.setups[0]!.operations.push({
          id: 'vcarve#1',
          kind: 'vcarve',
          name: 'V',
          suppressed: false,
          tool: T,
          geometry: [],
        });
      },
      'invalid-id',
      ['cam', 'setups', 0, 'operations', 3, 'id'],
    ],
    [
      'a WCS reference id never allocated',
      (d) => {
        const up = d.cam.setups[0]!.wcs.up;
        if (up.kind === 'face') up.face.id = 'r3';
      },
      'invalid-id',
      ['cam', 'setups', 0, 'wcs', 'up', 'face', 'id'],
    ],
    [
      'a split reference id',
      (d) => {
        const g = d.cam.setups[0]!.operations[0]!.geometry[0]!;
        if (g.kind === 'face') g.face.id = 'r2#a';
      },
      'invalid-id',
      ['cam', 'setups', 0, 'operations', 0, 'geometry', 0, 'face', 'id'],
    ],
    [
      'a reference id used twice',
      (d) => {
        const g = d.cam.setups[0]!.operations[0]!.geometry[0]!;
        if (g.kind === 'face') g.face.id = 'r1';
      },
      'duplicate',
      ['cam', 'setups', 0, 'operations', 0, 'geometry', 0, 'face', 'id'],
    ],
    [
      'an operation id used twice, across setups',
      (d) => {
        d.cam.nextIds.setup = 3;
        d.cam.setups.push(
          setup({
            id: 'setup#2',
            wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs,
            operations: [drill()],
          }),
        );
      },
      'duplicate',
      ['cam', 'setups', 1, 'operations', 0, 'id'],
    ],
    [
      'a drill of a face',
      (d) => (d.cam.setups[0]!.operations[2]!.geometry = [{ kind: 'region', sketch: 'sketch#2' }]),
      'kind-mismatch',
      ['cam', 'setups', 0, 'operations', 2, 'geometry', 0, 'kind'],
    ],
    [
      'a pocket of a hole feature',
      (d) => (d.cam.setups[0]!.operations[1]!.geometry = [{ kind: 'hole', feature: 'hole#1' }]),
      'kind-mismatch',
      ['cam', 'setups', 0, 'operations', 1, 'geometry', 0, 'kind'],
    ],
    [
      'a 3D surfacing bounded by a hole feature',
      (d) => {
        d.cam.nextIds.surface3d = 2;
        d.cam.setups[0]!.operations.push({
          id: 'surface3d#1',
          kind: 'surface3d',
          name: 'Finish',
          suppressed: false,
          tool: T,
          geometry: [{ kind: 'hole', feature: 'hole#1' }],
          stepover: mm('0.3'),
          angle: deg('0'),
        });
      },
      'kind-mismatch',
      ['cam', 'setups', 0, 'operations', 3, 'geometry', 0, 'kind'],
    ],
    [
      'a tool expression with an unknown variable',
      (d) => (d.cam.tools[0]!.presets[0]!.feed = mm('#nope')),
      'unknown-variable',
      ['cam', 'tools', 0, 'presets', 0, 'feed', 'source'],
    ],
    [
      'a setup expression that does not parse',
      (d) => (d.cam.setups[0]!.heights.retract = mm('5 +')),
      'expression',
      ['cam', 'setups', 0, 'heights', 'retract', 'source'],
    ],
    [
      'an operation expression with an unknown variable',
      (d) => {
        const op = d.cam.setups[0]!.operations[1]!;
        if (op.kind === 'pocket') op.depth = { kind: 'blind', depth: mm('depth') };
      },
      'unknown-variable',
      ['cam', 'setups', 0, 'operations', 1, 'depth', 'depth', 'source'],
    ],
  ];

  it.each(broken)('reports %s', (_label, breakIt, code, path) => {
    const doc = clone(machined());
    breakIt(doc);
    const issues = validateDocument(doc);
    expect(issues.map((i) => [i.code, i.path])).toContainEqual([code, path]);
  });

  it('refuses such a document on load, and never modifies the value it is given', () => {
    const doc = clone(machined());
    doc.cam.setups[0]!.part = 'part#9';
    const value = deepFreeze(JSON.parse(JSON.stringify(doc)) as unknown);
    const r = parseDocument(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('dependency');
  });
});

describe('commands', () => {
  it('parses every CAM command', () => {
    const commands: Command[] = [
      { type: 'addCamTool', tool: tool(T) },
      { type: 'editCamTool', tool: tool(T) },
      { type: 'deleteCamTool', toolId: T },
      { type: 'restoreCamTool', tool: tool(T), index: 0 },
      { type: 'addCamSetup', setup: setup(), index: 0 },
      { type: 'editCamSetup', setupId: S, name: 'Back', body: null, post: 'grbl' },
      { type: 'deleteCamSetup', setupId: S },
      { type: 'restoreCamSetup', setup: setup(), index: 0 },
      { type: 'reorderCamSetups', setupId: S, index: 0 },
      { type: 'addCamOperation', setupId: S, operation: drill() },
      { type: 'editCamOperation', setupId: S, operation: drill() },
      { type: 'deleteCamOperation', setupId: S, operationId: 'drill#1' },
      { type: 'restoreCamOperation', setupId: S, operation: drill(), index: 2 },
      { type: 'reorderCamOperation', setupId: S, operationId: 'drill#1', index: 0 },
      { type: 'suppressCamOperation', setupId: S, operationId: 'drill#1', suppressed: true },
    ];
    for (const c of commands)
      expect([c.type, CommandSchema.safeParse(c).success]).toEqual([c.type, true]);
    for (const bad of [
      { type: 'editCamSetup', setupId: S, machine: 'Not An Id' },
      { type: 'deleteCamTool', toolId: 'x'.repeat(33) },
      { type: 'addCamOperation', setupId: S, operation: { ...drill(), id: 'pocket#1' } },
      { type: 'suppressCamOperation', setupId: S, operationId: 'drill#1' },
    ]) {
      expect(CommandSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('adds a tool and a setup with its operations, allocating every id, and undoes each', () => {
    const base = apply(bracket(), {
      type: 'setVariable',
      name: 'feed',
      expression: mm('1200mm/min'),
    }).document;
    const withTool = roundTrip(base, { type: 'addCamTool', tool: tool(T) });
    expect(withTool.cam.nextIds).toEqual({ tool: 2 });
    const doc = roundTrip(withTool, {
      type: 'addCamSetup',
      setup: setup({ operations: [profile(), pocket('pocket#3'), drill()] }),
    });
    expect(doc.cam.setups.map((s) => s.id)).toEqual([S]);
    expect(doc.cam.nextIds).toEqual({ tool: 2, setup: 2, profile: 2, pocket: 4, drill: 2, r: 3 });
    // CAM ids are their own namespace: the part's counters do not move.
    expect(doc.parts).toEqual(base.parts);
  });

  it('never reuses an id, even once the tool, setup or operation is gone', () => {
    const doc = machined();
    const noDrill = apply(doc, {
      type: 'deleteCamOperation',
      setupId: S,
      operationId: 'drill#1',
    }).document;
    expect(
      refused(noDrill, { type: 'addCamOperation', setupId: S, operation: drill() }, 'id-reused')
        ?.blockers,
    ).toEqual(['drill#1']);
    const noSetup = apply(doc, { type: 'deleteCamSetup', setupId: S }).document;
    refused(noSetup, { type: 'addCamSetup', setup: setup() }, 'id-reused');
    // An operation id from another setup's counter, even in a new setup, is still taken.
    refused(
      apply(doc, { type: 'addCamTool', tool: tool('tool#2') }).document,
      {
        type: 'addCamSetup',
        setup: setup({
          id: 'setup#2',
          wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs,
          operations: [pocket()],
        }),
      },
      'id-reused',
    );
    const noTool = apply(apply(doc, { type: 'deleteCamSetup', setupId: S }).document, {
      type: 'deleteCamTool',
      toolId: T,
    }).document;
    refused(noTool, { type: 'addCamTool', tool: tool(T) }, 'id-reused');
    // History may put back what was there: its ids were allocated.
    apply(noTool, { type: 'restoreCamTool', tool: tool(T), index: 0 });
    refused(noTool, { type: 'restoreCamTool', tool: tool('tool#5'), index: 0 }, 'invalid-id');
  });

  it('edits a tool, and refuses to delete one that an operation cuts with', () => {
    const doc = machined();
    roundTrip(doc, {
      type: 'editCamTool',
      tool: tool(T, { kind: 'bull', cornerRadius: mm('0.5'), flutes: 3 }),
    });
    const error = refused(doc, { type: 'deleteCamTool', toolId: T }, 'dependency');
    expect(error?.blockers).toEqual([`${S}/profile#1`, `${S}/pocket#1`, `${S}/drill#1`]);
    expect(error?.message).toMatch(/operations setup#1\/profile#1, .* cut with it/);
    refused(doc, { type: 'deleteCamTool', toolId: 'tool#9' }, 'not-found');
    refused(doc, { type: 'editCamTool', tool: tool('tool#9') }, 'not-found');
    const two = roundTrip(doc, {
      type: 'addCamTool',
      tool: tool('tool#2', { kind: 'ball' }),
      index: 0,
    });
    expect(two.cam.tools.map((t) => t.id)).toEqual(['tool#2', T]);
    roundTrip(two, { type: 'deleteCamTool', toolId: 'tool#2' });
  });

  it('edits a setup field by field, and undoes each', () => {
    let doc = machined();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' }).document;
    const edits: Command[] = [
      { type: 'editCamSetup', setupId: S, name: '  Back side ' },
      { type: 'editCamSetup', setupId: S, part: 'part#2' },
      { type: 'editCamSetup', setupId: S, body: 'extrude#1' },
      { type: 'editCamSetup', setupId: S, machine: 'shapeoko-4-xxl', post: 'carbide-motion' },
      {
        type: 'editCamSetup',
        setupId: S,
        stock: {
          kind: 'explicit',
          size: { x: mm('100'), y: mm('80'), z: mm('18') },
          offset: { x: mm('5'), y: mm('5'), z: mm('0') },
          material: 'mdf',
        },
      },
      {
        type: 'editCamSetup',
        setupId: S,
        heights: { clearance: mm('15'), retract: mm('thickness') },
      },
      {
        type: 'editCamSetup',
        setupId: S,
        wcs: { up: { kind: 'axis', axis: '-z' }, origin: { xy: 'centre', z: 'bottom' } },
      },
    ];
    for (const c of edits) roundTrip(doc, c);
    const named = apply(doc, edits[0]!).document;
    expect(named.cam.setups[0]!.name).toBe('Back side');
    const bodied = apply(doc, edits[2]!).document;
    const cleared = roundTrip(bodied, { type: 'editCamSetup', setupId: S, body: null });
    expect('body' in cleared.cam.setups[0]!).toBe(false);
    refused(doc, { type: 'editCamSetup', setupId: S, name: '  ' }, 'invalid-name');
    refused(doc, { type: 'editCamSetup', setupId: S, part: 'part#9' }, 'dependency');
    refused(doc, { type: 'editCamSetup', setupId: 'setup#9', name: 'x' }, 'not-found');
  });

  it('re-picking a face takes a fresh reference id and never reuses the old one', () => {
    const doc = machined();
    const repick = (id: string): Command => ({
      type: 'editCamSetup',
      setupId: S,
      wcs: {
        up: { kind: 'face', face: { id, ref: { face: 'extrude#1:cap:start' } } },
        origin: { xy: 'back-right', z: 'top' },
      },
    });
    // r2 is an operation's face in the same setup: taking it is a clash, not a re-pick.
    refused(doc, repick('r2'), 'duplicate');
    const next = roundTrip(doc, repick('r3'));
    expect(next.cam.nextIds.r).toBe(4);
    // Once r1 is gone, picking it again would reuse a deleted id.
    refused(next, repick('r1'), 'id-reused');
    const op = {
      ...profile(),
      geometry: [{ kind: 'face' as const, face: { id: 'r1', ref: { face: 'x' } } }],
    };
    refused(doc, { type: 'editCamOperation', setupId: S, operation: op }, 'id-reused');
    roundTrip(doc, {
      type: 'editCamOperation',
      setupId: S,
      operation: { ...op, geometry: [{ kind: 'face', face: { id: 'r7', ref: { face: 'x' } } }] },
    });
  });

  it('deletes a setup with its operations and puts it back where it was', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: setup({ id: 'setup#2', wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs }),
    }).document;
    const done = apply(doc, { type: 'deleteCamSetup', setupId: S });
    expect(done.document.cam.setups.map((s) => s.id)).toEqual(['setup#2']);
    expect(done.inverse).toEqual({ type: 'restoreCamSetup', setup: doc.cam.setups[0], index: 0 });
    roundTrip(doc, { type: 'deleteCamSetup', setupId: S });
    const moved = roundTrip(doc, { type: 'reorderCamSetups', setupId: S, index: 1 });
    expect(moved.cam.setups.map((s) => s.id)).toEqual(['setup#2', S]);
    refused(doc, { type: 'reorderCamSetups', setupId: S, index: 2 }, 'invalid-index');
    refused(doc, { type: 'deleteCamSetup', setupId: 'setup#9' }, 'not-found');
    refused(
      doc,
      {
        type: 'addCamSetup',
        setup: setup({
          id: 'setup#3',
          operations: [],
          wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs,
        }),
        index: 3,
      },
      'invalid-index',
    );
  });

  it('adds, edits, reorders, suppresses and deletes operations, and undoes each', () => {
    const doc = machined();
    const added = roundTrip(doc, {
      type: 'addCamOperation',
      setupId: S,
      operation: {
        id: 'facing#1',
        kind: 'facing',
        name: 'Face',
        suppressed: false,
        tool: T,
        geometry: [],
        depth: mm('0.5'),
        angle: deg('0'),
      },
      index: 0,
    });
    expect(added.cam.setups[0]!.operations.map((o) => o.id)).toEqual([
      'facing#1',
      'profile#1',
      'pocket#1',
      'drill#1',
    ]);
    roundTrip(doc, {
      type: 'editCamOperation',
      setupId: S,
      operation: pocket('pocket#1', {
        name: 'Deeper',
        depth: { kind: 'through' },
      } as Partial<CamOperation>),
    });
    const reordered = roundTrip(doc, {
      type: 'reorderCamOperation',
      setupId: S,
      operationId: 'drill#1',
      index: 0,
    });
    expect(reordered.cam.setups[0]!.operations.map((o) => o.id)).toEqual([
      'drill#1',
      'profile#1',
      'pocket#1',
    ]);
    const suppressed = roundTrip(doc, {
      type: 'suppressCamOperation',
      setupId: S,
      operationId: 'pocket#1',
      suppressed: true,
    });
    expect(suppressed.cam.setups[0]!.operations[1]!.suppressed).toBe(true);
    roundTrip(doc, { type: 'deleteCamOperation', setupId: S, operationId: 'profile#1' });
    refused(doc, { type: 'deleteCamOperation', setupId: S, operationId: 'pocket#9' }, 'not-found');
    refused(
      doc,
      { type: 'suppressCamOperation', setupId: S, operationId: 'x#1', suppressed: true },
      'not-found',
    );
    refused(
      doc,
      { type: 'addCamOperation', setupId: 'setup#9', operation: drill('drill#2') },
      'not-found',
    );
    refused(doc, { type: 'addCamOperation', setupId: S, operation: drill() }, 'duplicate');
    refused(
      doc,
      { type: 'addCamOperation', setupId: S, operation: drill('drill#2', { tool: 'tool#3' }) },
      'dependency',
    );
    refused(
      doc,
      {
        type: 'addCamOperation',
        setupId: S,
        operation: drill('drill#2', { geometry: [{ kind: 'region', sketch: 'sketch#1' }] }),
      },
      'kind-mismatch',
    );
    refused(
      doc,
      { type: 'reorderCamOperation', setupId: S, operationId: 'drill#1', index: 3 },
      'invalid-index',
    );
  });

  it('moves an operation to another setup under its id, as one undo step', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: setup({ id: 'setup#2', wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs }),
    }).document;
    const op = doc.cam.setups[0]!.operations[2]!;
    const move: Command = {
      type: 'batch',
      commands: [
        { type: 'deleteCamOperation', setupId: S, operationId: op.id },
        { type: 'restoreCamOperation', setupId: 'setup#2', operation: op, index: 0 },
      ],
    };
    const moved = roundTrip(doc, move);
    expect(moved.cam.setups[1]!.operations).toEqual([op]);
    expect(moved.cam.setups[0]!.operations.map((o) => o.id)).toEqual(['profile#1', 'pocket#1']);
    // Without the delete the id would be in two setups.
    refused(doc, move.commands[1]!, 'duplicate');
  });

  it('never blocks modelling: deleting or editing what an operation names is allowed', () => {
    const doc = machined();
    const ids = doc.parts[0]!.features.map((f) => f.id).reverse();
    const empty = apply(doc, {
      type: 'batch',
      commands: ids.map((featureId) => ({ type: 'deleteFeature', partId: PART, featureId })),
    }).document;
    expect(empty.parts[0]!.features).toEqual([]);
    expect(empty.cam).toEqual(doc.cam);
    expect(validateDocument(empty)).toEqual([]);
    apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' });
    apply(doc, { type: 'suppressFeature', partId: PART, featureId: 'extrude#1', suppressed: true });
    apply(doc, { type: 'renameFeature', partId: PART, featureId: 'sketch#2', name: 'Holes' });
    apply(doc, {
      type: 'setBodyProps',
      partId: PART,
      bodyId: 'extrude#1',
      props: { name: 'Plate' },
    });
  });

  it('refuses to delete a part that a setup machines, naming the setups', () => {
    let doc = machined();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' }).document;
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: setup({
        id: 'setup#2',
        part: 'part#2',
        wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs,
      }),
    }).document;
    expect(partCamSetups(doc, PART)).toEqual([S]);
    const error = refused(doc, { type: 'deletePart', partId: 'part#2' }, 'dependency');
    expect(error?.blockers).toEqual(['setup#2']);
    expect(error?.message).toMatch(/CAM setup setup#2 machines it/);
    const freed = apply(doc, { type: 'deleteCamSetup', setupId: 'setup#2' }).document;
    apply(freed, { type: 'deletePart', partId: 'part#2' });
    // Retargeting the setup frees the part as well.
    const retargeted = apply(doc, {
      type: 'editCamSetup',
      setupId: 'setup#2',
      part: PART,
    }).document;
    apply(retargeted, { type: 'deletePart', partId: 'part#2' });
  });

  it('refuses commands that would take CAM past its section-wide limits', () => {
    const doc = machined();
    const setups = Array.from({ length: 10 }, (_, i) =>
      setup({
        id: `setup#${i + 2}`,
        wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs,
        operations: Array.from({ length: MAX_CAM_OPERATIONS / 10 }, (_, k) =>
          drill(`drill#${i * 1000 + k + 2}`),
        ),
      }),
    );
    const full: ManufaktureDocument = {
      ...doc,
      cam: {
        ...doc.cam,
        setups: [{ ...doc.cam.setups[0]!, operations: [] }, ...setups],
        nextIds: { ...doc.cam.nextIds, setup: 12, drill: 10_002 },
      },
    };
    expect(validateDocument(full)).toEqual([]);
    expect(DocumentSchema.safeParse(full).success).toBe(true);
    const error = refused(
      full,
      { type: 'addCamOperation', setupId: S, operation: drill('drill#10002') },
      'schema',
    );
    expect(error?.message).toMatch(/at most 10000/);
  });

  it('keeps the higher CAM counters when a document is restored', () => {
    const past = machined();
    const current = apply(past, { type: 'deleteCamSetup', setupId: S }).document;
    const later = apply(current, {
      type: 'addCamSetup',
      setup: setup({
        id: 'setup#4',
        wcs: { ...setup().wcs, up: { kind: 'face', face: { id: 'r9', ref: { face: 'x' } } } },
        operations: [drill('drill#5')],
      }),
    }).document;
    const restored = restoredDocument(later, past);
    expect(restored.cam.setups).toEqual(past.cam.setups);
    expect(restored.cam.nextIds).toEqual({
      tool: 2,
      setup: 5,
      profile: 2,
      pocket: 2,
      drill: 6,
      r: 10,
    });
    apply(later, { type: 'replaceDocument', document: restored });
  });

  it('never modifies the document it is given', () => {
    const doc = deepFreeze(machined());
    const commands: Command[] = [
      { type: 'editCamTool', tool: tool(T, { flutes: 4 }) },
      { type: 'editCamSetup', setupId: S, name: 'X', body: 'extrude#1' },
      { type: 'deleteCamOperation', setupId: S, operationId: 'pocket#1' },
      { type: 'editCamOperation', setupId: S, operation: drill('drill#1', { name: 'Y' }) },
      { type: 'reorderCamOperation', setupId: S, operationId: 'drill#1', index: 0 },
      { type: 'suppressCamOperation', setupId: S, operationId: 'drill#1', suppressed: true },
      { type: 'deleteCamSetup', setupId: S },
    ];
    for (const c of commands) apply(doc, c);
  });

  it('keeps a new document valid with an empty section', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    expect(doc.cam).toEqual({ tools: [], setups: [], nextIds: {} });
    expect(validateDocument(doc)).toEqual([]);
  });
});

describe('variables', () => {
  it('lists CAM uses with the tool, the setup, the operation and the path', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'editCamTool',
      tool: tool(T, { presets: [{ ...tool(T).presets[0]!, feed: mm('feed * 1.25') }] }),
    }).document;
    doc = apply(doc, {
      type: 'editCamSetup',
      setupId: S,
      heights: { clearance: mm('thickness + 10'), retract: mm('5') },
    }).document;
    expect(camVariableUses(doc, 'feed')).toEqual([
      { kind: 'camTool', toolId: T, path: ['presets', 0, 'feed'], expected: 'feed' },
      {
        kind: 'camSetup',
        setupId: S,
        operationId: 'profile#1',
        path: ['operations', 0, 'feeds', 'cut'],
        expected: 'feed',
      },
    ]);
    expect(camVariableUses(doc, 'thickness')).toEqual([
      { kind: 'camSetup', setupId: S, path: ['heights', 'clearance'], expected: 'length' },
      {
        kind: 'camSetup',
        setupId: S,
        operationId: 'pocket#1',
        path: ['operations', 1, 'depth', 'depth'],
        expected: 'length',
      },
    ]);
    // The model uses are listed apart, so CAM does not show among them.
    expect(variableUses(doc, 'feed')).toEqual([]);
    expect(variableCamUsers(doc, 'feed')).toEqual([T, `${S}/profile#1`]);
    expect(variableCamUsers(doc, 'thickness')).toEqual([S, `${S}/pocket#1`]);
    expect(variableUsers(doc, 'thickness')).toEqual(expect.arrayContaining([S, `${S}/pocket#1`]));
  });

  it('refuses to delete a variable a CAM expression reads', () => {
    const doc = machined();
    const error = refused(doc, { type: 'deleteVariable', name: 'feed' }, 'variable-in-use');
    expect(error?.blockers).toEqual([`${S}/profile#1`]);
    const freed = apply(doc, {
      type: 'editCamOperation',
      setupId: S,
      operation: profile('profile#1', { feeds: { cut: mm('1000mm/min') } }),
    }).document;
    apply(freed, { type: 'deleteVariable', name: 'feed' });
  });

  it('renames a variable in tools, setups and operations, as one undo step', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'editCamTool',
      tool: tool(T, { presets: [{ ...tool(T).presets[0]!, plunge: mm('feed / 3') }] }),
    }).document;
    doc = apply(doc, {
      type: 'editCamSetup',
      setupId: S,
      heights: { clearance: mm('10'), retract: mm('feed * 0 + 5mm') },
    }).document;
    const done = apply(doc, unwrap(renameVariable(doc, 'feed', 'cutFeed')));
    const cam = done.document.cam;
    expect(cam.tools[0]!.presets[0]!.plunge).toEqual(mm('#cutFeed / 3'));
    expect(cam.setups[0]!.heights.retract).toEqual(mm('#cutFeed * 0 + 5mm'));
    expect(cam.setups[0]!.operations[0]!.feeds).toEqual({ cut: mm('#cutFeed') });
    expect(camVariableUses(done.document, 'feed')).toEqual([]);
    expect(apply(done.document, done.inverse).document).toEqual(doc);
  });

  it('inlines a variable into CAM expressions', () => {
    const doc = machined();
    const done = apply(doc, unwrap(inlineVariable(doc, 'thickness', '6mm')));
    const op = done.document.cam.setups[0]!.operations[1]!;
    expect(op.kind === 'pocket' && op.depth).toEqual({ kind: 'blind', depth: mm('(6mm) / 2') });
    expect(done.document.variables.map((v) => v.name)).not.toContain('thickness');
    expect(apply(done.document, done.inverse).document).toEqual(doc);
  });
});

describe('changes', () => {
  it('reports a CAM edit separately, never as a part change', () => {
    const doc = machined();
    const next = apply(doc, { type: 'editCamSetup', setupId: S, post: 'grblhal' }).document;
    const change = diffDocuments(doc, next);
    expect(change.empty).toBe(false);
    expect(change.camChanged).toBe(true);
    expect(change.cam).toEqual({
      tools: { added: [], removed: [], changed: [] },
      setups: { added: [], removed: [], changed: [S] },
      reordered: false,
    });
    expect(change.parts).toEqual([]);
    expect(change.parts.every((p) => p.firstAffectedIndex === null)).toBe(true);
    expect(change.printChanged).toBe(false);
  });

  it('has no firstAffectedIndex in any part for any CAM-only edit', () => {
    const doc = machined();
    const commands: Command[] = [
      { type: 'addCamTool', tool: tool('tool#2') },
      { type: 'editCamTool', tool: tool(T, { flutes: 3 }) },
      { type: 'deleteCamOperation', setupId: S, operationId: 'drill#1' },
      { type: 'suppressCamOperation', setupId: S, operationId: 'drill#1', suppressed: true },
      { type: 'reorderCamOperation', setupId: S, operationId: 'drill#1', index: 0 },
      { type: 'deleteCamSetup', setupId: S },
    ];
    for (const c of commands) {
      const change = diffDocuments(doc, apply(doc, c).document);
      expect([c.type, change.camChanged, change.parts]).toEqual([c.type, true, []]);
    }
    const toolEdit = diffDocuments(doc, apply(doc, commands[1]!).document);
    expect(toolEdit.cam.tools.changed).toEqual([T]);
    expect(toolEdit.cam.setups.changed).toEqual([]);
  });

  it('reports added, removed and reordered setups and tools', () => {
    const doc = machined();
    const two = apply(doc, {
      type: 'addCamSetup',
      setup: setup({ id: 'setup#2', wcs: createCamSetup('x', 'x', PART, 'm', 'p').wcs }),
    }).document;
    expect(diffDocuments(doc, two).cam.setups.added).toEqual(['setup#2']);
    expect(diffDocuments(two, doc).cam.setups.removed).toEqual(['setup#2']);
    const swapped = apply(two, { type: 'reorderCamSetups', setupId: S, index: 1 }).document;
    const change = diffDocuments(two, swapped);
    expect(change.cam.reordered).toBe(true);
    expect(change.camChanged).toBe(true);
    const tooled = apply(doc, { type: 'addCamTool', tool: tool('tool#2') }).document;
    expect(diffDocuments(doc, tooled).cam.tools.added).toEqual(['tool#2']);
  });

  it('marks tools and setups whose expressions read a changed variable, and dirties no part', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'editCamTool',
      tool: tool(T, { presets: [{ ...tool(T).presets[0]!, feed: mm('feed') }] }),
    }).document;
    const next = apply(doc, {
      type: 'setVariable',
      name: 'feed',
      expression: mm('900mm/min'),
    }).document;
    const change = diffDocuments(doc, next);
    expect(change.camChanged).toBe(true);
    expect(change.cam.tools.changed).toEqual([T]);
    expect(change.cam.setups.changed).toEqual([S]);
    expect(change.variables.changed).toEqual(['feed']);
    expect(change.parts).toEqual([]);
  });

  it('reports no CAM change for a part edit, nor for nothing', () => {
    const doc = machined();
    const next = apply(doc, {
      type: 'renameFeature',
      partId: PART,
      featureId: 'fillet#1',
      name: 'Round',
    }).document;
    const change = diffDocuments(doc, next);
    expect(change.camChanged).toBe(false);
    expect(change.cam.setups).toEqual({ added: [], removed: [], changed: [] });
    const none = diffDocuments(doc, doc);
    expect(none.empty).toBe(true);
    expect(none.camChanged).toBe(false);
  });

  it('carries CAM changes through the store, undo and redo included', () => {
    const store = unwrap(DocumentStore.create(machined()));
    const before = store.document;
    const change = unwrap(
      store.execute({ type: 'deleteCamOperation', setupId: S, operationId: 'pocket#1' }),
    );
    expect(change.camChanged).toBe(true);
    expect(change.parts).toEqual([]);
    const undo = unwrap(store.undo());
    expect(undo.camChanged).toBe(true);
    expect(undo.cam.setups.changed).toEqual([S]);
    expect(store.document.cam.setups).toEqual(before.cam.setups);
    const redo = unwrap(store.redo());
    expect(redo.camChanged).toBe(true);
    expect(store.document.cam.setups[0]!.operations.map((o) => o.id)).toEqual([
      'profile#1',
      'drill#1',
    ]);
  });
});

describe('saving', () => {
  it('round trips CAM, with the counters in canonical key order', () => {
    const doc = machined();
    const shuffled: ManufaktureDocument = {
      ...doc,
      cam: {
        ...doc.cam,
        nextIds: { r: 3, drill: 2, tool: 2, pocket: 2, setup: 2, profile: 2 },
      },
    };
    const text = serialize(shuffled);
    expect(text).toBe(serialize(doc));
    const loaded = unwrap(deserialize(text));
    expect(loaded.document).toEqual(doc);
    expect(loaded.migrated).toBe(false);
    const json = JSON.parse(text) as { cam: { nextIds: object } };
    expect(Object.keys(json.cam.nextIds)).toEqual([
      'drill',
      'pocket',
      'profile',
      'r',
      'setup',
      'tool',
    ]);
    expect(serialize(loaded.document)).toBe(text);
  });

  it('round trips every operation kind and stock through serialize and deserialize', () => {
    let doc = machined();
    doc = apply(doc, {
      type: 'addCamTool',
      tool: tool('tool#2', { kind: 'vbit', angle: deg('60') }),
    }).document;
    doc = apply(doc, {
      type: 'addCamSetup',
      setup: setup({
        id: 'setup#2',
        body: 'extrude#1',
        stock: {
          kind: 'explicit',
          size: { x: mm('12"'), y: mm('8"'), z: mm('3/4"') },
          offset: { x: mm('1"'), y: mm('1"'), z: mm('0') },
          material: 'plywood',
        },
        wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'centre', z: 'bottom' } },
        operations: [
          {
            id: 'facing#1',
            kind: 'facing',
            name: 'Face',
            suppressed: false,
            tool: T,
            geometry: [],
            depth: mm('0.5'),
            stepdown: mm('0.5'),
            stepover: mm('0.6'),
            angle: deg('0'),
          },
          {
            id: 'vcarve#1',
            kind: 'vcarve',
            name: 'Sign',
            suppressed: true,
            tool: 'tool#2',
            geometry: [{ kind: 'region', sketch: 'sketch#1' }],
            maxDepth: mm('3'),
          },
          {
            id: 'surface3d#1',
            kind: 'surface3d',
            name: 'Finish',
            suppressed: false,
            tool: T,
            geometry: [],
            stepover: mm('0.2'),
            angle: deg('45'),
            allowance: mm('0'),
          },
        ],
      }),
    }).document;
    const loaded = unwrap(deserialize(serialize(doc)));
    expect(loaded.document).toEqual(doc);
    expect(loaded.document.cam.setups[1]!.operations.map((o) => o.kind)).toEqual([
      'facing',
      'vcarve',
      'surface3d',
    ]);
  });
});

/** The optional operation fields T5.5b folded into the v14 schema in place (no format bump). */
describe('operation extras', () => {
  const B = 'tool#2';
  const pocketExtras = (): CamOperation =>
    pocket('pocket#1', {
      finishAllowance: mm('0.3'),
      finishPass: false,
      finishStepdown: mm('4'),
      floorAllowance: mm('0.2'),
      floorPass: true,
    } as Partial<CamOperation>);
  const carve = (extra: Record<string, unknown> = {}): CamOperation =>
    ({
      id: 'vcarve#1',
      kind: 'vcarve',
      name: 'Letters',
      suppressed: false,
      tool: B,
      geometry: [{ kind: 'region', sketch: 'sketch#2' }],
      maxDepth: mm('3'),
      stepdown: mm('1.5'),
      flatStepover: mm('0.4'),
      clearing: {
        tool: T,
        stepdown: mm('1'),
        stepover: mm('0.4'),
        entry: { kind: 'helix', angle: deg('3'), radius: mm('1') },
        feeds: { cut: mm('feed') },
      },
      ...extra,
    }) as CamOperation;
  const surface = (extra: Record<string, unknown> = {}): CamOperation =>
    ({
      id: 'surface3d#1',
      kind: 'surface3d',
      name: 'Finish',
      suppressed: false,
      tool: B,
      geometry: [{ kind: 'region', sketch: 'sketch#2' }],
      stepover: mm('0.5'),
      angle: deg('0'),
      allowance: mm('0'),
      strategy: 'parallel',
      tolerance: mm('0.01'),
      sampling: mm('0.2'),
      pattern: 'oneway',
      stepdown: mm('2'),
      entry: { kind: 'ramp', angle: deg('3') },
      climb: false,
      sliceCell: mm('0.25'),
      ...extra,
    }) as CamOperation;

  /** The bracket with tool#1 (flat), tool#2 (V-bit) and the three operations above. */
  function extras(): ManufaktureDocument {
    let doc = apply(bracket(), {
      type: 'setVariable',
      name: 'feed',
      expression: mm('1200mm/min'),
    }).document;
    doc = apply(doc, { type: 'addCamTool', tool: tool(T) }).document;
    doc = apply(doc, {
      type: 'addCamTool',
      tool: tool(B, { kind: 'vbit', angle: deg('60') }),
    }).document;
    return apply(doc, {
      type: 'addCamSetup',
      setup: setup({ operations: [pocketExtras(), carve(), surface()] }),
    }).document;
  }

  it('accepts every new field, each optional', () => {
    for (const op of [pocketExtras(), carve(), surface(), surface({ strategy: 'zlevel' })]) {
      expect([op.id, CamOperationSchema.safeParse(op).success]).toEqual([op.id, true]);
    }
    const bare = carve({ clearing: { tool: T } });
    expect(CamOperationSchema.safeParse(bare).success).toBe(true);
    expect(CamOperationSchema.safeParse(pocket()).success).toBe(true);
    const doc = extras();
    expect(validateDocument(doc)).toEqual([]);
  });

  const refusals: [string, CamOperation][] = [
    ['a finish pass that is not a boolean', pocket('pocket#1', { finishPass: 'yes' } as never)],
    ['a floor allowance that is a number', pocket('pocket#1', { floorAllowance: 0.2 } as never)],
    ['a V-carve stepdown with no units', carve({ stepdown: { source: '1' } })],
    ['a clearing with no tool', carve({ clearing: { stepdown: mm('1') } })],
    ['a clearing tool that is not a tool id', carve({ clearing: { tool: 'setup#1' } })],
    ['a clearing with an unknown field', carve({ clearing: { tool: T, depth: mm('1') } })],
    ['a clearing with empty feeds', carve({ clearing: { tool: T, feeds: {} } })],
    ['an unknown entry on a clearing', carve({ clearing: { tool: T, entry: { kind: 'dive' } } })],
    ['an unknown strategy', surface({ strategy: 'waterline' })],
    ['an unknown pattern', surface({ pattern: 'spiral' })],
    [
      'a tolerance over the length limit',
      surface({ tolerance: mm('1'.repeat(MAX_CAM_EXPRESSION + 1)) }),
    ],
    ['a climb that is not a boolean', surface({ climb: 1 })],
    ['a sampling that is a number', surface({ sampling: 0.2 })],
    ['an unknown surfacing field', surface({ waterline: true })],
    ['a flat stepover on a pocket', pocket('pocket#1', { flatStepover: mm('1') } as never)],
  ];
  for (const [what, op] of refusals) {
    it(`refuses ${what}`, () => {
      expect(CamOperationSchema.safeParse(op).success).toBe(false);
    });
  }

  it('lists the new expressions with the kind each expects', () => {
    const sites = (op: CamOperation) =>
      camExpressions(op).map((s) => [s.path.join('.'), s.expected]);
    expect(sites(pocketExtras())).toEqual(
      expect.arrayContaining([
        ['finishStepdown', 'length'],
        ['floorAllowance', 'length'],
      ]),
    );
    expect(sites(carve())).toEqual([
      ['maxDepth', 'length'],
      ['stepdown', 'length'],
      ['flatStepover', 'length'],
      ['clearing.stepdown', 'length'],
      ['clearing.stepover', 'number'],
      ['clearing.entry.angle', 'angle'],
      ['clearing.entry.radius', 'length'],
      ['clearing.feeds.cut', 'feed'],
    ]);
    expect(sites(surface())).toEqual([
      ['stepover', 'length'],
      ['angle', 'angle'],
      ['allowance', 'length'],
      ['tolerance', 'length'],
      ['sampling', 'length'],
      ['stepdown', 'length'],
      ['entry.angle', 'angle'],
      ['sliceCell', 'length'],
    ]);
  });

  it('checks the clearing tool exists, and refuses to delete it while a V-carve clears with it', () => {
    const doc = extras();
    expect(camToolUsers(doc.cam, T)).toEqual([`${S}/pocket#1`, `${S}/vcarve#1`]);
    const error = refused(doc, { type: 'deleteCamTool', toolId: T }, 'dependency');
    expect(error?.blockers).toEqual([`${S}/pocket#1`, `${S}/vcarve#1`]);
    const missing = clone(doc);
    const op = missing.cam.setups[0]!.operations[1]!;
    if (op.kind === 'vcarve') op.clearing = { tool: 'tool#9' };
    missing.cam.nextIds.tool = 10;
    const errors = validateDocument(missing);
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['dependency', ['cam', 'setups', 0, 'operations', 1, 'clearing', 'tool']],
    ]);
  });

  it('checks the new expressions, and renames a variable in them', () => {
    const doc = extras();
    const bad = clone(doc);
    const op = bad.cam.setups[0]!.operations[2]!;
    if (op.kind === 'surface3d') op.sampling = mm('#nope');
    expect(validateDocument(bad).map((e) => [e.code, e.path])).toEqual([
      ['unknown-variable', ['cam', 'setups', 0, 'operations', 2, 'sampling', 'source']],
    ]);
    const done = apply(doc, unwrap(renameVariable(doc, 'feed', 'cutFeed')));
    const v = done.document.cam.setups[0]!.operations[1]!;
    expect(v.kind === 'vcarve' && v.clearing?.feeds).toEqual({ cut: mm('#cutFeed') });
    expect(apply(done.document, done.inverse).document).toEqual(doc);
  });

  it('edits and undoes the new fields, and round trips them through a file and a restore', () => {
    const doc = extras();
    roundTrip(doc, {
      type: 'editCamOperation',
      setupId: S,
      operation: surface({ strategy: 'zlevel', pattern: 'zigzag', climb: true }),
    });
    const { clearing: _c, ...unclearing } = carve() as CamOperation & { clearing?: unknown };
    void _c;
    roundTrip(doc, { type: 'editCamOperation', setupId: S, operation: unclearing as CamOperation });
    const text = serialize(doc);
    const loaded = unwrap(deserialize(text));
    expect(loaded.migrated).toBe(false);
    expect(loaded.document).toEqual(doc);
    expect(serialize(loaded.document)).toBe(text);
    expect(restoredDocument(bracket(), doc).cam).toEqual(doc.cam);
  });
});
