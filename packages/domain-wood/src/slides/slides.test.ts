// The slide translator in Node, with no kernel: the catalog's data, the two members' boxes and the
// slide's fit against numbers worked out by hand from the boards' frames, the refusals naming the
// numbers, and the cut list's hardware line.

import type { ExtensionFeature } from '@manufakture/core';
import type { ExtrudeInput } from '@manufakture/kernel';
import type { ExtensionContext, ExtensionInputs } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import type { BoardFrame, BoardMetadata } from '../board';
import { cutList } from '../cutlist';
import type { CutListPart } from '../cutlist/input';
import type { Json } from '../migrations';
import { SLIDE_FAMILIES, findSlideFamily } from './catalog';
import { readSlideParams, type SlideParams } from './params';
import { readSlideMetadata, slideType, translateSlide, type SlideMetadata } from './translate';

type V = [number, number, number];
const X: V = [1, 0, 0];
const Y: V = [0, 1, 0];
const Z: V = [0, 0, 1];
const IN = 25.4;

/**
 * A side standing in the YZ plane: from `x` across by `t`, from `y` along by `length`, from `z`
 * up by `height`. Length along +y, width up, thickness along +x.
 */
function side(x: number, t: number, y: number, length: number, z: number, height: number) {
  const frame: BoardFrame = {
    origin: [x, y, z],
    axes: { length: Y, width: Z, thickness: X },
    size: { length, width: height, thickness: t },
  };
  return frame;
}

function boardMeta(frame: BoardFrame): BoardMetadata {
  return {
    form: 'panel',
    stock: 'us-ply-23-32',
    material: 'plywood',
    grain: true,
    frame,
    overridden: { thickness: false, width: false },
  };
}

const expr = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

const SIDE_MOUNT = {
  family: 'side-mount-ball-bearing',
  size: '18in',
  cabinet: 'extension#1',
  drawer: 'extension#2',
  opens: '-y',
};

/** The context regen builds for a slide between the cabinet (`extension#1`) and drawer (`#2`). */
function context(
  params: Json,
  cabinet: BoardFrame,
  drawer: BoardFrame,
  values: Record<string, number> = {},
  extra: Partial<ExtensionFeature> = {},
): ExtensionContext<SlideParams> {
  const read = readSlideParams(params, 1);
  if (!read.ok) throw new Error(read.message);
  const expressions = Object.fromEntries(Object.keys(values).map((k) => [k, expr('0')]));
  return {
    feature: {
      id: 'extension#3',
      kind: 'extension',
      name: 'Slide',
      suppressed: false,
      extension: 'wood.slide',
      schemaVersion: 1,
      operation: 'new',
      dependsOn: ['extension#1', 'extension#2'],
      references: [],
      expressions,
      params: params as ExtensionFeature['params'],
      ...extra,
    },
    params: read.value,
    values,
    references: {},
    data: {},
    sketches: new Map(),
    upstream: new Map([
      ['extension#1', { type: 'wood.board', inputs: [], metadata: boardMeta(cabinet) as never }],
      ['extension#2', { type: 'wood.board', inputs: [], metadata: boardMeta(drawer) as never }],
    ]),
    bodies: ['extension#1', 'extension#2'],
    profile: () => ({ ok: false, message: 'no sketches' }),
  };
}

/** An extrude's box in the model: its profile's rectangle swept along the normal. */
function boxOf(input: ExtrudeInput): { lo: V; hi: V } {
  const p = input.profile as Extract<ExtrudeInput['profile'], { loops: unknown }>;
  const { origin, xDir, normal } = p.frame;
  const y = [
    normal[1] * xDir[2] - normal[2] * xDir[1],
    normal[2] * xDir[0] - normal[0] * xDir[2],
    normal[0] * xDir[1] - normal[1] * xDir[0],
  ];
  const d = input.extent.type === 'blind' ? input.extent.distance : NaN;
  const lo: V = [Infinity, Infinity, Infinity];
  const hi: V = [-Infinity, -Infinity, -Infinity];
  for (const e of p.loops[0]!.entities) {
    if (e.kind !== 'line') throw new Error('expected lines');
    for (const [u, v] of [e.start, e.end]) {
      for (const t of [0, d]) {
        for (let c = 0; c < 3; c++) {
          const w = origin[c]! + u! * xDir[c]! + v! * y[c]! + t * normal[c]!;
          lo[c] = Math.min(lo[c]!, w);
          hi[c] = Math.max(hi[c]!, w);
        }
      }
    }
  }
  return { lo, hi };
}

function built(ctx: ExtensionContext<SlideParams>): {
  cabinet: { lo: V; hi: V };
  drawer: { lo: V; hi: V };
  inputs: ExtrudeInput[];
  meta: SlideMetadata;
} {
  const out = translateSlide(ctx);
  if ('error' in out) throw new Error(out.error);
  const { inputs, metadata } = out as ExtensionInputs;
  expect(inputs).toHaveLength(2);
  const [c, d] = inputs as ExtrudeInput[];
  expect(c).toMatchObject({
    kind: 'extrude',
    id: 'extension#3',
    body: 'extension#3:slide/cabinet',
    capRole: 'cap.cabinet',
    mode: 'new',
  });
  expect(d).toMatchObject({ body: 'extension#3:slide/drawer', capRole: 'cap.drawer' });
  const meta = readSlideMetadata(metadata);
  expect(meta).toBeDefined();
  return { cabinet: boxOf(c!), drawer: boxOf(d!), inputs: [c!, d!], meta: meta! };
}

function refused(ctx: ExtensionContext<SlideParams>) {
  const out = translateSlide(ctx);
  expect(out, JSON.stringify(out)).toHaveProperty('error');
  return out as { error: string; field?: readonly (string | number)[] };
}

const close = (a: readonly number[], b: readonly number[], digits = 6) =>
  a.forEach((x, i) => expect(x, `component ${i} of [${a.join(', ')}]`).toBeCloseTo(b[i]!, digits));

// The cabinet's left side: 18 mm from x = 0, 560 deep from the front (y = 0), 760 tall. A drawer
// side 12 mm thick, 457.2 long, 200 tall from z = 50, 1/2" from the cabinet side.
const CABINET = side(0, 18, 0, 560, 0, 760);
const DRAWER_X = 18 + 12.7;
const DRAWER = side(DRAWER_X, 12, 0, 18 * IN, 50, 200);

describe('the slide catalog', () => {
  it('holds a side-mount series 10" to 28" in 2" steps and an undermount series, all unverified', () => {
    expect(SLIDE_FAMILIES.map((f) => [f.id, f.mount, f.clearance.kind, f.verified])).toEqual([
      ['side-mount-ball-bearing', 'side', 'side-mount', false],
      ['undermount-concealed', 'under', 'undermount', false],
    ]);
    const sideMount = findSlideFamily('side-mount-ball-bearing')!;
    expect(sideMount.sizes.map((s) => s.id)).toEqual(
      [10, 12, 14, 16, 18, 20, 22, 24, 26, 28].map((n) => `${n}in`),
    );
    expect(sideMount.clearance).toEqual({
      kind: 'side-mount',
      side: { nominal: 12.7, min: 12.7, max: 13.5 },
      height: 45.7,
    });
    expect(findSlideFamily('undermount-concealed')!.sizes.map((s) => s.id)).toEqual([
      '9in',
      '12in',
      '15in',
      '18in',
      '21in',
    ]);
    for (const f of SLIDE_FAMILIES) {
      expect(f.source.length).toBeGreaterThan(0);
      for (const s of f.sizes) {
        expect(s.nominal).toBeCloseTo(Number(s.id.replace('in', '')) * IN, 9);
        // Every hole is on its member, front to back.
        for (const [holes, length] of [
          [s.holes.cabinet, s.cabinetLength],
          [s.holes.drawer, s.drawerLength],
        ] as const) {
          expect([...holes].sort((a, b) => a - b)).toEqual(holes);
          for (const h of holes) expect(h).toBeGreaterThan(0);
          for (const h of holes) expect(h).toBeLessThan(length);
        }
        expect(s.minCabinetDepth).toBeGreaterThanOrEqual(s.cabinetLength);
      }
    }
  });
});

describe('params', () => {
  it('names a family, one of its sizes, two boards and the way the drawer opens', () => {
    expect(readSlideParams(SIDE_MOUNT, 1)).toEqual({ ok: true, value: SIDE_MOUNT });
    const bad = (params: Json) => readSlideParams(params, 1);
    expect(bad({ ...SIDE_MOUNT, family: 'drawer-glide' })).toMatchObject({
      ok: false,
      field: ['family'],
    });
    expect(bad({ ...SIDE_MOUNT, size: '19in' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('"10in", "12in"') as string,
      field: ['size'],
    });
    expect(bad({ ...SIDE_MOUNT, drawer: 'extension#1' })).toMatchObject({
      ok: false,
      field: ['drawer'],
    });
    expect(bad({ ...SIDE_MOUNT, opens: 'out' })).toMatchObject({ ok: false, field: ['opens'] });
    expect(bad({ ...SIDE_MOUNT, colour: 'zinc' })).toMatchObject({ ok: false, field: ['colour'] });
    expect(bad({ ...SIDE_MOUNT, cabinet: 'side' })).toMatchObject({
      ok: false,
      field: ['cabinet'],
    });
  });

  it('declares its id fields and expressions', () => {
    expect(slideType.idFields).toEqual([
      { path: ['cabinet'], kind: 'feature' },
      { path: ['drawer'], kind: 'feature' },
    ]);
    expect(slideType.expressions).toEqual({ setback: 'length', offset: 'length' });
  });
});

describe('a side-mount slide', () => {
  it('fills the 1/2" gap with two members, the slide closed, centred on the drawer side', () => {
    const { cabinet, drawer, meta } = built(context(SIDE_MOUNT, CABINET, DRAWER));
    const z0 = 150 - 45.7 / 2;
    const z1 = 150 + 45.7 / 2;
    // From the front (y = 0) back 450 mm, the 18" slide's closed length.
    close(cabinet.lo, [18, 0, z0]);
    close(cabinet.hi, [18 + 6.35, 450, z1]);
    close(drawer.lo, [18 + 6.35, 0, z0]);
    close(drawer.hi, [DRAWER_X, 450, z1]);
    expect(meta).toMatchObject({
      kind: 'slide',
      family: 'side-mount-ball-bearing',
      size: '18in',
      item: 'Drawer slide, side-mount ball-bearing, full extension',
      cabinet: 'extension#1',
      drawer: 'extension#2',
      bodies: { cabinet: 'extension#3:slide/cabinet', drawer: 'extension#3:slide/drawer' },
      travel: 457,
      opens: [0, -1, 0],
      requires: [],
      verified: false,
    });
    expect(meta.nominal).toBeCloseTo(457.2, 9);
    expect(meta.fit).toMatchObject({
      gap: 12.7,
      required: 12.7,
      tolerance: 0.8,
      sideThickness: 12,
      height: 45.7,
      setback: 0,
      cabinetLength: 450,
      drawerLength: 450,
    });
    // The holes: on the cabinet side's face and the drawer side's, at the slide's centre line,
    // measured back from its front.
    expect(meta.holes.cabinet).toEqual([35, 163, 320, 392].map((y) => [18, y, 150]));
    expect(meta.holes.drawer).toEqual([35, 163, 224, 352].map((y) => [DRAWER_X, y, 150]));
  });

  it("names its members' faces under its own id", () => {
    const { inputs } = built(context(SIDE_MOUNT, CABINET, DRAWER));
    const ids = inputs.map((i) =>
      'loops' in i.profile ? i.profile.loops[0]!.entities.map((e) => e.id) : [],
    );
    expect(ids).toEqual([
      ['cabinet.bottom', 'cabinet.back', 'cabinet.top', 'cabinet.front'],
      ['drawer.bottom', 'drawer.back', 'drawer.top', 'drawer.front'],
    ]);
  });

  it('sits on the right of a drawer too, set back and raised, opening along +x', () => {
    // Turned: the drawer opens towards +x, its sides lying in the XZ plane, thickness along -y,
    // and the cabinet's side on the drawer side's +y side.
    const xz = (y: number, t: number, x: number, length: number, z: number, height: number) => ({
      origin: [x, y, z] as V,
      axes: { length: X, width: Z, thickness: [0, -1, 0] as V },
      size: { length, width: height, thickness: t },
    });
    // The drawer side from y = -12 to 0, the cabinet side from 13 to 31 (a 13 mm gap).
    const drawer = xz(0, 12, 0, 500, 0, 150);
    const cabinet = xz(31, 18, -40, 600, 0, 150);
    const {
      cabinet: c,
      drawer: d,
      meta,
    } = built(
      context({ ...SIDE_MOUNT, opens: '+x' }, cabinet, drawer, { setback: 20, offset: 10 }),
    );
    // Front at x = 500 - 20; the members split the 13 mm gap.
    close(c.lo, [480 - 450, 13 - 6.5, 85 - 22.85]);
    close(c.hi, [480, 13, 85 + 22.85]);
    close(d.lo, [480 - 450, 0, 85 - 22.85]);
    close(d.hi, [480, 6.5, 85 + 22.85]);
    expect(meta.opens).toEqual([1, 0, 0]);
    expect(meta.fit).toMatchObject({ gap: 13, setback: 20, offset: 10, front: 480 });
    expect(meta.holes.cabinet[0]).toEqual([445, 13, 85]);
  });

  it('refuses a gap out of range, naming the numbers', () => {
    const wide = refused(context(SIDE_MOUNT, CABINET, side(18 + 14, 12, 0, 457.2, 50, 200)));
    expect(wide.error).toBe(
      'the gap between extension#1 and extension#2 is 14 mm, and a side-mount-ball-bearing slide needs 12.7 mm to 13.5 mm: make the drawer wider',
    );
    expect(wide.field).toEqual(['params', 'drawer']);
    const tight = refused(context(SIDE_MOUNT, CABINET, side(18 + 10, 12, 0, 457.2, 50, 200)));
    expect(tight.error).toMatch(/is 10 mm, .*make the drawer narrower/);
    const overlap = refused(context(SIDE_MOUNT, CABINET, side(10, 12, 0, 457.2, 50, 200)));
    expect(overlap.error).toBe(
      'extension#2 overlaps extension#1: the slide needs a gap between them',
    );
  });

  it('refuses a cabinet too shallow and a drawer too short for the size', () => {
    // The guide's bookshelf is 11-1/4" deep: an 18" slide needs 450 mm.
    const shallow = refused(context(SIDE_MOUNT, side(0, 18, 0, 11.25 * IN, 0, 760), DRAWER));
    expect(shallow.error).toBe(
      'the side-mount-ball-bearing 18in slide needs 450 mm of extension#1 behind its front, and there is 285.75 mm: the cabinet is too shallow for it, so pick a shorter size or a deeper cabinet',
    );
    expect(shallow.field).toEqual(['params', 'size']);
    const short = refused(context(SIDE_MOUNT, CABINET, side(DRAWER_X, 12, 0, 400, 50, 200)));
    expect(short.error).toMatch(/drawer member is 450 mm long, and extension#2 runs only 400 mm/);
    // Set back past the cabinet's front: the slide's front is outside the cabinet.
    const proud = refused(context(SIDE_MOUNT, CABINET, side(DRAWER_X, 12, -30, 500, 50, 200)));
    expect(proud.error).toMatch(/30 mm in front of extension#1's front end: set it back/);
    expect(proud.field).toEqual(['expressions', 'setback']);
  });

  it('refuses boards that do not stand along the travel, and a slide off the drawer side', () => {
    const across = refused(context({ ...SIDE_MOUNT, opens: '+x' }, CABINET, DRAWER));
    expect(across.error).toMatch(/thickness must run along y, and it runs along x/);
    const high = refused(context(SIDE_MOUNT, CABINET, DRAWER, { offset: 90 }));
    expect(high.error).toMatch(/does not fit on it/);
    expect(high.field).toEqual(['expressions', 'offset']);
    const tilted = {
      ...DRAWER,
      axes: { length: Y, width: [0, 0.6, 0.8] as V, thickness: X },
    };
    expect(refused(context(SIDE_MOUNT, CABINET, tilted)).error).toMatch(/not square to the world/);
  });

  it('refuses another operation, a scope, an expression it does not read and a missing board', () => {
    expect(refused(context(SIDE_MOUNT, CABINET, DRAWER, {}, { operation: 'add' })).error).toMatch(
      /operation must be "new"/,
    );
    expect(
      refused(context(SIDE_MOUNT, CABINET, DRAWER, {}, { scope: ['extension#1'] })).field,
    ).toEqual(['scope']);
    const under = { ...SIDE_MOUNT, family: 'undermount-concealed' };
    expect(refused(context(under, CABINET, DRAWER, { offset: 1 })).error).toBe(
      'an undermount slide has no "offset" value',
    );
    const ctx = context(SIDE_MOUNT, CABINET, DRAWER);
    expect(refused({ ...ctx, bodies: ['extension#1'] }).field).toEqual(['params', 'drawer']);
    expect(refused({ ...ctx, upstream: new Map() }).field).toEqual(['dependsOn']);
  });
});

describe('an undermount slide', () => {
  const UNDER = { ...SIDE_MOUNT, family: 'undermount-concealed' };
  // A 16 mm drawer side 5 mm from the cabinet side (21 mm to its inner face), its bottom edge at
  // z = 50, 457 mm long for the 18" runner.
  const drawer16 = (gap = 5, z = 50, t = 16) => side(18 + gap, t, 0, 457, z, 150);

  it('puts the runner under the drawer side and the rail in the bottom recess', () => {
    const { cabinet, drawer, meta } = built(context(UNDER, CABINET, drawer16()));
    // The runner: 37 mm in from the cabinet side, in the 14 mm under the drawer side, 471 long.
    close(cabinet.lo, [18, 0, 36]);
    close(cabinet.hi, [55, 471, 50]);
    // The rail: from the drawer side's inner face to the runner's reach, 13 mm up, 457 long.
    close(drawer.lo, [39, 0, 50]);
    close(drawer.hi, [55, 457, 63]);
    expect(meta.fit).toMatchObject({
      gap: 5,
      required: 5,
      tolerance: 1.5,
      sideThickness: 16,
      bottomRecess: 13,
      bottomClearance: 14,
      backNotchWidth: 35,
      backNotchHeight: 13,
      cabinetLength: 471,
      drawerLength: 457,
    });
    expect(meta.holes).toEqual({ cabinet: [261, 453].map((y) => [18, y, 43]), drawer: [] });
    expect(meta.requires).toEqual([
      "Recess the drawer bottom at least 13 mm above the sides' bottom edges",
      'Notch the drawer back 35 mm wide by 13 mm high at each bottom corner',
      'Leave at least 6 mm above the drawer sides',
      "Bore the locking devices under the drawer front and the rear hooks in the drawer back from the maker's template",
    ]);
    expect(meta.item).toBe(
      'Drawer slide, undermount concealed, full extension (with locking devices)',
    );
  });

  it('takes the gap from the side thickness: a 13 mm side 8 mm off the cabinet', () => {
    expect(built(context(UNDER, CABINET, drawer16(8, 50, 13))).meta.fit).toMatchObject({
      gap: 8,
      required: 8,
    });
    // Within the locking device's 1.5 mm.
    expect(built(context(UNDER, CABINET, drawer16(6.5))).meta.fit.gap).toBe(6.5);
  });

  it('refuses a side too thick, a gap off its side thickness and a runner below the cabinet', () => {
    expect(refused(context(UNDER, CABINET, drawer16(5, 50, 19))).error).toBe(
      'extension#2 is 19 mm thick, and an undermount-concealed slide takes drawer sides 12 mm to 16 mm thick',
    );
    expect(refused(context(UNDER, CABINET, drawer16(12.7))).error).toBe(
      "the gap between extension#1 and extension#2 is 12.7 mm, and with a 16 mm drawer side an undermount-concealed slide needs 5 mm (within 1.5 mm): the drawer's inside is 42 mm narrower than the opening",
    );
    const low = refused(context(UNDER, side(0, 18, 0, 560, 40, 700), drawer16()));
    expect(low.error).toBe(
      'the runner needs 14 mm under extension#2, down to 36 mm, and extension#1 ends at 40 mm: raise the drawer',
    );
    // An 18" runner needs 480 mm of cabinet behind its front.
    expect(refused(context(UNDER, side(0, 18, 0, 470, 0, 760), drawer16())).error).toMatch(
      /needs 480 mm of extension#1 behind its front, and there is 470 mm/,
    );
  });
});

describe('the cut list', () => {
  const part = (metas: SlideMetadata[]): CutListPart => ({
    id: 'part#1',
    bodies: [
      { bodyId: 'extension#1', creator: 'extension#1' },
      { bodyId: 'extension#2', creator: 'extension#2' },
      ...metas.flatMap((m, i) => [
        { bodyId: m.bodies.cabinet, creator: `extension#${3 + i}`, material: 'steel' },
        { bodyId: m.bodies.drawer, creator: `extension#${3 + i}` },
      ]),
    ],
    features: [
      { featureId: 'extension#1', metadata: boardMeta(CABINET) },
      { featureId: 'extension#2', metadata: boardMeta(DRAWER) },
      ...metas.map((m, i) => ({ featureId: `extension#${3 + i}`, metadata: m })),
    ],
  });
  const slide = (id: string) => {
    const ctx = context(SIDE_MOUNT, CABINET, DRAWER);
    const out = translateSlide({ ...ctx, feature: { ...ctx.feature, id } }) as ExtensionInputs;
    return readSlideMetadata(out.metadata)!;
  };

  it('counts each slide as a hardware line, and lists or excludes neither member', () => {
    const list = cutList({ parts: [part([slide('extension#3'), slide('extension#4')])] });
    expect(list.excluded).toEqual([]);
    expect(list.rows.map((r) => r.kind)).toEqual(['board', 'board']);
    expect(list.hardware).toEqual([
      expect.objectContaining({
        key: 'hardware|slide|side-mount-ball-bearing|18in',
        kind: 'hardware',
        category: 'hardware',
        item: 'Drawer slide, side-mount ball-bearing, full extension',
        quantity: 2,
        unit: 'each',
        sources: [
          { id: 'extension#3', part: 'part#1', quantity: 1 },
          { id: 'extension#4', part: 'part#1', quantity: 1 },
        ],
      }),
    ]);
    expect(list.hardware[0]!.size!.length).toBeCloseTo(457.2, 9);
    expect(list.totals.find((t) => t.group === 'hardware')).toMatchObject({ quantity: 2 });
  });

  it('counts a slide once through an assembly that splits its members between instances', () => {
    const m = slide('extension#3');
    const list = cutList({
      parts: [part([m])],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1', bodies: ['extension#1', m.bodies.cabinet] },
          { id: 'inst#2', part: 'part#1', bodies: ['extension#2', m.bodies.drawer] },
        ],
      },
    });
    expect(list.hardware.map((h) => h.quantity)).toEqual([1]);
    // Two cabinets, each showing all of it: two slides.
    const twice = cutList({
      parts: [part([m])],
      assembly: {
        instances: [
          { id: 'inst#1', part: 'part#1' },
          { id: 'inst#2', part: 'part#1' },
        ],
      },
    });
    expect(twice.hardware.map((h) => h.quantity)).toEqual([2]);
  });

  it('reads only well-formed slide metadata', () => {
    const m = slide('extension#3');
    expect(readSlideMetadata(m)).toEqual(m);
    expect(readSlideMetadata({ ...m, kind: 'joint' })).toBeUndefined();
    expect(readSlideMetadata({ ...m, holes: { cabinet: [[1, 2]], drawer: [] } })).toBeUndefined();
    expect(readSlideMetadata({ ...m, fit: { gap: '12.7' } })).toBeUndefined();
    expect(readSlideMetadata(null)).toBeUndefined();
  });
});
