// Construction drawings through regen with the real kernel (libcascade in Node), M6 plan T6.4a:
// the 12' x 16' shed with a door, a 6/12 gable roof and a floor, drawn on one sheet as a floor
// plan at 4', a framing elevation of the door wall and one of a gable wall. The plan shows the
// walls' layers (sectioned) and the door swing; the elevation every framing member of the wall
// at its size; the gable elevation a 6/12 pitch symbol; the strings follow the door; the title
// block carries the disclaimer.

import {
  applyCommand,
  createDocument,
  type Command,
  type Drawing,
  type DrawingView,
  type ExtensionFeature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { projectPoint, type KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  type DrawingSheetResult,
  type DrawingViewResult,
  type MemberData,
  type RegenResult,
  type RegenSolver,
} from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { constructionDomain, registerConstruction } from '../domain';
import { constructionDrawings } from './views';
import { registerStock } from '@manufakture/stock';
import { inch } from '../test-helpers';

const PART = 'part#1';
const D = 'drawing#1';
const S = 'sheet#1';

type Vec2 = readonly [number, number];
interface TextItem {
  kind: 'text';
  text: string;
  owner?: string;
  height: number;
}

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
  operation: ExtensionFeature['operation'] | null = 'new',
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
    ...(operation === null ? {} : { operation }),
  };
}

const wall = (id: string, a: [number, number], b: [number, number]) =>
  ext(
    id,
    'construction.wall',
    { level: 'level-1', wallType: 'ext-2x4', points: 2 },
    { x1: ins(a[0]), y1: ins(a[1]), x2: ins(b[0]), y2: ins(b[1]) },
  );

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
  { level: 'level-1', floorType: 'shed-floor', outline: 'walls' },
  {},
  WALLS,
);
const roof = ext(
  'extension#6',
  'construction.roof',
  { roofType: 'shed-roof', kind: 'gable' },
  { pitch: ins('6/12') },
  WALLS,
);
/** A 36" x 80" door in the front wall, centred `at` inches from its start. */
const door = (at: number) =>
  ext(
    'extension#7',
    'construction.opening',
    { kind: 'door' },
    { position: ins(at), width: ins(36), height: ins(80) },
    ['extension#1'],
    null,
  );

const domainView = (
  id: string,
  params: Record<string, unknown>,
  position: [number, number],
): DrawingView => ({
  id,
  source: {
    domain: 'construction',
    part: PART,
    schemaVersion: 1,
    params: params as Record<string, never>,
  },
  direction: 'top',
  scale: { paper: ins('1/4'), model: ins(12) },
  position,
  options: { hidden: false, smooth: false },
});

const VIEWS = [
  domainView('view#1', { kind: 'plan', level: 'level-1' }, [60, 150]),
  domainView('view#2', { kind: 'elevation', wall: 'extension#1' }, [60, 40]),
  domainView('view#3', { kind: 'elevation', wall: 'extension#3' }, [250, 150]),
];

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const add = (feature: ExtensionFeature): Command => ({ type: 'addFeature', partId: PART, feature });

function shed(at = 48, views: DrawingView[] = VIEWS): ManufaktureDocument {
  const drawing: Drawing = {
    id: D,
    name: 'Shed drawings',
    nextIds: { sheet: 2, view: views.length + 1 },
    sheets: [
      {
        id: S,
        name: 'Framing',
        size: 'A3',
        orientation: 'landscape',
        titleBlock: { fields: [{ label: 'Title', value: 'Shed' }] },
        views,
        dimensions: [],
        notes: [],
      },
    ],
  };
  return apply(
    createDocument({
      id: 'doc-1',
      name: 'Shed',
      units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
    }),
    { type: 'setDomainData', namespace: 'construction', schemaVersion: 1, data: CONSTRUCTION },
    ...[...shedWalls, floor, roof, door(at)].map(add),
    { type: 'addDrawing', drawing },
  );
}

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

const noSolver: RegenSolver = {
  solve: () => {
    throw new Error('these documents have no sketches');
  },
};

function engineFor(domainViewBudget?: number): RegenEngine {
  const extensions = new ExtensionRegistry();
  registerConstruction(extensions);
  return new RegenEngine({
    kernel: service,
    solver: noSolver,
    extensions,
    ...(domainViewBudget === undefined ? {} : { domainViewBudget }),
  });
}

async function regen(engine: RegenEngine, doc: ManufaktureDocument): Promise<RegenResult> {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  for (const f of result.parts[0]!.features)
    expect(f.status, `${f.featureId}: ${JSON.stringify(f.errors)}`).toBe('ok');
  return result;
}

async function sheetOf(engine: RegenEngine, doc: ManufaktureDocument): Promise<DrawingSheetResult> {
  const r = await engine.drawingSheet(doc, D, S);
  if (r === null) throw new Error('superseded');
  return r;
}

const view = (sheet: DrawingSheetResult, id: string): DrawingViewResult =>
  sheet.views.find((v) => v.viewId === id)!;

const texts = (sheet: DrawingSheetResult, owner: string) =>
  sheet
    .display!.items.filter((i): i is typeof i & TextItem => i.kind === 'text' && i.owner === owner)
    .map((t) => t.text);

const close = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe('construction drawings of the shed', () => {
  it('draws the plan, the framing elevations and the title block', async () => {
    const engine = engineFor();
    const doc = shed();
    const result = await regen(engine, doc);
    const sheet = await sheetOf(engine, doc);
    expect(sheet.diagnostics).toEqual([]);
    for (const v of sheet.views) expect(v.diagnostics, v.viewId).toEqual([]);

    // The plan at 4': the walls' sheathing projected and cut (hatched), the door's swing.
    const plan = view(sheet, 'view#1');
    expect(plan.items.map((i) => i.body).sort()).toEqual([
      'extension#1:layer/sheathing',
      'extension#2:layer/sheathing',
      'extension#3:layer/sheathing',
      'extension#4:layer/sheathing',
      'extension#5:layer/subfloor',
    ]);
    const faces = new Map(
      (plan.sections ?? []).map((s) => [plan.items[s.item]!.body, s.faces.length]),
    );
    // The door's rough opening splits the front wall's sheathing in two; the floor is below.
    expect(Object.fromEntries(faces)).toEqual({
      'extension#1:layer/sheathing': 2,
      'extension#2:layer/sheathing': 1,
      'extension#3:layer/sheathing': 1,
      'extension#4:layer/sheathing': 1,
      'extension#5:layer/subfloor': 0,
    });
    const swing = plan.input!.overlay!.filter((o) => o.curve.kind === 'arc');
    expect(swing).toHaveLength(1);
    const arc = swing[0]!.curve as Extract<(typeof swing)[0]['curve'], { kind: 'arc' }>;
    expect(arc.radius).toBeCloseTo(inch(36), 6);
    expect(arc.end - arc.start).toBeCloseTo(Math.PI / 2, 9);
    // The studs cut at 4' (sections of 1-1/2" x 3-1/2").
    expect(plan.input!.overlay!.length).toBeGreaterThan(100);
    // The front wall's string, outside it: corner, rough opening, corner, and the overall.
    expect(texts(sheet, 'view#1/extension#1:s1')).toEqual([`2' 6"`, `3' 0"`, `10' 6"`, `16' 0"`]);

    // The door wall's framing elevation: every member of the wall and the door at its size.
    const front = view(sheet, 'view#2');
    const members = (result.parts[0]!.members ?? []).find((s) => s.group === 'extension#1')!
      .members as MemberData[];
    expect(members.length).toBeGreaterThan(15);
    const lines = front.input!.overlay!.flatMap((o) => (o.curve.kind === 'line' ? [o.curve] : []));
    for (const m of members) {
      // Its rectangle as seen from outside: along the wall (x) and up (y) in view coordinates.
      const corners = cornersOf(m).map((p) => projectPoint(front.frame, p));
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const box: Vec2[] = [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
        [Math.min(...xs), Math.max(...ys)],
      ];
      for (let i = 0; i < 4; i++) {
        const a = box[i]!;
        const b = box[(i + 1) % 4]!;
        const found = lines.some(
          (l) => (close(l.a, a) && close(l.b, b)) || (close(l.a, b) && close(l.b, a)),
        );
        expect(found, `${m.owner}:${m.id} edge ${i}`).toBe(true);
      }
    }
    // Its strings: along the bottom with the door's rough opening, up the side to the door head.
    expect(texts(sheet, 'view#2/extension#1:s1:along')).toEqual([
      `2' 6"`,
      `3' 0"`,
      `10' 6"`,
      `16' 0"`,
    ]);
    expect(texts(sheet, 'view#2/extension#1:s1:up')).toEqual([`6' 8"`, `1' 5-1/8"`, `8' 1-1/8"`]);

    // The gable wall's elevation carries the roof's 6/12 pitch symbol.
    expect(view(sheet, 'view#3').symbols).toHaveLength(1);
    expect(texts(sheet, 'view#3/extension#6:pitch')).toEqual(['12', '6']);

    // The title block carries the disclaimer.
    const small = sheet
      .display!.items.filter(
        (i): i is typeof i & TextItem =>
          i.kind === 'text' && i.owner === 'titleBlock' && i.height === 1.8,
      )
      .map((t) => t.text)
      .join(' ');
    expect(small).toContain(DISCLAIMER_SHORT);
    expect(sheet.input!.disclaimer).toBe(DISCLAIMER_SHORT);

    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('moving the door updates the strings', async () => {
    const engine = engineFor();
    await regen(engine, shed(48));
    let sheet = await sheetOf(engine, shed(48));
    expect(texts(sheet, 'view#1/extension#1:s1')).toEqual([`2' 6"`, `3' 0"`, `10' 6"`, `16' 0"`]);
    const moved = shed(60);
    await regen(engine, moved);
    sheet = await sheetOf(engine, moved);
    expect(texts(sheet, 'view#1/extension#1:s1')).toEqual([`3' 6"`, `3' 0"`, `9' 6"`, `16' 0"`]);
    expect(texts(sheet, 'view#2/extension#1:s1:along')).toEqual([
      `3' 6"`,
      `3' 0"`,
      `9' 6"`,
      `16' 0"`,
    ]);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('reports a view it cannot draw as a diagnostic, not a failure', async () => {
    const engine = engineFor();
    const doc = shed();
    await regen(engine, doc);
    const bad = apply(doc, {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: domainView('view#2', { kind: 'elevation', wall: 'extension#9' }, [60, 40]),
    });
    const sheet = await sheetOf(engine, bad);
    const d = view(sheet, 'view#2').diagnostics;
    expect(d.map((x) => [x.code, x.severity])).toEqual([['domain-view', 'error']]);
    expect(d[0]!.message).toMatch(/extension#9 is not a wall/);
    const newer = apply(doc, {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: {
        ...domainView('view#2', {}, [60, 40]),
        source: { domain: 'construction', part: PART, schemaVersion: 2, params: {} },
      },
    });
    expect(view(await sheetOf(engine, newer), 'view#2').diagnostics[0]!.message).toMatch(
      /newer than this build reads/,
    );
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});

/** What reading the shed costs a domain view: its members and its construction features. */
function scanCost(result: RegenResult): number {
  const members = (result.parts[0]!.members ?? []).reduce(
    (n, x) => n + (x.members?.length ?? 0),
    0,
  );
  return members + result.parts[0]!.features.length;
}

/** A registry whose construction views count their calls. */
function countingEngine(budget: number): { engine: RegenEngine; calls: () => number } {
  let calls = 0;
  const extensions = new ExtensionRegistry();
  registerStock(extensions);
  extensions.registerDomain({
    ...constructionDomain,
    drawings: {
      ...constructionDrawings,
      view(ctx) {
        calls++;
        return constructionDrawings.view(ctx);
      },
    },
  });
  const engine = new RegenEngine({
    kernel: service,
    solver: noSolver,
    extensions,
    domainViewBudget: budget,
  });
  return { engine, calls: () => calls };
}

describe('the disclaimer and the request budget', () => {
  it('charges each distinct view for the members it scans, before scanning', async () => {
    // Plans cut above the walls draw almost nothing but read every member: a budget of three
    // scans lets two through (each also draws its strings) and refuses the rest unread.
    const probe = engineFor();
    const scanned = scanCost(await regen(probe, shed()));
    expect(scanned).toBeGreaterThan(100);
    await probe.dispose();
    const plans = Array.from({ length: 30 }, (_, i) =>
      domainView(
        `view#${i + 1}`,
        { kind: 'plan', level: 'level-1', cut: ins(200 + i), openings: 'none' },
        [60, 40],
      ),
    );
    const { engine, calls } = countingEngine(3 * scanned);
    const doc = shed(48, plans);
    await regen(engine, doc);
    const sheet = await sheetOf(engine, doc);
    expect(calls()).toBe(2);
    expect(sheet.views.slice(0, 2).every((v) => v.diagnostics.length === 0)).toBe(true);
    for (const v of sheet.views.slice(2)) {
      expect(v.diagnostics.map((d) => [d.code, d.severity])).toEqual([['domain-view', 'warning']]);
      expect(v.diagnostics[0]!.message).toMatch(
        /members, lines, arcs, string points and marks and pitch symbols/,
      );
    }
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  const disclaimer = (sheet: DrawingSheetResult) => sheet.input?.disclaimer;

  it('is on a sheet whose only construction view fails to draw', async () => {
    const engine = engineFor();
    const doc = shed(48, [
      domainView('view#1', { kind: 'elevation', wall: 'extension#9' }, [60, 40]),
    ]);
    await regen(engine, doc);
    const sheet = await sheetOf(engine, doc);
    expect(view(sheet, 'view#1').diagnostics.map((d) => d.code)).toEqual(['domain-view']);
    expect(disclaimer(sheet)).toBe(DISCLAIMER_SHORT);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('is on a sheet of a plain view of a part with construction features', async () => {
    const engine = engineFor();
    const plain: DrawingView = {
      id: 'view#1',
      source: { part: PART },
      direction: 'front',
      scale: { paper: ins('1/4'), model: ins(12) },
      position: [200, 150],
      options: { hidden: false, smooth: false },
    };
    const doc = shed(48, [plain]);
    await regen(engine, doc);
    const sheet = await sheetOf(engine, doc);
    expect(view(sheet, 'view#1').edges.length).toBeGreaterThan(0);
    expect(disclaimer(sheet)).toBe(DISCLAIMER_SHORT);
    const small = sheet
      .display!.items.filter(
        (i): i is typeof i & TextItem =>
          i.kind === 'text' && i.owner === 'titleBlock' && i.height === 1.8,
      )
      .map((t) => t.text)
      .join(' ');
    expect(small).toContain(DISCLAIMER_SHORT);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });

  it('draws many copies of one view once, and stops at the request budget', async () => {
    const copies = Array.from({ length: 40 }, (_, i) =>
      domainView(`view#${i + 1}`, { kind: 'elevation', wall: 'extension#1' }, [60, 40]),
    );
    // What one copy costs, from a request with the default budget.
    const probe = engineFor();
    const one = shed(48, copies.slice(0, 1));
    const scanned = scanCost(await regen(probe, one));
    const first = view(await sheetOf(probe, one), 'view#1');
    const cost =
      first.input!.overlay!.length +
      (first.symbols?.length ?? 0) +
      (first.chains ?? []).reduce((n, c) => n + c.points.length + (c.marks?.length ?? 0), 0);
    expect(cost).toBeGreaterThan(50);
    await probe.dispose();

    // The first copy is charged its scan and its output, each further copy its output.
    const { engine, calls } = countingEngine(scanned + Math.floor(2.5 * cost));
    const doc = shed(48, copies);
    await regen(engine, doc);
    const sheet = await sheetOf(engine, doc);
    expect(calls()).toBe(1);
    const drawn = sheet.views.filter((v) => v.diagnostics.length === 0);
    expect(drawn.map((v) => v.viewId)).toEqual(['view#1', 'view#2']);
    for (const v of sheet.views.slice(2)) {
      expect(v.diagnostics.map((d) => [d.code, d.severity])).toEqual([['domain-view', 'warning']]);
      expect(v.input?.overlay).toBeUndefined();
    }
    // Still on the title block.
    expect(disclaimer(sheet)).toBe(DISCLAIMER_SHORT);
    await engine.dispose();
    await service.idle();
    expect(service.leaks()).toEqual([]);
  });
});

function cornersOf(m: MemberData): [number, number, number][] {
  const z = [
    m.placement.x[1] * m.placement.y[2] - m.placement.x[2] * m.placement.y[1],
    m.placement.x[2] * m.placement.y[0] - m.placement.x[0] * m.placement.y[2],
    m.placement.x[0] * m.placement.y[1] - m.placement.x[1] * m.placement.y[0],
  ];
  const out: [number, number, number][] = [];
  for (const a of [0, m.length])
    for (const b of [0, m.stock.width])
      for (const c of [0, m.stock.depth])
        out.push(
          [0, 1, 2].map(
            (i) =>
              m.placement.origin[i]! + a * m.placement.x[i]! + b * m.placement.y[i]! + c * z[i]!,
          ) as [number, number, number],
        );
  return out;
}
