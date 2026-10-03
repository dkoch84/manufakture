// Walls and openings through regen with the real kernel (libcascade in Node): layer bodies with
// exact volumes, the member stage framing each wall with its openings and the walls it meets, and
// the caching that keeps an opening's move to its own wall. The domain registers on its own
// registry, as the app's regen worker entry does on the default one.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type MirrorFeature,
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
import { inch } from '../test-helpers';
import { MAX_COORDINATE } from './common';
import { layerArea } from './wall';

const PART = 'part#1';
const HEIGHT = inch(97.125);
const OSB = inch(7 / 16);
const GYP = 12.7;
const STUD = inch(3.5);

// A JSON-shaped expression (an inferred type, so it also fits where stored JSON is expected).
const ins = (v: number) => ({
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

/** One level at the datum, 97-1/8" high; a 2x4 wall type with OSB outside and drywall inside. */
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
          header: { stock: 'us-2x8', plies: 2, jacks: 1 },
        },
        { id: 'drywall', kind: 'drywall', stock: 'us-gyp-1-2-8ft' },
      ],
    },
  ],
};

function wall(
  id: string,
  points: readonly (readonly [number, number])[],
  params: Record<string, unknown> = {},
  expressions: Record<string, StoredExpression> = {},
): ExtensionFeature {
  const exprs: Record<string, StoredExpression> = {};
  points.forEach(([x, y], i) => {
    exprs[`x${i + 1}`] = ins(x);
    exprs[`y${i + 1}`] = ins(y);
  });
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'construction.wall',
    schemaVersion: 1,
    dependsOn: [],
    references: [],
    expressions: { ...exprs, ...expressions },
    params: {
      level: 'level-1',
      wallType: 'ext-2x4',
      points: points.length,
      ...params,
    } as ExtensionFeature['params'],
    operation: 'new',
  };
}

function opening(
  id: string,
  host: string,
  params: Record<string, unknown>,
  expressions: Record<string, number>,
  extra: Partial<ExtensionFeature> = {},
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'construction.opening',
    schemaVersion: 1,
    dependsOn: [host],
    references: [],
    expressions: Object.fromEntries(Object.entries(expressions).map(([k, v]) => [k, ins(v)])),
    params: params as ExtensionFeature['params'],
    ...extra,
  };
}

/** A 36" x 80" door centred 48" from the start of its wall's first segment. */
const door = (id: string, host: string, at = 48) =>
  opening(id, host, { kind: 'door' }, { position: at, width: 36, height: 80 });

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

function building(...features: ExtensionFeature[]): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-1', name: 'Walls' }),
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

const ids = (members: readonly MemberData[], owner?: string) =>
  members.filter((m) => owner === undefined || m.owner === owner).map((m) => m.id);

const byId = (members: readonly MemberData[], full: string) =>
  members.find((m) => `${m.owner}:${m.id}` === full)!;

/** The documents here have no sketches, so the solver is never asked. */
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

describe('walls through regen with the real kernel', () => {
  it('a 16 ft wall makes its layer bodies with exact volumes and the T6.2a framing', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
      ),
    );
    expectOk(result, 'extension#1');
    const L = inch(192);
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/sheathing'))).toBeCloseTo(
      L * HEIGHT * OSB,
      3,
    );
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/drywall'))).toBeCloseTo(
      L * HEIGHT * GYP,
      3,
    );
    // The framing layer is members, not a body.
    expect(result.parts[0]!.bodies.map((b) => b.bodyId).sort()).toEqual([
      'extension#1:layer/drywall',
      'extension#1:layer/sheathing',
    ]);
    // Face names: unique across the bodies, named by layer and segment.
    expect(result.names).toEqual(
      expect.arrayContaining([
        'extension#1:side:sheathing.ext1',
        'extension#1:side:sheathing.int1',
        'extension#1:side:sheathing.start',
        'extension#1:side:drywall.end',
        'extension#1:cap.sheathing:start',
        'extension#1:cap.drywall:end',
      ]),
    );

    // T6.2a's fixture: 13 studs at 16" on centre, 1 bottom and 2 top plates, all 92-5/8" precut.
    const members = membersOf(result, 'extension#1');
    expect(countByRole(members as Member[])).toEqual({
      'bottom-plate': 1,
      stud: 13,
      'top-plate': 2,
    });
    expect(ids(members.filter((m) => m.role === 'stud'))).toEqual(
      Array.from({ length: 13 }, (_, k) => `s${k}`),
    );
    for (const m of members.filter((x) => x.role === 'stud')) {
      expect(m.length).toBeCloseTo(inch(92.625), 9);
    }
    // The framing lies left of the path (justification left), the sheathing right of it.
    const s1 = byId(members, 'extension#1:s1');
    expect(s1.placement.origin[0]).toBeCloseTo(inch(16) - inch(0.75), 6);
    expect(s1.placement.origin[1]).toBeCloseTo(0, 6);
    await done(engine);
  });

  it('an L of two segments mitres its layers and frames the corner', async () => {
    const engine = engineFor();
    // 16' along x, then 12' along y: a left turn, so the interior (left) is inside the L.
    const doc = building(
      wall('extension#1', [
        [0, 0],
        [192, 0],
        [192, 144],
      ]),
    );
    const result = await regen(engine, doc);
    expectOk(result, 'extension#1');
    // A band from lo to hi left of a path turning left by 90 degrees: (hi - lo)(L1 + L2) less
    // (hi^2 - lo^2), the mitre's overlap. Sheathing is right of the path, drywall past the studs.
    const strip = (lo: number, hi: number) =>
      (hi - lo) * (inch(192) + inch(144)) - (hi * hi - lo * lo);
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/sheathing'))).toBeCloseTo(
      strip(-OSB, 0) * HEIGHT,
      2,
    );
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/drywall'))).toBeCloseTo(
      strip(STUD, STUD + GYP) * HEIGHT,
      2,
    );
    expect(strip(-OSB, 0)).toBeCloseTo(
      layerArea(
        [
          [0, 0],
          [inch(192), 0],
          [inch(192), inch(144)],
        ],
        false,
        -OSB,
        0,
      ),
      6,
    );
    const members = membersOf(result, 'extension#1');
    // Segment 1 runs through and carries the corner stud; segment 2 butts and starts at its face.
    expect(ids(members)).toEqual(
      expect.arrayContaining(['end:corner', 'seg2/s0', 'seg2/bottom1:1']),
    );
    const seg2Start = byId(members, 'extension#1:seg2/s0');
    expect(seg2Start.placement.origin[1]).toBeCloseTo(STUD, 6);
    await done(engine);
  });

  it('a closed wall frames a 12 x 16 ft outline as a pinwheel of through and butting walls', async () => {
    const engine = engineFor();
    const doc = building(
      wall(
        'extension#1',
        [
          [0, 0],
          [192, 0],
          [192, 144],
          [0, 144],
        ],
        { closed: true },
      ),
    );
    const result = await regen(engine, doc);
    expectOk(result, 'extension#1');
    // The sheathing outline: a ring 7/16" wide outside the 16' x 12' path.
    const outer = (inch(192) + 2 * OSB) * (inch(144) + 2 * OSB) - inch(192) * inch(144);
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/sheathing'))).toBeCloseTo(
      outer * HEIGHT,
      2,
    );
    const members = membersOf(result, 'extension#1');
    for (const prefix of ['', 'seg2/', 'seg3/', 'seg4/']) {
      expect(ids(members)).toEqual(expect.arrayContaining([`${prefix}end:corner`]));
    }
    await done(engine);
  });

  it('an opening cuts sheathing and drywall exactly and reframes the wall', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
        door('extension#2', 'extension#1'),
      ),
    );
    expectOk(result, 'extension#1', 'extension#2');
    const L = inch(192);
    const hole = inch(36) * inch(80);
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/sheathing'))).toBeCloseTo(
      (L * HEIGHT - hole) * OSB,
      3,
    );
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/drywall'))).toBeCloseTo(
      (L * HEIGHT - hole) * GYP,
      3,
    );
    expect(result.names).toEqual(
      expect.arrayContaining(['extension#2:sheathing:xmin', 'extension#2:drywall:zmax']),
    );
    const members = membersOf(result, 'extension#1');
    // The opening's members are its own (cripples on the 32", 48" and 64" layout); the layout
    // studs inside its framing are gone.
    expect(ids(members, 'extension#2').sort()).toEqual(
      [
        'cripple-a1',
        'cripple-a2',
        'cripple-a3',
        'header',
        'header-2',
        'jack-l',
        'jack-r',
        'king-l',
        'king-r',
      ].sort(),
    );
    expect(ids(members, 'extension#1')).not.toContain('s3');
    expect(byId(members, 'extension#2:jack-l').length).toBeCloseTo(inch(78.5), 9);
    // The header came from the wall type's default (no header rules in the document).
    expect(setOf(result, 'extension#1').metadata).toMatchObject({
      openings: [{ id: 'extension#2', header: { source: 'default', plies: 2 }, framed: true }],
    });
    await done(engine);
  });

  it('moving an opening changes only its own wall', async () => {
    const engine = engineFor();
    const doc = building(
      wall('extension#1', [
        [0, 0],
        [192, 0],
      ]),
      door('extension#2', 'extension#1'),
      wall('extension#3', [
        [0, 300],
        [192, 300],
      ]),
    );
    const first = await regen(engine, doc);
    expectOk(first, 'extension#1', 'extension#2', 'extension#3');
    const moved = await regen(engine, apply(doc, edit(door('extension#2', 'extension#1', 100))));
    expect(setOf(moved, 'extension#1')).toMatchObject({ cached: false, changed: true });
    expect(setOf(moved, 'extension#3')).toMatchObject({ cached: true, changed: false });
    expect(feature(moved, 'extension#3').cached).toBe(true);
    const king = byId(membersOf(moved, 'extension#1'), 'extension#2:king-l');
    expect(king.placement.origin[0]).toBeCloseTo(inch(100 - 18 - 1.5 - 1.5), 6);
    await done(engine);
  });

  it('two walls meeting at an L: the first runs through, the second butts', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
        wall('extension#2', [
          [192, 0],
          [192, 144],
        ]),
      ),
    );
    expectOk(result, 'extension#1', 'extension#2');
    const first = membersOf(result, 'extension#1');
    expect(ids(first)).toContain('end:corner');
    const second = membersOf(result, 'extension#2');
    expect(ids(second)).not.toContain('start:corner');
    // The butting wall starts at the through wall's inside face, a stud depth in.
    expect(byId(second, 'extension#2:s0').placement.origin[1]).toBeCloseTo(STUD, 6);
    // Each group knows its neighbour.
    expect(setOf(result, 'extension#1').features).toEqual(['extension#1', 'extension#2']);
    await done(engine);
  });

  it('a wall ending on another frames a tee in the other', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
        // Running up +y, its framing lies right of its path: from x = 100" to 103-1/2".
        wall(
          'extension#2',
          [
            [100, 0],
            [100, 120],
          ],
          { justification: 'right' },
        ),
      ),
    );
    expectOk(result, 'extension#1', 'extension#2');
    const host = membersOf(result, 'extension#1');
    expect(ids(host)).toEqual(expect.arrayContaining(['t1:corner-l', 't1:corner-r']));
    const left = byId(host, 'extension#1:t1:corner-l');
    // corner-l ends where the meeting wall's framing starts, corner-r where it ends.
    expect(left.placement.origin[0]).toBeCloseTo(inch(100 - 1.5), 6);
    expect(byId(host, 'extension#1:t1:corner-r').placement.origin[0]).toBeCloseTo(inch(103.5), 6);
    const branch = membersOf(result, 'extension#2');
    expect(byId(branch, 'extension#2:s0').placement.origin[1]).toBeCloseTo(STUD, 6);
    await done(engine);
  });

  it('refuses walls that cross away from their ends', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
        wall('extension#2', [
          [96, -60],
          [96, 60],
        ]),
      ),
    );
    for (const id of ['extension#1', 'extension#2']) {
      expect(feature(result, id).status).toBe('error');
      expect(feature(result, id).errors[0]!.message).toMatch(/crosses/);
    }
    await done(engine);
  });

  it('a suppressed host fails its opening; deleting it is refused while the opening needs it', async () => {
    const engine = engineFor();
    const doc = building(
      wall('extension#1', [
        [0, 0],
        [192, 0],
      ]),
      door('extension#2', 'extension#1'),
    );
    const suppressed = apply(
      doc,
      edit({
        ...wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
        suppressed: true,
      }),
    );
    const result = await regen(engine, suppressed);
    expect(feature(result, 'extension#2')).toMatchObject({
      status: 'upstream-error',
      errors: [{ code: 'upstream', upstream: ['extension#1'] }],
    });
    const del = applyCommand(doc, {
      type: 'deleteFeature',
      partId: PART,
      featureId: 'extension#1',
    });
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toMatchObject({ code: 'dependency', blockers: ['extension#2'] });
    await done(engine);
  });

  it('a stock thickness override widens the wall', async () => {
    const engine = engineFor();
    const doc = apply(
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
      ),
      {
        type: 'setDomainData',
        namespace: 'stock',
        schemaVersion: 1,
        data: { overrides: { 'us-osb-7-16': { thickness: ins(0.5) } } },
      },
    );
    const result = await regen(engine, doc);
    expectOk(result, 'extension#1');
    expect(await volume(engine, bodyShape(result, 'extension#1:layer/sheathing'))).toBeCloseTo(
      inch(192) * HEIGHT * inch(0.5),
      3,
    );
    await done(engine);
  });

  it('keeps its layer face names when the wall lengthens', async () => {
    const engine = engineFor();
    const short = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [192, 0],
        ]),
      ),
    );
    const long = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [240, 0],
        ]),
      ),
    );
    expect([...long.names].sort()).toEqual([...short.names].sort());
    // Slots before the end keep their ids; the longer wall adds slots after them.
    const before = ids(membersOf(short, 'extension#1'));
    expect(ids(membersOf(long, 'extension#1'))).toEqual(
      expect.arrayContaining(before.filter((id) => id !== 's12')),
    );
    await done(engine);
  });

  it('a later feature on a sheathing face resolves exact after the wall lengthens', async () => {
    const engine = engineFor();
    const face = 'extension#1:side:sheathing.ext1';
    // A mirror of the sheathing body in its own exterior face: the face is its reference.
    const mirror: MirrorFeature = {
      id: 'mirror#1',
      kind: 'mirror',
      name: 'Mirror 1',
      suppressed: false,
      features: [],
      body: true,
      scope: ['extension#1:layer/sheathing'],
      mode: 'new',
      plane: { id: 'r1', ref: { face } },
    };
    const docOf = (length: number) =>
      apply(
        building(
          wall('extension#1', [
            [0, 0],
            [length, 0],
          ]),
        ),
        { type: 'addFeature', partId: PART, feature: mirror },
      );
    const expected = [{ referenceId: 'r1', target: face, via: 'exact', fragile: false }];
    const short = await regen(engine, docOf(192));
    expectOk(short, 'extension#1', 'mirror#1');
    expect(feature(short, 'mirror#1').references).toEqual(expected);
    const long = await regen(engine, docOf(240));
    expectOk(long, 'extension#1', 'mirror#1');
    expect(feature(long, 'mirror#1').references).toEqual(expected);
    expect(feature(long, 'mirror#1').warnings).toEqual([]);
    // The copy follows the longer wall: as long as the sheathing, on the far side of the face.
    const copy = (result: RegenResult) =>
      result.parts[0]!.bodies.find((b) => b.bodyId.startsWith('mirror#1'))!;
    expect(await volume(engine, copy(long).shape)).toBeCloseTo(inch(240) * HEIGHT * OSB, 3);
    await done(engine);
  });

  it('checks an opening against its host and its scope', async () => {
    const engine = engineFor();
    const host = wall('extension#1', [
      [0, 0],
      [192, 0],
    ]);
    const scoped = await regen(
      engine,
      building(
        host,
        opening(
          'extension#2',
          'extension#1',
          { kind: 'window' },
          { position: 48, width: 36, height: 48, sill: 36 },
          { scope: ['extension#1:layer/sheathing'] },
        ),
      ),
    );
    expect(feature(scoped, 'extension#2').errors[0]!.message).toMatch(
      /cuts extension#1:layer\/drywall: list it in the opening's scope/,
    );
    const outside = await regen(
      engine,
      building(
        host,
        opening(
          'extension#2',
          'extension#1',
          { kind: 'door' },
          { position: 186, width: 36, height: 80 },
        ),
      ),
    );
    expect(feature(outside, 'extension#2').errors[0]!.message).toMatch(/does not fit/);
    const windowOk = await regen(
      engine,
      building(
        host,
        opening(
          'extension#2',
          'extension#1',
          { kind: 'window', from: 'end' },
          { position: 48, width: 36, height: 48, sill: 36 },
        ),
      ),
    );
    expectOk(windowOk, 'extension#1', 'extension#2');
    const sill = byId(membersOf(windowOk, 'extension#1'), 'extension#2:sill');
    expect(sill.placement.origin[0]).toBeCloseTo(inch(192 - 48 - 18), 6);
    await done(engine);
  });

  it('reports which header each opening used, and warns when no rule covers one', async () => {
    const engine = engineFor();
    const doc = apply(
      building(
        wall('extension#1', [
          [0, 0],
          [288, 0],
        ]),
        door('extension#2', 'extension#1'),
        opening(
          'extension#3',
          'extension#1',
          { kind: 'opening' },
          { position: 150, width: 60, height: 60, sill: 12 },
        ),
        opening(
          'extension#4',
          'extension#1',
          { kind: 'window', header: { kind: 'default' } },
          { position: 240, width: 24, height: 36, sill: 40 },
        ),
      ),
      {
        type: 'setDomainData',
        namespace: 'construction',
        schemaVersion: 1,
        data: {
          ...CONSTRUCTION,
          headerRules: [{ maxWidth: ins(48), header: { stock: 'us-2x10', plies: 2, jacks: 2 } }],
        },
      },
    );
    const result = await regen(engine, doc);
    expectOk(result, 'extension#1', 'extension#2', 'extension#3', 'extension#4');
    expect(setOf(result, 'extension#1').metadata).toMatchObject({
      openings: [
        { id: 'extension#2', header: { source: 'rule', rule: 0, stock: '2x10', jacks: 2 } },
        { id: 'extension#3', header: { source: 'default', stock: '2x8' } },
        { id: 'extension#4', header: { source: 'default', stock: '2x8', jacks: 1 } },
      ],
    });
    // The 60" opening is wider than every rule: a layout warning on the opening itself.
    expect(feature(result, 'extension#3').warnings).toEqual([
      expect.objectContaining({
        code: 'members',
        domainCode: 'no-header-rule',
        group: 'extension#1',
      }),
    ]);
    expect(feature(result, 'extension#4').warnings).toEqual([]);
    for (const f of result.parts[0]!.features) {
      for (const w of f.warnings) expect(w.message).not.toMatch(/\b(safe|compliant|OK|passes)\b/);
    }
    await done(engine);
  });

  it('applies per-member overrides of the wall and of its openings, and reports lost ones', async () => {
    const engine = engineFor();
    const doc = building(
      wall(
        'extension#1',
        [
          [0, 0],
          [192, 0],
        ],
        {
          overrides: [
            { id: 's10', delete: true },
            { id: 's11' },
            { id: 's40', delete: true },
            { id: 's12', stock: 'us-2x6' },
          ],
        },
        { move_2: ins(2) },
      ),
      opening(
        'extension#2',
        'extension#1',
        { kind: 'door', overrides: [{ id: 'king-l', stock: 'us-2x6' }] },
        { position: 48, width: 36, height: 80 },
      ),
    );
    const result = await regen(engine, doc);
    expectOk(result, 'extension#1', 'extension#2');
    const members = membersOf(result, 'extension#1');
    expect(ids(members, 'extension#1')).not.toContain('s10');
    expect(byId(members, 'extension#1:s11').placement.origin[0]).toBeCloseTo(
      inch(176 - 0.75 + 2),
      6,
    );
    expect(byId(members, 'extension#1:s12').stock.id).toBe('us-2x6');
    expect(byId(members, 'extension#2:king-l').stock.id).toBe('us-2x6');
    expect(setOf(result, 'extension#1').metadata).toMatchObject({
      overrides: expect.arrayContaining([
        { owner: 'extension#1', id: 's40', status: 'lost' },
        { owner: 'extension#2', id: 'king-l', status: 'applied' },
      ]),
    });
    expect(feature(result, 'extension#1').warnings).toEqual([
      expect.objectContaining({ domainCode: 'override-lost', member: 'extension#1:s40' }),
    ]);
    await done(engine);
  });

  it('refuses a wall past the member budget fast, as an error on the wall', async () => {
    // The review's case through regen: 64 points, the long runs 99 m, studs at 2", 20 blocking
    // rows. Framing only (no operation), so no layer bodies. Built in full it was 2.6 million
    // members and 6.5 s before regen's cap refused it.
    const run = 3900;
    const points = Array.from({ length: 64 }, (_, i): [number, number] => [
      Math.floor((i + 1) / 2) % 2 === 1 ? run : 0,
      Math.floor(i / 2) * 100,
    ]);
    const framingOnly = wall('extension#1', points, {}, { spacing: ins(2) });
    delete framingOnly.operation;
    const heights = Array.from({ length: 20 }, (_, r) => ins(8 + 4 * r));
    const doc = apply(building(framingOnly), {
      type: 'setDomainData',
      namespace: 'construction',
      schemaVersion: 1,
      data: { ...CONSTRUCTION, framing: { blocking: { kind: 'heights', heights } } },
    });
    const engine = engineFor();
    const t0 = performance.now();
    const result = await regen(engine, doc);
    const elapsed = performance.now() - t0;
    expect(feature(result, 'extension#1').status).toBe('error');
    expect(feature(result, 'extension#1').errors[0]!.message).toMatch(
      /The wall would have more than 50000 members/,
    );
    expect(elapsed).toBeLessThan(1000);
    await done(engine);
  });

  it('frames a wall at the coordinate limit, and refuses one past it with a clear message', async () => {
    const engine = engineFor();
    const edge = Math.floor(MAX_COORDINATE / inch(1)); // 19,685 in, 499.999 m
    const near = await regen(
      engine,
      building(
        wall('extension#1', [
          [edge - 192, -edge],
          [edge, -edge],
        ]),
      ),
    );
    expectOk(near, 'extension#1');
    expect(membersOf(near, 'extension#1').length).toBe(16);
    const past = await regen(
      engine,
      building(
        wall('extension#1', [
          [edge - 192, 0],
          [edge + 1, 0],
        ]),
      ),
    );
    expect(feature(past, 'extension#1').status).toBe('error');
    expect(feature(past, 'extension#1').errors[0]!.message).toMatch(
      /point 2 is more than 500 m from the origin/,
    );
    await done(engine);
  });

  it('refuses what it cannot build, with the field at fault', async () => {
    const engine = engineFor();
    const cases: [ExtensionFeature, RegExp, string][] = [
      [
        wall(
          'extension#1',
          [
            [0, 0],
            [192, 0],
          ],
          { level: 'level-9' },
        ),
        /no level "level-9"/,
        'params',
      ],
      [
        wall(
          'extension#1',
          [
            [0, 0],
            [192, 0],
          ],
          { wallType: 'int' },
        ),
        /no wall type "int"/,
        'params',
      ],
      [
        wall('extension#1', [
          [0, 0],
          [5000, 0],
        ]),
        /longer than 100 m/,
        'expressions',
      ],
      [
        wall(
          'extension#1',
          [
            [0, 0],
            [192, 0],
          ],
          {},
          { spacing: ins(1) },
        ),
        /spacing must be at least 50 mm/,
        'expressions',
      ],
      [
        {
          ...wall('extension#1', [
            [0, 0],
            [192, 0],
          ]),
          operation: 'add',
        },
        /operation is "new" or none/,
        'operation',
      ],
    ];
    for (const [f, message, field] of cases) {
      const r = await regen(engine, building(f));
      expect(feature(r, 'extension#1').status).toBe('error');
      const error = feature(r, 'extension#1').errors[0]!;
      expect('field' in error ? error.field?.[0] : undefined).toBe(field);
      expect(feature(r, 'extension#1').errors[0]!.message).toMatch(message);
    }
    await done(engine);
  });
});
