// Joints through regen with the real kernel (libcascade in Node) and the real sketch solver: each
// kind's volumes against hand-computed ones, the joint's face names across edits, a dado following
// its board, and the kernel's interference check between the joined boards before and after.

import {
  applyCommand,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import type { InterferenceResult, KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenResult } from '@manufakture/regen';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerWood } from '../domain';
import type { Json } from '../migrations';
import { POCKET_JIG } from './fasteners';
import { readJointMetadata } from './translate';

const PART = 'part#1';
const IN = 25.4;
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

type V = [number, number, number];
interface Plane {
  origin: V;
  normal: V;
  xDir: V;
}
const XY = (origin: V = [0, 0, 0]): Plane => ({ origin, normal: [0, 0, 1], xDir: [1, 0, 0] });
/** A plane facing +x, its sketch x along +y and its sketch y along +z. */
const YZ = (origin: V): Plane => ({ origin, normal: [1, 0, 0], xDir: [0, 1, 0] });

/**
 * A fully constrained w x d rectangle from the plane's origin: its first line along sketch x, its
 * second along sketch y. Entity and constraint ids are unique in a document, so they are numbered
 * after the sketch's own number.
 */
function rectangle(id: string, w: number, d: number, plane: Plane): SketchFeature {
  const n = Number(id.split('#')[1]);
  const [e1, e2, e3, e4] = [1, 2, 3, 4].map((i) => `e${(n - 1) * 4 + i}`) as [
    string,
    string,
    string,
    string,
  ];
  let k = (n - 1) * 20 + 1;
  const kid = () => `k${k++}`;
  const corner = (a: string, b: string) => ({
    id: kid(),
    kind: 'coincident' as const,
    a: { entity: a, at: 'end' as const },
    b: { entity: b, at: 'start' as const },
  });
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', ...plane },
    entities: [
      { id: e1, kind: 'line', construction: false, start: [0, 0], end: [w, 0] },
      { id: e2, kind: 'line', construction: false, start: [w, 0], end: [w, d] },
      { id: e3, kind: 'line', construction: false, start: [w, d], end: [0, d] },
      { id: e4, kind: 'line', construction: false, start: [0, d], end: [0, 0] },
    ],
    constraints: [
      corner(e1, e2),
      corner(e2, e3),
      corner(e3, e4),
      corner(e4, e1),
      { id: kid(), kind: 'horizontal', line: e1 },
      { id: kid(), kind: 'horizontal', line: e3 },
      { id: kid(), kind: 'vertical', line: e2 },
      { id: kid(), kind: 'vertical', line: e4 },
      { id: kid(), kind: 'coincident', a: { entity: e1, at: 'start' }, b: { entity: '@origin' } },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: e1, at: 'start' },
        b: { entity: e1, at: 'end' },
        value: mm(w),
      },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: e2, at: 'start' },
        b: { entity: e2, at: 'end' },
        value: mm(d),
      },
    ],
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

function joint(
  id: string,
  params: Json,
  expressions: Record<string, StoredExpression> = {},
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: 'wood.joint',
    schemaVersion: 1,
    dependsOn: ['extension#1', 'extension#2'],
    references: [],
    expressions,
    params: {
      a: 'extension#1',
      b: 'extension#2',
      ...(params as object),
    } as ExtensionFeature['params'],
    scope: ['extension#1', 'extension#2'],
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

interface Scene {
  /** Board A: a rectangle on the XY plane, extruded up by its stock. */
  a: { length: number; width: number; stock: string };
  /** Board B: a rectangle on a YZ plane at `origin`, extruded along +x by its stock. */
  b: { origin: V; width: number; height: number; stock: string };
  joint?: ExtensionFeature;
}

function scene(s: Scene): ManufaktureDocument {
  const doc = apply(
    createDocument({ id: 'doc-joints', name: 'Joints' }),
    add(rectangle('sketch#1', s.a.length, s.a.width, XY())),
    add(panel('extension#1', 'sketch#1', s.a.stock)),
    add(rectangle('sketch#2', s.b.width, s.b.height, YZ(s.b.origin))),
    add(panel('extension#2', 'sketch#2', s.b.stock)),
  );
  return s.joint === undefined ? doc : apply(doc, add(s.joint));
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const result = await engine.regen(doc);
  if (result === null) throw new Error('the regen was superseded');
  return result;
}

function feature(result: RegenResult, id: string) {
  return result.parts[0]!.features.find((f) => f.featureId === id)!;
}

function expectOk(result: RegenResult) {
  for (const f of result.parts[0]!.features) {
    expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
  }
}

function bodyShape(result: RegenResult, id: string): ShapeId {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id);
  expect(body, `body ${id}`).toBeDefined();
  return body!.shape;
}

async function volume(engine: RegenEngine, result: RegenResult, id: string): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape: bodyShape(result, id) }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

/** The volume by which the two boards overlap, from the kernel's interference check (0: none). */
async function interference(engine: RegenEngine, result: RegenResult): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [
      {
        op: 'interference',
        items: [
          { shapes: [bodyShape(result, 'extension#1')] },
          { shapes: [bodyShape(result, 'extension#2')] },
        ],
      },
    ],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  const value = r.value as InterferenceResult;
  expect(value.failures).toEqual([]);
  return value.pairs.reduce((sum, p) => sum + p.volume, 0);
}

/** The names of the joint's faces and edges (an edge's name joins its faces' names with `|`). */
const jointNames = (result: RegenResult) =>
  result.names.filter((n) => n.startsWith('extension#3:')).sort();
const jointFaces = (result: RegenResult) => jointNames(result).filter((n) => !n.includes('|'));

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

// A side panel 600 x 300 x 18 on the XY plane; a shelf 300 deep, 400 tall, 18 thick standing on it.
const SIDE = { length: 600, width: 300, stock: 'mm-ply-18' };
const shelf = (x: number, z0: number, height = 400) => ({
  origin: [x, 0, z0] as V,
  width: 300,
  height,
  stock: 'mm-ply-18',
});
const SIDE_VOLUME = 600 * 300 * 18;
const SHELF_VOLUME = 300 * 400 * 18;

describe('joints through regen with the real kernel', () => {
  it('cuts a dado that fits its shelf, keeps its face names and follows the shelf', async () => {
    await withEngine(async (engine) => {
      const dado = joint('extension#3', { kind: 'dado' });
      const before = await regen(engine, scene({ a: SIDE, b: shelf(200, 12) }));
      expectOk(before);
      expect(await interference(engine, before)).toBeCloseTo(18 * 300 * 6, 3);

      const after = await regen(engine, scene({ a: SIDE, b: shelf(200, 12), joint: dado }));
      expectOk(after);
      expect(await volume(engine, after, 'extension#1')).toBeCloseTo(SIDE_VOLUME - 18 * 300 * 6, 4);
      expect(await volume(engine, after, 'extension#2')).toBeCloseTo(SHELF_VOLUME, 4);
      expect(await interference(engine, after)).toBe(0);
      // A through dado: two walls and a floor; it is open at the top and at both ends.
      const names = jointNames(after);
      expect(jointFaces(after)).toEqual([
        'extension#3:groove:xmax',
        'extension#3:groove:xmin',
        'extension#3:groove:zmin',
      ]);
      expect(readJointMetadata(feature(after, 'extension#3').metadata)).toMatchObject({
        kind: 'dado',
        warnings: [],
        hardware: [],
      });

      // The side longer, and the shelf taller: the same names.
      const longer = await regen(
        engine,
        scene({ a: { ...SIDE, length: 700 }, b: shelf(200, 12, 500), joint: dado }),
      );
      expectOk(longer);
      expect(jointNames(longer)).toEqual(names);
      expect(await volume(engine, longer, 'extension#1')).toBeCloseTo(
        700 * 300 * 18 - 18 * 300 * 6,
        4,
      );

      // The shelf moved along the side: the dado moves with it.
      const moved = await regen(engine, scene({ a: SIDE, b: shelf(350, 12), joint: dado }));
      expectOk(moved);
      expect(jointNames(moved)).toEqual(names);
      expect(await volume(engine, moved, 'extension#1')).toBeCloseTo(SIDE_VOLUME - 18 * 300 * 6, 4);
      expect(await interference(engine, moved)).toBe(0);
    });
  });

  it('cuts a stopped dado and notches the shelf, and a rabbet at the end of the side', async () => {
    await withEngine(async (engine) => {
      const stopped = await regen(
        engine,
        scene({
          a: SIDE,
          b: shelf(200, 12),
          joint: joint('extension#3', { kind: 'dado', stopped: 'low' }, { stop: mm(20) }),
        }),
      );
      expectOk(stopped);
      expect(await volume(engine, stopped, 'extension#1')).toBeCloseTo(
        SIDE_VOLUME - 18 * 280 * 6,
        4,
      );
      expect(await volume(engine, stopped, 'extension#2')).toBeCloseTo(
        SHELF_VOLUME - 18 * 20 * 6,
        4,
      );
      expect(await interference(engine, stopped)).toBe(0);

      const rabbet = await regen(
        engine,
        scene({
          a: SIDE,
          b: shelf(582, 12),
          joint: joint('extension#3', { kind: 'rabbet' }, { clearance: mm(0.5) }),
        }),
      );
      expectOk(rabbet);
      expect(await volume(engine, rabbet, 'extension#1')).toBeCloseTo(
        SIDE_VOLUME - 18.5 * 300 * 6,
        4,
      );
      expect(await interference(engine, rabbet)).toBe(0);
      // Open at the end: one wall and the floor.
      expect(jointFaces(rabbet)).toEqual(['extension#3:groove:xmin', 'extension#3:groove:zmin']);
    });
  });

  it('cuts square and rounded mortises and their tenons', async () => {
    await withEngine(async (engine) => {
      // A 2x4 leg flat on the XY plane (38.1 thick); an 18 mm rail 80 wide entering its top 25 mm.
      const leg = { length: 400, width: 100, stock: 'us-2x4' };
      const rail = {
        origin: [150, 10, 38.1 - 25] as V,
        width: 80,
        height: 300,
        stock: 'mm-ply-18',
      };
      const legVolume = 400 * 100 * 38.1;
      const railVolume = 80 * 300 * 18;
      const before = await regen(engine, scene({ a: leg, b: rail }));
      expect(await interference(engine, before)).toBeCloseTo(18 * 80 * 25, 3);

      // Defaults: a 6 mm (a third of 18) tenon, 68 wide (6 mm shoulders), 25 long.
      const square = await regen(
        engine,
        scene({ a: leg, b: rail, joint: joint('extension#3', { kind: 'mortise-tenon' }) }),
      );
      expectOk(square);
      expect(await volume(engine, square, 'extension#1')).toBeCloseTo(legVolume - 6 * 68 * 25, 4);
      expect(await volume(engine, square, 'extension#2')).toBeCloseTo(
        railVolume - (18 * 80 - 6 * 68) * 25,
        4,
      );
      expect(await interference(engine, square)).toBe(0);
      const squareNames = jointNames(square);
      expect(squareNames).toEqual(
        expect.arrayContaining([
          'extension#3:mortise:zmin',
          'extension#3:cheek-0:xmax',
          'extension#3:shoulder-1:ymin',
        ]),
      );

      const rounded = await regen(
        engine,
        scene({
          a: leg,
          b: rail,
          joint: joint('extension#3', { kind: 'mortise-tenon', ends: 'rounded' }),
        }),
      );
      expectOk(rounded);
      const section = 62 * 6 + Math.PI * 3 * 3;
      expect(await volume(engine, rounded, 'extension#1')).toBeCloseTo(legVolume - section * 25, 3);
      expect(await volume(engine, rounded, 'extension#2')).toBeCloseTo(
        railVolume - (18 * 80 - section) * 25,
        3,
      );
      expect(await interference(engine, rounded)).toBeLessThan(1e-3);
      expect(jointNames(rounded)).toEqual(
        expect.arrayContaining(['extension#3:mortise-end-0:wall', 'extension#3:round-1:wall']),
      );

      // The rail longer: the same joint faces.
      const longer = await regen(
        engine,
        scene({
          a: leg,
          b: { ...rail, height: 450 },
          joint: joint('extension#3', { kind: 'mortise-tenon' }),
        }),
      );
      expectOk(longer);
      expect(jointNames(longer)).toEqual(squareNames);
    });
  });

  it('cuts box joint fingers on both boards', async () => {
    await withEngine(async (engine) => {
      const a = { length: 300, width: 100, stock: 'mm-ply-18' };
      const b = { origin: [282, 0, 0] as V, width: 100, height: 200, stock: 'mm-ply-18' };
      const before = await regen(engine, scene({ a, b }));
      expect(await interference(engine, before)).toBeCloseTo(18 * 100 * 18, 3);
      const after = await regen(
        engine,
        scene({ a, b, joint: joint('extension#3', { kind: 'box-joint' }) }),
      );
      expectOk(after);
      // Six fingers of 100 / 6: each board loses three.
      const slots = 3 * (100 / 6) * 18 * 18;
      expect(await volume(engine, after, 'extension#1')).toBeCloseTo(300 * 100 * 18 - slots, 4);
      expect(await volume(engine, after, 'extension#2')).toBeCloseTo(200 * 100 * 18 - slots, 4);
      expect(await interference(engine, after)).toBe(0);
      expect(readJointMetadata(feature(after, 'extension#3').metadata)!.details).toMatchObject({
        fingers: 6,
      });
    });
  });

  it('drills dowel holes and pocket holes, reporting the hardware', async () => {
    await withEngine(async (engine) => {
      const b = shelf(200, 18);
      const dowels = await regen(
        engine,
        scene({ a: SIDE, b, joint: joint('extension#3', { kind: 'dowel' }) }),
      );
      expectOk(dowels);
      // Four 8 mm dowels, 12 into the side and 20 into the shelf.
      const hole = Math.PI * 4 * 4;
      expect(await volume(engine, dowels, 'extension#1')).toBeCloseTo(
        SIDE_VOLUME - 4 * hole * 12,
        3,
      );
      expect(await volume(engine, dowels, 'extension#2')).toBeCloseTo(
        SHELF_VOLUME - 4 * hole * 20,
        3,
      );
      expect(await interference(engine, dowels)).toBe(0);
      expect(readJointMetadata(feature(dowels, 'extension#3').metadata)!.hardware).toEqual([
        { item: 'dowel', diameter: 8, length: 32, quantity: 4 },
      ]);
      expect(jointNames(dowels)).toEqual(
        expect.arrayContaining(['extension#3:a-hole-1:end', 'extension#3:b-hole-4:wall']),
      );

      const pockets = await regen(
        engine,
        scene({ a: SIDE, b, joint: joint('extension#3', { kind: 'pocket-screw' }) }),
      );
      expectOk(pockets);
      expect(await volume(engine, pockets, 'extension#1')).toBeCloseTo(SIDE_VOLUME, 4);
      // Each pocket in the shelf: the wide step from where its axis leaves the face (9 / sin 15
      // back from the exit) to its floor (half the 1-1/4" screw back), then the pilot to the end.
      const angle = POCKET_JIG.angle;
      const rs = POCKET_JIG.pocketDiameter / 2;
      const rp = POCKET_JIG.pilotDiameter / 2;
      const pilot = (1.25 * IN) / 2;
      const one = Math.PI * rs * rs * (9 / Math.sin(angle) - pilot) + Math.PI * rp * rp * pilot;
      expect(await volume(engine, pockets, 'extension#2')).toBeCloseTo(SHELF_VOLUME - 3 * one, 3);
      expect(readJointMetadata(feature(pockets, 'extension#3').metadata)!.hardware).toEqual([
        { item: 'pocket-screw', length: 1.25 * IN, quantity: 3 },
      ]);
      expect(jointNames(pockets)).toEqual(
        expect.arrayContaining(['extension#3:pocket-1:shoulder', 'extension#3:pocket-3:step']),
      );
    });
  });

  it('refuses boards at an odd angle on the joint, leaving the boards whole', async () => {
    await withEngine(async (engine) => {
      const c = Math.cos(Math.PI / 6);
      const s = Math.sin(Math.PI / 6);
      const doc = apply(
        createDocument({ id: 'doc-splay', name: 'Splayed' }),
        add(rectangle('sketch#1', 600, 300, XY())),
        add(panel('extension#1', 'sketch#1', 'mm-ply-18')),
        add(
          rectangle('sketch#2', 300, 400, {
            origin: [200, 0, 12],
            normal: [c, s, 0],
            xDir: [-s, c, 0],
          }),
        ),
        add(panel('extension#2', 'sketch#2', 'mm-ply-18')),
        add(joint('extension#3', { kind: 'dado' })),
      );
      const result = await regen(engine, doc);
      expect(feature(result, 'extension#1').status).toBe('ok');
      expect(feature(result, 'extension#2').status).toBe('ok');
      const f = feature(result, 'extension#3');
      expect(f.status).toBe('error');
      expect(f.errors[0]).toMatchObject({
        code: 'invalid',
        field: ['params', 'b'],
        message: expect.stringMatching(
          /extension#2 is not square to extension#1 \(about 30° off\)/,
        ),
      });
      expect(await volume(engine, result, 'extension#1')).toBeCloseTo(SIDE_VOLUME, 4);
    });
  });
});
