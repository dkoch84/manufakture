// The construction model as IFC, from a real regen (T6.6a): the 12' x 16' shed (four walls, a door
// and a window, a floor with skids and subfloor, a 6/12 gable roof with sheathing) regenerated with
// the real kernel (libcascade in Node), turned into the writer's input by
// `constructionIfcBuilding`, written by `@manufakture/io` and read back with web-ifc.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { memberClass, writeIfc } from '@manufakture/io';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type MemberData,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConstructionData } from '../data';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { registerConstruction } from '../domain';
import type { Member } from '../members';
import { constructionIfcBuilding, type ConstructionIfcSource } from './adapter';
import { fullId, ifcReader, type IfcReader } from './test-ifc-read';

const PART = 'part#1';

const ins = (v: number | string) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});

const CONSTRUCTION = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: ins(0), height: ins(97.125) }],
  wallTypes: [
    {
      id: 'ext-2x4',
      name: 'Exterior 2x4',
      layers: [
        { id: 'sheathing', kind: 'sheathing', stock: 'us-osb-7-16' },
        {
          id: 'framing',
          kind: 'framing',
          stock: 'us-2x4',
          header: { stock: 'us-2x6', plies: 2, jacks: 1 },
        },
      ],
    },
  ],
  floorTypes: [
    { id: 'shed-floor', name: 'Shed floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
  ],
  roofTypes: [
    {
      id: 'shed-roof',
      name: 'Shed roof',
      rafterStock: 'us-2x6',
      ridgeStock: 'us-2x8',
      sheathing: 'us-osb-7-16',
    },
  ],
};

function ext(
  id: string,
  extension: string,
  params: Record<string, unknown>,
  expressions: Record<string, StoredExpression>,
  dependsOn: string[] = [],
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: `Feature ${id}`,
    suppressed: false,
    extension,
    schemaVersion: 1,
    dependsOn,
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    operation: 'new',
  };
}

const wall = (id: string, a: [number, number], b: [number, number]) =>
  ext(
    id,
    'construction.wall',
    { level: 'level-1', wallType: 'ext-2x4', points: 2 },
    { x1: ins(a[0]), y1: ins(a[1]), x2: ins(b[0]), y2: ins(b[1]) },
  );

/** An opening cuts its wall and makes no body: it has no operation. */
function withoutOperation(f: ExtensionFeature): ExtensionFeature {
  const rest: Partial<ExtensionFeature> = { ...f };
  delete rest.operation;
  return rest as ExtensionFeature;
}

const WALLS = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
const FEATURES: ExtensionFeature[] = [
  wall('extension#1', [0, 0], [192, 0]),
  wall('extension#2', [192, 144], [0, 144]),
  wall('extension#3', [192, 0], [192, 144]),
  wall('extension#4', [0, 144], [0, 0]),
  ext(
    'extension#5',
    'construction.floor',
    {
      level: 'level-1',
      floorType: 'shed-floor',
      outline: 'walls',
      skids: { stock: 'us-4x6', count: 3 },
    },
    {},
    WALLS,
  ),
  ext(
    'extension#6',
    'construction.roof',
    { roofType: 'shed-roof', kind: 'gable' },
    { pitch: ins('6/12') },
    WALLS,
  ),
  withoutOperation(
    ext(
      'extension#7',
      'construction.opening',
      { kind: 'door' },
      { position: ins(72), width: ins(36), height: ins(80) },
      ['extension#3'],
    ),
  ),
  withoutOperation(
    ext(
      'extension#8',
      'construction.opening',
      { kind: 'window' },
      { position: ins(48), width: ins(24), height: ins(36), sill: ins(42) },
      ['extension#1'],
    ),
  ),
];

function shed(): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-ifc-shed', name: 'Shed' });
  const commands: Command[] = [
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    ...FEATURES.map((feature): Command => ({ type: 'addFeature', partId: PART, feature })),
  ];
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

const engineFor = () => {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({ kernel: service, solver: noSolver, extensions });
};

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('these documents have no sketches');
  },
};

let service: KernelService;
let reader: IfcReader;

beforeAll(async () => {
  service = await createNodeService();
  reader = await ifcReader();
}, 60_000);

afterAll(async () => {
  reader.close();
  await service.idle();
});

function source(doc: ManufaktureDocument, result: RegenResult): ConstructionIfcSource {
  const data = readConstructionData(CONSTRUCTION, 1);
  if (!data.ok) throw new Error(data.message);
  const part = result.parts[0]!;
  const members: MemberData[] = (part.members ?? []).flatMap((s) => s.members ?? []);
  const features = doc.parts[0]!.features;
  return {
    documentId: doc.id,
    name: doc.name,
    unit: 'ft',
    levels: data.value.settings.levels,
    features: part.features,
    members,
    names: new Map(features.map((f) => [f.id, f.name])),
  };
}

describe('the shed through regen as IFC', () => {
  let result: RegenResult;
  let doc: ManufaktureDocument;
  let engine: RegenEngine;

  beforeAll(async () => {
    engine = engineFor();
    doc = shed();
    result = await regen(engine, doc);
    for (const f of result.parts[0]!.features) {
      expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
    }
  }, 60_000);

  afterAll(async () => {
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('maps every wall, opening, floor, roof and member, and leaves nothing out', () => {
    const { building, notes } = constructionIfcBuilding(source(doc, result));
    expect(notes).toEqual([]);
    expect(building.disclaimer).toBe(DISCLAIMER_SHORT);
    expect(building.walls!.map((w) => w.id)).toEqual(WALLS);
    expect(building.walls![0]!.name).toBe('Feature extension#1');
    expect(building.walls![0]!.layers!.map((l) => l.kind)).toEqual(['sheathing', 'framing']);
    expect(building.openings!.map((o) => [o.id, o.type, o.wall])).toEqual([
      ['extension#7', 'door', 'extension#3'],
      ['extension#8', 'window', 'extension#1'],
    ]);
    expect(building.floors![0]!.thickness).toBeCloseTo(25.4 * (23 / 32), 9);
    expect(building.roofs![0]!.sheets!.map((s) => s.id)).toEqual(['sheathing-e1', 'sheathing-e3']);
    expect(building.members!.length).toBeGreaterThan(100);
  });

  it('writes a file whose entities match the model, read back with web-ifc', async () => {
    const src = source(doc, result);
    const { building } = constructionIfcBuilding(src);
    const members = building.members as Member[];
    const model = reader.read(await writeIfc(building));
    const asMember = members.filter((m) => memberClass(m.role).entity === 'member').length;
    expect(reader.counts(model)).toEqual({
      project: 1,
      site: 1,
      building: 1,
      storey: 1,
      wall: 4,
      opening: 2,
      door: 1,
      window: 1,
      member: asMember,
      beam: members.length - asMember,
      plate: 4 + 2, // wall sheathing, the roof's two planes
      covering: 0,
      slab: 1,
      roof: 1,
    });
    const tags = [
      ...reader.lines(model, reader.mod.IFCMEMBER),
      ...reader.lines(model, reader.mod.IFCBEAM),
    ].map((e) => e.Tag.value as string);
    expect(tags.sort()).toEqual(members.map(fullId).sort());
    expect(reader.worstPlacement(model, members)).toBeLessThan(0.01);
  });

  it("puts the roof's sheathing sheets where regen built the sheathing bodies", async () => {
    const { building } = constructionIfcBuilding(source(doc, result));
    const model = reader.read(await writeIfc(building));
    const sheets = reader
      .ids(model, reader.mod.IFCPLATE)
      .map((id) => [reader.api.GetLine(model, id).Tag.value as string, id] as const)
      .filter(([tag]) => tag.startsWith('extension#6/'));
    expect(sheets).toHaveLength(2);
    for (const [tag, id] of sheets) {
      const key = tag.slice('extension#6/'.length);
      const body = result.parts[0]!.bodies.find((b) => b.bodyId === `extension#6:layer/${key}`)!;
      const p = body.mesh!.positions;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, p[i + k]!);
          hi[k] = Math.max(hi[k]!, p[i + k]!);
        }
      }
      const [ilo, ihi] = reader.boxOf(model, id);
      for (let k = 0; k < 3; k++) {
        expect(ilo[k]).toBeCloseTo(lo[k]!, 1);
        expect(ihi[k]).toBeCloseTo(hi[k]!, 1);
      }
    }
  });

  it('keeps every GlobalId when the document is regenerated from scratch and exported again', async () => {
    const first = reader.globalIds(
      reader.read(await writeIfc(constructionIfcBuilding(source(doc, result)).building)),
    );
    // A fresh engine, so every member set comes back in full (a warm one sends unchanged sets
    // as null, and the app keeps the last).
    const other = engineFor();
    try {
      const again = await regen(other, doc);
      const second = reader.globalIds(
        reader.read(await writeIfc(constructionIfcBuilding(source(doc, again)).building)),
      );
      expect(second.size).toBeGreaterThan(150);
      expect(second).toEqual(first);
    } finally {
      await other.dispose();
    }
  }, 60_000);

  it('leaves out an opening whose wall is missing, and its members', () => {
    const src = source(doc, result);
    const features = src.features.filter((f) => f.featureId !== 'extension#3');
    const { building, notes } = constructionIfcBuilding({ ...src, features });
    expect(building.openings!.map((o) => o.id)).toEqual(['extension#8']);
    expect(
      building.members!.some((m) => m.owner === 'extension#3' || m.owner === 'extension#7'),
    ).toBe(false);
    expect(notes).toHaveLength(2);
  });

  it('leaves out what a remodel demolishes: a door, and a wall with its window (#1213)', async () => {
    let remodel = shed();
    const edit = (id: string, change: (f: ExtensionFeature) => ExtensionFeature) => {
      const f = remodel.parts[0]!.features.find((x) => x.id === id) as ExtensionFeature;
      const r = applyCommand(remodel, { type: 'editFeature', partId: PART, feature: change(f) });
      if (!r.ok) throw new Error(r.error.message);
      remodel = r.value.document;
    };
    edit('extension#7', (f) => ({ ...f, params: { ...f.params, phase: 'demolish' } }));
    // A demolished wall makes no body, so it has no operation.
    edit('extension#1', (f) =>
      withoutOperation({ ...f, params: { ...f.params, phase: 'demolish' } }),
    );
    const other = engineFor();
    try {
      const r = await regen(other, remodel);
      for (const id of ['extension#1', 'extension#7', 'extension#8']) {
        const f = r.parts[0]!.features.find((x) => x.featureId === id)!;
        expect(f.status, `${id}: ${JSON.stringify(f.errors)}`).toBe('ok');
      }
      const { building, notes } = constructionIfcBuilding(source(remodel, r));
      expect(building.walls!.map((w) => w.id)).toEqual([
        'extension#2',
        'extension#3',
        'extension#4',
      ]);
      expect(building.openings).toEqual([]);
      expect(notes).toEqual([
        'Feature extension#1 is left out: it is demolished.',
        'Feature extension#7 is left out: it is demolished.',
        'Opening Feature extension#8 is left out: its wall is demolished.',
      ]);
      // Their members are not in the design, so none reach the file.
      expect(
        building.members!.some((m) =>
          ['extension#1', 'extension#7', 'extension#8'].includes(m.owner),
        ),
      ).toBe(false);
      const model = reader.read(await writeIfc(building));
      expect(reader.counts(model)).toMatchObject({ wall: 3, opening: 0, door: 0, window: 0 });
    } finally {
      await other.dispose();
    }
  }, 60_000);
});
