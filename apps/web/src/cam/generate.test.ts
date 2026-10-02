// From the geometry stage's reply to the CAM worker's evaluated setup: the stock box from the
// body's bounds and margins, the WCS frame, loops and drill points in machine coordinates, a
// facing with no source facing the whole stock top, and only resolved operations sent on.

import type { CamGeometryResult, CamOperationResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { setupInput, stockOutline } from './generate';

const tool = {
  id: 'tool#1',
  name: 'Flat',
  kind: 'flat' as const,
  diameter: 6,
  fluteLength: 20,
  flutes: 2,
};
const feeds = { spindle: 18000, cut: 1000, plunge: 300 };

function op(
  partial: Partial<CamOperationResult> & Pick<CamOperationResult, 'operationId' | 'kind'>,
): CamOperationResult {
  return {
    key: `${partial.operationId}-key`,
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    sources: [],
    values: null,
    ...partial,
  };
}

const square = (x0: number, y0: number, s: number) => {
  const p: [number, number][] = [
    [x0, y0],
    [x0 + s, y0],
    [x0 + s, y0 + s],
    [x0, y0 + s],
  ];
  return {
    segments: p.map((start, i) => ({ kind: 'line' as const, start, end: p[(i + 1) % 4]! })),
  };
};

function geometry(): CamGeometryResult {
  return {
    generation: 3,
    setupId: 'setup#1',
    partId: 'part#1',
    bodyId: 'extrude#1',
    bodyKey: 'body',
    key: 'all',
    status: 'ok',
    errors: [],
    warnings: [],
    references: [],
    bounds: { min: [0, -15, 0], max: [50, 15, 6] },
    setup: {
      machine: 'shapeoko-5-pro-4x4',
      post: 'grbl',
      stock: {
        kind: 'fromBody',
        margins: { xMin: 0, xMax: 0, yMin: 0, yMax: 0, top: 1, bottom: 0 },
        material: 'plywood',
      },
      wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
      heights: { clearance: 10, retract: 5 },
      stockZ: { top: 0, bottom: -7 },
    },
    operations: [
      op({
        operationId: 'facing#1',
        kind: 'facing',
        values: {
          id: 'facing#1',
          name: 'Face',
          tool,
          feeds,
          kind: 'facing',
          depth: { top: 0, bottom: -1 },
          stepdown: 1,
          stepover: 0.5,
          angle: 0,
        },
      }),
      op({
        operationId: 'profile#1',
        kind: 'profile',
        sources: [
          {
            source: 0,
            kind: 'region',
            z: -1,
            planar: {
              origin: [10, 0, 6],
              xDir: [1, 0, 0],
              normal: [0, 0, 1],
              loops: [square(0, 0, 10)],
            },
          },
        ],
        values: {
          id: 'profile#1',
          name: 'Outline',
          tool,
          feeds,
          kind: 'profile',
          side: 'outside',
          depth: { top: 0, bottom: -7 },
          stepdown: 2,
          finishAllowance: 0,
          entry: { kind: 'plunge' },
          leadIn: { kind: 'none' },
          leadOut: { kind: 'none' },
          climb: true,
          finishPass: false,
          finishStepdown: 2,
        },
      }),
      op({
        operationId: 'drill#1',
        kind: 'drill',
        sources: [
          {
            source: 'body',
            kind: 'holeWalls',
            points: [
              { position: [25, 0, 6], axis: [0, 0, -1], diameter: 4.5, depth: 6, through: true },
            ],
          },
        ],
        values: { id: 'drill#1', name: 'Holes', tool, feeds, kind: 'drill' },
      }),
      op({
        operationId: 'pocket#1',
        kind: 'pocket',
        status: 'error',
        errors: [{ code: 'reference-lost', message: 'gone', source: 0 }],
      }),
      op({ operationId: 'pocket#2', kind: 'pocket', status: 'suppressed' }),
      op({
        operationId: 'profile#2',
        kind: 'profile',
        sources: [
          {
            source: 0,
            kind: 'face',
            z: -1,
            facing: true,
            // A plane on the side of the part: not parallel to the machine XY plane.
            planar: {
              origin: [0, 0, 0],
              xDir: [0, 1, 0],
              normal: [1, 0, 0],
              loops: [square(0, 0, 5)],
            },
          },
        ],
        values: {
          id: 'profile#2',
          name: 'Side',
          tool,
          feeds,
          kind: 'profile',
          side: 'outside',
          depth: { top: 0, bottom: -7 },
          stepdown: 2,
          finishAllowance: 0,
          entry: { kind: 'plunge' },
          leadIn: { kind: 'none' },
          leadOut: { kind: 'none' },
          climb: true,
          finishPass: false,
          finishStepdown: 2,
        },
      }),
    ],
    cached: false,
    ms: 1,
  };
}

describe('setupInput', () => {
  it('builds the stock, frame and machine-coordinate geometry of the resolved operations', () => {
    const r = setupInput(geometry(), { id: 'setup#1', name: 'Top' });
    if (!r.ok) throw new Error(r.message);
    const s = r.setup;
    expect(s.stock).toEqual({ min: [0, -15, 0], max: [50, 15, 7], material: 'plywood' });
    expect(s.frame.origin).toEqual([0, -15, 7]);
    expect(s.heights).toEqual({ clearance: 10, retract: 5 });
    expect(s.operations.map((o) => o.id)).toEqual(['facing#1', 'profile#1', 'drill#1']);
    const [facing, profile, drill] = s.operations as [
      (typeof s.operations)[number],
      (typeof s.operations)[number],
      (typeof s.operations)[number],
    ];
    // A facing with no source faces the whole stock top, in machine XY.
    expect(facing.kind === 'facing' && facing.loops).toEqual([stockOutline(s.stock, [0, -15, 7])]);
    expect(facing.kind === 'facing' && facing.loops[0]!.segments.map((x) => x.start)).toEqual([
      [0, 0],
      [50, 0],
      [50, 30],
      [0, 30],
    ]);
    // The region square, 10 mm in from the part's left at y 0..10, is at machine (10..20, 15..25).
    expect(profile.kind === 'profile' && profile.loops[0]!.segments.map((x) => x.start)).toEqual([
      [10, 15],
      [20, 15],
      [20, 25],
      [10, 25],
    ]);
    expect(drill.kind === 'drill' && drill.points).toEqual([
      { at: [25, 15], depth: { top: -1, bottom: -7 }, diameter: 4.5, through: true },
    ]);
    // A source not parallel to the setup is that operation's failure, not the setup's.
    expect(Object.keys(r.failed)).toEqual(['profile#2']);
    expect(r.failed['profile#2']).toMatch(/parallel/);
  });

  it('refuses a setup whose geometry failed, with the stage message', () => {
    const g = {
      ...geometry(),
      status: 'error' as const,
      setup: null,
      errors: [{ code: 'no-body' as const, message: 'No body' }],
    };
    expect(setupInput(g, { id: 'setup#1', name: 'Top' })).toEqual({
      ok: false,
      message: 'No body',
    });
  });

  it('takes an explicit stock that holds the body, and refuses one that does not', () => {
    const g = geometry();
    const explicit = {
      ...g,
      setup: {
        ...g.setup!,
        stock: {
          kind: 'explicit' as const,
          size: [60, 40, 10] as const,
          offset: [5, 5, 2] as const,
        },
      },
    };
    const r = setupInput(explicit, { id: 'setup#1', name: 'Top' });
    if (!r.ok) throw new Error(r.message);
    expect(r.setup.stock).toEqual({ min: [-5, -20, -2], max: [55, 20, 8] });
    const small = {
      ...g,
      setup: {
        ...g.setup!,
        stock: {
          kind: 'explicit' as const,
          size: [10, 10, 10] as const,
          offset: [0, 0, 0] as const,
        },
      },
    };
    const refused = setupInput(small, { id: 'setup#1', name: 'Top' });
    expect(refused.ok).toBe(false);
  });
});
