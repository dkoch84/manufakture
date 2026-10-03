// The wall and opening params readers, the layer outlines and the wall graph, without a kernel.

import { describe, expect, it } from 'vitest';
import { constructionDomain } from '../domain';
import { DEFAULT_WALL_SETTINGS } from '../framing/wall';
import { S2X4, DOUBLE_2X8, inch } from '../test-helpers';
import { MAX_WALL_POINTS, type WallMetadata } from './common';
import { MAX_GRAPH_SEGMENTS, framedWall, wallGraph, type GraphWall } from './graph';
import { OPENING_SCHEMA_VERSION, readOpeningParams } from './opening';
import { constructionGroups } from './stage';
import {
  WALL_EXPRESSIONS,
  WALL_SCHEMA_VERSION,
  layerArea,
  layerLoops,
  readWallParams,
} from './wall';

describe('wall params', () => {
  const base = { level: 'level-1', wallType: 'ext-2x4', points: 2 };

  it('reads the defaults, and the version is 1 with no migrations yet', () => {
    expect(WALL_SCHEMA_VERSION).toBe(1);
    expect(readWallParams(base, 1)).toEqual({
      ok: true,
      value: {
        ...base,
        closed: false,
        justification: 'left',
        joins: { start: 'auto', end: 'auto' },
        framing: {},
        overrides: [],
      },
    });
  });

  it.each([
    [{ ...base, level: 'Level 1' }, ['level']],
    [{ ...base, points: 1 }, ['points']],
    [{ ...base, points: MAX_WALL_POINTS + 1 }, ['points']],
    [{ ...base, points: 2, closed: true }, ['points']],
    [{ ...base, justification: 'middle' }, ['justification']],
    [{ ...base, framing: { kings: 9 } }, ['framing', 'kings']],
    [{ ...base, framing: { blocking: 'heights' } }, ['framing', 'blocking']],
    [{ ...base, joins: { start: 'never' } }, ['joins', 'start']],
    [{ ...base, overrides: [{ id: 's1' }, { id: 's1' }] }, ['overrides', 1, 'id']],
    [{ ...base, overrides: [{ id: 'extension#3:s1' }] }, ['overrides', 0, 'id']],
    [{ ...base, wallId: 'extension#3' }, ['wallId']],
  ])('refuses %j at %j', (params, field) => {
    const r = readWallParams(params, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field ?? []).toEqual(field);
  });

  it('declares every point and nudge as a length', () => {
    expect(WALL_EXPRESSIONS.x1).toBe('length');
    expect(WALL_EXPRESSIONS[`y${MAX_WALL_POINTS}`]).toBe('length');
    expect(WALL_EXPRESSIONS[`x${MAX_WALL_POINTS + 1}`]).toBeUndefined();
    expect(WALL_EXPRESSIONS.move_1).toBe('length');
  });
});

describe('opening params', () => {
  it('reads the defaults', () => {
    expect(OPENING_SCHEMA_VERSION).toBe(1);
    expect(readOpeningParams({ kind: 'window' }, 1)).toEqual({
      ok: true,
      value: {
        kind: 'window',
        segment: 1,
        from: 'start',
        sizing: 'rough',
        header: { kind: 'auto' },
        overrides: [],
      },
    });
    expect(
      readOpeningParams(
        {
          kind: 'door',
          swing: 'in',
          hand: 'left',
          header: { kind: 'explicit', stock: 'us-2x10', plies: 2, jacks: 2 },
        },
        1,
      ),
    ).toMatchObject({ ok: true, value: { header: { kind: 'explicit', plies: 2 } } });
  });

  it.each([
    [{ kind: 'arch' }, ['kind']],
    [{ kind: 'window', swing: 'in' }, ['swing']],
    [
      { kind: 'door', header: { kind: 'explicit', stock: 'us-2x10', plies: 2 } },
      ['header', 'jacks'],
    ],
    [{ kind: 'door', header: { kind: 'rule' } }, ['header', 'kind']],
    [{ kind: 'door', segment: 0 }, ['segment']],
    [{ kind: 'door', wall: 'extension#1' }, ['wall']],
  ])('refuses %j at %j', (params, field) => {
    const r = readOpeningParams(params, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field ?? []).toEqual(field);
  });
});

describe('layer outlines', () => {
  const L: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 50],
  ];

  it('names the edges by layer, side and segment, and mitres the corner', () => {
    const [loop] = layerLoops('osb', L, false, -10, 0);
    expect(loop!.entities.map((e) => e.id)).toEqual([
      'osb.ext1',
      'osb.ext2',
      'osb.end',
      'osb.int2',
      'osb.int1',
      'osb.start',
    ]);
    // The exterior side turns at the mitre point (110, -10).
    expect(loop!.entities[0]).toMatchObject({ start: [0, -10], end: [110, -10] });
    expect(layerArea(L, false, -10, 0)).toBeCloseTo(10 * 150 + 100, 9);
  });

  it('gives a closed path its outer ring first and the inner as a hole', () => {
    const square: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const loops = layerLoops('d', square, true, 10, 20);
    expect(loops.map((l) => l.entities[0]!.id)).toEqual(['d.ext1', 'd.int1']);
    expect(layerArea(square, true, 10, 20)).toBeCloseTo(80 * 80 - 60 * 60, 9);
    // Clockwise, the left side is outside: the interior ring is the outer one.
    const cw = [...square].reverse();
    expect(layerLoops('d', cw, true, 10, 20).map((l) => l.entities[0]!.id)).toEqual([
      'd.int1',
      'd.ext1',
    ]);
  });
});

function meta(points: [number, number][], extra: Partial<WallMetadata> = {}): WallMetadata {
  return {
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: inch(97.125),
    points,
    closed: false,
    justification: 'left',
    thickness: inch(3.5),
    free: { start: false, end: false },
    layers: [],
    settings: { studStock: S2X4, defaultHeader: DOUBLE_2X8 },
    overrides: [],
    ...extra,
  };
}

describe('the wall graph', () => {
  const T = inch(3.5);

  it('runs the first wall through at an L corner at any angle, and butts the second', () => {
    // A 45-degree corner: the second wall leaves the first's end turning left by 45 degrees.
    const c = Math.SQRT1_2;
    const a: GraphWall = {
      id: 'extension#1',
      meta: meta([
        [-1000, 0],
        [0, 0],
      ]),
    };
    const b: GraphWall = {
      id: 'extension#2',
      meta: meta([
        [0, 0],
        [1000 * c, 1000 * c],
      ]),
    };
    const g = wallGraph([a, b]);
    const fa = framedWall(g, a);
    const fb = framedWall(g, b);
    expect(fa.segments[0]!.joins).toEqual({
      start: { kind: 'free' },
      end: { kind: 'L', through: true, otherThickness: T },
    });
    expect(fb.segments[0]!.joins!.start).toEqual({ kind: 'L', through: false, otherThickness: T });
    // a's centre line (y = T/2) reaches b's far band line (its right face, through the origin) at
    // x = (T/2) / tan 45; b's centre line meets a's near face (y = T) a distance u along it.
    expect(fa.segments[0]!.end[0]).toBeCloseTo(T / 2, 9);
    expect(fa.shifts[0]).toBe(0);
    const u = (T - (T / 2) * c) / c;
    expect(fb.shifts[0]).toBeCloseTo(u, 9);
  });

  it('frames a tee where a wall ends on another, and leaves three ends at a point free', () => {
    const host: GraphWall = {
      id: 'extension#1',
      meta: meta([
        [0, 0],
        [5000, 0],
      ]),
    };
    const branch: GraphWall = {
      id: 'extension#2',
      meta: meta([
        [2000, 0],
        [2000, -3000],
      ]),
    };
    const g = wallGraph([host, branch]);
    // The branch runs down (-y), so its framing lies left of it, at x 2000 to 2000 + T.
    expect(framedWall(g, host).segments[0]!.tees).toEqual([
      { at: expect.closeTo(2000 + T / 2, 9), otherThickness: T },
    ]);
    expect(framedWall(g, branch).segments[0]!.joins!.start).toEqual({
      kind: 'T',
      otherThickness: T,
    });
    expect(g.neighbours.get('extension#1')).toEqual(new Set(['extension#2']));

    const three = wallGraph([
      {
        id: 'extension#1',
        meta: meta([
          [0, 0],
          [1000, 0],
        ]),
      },
      {
        id: 'extension#2',
        meta: meta([
          [1000, 0],
          [1000, 1000],
        ]),
      },
      {
        id: 'extension#3',
        meta: meta([
          [1000, 0],
          [2000, 0],
        ]),
      },
    ]);
    expect(three.warnings.map((w) => w.wall)).toEqual([
      'extension#1',
      'extension#2',
      'extension#3',
    ]);
  });

  it('keeps ends set free, and walls on other levels, apart', () => {
    const a: GraphWall = {
      id: 'extension#1',
      meta: meta(
        [
          [0, 0],
          [1000, 0],
        ],
        { free: { start: false, end: true } },
      ),
    };
    const b: GraphWall = {
      id: 'extension#2',
      meta: meta([
        [1000, 0],
        [1000, 1000],
      ]),
    };
    const up: GraphWall = {
      id: 'extension#3',
      meta: meta(
        [
          [1000, 0],
          [1000, 1000],
        ],
        { level: 'level-2' },
      ),
    };
    const g = wallGraph([a, b, up]);
    expect(framedWall(g, a).segments[0]!.joins!.end).toEqual({ kind: 'free' });
    expect(framedWall(g, up).segments[0]!.joins!.start).toEqual({ kind: 'free' });
  });

  it('finds crossings, and refuses a part with too many segments', () => {
    const g = wallGraph([
      {
        id: 'extension#1',
        meta: meta([
          [0, 0],
          [1000, 0],
        ]),
      },
      {
        id: 'extension#2',
        meta: meta([
          [500, -500],
          [500, 500],
        ]),
      },
    ]);
    expect(g.crossings).toEqual([['extension#1', 'extension#2']]);
    const many = Array.from({ length: MAX_GRAPH_SEGMENTS / 63 + 1 }, (_, i) => ({
      id: `extension#${i + 1}`,
      meta: meta(Array.from({ length: 64 }, (_, k): [number, number] => [k * 1000, i * 10_000])),
    }));
    expect(() => wallGraph(many)).toThrow(/wall segments, more than/);
  });

  it('groups a wall with its openings and the walls it meets', () => {
    const groups = constructionGroups({
      partId: 'part#1',
      data: {},
      features: [
        {
          id: 'extension#1',
          type: 'construction.wall',
          schemaVersion: 1,
          dependsOn: [],
          metadata: meta([
            [0, 0],
            [1000, 0],
          ]) as never,
        },
        {
          id: 'extension#2',
          type: 'construction.wall',
          schemaVersion: 1,
          dependsOn: [],
          metadata: meta([
            [1000, 0],
            [1000, 1000],
          ]) as never,
        },
        {
          id: 'extension#3',
          type: 'construction.opening',
          schemaVersion: 1,
          dependsOn: ['extension#2'],
          metadata: { kind: 'opening', wall: 'extension#2' },
        },
      ],
    });
    expect(groups).toEqual([
      { id: 'extension#1', features: ['extension#1', 'extension#2'] },
      { id: 'extension#2', features: ['extension#2', 'extension#3', 'extension#1'] },
    ]);
  });
});

describe('the domain registration', () => {
  it('registers the wall, opening, floor and roof types and the member stage', () => {
    expect(Object.keys(constructionDomain.types ?? {}).sort()).toEqual([
      'construction.floor',
      'construction.opening',
      'construction.roof',
      'construction.wall',
    ]);
    expect(typeof constructionDomain.members?.frame).toBe('function');
    expect(DEFAULT_WALL_SETTINGS.headerRules).toEqual([]);
  });
});
