// The read queries on the cabinet (M4) and the shed (M6), and reference imports on the bracket:
// tree, object, schema, findGeometry, measure (bodies, targets, clearance, interference at
// poses), quantities as data marked unreviewed, errors and history.

import { applyCommand, type ManufaktureDocument } from '@manufakture/core';
import { importSource, writeBinaryStl } from '@manufakture/io';
import { createNodeService } from '@manufakture/kernel/node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Session } from './session';
import { CABINET, PART, bracketDocument, cabinetDocument, shedDocument } from './test/fixtures';
import { ok, seeded, type Seeded } from './test/setup';

const open: Session[] = [];
let seed: Seeded;

async function start(doc: ManufaktureDocument): Promise<Session> {
  seed = await seeded(doc);
  const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Test' }));
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const inch = (x: number) => x * 25.4;

describe('the cabinet', () => {
  it('outlines the document and gives each object as JSON', async () => {
    const s = await start(cabinetDocument());
    const tree = ok(await s.tree());
    const part = tree.parts[0]!;
    expect(part.features).toHaveLength(20);
    expect(part.features.every((f) => f.status === 'ok')).toBe(true);
    expect(part.features.find((f) => f.id === 'extension#1')).toMatchObject({
      kind: 'extension:wood.board',
      name: 'Left side',
    });
    expect(part.bodies).toHaveLength(6);
    const feature = ok(await s.object({ kind: 'feature', partId: PART, featureId: 'extension#7' }));
    expect(feature).toMatchObject({ kind: 'extension', extension: 'wood.joint' });
    expect(await s.object({ kind: 'feature', partId: PART, featureId: 'extension#99' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'not-found' }),
    });
    expect(await s.object({ kind: 'nonsense' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-input' }),
    });
    expect(ok(await s.object({ kind: 'document' }))).toMatchObject({ parts: [PART] });
  });

  it('finds faces by plane and position, and measures between them', async () => {
    const s = await start(cabinetDocument());
    // The left side's outer face: normal -X, at x = 0.
    const outer = ok(
      await s.findGeometry({ normal: [-1, 0, 0], nearest: [0, 143, 381], limit: 3 }),
    );
    expect(outer[0]!.centroid![0]).toBeCloseTo(0, 6);
    expect(outer[0]!.name).not.toBeNull();
    const body = outer[0]!.bodyId;
    // The same side's inner face is a ply thickness away, parallel.
    const inner = ok(await s.findGeometry({ bodyId: body, normal: [1, 0, 0] }));
    expect(inner.length).toBeGreaterThan(0);
    const m = ok(
      await s.measure({
        kind: 'targets',
        partId: PART,
        bodyId: body,
        targets: [
          { kind: 'face', name: outer[0]!.name },
          {
            kind: 'face',
            index: inner.sort((a, b) => a.centroid![0] - b.centroid![0]).at(-1)!.index,
          },
        ],
      }),
    ) as { distance: { value: number }; angle: { value: number } };
    expect(m.distance.value).toBeCloseTo(inch(CABINET.ply), 6);
    expect(m.angle.value).toBeCloseTo(0, 9);
  });

  it('gives the cut list and hardware as data, marked unreviewed', async () => {
    const s = await start(cabinetDocument());
    const q = ok(await s.quantities());
    expect(q.reviewed).toBe(false);
    expect(q.cutList).not.toBeNull();
    expect(q.cutList!.rows.length).toBeGreaterThan(0);
    expect(q.takeoffs).toEqual([]);
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });

  it('measures clearance between two boards, and their overlap when one is moved into the other', async () => {
    const s = await start(cabinetDocument());
    const tree = ok(await s.tree());
    const [left, right] = tree.parts[0]!.bodies;
    const apart = ok(
      await s.measure({
        kind: 'clearance',
        bodies: [
          { partId: PART, bodyId: left!.bodyId },
          { partId: PART, bodyId: right!.bodyId },
        ],
      }),
    ) as { pairs: unknown[]; gaps: { boxGap: number }[] };
    expect(apart.pairs).toEqual([]);
    expect(apart.gaps[0]!.boxGap).toBeCloseTo(inch(CABINET.width - 2 * CABINET.ply), 3);
    const moved = ok(
      await s.measure({
        kind: 'clearance',
        bodies: [
          { partId: PART, bodyId: left!.bodyId },
          {
            partId: PART,
            bodyId: right!.bodyId,
            placement: {
              translation: [-inch(CABINET.width - CABINET.ply), 0, 0],
              rotation: [0, 0, 0, 1],
            },
          },
        ],
      }),
    ) as { pairs: { volume: number }[] };
    expect(moved.pairs).toHaveLength(1);
    expect(moved.pairs[0]!.volume).toBeGreaterThan(0);
  });
});

describe('assemblies', () => {
  it('checks interference at the solved poses and at given ones, ids made by symbols', async () => {
    const s = await start(bracketDocument());
    const pose = (x: number) => ({ translation: [x, 0, 0], rotation: [0, 0, 0, 1] });
    const instance = (id: string, x: number) => ({
      type: 'addInstance',
      assemblyId: 'assembly#$a',
      instance: {
        id,
        name: id,
        source: { part: PART },
        fixed: true,
        suppressed: false,
        pose: pose(x),
      },
    });
    const r = ok(
      await s.apply({
        label: 'Two brackets',
        commands: [
          { type: 'addAssembly', assemblyId: 'assembly#$a', name: 'Pair' },
          instance('inst#$one', 0),
          instance('inst#$two', 10),
        ],
      }),
    );
    expect(r.symbols).toEqual({ $a: 'assembly#1', $one: 'inst#1', $two: 'inst#2' });
    const at = ok(await s.measure({ kind: 'interference', assemblyId: 'assembly#1' })) as {
      instances: string[];
      pairs: { a: string; b: string; volume: number }[];
    };
    expect(at.instances).toEqual(['inst#1', 'inst#2']);
    expect(at.pairs).toHaveLength(1);
    expect(at.pairs[0]).toMatchObject({ a: 'inst#1', b: 'inst#2' });
    expect(at.pairs[0]!.volume).toBeGreaterThan(0);
    const apart = ok(
      await s.measure({
        kind: 'interference',
        assemblyId: 'assembly#1',
        poses: { 'inst#2': pose(200) },
      }),
    ) as { pairs: unknown[] };
    expect(apart.pairs).toEqual([]);
    const tree = ok(await s.tree());
    expect(tree.assemblies[0]!.instances.map((i) => i.id)).toEqual(['inst#1', 'inst#2']);
  });
});

describe('the shed', () => {
  it('gives the takeoff of its framing as data', async () => {
    const s = await start(shedDocument());
    const q = ok(await s.quantities());
    expect(q.reviewed).toBe(false);
    expect(q.takeoffs).toHaveLength(1);
    expect(q.takeoffs[0]!.partId).toBe(PART);
    expect(JSON.stringify(q.takeoffs[0]!.takeoff)).toContain('us-2x4');
    expect(ok(await s.errors())).toEqual([]);
  });

  it('moves a window and reports the walls that changed', async () => {
    const s = await start(shedDocument());
    const window = s.document.parts[0]!.features.find((f) => f.id === 'extension#5')!;
    const r = ok(
      await s.apply({
        label: 'Move window 1',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...window,
              expressions: {
                ...(window as { expressions: Record<string, unknown> }).expressions,
                position: { source: '60', lengthUnit: 'in', angleUnit: 'deg' },
              },
            },
          },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.measured.length).toBeGreaterThan(0);
    const q = ok(await s.quantities());
    expect(q.takeoffs).toHaveLength(1);
  });
});

describe('reference imports', () => {
  const service = createNodeService();
  afterAll(async () => {
    void (await service);
  });

  /** A 10 mm cube as STEP bytes, from the kernel. */
  async function cubeStep(): Promise<Uint8Array> {
    const k = await service;
    const reply = await k.run({
      generation: 1,
      ops: [
        { op: 'box', size: [10, 10, 10] },
        { op: 'exportStep', bodies: [{ shape: { result: 0 }, name: 'cube' }] },
      ],
    });
    const r = reply.results[1]!;
    if (!r.ok) throw new Error(r.error.message);
    return (r.value as { data: Uint8Array }).data;
  }

  /** A 20 mm cube as a binary STL. */
  function cubeStl(): Uint8Array {
    const p = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0, 0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 20, 20];
    const t = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ];
    return writeBinaryStl({ positions: new Float32Array(p), indices: new Uint32Array(t) });
  }

  it('reads STEP and STL reference bodies again on open, and measures them', async () => {
    let doc = bracketDocument();
    for (const [i, [format, bytes]] of (
      [
        ['step', await cubeStep()],
        ['stl', cubeStl()],
      ] as const
    ).entries()) {
      const r = applyCommand(doc, {
        type: 'addFeature',
        partId: PART,
        feature: {
          id: `import#${i + 1}`,
          kind: 'import',
          name: `Cube ${format}`,
          suppressed: false,
          source: await importSource(format, `cube.${format}`, bytes),
          operation: 'reference',
        },
      } as never);
      if (!r.ok) throw new Error(r.error.message);
      doc = r.value.document;
    }
    const s = await start(doc);
    const step = ok(await s.measure({ kind: 'body', partId: PART, bodyId: 'import#1' })) as {
      volume: number;
    };
    expect(step.volume).toBeCloseTo(1000, 6);
    const stl = ok(await s.measure({ kind: 'body', partId: PART, bodyId: 'import#2' })) as {
      volume: number;
      mesh: boolean;
    };
    expect(stl).toMatchObject({ mesh: true });
    expect(stl.volume).toBeCloseTo(8000, 3);
    // Removed by a batch: released and gone.
    ok(
      await s.apply({
        label: 'No STEP cube',
        commands: [{ type: 'deleteFeature', partId: PART, featureId: 'import#1' }],
      }),
    );
    expect(await s.measure({ kind: 'body', partId: PART, bodyId: 'import#1' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'not-found' }),
    });
  });
});

describe('schemas', () => {
  it('gives every command type and feature kind a JSON Schema with its doc comments', async () => {
    const s = await start(bracketDocument());
    const index = s.schemaIndex();
    expect(index.commands).toContain('batch');
    expect(index.features).toContain('extrude');
    for (const command of index.commands) {
      const schema = ok(await s.schema({ command })) as { type?: string; properties?: object };
      expect(schema.properties, command).toBeDefined();
    }
    for (const feature of index.features) ok(await s.schema({ feature }));
    const add = ok(await s.schema({ command: 'addFeature' })) as { description: string };
    expect(add.description).toMatch(/^Insert a new feature/);
    const extrude = ok(await s.schema({ feature: 'extrude' })) as {
      properties: Record<string, { description?: string }>;
    };
    expect(extrude.properties.reverse!.description).toBe('Extrude against the sketch normal.');
    expect(await s.schema({ command: 'nope' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'not-found' }),
    });
  });
});
