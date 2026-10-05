// Layer joins between separate walls (a T6.1b follow-up): the later wall, which names the earlier in
// its dependsOn, mitres their layers at an L and butts them at a tee. Detection without a kernel,
// then volumes through regen with the real kernel: every layer body exact, no two overlapping
// (their fuse is as big as their sum), and a shed of four walls identical to one closed wall.

import {
  applyCommand,
  createDocument,
  type ExtensionFeature,
  type Feature,
  type ManufaktureDocument,
  type MirrorFeature,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenResult } from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConstruction } from '../domain';
import { DOUBLE_2X8, S2X4, inch } from '../test-helpers';
import type { WallMetadata } from './common';
import { MAX_LAYER_JOIN_WALLS, layerJoins, type GraphWall } from './graph';
import { layerArea } from './wall';

const PART = 'part#1';
const HEIGHT = inch(97.125);
const OSB = inch(7 / 16);
const GYP = 12.7;
const STUD = inch(3.5);

// Detection ---------------------------------------------------------------------------------------

function meta(points: [number, number][], extra: Partial<WallMetadata> = {}): WallMetadata {
  return {
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: HEIGHT,
    points,
    closed: false,
    justification: 'left',
    thickness: STUD,
    free: { start: false, end: false },
    layers: [],
    settings: { studStock: S2X4, defaultHeader: DOUBLE_2X8 },
    overrides: [],
    ...extra,
  };
}

const gw = (id: string, points: [number, number][], extra: Partial<WallMetadata> = {}) =>
  ({ id, meta: meta(points, extra) }) satisfies GraphWall;

const kinds = (self: GraphWall, upstream: GraphWall[]) =>
  layerJoins(self, upstream).map((j) => [j.kind, j.other.id]);

describe('layer join detection', () => {
  const a = gw('extension#1', [
    [0, 0],
    [1000, 0],
  ]);

  it('finds an L, a tee as the branch and a tee as the host', () => {
    const corner = gw('extension#2', [
      [1000, 0],
      [1000, 800],
    ]);
    expect(layerJoins(corner, [a])).toMatchObject([
      { kind: 'corner', end: 'start', otherEnd: 'end', other: { id: 'extension#1' } },
    ]);
    const branch = gw('extension#2', [
      [400, 0],
      [400, 800],
    ]);
    expect(layerJoins(branch, [a])).toMatchObject([{ kind: 'branch', end: 'start', segment: 0 }]);
    // The earlier wall ends on this one: this one hosts the tee.
    const host = gw('extension#3', [
      [-200, 800],
      [800, 800],
    ]);
    expect(layerJoins(host, [branch])).toMatchObject([
      { kind: 'host', otherEnd: 'end', segment: 0, other: { id: 'extension#2' } },
    ]);
  });

  it('joins nothing the wall graph leaves free', () => {
    const b = gw('extension#2', [
      [1000, 0],
      [1000, 800],
    ]);
    // An end set free, another level, collinear walls, three ends at a point, a corner point.
    expect(
      kinds(
        gw(
          'extension#3',
          [
            [1000, 0],
            [1000, 800],
          ],
          { free: { start: true, end: false } },
        ),
        [a],
      ),
    ).toEqual([]);
    expect(
      kinds(
        gw(
          'extension#3',
          [
            [1000, 0],
            [1000, 800],
          ],
          { level: 'level-2' },
        ),
        [a],
      ),
    ).toEqual([]);
    expect(
      kinds(
        gw('extension#3', [
          [1000, 0],
          [2000, 0],
        ]),
        [a],
      ),
    ).toEqual([]);
    expect(
      kinds(
        gw('extension#3', [
          [1000, 0],
          [1800, -600],
        ]),
        [a, b],
      ),
    ).toEqual([]);
    const bent = gw('extension#4', [
      [0, 2000],
      [1000, 2000],
      [1000, 3000],
    ]);
    expect(
      kinds(
        gw('extension#5', [
          [1000, 2000],
          [2000, 2000],
        ]),
        [bent],
      ),
    ).toEqual([]);
    // A wall that does not name the other (not upstream) sees nothing.
    expect(kinds(b, [])).toEqual([]);
  });

  it(`refuses more than ${MAX_LAYER_JOIN_WALLS} walls, so the search stays bounded`, () => {
    const many = Array.from({ length: MAX_LAYER_JOIN_WALLS + 1 }, (_, i) =>
      gw(`extension#${i + 10}`, [
        [0, 1000 * (i + 1)],
        [500, 1000 * (i + 1)],
      ]),
    );
    expect(() => layerJoins(a, many)).toThrow(/at most 64/);
    expect(layerJoins(a, many.slice(1))).toEqual([]);
  });
});

// Through regen -------------------------------------------------------------------------------

const ins = (v: number) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});
const mm = (v: number) => ({
  source: String(v),
  lengthUnit: 'mm' as const,
  angleUnit: 'deg' as const,
});

/** Two levels at the datum (the second holds reference walls the first's never meet). */
const CONSTRUCTION = {
  levels: [
    { id: 'level-1', name: 'Level 1', elevation: ins(0), height: ins(97.125) },
    { id: 'level-2', name: 'Reference', elevation: ins(0), height: ins(97.125) },
  ],
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

/** A wall through `points` (mm), naming `dependsOn`. */
function wall(
  id: string,
  points: readonly (readonly [number, number])[],
  dependsOn: string[] = [],
  params: Record<string, unknown> = {},
): ExtensionFeature {
  const exprs: Record<string, StoredExpression> = {};
  points.forEach(([x, y], i) => {
    exprs[`x${i + 1}`] = mm(x);
    exprs[`y${i + 1}`] = mm(y);
  });
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'construction.wall',
    schemaVersion: 1,
    dependsOn,
    references: [],
    expressions: exprs,
    params: {
      level: 'level-1',
      wallType: 'ext-2x4',
      points: points.length,
      ...params,
    } as ExtensionFeature['params'],
    operation: 'new',
  };
}

function building(...features: Feature[]): ManufaktureDocument {
  let doc = createDocument({ id: 'doc-1', name: 'Joins' });
  for (const c of [
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    ...features.map((feature) => ({ type: 'addFeature', partId: PART, feature })),
  ] as const) {
    const r = applyCommand(doc, c as Parameters<typeof applyCommand>[1]);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

function engineFor(): RegenEngine {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({
    kernel: service,
    solver: {
      solve: () => {
        throw new Error('no sketches here');
      },
    },
    extensions,
  });
}

async function regenAny(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const result = await regenAny(engine, doc);
  for (const f of result.parts[0]!.features) {
    expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
  }
  return result;
}

async function done(engine: RegenEngine) {
  await engine.dispose();
  await service.idle();
  expect(service.leaks()).toEqual([]);
}

function shape(result: RegenResult, id: string): ShapeId {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id);
  expect(body, `body ${id}`).toBeDefined();
  return body!.shape;
}

/** Volumes of the bodies, their fuse and (with `ref`) what each of fuse and ref has beyond the other. */
async function measure(
  engine: RegenEngine,
  shapes: readonly ShapeId[],
  ref?: ShapeId,
): Promise<{ each: number[]; fused: number; extra?: number; missing?: number }> {
  const ops: object[] = [
    ...shapes.map((shape) => ({ op: 'properties', shape })),
    {
      op: 'boolean',
      kind: 'fuse',
      shape: shapes[0],
      tools: shapes.slice(1),
      keep: false,
    },
  ];
  const fuse = shapes.length;
  ops.push({ op: 'properties', shape: { result: fuse } });
  if (ref !== undefined) {
    ops.push(
      { op: 'boolean', kind: 'cut', shape: { result: fuse }, tools: [ref], keep: false },
      { op: 'properties', shape: { result: fuse + 2 } },
      { op: 'boolean', kind: 'cut', shape: ref, tools: [{ result: fuse }], keep: false },
      { op: 'properties', shape: { result: fuse + 4 } },
    );
  }
  const reply = await service.run({
    generation: engine.generation,
    ops: ops as Parameters<KernelService['run']>[0]['ops'],
  });
  const vol = (i: number) => {
    const r = reply.results[i]!;
    if (!r.ok) throw new Error(r.error.message);
    return (r.value as { volume: number }).volume;
  };
  return {
    each: shapes.map((_, i) => vol(i)),
    fused: vol(fuse + 1),
    ...(ref === undefined ? {} : { extra: vol(fuse + 3), missing: vol(fuse + 5) }),
  };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
/** Volumes agree to 1e-6 relative (or 0.001 mm3), far below any layer's slice. */
const close = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(Math.max(1e-6 * Math.abs(expected), 1e-3));

const L1 = inch(192);
const L2 = inch(144);

describe('layer joins through regen with the real kernel', () => {
  it('mitres two walls at an L exactly as one path with that corner', async () => {
    const engine = engineFor();
    const result = await regen(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [L1, 0],
        ]),
        wall(
          'extension#2',
          [
            [L1, 0],
            [L1, L2],
          ],
          ['extension#1'],
        ),
      ),
    );
    // Each wall's layer ends on the corner's bisector: the sheathing outside gains half the
    // mitre's square, the drywall inside loses half of its.
    const sheathing = await measure(engine, [
      shape(result, 'extension#1:layer/sheathing'),
      shape(result, 'extension#2:layer/sheathing'),
    ]);
    close(sheathing.each[0]!, (OSB * L1 + (OSB * OSB) / 2) * HEIGHT);
    close(sheathing.each[1]!, (OSB * L2 + (OSB * OSB) / 2) * HEIGHT);
    close(sheathing.fused, sum(sheathing.each));
    const lPath: [number, number][] = [
      [0, 0],
      [L1, 0],
      [L1, L2],
    ];
    close(sheathing.fused, layerArea(lPath, false, -OSB, 0) * HEIGHT);
    const inner = ((STUD + GYP) ** 2 - STUD ** 2) / 2;
    const drywall = await measure(engine, [
      shape(result, 'extension#1:layer/drywall'),
      shape(result, 'extension#2:layer/drywall'),
    ]);
    close(drywall.each[0]!, (GYP * L1 - inner) * HEIGHT);
    close(drywall.each[1]!, (GYP * L2 - inner) * HEIGHT);
    close(drywall.fused, sum(drywall.each));
    close(drywall.fused, layerArea(lPath, false, STUD, STUD + GYP) * HEIGHT);
    // The layer faces keep their names; the earlier wall's joined end is the later one's cut.
    expect(result.names).toEqual(
      expect.arrayContaining([
        'extension#1:side:sheathing.ext1',
        'extension#1:side:drywall.int1',
        'extension#2:side:sheathing.start',
        'extension#2:side:drywall.ext1',
        'extension#2:start-trim-drywall:ymin',
      ]),
    );
    await done(engine);
  });

  it('keeps layer face references exact across a join, as the walls lengthen', async () => {
    const engine = engineFor();
    // A mirror of each wall's sheathing in its own exterior face: the faces are its references.
    const mirror = (id: string, wallId: string, ref: string): MirrorFeature => ({
      id,
      kind: 'mirror',
      name: id,
      suppressed: false,
      features: [],
      body: true,
      scope: [`${wallId}:layer/sheathing`],
      mode: 'new',
      plane: { id: ref, ref: { face: `${wallId}:side:sheathing.ext1` } },
    });
    const docOf = (length: number) =>
      building(
        wall('extension#1', [
          [0, 0],
          [length, 0],
        ]),
        wall(
          'extension#2',
          [
            [length, 0],
            [length, L2],
          ],
          ['extension#1'],
        ),
        mirror('mirror#1', 'extension#1', 'r1'),
        mirror('mirror#2', 'extension#2', 'r2'),
      );
    for (const length of [L1, inch(240)]) {
      const result = await regen(engine, docOf(length));
      for (const [id, wallId, ref] of [
        ['mirror#1', 'extension#1', 'r1'],
        ['mirror#2', 'extension#2', 'r2'],
      ] as const) {
        const f = result.parts[0]!.features.find((x) => x.featureId === id)!;
        expect(f.references).toEqual([
          {
            referenceId: ref,
            target: `${wallId}:side:sheathing.ext1`,
            via: 'exact',
            fragile: false,
          },
        ]);
      }
    }
    await done(engine);
  });

  it.each([60, 120])(
    'mitres an L at %d degrees with no gap or overlap',
    async (deg) => {
      const engine = engineFor();
      const a = (deg * Math.PI) / 180;
      // The second wall turns left by 180 - deg degrees: the walls meet at `deg` inside.
      const turn = Math.PI - a;
      const end: [number, number] = [L1 + L2 * Math.cos(turn), L2 * Math.sin(turn)];
      const result = await regen(
        engine,
        building(
          wall('extension#1', [
            [0, 0],
            [L1, 0],
          ]),
          wall('extension#2', [[L1, 0], end], ['extension#1']),
        ),
      );
      const path: [number, number][] = [[0, 0], [L1, 0], end];
      for (const [layer, lo, hi] of [
        ['sheathing', -OSB, 0],
        ['drywall', STUD, STUD + GYP],
      ] as const) {
        const m = await measure(engine, [
          shape(result, `extension#1:layer/${layer}`),
          shape(result, `extension#2:layer/${layer}`),
        ]);
        close(m.fused, sum(m.each));
        close(m.fused, layerArea(path, false, lo, hi) * HEIGHT);
      }
      await done(engine);
    },
    30_000,
  );

  // The tee of regen.test.ts: a wall up +y from x = 100" on a 16' wall, framed right of its path.
  const host = () =>
    wall('extension#1', [
      [0, 0],
      [L1, 0],
    ]);
  const branch = (deps: string[] = []) =>
    wall(
      'extension#2',
      [
        [inch(100), 0],
        [inch(100), inch(120)],
      ],
      deps,
      { justification: 'right' },
    );

  /** The tee's volumes: the host's drywall notched for the branch's studs, the branch butting it. */
  async function teeVolumes(engine: RegenEngine, result: RegenResult, h: string, b: string) {
    const bodies = [
      `${h}:layer/sheathing`,
      `${h}:layer/drywall`,
      `${b}:layer/sheathing`,
      `${b}:layer/drywall`,
    ].map((id) => shape(result, id));
    const m = await measure(engine, bodies);
    const run = inch(120) - (STUD + GYP);
    close(m.each[0]!, L1 * OSB * HEIGHT);
    close(m.each[1]!, (L1 - STUD) * GYP * HEIGHT);
    close(m.each[2]!, run * OSB * HEIGHT);
    close(m.each[3]!, run * GYP * HEIGHT);
    close(m.fused, sum(m.each));
  }

  it('butts a tee: the branch stops at the host drywall, which is notched for its studs', async () => {
    const engine = engineFor();
    const result = await regen(engine, building(host(), branch(['extension#1'])));
    await teeVolumes(engine, result, 'extension#1', 'extension#2');
    expect(result.names).toEqual(
      expect.arrayContaining([
        'extension#2:start-notch-drywall:ymin',
        'extension#2:side:drywall.start',
      ]),
    );
    await done(engine);
  });

  it('joins a tee the same way when the host is the later wall', async () => {
    const engine = engineFor();
    const earlier = wall(
      'extension#1',
      [
        [inch(100), 0],
        [inch(100), inch(120)],
      ],
      [],
      { justification: 'right' },
    );
    const later = wall(
      'extension#2',
      [
        [0, 0],
        [L1, 0],
      ],
      ['extension#1'],
    );
    const result = await regen(engine, building(earlier, later));
    await teeVolumes(engine, result, 'extension#2', 'extension#1');
    expect(result.names).toEqual(
      expect.arrayContaining([
        'extension#2:tee1-notch-drywall:ymin',
        'extension#2:tee1-trim-drywall:ymin',
      ]),
    );
    await done(engine);
  });

  it('butts a tee at 60 degrees and one from the exterior side', async () => {
    const engine = engineFor();
    const a = Math.PI / 3;
    const len = inch(120);
    const result = await regen(
      engine,
      building(
        host(),
        wall(
          'extension#2',
          [
            [inch(60), 0],
            [inch(60) + len * Math.cos(a), len * Math.sin(a)],
          ],
          ['extension#1'],
        ),
        // From the exterior: down -y, so it stops at the sheathing's outer face.
        wall(
          'extension#3',
          [
            [inch(150), 0],
            [inch(150), -len],
          ],
          ['extension#1'],
        ),
      ),
    );
    const ids = ['extension#1', 'extension#2', 'extension#3'].flatMap((w) => [
      `${w}:layer/sheathing`,
      `${w}:layer/drywall`,
    ]);
    const m = await measure(
      engine,
      ids.map((id) => shape(result, id)),
    );
    close(m.fused, sum(m.each));
    // A band [t0, t1] of a wall at angle a, from the host's face line y = F to its far end.
    const band = (t0: number, t1: number, F: number, c: number, s: number) =>
      ((t1 - t0) * len - (F * (t1 - t0) - (c * (t1 * t1 - t0 * t0)) / 2) / s) * HEIGHT;
    const F = STUD + GYP;
    close(m.each[2]!, band(-OSB, 0, F, Math.cos(a), Math.sin(a)));
    close(m.each[3]!, band(STUD, STUD + GYP, F, Math.cos(a), Math.sin(a)));
    // The exterior branch: a wall running -y has its left (interior) toward +x, and the host's
    // stack face on its side is the sheathing's outer face, OSB below the path.
    const down = len - OSB;
    close(m.each[4]!, down * OSB * HEIGHT);
    close(m.each[5]!, down * GYP * HEIGHT);
    // The host: its drywall notched across the 60-degree wall's studs (a band STUD wide across
    // that wall is STUD / sin(a) along the host); its sheathing across the other's.
    close(m.each[1]!, (L1 - STUD / Math.sin(a)) * GYP * HEIGHT);
    close(m.each[0]!, (L1 - STUD) * OSB * HEIGHT);
    await done(engine);
  });

  it('joins a 12 x 16 ft shed of four walls into exactly one closed wall', async () => {
    const engine = engineFor();
    // Each wall names the one before it; the last names the first too, so all four corners join.
    const corners: [number, number][] = [
      [0, 0],
      [L1, 0],
      [L1, L2],
      [0, L2],
    ];
    const reference = wall('extension#9', corners, [], { level: 'level-2', closed: true });
    const result = await regen(
      engine,
      building(
        wall('extension#1', [corners[0]!, corners[1]!]),
        wall('extension#2', [corners[1]!, corners[2]!], ['extension#1']),
        wall('extension#3', [corners[2]!, corners[3]!], ['extension#2']),
        wall('extension#4', [corners[3]!, corners[0]!], ['extension#3', 'extension#1']),
        reference,
      ),
    );
    const walls = ['extension#1', 'extension#2', 'extension#3', 'extension#4'];
    const lengths = [L1, L2, L1, L2];
    for (const [layer, lo, hi] of [
      ['sheathing', -OSB, 0],
      ['drywall', STUD, STUD + GYP],
    ] as const) {
      const m = await measure(
        engine,
        walls.map((w) => shape(result, `${w}:layer/${layer}`)),
        shape(result, `extension#9:layer/${layer}`),
      );
      // Each wall's band, mitred at both ends: outside it gains lo^2 / 2 per end, inside it
      // loses (hi^2 - lo^2) / 2 per end.
      m.each.forEach((v, i) => close(v, ((hi - lo) * lengths[i]! - (hi * hi - lo * lo)) * HEIGHT));
      close(m.fused, sum(m.each));
      close(m.fused, layerArea(corners, true, lo, hi) * HEIGHT);
      // Nothing of the four walls outside the closed one, nothing of it outside them.
      expect(m.extra!).toBeLessThan(1e-3);
      expect(m.missing!).toBeLessThan(1e-3);
    }
    // The framing is the four-wall pinwheel as before: through walls by feature number.
    const sets = result.parts[0]!.members ?? [];
    expect(sets.map((s) => s.group).sort()).toEqual([...walls, 'extension#9'].sort());
    await done(engine);
  }, 60_000);

  it('refuses to join walls meeting at too sharp an angle, naming the wall to take out', async () => {
    const engine = engineFor();
    // 20 degrees between the walls: the mitre would run far past the corner.
    const a = (20 * Math.PI) / 180;
    const result = await regenAny(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [L1, 0],
        ]),
        wall(
          'extension#2',
          [
            [L1, 0],
            [L1 - L2 * Math.cos(a), L2 * Math.sin(a)],
          ],
          ['extension#1'],
        ),
      ),
    );
    const f = result.parts[0]!.features.find((x) => x.featureId === 'extension#2')!;
    expect(f.status).toBe('error');
    expect(f.errors[0]).toMatchObject({ field: ['dependsOn'] });
    expect(f.errors[0]!.message).toMatch(/too sharp an angle .* take extension#1 out of dependsOn/);
    await done(engine);
  });

  it('refuses a wall too short for the mitre its join needs', async () => {
    const engine = engineFor();
    // 20 mm long: its drywall, 89 to 102 mm in from the corner, cannot reach the mitre.
    const result = await regenAny(
      engine,
      building(
        wall('extension#1', [
          [0, 0],
          [L1, 0],
        ]),
        wall(
          'extension#2',
          [
            [L1, 0],
            [L1, 20],
          ],
          ['extension#1'],
        ),
      ),
    );
    const f = result.parts[0]!.features.find((x) => x.featureId === 'extension#2')!;
    expect(f.status).toBe('error');
    expect(f.errors[0]!.message).toMatch(/too short for the corners and joins of layer "drywall"/);
    await done(engine);
  });

  it('refuses to cut away a very short earlier wall with a long mitre', async () => {
    const engine = engineFor();
    // The earlier wall is 50 mm long; the later one's mitre would cut its drywall past its start.
    const result = await regenAny(
      engine,
      building(
        wall('extension#1', [
          [L1 - 50, 0],
          [L1, 0],
        ]),
        wall(
          'extension#2',
          [
            [L1, 0],
            [L1, L2],
          ],
          ['extension#1'],
        ),
      ),
    );
    const f = result.parts[0]!.features.find((x) => x.featureId === 'extension#2')!;
    expect(f.status).toBe('error');
    expect(f.errors[0]).toMatchObject({ field: ['dependsOn'] });
    expect(f.errors[0]!.message).toMatch(/extension#1's last segment is too short/);
    await done(engine);
  });
});
