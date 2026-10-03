// Floors and roofs through regen with the real kernel (libcascade in Node), M6 plan T6.1c: the
// 12' x 16' shed's floor, walls and 6/12 gable roof regenerate together with the member counts of
// the T6.2b and T6.2c fixtures; a change of pitch re-runs only the roof (and its gable studs); and
// each roof plane's sheathing is exactly its hand-computed area.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type MemberData,
  type MemberSetResult,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConstruction } from '../domain';
import { countByRole, type Member } from '../members';
import { inch, toInches } from '../test-helpers';
import { readRoofMetadata } from './roof';

const PART = 'part#1';
const OSB = inch(7 / 16);
const OSB_23_32 = inch(23 / 32);
const PLATE = inch(97.125);
const SQ_IN = inch(1) * inch(1);

// A JSON-shaped expression (an inferred type, so it also fits where stored JSON is expected).
const ins = (v: number | string) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

/**
 * The shed's settings: one level at the datum, 97-1/8" high; a 2x4 wall type with 7/16" OSB
 * outside; a floor of 2x6 joists under 23/32" OSB; a roof of 2x6 rafters, a 2x8 ridge and 7/16"
 * OSB sheathing (the generator's defaults: 16" on centre, a 12" eave overhang, no rake overhang).
 */
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
    name: id,
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

// The walls run counter-clockwise with their exterior (right of the path) out, the path on the
// framing's outside face. The 16' walls (#1, #2) come first, so they run through the corners and
// the 12' gable walls (#3, #4) butt between them, as the takeoff's shed has it.
const WALLS = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
const shedWalls = [
  wall('extension#1', [0, 0], [192, 0]),
  wall('extension#2', [192, 144], [0, 144]),
  wall('extension#3', [192, 0], [192, 144]),
  wall('extension#4', [0, 144], [0, 0]),
];
const floor = ext(
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
);
const roof = (pitch: string, extra: Record<string, StoredExpression> = {}) =>
  ext(
    'extension#6',
    'construction.roof',
    { roofType: 'shed-roof', kind: 'gable' },
    { pitch: ins(pitch), ...extra },
    WALLS,
  );

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const add = (feature: ExtensionFeature): Command => ({ type: 'addFeature', partId: PART, feature });
const edit = (feature: ExtensionFeature): Command => ({
  type: 'editFeature',
  partId: PART,
  feature,
});

function shed(...features: ExtensionFeature[]): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-1', name: 'Shed' }),
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    ...features.map(add),
  );
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

async function volume(engine: RegenEngine, shape: ShapeId): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

const feature = (result: RegenResult, id: string) =>
  result.parts[0]!.features.find((f) => f.featureId === id)!;

function expectOk(result: RegenResult, ...ids: string[]) {
  for (const id of ids) {
    const f = feature(result, id);
    expect(f.status, `${id}: ${JSON.stringify(f.errors)}`).toBe('ok');
  }
}

function bodyShape(result: RegenResult, id: string): ShapeId {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id);
  expect(body, `body ${id}`).toBeDefined();
  return body!.shape;
}

const setOf = (result: RegenResult, group: string): MemberSetResult => {
  const set = (result.parts[0]!.members ?? []).find((s) => s.group === group);
  expect(set, `member set ${group}`).toBeDefined();
  return set!;
};

const membersOf = (result: RegenResult, group: string): MemberData[] =>
  setOf(result, group).members!;

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('these documents have no sketches');
  },
};

function engineFor(): RegenEngine {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({ kernel: service, solver: noSolver, extensions });
}

async function done(engine: RegenEngine) {
  await engine.dispose();
  await service.idle();
  expect(service.leaks()).toEqual([]);
}

/** cos(6/12) = 12 / sqrt(180): a plane's area up the slope is its plan area over it. */
const COS_6_12 = 12 / Math.sqrt(180);
const COS_4_12 = 12 / Math.sqrt(160);

describe('the 12 ft x 16 ft shed through regen with the real kernel', () => {
  it('regenerates the floor, walls and a 6/12 gable roof with the T6.2b and T6.2c counts', async () => {
    const engine = engineFor();
    const result = await regen(engine, shed(...shedWalls, floor, roof('6/12')));
    expectOk(result, ...WALLS, 'extension#5', 'extension#6');

    // T6.2b: 13 joists of 141" (2x6 at 16" over 16', spanning 12' less two rims), 2 rims of 16',
    // three 4x6 skids of 16'.
    const floorMembers = membersOf(result, 'extension#5');
    expect(countByRole(floorMembers as Member[])).toEqual({ joist: 13, rim: 2, skid: 3 });
    for (const m of floorMembers.filter((x) => x.role === 'joist')) {
      expect(toInches(m.length)).toBeCloseTo(141, 9);
    }
    for (const m of floorMembers.filter((x) => x.role !== 'joist')) {
      expect(toInches(m.length)).toBeCloseTo(192, 9);
    }
    // The subfloor's top is the level (the walls stand on it); the joists and rims hang below.
    const joist = floorMembers.find((m) => m.id === 'j0')!;
    expect(joist.placement.origin[2]).toBeCloseTo(-inch(23 / 32 + 5.5), 9);
    expect(await volume(engine, bodyShape(result, 'extension#5:layer/subfloor'))).toBeCloseTo(
      inch(192) * inch(144) * OSB_23_32,
      3,
    );

    // T6.2c: 13 pairs of common rafters and one ridge board, plus 8 gable studs on each gable
    // wall's own layout (the butting 12' walls' layouts start 3-1/2" in from the corner).
    const roofMembers = membersOf(result, 'extension#6');
    expect(countByRole(roofMembers as Member[])).toEqual({
      'common-rafter': 26,
      ridge: 1,
      'gable-stud': 16,
    });
    expect(roofMembers.every((m) => m.owner === 'extension#6')).toBe(true);
    expect(feature(result, 'extension#6').metadata).toMatchObject({
      kind: 'roof',
      walls: WALLS,
      input: { footprint: { length: inch(192), width: inch(144), wallThickness: inch(3.5) } },
    });
    const meta = readRoofMetadata(feature(result, 'extension#6').metadata)!;
    expect(meta.input.footprint.plate).toBeCloseTo(PLATE, 9);
    expect(meta.input.pitch).toBeCloseTo(Math.atan(0.5), 12);
    expect(meta.input.settings.gableStuds?.origin).toEqual({ e4: inch(140.5), e2: inch(3.5) });
    // The common rafter's line length to the ridge face is T6.2c's 79.66" (71.25 x 1.1180).
    expect(setOf(result, 'extension#6').metadata).toMatchObject({
      geometry: { commonRun: inch(71.25) },
    });

    // Each roof plane's sheathing: (overhang + width / 2) up the slope by the 16' length, its
    // underside exactly 192 x (12 + 72) / cos = 18,031.65 sq in; the body is that by the
    // thickness, extruded square to the plane.
    const plane = inch(192) * inch(12 + 72);
    for (const n of [1, 3]) {
      const v = await volume(engine, bodyShape(result, `extension#6:layer/sheathing-e${n}`));
      expect(v / OSB).toBeCloseTo(plane / COS_6_12, 1);
      expect(v / OSB / SQ_IN).toBeCloseTo(18031.65, 2);
    }
    // The gable walls' sheathing carried up to the roof line: a triangle 144" wide and 36" high.
    for (const n of [2, 4]) {
      const v = await volume(engine, bodyShape(result, `extension#6:layer/gable-e${n}-sheathing`));
      expect(v).toBeCloseTo(((inch(144) * inch(36)) / 2) * OSB, 2);
    }
    await done(engine);
  });

  it('changing the pitch to 4/12 re-runs only the roof and its gable studs', async () => {
    const engine = engineFor();
    const doc = shed(...shedWalls, floor, roof('6/12'));
    const first = await regen(engine, doc);
    expectOk(first, ...WALLS, 'extension#5', 'extension#6');
    const studsBefore = membersOf(first, 'extension#6').filter((m) => m.role === 'gable-stud');

    const second = await regen(engine, apply(doc, edit(roof('4/12'))));
    expectOk(second, ...WALLS, 'extension#5', 'extension#6');
    for (const id of [...WALLS, 'extension#5']) {
      expect(feature(second, id).cached, id).toBe(true);
      expect(setOf(second, id), id).toMatchObject({ cached: true, changed: false });
    }
    expect(feature(second, 'extension#6').cached).toBe(false);
    expect(setOf(second, 'extension#6')).toMatchObject({ cached: false, changed: true });
    const after = membersOf(second, 'extension#6');
    expect(countByRole(after as Member[])).toEqual({
      'common-rafter': 26,
      ridge: 1,
      'gable-stud': 16,
    });
    // The gable studs are cut to the lower roof line: each one shorter.
    const studs = after.filter((m) => m.role === 'gable-stud');
    expect(studs.map((m) => m.id)).toEqual(studsBefore.map((m) => m.id));
    studs.forEach((m, i) => expect(m.length).toBeLessThan(studsBefore[i]!.length));
    for (const n of [1, 3]) {
      const v = await volume(engine, bodyShape(second, `extension#6:layer/sheathing-e${n}`));
      expect(v / OSB).toBeCloseTo((inch(192) * inch(84)) / COS_4_12, 1);
    }
    await done(engine);
  });

  it('reads the pitch as a slope field: 6:12, 25% and degrees, and refuses a bare number', async () => {
    const engine = engineFor();
    const pitchOf = async (source: string) => {
      const r = await regen(engine, shed(...shedWalls, roof(source)));
      return feature(r, 'extension#6');
    };
    expect(readRoofMetadata((await pitchOf('6:12')).metadata)!.input.pitch).toBeCloseTo(
      Math.atan(0.5),
      12,
    );
    expect(readRoofMetadata((await pitchOf('25%')).metadata)!.input.pitch).toBeCloseTo(
      Math.atan(0.25),
      12,
    );
    expect(readRoofMetadata((await pitchOf('30deg')).metadata)!.input.pitch).toBeCloseTo(
      Math.PI / 6,
      12,
    );
    const bare = await pitchOf('30');
    expect(bare.status).not.toBe('ok');
    expect(bare.errors[0]).toMatchObject({ field: ['expressions', 'pitch'] });
    await done(engine);
  });

  it('a hip roof sheathes four planes cut at the hips, each its hand-computed area', async () => {
    const engine = engineFor();
    const hip = ext(
      'extension#6',
      'construction.roof',
      { roofType: 'shed-roof', kind: 'hip' },
      { pitch: ins('6/12') },
      WALLS,
    );
    const doc = apply(shed(...shedWalls), {
      type: 'setDomainData',
      namespace: 'construction',
      schemaVersion: 1,
      data: {
        ...CONSTRUCTION,
        roofTypes: [{ ...CONSTRUCTION.roofTypes[0], hipStock: 'us-2x8' }],
      },
    });
    const result = await regen(engine, apply(doc, add(hip)));
    expectOk(result, 'extension#6');
    // Plan areas with a 12" overhang all round: the eave planes trapezoids from 216" at the eave
    // line to the 48" ridge, 84" deep; the end planes triangles 168" wide, 84" deep.
    const eave = ((216 + 48) / 2) * 84;
    const end = (168 * 84) / 2;
    for (const [n, plan] of [
      [1, eave],
      [2, end],
      [3, eave],
      [4, end],
    ] as const) {
      const v = await volume(engine, bodyShape(result, `extension#6:layer/sheathing-e${n}`));
      expect(v / OSB / SQ_IN).toBeCloseTo(plan / COS_6_12, 3);
    }
    expect(countByRole(membersOf(result, 'extension#6') as Member[])).toMatchObject({
      'hip-rafter': 4,
      ridge: 1,
    });
    await done(engine);
  });

  it('a roof fails with the walls it bears on, through dependsOn', async () => {
    const engine = engineFor();
    const doc = shed(...shedWalls, roof('6/12'));
    const broken = apply(doc, edit(wall('extension#3', [192, 0], [192, 100])));
    const result = await regen(engine, broken);
    expect(feature(result, 'extension#6').status).not.toBe('ok');
    expect(JSON.stringify(feature(result, 'extension#6').errors)).toMatch(/ring|rectangle/);
    await done(engine);
  });
});
