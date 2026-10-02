// Boards through regen with the real kernel (libcascade in Node) and the real sketch solver
// (ADR 0013 decision 1: regen, kernel and sketch are devDependencies of this package only). The
// domain registers on its own registry, as the app's regen worker entry does on the default one.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenResult } from '@manufakture/regen';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBoardMetadata } from './board';
import { registerWood, woodDomain } from './domain';
import type { Json } from './migrations';

const PART = 'part#1';
const IN = 25.4;
// A JSON-shaped expression (an inferred type, so it also fits where stored JSON is expected).
const mm = (source: string | number) => ({
  source: String(source),
  lengthUnit: 'mm' as const,
  angleUnit: 'deg' as const,
});

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

/** A fully constrained w x d rectangle from the origin of the XY plane: e1 along +x, e2 up. */
function rectangle(id: string, w: number, d: number): SketchFeature {
  let k = 1;
  const kid = () => `k${k++}`;
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [
      { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [w, 0] },
      { id: 'e2', kind: 'line', construction: false, start: [w, 0], end: [w, d] },
      { id: 'e3', kind: 'line', construction: false, start: [w, d], end: [0, d] },
      { id: 'e4', kind: 'line', construction: false, start: [0, d], end: [0, 0] },
    ],
    constraints: [
      {
        id: kid(),
        kind: 'coincident',
        a: { entity: 'e1', at: 'end' },
        b: { entity: 'e2', at: 'start' },
      },
      {
        id: kid(),
        kind: 'coincident',
        a: { entity: 'e2', at: 'end' },
        b: { entity: 'e3', at: 'start' },
      },
      {
        id: kid(),
        kind: 'coincident',
        a: { entity: 'e3', at: 'end' },
        b: { entity: 'e4', at: 'start' },
      },
      {
        id: kid(),
        kind: 'coincident',
        a: { entity: 'e4', at: 'end' },
        b: { entity: 'e1', at: 'start' },
      },
      { id: kid(), kind: 'horizontal', line: 'e1' },
      { id: kid(), kind: 'horizontal', line: 'e3' },
      { id: kid(), kind: 'vertical', line: 'e2' },
      { id: kid(), kind: 'vertical', line: 'e4' },
      { id: kid(), kind: 'coincident', a: { entity: 'e1', at: 'start' }, b: { entity: '@origin' } },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        value: mm(w),
      },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: 'e2', at: 'start' },
        b: { entity: 'e2', at: 'end' },
        value: mm(d),
      },
    ],
  };
}

/** One construction line (`e5`) with both ends fixed: the path of a stick. */
function path(id: string, start: [number, number], end: [number, number]): SketchFeature {
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [{ id: 'e5', kind: 'line', construction: true, start, end }],
    constraints: [
      { id: 'k12', kind: 'fix', point: { entity: 'e5', at: 'start' } },
      { id: 'k13', kind: 'fix', point: { entity: 'e5', at: 'end' } },
    ],
  };
}

function board(
  id: string,
  sketch: string,
  params: Json,
  expressions: Record<string, StoredExpression> = {},
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'wood.board',
    schemaVersion: 1,
    dependsOn: [sketch],
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    operation: 'new',
  };
}

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const add = (feature: SketchFeature | ExtensionFeature): Command => ({
  type: 'addFeature',
  partId: PART,
  feature,
});

/** A plywood panel (extension#1, 600 x 300 region) and a 2x4 stick 8 ft along y = 500. */
function shelf(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-1', name: 'Boards' }),
    add(rectangle('sketch#1', 600, 300)),
    add(
      board('extension#1', 'sketch#1', {
        form: 'panel',
        stock: 'us-ply-23-32',
        sketch: 'sketch#1',
      }),
    ),
    add(path('sketch#2', [0, 500], [96 * IN, 500])),
    add(
      board('extension#2', 'sketch#2', {
        form: 'stick',
        stock: 'us-2x4',
        sketch: 'sketch#2',
        line: 'e5',
        justify: { thickness: 'positive', width: 'positive' },
      }),
    ),
  );
}

/**
 * Regenerate at a generation the shared kernel service has not cancelled. A new engine picks the
 * service's newest generation plus one, which an earlier engine on the same service may already
 * have cancelled (its last regens sent no batch); such a regen would be superseded and resolve to
 * null.
 */
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

function feature(result: RegenResult, id: string) {
  return result.parts[0]!.features.find((f) => f.featureId === id)!;
}

function bodyShape(result: RegenResult, id: string): ShapeId {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id);
  expect(body, `body ${id}`).toBeDefined();
  return body!.shape;
}

describe('boards through regen with the real kernel', () => {
  it('builds a panel and a stick with exact volumes, their frames and face names', async () => {
    const extensions = new ExtensionRegistry();
    registerWood(extensions);
    expect(extensions.lookup('wood.board')?.implementation).toBe(woodDomain.implementation);
    const engine = new RegenEngine({ kernel: service, solver, extensions });
    const result = await regen(engine, shelf());
    for (const id of ['sketch#1', 'extension#1', 'sketch#2', 'extension#2']) {
      expect(
        feature(result, id).status,
        `${id}: ${JSON.stringify(feature(result, id).errors)}`,
      ).toBe('ok');
    }

    const ply = (23 / 32) * IN;
    expect(await volume(engine, bodyShape(result, 'extension#1'))).toBeCloseTo(600 * 300 * ply, 4);
    const panel = readBoardMetadata(feature(result, 'extension#1').metadata)!;
    expect(panel.frame.size.length).toBeCloseTo(600, 9);
    expect(panel.frame.size.width).toBeCloseTo(300, 9);
    expect(panel.frame.size.thickness).toBeCloseTo(18.25625, 12);
    expect(panel.frame.axes.length).toEqual([1, 0, 0]);

    expect(await volume(engine, bodyShape(result, 'extension#2'))).toBeCloseTo(
      38.1 * 88.9 * 2438.4,
      3,
    );
    const stick = readBoardMetadata(feature(result, 'extension#2').metadata)!;
    expect(stick.frame.size.length).toBeCloseTo(2438.4, 9);
    expect(stick.frame.size.width).toBeCloseTo(88.9, 9);
    expect(stick.frame.size.thickness).toBeCloseTo(38.1, 9);
    // Flush to the line on its thickness and width faces: the blank's thickness starts at the
    // line and its width runs up from it along +z. The frame's width axis is -z (right-handed:
    // length x width = thickness), so the min corner is at the top face.
    expect(stick.frame.axes.length).toEqual([1, 0, 0]);
    expect(stick.frame.axes.width).toEqual([0, 0, -1]);
    expect(stick.frame.axes.thickness).toEqual([0, 1, 0]);
    stick.frame.origin.forEach((x, i) => expect(x).toBeCloseTo([0, 500, 88.9][i]!, 6));

    expect(result.names).toEqual(
      expect.arrayContaining([
        'extension#1:side:e1',
        'extension#1:cap:end',
        'extension#2:side:t0',
        'extension#2:side:w0',
        'extension#2:side:w1',
        'extension#2:cap:start',
      ]),
    );
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('follows a stock override, and rebuilds nothing for a price', async () => {
    const extensions = new ExtensionRegistry();
    registerWood(extensions);
    const engine = new RegenEngine({ kernel: service, solver, extensions });
    const doc = shelf();
    await regen(engine, doc);

    const measured = apply(doc, {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 1,
      data: { overrides: { 'us-ply-23-32': { thickness: mm('18.2mm') } } },
    });
    const thinner = await regen(engine, measured);
    expect(feature(thinner, 'extension#1').status).toBe('ok');
    expect(await volume(engine, bodyShape(thinner, 'extension#1'))).toBeCloseTo(
      600 * 300 * 18.2,
      4,
    );
    expect(readBoardMetadata(feature(thinner, 'extension#1').metadata)!.overridden.thickness).toBe(
      true,
    );
    // Only the plywood panel is rebuilt; the stick's input is unchanged and comes from the cache.
    expect(thinner.counters).toMatchObject({ featureOps: 1 });
    expect(feature(thinner, 'extension#2').cached).toBe(true);

    const priced = apply(measured, {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 1,
      data: {
        overrides: {
          'us-ply-23-32': { thickness: mm('18.2mm'), price: { amount: 62, per: 'sheet' } },
        },
      },
    });
    const same = await regen(engine, priced);
    expect(same.counters).toMatchObject({ featureOps: 0 });

    // An override that names a variable is refused, and every board fails rather than fall back
    // to the catalog thickness.
    const bad = apply(priced, {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 1,
      data: { overrides: { 'us-ply-23-32': { thickness: mm('#t') } } },
    });
    const failed = await regen(engine, bad);
    for (const id of ['extension#1', 'extension#2']) {
      expect(feature(failed, id).status).toBe('error');
      expect(feature(failed, id).errors[0]).toMatchObject({
        code: 'invalid',
        field: ['domains', 'stock', 'data', 'overrides', 'us-ply-23-32', 'thickness'],
      });
    }
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('reports invalid params and an unknown stock on the feature, and a newer version as unsupported', async () => {
    const extensions = new ExtensionRegistry();
    registerWood(extensions);
    const engine = new RegenEngine({ kernel: service, solver, extensions });
    const doc = apply(
      createDocument({ id: 'doc-2', name: 'Bad boards' }),
      add(rectangle('sketch#1', 100, 100)),
      add(board('extension#1', 'sketch#1', { form: 'panel', stock: 'us-3x1', sketch: 'sketch#1' })),
      add({
        ...board('extension#2', 'sketch#1', {
          form: 'panel',
          stock: 'mm-ply-18',
          sketch: 'sketch#1',
        }),
        schemaVersion: 2,
      }),
      add(
        board('extension#3', 'sketch#1', { form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#1' }),
      ),
    );
    const result = await regen(engine, doc);
    expect(feature(result, 'extension#1').errors[0]).toMatchObject({
      code: 'invalid',
      field: ['params', 'stock'],
    });
    expect(feature(result, 'extension#2').errors[0]).toMatchObject({ code: 'unsupported' });
    expect(feature(result, 'extension#3').status).toBe('ok');
    expect(await volume(engine, bodyShape(result, 'extension#3'))).toBeCloseTo(100 * 100 * 18, 6);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});
