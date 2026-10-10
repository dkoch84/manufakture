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

async function start(
  doc: ManufaktureDocument,
  options: Parameters<typeof seeded>[1] = {},
): Promise<Session> {
  seed = await seeded(doc, options);
  const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Test' }));
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const inch = (x: number) => x * 25.4;

describe('the cabinet', () => {
  it('a measured variable: its value in the outline, a lost face in the errors (#1202)', async () => {
    const s = await start(cabinetDocument());
    const width = (source: string) => ({
      type: 'setVariable' as const,
      name: 'opening',
      expression: { source, lengthUnit: 'in' as const, angleUnit: 'deg' as const },
    });
    // The bottom's top to the shelf's underside: the bottom opening's height.
    const r = ok(
      await s.apply({
        label: 'Measure the opening',
        commands: [width('distance("extension#3:cap:end", "extension#5:cap:start")')],
      }),
    );
    expect(r.errors).toEqual([]);
    const tree = ok(await s.tree());
    const opening = tree.variables.find((v) => v.name === 'opening')!;
    expect(opening.value!.value).toBeCloseTo(inch(14 - 23 / 32), 6);
    expect(opening.error).toBeUndefined();

    const lost = ok(
      await s.apply({
        label: 'Measure a face that is not there',
        commands: [width('distance("extension#3:cap:end", "extension#5:cap:middle")')],
      }),
    );
    const message = '#opening: Face "extension#5:cap:middle" is not found on part#1';
    expect(lost.errors).toEqual([
      { where: 'variable', id: 'opening', severity: 'error', code: 'measure', message },
    ]);
    expect(ok(await s.errors())).toEqual(lost.errors);
    const after = ok(await s.tree()).variables.find((v) => v.name === 'opening')!;
    expect(after).toMatchObject({ value: null, error: message.slice('#opening: '.length) });
  });

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
    // Connector frames are for mates only (the drawer-slides scenario reads a real one).
    expect(ok(await s.mateFrames({ kind: 'document' }))).toBeUndefined();
    expect(
      ok(await s.mateFrames({ kind: 'mate', assemblyId: 'assembly#9', mateId: 'mate#1' })),
    ).toBeUndefined();
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

  it('measures between faces of two bodies of the part: distance and angle', async () => {
    const s = await start(cabinetDocument());
    const left = 'extension#1:cap:end{extension#11:groove:xmin}';
    const right = 'extension#2:cap:start{extension#12:groove:xmin}';
    const m = ok(
      await s.measure({
        kind: 'targets',
        partId: PART,
        bodyId: 'extension#1',
        targets: [
          { kind: 'face', name: left },
          { kind: 'face', name: right, bodyId: 'extension#2' },
        ],
      }),
    ) as {
      items: { ok: boolean; name: string; bodyId: string }[];
      distance: { value: number; planes: number | null };
      angle: { value: number; normals: number; between: string };
    };
    expect(m.items.map((i) => [i.ok, i.name, i.bodyId])).toEqual([
      [true, left, 'extension#1'],
      [true, right, 'extension#2'],
    ]);
    // The sides' inner faces face each other across the cabinet: its width less two sides.
    const width = inch(CABINET.width - 2 * CABINET.ply);
    expect(m.distance.value).toBeCloseTo(width, 6);
    expect(m.distance.planes).toBeCloseTo(width, 6);
    expect(m.angle).toMatchObject({ between: 'planes', value: 0 });
    expect(m.angle.normals).toBeCloseTo(180, 9);
    // The bottom's top against a side: square, in degrees.
    const square = ok(
      await s.measure({
        kind: 'targets',
        partId: PART,
        bodyId: 'extension#3',
        targets: [
          { kind: 'face', name: 'extension#3:cap:end' },
          { kind: 'face', name: left, bodyId: 'extension#1' },
        ],
      }),
    ) as { distance: { planes: number | null }; angle: { value: number } };
    expect(square.angle.value).toBeCloseTo(90, 9);
    expect(square.distance.planes).toBeNull();
    // A body that is not there, and a bodyId that is not a string, are refused.
    const missing = await s.measure({
      kind: 'targets',
      partId: PART,
      bodyId: 'extension#1',
      targets: [
        { kind: 'face', name: left },
        { kind: 'face', name: right, bodyId: 'extension#99' },
      ],
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(JSON.stringify(missing)).toContain('extension#99');
    const bad = await s.measure({
      kind: 'targets',
      partId: PART,
      bodyId: 'extension#1',
      targets: [{ kind: 'face', name: left, bodyId: 2 }],
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
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

describe('interference over a travel', () => {
  const pose = (x: number) => ({ translation: [x, 0, 0], rotation: [0, 0, 0, 1] });
  const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
  // Two brackets on a slider along -X (the normal of the bracket's back face, x = 0), both at the
  // origin: the second slides out of the first. They overlap until 50 mm, the bracket's length.
  interface PairOptions {
    limits?: Record<string, unknown>;
    kind?: 'slider' | 'revolute';
    face?: string;
    /** The connectors' offset translation (mm, along each connector frame's axes). */
    offset?: [number, number, number];
    /** More commands after the mate (a third instance, another mate). */
    more?: Record<string, unknown>[];
    session?: Parameters<typeof seeded>[1];
  }
  const instance = (id: string, fixed: boolean, x = 0) => ({
    type: 'addInstance',
    assemblyId: 'assembly#$a',
    instance: { id, name: id, source: { part: PART }, fixed, suppressed: false, pose: pose(x) },
  });
  async function pair(limits?: Record<string, unknown>, options: PairOptions = {}) {
    const s = await start(bracketDocument(), options.session);
    const offset = options.offset
      ? {
          offset: {
            translation: options.offset.map((v) => mm(`${v}`)),
            rotation: [mm('0'), mm('0'), mm('0')],
          },
        }
      : {};
    const connector = (id: string, instance: string) => ({
      id,
      instance,
      inference: 'centroid',
      origin: { id: `r$ref_${id.slice(4)}`, ref: { face: options.face ?? 'extrude#1:side:e6' } },
      ...offset,
    });
    ok(
      await s.apply({
        label: 'Two brackets on a mate',
        commands: [
          { type: 'addAssembly', assemblyId: 'assembly#$a', name: 'Pair' },
          instance('inst#$one', true),
          instance('inst#$two', false),
          {
            type: 'addMate',
            assemblyId: 'assembly#$a',
            mate: {
              id: 'mate#$slide',
              name: 'Slide',
              kind: options.kind ?? 'slider',
              suppressed: false,
              a: connector('mc#$ca', 'inst#$one'),
              b: connector('mc#$cb', 'inst#$two'),
              ...(limits ? { limits } : {}),
            },
          },
          ...(options.more ?? []),
        ],
      }),
    );
    return s;
  }
  type Sweep = {
    travel: { from: number; to: number; step: number; unit: string };
    values: number[];
    checked: number;
    first: { value: number; pairs: { a: string; b: string; volume: number }[] } | null;
    pairs: unknown[];
    moving: string[];
    staticPairs: { a: string; b: string; volume: number }[];
    colliding: number[];
    warnings: { code: string; bound?: string; values?: number[] }[];
  };
  const sweep = async (s: Session, travel: Record<string, unknown>) =>
    ok(
      await s.measure({ kind: 'interference', assemblyId: 'assembly#1', travel }),
    ) as unknown as Sweep;

  it('sweeps a slider over its limits by default, and from a given end with a given step', async () => {
    const s = await pair({ min: mm('20'), max: mm('100') });
    const all = await sweep(s, { mateId: 'mate#1' });
    expect(all.travel).toMatchObject({ from: 20, to: 100, step: 4, unit: 'mm' });
    expect(all.checked).toBe(21);
    expect(all.first).toEqual({
      value: 20,
      pairs: [{ a: 'inst#1', b: 'inst#2', volume: expect.any(Number) }],
    });
    expect(all.pairs).toEqual(all.first!.pairs);
    // 50 mm is touching, not overlapping.
    expect(all.colliding).toEqual([20, 24, 28, 32, 36, 40, 44, 48]);
    expect(all.warnings).toEqual([]);
    // Closing from the far end: the first value that collides on the way in.
    const closing = await sweep(s, { mateId: 'mate#1', from: 100, to: 20, step: 10 });
    expect(closing.values).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 20]);
    expect(closing.first!.value).toBe(40);
    // A range past the limits is checked, with a warning naming the values.
    const past = await sweep(s, { mateId: 'mate#1', from: 0, to: 20, step: 10 });
    expect(past.checked).toBe(3);
    expect(past.first!.value).toBe(0);
    expect(past.warnings).toEqual([
      expect.objectContaining({ code: 'outside-limits', bound: 'min', limit: 20, values: [0, 10] }),
    ]);
    // A pose by hand past the limit is a warning as well.
    const posed = ok(
      await s.measure({
        kind: 'interference',
        assemblyId: 'assembly#1',
        poses: { 'inst#2': pose(-150) },
      }),
    ) as unknown as Sweep;
    expect(posed.pairs).toEqual([]);
    expect(posed.warnings).toEqual([
      expect.objectContaining({ code: 'outside-limits', bound: 'max', limit: 100, value: 150 }),
    ]);
  });

  it('checks only pairs with a moving instance; the rest once, as staticPairs', async () => {
    // A third bracket, fixed where the first is: the two overlap whatever the slider does.
    const s = await pair(
      { min: mm('60'), max: mm('100') },
      { more: [instance('inst#$three', true)] },
    );
    const r = await sweep(s, { mateId: 'mate#1', step: 20 });
    expect(r.moving).toEqual(['inst#2']);
    expect(r.staticPairs).toEqual([{ a: 'inst#1', b: 'inst#3', volume: expect.any(Number) }]);
    // Past 50 mm the moving bracket is clear of both: the fixed overlap does not count as one.
    expect(r.checked).toBe(3);
    expect(r.first).toBeNull();
    expect(r.pairs).toEqual([]);
  });

  it('stops a sweep that runs past the kernel budget and answers what it checked', async () => {
    const s = await pair(
      { min: mm('0'), max: mm('100') },
      { session: { limits: { kernelMsPerCall: 500 } } },
    );
    const r = await sweep(s, { mateId: 'mate#1', step: 1 });
    expect(r.values).toHaveLength(101);
    expect(r.checked).toBeGreaterThan(0);
    expect(r.checked).toBeLessThan(101);
    expect(r.first!.value).toBe(0);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'truncated', checked: r.checked, values: 101, ms: 500 }),
    ]);
  });

  it('refuses to sweep an assembly whose solve conflicts', async () => {
    // The two brackets also fastened to each other 10 mm apart, both fixed: no solve closes that.
    const s = await pair(
      { min: mm('0'), max: mm('100') },
      {
        more: [
          instance('inst#$three', true, 10),
          {
            type: 'addMate',
            assemblyId: 'assembly#$a',
            mate: {
              id: 'mate#$fix',
              name: 'Fix',
              kind: 'fastened',
              suppressed: false,
              a: {
                id: 'mc#$fa',
                instance: 'inst#$one',
                inference: 'centroid',
                origin: { id: 'r$ref_fa', ref: { face: 'extrude#1:side:e6' } },
              },
              b: {
                id: 'mc#$fb',
                instance: 'inst#$three',
                inference: 'centroid',
                origin: { id: 'r$ref_fb', ref: { face: 'extrude#1:side:e6' } },
              },
            },
          },
        ],
      },
    );
    const r = await s.measure({
      kind: 'interference',
      assemblyId: 'assembly#1',
      travel: { mateId: 'mate#1' },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/last solve is conflicting/);
  });

  it('sweeps a revolute in degrees, with warnings in degrees', async () => {
    // Both connectors on the bracket's foot (normal -Z), moved 100 mm along their frame's x: the
    // second bracket swings about a vertical axis 100 mm off, clear of the first past some angle.
    const s = await pair(
      { min: mm('0 deg'), max: mm('90 deg') },
      { kind: 'revolute', face: 'extrude#1:side:e1', offset: [100, 0, 0] },
    );
    const all = await sweep(s, { mateId: 'mate#1' });
    expect(all.travel).toMatchObject({ from: 0, to: 90, step: 4.5, unit: 'deg' });
    expect(all.checked).toBe(21);
    expect(all.first!.value).toBe(0);
    expect(all.colliding).not.toContain(90);
    const past = await sweep(s, { mateId: 'mate#1', from: 0, to: 180, step: 30 });
    expect(past.values).toEqual([0, 30, 60, 90, 120, 150, 180]);
    expect(past.colliding).not.toContain(180);
    expect(past.warnings).toEqual([
      expect.objectContaining({
        code: 'outside-limits',
        bound: 'max',
        limit: 90,
        unit: 'deg',
        values: [120, 150, 180],
      }),
    ]);
    // A pose by hand, turned 120 degrees about the axis: a warning in degrees too.
    const frames = ok(
      await s.mateFrames({ kind: 'mate', assemblyId: 'assembly#1', mateId: 'mate#1' }),
    ) as {
      a: { origin: readonly number[]; z: readonly number[] };
    };
    const axis = frames.a.z;
    const angle = (120 * Math.PI) / 180;
    const q = [...axis.map((c) => c * Math.sin(angle / 2)), Math.cos(angle / 2)];
    // Turn about the axis through a's origin: p' = R (p - o) + o, so t = o - R o.
    const o = frames.a.origin;
    const rot = (v: readonly number[]) => {
      const [x, y, z, w] = q as [number, number, number, number];
      const c = [y * v[2]! - z * v[1]!, z * v[0]! - x * v[2]!, x * v[1]! - y * v[0]!];
      return [
        v[0]! + 2 * (w * c[0]! + y * c[2]! - z * c[1]!),
        v[1]! + 2 * (w * c[1]! + z * c[0]! - x * c[2]!),
        v[2]! + 2 * (w * c[2]! + x * c[1]! - y * c[0]!),
      ];
    };
    const ro = rot(o);
    const posed = ok(
      await s.measure({
        kind: 'interference',
        assemblyId: 'assembly#1',
        poses: { 'inst#2': { translation: o.map((c, i) => c - ro[i]!), rotation: q } },
      }),
    ) as unknown as { warnings: Record<string, unknown>[] };
    expect(posed.warnings).toEqual([
      expect.objectContaining({
        code: 'outside-limits',
        bound: 'max',
        limit: expect.closeTo(90, 9) as number,
        value: expect.closeTo(120, 6) as number,
        unit: 'deg',
      }),
    ]);
  });

  it('refuses a sweep it cannot make', async () => {
    const s = await pair({ min: mm('0') });
    const refused = async (query: Record<string, unknown>, message: RegExp) => {
      const r = await s.measure({ kind: 'interference', assemblyId: 'assembly#1', ...query });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toMatch(message);
    };
    await refused({ travel: { mateId: 'mate#1' } }, /no maximum: give travel to/);
    await refused({ travel: { mateId: 'mate#1', to: 1000, step: 1 } }, /at most 101 values/);
    await refused({ travel: { mateId: 'mate#9' } }, /no mate mate#9/);
    await refused(
      { travel: { mateId: 'mate#1', to: 10 }, poses: { 'inst#2': pose(5) } },
      /poses or a travel, not both/,
    );
    const r = await sweep(s, { mateId: 'mate#1', to: 60, step: 30 });
    expect(r.values).toEqual([0, 30, 60]);
    expect(r.colliding).toEqual([0, 30]);
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

  it("counts one feature's members alone, and gives the base version's quantities (#1217)", async () => {
    const s = await start(shedDocument());
    const before = ok(await s.quantities());
    // Window 1's members only: the takeoff is made for them, its purchase rows theirs alone.
    const own = ok(await s.quantities({ owners: ['extension#5'] }));
    expect(own.cutList).toBeNull();
    expect(own.takeoffs).toHaveLength(1);
    const rows = own.takeoffs[0]!.takeoff.rows;
    const sources = rows.filter((r) => r.category === 'framing').flatMap((r) => r.sources);
    const listed = ok(await s.members({ kind: 'members', partId: PART, owner: 'extension#5' }));
    expect(sources.map((x) => x.id).sort()).toEqual(listed.members.map((m) => m.id).sort());
    expect(rows.some((r) => r.category === 'lumber')).toBe(true);
    const each = (q: typeof own) =>
      q.takeoffs[0]!.takeoff.totals.find((t) => t.group === 'framing' && t.unit === 'each')!.value;
    expect(each(own)).toBe(listed.members.length);
    expect(each(own)).toBeLessThan(each(before));
    // A feature that owns nothing leaves every part studio out.
    expect(ok(await s.quantities({ owners: ['extension#99'] })).takeoffs).toEqual([]);

    const window = s.document.parts[0]!.features.find((f) => f.id === 'extension#5')!;
    ok(
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
    const head = ok(await s.quantities());
    expect(head).not.toEqual(before);
    // The base is what the session opened on, regenerated on an engine of its own, and kept.
    expect(ok(await s.baseQuantities())).toEqual(before);
    expect(ok(await s.baseQuantities({ owners: ['extension#5'] }))).toEqual(own);
  });

  it("lists a feature's members along its wall, and its overrides' statuses", async () => {
    const s = await start(shedDocument());
    // Window 1 on the front wall, centred at 48", 24" wide, sill at 44".
    const w = ok(await s.members({ kind: 'members', partId: PART, owner: 'extension#5' }));
    expect(w).toMatchObject({
      owner: 'extension#5',
      kind: 'opening',
      wall: 'extension#1',
      segment: 1,
      framed: true,
      omitted: 0,
      overrides: [],
    });
    expect(w.count).toBe(w.members.length);
    const under = w.members.filter((m) => m.role === 'cripple' && m.above!.to <= inch(44) + 1e-6);
    expect(under.length).toBeGreaterThan(0);
    for (const m of under) expect(Math.abs(m.along!.centre - inch(48))).toBeLessThan(inch(12));

    // Overrides on the left wall: one applies, one names a member the wall never had.
    const left = s.document.parts[0]!.features.find((f) => f.id === 'extension#4')!;
    const params = (left as { params: Record<string, unknown> }).params;
    ok(
      await s.apply({
        label: 'Left wall overrides',
        commands: [
          {
            type: 'editFeature',
            partId: PART,
            feature: {
              ...left,
              params: { ...params, overrides: [{ id: 's3', delete: true }, { id: 'extra1' }] },
            },
          },
        ],
      }),
    );
    const expected = [
      { n: 1, id: 's3', member: 'extension#4:s3', status: 'applied', delete: true },
      { n: 2, id: 'extra1', member: 'extension#4:extra1', status: 'lost' },
    ];
    const l = ok(await s.members({ kind: 'members', partId: PART, owner: 'extension#4' }));
    expect(l.kind).toBe('wall');
    expect(l.overrides).toEqual(expected);
    expect(l.members.some((m) => m.local === 's3')).toBe(false);
    expect(l.members.some((m) => m.local === 's4')).toBe(true);

    // A regen that leaves the left wall's set alone does not resend it: the statuses stay.
    const window = s.document.parts[0]!.features.find((f) => f.id === 'extension#5')!;
    ok(
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
    const again = ok(await s.members({ kind: 'members', partId: PART, owner: 'extension#4' }));
    expect(again.overrides).toEqual(expected);

    // Floors and roofs list their members with no position along a wall.
    const floor = ok(await s.members({ kind: 'members', partId: PART, owner: 'extension#8' }));
    expect(floor.kind).toBe('floor');
    expect(floor.count).toBeGreaterThan(0);
    expect(floor.members[0]).toMatchObject({ along: null, above: null });

    expect(await s.members({ kind: 'members', partId: PART, owner: 'extension#99' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'not-found' }),
    });
    expect(await s.members({ kind: 'members', partId: PART })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-input' }),
    });
  });
});

describe('the bracket', () => {
  /** A boss 6 mm in radius, 5 mm tall, on the foot over the first M4 hole (x = 25). */
  const boss = [
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'sketch#$s',
        kind: 'sketch',
        name: 'Boss sketch',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, 6], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [{ id: 'e$c', kind: 'circle', construction: false, center: [25, 0], radius: 6 }],
        constraints: [],
      },
    },
    {
      type: 'addFeature',
      partId: PART,
      feature: {
        id: 'extrude#$boss',
        kind: 'extrude',
        name: 'Boss',
        suppressed: false,
        profile: { sketch: 'sketch#$s' },
        operation: 'add',
        extent: { type: 'blind', distance: { source: '5', lengthUnit: 'mm', angleUnit: 'deg' } },
        reverse: false,
      },
    },
  ];

  it('gives cylinder hits a point on the axis and a hole-or-boss flag', async () => {
    const s = await start(bracketDocument());
    ok(await s.apply({ label: 'Boss', commands: boss }));
    const [wall] = ok(await s.findGeometry({ name: 'hole#1:wall:e7' }));
    expect(wall).toMatchObject({ surface: 'cylinder', radius: 2.25, hole: true });
    expect(wall!.axisOrigin![0]).toBeCloseTo(25, 9);
    expect(wall!.axisOrigin![1]).toBeCloseTo(0, 9);
    const [side] = ok(await s.findGeometry({ name: 'extrude#2:side:e9' }));
    expect(side).toMatchObject({ surface: 'cylinder', radius: 6, hole: false });
    // A plane has neither.
    const [top] = ok(await s.findGeometry({ normal: [0, 0, 1], nearest: [25, 0, 11], limit: 1 }));
    expect(top).toMatchObject({ surface: 'plane', axisOrigin: null, hole: null });
  });

  it('finds the faces on one axis with coaxialWith, not the parallel ones', async () => {
    const s = await start(bracketDocument());
    ok(await s.apply({ label: 'Boss', commands: boss }));
    const names = async (query: Record<string, unknown>) =>
      ok(await s.findGeometry(query))
        .map((h) => `${h.name} ${h.hole ? 'hole' : 'boss'}`)
        .sort();
    // The boss, the counterbore and the hole under it; not the hole at x = 40, nor the fillet.
    const onAxis = ['extrude#2:side:e9 boss', 'hole#1:cbore:e7 hole', 'hole#1:wall:e7 hole'];
    expect(await names({ coaxialWith: 'extrude#2:side:e9' })).toEqual(onAxis);
    expect(await names({ coaxialWith: 'hole#1:wall:e7' })).toEqual(onAxis);
    expect(await names({ coaxialWith: 'hole#1:wall:e8' })).toEqual([
      'hole#1:cbore:e8 hole',
      'hole#1:wall:e8 hole',
    ]);
    // Combined with the other filters; edges never match.
    expect(await names({ coaxialWith: 'hole#1:wall:e7', radius: 4 })).toEqual([
      'hole#1:cbore:e7 hole',
    ]);
    expect(await names({ coaxialWith: 'hole#1:wall:e7', kind: 'edge' })).toEqual([]);
    expect(await names({ coaxialWith: 'fillet#1:round:r1' })).toEqual(['fillet#1:round:r1 hole']);
    // A distance between the lines within tolerance counts; the holes are 15 mm apart.
    expect(await names({ coaxialWith: 'hole#1:wall:e7', tolerance: 16, bornBy: 'hole#1' })).toEqual(
      [
        'hole#1:cbore:e7 hole',
        'hole#1:cbore:e8 hole',
        'hole#1:wall:e7 hole',
        'hole#1:wall:e8 hole',
      ],
    );
  });

  it('refuses a coaxialWith that names no face, or a face that is not a cylinder', async () => {
    const s = await start(bracketDocument());
    expect(await s.findGeometry({ coaxialWith: 'hole#1:wall:e99' })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-input',
        message: expect.stringMatching(/names no face/),
      }),
    });
    const [plane] = ok(await s.findGeometry({ normal: [0, 0, 1], limit: 1 }));
    expect(await s.findGeometry({ coaxialWith: plane!.name })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'invalid-input',
        message: expect.stringMatching(/cylindrical/),
      }),
    });
    expect(await s.findGeometry({ coaxialWith: 7 })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid-input' }),
    });
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
