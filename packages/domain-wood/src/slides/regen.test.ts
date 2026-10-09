// A slide through regen with the real kernel (libcascade in Node) and the real sketch solver: its
// two members are bodies of their own, named under the slide's id, touching the boards and
// overlapping neither, and they follow the drawer side when it moves; a gap that does not fit is
// an error on the feature.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type SketchFeature,
} from '@manufakture/core';
import type { InterferenceResult, KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenResult } from '@manufakture/regen';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findStock } from '../catalog';
import { registerWood } from '../domain';
import { readSlideMetadata } from './translate';

const PART = 'part#1';
const IN = 25.4;
const PLY_34 = findStock('us-ply-23-32')!.actual.thickness;
const PLY_58 = findStock('us-ply-19-32')!.actual.thickness;

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

type V = [number, number, number];

/** A w x h rectangle (sketch x along +y, sketch y along +z) on a plane facing +x at `origin`. */
function rectangle(id: string, origin: V, w: number, h: number): SketchFeature {
  const n = Number(id.split('#')[1]);
  const e = [1, 2, 3, 4].map((i) => `e${(n - 1) * 4 + i}`);
  const c: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin, normal: [1, 0, 0], xDir: [0, 1, 0] },
    entities: c.map((start, i) => ({
      id: e[i]!,
      kind: 'line' as const,
      construction: false,
      start,
      end: c[(i + 1) % 4]!,
    })),
    constraints: [],
  };
}

function panel(id: string, sketch: string, stock: string): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'wood.board',
    schemaVersion: 1,
    dependsOn: [sketch],
    references: [],
    expressions: {},
    params: { form: 'panel', stock, sketch },
    operation: 'new',
  };
}

function slide(family: string, size: string): ExtensionFeature {
  return {
    id: 'extension#3',
    kind: 'extension',
    name: 'Left slide',
    suppressed: false,
    extension: 'wood.slide',
    schemaVersion: 1,
    operation: 'new',
    dependsOn: ['extension#1', 'extension#2'],
    references: [],
    expressions: {},
    params: { family, size, cabinet: 'extension#1', drawer: 'extension#2', opens: '-y' },
  };
}

const add = (feature: SketchFeature | ExtensionFeature): Command => ({
  type: 'addFeature',
  partId: PART,
  feature,
});

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** A cabinet side (3/4" ply, 22" deep, 30" tall) and a drawer side `gap` off it, 1/2" ply. */
function scene(gap: number, s: ExtensionFeature, stock = 'us-ply-15-32'): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-slides', name: 'Slides' }),
    add(rectangle('sketch#1', [0, 0, 0], 22 * IN, 30 * IN)),
    add(panel('extension#1', 'sketch#1', 'us-ply-23-32')),
    add(rectangle('sketch#2', [PLY_34 + gap, 0, 50], 18 * IN, 6 * IN)),
    add(panel('extension#2', 'sketch#2', stock)),
    add(s),
  );
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const result = await engine.regen(doc);
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

function shape(result: RegenResult, id: string): ShapeId {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id);
  expect(body, `body ${id}`).toBeDefined();
  return body!.shape;
}

async function volume(engine: RegenEngine, result: RegenResult, id: string): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape: shape(result, id) }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

/** The pairs of bodies that overlap (a volume above a cubic micrometre). */
async function overlaps(engine: RegenEngine, result: RegenResult, ids: string[]) {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'interference', items: ids.map((id) => ({ shapes: [shape(result, id)] })) }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  const value = r.value as InterferenceResult;
  expect(value.failures).toEqual([]);
  return value.pairs.filter((p) => p.volume > 1e-9).map((p) => [ids[p.a], ids[p.b]]);
}

async function withEngine(run: (engine: RegenEngine) => Promise<void>) {
  const extensions = new ExtensionRegistry();
  registerWood(extensions);
  const engine = new RegenEngine({ kernel: service, solver, extensions });
  try {
    await run(engine);
  } finally {
    await engine.dispose();
    await service.idle();
  }
  expect(service.leaks()).toEqual([]);
}

const CABINET_MEMBER = 'extension#3:slide/cabinet';
const DRAWER_MEMBER = 'extension#3:slide/drawer';

describe('wood.slide through regen', () => {
  it('makes the two members as bodies filling the gap, and follows the drawer side', async () => {
    await withEngine(async (engine) => {
      const doc = scene(12.7, slide('side-mount-ball-bearing', '18in'));
      const result = await regen(engine, doc);
      const f = result.parts[0]!.features.find((x) => x.featureId === 'extension#3')!;
      expect(f.status, JSON.stringify(f.errors)).toBe('ok');
      const meta = readSlideMetadata(f.metadata)!;
      expect(meta.fit.gap).toBeCloseTo(12.7, 6);
      expect(result.parts[0]!.bodies.map((b) => b.bodyId)).toEqual([
        'extension#1',
        'extension#2',
        CABINET_MEMBER,
        DRAWER_MEMBER,
      ]);
      // Each member: half the gap, 45.7 high, 450 long.
      for (const id of [CABINET_MEMBER, DRAWER_MEMBER]) {
        expect(await volume(engine, result, id)).toBeCloseTo(6.35 * 45.7 * 450, 3);
      }
      // Touching the boards and each other, overlapping nothing.
      expect(
        await overlaps(engine, result, [
          'extension#1',
          'extension#2',
          CABINET_MEMBER,
          DRAWER_MEMBER,
        ]),
      ).toEqual([]);
      // Its faces are named under its id, one cap role per member.
      for (const name of [
        'extension#3:cap.cabinet:start',
        'extension#3:cap.cabinet:end',
        'extension#3:cap.drawer:end',
        'extension#3:side:cabinet.front',
        'extension#3:side:drawer.top',
      ]) {
        expect(result.names).toContain(name);
      }

      // The drawer side 0.5 mm further out: the slide still fits (up to 13.5 mm), and the members
      // widen with the gap.
      const moved = scene(13.2, slide('side-mount-ball-bearing', '18in'));
      const again = await regen(engine, moved);
      expect(again.parts[0]!.features.every((x) => x.status === 'ok')).toBe(true);
      expect(await volume(engine, again, CABINET_MEMBER)).toBeCloseTo(6.6 * 45.7 * 450, 3);

      // An inch out: an error on the slide naming the gap, and no members.
      const far = await regen(engine, scene(12.7 + IN, slide('side-mount-ball-bearing', '18in')));
      const err = far.parts[0]!.features.find((x) => x.featureId === 'extension#3')!;
      expect(err.status).toBe('error');
      expect(err.errors[0]!.message).toMatch(/is 38\.1 mm, and a side-mount-ball-bearing slide/);
      expect(far.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extension#1', 'extension#2']);
    });
  }, 60_000);

  it('places an undermount runner under a 5/8" (19/32" actual) drawer side', async () => {
    await withEngine(async (engine) => {
      const result = await regen(
        engine,
        scene(21 - PLY_58, slide('undermount-concealed', '18in'), 'us-ply-19-32'),
      );
      const features = result.parts[0]!.features;
      for (const f of features) expect(f.status, JSON.stringify(f.errors)).toBe('ok');
      const meta = readSlideMetadata(
        features.find((x) => x.featureId === 'extension#3')!.metadata,
      )!;
      expect(meta.requires).toHaveLength(4);
      // The runner: 37 mm in, 14 mm high, 471 long; it passes under the drawer side.
      expect(await volume(engine, result, CABINET_MEMBER)).toBeCloseTo(37 * 14 * 471, 3);
      expect(
        await overlaps(engine, result, [
          'extension#1',
          'extension#2',
          CABINET_MEMBER,
          DRAWER_MEMBER,
        ]),
      ).toEqual([]);
    });
  }, 60_000);
});
