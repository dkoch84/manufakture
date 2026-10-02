// The cut list from real regens (libcascade in Node and the real sketch solver): boards and joints
// built by the kernel, mapped with `cutListPart`, against hand-computed rows. Pins down the blank
// rule (a tenon's length is in its board's blank, though the body is cut shorter) and a
// configuration row through core's `configured`.

import {
  applyCommand,
  configured,
  createDocument,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenResult } from '@manufakture/regen';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { boardFeet } from '@manufakture/takeoff';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerWood } from '../domain';
import type { Json } from '../migrations';
import { cutList, type CutList } from './cutlist';
import { cutListPart } from './from-regen';

const PART = 'part#1';
const expr = (source: string | number) => ({
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
const XY: Plane = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
/** A plane facing +x, its sketch x along +y and its sketch y along +z. */
const YZ = (origin: V): Plane => ({ origin, normal: [1, 0, 0], xDir: [0, 1, 0] });

/**
 * A fully constrained rectangle from the plane's origin, `w` along sketch x and `d` along sketch
 * y; each size a number or an expression source (`#depth`) with the number as its first guess.
 */
function rectangle(
  id: string,
  w: number | [number, string],
  d: number,
  plane: Plane,
): SketchFeature {
  const n = Number(id.split('#')[1]);
  const [e1, e2, e3, e4] = [1, 2, 3, 4].map((i) => `e${(n - 1) * 4 + i}`) as [
    string,
    string,
    string,
    string,
  ];
  const [wv, ws] = typeof w === 'number' ? [w, String(w)] : w;
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
      { id: e1, kind: 'line', construction: false, start: [0, 0], end: [wv, 0] },
      { id: e2, kind: 'line', construction: false, start: [wv, 0], end: [wv, d] },
      { id: e3, kind: 'line', construction: false, start: [wv, d], end: [0, d] },
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
        value: expr(ws),
      },
      {
        id: kid(),
        kind: 'distance',
        a: { entity: e2, at: 'start' },
        b: { entity: e2, at: 'end' },
        value: expr(d),
      },
    ],
  };
}

function panel(id: string, name: string, sketch: string, stock: string): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name,
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

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const result = await engine.regen(doc);
  if (result === null) throw new Error('the regen was superseded');
  for (const f of result.parts[0]!.features) {
    expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
  }
  return result;
}

async function volume(engine: RegenEngine, result: RegenResult, id: string): Promise<number> {
  const body = result.parts[0]!.bodies.find((b) => b.bodyId === id)!;
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape: body.shape }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

/** The cut list of the document's one part as regen built it. */
function listOf(doc: ManufaktureDocument, result: RegenResult): CutList {
  return cutList({ parts: [cutListPart(doc.parts[0]!, result.parts[0]!)] });
}

const rows = (list: CutList) =>
  list.rows.map((r) => ({
    item: r.item,
    stock: r.stock,
    quantity: r.quantity,
    size: [r.size!.length, r.size!.width, r.size!.thickness].map((x) => +x!.toFixed(9)),
  }));

/**
 * A side 600 x 400 x 18 flat on the XY plane, and a shelf `#depth` (300) deep and 400 tall
 * standing on it, 18 thick, doweled with four 8 mm dowels. `#depth` is a configuration parameter
 * with a row "Deep" at 350.
 */
function shelfUnit(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-cutlist', name: 'Cut list' }),
    { type: 'setVariable', name: 'depth', expression: expr(300) },
    add(rectangle('sketch#1', 600, 400, XY)),
    add(panel('extension#1', 'Side', 'sketch#1', 'mm-ply-18')),
    add(rectangle('sketch#2', [300, '#depth'], 400, YZ([200, 20, 18]))),
    add(panel('extension#2', 'Shelf', 'sketch#2', 'mm-ply-18')),
    add(joint('extension#3', { kind: 'dowel' }, { count: expr(4) })),
    {
      type: 'setConfigParameter',
      parameter: { id: 'cp#1', name: 'Depth', kind: 'variable', variable: 'depth' },
    },
    { type: 'setConfigRow', row: { id: 'cfg#1', name: 'Deep', values: { 'cp#1': expr(350) } } },
  );
}

describe('the cut list of real regens', () => {
  it('lists the boards by their blanks and the dowels, and follows a configuration row', async () => {
    await withEngine(async (engine) => {
      const doc = shelfUnit();
      const result = await regen(engine, doc);
      const list = listOf(doc, result);
      // The shelf's panel grain runs along its longest side: 400 tall by 300 deep.
      expect(rows(list)).toEqual([
        { item: 'Side', stock: 'mm-ply-18', quantity: 1, size: [600, 400, 18] },
        { item: 'Shelf', stock: 'mm-ply-18', quantity: 1, size: [400, 300, 18] },
      ]);
      expect(list.rows[0]!.extended + list.rows[1]!.extended).toBeCloseTo(600 * 400 + 400 * 300, 6);
      // The holes are in the bodies, not the blanks.
      expect(await volume(engine, result, 'extension#2')).toBeLessThan(400 * 300 * 18 - 1);
      expect(list.hardware.map((r) => [r.item, r.size, r.quantity])).toEqual([
        ['Dowel', { diameter: 8, length: 32 }, 4],
      ]);

      const deepDoc = configured(doc, 'cfg#1');
      if (!deepDoc.ok) throw new Error(deepDoc.error.message);
      const deep = await regen(engine, deepDoc.value);
      const deepList = cutList({
        parts: [cutListPart(deepDoc.value.parts[0]!, deep.parts[0]!)],
        configuration: { id: 'cfg#1', name: 'Deep' },
      });
      expect(rows(deepList)).toEqual([
        { item: 'Side', stock: 'mm-ply-18', quantity: 1, size: [600, 400, 18] },
        { item: 'Shelf', stock: 'mm-ply-18', quantity: 1, size: [400, 350, 18] },
      ]);
      expect(deepList.rows[0]).toEqual(list.rows[0]);
      expect(deepList.hardware).toEqual(list.hardware);
      expect(deepList.configuration).toEqual({ id: 'cfg#1', name: 'Deep' });
    });
  });

  it("keeps a tenon's length in its board's blank", async () => {
    await withEngine(async (engine) => {
      // A 2x4 leg flat on the XY plane (38.1 thick, glued up to 100 wide); an 18 mm rail 80 wide
      // and 300 tall entering its top 25 mm, with a mortise and tenon.
      const doc = apply(
        createDocument({ id: 'doc-tenon', name: 'Tenon' }),
        add(rectangle('sketch#1', 400, 100, XY)),
        add(panel('extension#1', 'Leg', 'sketch#1', 'us-2x4')),
        add(rectangle('sketch#2', 80, 300, YZ([150, 10, 38.1 - 25]))),
        add(panel('extension#2', 'Rail', 'sketch#2', 'mm-ply-18')),
        add(joint('extension#3', { kind: 'mortise-tenon' })),
      );
      const result = await regen(engine, doc);
      // The tenon (6 x 68 x 25 by default) is what is left of the rail's last 25 mm.
      expect(await volume(engine, result, 'extension#2')).toBeCloseTo(
        80 * 300 * 18 - (18 * 80 - 6 * 68) * 25,
        4,
      );
      const list = listOf(doc, result);
      expect(rows(list)).toEqual([
        { item: 'Rail', stock: 'mm-ply-18', quantity: 1, size: [300, 80, 18] },
        { item: 'Leg', stock: 'us-2x4', quantity: 1, size: [400, 100, 38.1] },
      ]);
      // The leg is wider than a 2x4: counted on its own width, at the nominal 2" thickness.
      const leg = list.rows[1]!;
      expect(leg.flags).toEqual(['actual-width']);
      expect(leg.extended).toBeCloseTo(boardFeet(50.8, 100, 400), 12);
      expect(list.hardware).toEqual([]);
    });
  });
});
