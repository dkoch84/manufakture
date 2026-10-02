import type { ExtensionFeature, StoredExpression } from '@manufakture/core';
import type { ExtrudeInput, ProfileEntity, SketchProfile, Vec3 } from '@manufakture/kernel';
import type { ExtensionContext, ExtensionInputs, SketchResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import {
  BOARD_SCHEMA_VERSION,
  JUSTIFY,
  boardType,
  readBoardMetadata,
  readBoardParams,
  translateBoard,
  type BoardMetadata,
  type BoardParams,
} from './board';
import type { Json } from './migrations';
import { readStockData, type StockData } from './stock-data';

const IN = 25.4;
// A JSON-shaped expression (an inferred type, so it also fits where stored JSON is expected).
const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

/** Evaluated values as regen would pass them for the expressions above (mm, radians). */
type Values = Record<string, number>;

interface Placement {
  origin: Vec3;
  normal: Vec3;
  xDir: Vec3;
}
const XY: Placement = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };

function line(id: string, start: [number, number], end: [number, number]) {
  return { id, kind: 'line' as const, construction: false, start, end };
}

/** A w x h rectangle at (x, y): e1 along +x at the bottom, e2 up, e3 back, e4 down. */
function rectangle(w: number, h: number, x = 0, y = 0) {
  return [
    line('e1', [x, y], [x + w, y]),
    line('e2', [x + w, y], [x + w, y + h]),
    line('e3', [x + w, y + h], [x, y + h]),
    line('e4', [x, y + h], [x, y]),
  ];
}

function sketch(entities: ReturnType<typeof line>[], placement: Placement = XY): SketchResult {
  return {
    placement,
    entities,
    regions: [],
    voids: [],
    diagnostics: [],
    outlines: [],
  } as unknown as SketchResult;
}

function feature(
  params: Json,
  expressions: Record<string, StoredExpression> = {},
): ExtensionFeature {
  return {
    id: 'extension#1',
    kind: 'extension',
    name: 'Board 1',
    suppressed: false,
    extension: 'wood.board',
    schemaVersion: 1,
    dependsOn: ['sketch#1'],
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    operation: 'new',
  };
}

/**
 * The context regen builds, by hand: params read by the type, the sketch solved, and a profile
 * made of the sketch's lines as one loop (enough for the rectangles here).
 */
function context(
  f: ExtensionFeature,
  s: SketchResult,
  options: { values?: Values; stock?: StockData; regions?: number } = {},
): ExtensionContext<BoardParams> {
  const params = readBoardParams(f.params as Json, f.schemaVersion);
  if (!params.ok) throw new Error(params.message);
  const data: Record<string, unknown> = {};
  if (options.stock) data.stock = options.stock;
  return {
    feature: f,
    params: params.value,
    values: options.values ?? {},
    references: {},
    data,
    sketches: new Map([['sketch#1', s]]),
    upstream: new Map(),
    bodies: [],
    profile(sketchId, entities) {
      const sk = sketchId === 'sketch#1' ? s : undefined;
      if (!sk) return { ok: false, message: `${sketchId} is not a solved sketch` };
      const loop: ProfileEntity[] = sk.entities
        .filter((e) => e.kind === 'line' && (!entities || entities.includes(e.id)))
        .map((e) => {
          const l = e as ReturnType<typeof line>;
          return { id: l.id, kind: 'line', start: l.start, end: l.end };
        });
      const frame = {
        origin: sk.placement.origin,
        xDir: sk.placement.xDir,
        normal: sk.placement.normal,
      };
      const value: SketchProfile =
        (options.regions ?? 1) === 1
          ? { frame, loops: [{ entities: loop }] }
          : {
              frame,
              regions: Array.from({ length: options.regions! }, () => ({
                loops: [{ entities: loop }],
              })),
            };
      return { ok: true, value };
    },
  };
}

function built(ctx: ExtensionContext<BoardParams>): { input: ExtrudeInput; meta: BoardMetadata } {
  const out = translateBoard(ctx);
  if ('error' in out) throw new Error(out.error);
  const { inputs, metadata } = out as ExtensionInputs;
  expect(inputs).toHaveLength(1);
  const meta = readBoardMetadata(metadata);
  expect(meta).toBeDefined();
  return { input: inputs[0] as ExtrudeInput, meta: meta! };
}

function stockData(overrides: Json): StockData {
  const r = readStockData({ overrides }, 1);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((x, i) => expect(x, `component ${i}`).toBeCloseTo(b[i]!, 9));

const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
/** The frame is right-handed: length x width = thickness. */
const rightHanded = (meta: BoardMetadata) =>
  close(cross(meta.frame.axes.length, meta.frame.axes.width), meta.frame.axes.thickness);

describe('wood.board params', () => {
  it('reads panels and sticks with their defaults', () => {
    expect(
      readBoardParams({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1' }, 1),
    ).toEqual({
      ok: true,
      value: {
        form: 'panel',
        stock: 'us-ply-23-32',
        sketch: 'sketch#1',
        grain: { type: 'longest' },
        flip: false,
      },
    });
    expect(
      readBoardParams(
        {
          form: 'panel',
          stock: 'mm-ply-18',
          sketch: 'sketch#2',
          entities: ['e1', 'e2'],
          grain: { type: 'line', entity: 'e7' },
          flip: true,
        },
        1,
      ),
    ).toMatchObject({ ok: true, value: { entities: ['e1', 'e2'], flip: true } });
    expect(
      readBoardParams({ form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1' }, 1),
    ).toEqual({
      ok: true,
      value: {
        form: 'stick',
        stock: 'us-2x4',
        sketch: 'sketch#1',
        line: 'e1',
        justify: { thickness: 'centre', width: 'centre' },
      },
    });
  });

  it('refuses malformed params with the field at fault', () => {
    const bad = (p: Json) => readBoardParams(p, 1);
    expect(bad({ form: 'slab', stock: 'us-2x4', sketch: 'sketch#1' })).toMatchObject({
      ok: false,
      field: ['form'],
    });
    expect(bad({ form: 'stick', stock: 'us-3x1', sketch: 'sketch#1', line: 'e1' })).toMatchObject({
      ok: false,
      field: ['stock'],
      message: expect.stringContaining('us-3x1'),
    });
    // A stick is cut from lumber; sheet stock is refused with what to do instead.
    expect(
      bad({ form: 'stick', stock: 'us-ply-23-32', sketch: 'sketch#1', line: 'e1' }),
    ).toMatchObject({
      ok: false,
      field: ['stock'],
      message: expect.stringContaining('is sheet stock: a stick is cut from lumber'),
    });
    // A panel may be cut from lumber (a glue-up): it takes the board's thickness.
    expect(
      readBoardParams({ form: 'panel', stock: 'us-1x12', sketch: 'sketch#1' }, 1),
    ).toMatchObject({ ok: true });
    expect(bad({ form: 'stick', stock: 'us-2x4', sketch: 'extrude', line: 'e1' })).toMatchObject({
      ok: false,
      field: ['sketch'],
    });
    expect(bad({ form: 'stick', stock: 'us-2x4', sketch: 'sketch#1' })).toMatchObject({
      ok: false,
      field: ['line'],
    });
    expect(
      bad({ form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1', grain: {} }),
    ).toMatchObject({ ok: false, field: ['grain'] });
    expect(
      bad({
        form: 'stick',
        stock: 'us-2x4',
        sketch: 'sketch#1',
        line: 'e1',
        justify: { width: 'top' },
      }),
    ).toMatchObject({ ok: false, field: ['justify', 'width'] });
    expect(
      bad({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1', entities: [] }),
    ).toMatchObject({ ok: false, field: ['entities'] });
    expect(
      bad({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1', grain: { type: 'line' } }),
    ).toMatchObject({ ok: false, field: ['grain', 'entity'] });
    expect(
      bad({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1', flip: 'yes' }),
    ).toMatchObject({ ok: false, field: ['flip'] });
    expect(bad([])).toMatchObject({ ok: false });
    expect(readBoardParams({}, BOARD_SCHEMA_VERSION + 1)).toMatchObject({
      ok: false,
      message: expect.stringContaining('newer'),
    });
  });

  it('is what the registered type checks params with', () => {
    expect(boardType.schemaVersion).toBe(1);
    expect(boardType.params!({ form: 'stick' }, 1)).toMatchObject({ ok: false });
  });
});

describe('wood.board translator', () => {
  it('builds a 2x4 stick 8 ft along x as a 38.1 x 88.9 mm section extruded 2438.4 mm', () => {
    const f = feature({ form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1' });
    const { input, meta } = built(context(f, sketch([line('e1', [0, 0], [96 * IN, 0])])));
    expect(input.kind).toBe('extrude');
    expect(input.id).toBe('extension#1');
    expect(input.mode).toBe('new');
    expect(input.extent).toEqual({ type: 'blind', distance: 96 * IN });
    expect(input.extent).toEqual({ type: 'blind', distance: expect.closeTo(2438.4, 9) });
    const profile = input.profile as Extract<SketchProfile, { loops: unknown }>;
    expect(profile.frame.normal).toEqual([1, 0, 0]);
    expect(profile.frame.origin).toEqual([0, 0, 0]);
    // Thickness to the left of the line (+y), width along the sketch normal (+z), centred.
    close(profile.frame.xDir, [0, 1, 0]);
    const ents = profile.loops[0]!.entities as Extract<ProfileEntity, { kind: 'line' }>[];
    expect(ents.map((e) => e.id)).toEqual(['w1', 't1', 'w0', 't0']);
    close(ents[0]!.start, [-19.05, -44.45]);
    close(ents[1]!.end, [19.05, 44.45]);
    // Face ids follow the reported frame, low to high on each axis: t0 at the low thickness end
    // (section x -19.05), w0 at the low end of the frame's width axis (-z), which is the section's
    // high y (+44.45, world z = +44.45) because the section's y is that axis reversed.
    const at = (id: string) => ents.find((e) => e.id === id)!;
    expect(at('t0').start[0]).toBeCloseTo(-19.05, 9);
    expect(at('t1').start[0]).toBeCloseTo(19.05, 9);
    expect(at('w0').start[1]).toBeCloseTo(44.45, 9);
    expect(at('w1').start[1]).toBeCloseTo(-44.45, 9);
    // The section is 38.1 by 88.9.
    expect(ents[0]!.end[0] - ents[0]!.start[0]).toBeCloseTo(38.1, 9);
    expect(ents[1]!.end[1] - ents[1]!.start[1]).toBeCloseTo(88.9, 9);

    expect(meta.form).toBe('stick');
    expect(meta.stock).toBe('us-2x4');
    expect(meta.material).toBe('pine');
    expect(meta.grain).toBe(true);
    close(meta.frame.axes.length, [1, 0, 0]);
    close(meta.frame.axes.thickness, [0, 1, 0]);
    // Width is -z, so length x width = thickness; the origin is the min corner in that frame.
    close(meta.frame.axes.width, [0, 0, -1]);
    close(meta.frame.origin, [0, -19.05, 44.45]);
    rightHanded(meta);
    expect(meta.frame.size.length).toBeCloseTo(2438.4, 9);
    expect(meta.frame.size.width).toBeCloseTo(88.9, 9);
    expect(meta.frame.size.thickness).toBeCloseTo(38.1, 9);
    expect(meta.overridden).toEqual({ thickness: false, width: false });
  });

  it('turns a stick about its line and justifies it flush to a face', () => {
    const f = feature(
      {
        form: 'stick',
        stock: 'us-2x4',
        sketch: 'sketch#1',
        line: 'e1',
        justify: { thickness: 'positive', width: 'negative' },
      },
      { rotation: mm('90deg') },
    );
    const s = sketch([line('e1', [10, 20], [10, 20 + 1000])]);
    const { input, meta } = built(context(f, s, { values: { rotation: Math.PI / 2 } }));
    const profile = input.profile as Extract<SketchProfile, { loops: unknown }>;
    // Line along +y; at no rotation thickness is n x d = z x y = -x; turned 90 deg it is +z.
    close(profile.frame.normal, [0, 1, 0]);
    close(profile.frame.xDir, [0, 0, 1]);
    close(meta.frame.axes.thickness, [0, 0, 1]);
    close(meta.frame.axes.width, [-1, 0, 0]);
    rightHanded(meta);
    // Thickness from the line up (positive), the section's width ending at the line (negative):
    // the blank spans x from 10 - 88.9 to 10, and the frame's width axis runs toward -x from 10.
    close(meta.frame.origin, [10, 20, 0]);
    expect(meta.frame.size.length).toBeCloseTo(1000, 9);
  });

  it('places a stick on a sketch plane that is not XY, with a length and width of its own', () => {
    // A sketch on the XZ plane: x along +x, normal -y, so sketch y is +z.
    const XZ: Placement = { origin: [0, 0, 5], normal: [0, -1, 0], xDir: [1, 0, 0] };
    const f = feature(
      { form: 'stick', stock: 'us-hw-4-4', sketch: 'sketch#1', line: 'e1' },
      { length: mm('600'), width: mm('100') },
    );
    const s = sketch([line('e1', [0, 0], [0, 50])], XZ);
    const { input, meta } = built(context(f, s, { values: { length: 600, width: 100 } }));
    expect(input.extent).toEqual({ type: 'blind', distance: 600 });
    close(meta.frame.axes.length, [0, 0, 1]);
    expect(meta.frame.size).toEqual({ length: 600, width: 100, thickness: (13 / 16) * IN });
    expect(meta.overridden.width).toBe(true);
    expect(meta.material).toBe('oak');
  });

  it('builds a 3/4" plywood panel from a 600 x 300 mm region, exactly 23/32" thick', () => {
    const f = feature({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1' });
    const { input, meta } = built(context(f, sketch(rectangle(600, 300))));
    expect(input.extent.type).toBe('blind');
    expect((input.extent as { distance: number }).distance).toBeCloseTo(18.25625, 12);
    expect(input.reverse).toBeUndefined();
    // The grain defaults to the longest side: along x.
    close(meta.frame.axes.length, [1, 0, 0]);
    close(meta.frame.axes.width, [0, 1, 0]);
    close(meta.frame.axes.thickness, [0, 0, 1]);
    close(meta.frame.origin, [0, 0, 0]);
    expect(meta.frame.size).toEqual({ length: 600, width: 300, thickness: (23 / 32) * IN });
  });

  it('runs the grain along the longest side, a sketch line or an angle', () => {
    const tall = sketch(rectangle(300, 800, 50, 0));
    const longest = built(
      context(feature({ form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#1' }), tall),
    ).meta;
    close(longest.frame.axes.length, [0, 1, 0]);
    close(longest.frame.axes.width, [-1, 0, 0]);
    expect(longest.frame.size).toEqual({ length: 800, width: 300, thickness: 18 });
    close(longest.frame.origin, [350, 0, 0]);

    const across = built(
      context(
        feature({
          form: 'panel',
          stock: 'mm-ply-18',
          sketch: 'sketch#1',
          grain: { type: 'line', entity: 'e1' },
        }),
        tall,
      ),
    ).meta;
    close(across.frame.axes.length, [1, 0, 0]);
    expect(across.frame.size.length).toBe(300);
    expect(across.frame.size.width).toBe(800);

    const angled = built(
      context(
        feature(
          { form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#1', grain: { type: 'angle' } },
          { grainAngle: mm('45deg') },
        ),
        sketch(rectangle(100, 100)),
        { values: { grainAngle: Math.PI / 4 } },
      ),
    ).meta;
    close(angled.frame.axes.length, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(angled.frame.size.length).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(angled.frame.size.width).toBeCloseTo(100 * Math.SQRT2, 9);
  });

  it('flips a panel against the sketch normal and keeps its frame right-handed', () => {
    const f = feature({ form: 'panel', stock: 'mm-mdf-18', sketch: 'sketch#1', flip: true });
    const { input, meta } = built(context(f, sketch(rectangle(600, 300))));
    expect(input.reverse).toBe(true);
    close(meta.frame.axes.thickness, [0, 0, -1]);
    close(meta.frame.axes.width, [0, -1, 0]);
    close(meta.frame.origin, [0, 300, 0]);
    expect(meta.grain).toBe(false);
    expect(meta.material).toBe('mdf');
  });

  it('uses the document thickness override and reports it', () => {
    const f = feature({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1' });
    const stock = stockData({ 'us-ply-23-32': { thickness: mm('18.2mm') } });
    const { input, meta } = built(context(f, sketch(rectangle(600, 300)), { stock }));
    expect(input.extent).toEqual({ type: 'blind', distance: 18.2 });
    expect(meta.frame.size.thickness).toBe(18.2);
    expect(meta.overridden.thickness).toBe(true);

    // An override of another stock, or a price, changes nothing a board builds.
    const other = stockData({
      'us-2x4': { thickness: mm('40') },
      'us-ply-23-32': { price: { amount: 60, per: 'sheet' } },
    });
    const plain = built(context(f, sketch(rectangle(600, 300)))).input;
    expect(built(context(f, sketch(rectangle(600, 300)), { stock: other })).input).toEqual(plain);

    // A stick follows its stock's thickness and width overrides.
    const stick = feature({ form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1' });
    const measured = stockData({ 'us-2x4': { thickness: mm('38'), width: mm('89') } });
    const s = built(context(stick, sketch([line('e1', [0, 0], [100, 0])]), { stock: measured }));
    expect(s.meta.frame.size).toEqual({ length: 100, width: 89, thickness: 38 });
    expect(s.meta.overridden).toEqual({ thickness: true, width: true });
  });

  it('refuses what it cannot build, naming the field', () => {
    const rect = sketch(rectangle(600, 300));
    const panel = feature({ form: 'panel', stock: 'us-ply-23-32', sketch: 'sketch#1' });
    expect(translateBoard(context({ ...panel, operation: 'add' }, rect))).toMatchObject({
      field: ['operation'],
    });
    const noOp: ExtensionFeature = { ...panel };
    delete noOp.operation;
    expect(translateBoard(context(noOp, rect))).toMatchObject({ field: ['operation'] });
    expect(
      translateBoard(context({ ...panel, expressions: { rotation: mm('1') } }, rect)),
    ).toMatchObject({ field: ['expressions', 'rotation'] });
    expect(translateBoard(context(panel, rect, { regions: 2 }))).toMatchObject({
      error: expect.stringContaining('one region'),
    });
    const other = { ...context(panel, rect), sketches: new Map() };
    expect(translateBoard(other)).toMatchObject({ field: ['dependsOn'] });
    expect(
      translateBoard(
        context(
          feature({
            form: 'panel',
            stock: 'us-ply-23-32',
            sketch: 'sketch#1',
            grain: { type: 'line', entity: 'e9' },
          }),
          rect,
        ),
      ),
    ).toMatchObject({ field: ['params', 'grain', 'entity'] });
    expect(
      translateBoard(
        context(
          feature({
            form: 'panel',
            stock: 'us-ply-23-32',
            sketch: 'sketch#1',
            grain: { type: 'angle' },
          }),
          rect,
        ),
      ),
    ).toMatchObject({ field: ['expressions', 'grainAngle'] });

    const stick = (stock: string) =>
      feature({ form: 'stick', stock, sketch: 'sketch#1', line: 'e1' });
    expect(
      translateBoard(context(stick('us-2x4'), sketch([line('e2', [0, 0], [1, 0])]))),
    ).toMatchObject({ field: ['params', 'line'] });
    expect(
      translateBoard(context(stick('us-2x4'), sketch([line('e1', [3, 3], [3, 3])]))),
    ).toMatchObject({ field: ['params', 'line'] });
    expect(
      translateBoard(context(stick('us-hw-8-4'), sketch([line('e1', [0, 0], [100, 0])]))),
    ).toMatchObject({
      field: ['expressions', 'width'],
      error: expect.stringContaining('random widths'),
    });
    // The translator refuses sheet stock too, should it get params regen did not check.
    const sheetCtx = context(stick('us-2x4'), sketch([line('e1', [0, 0], [100, 0])]));
    expect(
      translateBoard({ ...sheetCtx, params: { ...sheetCtx.params, stock: 'us-ply-23-32' } }),
    ).toMatchObject({
      field: ['params', 'stock'],
      error: expect.stringContaining('is sheet stock: a stick is cut from lumber (draw a panel'),
    });
    expect(
      translateBoard(
        context(stick('us-2x4'), sketch([line('e1', [0, 0], [100, 0])]), {
          values: { length: -5 },
        }),
      ),
    ).toMatchObject({ field: ['expressions', 'length'] });
  });

  it("reports a right-handed frame whose origin is the blank's min corner", () => {
    const dot = (a: readonly number[], b: readonly number[]) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const XZ: Placement = { origin: [0, 0, 5], normal: [0, -1, 0], xDir: [1, 0, 0] };
    const s = (placement: Placement) => sketch([line('e1', [3, 4], [403, 304])], placement);
    for (const placement of [XY, XZ]) {
      for (const rotation of [0, 0.4, Math.PI / 2, 2.5]) {
        for (const thickness of JUSTIFY) {
          for (const width of JUSTIFY) {
            const f = feature(
              {
                form: 'stick',
                stock: 'us-2x6',
                sketch: 'sketch#1',
                line: 'e1',
                justify: { thickness, width },
              },
              { rotation: mm(`${rotation}rad`) },
            );
            const { input, meta } = built(context(f, s(placement), { values: { rotation } }));
            rightHanded(meta);
            // Every corner of the section lies in the blank: [0, size] along width and thickness.
            const profile = input.profile as Extract<SketchProfile, { loops: unknown }>;
            const { origin, xDir, normal } = profile.frame;
            const yDir = cross(normal, xDir);
            for (const e of profile.loops[0]!.entities as Extract<
              ProfileEntity,
              { kind: 'line' }
            >[]) {
              const p = [0, 1, 2].map(
                (i) =>
                  origin[i]! +
                  xDir[i]! * e.start[0] +
                  yDir[i]! * e.start[1] -
                  meta.frame.origin[i]!,
              );
              for (const axis of ['width', 'thickness'] as const) {
                const at = dot(p, meta.frame.axes[axis]);
                expect(at).toBeGreaterThanOrEqual(-1e-9);
                expect(at).toBeLessThanOrEqual(meta.frame.size[axis] + 1e-9);
              }
            }
          }
        }
      }
    }
    for (const flip of [false, true]) {
      for (const grain of [{ type: 'longest' }, { type: 'line', entity: 'e2' }] as const) {
        const f = feature({ form: 'panel', stock: 'mm-ply-18', sketch: 'sketch#1', grain, flip });
        rightHanded(built(context(f, sketch(rectangle(300, 800, 50, 0)))).meta);
      }
    }
  });

  it('is deterministic and returns plain data', () => {
    const f = feature({ form: 'stick', stock: 'us-2x6', sketch: 'sketch#1', line: 'e1' });
    const s = sketch([line('e1', [0, 0], [1200, 900])]);
    const a = translateBoard(context(f, s));
    const b = translateBoard(context(f, s));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a).toEqual(b);
    expect(boardType.translate(context(f, s), [])).toEqual(a);
  });

  it('reads board metadata back and refuses anything else', () => {
    expect(readBoardMetadata(null)).toBeUndefined();
    expect(readBoardMetadata({ form: 'panel' })).toBeUndefined();
    const { meta } = built(
      context(
        feature({ form: 'panel', stock: 'mm-ply-12', sketch: 'sketch#1' }),
        sketch(rectangle(10, 20)),
      ),
    );
    expect(
      readBoardMetadata({ ...meta, frame: { ...meta.frame, origin: [0, 0] } }),
    ).toBeUndefined();
  });
});
