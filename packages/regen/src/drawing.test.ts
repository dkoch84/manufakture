// The drawing stage (T4.4e): pure mapping and picking rules first, then the real kernel and
// solver on the M1 bracket and the box-and-lid assembly: views projected on request and cached,
// dimensions resolved on the model and following its edits, and picks with the depth tie-break.

import { readFileSync } from 'node:fs';
import {
  parseDocument,
  type Command,
  type Dimension,
  type DimensionRef,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
  type Sheet,
} from '@manufakture/core';
import type {
  KernelOp,
  KernelService,
  MeasuredEdge,
  OpResult,
  ShapeId,
  Vec3,
  ViewFrame,
} from '@manufakture/kernel';
import type { DisplayList } from '@manufakture/drawing';
import { viewFrame } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrawingStage,
  PICK_TIE_TOLERANCE,
  cylinderExtent,
  dimensionInput,
  edgeSamples,
  drawingOffset,
  evaluateScale,
  pickInView,
  sheetInput,
  titleBlockInput,
  valueFormat,
  type DrawingBody,
  type DrawingHost,
  type DrawingViewResult,
  type RefGeometry,
  type ViewPickData,
} from './drawing';
import { RegenEngine, type RegenKernel } from './engine';
import { ASSEMBLY, PART, apply, boxAndLid, mm, setVariable, unwrap } from './test-helpers';
import { evaluateVariables } from './values';

const NO_VARIABLES = evaluateVariables([]);
const FRONT: ViewFrame = viewFrame({ direction: [0, 1, 0], up: [0, 0, 1] });
const TOP: ViewFrame = viewFrame({ direction: [0, 0, -1], up: [0, 1, 0] });

describe('mapping core drawings onto packages/drawing', () => {
  it("turns core's offset (from the first anchor) into packages/drawing's (from the nearer one)", () => {
    // Horizontal: the line 10 above the first anchor, which is the lower one.
    expect(drawingOffset('horizontal', [0, 0], [40, 6], 10, 1)).toBeCloseTo(4, 12);
    // Below both anchors.
    expect(drawingOffset('horizontal', [0, 0], [40, 6], -5, 1)).toBeCloseTo(-5, 12);
    // Vertical: core measures to the left, packages/drawing to the right.
    expect(drawingOffset('vertical', [0, 0], [0, 6], 10, 1)).toBeCloseTo(-10, 12);
    expect(drawingOffset('vertical', [0, 0], [0, 6], -8, 1)).toBeCloseTo(8, 12);
    // Paper mm: the anchors scale, the offset does not.
    expect(drawingOffset('horizontal', [0, 0], [40, 6], 20, 2)).toBeCloseTo(8, 12);
  });

  it('evaluates scales as ratios, or in feet and inches when both sides are written so', () => {
    const ratio = evaluateScale({ paper: mm('1'), model: mm('5') }, NO_VARIABLES);
    expect(ratio).toEqual({ ok: true, scale: { paper: 1, model: 5 } });
    const inches = evaluateScale(
      {
        paper: { source: '2', lengthUnit: 'in', angleUnit: 'deg' },
        model: { source: '1', lengthUnit: 'in', angleUnit: 'deg' },
      },
      NO_VARIABLES,
    );
    expect(inches).toEqual({ ok: true, scale: { paper: 2, model: 1 } });
    const arch = evaluateScale({ paper: mm('1-1/2"'), model: mm("1'") }, NO_VARIABLES);
    expect(arch.ok && arch.scale.notation).toBe('imperial');
    expect(arch.ok && arch.scale.paper / arch.scale.model).toBeCloseTo(1.5 / 12, 12);
    const bad = evaluateScale({ paper: mm('#nope'), model: mm('1') }, NO_VARIABLES);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.field).toEqual(['scale', 'paper']);
    expect(evaluateScale({ paper: mm('0'), model: mm('1') }, NO_VARIABLES).ok).toBe(false);
  });

  it('evaluates a custom sheet size, and turns a bad one into a diagnostic, never a throw', () => {
    const sheet = (width: string, height: string): Sheet => ({
      id: 'sheet#1',
      name: 'S',
      size: { width: mm(width), height: mm(height) },
      orientation: 'portrait',
      views: [],
      dimensions: [],
      notes: [],
    });
    expect(sheetInput(sheet('300', '200'), NO_VARIABLES)).toEqual({
      ok: true,
      sheet: { size: { width: 300, height: 200 }, orientation: 'portrait' },
    });
    const zero = sheetInput(sheet('0', '200'), NO_VARIABLES);
    expect(!zero.ok && zero.diagnostic).toMatchObject({
      code: 'sheet-size',
      field: ['size', 'width'],
    });
    const unknown = sheetInput(sheet('300', '#missing'), NO_VARIABLES);
    expect(!unknown.ok && unknown.diagnostic).toMatchObject({
      code: 'expression',
      field: ['size', 'height'],
    });
  });

  it('maps title block fields by label and reports the ones with no cell', () => {
    expect(
      titleBlockInput({
        fields: [
          { label: 'Title', value: 'Bracket' },
          { label: 'Drawing No.', value: 'MK-1' },
          { label: 'Drawn by', value: 'DB' },
          { label: 'Finish', value: 'oiled' },
          { label: 'Material', value: '' },
        ],
      }),
    ).toEqual({
      input: { title: 'Bracket', drawingNumber: 'MK-1', drawnBy: 'DB' },
      unknown: ['Finish'],
    });
  });

  it("formats values in the document's display units, with a dimension's own precision", () => {
    const units = { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } } as const;
    expect(valueFormat(units)).toEqual({
      length: { unit: 'ft-in', denominator: 16 },
      angle: { unit: 'deg' },
    });
    expect(valueFormat(units, { denominator: 32 }).length).toEqual({
      unit: 'ft-in',
      denominator: 32,
    });
    const mmUnits = { length: { unit: 'mm', decimals: 2 }, angle: { unit: 'deg' } } as const;
    expect(valueFormat(mmUnits, { decimals: 1 })).toEqual({
      length: { unit: 'mm', decimals: 1 },
      angle: { unit: 'deg', decimals: 1 },
    });
  });
});

describe('dimension geometry', () => {
  const ref: DimensionRef = { face: { face: 'f' }, body: 'b' };
  const linear = (kind: 'horizontal' | 'vertical' | 'aligned', offset = 5): Dimension => ({
    id: 'dim#1',
    view: 'view#1',
    kind,
    refs: [ref, ref],
    offset,
  });

  it("measures between two parallel planes along the first one's normal", () => {
    const r = dimensionInput(
      linear('horizontal'),
      [
        { kind: 'plane', point: [0, 5, 3], normal: [-1, 0, 0] },
        { kind: 'plane', point: [40, 12, 1], normal: [1, 0, 0] },
      ],
      FRONT,
      1,
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeCloseTo(40, 12);
    expect(r.warnings).toEqual([]);
    expect(r.input).toMatchObject({
      kind: 'horizontal',
      points: [
        [0, 3],
        [40, 3],
      ],
    });
  });

  it('warns when an aligned value is foreshortened, and refuses coincident anchors', () => {
    const r = dimensionInput(
      linear('aligned'),
      [
        { kind: 'point', point: [0, 0, 0] },
        { kind: 'point', point: [10, 10, 0] },
      ],
      FRONT,
      1,
      {},
    );
    expect(r.ok && r.value).toBeCloseTo(10, 12);
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['foreshortened']);
    const same = dimensionInput(
      linear('horizontal'),
      [
        { kind: 'point', point: [3, 0, 0] },
        { kind: 'point', point: [3, 9, 4] },
      ],
      FRONT,
      1,
      {},
    );
    expect(same.ok).toBe(false);
  });

  it('dimensions a cylinder seen across by its silhouettes, and face on by its circle', () => {
    const dim: Dimension = {
      id: 'dim#2',
      view: 'view#1',
      kind: 'diameter',
      refs: [ref],
      at: [0, 7],
    };
    const across = dimensionInput(
      dim,
      [{ kind: 'cylinder', origin: [20, 10, 3], axis: [0, 0, 1], radius: 3, length: 6 }],
      FRONT,
      1,
      {},
    );
    expect(across.ok && across.value).toBe(6);
    expect(across.ok && across.input).toMatchObject({
      kind: 'diameter',
      lines: [
        [
          [23, 0],
          [23, 6],
        ],
        [
          [17, 0],
          [17, 6],
        ],
      ],
      offset: 7,
    });
    const faceOn = dimensionInput(
      dim,
      [{ kind: 'cylinder', origin: [20, 10, 3], axis: [0, 0, 1], radius: 3, length: 6 }],
      TOP,
      1,
      {},
    );
    expect(faceOn.ok && faceOn.input).toMatchObject({
      kind: 'diameter',
      circle: { center: [20, 10], radius: 3 },
      angle: Math.PI / 2,
    });
    const radius = dimensionInput(
      { ...dim, kind: 'radius' },
      [{ kind: 'cylinder', origin: [20, 10, 3], axis: [0, 0, 1], radius: 3, length: 6 }],
      FRONT,
      1,
      {},
    );
    expect(radius.ok).toBe(false);
  });

  it("finds a partial cylinder's extent and arc from its edges, and warns that a silhouette is off it", () => {
    // A quarter round about z through (38, 2), from z 0 to 6, from +x (40, 2) to -y (38, 0): a
    // fillet's face. Its edges: the two arcs and the two lines.
    const c: Vec3 = [38, 2, 0];
    const arc = (z: number, reversed: boolean): MeasuredEdge => {
      const a: Vec3 = [40, 2, z];
      const b: Vec3 = [38, 0, z];
      const m: Vec3 = [38 + Math.SQRT2, 2 - Math.SQRT2, z];
      return {
        kind: 'edge',
        index: 1,
        name: null,
        curve: 'circle',
        length: Math.PI,
        start: reversed ? b : a,
        end: reversed ? a : b,
        midpoint: m,
        direction: null,
        circle: { center: [38, 2, z], radius: 2, axis: [0, 0, 1], sweep: Math.PI / 2 },
      };
    };
    const samples = edgeSamples(arc(0, false));
    // Sampled along the arc, not the long way round, whichever way the edge runs.
    expect(samples.length).toBeGreaterThan(3);
    for (const q of [...samples, ...edgeSamples(arc(6, true))]) {
      expect(Math.hypot(q[0] - 38, q[1] - 2)).toBeCloseTo(2, 9);
      expect(q[0] >= 38 - 1e-9 && q[1] <= 2 + 1e-9).toBe(true);
    }
    const points = [
      ...edgeSamples(arc(0, false)),
      ...edgeSamples(arc(6, true)),
      [40, 2, 0],
      [40, 2, 6],
      [38, 0, 0],
      [38, 0, 6],
    ] as Vec3[];
    const extent = cylinderExtent(c, [0, 0, 1], points, false)!;
    expect(extent.length).toBeCloseTo(6, 12);
    expect(extent.origin[2]).toBeCloseTo(3, 12);
    expect(extent.arc.sweep).toBeCloseTo(Math.PI / 2, 9);

    const geometry = [
      { kind: 'cylinder', radius: 2, axis: [0, 0, 1], ...extent },
    ] as const satisfies readonly RefGeometry[];
    const dim: Dimension = {
      id: 'dim#4',
      view: 'view#1',
      kind: 'diameter',
      refs: [ref],
      at: [0, 9],
    };
    const front = dimensionInput(dim, geometry, FRONT, 1, {});
    expect(front.ok && front.value).toBe(4);
    // The silhouettes run the face's full height, x = 40 (on the face) and 36 (off it).
    expect(front.ok && front.input).toMatchObject({
      lines: [
        [
          [40, 0],
          [40, 6],
        ],
        [
          [36, 0],
          [36, 6],
        ],
      ],
    });
    expect(front.ok && front.warnings.map((w) => w.code)).toEqual(['silhouette']);
    // A whole cylinder has both.
    const whole = cylinderExtent(c, [0, 0, 1], points, true)!;
    const both = dimensionInput(dim, [{ ...geometry[0], ...whole }], FRONT, 1, {});
    expect(both.ok && both.warnings).toEqual([]);
  });

  it('picks the angle whose quadrant holds `at`', () => {
    const dim: Dimension = {
      id: 'dim#3',
      view: 'view#1',
      kind: 'angle',
      refs: [
        { edge: { faces: ['a', 'b'] }, body: 'b' },
        { edge: { faces: ['c', 'd'] }, body: 'b' },
      ],
      at: [10, 10],
    };
    // Two lines through the origin of the front view: along x, and at 60 degrees.
    const c = Math.cos(Math.PI / 3);
    const s = Math.sin(Math.PI / 3);
    const geometry = [
      { kind: 'line', a: [-10, 0, 0], b: [10, 0, 0] },
      { kind: 'line', a: [-10 * c, 0, -10 * s], b: [10 * c, 0, 10 * s] },
    ] as const;
    const inside = dimensionInput(dim, geometry, FRONT, 1, {});
    expect(inside.ok && inside.value).toBeCloseTo(Math.PI / 3, 12);
    expect(inside.ok && inside.input).toMatchObject({ kind: 'angle', radius: Math.hypot(10, 10) });
    // `at` on the other side of the 60 degree leg: the supplementary angle.
    const outside = dimensionInput({ ...dim, at: [-10, 10] }, geometry, FRONT, 1, {});
    expect(outside.ok && outside.value).toBeCloseTo((2 * Math.PI) / 3, 12);
  });
});

describe('pickInView', () => {
  // A 40 x 20 x 6 plate's front edge and back edge at the top, which the front view draws as one
  // line, and its two left vertices front and back.
  const data: ViewPickData = {
    frame: FRONT,
    items: [
      {
        item: 0,
        body: 'extrude#1',
        edges: [
          {
            ref: { faces: ['back', 'top'] },
            points: [
              [0, 20, 6],
              [40, 20, 6],
            ],
          },
          {
            ref: { faces: ['front', 'top'] },
            points: [
              [0, 0, 6],
              [40, 0, 6],
            ],
          },
        ],
        vertices: [
          { ref: { faces: ['back', 'left', 'top'] }, point: [0, 20, 6] },
          { ref: { faces: ['front', 'left', 'top'] }, point: [0, 0, 6] },
        ],
        cylinders: [],
      },
    ],
  };

  it('breaks ties between coincident edges by depth: the one nearest the viewer', () => {
    const hit = pickInView(data, [20, 6.05], { radius: 1 });
    expect(hit).toMatchObject({
      kind: 'edge',
      ref: { edge: { faces: ['front', 'top'] }, body: 'extrude#1' },
    });
    expect(hit!.distance).toBeCloseTo(0.05, 12);
    // A back edge 0.1 mm nearer the click still loses within the tie window.
    const shifted: ViewPickData = {
      ...data,
      items: [
        {
          ...data.items[0]!,
          edges: [
            {
              ref: { faces: ['back', 'top'] },
              points: [
                [0, 20, 6.1],
                [40, 20, 6.1],
              ],
            },
            {
              ref: { faces: ['front', 'top'] },
              points: [
                [0, 0, 6],
                [40, 0, 6],
              ],
            },
          ],
          vertices: [],
        },
      ],
    };
    expect(pickInView(shifted, [20, 6.12], { radius: 1 })!.ref).toMatchObject({
      edge: { faces: ['front', 'top'] },
    });
    // Outside the window the nearer one wins.
    expect(pickInView(shifted, [20, 6.12], { radius: 1, tie: 0.01 })!.ref).toMatchObject({
      edge: { faces: ['back', 'top'] },
    });
    expect(PICK_TIE_TOLERANCE).toBe(0.15);
  });

  it('prefers a vertex within its radius, and finds nothing far away', () => {
    expect(pickInView(data, [0.2, 6.1], { radius: 1 })).toMatchObject({
      kind: 'vertex',
      ref: { vertex: { faces: ['front', 'left', 'top'] } },
    });
    expect(pickInView(data, [0.2, 6.1], { radius: 1, kinds: ['edge'] })!.kind).toBe('edge');
    expect(pickInView(data, [20, 10], { radius: 1 })).toBeNull();
  });
});

// With the real kernel ---------------------------------------------------------------------

describe("the stage's caches", () => {
  /**
   * A host with `n` one-vertex bodies, body i's vertex at (10 i, 0, 0), answering every op the
   * stage sends from data alone: no kernel.
   */
  function fakeHost(n: number): DrawingHost {
    const bodies: DrawingBody[] = Array.from({ length: n }, (_, i) => ({
      key: `b${i}`,
      body: `b${i}`,
      pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      shape: (i + 1) as ShapeId,
      bodyKey: `key${i}`,
      kernelInstance: null,
    }));
    const at = (shape: unknown): Vec3 => [10 * ((shape as number) - 1), 0, 0];
    const reply = (op: KernelOp): unknown => {
      switch (op.op) {
        case 'project':
          return { keys: [], edges: [], bounds: null };
        case 'tessellate':
          return { edgeRanges: [], edgePositions: [] };
        case 'topology':
          return { faces: [], edges: [], vertices: [{ index: 1, point: at(op.shape), faces: [] }] };
        case 'pick':
          return { ref: { faces: [`v${op.shape as number}`] } };
        case 'connector':
          return {
            results: [{ ok: true, via: 'exact', fragile: false, frame: { origin: at(op.shape) } }],
          };
        default:
          throw new Error(`unexpected ${op.op}`);
      }
    };
    return {
      generation: 1,
      variables: NO_VARIABLES,
      versions: { kernelBuild: 'fake', namingScheme: 1, implementation: 1 },
      deflection: undefined,
      bodies: async () => ({ bodies, diagnostics: [] }),
      domainView: async () => ({ output: null, bodies: [], diagnostics: [] }),
      titleNotes: () => [],
      run: async (ops) =>
        ops.map((op) => ({ ok: true, op: op.op, value: reply(op), ms: 0 }) as OpResult),
    };
  }

  it('answers a view with more bodies and references than its caches keep', async () => {
    const n = 5;
    const host = fakeHost(n);
    const vertex = (i: number): DimensionRef => ({
      vertex: { faces: [`v${i + 1}`] },
      body: `b${i}`,
    });
    const sheet: Sheet = {
      id: 'sheet#1',
      name: 'S',
      size: 'A3',
      orientation: 'landscape',
      views: [
        {
          id: 'view#1',
          source: { part: PART },
          direction: 'front',
          scale: { paper: mm('1'), model: mm('1') },
          position: [0, 0],
          options: { hidden: false, smooth: false },
        },
      ],
      dimensions: Array.from({ length: n - 1 }, (_, i) => ({
        id: `dim#${i + 1}`,
        view: 'view#1',
        kind: 'horizontal' as const,
        refs: [vertex(0), vertex(i + 1)],
        offset: 5,
      })),
      notes: [],
    };
    const drawing: Drawing = {
      id: 'drawing#1',
      name: 'D',
      nextIds: { sheet: 2, view: 2, note: 1 },
      sheets: [sheet],
    };
    const document = bracket();
    // Caches of one entry each: every request evicts its own entries as it goes.
    const stage = new DrawingStage({ views: 1, refs: 1, picks: 1 });
    for (let round = 0; round < 2; round++) {
      const v = await stage.view(host, document, drawing, sheet, sheet.views[0]!, { pick: true });
      expect(v.pick!.items.map((x) => x.vertices[0]!.point[0])).toEqual([0, 10, 20, 30, 40]);
      expect(v.dimensions.map((d) => [d.outcome, d.value])).toEqual([
        ['exact', 10],
        ['exact', 20],
        ['exact', 30],
        ['exact', 40],
      ]);
    }
    // Only the last reference stayed cached, so the second round asked for the others again.
    expect(stage.stats.resolveOps).toBe(n + (n - 1));
  });

  it("numbers each sheet's title block by its place in the drawing, unless the block says", async () => {
    const page = (id: string, fields: { label: string; value: string }[]): Sheet => ({
      id,
      name: id,
      size: 'A3',
      orientation: 'landscape',
      views: [],
      dimensions: [],
      notes: [],
      titleBlock: { fields },
    });
    const sheetCell = (display: DisplayList | null) =>
      display!.items.flatMap((i) =>
        i.kind === 'text' && i.owner === 'titleBlock' && /^\d+ \/ \d+$/.test(i.text)
          ? [i.text]
          : [],
      );
    const title = [{ label: 'Title', value: 'Shed' }];
    const sheets = [
      page('sheet#1', title),
      page('sheet#2', title),
      page('sheet#3', [...title, { label: 'Sheet', value: 'A-3' }]),
      page('sheet#4', [...title, { label: 'Sheet', value: '' }]),
    ];
    const drawing: Drawing = {
      id: 'drawing#1',
      name: 'D',
      nextIds: { sheet: 5, view: 1, note: 1 },
      sheets,
    };
    const stage = new DrawingStage();
    const host = fakeHost(0);
    const document = bracket();
    const got = await Promise.all(sheets.map((x) => stage.sheet(host, document, drawing, x)));
    expect(got.map((r) => r.input!.titleBlock && r.input!.titleBlock.sheet)).toEqual([
      '1 / 4',
      '2 / 4',
      'A-3',
      '4 / 4',
    ]);
    expect(sheetCell(got[1]!.display)).toEqual(['2 / 4']);
    // A lone sheet is 1 / 1.
    const lone: Drawing = { ...drawing, sheets: [sheets[1]!] };
    const one = await stage.sheet(host, document, lone, sheets[1]!);
    expect(sheetCell(one.display)).toEqual(['1 / 1']);
  });
});

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

afterAll(async () => {
  await service.idle();
  expect(service.leaks()).toEqual([]);
});

const D = 'drawing#1';
const S = 'sheet#1';
const BODY = 'extrude#1';

/** The M1 bracket: a 40 x 20 plate of `#thickness` with a 2 mm round on its front right edge. */
const bracket = (): ManufaktureDocument =>
  unwrap(
    parseDocument(
      JSON.parse(
        readFileSync(new URL('../../core/src/fixtures/v6-bracket.json', import.meta.url), 'utf8'),
      ),
    ),
  ).document;

const view = (
  id: string,
  direction: DrawingView['direction'],
  extra: Partial<DrawingView> = {},
): DrawingView => ({
  id,
  source: { part: PART },
  direction,
  scale: { paper: mm('2'), model: mm('1') },
  position: [60, 120],
  options: { hidden: true, smooth: true },
  ...extra,
});

/** A drawing of `views` on one A3 sheet; ids allocated past them. */
function withDrawing(doc: ManufaktureDocument, views: DrawingView[], extra: Partial<Sheet> = {}) {
  const drawing: Drawing = {
    id: D,
    name: 'Drawing',
    nextIds: { sheet: 2, view: 10, note: 10 },
    sheets: [
      {
        id: S,
        name: 'Sheet 1',
        size: 'A3',
        orientation: 'landscape',
        views,
        dimensions: [],
        notes: [],
        ...extra,
      },
    ],
  };
  return apply(doc, { type: 'addDrawing', drawing });
}

const addDimension = (dimension: Dimension): Command => ({
  type: 'addDimension',
  drawingId: D,
  sheetId: S,
  dimension,
});

/** The real service, counting `project` ops. */
function counting(): { kernel: RegenKernel; projects: () => number } {
  let projects = 0;
  return {
    kernel: {
      run: (request) => {
        projects += request.ops.filter((op) => op.op === 'project').length;
        return service.run(request);
      },
      release: (shapes) => service.release(shapes),
      cancel: (generation) => service.cancel(generation),
      onRecycle: (hook) => service.onRecycle(hook),
      stats: () => service.stats(),
    },
    projects: () => projects,
  };
}

const pickRef = (
  v: DrawingViewResult,
  at: [number, number],
  kinds: ('vertex' | 'edge' | 'face')[],
) => {
  const hit = pickInView(v.pick!, at, { radius: 1, kinds });
  expect(hit, `a pick at ${at.join(', ')}`).not.toBeNull();
  return hit!.ref;
};

describe('drawing views with the real kernel', () => {
  it('projects the bracket front view, dimensions it on picked references, and follows #thickness and a deleted fillet', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = withDrawing(bracket(), [
      view('view#1', 'front'),
      view('view#2', 'top', { position: [60, 40] }),
    ]);
    await engine.regen(doc);

    const front = (await engine.drawingView(doc, D, 'view#1', { pick: true }))!;
    expect(front.diagnostics).toEqual([]);
    expect(front.items).toEqual([
      {
        item: 0,
        key: BODY,
        body: BODY,
        pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        bodyKey: expect.any(String),
      },
    ]);
    expect(front.bounds!.min[0]).toBeCloseTo(0, 6);
    expect(front.bounds!.max[0]).toBeCloseTo(40, 6);
    expect(front.bounds!.max[1]).toBeCloseTo(6, 6);
    expect(front.edges.length).toBeGreaterThan(0);
    // Placed so the model origin lands at the view's position: the bounds' centre is 2 x (20, 3) off it.
    expect(front.input!.position).toEqual([100, 126]);

    // The picks a user would make: the front left vertices (the back ones project onto them).
    const bottom = pickRef(front, [0, 0], ['vertex']);
    const top = pickRef(front, [0, 6], ['vertex']);
    expect(bottom).toEqual({
      vertex: { faces: ['extrude#1:cap:start', 'extrude#1:side:e1', 'extrude#1:side:e4'] },
      body: BODY,
    });
    expect(top).toMatchObject({ vertex: { faces: expect.arrayContaining(['extrude#1:side:e1']) } });
    // And the round's top edge, an arc in the top view.
    const topView = (await engine.drawingView(doc, D, 'view#2', { pick: true }))!;
    const c = Math.SQRT1_2 * 2;
    const round = pickRef(topView, [38 + c, 2 - c], ['edge']);
    expect(round).toMatchObject({ edge: { faces: expect.arrayContaining(['fillet#1:round:r2']) } });

    doc = apply(
      doc,
      addDimension({
        id: 'dim#1',
        view: 'view#1',
        kind: 'vertical',
        refs: [bottom, top],
        offset: 10,
      }),
      // On the round's face (an edge of it would also touch the positional top cap).
      addDimension({
        id: 'dim#2',
        view: 'view#2',
        kind: 'radius',
        refs: [{ face: { face: 'fillet#1:round:r2' }, body: BODY }],
        at: [6, -6],
      }),
    );
    const at6 = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(at6.cached).toBe(true);
    expect(at6.dimensions).toHaveLength(1);
    // The top cap is a positional piece (`cap:end#1`: the hole's sketch split it), so the top
    // vertex resolves exactly but is reported fragile, as a feature's reference to it would be.
    expect(at6.dimensions[0]).toMatchObject({
      dimensionId: 'dim#1',
      outcome: 'warning',
      errors: [],
      warnings: [{ code: 'reference', referenceId: 'refs.1', via: 'exact', fragile: true }],
    });
    expect(at6.dimensions[0]!.value).toBeCloseTo(6, 9);
    expect(at6.dimensions[0]!.references.map((r) => r.via)).toEqual(['exact', 'exact']);
    // Core's offset is to the left of the first anchor for a vertical dimension.
    expect(at6.dimensions[0]!.input).toMatchObject({ kind: 'vertical', offset: -10 });
    const r6 = (await engine.drawingView(doc, D, 'view#2'))!.dimensions[0]!;
    expect(r6).toMatchObject({
      outcome: 'exact',
      input: { kind: 'radius', circle: { radius: 2 } },
    });
    expect(r6.value).toBeCloseTo(2, 9);

    // #thickness 6 -> 8: the dimension follows, its references stay exact.
    doc = apply(doc, setVariable('thickness', '8mm'));
    await engine.regen(doc);
    const at8 = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(at8.cached).toBe(false);
    expect(at8.bounds!.max[1]).toBeCloseTo(8, 6);
    expect(at8.dimensions[0]!.outcome).toBe('warning');
    expect(at8.dimensions[0]!.references.map((r) => r.via)).toEqual(['exact', 'exact']);
    expect(at8.dimensions[0]!.value).toBeCloseTo(8, 9);

    // Delete the fillet: the radius on its round is lost, the thickness stays.
    doc = apply(doc, { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' });
    await engine.regen(doc);
    const lost = (await engine.drawingView(doc, D, 'view#2'))!.dimensions[0]!;
    expect(lost).toMatchObject({ outcome: 'lost', value: null, input: null });
    expect(lost.errors).toEqual([
      expect.objectContaining({
        code: 'reference-lost',
        referenceId: 'refs.0',
        missing: ['fillet#1:round:r2'],
      }),
    ]);
    expect((await engine.drawingView(doc, D, 'view#1'))!.dimensions[0]!.value).toBeCloseTo(8, 9);
    await engine.dispose();
  });

  it('projects only on request, and a cache hit sends no project op', async () => {
    const { kernel, projects } = counting();
    const engine = new RegenEngine({ kernel, solver });
    let doc = withDrawing(bracket(), [view('view#1', 'front'), view('view#2', 'isometric')]);
    await engine.regen(doc);
    expect(projects()).toBe(0);
    const first = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(first.cached).toBe(false);
    expect(projects()).toBe(1);
    const again = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(again.cached).toBe(true);
    expect(again.edges).toEqual(first.edges);
    expect(projects()).toBe(1);
    // A drawing-only edit (moving the view) projects nothing again.
    doc = apply(doc, {
      type: 'moveView',
      drawingId: D,
      sheetId: S,
      viewId: 'view#1',
      position: [150, 150],
    });
    await engine.regen(doc);
    const moved = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(moved.cached).toBe(true);
    expect(projects()).toBe(1);
    // Another view, then a model edit: projected again.
    await engine.drawingView(doc, D, 'view#2');
    expect(projects()).toBe(2);
    doc = apply(doc, setVariable('thickness', '7mm'));
    await engine.regen(doc);
    expect((await engine.drawingView(doc, D, 'view#1'))!.cached).toBe(false);
    expect(projects()).toBe(3);
    expect(engine.drawingStats).toMatchObject({ projectOps: 3, projectHits: 2 });
    await engine.dispose();
  });

  it('picks the face of a round by its silhouette, and only where the face has one', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = withDrawing(bracket(), [
      view('view#1', 'front', { options: { hidden: true, smooth: true } }),
    ]);
    await engine.regen(doc);
    const front = (await engine.drawingView(doc, D, 'view#1', { pick: true }))!;
    const round = front.pick!.items[0]!.cylinders;
    expect(round).toHaveLength(1);
    expect(round[0]!.sweep).toBeCloseTo(Math.PI / 2, 2);
    // The quarter round's silhouette is at x = 40 (seen from the front); the far side of its
    // circle (x = 36) is not on the face.
    expect(pickInView(front.pick!, [40, 3], { radius: 0.5, kinds: ['face'] })!.ref).toEqual({
      face: { face: 'fillet#1:round:r2' },
      body: BODY,
    });
    expect(pickInView(front.pick!, [36, 3], { radius: 0.5, kinds: ['face'] })).toBeNull();
    // Edges first where an edge and a silhouette coincide.
    expect(pickInView(front.pick!, [40, 3], { radius: 0.5 })!.kind).toBe('edge');
    await engine.dispose();
  });

  it('dimensions a quarter round across its axis by its full height, warning that one silhouette is off it', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = apply(
      withDrawing(bracket(), [view('view#1', 'front')]),
      addDimension({
        id: 'dim#1',
        view: 'view#1',
        kind: 'diameter',
        refs: [{ face: { face: 'fillet#1:round:r2' }, body: BODY }],
        at: [0, 9],
      }),
    );
    await engine.regen(doc);
    const dim = (await engine.drawingView(doc, D, 'view#1'))!.dimensions[0]!;
    expect(dim.outcome).toBe('warning');
    expect(dim.value).toBeCloseTo(4, 9);
    expect(dim.warnings.map((w) => w.code)).toEqual(['silhouette']);
    // The face's height (the plate's thickness), not area / (2 pi r), a quarter of it.
    const input = dim.input!;
    const lines = input.kind === 'diameter' && 'lines' in input ? input.lines : null;
    expect(lines).not.toBeNull();
    for (const line of lines!) {
      expect(Math.abs(line[1][1] - line[0][1])).toBeCloseTo(6, 6);
      expect(Math.min(line[0][1], line[1][1])).toBeCloseTo(0, 6);
    }
    expect(lines!.map((l) => l[0][0]).sort((a, b) => a - b)).toEqual([
      expect.closeTo(36, 6),
      expect.closeTo(40, 6),
    ]);
    await engine.dispose();
  });

  it("keeps the side of a section core keeps (the kernel's normal is core's turned round), and fills its faces", async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const sectioned = (
      id: string,
      direction: DrawingView['direction'],
      normal: Vec3,
      offset: string,
    ) =>
      view(id, direction, {
        options: { hidden: false, smooth: false, section: { normal, offset: mm(offset) } },
      });
    const doc = withDrawing(bracket(), [
      // Core removes the side its normal points to: x > 20, then x < 20.
      sectioned('view#1', 'front', [1, 0, 0], '20'),
      sectioned('view#2', 'front', [-1, 0, 0], '-20'),
      // Seen from above, cut at half the thickness: the top half goes, the cut face shows.
      sectioned('view#3', 'top', [0, 0, 1], '3'),
    ]);
    await engine.regen(doc);
    const left = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(left.diagnostics).toEqual([]);
    expect(left.bounds!.min[0]).toBeCloseTo(0, 6);
    expect(left.bounds!.max[0]).toBeCloseTo(20, 6);
    const right = (await engine.drawingView(doc, D, 'view#2'))!;
    expect(right.bounds!.min[0]).toBeCloseTo(20, 6);
    expect(right.bounds!.max[0]).toBeCloseTo(40, 6);
    const top = (await engine.drawingView(doc, D, 'view#3'))!;
    expect(top.sections).toHaveLength(1);
    expect(top.sections![0]!.faces.length).toBeGreaterThan(0);
    const loops = top.input!.sections!;
    expect(loops).toHaveLength(1);
    expect(loops[0]!.item).toBe(0);
    expect(loops[0]!.loops.length).toBeGreaterThan(0);
    // The kept half's cut face spans the whole plate in plan.
    expect(top.bounds!.max[0] - top.bounds!.min[0]).toBeCloseTo(40, 6);
    await engine.dispose();
  });

  it('places assembly instances at their solved poses, and dimensions across instances', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = withDrawing(boxAndLid(), [
      view('view#1', 'front', { source: { assembly: ASSEMBLY } }),
    ]);
    const regen = (await engine.regen(doc))!;
    const lid = regen.assemblies[0]!.instances.find((x) => x.instanceId === 'inst#2')!;
    const front = (await engine.drawingView(doc, D, 'view#1', { pick: true }))!;
    expect(front.diagnostics).toEqual([]);
    expect(front.items.map((x) => [x.key, x.instance])).toEqual([
      ['inst#1/extrude#1', 'inst#1'],
      ['inst#2/extrude#1', 'inst#2'],
    ]);
    expect(front.items[1]!.pose).toEqual(lid.transform);
    // The lid lies on the 20 mm box: 25 mm in all.
    expect(front.bounds!.max[1]).toBeCloseTo(25, 6);
    const bottom = pickRef(front, [0, 0], ['vertex']);
    const top = pickRef(front, [0, 25], ['vertex']);
    expect(bottom).toMatchObject({ instance: ['inst#1'] });
    expect(top).toMatchObject({ instance: ['inst#2'] });
    doc = apply(
      doc,
      addDimension({
        id: 'dim#1',
        view: 'view#1',
        kind: 'vertical',
        refs: [bottom, top],
        offset: 10,
      }),
    );
    const dim = (await engine.drawingView(doc, D, 'view#1'))!.dimensions[0]!;
    expect(dim.outcome).toBe('exact');
    expect(dim.value).toBeCloseTo(25, 6);

    // An exploded view (T4.5a): the lid 30 mm up and 10 mm along x, the box where it was. The
    // dimension across the two follows the lid, and the solved poses stay as they are.
    doc = apply(doc, {
      type: 'addExplodedView',
      assemblyId: ASSEMBLY,
      explodedView: {
        id: 'explode#1',
        name: 'Exploded',
        steps: [
          {
            id: 'step#1',
            instances: ['inst#2'],
            direction: { vector: [0, 0, 1] },
            distance: mm('30'),
          },
          {
            id: 'step#2',
            instances: ['inst#2'],
            direction: { instance: 'inst#1', face: { face: 'extrude#1:side:e2' } },
            distance: mm('10'),
          },
        ],
      },
    } as Command);
    doc = apply(doc, {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: view('view#1', 'front', { source: { assembly: ASSEMBLY, explodedView: 'explode#1' } }),
    });
    const exploded = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(exploded.diagnostics).toEqual([]);
    expect(exploded.cached).toBe(false);
    expect(exploded.items[0]!.pose).toEqual(front.items[0]!.pose);
    const at = exploded.items[1]!.pose.translation;
    const was = lid.transform.translation;
    expect(at[0] - was[0]).toBeCloseTo(10, 9);
    expect(at[1] - was[1]).toBeCloseTo(0, 9);
    expect(at[2] - was[2]).toBeCloseTo(30, 9);
    expect(exploded.bounds!.max[1]).toBeCloseTo(55, 6);
    expect(exploded.bounds!.max[0]).toBeCloseTo(50, 6);
    expect(exploded.dimensions[0]!.outcome).toBe('exact');
    expect(exploded.dimensions[0]!.value).toBeCloseTo(55, 6);
    const again = (await engine.regen(doc))!;
    expect(again.assemblies[0]!.instances[1]!.transform).toEqual(lid.transform);
    // An exploded view whose step does not resolve in full is drawn without it, with a warning.
    doc = apply(doc, {
      type: 'editExplodeStep',
      assemblyId: ASSEMBLY,
      explodedViewId: 'explode#1',
      step: {
        id: 'step#2',
        instances: ['inst#2'],
        direction: { instance: 'inst#1', face: { face: 'extrude#1:side:e9' } },
        distance: mm('10'),
      },
    } as Command);
    await engine.regen(doc);
    const partly = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(partly.diagnostics.map((d) => d.code)).toEqual(['exploded-view']);
    expect(partly.bounds!.max[0]).toBeCloseTo(40, 6);
    expect(partly.bounds!.max[1]).toBeCloseTo(55, 6);
    await engine.dispose();
  });

  it('lays out a sheet, and reports a bad custom size instead of laying it out', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = withDrawing(bracket(), [view('view#1', 'front', { label: 'FRONT' })], {
      titleBlock: {
        fields: [
          { label: 'Title', value: 'Bracket' },
          { label: 'Finish', value: 'oiled' },
        ],
      },
      notes: [{ id: 'note#1', view: 'view#1', position: [0, -20], text: 'BREAK EDGES' }],
    });
    doc = apply(
      doc,
      addDimension({
        id: 'dim#1',
        view: 'view#1',
        kind: 'horizontal',
        refs: [
          {
            vertex: { faces: ['extrude#1:cap:start', 'extrude#1:side:e1', 'extrude#1:side:e4'] },
            body: BODY,
          },
          {
            vertex: { faces: ['extrude#1:cap:start', 'extrude#1:side:e2', 'extrude#1:side:e3'] },
            body: BODY,
          },
        ],
        offset: -10,
      }),
    );
    await engine.regen(doc);
    const sheet = (await engine.drawingSheet(doc, D, S))!;
    expect(sheet.diagnostics.map((d) => d.code)).toEqual(['title-field']);
    expect(sheet.views.map((v) => v.viewId)).toEqual(['view#1']);
    expect(sheet.views[0]!.dimensions[0]!.value).toBeCloseTo(40, 9);
    // The bracket's display units are inches with fractions: 40 mm is 1-9/16".
    const display = sheet.display!;
    expect(display.width).toBeCloseTo(420, 6);
    const texts = display.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    expect(texts).toEqual(
      expect.arrayContaining(['1-9/16"', 'FRONT', 'BREAK EDGES', 'Bracket', '2:1']),
    );
    expect(display.items.some((i) => i.owner === 'dim#1')).toBe(true);
    // The note sits relative to the view's position.
    const note = display.items.find((i) => i.kind === 'text' && i.text === 'BREAK EDGES')!;
    expect(note.kind === 'text' && note.at).toEqual([60, 100]);

    const custom = apply(doc, {
      type: 'editSheet',
      drawingId: D,
      sheetId: S,
      size: { width: mm('#width - 40'), height: mm('200') },
    });
    const bad = (await engine.drawingSheet(custom, D, S))!;
    expect(bad.display).toBeNull();
    expect(bad.diagnostics.map((d) => d.code)).toContain('sheet-size');
    expect(bad.views).toHaveLength(1);
    await engine.dispose();
  });

  it('answers at the client generation, and resolves to null when a newer regen supersedes it', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = withDrawing(bracket(), [view('view#1', 'front')]);
    await engine.regen(doc);
    const generation = engine.generation;
    const v = (await engine.drawingView(doc, D, 'view#1'))!;
    expect(v.generation).toBe(generation);
    expect(engine.generation).toBe(generation);
    expect(await engine.drawingView(doc, D, 'view#1', { generation: generation - 1 })).toBeNull();
    await expect(engine.drawingView(doc, D, 'view#9')).rejects.toThrow(TypeError);
    await engine.dispose();
  });
});
