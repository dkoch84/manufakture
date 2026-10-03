// From the geometry stage's reply to the CAM worker's evaluated setup: the stock box from the
// body's bounds and margins, the WCS frame, loops and drill points in machine coordinates, a
// facing with no source facing the whole stock top, and only resolved operations sent on.

import type { CamGeometryResult, CamOperationResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { CLEARING_SUFFIX, documentOperation, setupInput, stockOutline } from './generate';

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
        // As the stage measures it: 10 mm of stock, its top the origin.
        stockZ: { top: 0, bottom: -10 },
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

describe('3D surfaces and V-carve clearings (T5.5b)', () => {
  const ball = { ...tool, id: 'tool#2', name: 'Ball', kind: 'ball' as const };
  const vbit = { ...tool, id: 'tool#3', name: 'V', kind: 'vbit' as const, angle: Math.PI / 3 };
  const regionSource = {
    source: 0,
    kind: 'region' as const,
    z: 0,
    planar: {
      origin: [10, 0, 6] as [number, number, number],
      xDir: [1, 0, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      loops: [square(0, 0, 10)],
    },
  };
  const mesh = () => ({
    positions: new Float32Array([0, -15, 6, 50, -15, 6, 50, 15, 6]),
    indices: new Uint32Array([0, 1, 2]),
  });

  function with3d(withMesh = true): CamGeometryResult {
    const g = geometry();
    return {
      ...g,
      ...(withMesh ? { mesh: mesh() } : {}),
      operations: [
        op({
          operationId: 'surface3d#1',
          kind: 'surface3d',
          sources: [regionSource],
          values: {
            id: 'surface3d#1',
            name: 'Finish',
            tool: ball,
            feeds,
            kind: 'surface3d',
            stepover: 0.5,
            angle: 0,
            allowance: 0,
            pattern: 'oneway',
          },
        }),
        op({
          operationId: 'surface3d#2',
          kind: 'surface3d',
          values: {
            id: 'surface3d#2',
            name: 'Rough',
            tool,
            feeds,
            kind: 'surface3d',
            stepover: 2,
            angle: 0,
            allowance: 0.5,
            strategy: 'zlevel',
          },
        }),
        op({
          operationId: 'vcarve#1',
          kind: 'vcarve',
          sources: [regionSource],
          values: {
            id: 'vcarve#1',
            name: 'Letters',
            tool: vbit,
            feeds,
            kind: 'vcarve',
            top: 0,
            maxDepth: 2,
            clearing: { tool, feeds, stepdown: 1, stepover: 0.4 },
          },
        }),
      ],
    };
  }

  it('machines the mesh in machine coordinates, bounded by the sources when there are any', () => {
    const r = setupInput(with3d(), { id: 'setup#1', name: 'Top' });
    if (!r.ok) throw new Error(r.message);
    expect(r.failed).toEqual({});
    const [finish, rough] = r.setup.operations;
    if (finish?.kind !== 'surface3d' || rough?.kind !== 'surface3d') throw new Error('kinds');
    // The setup frame's origin is (0, -15, 7): model (50, 15, 6) is machine (50, 30, -1).
    expect([...finish.mesh.positions]).toEqual([0, 0, -1, 50, 0, -1, 50, 30, -1]);
    expect(rough.mesh).toBe(finish.mesh);
    expect((finish as { boundary?: unknown }).boundary).toEqual([
      expect.objectContaining({ segments: expect.any(Array) }),
    ]);
    expect(finish).toMatchObject({ pattern: 'oneway', stepover: 0.5 });
    expect(rough).not.toHaveProperty('boundary');
    expect(rough).toMatchObject({ strategy: 'zlevel', allowance: 0.5 });
  });

  it('fails a 3D surface without a mesh, on that operation only', () => {
    const r = setupInput(with3d(false), { id: 'setup#1', name: 'Top' });
    if (!r.ok) throw new Error(r.message);
    expect(Object.keys(r.failed)).toEqual(['surface3d#1', 'surface3d#2']);
    expect(r.setup.operations.map((o) => o.id)).toEqual([`vcarve#1${CLEARING_SUFFIX}`, 'vcarve#1']);
  });

  it('cuts a V-carve with a clearing tool in two, its clearing first with the end mill', () => {
    const r = setupInput(with3d(), { id: 'setup#1', name: 'Top' });
    if (!r.ok) throw new Error(r.message);
    const [clearing, carve] = r.setup.operations.slice(2);
    expect(clearing).toMatchObject({
      kind: 'vcarveClearing',
      id: 'vcarve#1/clearing',
      name: 'Letters (clearing)',
      tool: { id: 'tool#1', kind: 'flat' },
      stepdown: 1,
      stepover: 0.4,
      carve: { id: 'vcarve#1', tool: { id: 'tool#3' }, maxDepth: 2 },
    });
    expect((clearing as { carve: object }).carve).not.toHaveProperty('clearing');
    // The carve keeps its clearing, so the V-bit leaves the floor to the end mill.
    expect(carve).toMatchObject({ kind: 'vcarve', clearing: { tool: { id: 'tool#1' } } });
    expect(documentOperation('vcarve#1/clearing')).toBe('vcarve#1');
    expect(documentOperation('vcarve#1')).toBe('vcarve#1');
  });
});
