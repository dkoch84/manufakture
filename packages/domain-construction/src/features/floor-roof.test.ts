// The floor and roof features without a kernel (M6 plan T6.1c): their params readers, the ring the
// walls close, the translators against a hand-built context (outlines from points and a sketch,
// joist direction, the bounds that keep a document from hanging the worker), and the sheathing
// planes' hand-computed areas.

import type { ExtensionFeature } from '@manufakture/core';
import type { SketchProfile } from '@manufakture/kernel';
import type { ExtensionContext, ExtensionUpstream } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { readConstructionData, type ConstructionData } from '../data';
import { constructionDomain } from '../domain';
import { frameFloor } from '../framing/floor';
import { countByRole } from '../members';
import { faceArea } from '../takeoff/faces';
import { roofSheathingFaces } from '../takeoff';
import { inch } from '../test-helpers';
import type { WallMetadata } from './common';
import {
  FLOOR_EXPRESSIONS,
  FLOOR_SCHEMA_VERSION,
  MAX_FLOOR_SLOTS,
  MAX_OUTLINE_POINTS,
  exteriorRing,
  readFloorMetadata,
  readFloorParams,
  translateFloor,
  type FloorParams,
} from './floor';
import {
  ROOF_EXPRESSIONS,
  ROOF_SCHEMA_VERSION,
  readRoofMetadata,
  readRoofParams,
  sheathingArea,
  sheathingOutlines,
  translateRoof,
  type RoofParams,
} from './roof';

const ins = (v: number | string) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});

const DATA = (() => {
  const r = readConstructionData(
    {
      levels: [{ id: 'level-1', name: 'Level 1', elevation: ins(0), height: ins(97.125) }],
      floorTypes: [
        { id: 'shed-floor', name: 'Shed floor', joistStock: 'us-2x6', subfloor: 'us-osb-23-32' },
      ],
      roofTypes: [
        {
          id: 'shed-roof',
          name: 'Shed roof',
          rafterStock: 'us-2x6',
          ridgeStock: 'us-2x8',
          hipStock: 'us-2x8',
          sheathing: 'us-osb-7-16',
        },
      ],
    },
    1,
  );
  if (!r.ok) throw new Error(r.message);
  return r.value;
})();

function context<P>(
  type: string,
  params: P,
  values: Record<string, number>,
  more: {
    upstream?: Map<string, ExtensionUpstream>;
    dependsOn?: string[];
    profile?: SketchProfile;
    operation?: 'new';
    data?: ConstructionData;
  } = {},
): ExtensionContext<P> {
  const feature = {
    id: 'extension#9',
    kind: 'extension',
    name: 'f',
    suppressed: false,
    extension: type,
    schemaVersion: 1,
    dependsOn: more.dependsOn ?? [...(more.upstream?.keys() ?? [])],
    references: [],
    expressions: Object.fromEntries(Object.keys(values).map((k) => [k, ins(0)])),
    params: {},
    ...(more.operation === undefined ? {} : { operation: more.operation }),
  } as unknown as ExtensionFeature;
  return {
    feature,
    params,
    values,
    references: {},
    data: { construction: more.data ?? DATA },
    sketches: new Map(more.profile ? [['sketch#1', {} as never]] : []),
    upstream: more.upstream ?? new Map(),
    bodies: [],
    profile: () =>
      more.profile ? { ok: true, value: more.profile } : { ok: false, message: 'no sketch' },
  };
}

function wallMeta(points: [number, number][], closed = false): WallMetadata {
  return {
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: inch(97.125),
    points: points.map(([x, y]) => [inch(x), inch(y)]),
    closed,
    justification: 'left',
    thickness: inch(3.5),
    free: { start: false, end: false },
    layers: [],
    settings: {
      studStock: { id: 'us-2x4', name: '2x4', width: inch(1.5), depth: inch(3.5) },
      defaultHeader: {
        stock: { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) },
        plies: 2,
        jacks: 1,
      },
    },
    overrides: [],
  };
}

const upstreamOf = (walls: Record<string, WallMetadata>) =>
  new Map(
    Object.entries(walls).map(([id, meta]) => [
      id,
      { type: 'construction.wall', inputs: [], metadata: meta as never },
    ]),
  );

const FLOOR: FloorParams = {
  level: 'level-1',
  floorType: 'shed-floor',
  outline: 'points',
  points: 4,
  joists: 'short',
  blocking: 'none',
  doubleUnderWalls: true,
  overrides: [],
};

const rect = (w: number, d: number) => ({
  x1: 0,
  y1: 0,
  x2: inch(w),
  y2: 0,
  x3: inch(w),
  y3: inch(d),
  x4: 0,
  y4: inch(d),
});

function floorMeta(ctx: ExtensionContext<FloorParams>) {
  const out = translateFloor(ctx);
  if ('error' in out) throw new Error(out.error);
  return { out, meta: readFloorMetadata(out.metadata)! };
}

function refusal(out: object): { error: string; field?: unknown } {
  expect(out).toHaveProperty('error');
  return out as { error: string; field?: unknown };
}

describe('floor params', () => {
  it('reads the defaults', () => {
    expect(FLOOR_SCHEMA_VERSION).toBe(1);
    expect(
      readFloorParams({ level: 'level-1', floorType: 'shed-floor', outline: 'walls' }, 1),
    ).toEqual({
      ok: true,
      value: {
        level: 'level-1',
        floorType: 'shed-floor',
        outline: 'walls',
        joists: 'short',
        blocking: 'none',
        doubleUnderWalls: true,
        overrides: [],
      },
    });
    expect(FLOOR_EXPRESSIONS.direction).toBe('angle');
    expect(FLOOR_EXPRESSIONS[`x${MAX_OUTLINE_POINTS}`]).toBe('length');
    expect(FLOOR_EXPRESSIONS[`x${MAX_OUTLINE_POINTS + 1}`]).toBeUndefined();
  });

  const base = { level: 'level-1', floorType: 'shed-floor', outline: 'points', points: 4 };
  it.each([
    [{ ...base, outline: 'slab' }, ['outline']],
    [{ ...base, points: 3 }, ['points']],
    [{ ...base, points: MAX_OUTLINE_POINTS + 1 }, ['points']],
    [{ ...base, outline: 'walls' }, ['points']],
    [{ ...base, joists: 'diagonal' }, ['joists']],
    [{ ...base, blocking: 'at' }, ['blocking']],
    [{ ...base, skids: { stock: 'us-4x6', count: 21 } }, ['skids', 'count']],
    [{ ...base, skids: { stock: 'us-4x6' } }, ['skids', 'count']],
    [{ ...base, wall: 'extension#1' }, ['wall']],
  ])('refuses %j at %j', (params, field) => {
    const r = readFloorParams(params, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field ?? []).toEqual(field);
  });
});

describe('roof params', () => {
  it('reads the defaults; the pitch is a slope field', () => {
    expect(ROOF_SCHEMA_VERSION).toBe(1);
    expect(readRoofParams({ roofType: 'shed-roof', kind: 'gable' }, 1)).toEqual({
      ok: true,
      value: {
        roofType: 'shed-roof',
        kind: 'gable',
        ridge: 'long',
        ties: { kind: 'none' },
        gableStuds: true,
        overrides: [],
      },
    });
    expect(readRoofParams({ roofType: 'shed-roof', kind: 'hip' }, 1)).toMatchObject({
      ok: true,
      value: { gableStuds: false },
    });
    expect(ROOF_EXPRESSIONS.pitch).toBe('slope');
    expect(ROOF_EXPRESSIONS.overhang).toBe('length');
  });

  const base = { roofType: 'shed-roof', kind: 'gable' };
  it.each([
    [{ ...base, kind: 'shed' }, ['kind']],
    [{ ...base, kind: 'hip', ridge: 'short' }, ['ridge']],
    [{ ...base, kind: 'hip', gableStuds: true }, ['gableStuds']],
    [{ ...base, ties: { kind: 'rafter-ties', stock: 'us-2x4', every: 11 } }, ['ties', 'every']],
    [{ ...base, ties: { kind: 'none', stock: 'us-2x4' } }, ['ties']],
    [{ ...base, walls: ['extension#1'] }, ['walls']],
  ])('refuses %j at %j', (params, field) => {
    const r = readRoofParams(params, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field ?? []).toEqual(field);
  });
});

describe('the ring walls close', () => {
  it('follows a closed wall on its framing outside', () => {
    const r = exteriorRing(
      [
        {
          id: 'extension#1',
          meta: wallMeta(
            [
              [0, 0],
              [192, 0],
              [192, 144],
              [0, 144],
            ],
            true,
          ),
        },
      ],
      'a floor',
    );
    const expected = [
      [0, 0],
      [192, 0],
      [192, 144],
      [0, 144],
    ];
    r.points.forEach((p, i) => {
      expect(p[0] / inch(1)).toBeCloseTo(expected[i]![0]!, 9);
      expect(p[1] / inch(1)).toBeCloseTo(expected[i]![1]!, 9);
    });
    expect(r.edges.map((e) => e.segment)).toEqual([0, 1, 2, 3]);
  });

  it('chains open walls in any order, and offsets centred framing to its outside', () => {
    const walls = [
      {
        id: 'extension#3',
        meta: wallMeta([
          [192, 0],
          [192, 144],
        ]),
      },
      {
        id: 'extension#1',
        meta: {
          ...wallMeta([
            [0, 0],
            [192, 0],
          ]),
          justification: 'center' as const,
        },
      },
      {
        id: 'extension#4',
        meta: wallMeta([
          [0, 144],
          [0, 0],
        ]),
      },
      {
        id: 'extension#2',
        meta: wallMeta([
          [192, 144],
          [0, 144],
        ]),
      },
    ];
    const r = exteriorRing(walls, 'a roof');
    expect(r.edges.map((e) => e.wall)).toEqual([
      'extension#3',
      'extension#2',
      'extension#4',
      'extension#1',
    ]);
    // Wall 1's centred framing reaches 1-3/4" outside its path.
    const ys = r.points.map((p) => p[1] / inch(1));
    expect(Math.min(...ys)).toBeCloseTo(-1.75, 9);
  });

  it('refuses a wall running the other way, a ring that does not close, and an inward ring', () => {
    expect(() =>
      exteriorRing(
        [
          {
            id: 'extension#1',
            meta: wallMeta([
              [0, 0],
              [192, 0],
            ]),
          },
          {
            id: 'extension#2',
            meta: wallMeta([
              [192, 144],
              [192, 0],
            ]),
          },
        ],
        'a floor',
      ),
    ).toThrow(/runs the other way/);
    expect(() =>
      exteriorRing(
        [
          {
            id: 'extension#1',
            meta: wallMeta([
              [0, 0],
              [192, 0],
            ]),
          },
          {
            id: 'extension#2',
            meta: wallMeta([
              [192, 0],
              [192, 144],
            ]),
          },
        ],
        'a floor',
      ),
    ).toThrow(/do not close/);
    expect(() =>
      exteriorRing(
        [
          {
            id: 'extension#1',
            meta: wallMeta(
              [
                [0, 0],
                [0, 144],
                [192, 144],
                [192, 0],
              ],
              true,
            ),
          },
        ],
        'a floor',
      ),
    ).toThrow(/face into the ring/);
    expect(() => exteriorRing([], 'a floor')).toThrow(/needs the walls/);
  });
});

describe('the floor translator', () => {
  it('frames the T6.2b shed floor from points, joists across the short side', () => {
    const { meta } = floorMeta(context('construction.floor', FLOOR, rect(144, 192)));
    expect(meta.input.direction).toEqual([1, 0]);
    // The subfloor's top is the level: the 2x6 joists' bottoms sit 5-1/2" + 23/32" below.
    expect(meta.input.elevation! / inch(1)).toBeCloseTo(-5.5 - 23 / 32, 9);
    const r = frameFloor(meta.input);
    expect(countByRole(r.members)).toEqual({ joist: 13, rim: 2 });
    expect(r.subfloor!.area).toBeCloseTo(inch(144) * inch(192), 3);
  });

  it('spans the long side when asked, or the direction given', () => {
    const long = floorMeta(
      context('construction.floor', { ...FLOOR, joists: 'long' }, rect(144, 192)),
    ).meta;
    expect(long.input.direction[0]).toBeCloseTo(0, 12);
    expect(Math.abs(long.input.direction[1])).toBeCloseTo(1, 12);
    expect(countByRole(frameFloor(long.input).members)).toEqual({ joist: 10, rim: 2 });
    const given = floorMeta(
      context('construction.floor', FLOOR, { ...rect(144, 192), direction: Math.PI / 2 }),
    ).meta;
    expect(given.input.direction[1]).toBeCloseTo(1, 12);
  });

  it('takes its outline from a horizontal sketch', () => {
    const profile: SketchProfile = {
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
      loops: [
        {
          entities: [
            [0, 0, 144, 0],
            [144, 0, 144, 192],
            [144, 192, 0, 192],
            [0, 192, 0, 0],
          ].map(([a, b, c, d]) => ({
            kind: 'line' as const,
            start: [inch(a!), inch(b!)] as [number, number],
            end: [inch(c!), inch(d!)] as [number, number],
          })),
        },
      ],
    };
    const ctx = context(
      'construction.floor',
      { ...FLOOR, outline: 'sketch', points: undefined } as unknown as FloorParams,
      {},
      { profile, dependsOn: ['sketch#1'] },
    );
    const { meta } = floorMeta(ctx);
    expect(countByRole(frameFloor(meta.input).members)).toEqual({ joist: 13, rim: 2 });
    const tilted = {
      ...profile,
      frame: { ...profile.frame, normal: [0, 1, 0] as [number, number, number] },
    };
    expect(
      refusal(translateFloor({ ...ctx, profile: () => ({ ok: true, value: tilted }) })).error,
    ).toMatch(/horizontal/);
  });

  it('doubles the joists under a wall standing on a floor from points', () => {
    const upstream = upstreamOf({
      'extension#1': wallMeta([
        [72, 0],
        [72, 192],
      ]),
    });
    const ctx = context<FloorParams>(
      'construction.floor',
      { ...FLOOR, joists: 'long' },
      rect(144, 192),
      { upstream },
    );
    const { meta } = floorMeta(ctx);
    expect(meta.input.walls).toHaveLength(1);
    // The wall's framing centre line is 1-3/4" left of its path (x = 70.25"): a doubled pair
    // there, clear of the layout joists at 64" and 80", on top of the 10 layout joists.
    const r = frameFloor(meta.input);
    expect(countByRole(r.members)).toEqual({ joist: 12, rim: 2 });
    expect(r.members.map((m) => m.id)).toEqual(expect.arrayContaining(['w1a', 'w1b']));
  });

  it('makes the subfloor body with operation new, and refuses one without a subfloor', () => {
    const { out } = floorMeta(
      context('construction.floor', FLOOR, rect(144, 192), { operation: 'new' }),
    );
    expect('inputs' in out && out.inputs.map((i) => (i as { body?: string }).body)).toEqual([
      'extension#9:layer/subfloor',
    ]);
    const bare = readConstructionData(
      {
        levels: [{ id: 'level-1', name: 'L', elevation: ins(0), height: ins(96) }],
        floorTypes: [{ id: 'shed-floor', name: 'Bare', joistStock: 'us-2x6' }],
      },
      1,
    );
    if (!bare.ok) throw new Error(bare.message);
    expect(
      refusal(
        translateFloor(
          context('construction.floor', FLOOR, rect(144, 192), {
            operation: 'new',
            data: bare.value,
          }),
        ),
      ).field,
    ).toEqual(['operation']);
  });

  it('refuses a floor with more layout slots than a floor may have, before framing it', () => {
    // 100 m across at 50 mm is 2,000 slots: refused up front.
    const out = translateFloor(
      context('construction.floor', FLOOR, {
        x1: 0,
        y1: 0,
        x2: 10_000,
        y2: 0,
        x3: 10_000,
        y3: 100_000,
        x4: 0,
        y4: 100_000,
        spacing: 50,
      }),
    );
    expect(refusal(out).error).toMatch(/joist spaces across/);
  });

  /**
   * A comb outline in mm: `k` teeth `tooth` wide with `gap` between them, `depth` deep along y,
   * on a back `back` deep (4k corners). Joists spanning x cross every tooth: each band above the
   * back is cut into k pieces.
   */
  const comb = (k: number, tooth: number, gap: number, depth: number, back: number) => {
    const X = k * (tooth + gap) - gap;
    const pts: [number, number][] = [
      [0, 0],
      [X, 0],
    ];
    for (let i = k - 1; i >= 0; i--) {
      const xl = i * (tooth + gap);
      pts.push([xl + tooth, depth], [xl, depth]);
      if (i > 0) pts.push([xl, back], [xl - gap, back]);
    }
    return pts;
  };
  const combValues = (pts: readonly [number, number][]) =>
    Object.fromEntries(
      pts.flatMap(([x, y], i) => [
        [`x${i + 1}`, x],
        [`y${i + 1}`, y],
      ]),
    );

  it('refuses a comb-shaped floor whose bands would split into many joists, frames a smaller one', () => {
    const floorOf = (k: number, spacing: number) => {
      const pts = comb(k, inch(12), inch(12), inch(144), inch(24));
      return translateFloor(
        context(
          'construction.floor',
          { ...FLOOR, points: pts.length, joists: 'long' as const, blocking: 'mid-span' as const },
          { ...combValues(pts), spacing: inch(spacing) },
        ),
      );
    };
    // 16 teeth: 16 pieces a band times (10 slots + 32 flush joists) is far past 400.
    expect(refusal(floorOf(16, 16)).error).toMatch(/joists, more than/);
    // 8 teeth: 8 x (10 + 16) = 208.
    const ok = floorOf(8, 16);
    if ('error' in ok) throw new Error(ok.error);
    const start = performance.now();
    frameFloor(readFloorMetadata(ok.metadata)!.input);
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it('refuses a comb with walls doubling joists in every tooth, in the translator and in frameFloor', () => {
    // The security audit's document: 16 teeth 300 mm wide, 300 mm apart, 5.12 m deep; joists along
    // x at 420 mm with mid-span blocking; 64 short walls along the joists, 80 mm apart. Each
    // doubled band is cut by the whole outline, so the generator would make some 2,000 joists.
    const pts = comb(16, 300, 300, 5120, 300);
    const walls = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `extension#${i + 10}`,
        wallMeta([
          [50 / inch(1), (40 + 80 * i) / inch(1)],
          [250 / inch(1), (40 + 80 * i) / inch(1)],
        ]),
      ]),
    );
    const ctx = context<FloorParams>(
      'construction.floor',
      { ...FLOOR, points: pts.length, blocking: 'mid-span' },
      { ...combValues(pts), direction: 0, spacing: 420 },
      { upstream: upstreamOf(walls) },
    );
    expect(refusal(translateFloor(ctx)).error).toMatch(/joists, more than/);
    // The generator refuses it on its own, quickly, whoever calls it.
    const start = performance.now();
    expect(() =>
      frameFloor({
        floor: 'extension#9',
        outline: pts,
        direction: [1, 0],
        settings: {
          joistStock: { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) },
          spacing: 420,
          blocking: { kind: 'mid-span' },
        },
        walls: Array.from({ length: 64 }, (_, i) => ({
          id: `extension#${i + 10}`,
          start: [50, 40 + 80 * i] as [number, number],
          end: [250, 40 + 80 * i] as [number, number],
        })),
      }),
    ).toThrow(/blocking can be laid out/);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('frames the largest floor it accepts, with blocking and walls, in bounded time', () => {
    // MAX_FLOOR_SLOTS slots at 12", one blocking row, and 64 walls each doubling a joist.
    const across = MAX_FLOOR_SLOTS * 12 - 1;
    const walls = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `extension#${i + 10}`,
        wallMeta([
          [24 + i * 40 + 8, 0],
          [24 + i * 40 + 8, 144],
        ]),
      ]),
    );
    const ctx = context(
      'construction.floor',
      { ...FLOOR, blocking: 'mid-span' as const },
      { ...rect(across, 144), spacing: inch(12) },
      { upstream: upstreamOf(walls) },
    );
    // The span runs along the short side (144"), the layout along the long one.
    const { meta } = floorMeta(ctx);
    const start = performance.now();
    const r = frameFloor(meta.input);
    const ms = performance.now() - start;
    expect(r.members.length).toBeGreaterThan(MAX_FLOOR_SLOTS);
    expect(ms).toBeLessThan(5_000);
  });
});

const ROOF: RoofParams = {
  level: 'level-1',
  roofType: 'shed-roof',
  kind: 'gable',
  ridge: 'long',
  ties: { kind: 'none' },
  gableStuds: true,
  overrides: [],
};

const onLevel = (extra: Record<string, number> = {}) => ({
  pitch: Math.atan(0.5),
  x: 0,
  y: 0,
  length: inch(144),
  width: inch(192),
  wallThickness: inch(3.5),
  ...extra,
});

describe('the roof translator', () => {
  it('bears on a level: the ridge along the longer side, the plates at the level height', () => {
    const out = translateRoof(context('construction.roof', ROOF, onLevel()));
    if ('error' in out) throw new Error(out.error);
    const meta = readRoofMetadata(out.metadata)!;
    // 144 along x and 192 along y: the ridge turns to run along y, from corner (144, 0).
    expect(meta.input.footprint.length / inch(1)).toBeCloseTo(192, 9);
    expect(meta.input.footprint.width / inch(1)).toBeCloseTo(144, 9);
    expect(meta.input.footprint.origin.map((v) => v / inch(1))).toEqual([144, 0]);
    expect(meta.input.footprint.direction).toBeCloseTo(Math.PI / 2, 12);
    expect(meta.input.footprint.plate / inch(1)).toBeCloseTo(97.125, 9);
    // No walls, so no gable studs; no operation, so no bodies.
    expect(meta.input.settings.gableStuds).toBeUndefined();
    expect('inputs' in out && out.inputs).toEqual([]);
    const short = translateRoof(
      context('construction.roof', { ...ROOF, ridge: 'short' }, onLevel()),
    );
    if ('error' in short) throw new Error(short.error);
    expect(readRoofMetadata(short.metadata)!.input.footprint.length / inch(1)).toBeCloseTo(144, 9);
  });

  it('refuses a pitch out of range, a missing size, a rake on a hip and an overhang too long', () => {
    const field = (values: Record<string, number>, params: RoofParams = ROOF) =>
      refusal(translateRoof(context('construction.roof', params, values))).field;
    expect(field(onLevel({ pitch: 0 }))).toEqual(['expressions', 'pitch']);
    expect(field(onLevel({ pitch: (85 * Math.PI) / 180 }))).toEqual(['expressions', 'pitch']);
    const noWidth: Record<string, number> = onLevel();
    delete noWidth.width;
    expect(field(noWidth)).toEqual(['expressions', 'width']);
    expect(
      field(onLevel({ rakeOverhang: inch(12) }), { ...ROOF, kind: 'hip', gableStuds: false }),
    ).toEqual(['expressions', 'rakeOverhang']);
    expect(field(onLevel({ overhang: 6_000 }))).toEqual(['expressions', 'overhang']);
    expect(field(onLevel({ length: 1e9 }))).toEqual(['expressions', 'length']);
    expect(field(onLevel({ tieHeight: inch(24) }))).toEqual(['expressions', 'tieHeight']);
  });

  it('refuses walls that do not close a rectangle', () => {
    const upstream = upstreamOf({
      'extension#1': wallMeta(
        [
          [0, 0],
          [192, 0],
          [192, 144],
          [96, 144],
          [96, 200],
          [0, 200],
        ],
        true,
      ),
    });
    const out = translateRoof(
      context(
        'construction.roof',
        { ...ROOF, level: undefined } as unknown as RoofParams,
        { pitch: 0.4 },
        { upstream },
      ),
    );
    expect(refusal(out).error).toMatch(/rectangle/);
  });
});

describe('roof sheathing planes', () => {
  const L = inch(192);
  const W = inch(144);
  const o = inch(12);
  const pitch = Math.atan(0.5);

  it('gives each gable plane (L + 2 rake) x (overhang + W / 2) / cos, as the takeoff has it', () => {
    const planes = sheathingOutlines('gable', L, W, o, inch(12));
    expect(planes.map((p) => p.edge)).toEqual([1, 3]);
    const faces = roofSheathingFaces(
      {
        roof: 'extension#9',
        kind: 'gable',
        pitch,
        footprint: { origin: [0, 0], length: L, width: W, plate: 0, wallThickness: inch(3.5) },
        settings: {
          rafterStock: { id: 'us-2x6', name: '2x6', width: inch(1.5), depth: inch(5.5) },
          ridgeStock: { id: 'us-2x8', name: '2x8', width: inch(1.5), depth: inch(7.25) },
          overhang: o,
          rakeOverhang: inch(12),
        },
      },
      'us-osb-7-16',
    );
    for (const [i, p] of planes.entries()) {
      const hand = (216 * 84 * Math.sqrt(180)) / 12;
      expect(sheathingArea(p.points, pitch) / inch(1) ** 2).toBeCloseTo(hand, 6);
      expect(sheathingArea(p.points, pitch)).toBeCloseTo(faceArea(faces[i]!), 3);
    }
  });

  it('cuts a hip roof at its hips: trapezoid eaves, triangle ends, all four summing to the roof', () => {
    const planes = sheathingOutlines('hip', L, W, o, 0);
    expect(planes.map((p) => p.points.length)).toEqual([4, 3, 4, 3]);
    const total = planes.reduce((a, p) => a + sheathingArea(p.points, pitch), 0);
    // The whole roof in plan is the footprint plus the overhang all round, over cos.
    expect(total).toBeCloseTo(((L + 2 * o) * (W + 2 * o)) / Math.cos(pitch), 3);
  });
});

describe('the domain', () => {
  it('registers the floor and roof types with their expressions', () => {
    expect(constructionDomain.types?.['construction.floor']?.expressions).toBe(FLOOR_EXPRESSIONS);
    expect(constructionDomain.types?.['construction.roof']?.expressions).toBe(ROOF_EXPRESSIONS);
  });
});
