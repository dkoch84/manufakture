// The CAM geometry stage (M5 plan T5.1f) end to end in Node, with the real kernel service and the
// real planegcs solver: the M1 bracket (a 40 x 20 plate of `#thickness` with a 6 mm hole and a
// 2 mm round on its front right corner) plus a counterbored hole feature and a sketch no feature
// consumes, machined by a setup whose operations name the plate's top face, that sketch's region
// and the hole feature.

import { readFileSync } from 'node:fs';
import {
  parseDocument,
  type CamOperation,
  type CamSetup,
  type CamTool,
  type ExtrudeFeature,
  type HoleFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import type {
  EdgeInfo,
  FaceInfo,
  KernelService,
  MeshData,
  OpResult,
  ShapeId,
  Topology,
  VertexInfo,
} from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CamGeometryResult, CamLoop, CamOperationResult, CamSourceResult } from './cam';
import {
  CAM_DRILL_MAX_PECKS,
  CAM_MESH_DEFLECTION,
  CAM_MAX_TABS,
  CAM_MIN_ENTRY_ANGLE,
  CAM_MIN_TOOL_DIAMETER,
  CamStage,
  holeWallPoints,
  type CamHost,
} from './cam';
import { evaluateVariables } from './values';
import { RegenEngine } from './engine';
import { PART, add, apply, build, extrude, mm, rectangle, unwrap } from './test-helpers';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

const S = 'setup#1';
const T = 'tool#1';
const TOP = 'extrude#1:cap:end';
const deg = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

/**
 * The M1 bracket at the current format version, with its hole cut into the plate: the fixture's
 * extrude#2 cuts up from the top face, through nothing, so it only splits that face; reversed, it
 * drills a real 6 mm hole and the top face keeps its one name.
 */
function bracket(): ManufaktureDocument {
  const json = JSON.parse(
    readFileSync(new URL('../../core/src/fixtures/v14-bracket.json', import.meta.url), 'utf8'),
  );
  json.parts[0].features.find((f: { id: string }) => f.id === 'extrude#2').reverse = true;
  return unwrap(parseDocument(json)).document;
}

const tool: CamTool = {
  id: T,
  name: '1/4" flat',
  kind: 'flat',
  number: 201,
  diameter: mm('1/4"'),
  fluteLength: mm('19'),
  flutes: 2,
  presets: [
    {
      material: 'plywood',
      spindle: mm('18000rpm'),
      feed: mm('1500mm/min'),
      plunge: mm('500mm/min'),
      stepdown: mm('2'),
      stepover: mm('0.4'),
    },
  ],
};

const profile: CamOperation = {
  id: 'profile#1',
  kind: 'profile',
  name: 'Cut out',
  suppressed: false,
  tool: T,
  geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: TOP } } }],
  feeds: { cut: mm('feed') },
  side: 'outside',
  depth: { kind: 'through', extra: mm('0.5') },
  finishAllowance: mm('0.2'),
  tabs: { count: mm('4'), width: mm('6'), height: mm('2') },
  entry: { kind: 'ramp', angle: deg('3') },
  leadIn: { kind: 'arc', radius: mm('2') },
  leadOut: { kind: 'none' },
  climb: true,
};

const pocket: CamOperation = {
  id: 'pocket#1',
  kind: 'pocket',
  name: 'Recess',
  suppressed: false,
  tool: T,
  geometry: [{ kind: 'region', sketch: 'sketch#4' }],
  depth: { kind: 'blind', depth: mm('thickness / 2') },
  entry: { kind: 'helix', angle: deg('2'), radius: mm('1.5') },
  climb: true,
};

const drill: CamOperation = {
  id: 'drill#1',
  kind: 'drill',
  name: 'Holes',
  suppressed: false,
  tool: T,
  geometry: [{ kind: 'hole', feature: 'hole#1' }],
  peck: mm('2'),
};

function setup(operations: CamOperation[], extra: Partial<CamSetup> = {}): CamSetup {
  const zero = mm('0');
  return {
    id: S,
    name: 'Top',
    part: PART,
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    stock: {
      kind: 'fromBody',
      margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: zero, bottom: zero },
      material: 'plywood',
    },
    wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
    heights: { clearance: mm('10'), retract: mm('5') },
    operations,
    ...extra,
  };
}

/** Sketch#3: one point on the plate's top face, for the hole. */
const holePoints: SketchFeature = {
  id: 'sketch#3',
  kind: 'sketch',
  name: 'Hole points',
  suppressed: false,
  plane: { type: 'face', face: { id: 'r3', ref: { face: TOP } } },
  entities: [{ id: 'e7', kind: 'point', construction: false, position: [8, 10] }],
  constraints: [],
};

const hole: HoleFeature = {
  id: 'hole#1',
  kind: 'hole',
  name: 'Counterbored hole',
  suppressed: false,
  sketch: 'sketch#3',
  points: ['e7'],
  diameter: mm('4'),
  extent: { type: 'throughAll' },
  head: { type: 'counterbore', diameter: mm('8'), depth: mm('2') },
};

/** Sketch#4: a `width` x 4 rectangle on the top face that no feature consumes (like V-carved text). */
const recessOf = (width: string) =>
  rectangle('sketch#4', {
    width,
    depth: '4',
    at: [25, 3],
    plane: { type: 'face', face: { id: 'r4', ref: { face: TOP } } },
    ids: ['e8', 'e9', 'e10', 'e11'],
    firstConstraint: 7,
  });
const recess = recessOf('6');

/** The bracket with the hole, the loose sketch, a `feed` variable, the tool and the setup. */
function machined(
  operations: CamOperation[] = [profile, pocket, drill],
  extra: Partial<CamSetup> = {},
) {
  return apply(
    bracket(),
    { type: 'setVariable', name: 'feed', expression: mm('1200mm/min') },
    add(holePoints),
    add(hole),
    add(recess),
    { type: 'addCamTool', tool },
    { type: 'addCamSetup', setup: setup(operations, extra) },
  );
}

const setThickness = (doc: ManufaktureDocument, source: string) =>
  apply(doc, { type: 'setVariable', name: 'thickness', expression: mm(source) });

const op = (r: CamGeometryResult, id: string): CamOperationResult =>
  r.operations.find((o) => o.operationId === id)!;

/** Rounded to 1e-6, without a negative zero. */
const r6 = (x: number) => +x.toFixed(6) + 0;

/** Segment kinds of a loop, with `fullCircle` arcs as `circle`. */
const shape = (loop: CamLoop) =>
  loop.segments.map((s) => (s.kind === 'arc' && s.fullCircle ? 'circle' : s.kind));

function face(r: CamOperationResult): Extract<CamSourceResult, { kind: 'face' }> {
  const s = r.sources[0]!;
  expect(s.kind).toBe('face');
  return s as Extract<CamSourceResult, { kind: 'face' }>;
}

describe('the CAM geometry stage with the real kernel and solver', () => {
  it('resolves a face, a loose sketch region and a hole feature into loops, depths and drill points', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = machined();
    const regen = (await engine.regen(doc))!;
    expect(regen.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    // Regen exposes each feature's key (ADR 0014 decision 7), for the app's stale checks.
    expect(regen.parts[0]!.features.find((f) => f.featureId === 'sketch#4')!.key).toMatch(/\w+/);
    expect(regen.parts[0]!.features.find((f) => f.featureId === 'hole#1')!.key).toMatch(/\w+/);

    const r = (await engine.camGeometry(doc, S))!;
    expect(r.generation).toBe(regen.generation);
    expect(r.status).toBe('ok');
    expect(r.errors).toEqual([]);
    expect(r.bodyId).toBe('extrude#1');
    expect(r.bodyKey).toBe(regen.parts[0]!.bodies[0]!.bodyKey);
    // The plate's bounds, from the CAM mesh: its faces are flat, so they are exact.
    expect(r.bounds!.min.map(r6)).toEqual([0, 0, 0]);
    expect(r.bounds!.max.map(r6)).toEqual([40, 20, 6]);
    expect(r.setup).toMatchObject({
      machine: 'shapeoko-5-pro-4x4',
      post: 'grbl',
      wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
      heights: { clearance: 10, retract: 5 },
      stockZ: { top: 0, bottom: -6 },
    });
    expect(r.mesh).toBeUndefined();

    // The profile: the top face's outer loop (four lines and the round) and its two holes (the
    // 6 mm hole and the counterbore), at machine Z 0, cut through with 0.5 mm extra.
    const p = op(r, 'profile#1');
    expect(p.status).toBe('ok');
    expect(p.references).toEqual([
      { source: 0, referenceId: 'r1', target: TOP, via: 'exact', fragile: false },
    ]);
    const top = face(p);
    expect(top.z).toBeCloseTo(0, 9);
    expect(top.facing).toBe(true);
    expect(top.planar.normal).toEqual([0, 0, 1]);
    const [outer, ...holes] = top.planar.loops;
    expect(shape(outer!).sort()).toEqual(['arc', 'line', 'line', 'line', 'line']);
    const round = outer!.segments.find((s) => s.kind === 'arc')!;
    expect(round.kind === 'arc' && round.ccw).toBe(true);
    expect(round.kind === 'arc' && round.center.map(r6)).toEqual([38, 2]);
    expect(round.source).toEqual({ kind: 'edge', edge: expect.stringContaining('fillet#1') });
    expect(holes.map(shape)).toEqual([['circle'], ['circle']]);
    const radii = holes
      .map((h) => {
        const c = h.segments[0]!;
        if (c.kind !== 'arc') throw new Error('expected a circle');
        expect(c.ccw).toBe(false);
        return Math.hypot(c.start[0] - c.center[0], c.start[1] - c.center[1]);
      })
      .sort();
    expect(radii.map(r6)).toEqual([3, 4]);
    expect(p.values).toMatchObject({
      kind: 'profile',
      tool: { id: T, diameter: 6.35, fluteLength: 19, flutes: 2, number: 201 },
      // Spindle and plunge from the plywood preset, the cut feed from the operation's `feed`.
      feeds: { spindle: 18000, cut: 1200, plunge: 500 },
      side: 'outside',
      depth: { top: 0, bottom: -6.5 },
      stepdown: 2,
      finishAllowance: 0.2,
      tabs: { count: 4, width: 6, height: 2 },
      leadIn: { kind: 'arc', radius: 2 },
      leadOut: { kind: 'none' },
      climb: true,
      // Not in core yet: a finishing pass because of the allowance, in one step (6.5 <= 19).
      finishPass: true,
      finishStepdown: 6.5,
    });
    const entry = (p.values as { entry: { kind: string; angle: number } }).entry;
    expect(entry.kind).toBe('ramp');
    expect(entry.angle).toBeCloseTo((3 * Math.PI) / 180, 12);

    // The pocket: the loose sketch's rectangle, half the thickness deep from its plane.
    const k = op(r, 'pocket#1');
    expect(k.status).toBe('ok');
    const region = k.sources[0]!;
    expect(region.kind === 'region' && region.z).toBeCloseTo(0, 9);
    expect(region.kind === 'region' && region.planar.loops.map(shape)).toEqual([
      ['line', 'line', 'line', 'line'],
    ]);
    expect(region.kind === 'region' && region.planar.loops[0]!.segments[0]!.source).toEqual({
      kind: 'sketch',
      sketch: 'sketch#4',
      entity: 'e8',
    });
    expect(k.values).toMatchObject({
      kind: 'pocket',
      depth: { top: 0, bottom: -3 },
      stepover: 0.4,
    });

    // The drill: the through-hole under the counterbore, 2 mm down, through the 6 mm plate.
    const d = op(r, 'drill#1');
    expect(d.status).toBe('ok');
    const holeSource = d.sources[0]!;
    if (holeSource.kind !== 'hole') throw new Error('expected a hole source');
    expect(holeSource.points).toHaveLength(1);
    const point = holeSource.points[0]!;
    expect(point.position.map(r6)).toEqual([8, 10, 4]);
    expect(point.axis.map(r6)).toEqual([0, 0, -1]);
    expect(point).toMatchObject({
      diameter: 4,
      through: true,
      source: { kind: 'hole', feature: 'hole#1' },
    });
    expect(point.depth).toBeCloseTo(4, 9);
    expect(d.values).toMatchObject({ kind: 'drill', peck: 2 });
  }, 60_000);

  it('follows #thickness with the depths and keeps every reference exact', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = machined();
    await engine.regen(doc);
    const before = (await engine.camGeometry(doc, S))!;
    doc = setThickness(doc, '8mm');
    await engine.regen(doc);
    const after = (await engine.camGeometry(doc, S))!;
    expect(after.cached).toBe(false);
    expect(after.key).not.toBe(before.key);
    expect(after.setup!.stockZ).toEqual({ top: 0, bottom: -8 });
    expect(op(after, 'profile#1').values).toMatchObject({ depth: { top: 0, bottom: -8.5 } });
    expect(op(after, 'pocket#1').values).toMatchObject({ depth: { top: 0, bottom: -4 } });
    const point = (op(after, 'drill#1').sources[0] as Extract<CamSourceResult, { kind: 'hole' }>)
      .points[0]!;
    expect(point.position[2]).toBeCloseTo(6, 9);
    expect(point.depth).toBeCloseTo(6, 9);
    expect(op(after, 'profile#1').references).toEqual([
      { source: 0, referenceId: 'r1', target: TOP, via: 'exact', fragile: false },
    ]);
    expect(after.operations.every((o) => o.status === 'ok' && o.warnings.length === 0)).toBe(true);
    // Every operation's key moved with the body.
    for (const o of after.operations) {
      expect(o.key).not.toBe(op(before, o.operationId).key);
    }
  }, 60_000);

  it('reports reference-lost on the operation whose sketch was deleted, and on it only', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = apply(machined(), { type: 'deleteFeature', partId: PART, featureId: 'sketch#4' });
    const r = (await engine.camGeometry(doc, S))!;
    expect(r.status).toBe('ok');
    expect(op(r, 'pocket#1')).toMatchObject({
      status: 'error',
      values: null,
      errors: [{ code: 'reference-lost', source: 0, missing: ['sketch#4'] }],
    });
    expect(op(r, 'profile#1').status).toBe('ok');
    expect(op(r, 'drill#1').status).toBe('ok');
  }, 60_000);

  it('sends no feature ops for a CAM-only edit, and nothing at all for an unchanged setup', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = machined();
    await engine.regen(doc);
    const first = (await engine.camGeometry(doc, S))!;
    expect(first.cached).toBe(false);

    // The same setup again: served whole, no kernel batch.
    const stats = engine.stats;
    const again = (await engine.camGeometry(doc, S))!;
    expect(again.cached).toBe(true);
    expect(again.key).toBe(first.key);
    expect(engine.stats.batches).toBe(stats.batches);
    expect(engine.camStats.resultHits).toBe(1);

    // A CAM-only edit: a feed. No feature op, no new face resolution or loops.
    const cam = engine.camStats;
    doc = apply(doc, {
      type: 'editCamOperation',
      setupId: S,
      operation: { ...profile, feeds: { cut: mm('900mm/min') } } as CamOperation,
    });
    const edited = (await engine.camGeometry(doc, S))!;
    expect(edited.cached).toBe(false);
    expect(engine.stats.featureOps).toBe(stats.featureOps);
    expect(engine.camStats.faceLoopsOps).toBe(cam.faceLoopsOps);
    expect(engine.camStats.resolveOps).toBe(cam.resolveOps);
    expect(engine.camStats.tessellateOps).toBe(cam.tessellateOps);
    expect(op(edited, 'profile#1').values).toMatchObject({ feeds: { cut: 900 } });
    // Only the edited operation's key changed.
    expect(op(edited, 'profile#1').key).not.toBe(op(first, 'profile#1').key);
    expect(op(edited, 'pocket#1').key).toBe(op(first, 'pocket#1').key);
    expect(op(edited, 'drill#1').key).toBe(op(first, 'drill#1').key);
  }, 60_000);

  it('never cancels a regen: it runs at the current generation, and a newer number is lowered', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = machined();
    await engine.regen(doc);
    // A regen in flight, then a CAM request at the current generation: both complete.
    const thicker = setThickness(doc, '7mm');
    const regen = engine.regen(thicker);
    const geometry = engine.camGeometry(thicker, S, { generation: engine.generation });
    const [built, cam] = await Promise.all([regen, geometry]);
    expect(built).not.toBeNull();
    expect(cam).not.toBeNull();
    expect(cam!.generation).toBe(built!.generation);
    expect(cam!.setup!.stockZ.bottom).toBeCloseTo(-7, 9);

    // A wrong, far newer generation is lowered to the newest seen, so the kernel never sees it
    // and the next regen (one past the newest seen) still runs.
    const wrong = (await engine.camGeometry(doc, S, { generation: 1_000_000 }))!;
    expect(wrong.generation).toBe(built!.generation);
    expect(service.stats().generation).toBeLessThan(1_000_000);
    expect(await engine.regen(doc)).not.toBeNull();

    // A request older than the newest regen is superseded.
    expect(await engine.camGeometry(doc, S, { generation: 1 })).toBeNull();
  }, 60_000);

  it('resolves a WCS up from a face, sends the CAM mesh when asked, and refuses what cannot be cut from above', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const fromFace = machined(undefined, {
      wcs: {
        up: { kind: 'face', face: { id: 'r2', ref: { face: TOP } } },
        origin: { xy: 'centre', z: 'bottom' },
      },
    });
    const r = (await engine.camGeometry(fromFace, S, { mesh: true }))!;
    expect(r.status).toBe('ok');
    expect(r.setup!.wcs.up).toEqual({ kind: 'face', normal: [0, 0, 1] });
    expect(r.references).toEqual([
      { source: 'wcs', referenceId: 'r2', target: TOP, via: 'exact', fragile: false },
    ]);
    // Origin on the stock bottom: the top face is at machine Z 6.
    expect(r.setup!.stockZ).toEqual({ top: 6, bottom: 0 });
    expect(face(op(r, 'profile#1')).z).toBeCloseTo(6, 9);
    expect(op(r, 'profile#1').values).toMatchObject({ depth: { top: 6, bottom: -0.5 } });
    // The mesh at the CAM tolerance: every vertex within the plate, and a fine round.
    expect(r.mesh!.indices.length % 3).toBe(0);
    expect(r.mesh!.positions.length).toBeGreaterThan(0);
    expect(CAM_MESH_DEFLECTION.linear).toBe(0.004);

    // Up along +x: the top face, the sketch and the hole are all on edge.
    const sideways = machined(undefined, {
      wcs: { up: { kind: 'axis', axis: '+x' }, origin: { xy: 'front-left', z: 'top' } },
    });
    const s = (await engine.camGeometry(sideways, S))!;
    expect(s.operations.map((o) => [o.operationId, o.status, o.errors[0]?.code])).toEqual([
      ['profile#1', 'error', 'not-parallel'],
      ['pocket#1', 'error', 'not-parallel'],
      ['drill#1', 'error', 'not-parallel'],
    ]);
  }, 60_000);

  it('reports a lost WCS face on the setup, expressions and missing feeds on their operation', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const lost = machined(undefined, {
      wcs: {
        up: { kind: 'face', face: { id: 'r2', ref: { face: 'extrude#9:cap:end' } } },
        origin: { xy: 'front-left', z: 'top' },
      },
    });
    const r = (await engine.camGeometry(lost, S))!;
    expect(r.status).toBe('error');
    expect(r.errors).toMatchObject([
      { code: 'reference-lost', referenceId: 'r2', field: ['wcs', 'up', 'face'] },
    ]);
    expect(r.operations.every((o) => o.status === 'error' && o.errors[0]!.code === 'setup')).toBe(
      true,
    );

    const bad = machined(
      [{ ...pocket, depth: { kind: 'blind', depth: mm('5deg') } } as CamOperation, drill],
      {
        stock: {
          kind: 'fromBody',
          margins: {
            xMin: mm('0'),
            xMax: mm('0'),
            yMin: mm('0'),
            yMax: mm('0'),
            top: mm('0'),
            bottom: mm('0'),
          },
        },
      },
    );
    const e = (await engine.camGeometry(bad, S))!;
    expect(e.status).toBe('ok');
    expect(op(e, 'pocket#1').errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'expression', field: ['depth', 'depth'] }),
      ]),
    );
    // No material on the stock, so no preset: the drill has no feeds.
    expect(op(e, 'drill#1').errors.map((x) => [x.code, x.field])).toEqual([
      ['feeds', ['feeds', 'spindle']],
      ['feeds', ['feeds', 'cut']],
      ['feeds', ['feeds', 'plunge']],
    ]);
  }, 60_000);

  it('refuses a peck so small that the deepest hole would take more than 10000 pecks', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    expect(CAM_DRILL_MAX_PECKS).toBe(10000);
    // The through-hole is 4 mm deep: pecks of 0.0001 mm would be 40000.
    const tiny = machined([{ ...drill, peck: mm('0.0001') } as CamOperation]);
    const r = (await engine.camGeometry(tiny, S))!;
    expect(op(r, 'drill#1').errors).toEqual([
      expect.objectContaining({
        field: ['peck'],
        message: `The peck depth is too small: the deepest hole (4 mm) would take 40000 pecks, and at most ${CAM_DRILL_MAX_PECKS} are allowed`,
      }),
    ]);
    // 0.0004 mm is exactly 10000 pecks: allowed.
    const most = machined([{ ...drill, peck: mm('0.0004') } as CamOperation]);
    const m = (await engine.camGeometry(most, S))!;
    expect(op(m, 'drill#1').errors).toEqual([]);
  }, 60_000);

  it('refuses more tabs than a loop may have, and a tool finer than 0.01 mm', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const tabs = { count: mm('1001'), width: mm('6'), height: mm('2') };
    const many = machined([{ ...profile, tabs } as CamOperation]);
    const r = (await engine.camGeometry(many, S))!;
    expect(op(r, 'profile#1').errors).toEqual([
      expect.objectContaining({
        field: ['tabs', 'count'],
        message: `The tab count must be at most ${CAM_MAX_TABS}`,
      }),
    ]);
    expect(CAM_MAX_TABS).toBe(1000);
    const fine = apply(machined([profile]), {
      type: 'editCamTool',
      tool: { ...tool, diameter: mm('0.001') },
    });
    const f = (await engine.camGeometry(fine, S))!;
    expect(op(f, 'profile#1').errors).toEqual([
      expect.objectContaining({
        field: ['tool', 'diameter'],
        message: `${T}: the diameter must be at least ${CAM_MIN_TOOL_DIAMETER} mm`,
      }),
    ]);
    const smallest = apply(machined([profile]), {
      type: 'editCamTool',
      tool: { ...tool, diameter: mm(String(CAM_MIN_TOOL_DIAMETER)) },
    });
    const ok = (await engine.camGeometry(smallest, S))!;
    expect(op(ok, 'profile#1').errors.map((e) => e.field)).not.toContainEqual(['tool', 'diameter']);
  }, 60_000);

  it('misses the cache for an edit of a sketch no feature consumes, changing only its operation', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    let doc = machined();
    await engine.regen(doc);
    const before = (await engine.camGeometry(doc, S))!;
    doc = apply(doc, { type: 'editFeature', partId: PART, feature: recessOf('8') });
    const regen = (await engine.regen(doc))!;
    // No body changed: only the sketch's own key tells.
    expect(regen.parts[0]!.bodies[0]!.bodyKey).toBe(before.bodyKey);
    const after = (await engine.camGeometry(doc, S))!;
    expect(after.cached).toBe(false);
    expect(after.key).not.toBe(before.key);
    const width = (r: CamGeometryResult) => {
      const region = op(r, 'pocket#1').sources[0]!;
      if (region.kind !== 'region') throw new Error('expected a region');
      const xs = region.planar.loops[0]!.segments.flatMap((g) => [g.start[0], g.end[0]]);
      return r6(Math.max(...xs) - Math.min(...xs));
    };
    expect([width(before), width(after)]).toEqual([6, 8]);
    expect(op(after, 'pocket#1').key).not.toBe(op(before, 'pocket#1').key);
    expect(op(after, 'profile#1').key).toBe(op(before, 'profile#1').key);
    expect(op(after, 'drill#1').key).toBe(op(before, 'drill#1').key);
  }, 60_000);

  it('starts every cut at the stock top, above sources lying lower', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const zero = mm('0');
    const doc = machined(undefined, {
      stock: {
        kind: 'fromBody',
        margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: mm('2'), bottom: zero },
        material: 'plywood',
      },
    });
    const r = (await engine.camGeometry(doc, S))!;
    expect(r.setup!.stockZ).toEqual({ top: 0, bottom: -8 });
    expect(face(op(r, 'profile#1')).z).toBeCloseTo(-2, 9);
    expect(op(r, 'profile#1').values).toMatchObject({ depth: { top: 0, bottom: -8.5 } });
    // Blind: half the thickness below the region, which is 2 mm under the stock top.
    const pocketDepth = (op(r, 'pocket#1').values as { depth: { top: number; bottom: number } })
      .depth;
    expect(pocketDepth.top).toBe(r.setup!.stockZ.top);
    expect(pocketDepth.bottom).toBeCloseTo(-5, 9);
  }, 60_000);

  it('ends a pocket on a face at that face, its floor, whatever its depth says', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const floor: CamOperation = {
      ...pocket,
      geometry: [{ kind: 'face', face: { id: 'r2', ref: { face: 'hole#1:cbore-floor:e7' } } }],
      depth: { kind: 'through', extra: mm('1') },
    } as CamOperation;
    const r = (await engine.camGeometry(machined([floor]), S))!;
    const k = op(r, 'pocket#1');
    expect(k.status).toBe('ok');
    // The counterbore is 2 mm deep in the 6 mm plate: its floor is at machine Z -2.
    expect(face(k).z).toBeCloseTo(-2, 9);
    const depth = (k.values as { depth: { top: number; bottom: number } }).depth;
    expect(depth.top).toBe(0);
    expect(depth.bottom).toBeCloseTo(-2, 9);
    // Its outline: the counterbore's circle around the through-hole.
    expect(face(k).planar.loops.map(shape)).toEqual([['circle'], ['circle']]);

    // Several floors: the pocket stops at the highest (the plate's top at 0, above the
    // counterbore floor at -2), with a warning.
    const two = {
      ...floor,
      geometry: [...floor.geometry, { kind: 'face', face: { id: 'r3', ref: { face: TOP } } }],
    } as CamOperation;
    const t = op((await engine.camGeometry(machined([two]), S))!, 'pocket#1');
    expect(t.status).toBe('error'); // the plate's top is at the stock top: nothing to cut
    expect(t.warnings).toMatchObject([
      { code: 'heights', message: expect.stringContaining('ends at the highest floor') },
    ]);
    const margin = machined([two], {
      stock: {
        kind: 'fromBody',
        margins: {
          xMin: mm('0'),
          xMax: mm('0'),
          yMin: mm('0'),
          yMax: mm('0'),
          top: mm('1'),
          bottom: mm('0'),
        },
        material: 'plywood',
      },
    });
    const u = op((await engine.camGeometry(margin, S))!, 'pocket#1');
    expect(u.status).toBe('ok');
    expect(u.warnings.map((w) => w.code)).toEqual(['heights']);
    const highest = (u.values as { depth: { top: number; bottom: number } }).depth;
    expect(highest.top).toBe(0);
    expect(highest.bottom).toBeCloseTo(-1, 9);

    // A face looking down is an underside, never a floor; a profile still takes it as an outline.
    const bottom = { kind: 'face', face: { id: 'r4', ref: { face: 'extrude#1:cap:start' } } };
    const under = { ...floor, geometry: [bottom] } as CamOperation;
    const d = op((await engine.camGeometry(machined([under]), S))!, 'pocket#1');
    expect(d).toMatchObject({
      status: 'error',
      errors: [{ code: 'invalid', source: 0, message: expect.stringContaining('faces up') }],
    });
    const outline = { ...profile, geometry: [bottom] } as CamOperation;
    const o = op((await engine.camGeometry(machined([outline]), S))!, 'profile#1');
    expect(o.status).toBe('ok');
    expect(face(o).facing).toBe(false);

    // A floor face and a region in one pocket do not mix.
    const mixed = { ...floor, geometry: [...floor.geometry, ...pocket.geometry] } as CamOperation;
    const m = (await engine.camGeometry(machined([mixed]), S))!;
    expect(op(m, 'pocket#1').errors).toMatchObject([{ code: 'invalid', field: ['geometry'] }]);
  }, 60_000);

  it("drills the bracket's two holes from their walls when a drill picks nothing", async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const all: CamOperation = { ...drill, geometry: [] };
    const doc = machined([all]);
    await engine.regen(doc);
    const r = (await engine.camGeometry(doc, S))!;
    const d = op(r, 'drill#1');
    expect(d.status).toBe('ok');
    expect(d.errors).toEqual([]);
    // The counterbore's wide wall sits above the narrow one: left to a pocket, a note says so.
    expect(d.warnings.map((w) => [w.code, w.message])).toEqual([
      [
        'hole-steps',
        expect.stringMatching(
          /^The 8 mm step of the 4 mm hole at \(8, 10, 4\) .* is left to a pocket/,
        ),
      ],
    ]);
    expect(engine.camStats.topologyOps).toBe(1);
    const walls = d.sources[0]!;
    if (walls.kind !== 'holeWalls') throw new Error('expected hole walls');
    expect(walls.source).toBe('body');
    // The 6 mm hole of extrude#2 and the 4 mm through-hole of the counterbore, whose 8 mm wall is
    // left to a pocket. Machine coordinates: front-left top origin on a stock with no margins, so
    // machine Z is model Z less the 6 mm plate.
    const machine = walls.points
      .map((p) => ({
        at: [r6(p.position[0]), r6(p.position[1])],
        top: r6(p.position[2] - 6),
        bottom: r6(p.position[2] - 6 - p.depth),
        diameter: r6(p.diameter),
        through: p.through,
        axis: p.axis.map(r6),
      }))
      .sort((a, b) => a.at[0]! - b.at[0]!);
    expect(machine).toEqual([
      { at: [8, 10], top: -2, bottom: -6, diameter: 4, through: true, axis: [0, 0, -1] },
      { at: [20, 10], top: 0, bottom: -6, diameter: 6, through: true, axis: [0, 0, -1] },
    ]);
    // The same body again: the topology is not asked for twice.
    await engine.camGeometry(machined([{ ...all, name: 'Renamed' }]), S);
    expect(engine.camStats.topologyOps).toBe(1);

    // A blind operation depth replaces the walls' depths like a hole feature's.
    const blind: CamOperation = { ...all, depth: { kind: 'blind', depth: mm('3') } };
    const b = op((await engine.camGeometry(machined([blind]), S))!, 'drill#1');
    const bw = b.sources[0] as Extract<CamSourceResult, { kind: 'holeWalls' }>;
    expect(bw.points.map((p) => [r6(p.depth), p.through])).toEqual([
      [3, undefined],
      [3, undefined],
    ]);
  }, 60_000);

  it('drills a two-arc circle cut through plates of any thickness at any height, origin top or bottom', async () => {
    // The 6 mm hole of the bracket drawn as two arcs: the kernel makes its wall two half faces.
    const plate = (z0: number): ManufaktureDocument => {
      const json = JSON.parse(
        readFileSync(new URL('../../core/src/fixtures/v14-bracket.json', import.meta.url), 'utf8'),
      );
      const features = json.parts[0].features as { id: string; [k: string]: unknown }[];
      features.find((f) => f.id === 'extrude#2')!.reverse = true;
      const base = features.find((f) => f.id === 'sketch#1') as unknown as {
        plane: { origin: number[] };
      };
      base.plane.origin = [0, 0, z0];
      json.parts[0].nextIds.e = 7;
      Object.assign(
        features.find((f) => f.id === 'sketch#2')!,
        {
          entities: [
            {
              id: 'e5',
              kind: 'arc',
              construction: false,
              center: [20, 10],
              start: [23, 10],
              end: [17, 10],
            },
            {
              id: 'e6',
              kind: 'arc',
              construction: false,
              center: [20, 10],
              start: [17, 10],
              end: [23, 10],
            },
          ],
          constraints: [],
        },
      );
      return unwrap(parseDocument(json)).document;
    };
    const engine = new RegenEngine({ kernel: service, solver });
    const failures: string[] = [];
    for (const thickness of [6.35, 12.7, 6, 19.05]) {
      for (const z0 of [0, 0.7, 1.1, 2.54]) {
        for (const origin of ['top', 'bottom'] as const) {
          const doc = apply(
            setThickness(plate(z0), `${thickness}mm`),
            { type: 'addCamTool', tool },
            {
              type: 'addCamSetup',
              setup: setup([{ ...drill, geometry: [] }], {
                wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: origin } },
              }),
            },
          );
          await engine.regen(doc);
          const d = op((await engine.camGeometry(doc, S))!, 'drill#1');
          const s = d.sources[0];
          const p = s?.kind === 'holeWalls' && s.points.length === 1 ? s.points[0]! : undefined;
          const ok =
            d.status === 'ok' &&
            d.warnings.length === 0 &&
            p !== undefined &&
            p.through === true &&
            Math.abs(p.diameter - 6) < 1e-6 &&
            Math.abs(p.depth - thickness) < 1e-6 &&
            [r6(p.position[0]), r6(p.position[1]), r6(p.position[2] - z0)].join() ===
              [20, 10, r6(thickness)].join();
          if (!ok) {
            failures.push(
              `${thickness} mm at Z ${z0}, origin ${origin}: ${JSON.stringify({ errors: d.errors, warnings: d.warnings, sources: d.sources })}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('skips a hole under material (a side tunnel), and measures the clear height under a hole exiting into it', async () => {
    // A 40 x 20 x 10 block with a tunnel through it along Y (X 10 to 30, Z 3 to 6). Hole A, 6 mm,
    // goes down from the tunnel's floor at X 15: material above it. Hole B, 6 mm, comes down from
    // the top at X 25 into the tunnel's ceiling: through, with 3 mm clear below its exit.
    const circle = (
      id: string,
      entity: string,
      z0: number,
      at: [number, number],
    ): SketchFeature => ({
      id,
      kind: 'sketch',
      name: id,
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, z0], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [{ id: entity, kind: 'circle', construction: false, center: at, radius: 3 }],
      constraints: [],
    });
    const cut = (id: string, sketch: string, extent: ExtrudeFeature['extent']): ExtrudeFeature => ({
      ...extrude(id, sketch, '1', 'cut'),
      extent,
      reverse: true,
    });
    const tunnel = (drillOp: CamOperation) =>
      build([
        add(rectangle('sketch#1', { width: '40', depth: '20' })),
        add(extrude('extrude#1', 'sketch#1', '10')),
        add(
          rectangle('sketch#2', {
            width: '20',
            depth: '3',
            at: [10, 3],
            plane: { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
            ids: ['e5', 'e6', 'e7', 'e8'],
            firstConstraint: 20,
          }),
        ),
        add(cut('extrude#2', 'sketch#2', { type: 'throughAll' })),
        add(circle('sketch#3', 'e9', 3, [15, 10])),
        add(cut('extrude#3', 'sketch#3', { type: 'throughAll' })),
        add(circle('sketch#4', 'e10', 10, [25, 10])),
        add(cut('extrude#4', 'sketch#4', { type: 'blind', distance: mm('5') })),
        { type: 'addCamTool', tool },
        { type: 'addCamSetup', setup: setup([drillOp]) },
      ]);
    const doc = tunnel({ ...drill, geometry: [] });
    const engine = new RegenEngine({ kernel: service, solver });
    const regen = (await engine.regen(doc))!;
    expect(regen.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    const d = op((await engine.camGeometry(doc, S))!, 'drill#1');
    expect(d.status).toBe('ok');
    expect(d.warnings.map((w) => [w.code, w.message])).toEqual([
      ['holes', expect.stringMatching(/^the 6 mm hole at \(15, 10, 3\) .*material above it/)],
    ]);
    const walls = d.sources[0] as Extract<CamSourceResult, { kind: 'holeWalls' }>;
    expect(walls.points).toHaveLength(1);
    const b = walls.points[0]!;
    expect([r6(b.position[0]), r6(b.position[1]), r6(b.position[2])]).toEqual([25, 10, 10]);
    expect(b.through).toBe(true);
    expect(b.depth).toBeCloseTo(4, 5);
    expect(b.clearBelow).toBeCloseTo(3, 4);

    // The operation's own depth, through the stock: hole B would cut the tunnel's 3 mm floor.
    // Its modelled clear height no longer applies, and a warning says so.
    const deep = tunnel({ ...drill, geometry: [], depth: { kind: 'through' } });
    await engine.regen(deep);
    const dd = op((await engine.camGeometry(deep, S))!, 'drill#1');
    expect(dd.status).toBe('ok');
    const deepPoint = (dd.sources[0] as Extract<CamSourceResult, { kind: 'holeWalls' }>).points[0]!;
    expect(deepPoint.through).toBe(true);
    expect(deepPoint.depth).toBeCloseTo(10, 5);
    expect(deepPoint.clearBelow).toBeUndefined();
    expect(dd.warnings.map((w) => [w.code, w.message])).toEqual([
      ['holes', expect.stringMatching(/material above it/)],
      [
        'holes',
        "The operation's depth goes past the modelled bottom or exit of the hole at (25, 10, 10) and cuts the material below it",
      ],
    ]);
    // A blind depth no deeper than the hole's own: no warning.
    const shallow = tunnel({ ...drill, geometry: [], depth: { kind: 'blind', depth: mm('3') } });
    await engine.regen(shallow);
    const ds = op((await engine.camGeometry(shallow, S))!, 'drill#1');
    expect(ds.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/material above it/)]);
    const sp = (ds.sources[0] as Extract<CamSourceResult, { kind: 'holeWalls' }>).points[0]!;
    expect([sp.depth, sp.through, sp.clearBelow]).toEqual([3, undefined, undefined]);
  }, 60_000);

  it('drills a hole through a web over a relief pocket cut from below as a through hole', async () => {
    const doc = build([
      add(rectangle('sketch#1', { width: '40', depth: '20' })),
      add(extrude('extrude#1', 'sketch#1', '10')),
      // The relief: 20 x 10, 4 mm up from the bottom.
      add(
        rectangle('sketch#2', {
          width: '20',
          depth: '10',
          at: [10, 5],
          ids: ['e5', 'e6', 'e7', 'e8'],
          firstConstraint: 20,
        }),
      ),
      add(extrude('extrude#2', 'sketch#2', '4', 'cut')),
      add({
        id: 'sketch#3',
        kind: 'sketch',
        name: 'sketch#3',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [{ id: 'e9', kind: 'circle', construction: false, center: [20, 10], radius: 3 }],
        constraints: [],
      }),
      add({
        ...extrude('extrude#3', 'sketch#3', '1', 'cut'),
        extent: { type: 'throughAll' },
        reverse: true,
      }),
      { type: 'addCamTool', tool },
      { type: 'addCamSetup', setup: setup([{ ...drill, geometry: [] }]) },
    ]);
    const engine = new RegenEngine({ kernel: service, solver });
    const regen = (await engine.regen(doc))!;
    expect(regen.parts[0]!.features.every((f) => f.status === 'ok')).toBe(true);
    const d = op((await engine.camGeometry(doc, S))!, 'drill#1');
    expect(d.status).toBe('ok');
    expect(d.warnings).toEqual([]);
    const walls = d.sources[0] as Extract<CamSourceResult, { kind: 'holeWalls' }>;
    expect(walls.points).toHaveLength(1);
    const p = walls.points[0]!;
    // Machine Z 0 at the top: the wall runs from 0 down to the relief's ceiling at -6.
    expect(p.position[2]).toBeCloseTo(10, 5);
    expect(p.depth).toBeCloseTo(6, 5);
    expect(p.through).toBe(true);
    // Open below the relief: nothing to cap the breakthrough.
    expect(p.clearBelow).toBeUndefined();
  }, 60_000);

  it('fails closed when the CAM mesh is missing or empty: a drill with no geometry drills nothing', async () => {
    // The stage directly, with no mesh kept between uses, over a host whose second tessellation
    // fails (or comes back empty): the bounds come from the first, the column check has none.
    const doc = machined([{ ...drill, geometry: [] }]);
    const box = new Float32Array([0, 0, 0, 40, 0, 0, 40, 20, 0, 0, 20, 6]);
    const topology: Topology = {
      faces: [
        {
          index: 0,
          surface: 'cylinder',
          centroid: [20, 10, 3],
          area: 2 * Math.PI * 3 * 6,
          normal: null,
          axis: [0, 0, 1],
          radius: 3,
          axisOrigin: [20, 10, 0],
          hole: true,
        },
      ],
      edges: [
        {
          index: 0,
          faces: [0],
          seam: true,
          curve: 'line',
          midpoint: [23, 10, 3],
          length: 6,
          vertices: [0, 1],
        },
      ],
      vertices: [
        { index: 0, point: [23, 10, 0], faces: [0] },
        { index: 1, point: [23, 10, 6], faces: [0] },
      ],
    };
    for (const second of ['fail', 'empty'] as const) {
      let tessellations = 0;
      const host: CamHost = {
        generation: 1,
        versions: { kernelBuild: 'test', namingScheme: 1, implementation: 1 },
        variables: evaluateVariables(doc.variables),
        part: () =>
          Promise.resolve({
            part: doc.parts[0]!,
            bodies: [{ id: 'extrude#1', shape: 1 as ShapeId, key: 'body', instance: null }],
            sketches: new Map(),
            inputs: new Map(),
            results: new Map(),
          }),
        run: (ops) =>
          Promise.resolve(
            ops.map((o): OpResult => {
              if (o.op === 'topology') return { ok: true, op: 'topology', value: topology, ms: 0 };
              tessellations++;
              if (tessellations > 1 && second === 'fail') {
                return {
                  ok: false,
                  op: 'tessellate',
                  error: { code: 'kernel', operation: 'tessellate', message: 'out of memory' },
                  ms: 0,
                } as OpResult;
              }
              const empty = tessellations > 1;
              const value = {
                positions: box,
                indices: empty ? new Uint32Array(0) : new Uint32Array([0, 1, 2, 0, 2, 3]),
              } as unknown as MeshData;
              return { ok: true, op: 'tessellate', value, ms: 0 };
            }),
          ),
      };
      const stage = new CamStage({ meshes: 0 });
      const r = await stage.geometry(host, doc, doc.cam.setups[0]!);
      expect(r.status).toBe('ok');
      const d = op(r, 'drill#1');
      expect(d.status).toBe('error');
      expect(d.errors).toEqual([
        expect.objectContaining({
          code: 'kernel',
          message: expect.stringContaining('drills nothing'),
        }),
      ]);
      expect(tessellations).toBe(2);
    }
  });

  it("evaluates a pocket's, a V-carve's and a 3D surfacing's optional fields (T5.5b)", async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const vbit: CamTool = {
      ...tool,
      id: 'tool#2',
      name: '60 deg V',
      kind: 'vbit',
      angle: deg('60'),
      presets: [],
    };
    const ball: CamTool = {
      ...tool,
      id: 'tool#3',
      name: '1/8" ball',
      kind: 'ball',
      diameter: mm('1/8"'),
    };
    const pocketExtras = {
      ...pocket,
      finishAllowance: mm('0.3'),
      finishPass: false,
      finishStepdown: mm('1'),
      floorAllowance: mm('0.2'),
      floorPass: true,
    } as CamOperation;
    const carve = {
      id: 'vcarve#1',
      kind: 'vcarve',
      name: 'Letters',
      suppressed: false,
      tool: 'tool#2',
      geometry: [{ kind: 'region', sketch: 'sketch#4' }],
      feeds: { spindle: mm('18000rpm'), cut: mm('800mm/min'), plunge: mm('300mm/min') },
      maxDepth: mm('1'),
      stepdown: mm('0.5'),
      flatStepover: mm('0.3'),
      clearing: {
        tool: T,
        stepover: mm('0.5'),
        entry: { kind: 'ramp', angle: deg('5') },
        feeds: { cut: mm('feed') },
      },
    } as CamOperation;
    const finish = {
      id: 'surface3d#1',
      kind: 'surface3d',
      name: 'Finish',
      suppressed: false,
      tool: 'tool#3',
      geometry: [{ kind: 'region', sketch: 'sketch#4' }],
      stepover: mm('0.5'),
      angle: deg('90'),
      strategy: 'parallel',
      tolerance: mm('0.02'),
      sampling: mm('0.1'),
      pattern: 'oneway',
      climb: false,
    } as CamOperation;
    const withTools = (operations: CamOperation[]) =>
      apply(
        bracket(),
        { type: 'setVariable', name: 'feed', expression: mm('1200mm/min') },
        add(holePoints),
        add(hole),
        add(recess),
        { type: 'addCamTool', tool },
        { type: 'addCamTool', tool: vbit },
        { type: 'addCamTool', tool: ball },
        { type: 'addCamSetup', setup: setup(operations) },
      );
    let doc = withTools([pocketExtras, carve, finish]);
    const r = (await engine.camGeometry(doc, S))!;
    expect(op(r, 'pocket#1').values).toMatchObject({
      finishPass: false,
      finishStepdown: 1,
      floorAllowance: 0.2,
      floorPass: true,
    });
    const v = op(r, 'vcarve#1');
    expect(v.errors).toEqual([]);
    expect(v.values).toMatchObject({
      maxDepth: 1,
      stepdown: 0.5,
      flatStepover: 0.3,
      clearing: {
        tool: { id: T, kind: 'flat' },
        // The cut feed from the operation, the rest from the flat's plywood preset.
        feeds: { spindle: 18000, cut: 1200, plunge: 500 },
        stepdown: 2,
        stepover: 0.5,
        entry: { kind: 'ramp', angle: expect.closeTo((5 * Math.PI) / 180, 9) },
      },
    });
    const f = op(r, 'surface3d#1');
    expect(f.errors).toEqual([]);
    // The region bounds the finish; the mesh comes along for it.
    expect(f.sources.map((x) => x.kind)).toEqual(['region']);
    expect(f.values).toEqual(
      expect.objectContaining({
        stepover: 0.5,
        allowance: 0,
        strategy: 'parallel',
        tolerance: 0.02,
        sampling: 0.1,
        pattern: 'oneway',
        climb: false,
      }),
    );
    expect(f.values).not.toHaveProperty('stepdown');
    expect(r.mesh?.indices.length).toBeGreaterThan(0);

    // The clearing tool's definition is in the V-carve's key, and only there.
    const keys = (x: CamGeometryResult) => x.operations.map((o) => o.key);
    doc = apply(doc, { type: 'editCamTool', tool: { ...tool, flutes: 3 } });
    const edited = (await engine.camGeometry(doc, S))!;
    expect(keys(edited)[1]).not.toBe(keys(r)[1]);
    expect(keys(edited)[2]).toBe(keys(r)[2]);

    // Out of range, the wrong clearing tool, and a clearing with no maximum depth.
    const { maxDepth: _m, ...rest } = carve as CamOperation & { maxDepth?: unknown };
    void _m;
    const unbound = rest as CamOperation;
    const bad = withTools([
      { ...pocketExtras, floorAllowance: mm('4') } as CamOperation,
      { ...unbound, clearing: { tool: 'tool#2' } } as CamOperation,
      {
        ...finish,
        tolerance: mm('2'),
        sampling: mm('0.0001'),
        stepover: mm('5'),
      } as CamOperation,
    ]);
    const b = (await engine.camGeometry(bad, S))!;
    expect(op(b, 'pocket#1').errors.map((e) => e.field)).toEqual([['floorAllowance']]);
    expect(op(b, 'vcarve#1').errors).toEqual([
      expect.objectContaining({
        field: ['clearing', 'tool'],
        message: 'The clearing tool must be a flat or bull end mill, not a vbit tool',
      }),
    ]);
    expect(op(b, 'surface3d#1').errors.map((e) => e.field)).toEqual([
      ['stepover'],
      ['tolerance'],
      ['sampling'],
    ]);
    const unbounded = withTools([unbound]);
    const u = (await engine.camGeometry(unbounded, S))!;
    expect(op(u, 'vcarve#1').warnings.map((w) => w.code)).toEqual(['clearing']);

    // Entry angles below half a degree: a ramp or helix that long would be millions of moves.
    const shallow = deg('0.1');
    const steep = withTools([
      { ...pocketExtras, entry: { kind: 'ramp', angle: shallow } } as CamOperation,
      {
        ...carve,
        clearing: {
          tool: T,
          stepover: mm('0.5'),
          entry: { kind: 'helix', angle: shallow, radius: mm('1') },
          feeds: { cut: mm('feed') },
        },
      } as CamOperation,
      {
        ...finish,
        strategy: 'zlevel',
        entry: { kind: 'helix', angle: shallow, radius: mm('1') },
      } as CamOperation,
    ]);
    const a = (await engine.camGeometry(steep, S))!;
    expect(op(a, 'pocket#1').errors).toEqual([
      expect.objectContaining({
        field: ['entry', 'angle'],
        message: 'The entry angle must be at least 0.5 and at most 90 degrees',
      }),
    ]);
    expect(op(a, 'vcarve#1').errors).toEqual([
      expect.objectContaining({
        field: ['clearing', 'entry', 'angle'],
        message: 'The clearing entry angle must be at least 0.5 and at most 90 degrees',
      }),
    ]);
    expect(op(a, 'surface3d#1').errors.map((e) => e.field)).toEqual([['entry', 'angle']]);
    expect(CAM_MIN_ENTRY_ANGLE).toBeCloseTo((0.5 * Math.PI) / 180, 15);
  }, 60_000);

  it('rejects a setup the document does not have', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    await expect(engine.camGeometry(machined(), 'setup#9')).rejects.toThrow(/no CAM setup/);
  });
});

describe('holeWallPoints', () => {
  const Z: [number, number, number] = [0, 0, 1];
  /** A mesh with nothing in it: no material above or below any hole. */
  const NO_MESH = { positions: new Float32Array(0), indices: new Uint32Array(0) };
  /** Planes the walls' ends meet: facing up (a top face or floor) and facing down. */
  const UP = 100;
  const DOWN = 101;
  const planes: FaceInfo[] = [
    {
      index: UP,
      surface: 'plane',
      centroid: [0, 0, 10],
      area: 1,
      normal: [0, 0, 1],
      axis: null,
      radius: null,
    },
    {
      index: DOWN,
      surface: 'plane',
      centroid: [0, 0, 0],
      area: 1,
      normal: [0, 0, -1],
      axis: null,
      radius: null,
    },
  ];
  let edges: EdgeInfo[] = [];
  let vertices: VertexInfo[] = [];
  /**
   * A cylinder face of radius `r` about (x, y) from model Z `z0` to `z1`, `share` of a full turn,
   * its top circle meeting face `top` and its bottom circle face `bottom`.
   */
  function wall(
    index: number,
    [x, y]: [number, number],
    r: number,
    z0: number,
    z1: number,
    {
      top = UP,
      bottom = DOWN,
      share = 1,
      ...over
    }: Partial<FaceInfo> & {
      top?: number;
      bottom?: number;
      share?: number;
    } = {},
  ): FaceInfo {
    for (const [z, other] of [
      [z0, bottom],
      [z1, top],
    ] as const) {
      const v = vertices.length;
      vertices.push({ index: v, point: [x + r, y, z], faces: [index, other] });
      edges.push({
        index: edges.length,
        faces: [index, other],
        seam: false,
        curve: 'circle',
        midpoint: [x - r, y, z],
        length: share * 2 * Math.PI * r,
        vertices: [v],
      });
    }
    return {
      index,
      surface: 'cylinder',
      centroid: [x, y, (z0 + z1) / 2],
      area: share * 2 * Math.PI * r * (z1 - z0),
      normal: null,
      axis: [0, 0, index % 2 === 0 ? 1 : -1],
      radius: r,
      axisOrigin: [x, y, -3],
      hole: true,
      ...over,
    };
  }
  const topo = (faces: FaceInfo[]) => ({ faces: [...faces, ...planes], edges, vertices });
  /**
   * A wall in two half-cylinder faces `i` (front, y < centre) and `j` (back), as a two-arc circle
   * cut makes it: half-circle end edges, and two lines along the axis between the halves whose
   * midpoints sit at mid-height give or take the rounding a real kernel leaves (`eps`).
   */
  function halves(
    i: number,
    j: number,
    [x, y]: [number, number],
    r: number,
    z0: number,
    z1: number,
    eps: number,
    { top = UP, bottom = DOWN }: { top?: number; bottom?: number } = {},
  ): FaceInfo[] {
    const v = (point: [number, number, number]) => {
      vertices.push({ index: vertices.length, point, faces: [i, j] });
      return vertices.length - 1;
    };
    const right = [v([x + r, y, z0]), v([x + r, y, z1])];
    const left = [v([x - r, y, z0]), v([x - r, y, z1])];
    const mid = (z0 + z1) / 2;
    for (const [face, side] of [
      [i, -1],
      [j, 1],
    ] as const) {
      for (const [z, other, k] of [
        [z0, bottom, 0],
        [z1, top, 1],
      ] as const) {
        edges.push({
          index: edges.length,
          faces: [face, other],
          seam: false,
          curve: 'circle',
          midpoint: [x, y + side * r, z],
          length: Math.PI * r,
          vertices: [right[k]!, left[k]!],
        });
      }
    }
    for (const [pair, e] of [
      [right, eps],
      [left, -eps],
    ] as const) {
      edges.push({
        index: edges.length,
        faces: [i, j],
        seam: false,
        curve: 'line',
        midpoint: [vertices[pair[0]!]!.point[0], y, mid + e],
        length: z1 - z0,
        vertices: [pair[0]!, pair[1]!],
      });
    }
    const half = (index: number, side: number): FaceInfo => ({
      index,
      surface: 'cylinder',
      centroid: [x, y + (side * 2 * r) / Math.PI, mid],
      area: Math.PI * r * (z1 - z0),
      normal: null,
      axis: [0, 0, 1],
      radius: r,
      axisOrigin: [x, y, 0],
      hole: true,
    });
    return [half(i, -1), half(j, 1)];
  }
  const reset = () => {
    edges = [];
    vertices = [];
  };

  it('finds through and blind holes, with machine Z from the origin', () => {
    reset();
    const faces = [wall(0, [5, 5], 2, 0, 10), wall(1, [15, 5], 1.5, 4, 10, { bottom: UP })];
    // Origin on the top (setup Z 10): machine Z is model Z less 10; the body bottom is at -10.
    const found = holeWallPoints(topo(faces), Z, 10, -10, NO_MESH);
    expect(found.points).toEqual([
      { position: [5, 5, 10], axis: [0, 0, -1], diameter: 4, depth: 10, through: true },
      { position: [15, 5, 10], axis: [0, 0, -1], diameter: 3, depth: 6 },
    ]);
    expect(found.warnings).toEqual([]);
  });

  it('joins a wall split in halves, drills a counterbore through its floor, and a countersink', () => {
    reset();
    const faces: FaceInfo[] = [
      wall(0, [5, 5], 2, 0, 8, { share: 0.5, top: 50 }),
      wall(1, [5, 5], 2, 0, 8, { share: 0.5, top: 50 }),
      // The counterbore over it: 4 mm radius from 8 to 10, its floor (face 50) facing up.
      wall(2, [5, 5], 4, 8, 10, { bottom: 50 }),
      { ...planes[0]!, index: 50, centroid: [5, 5, 8] },
      // A countersunk hole: a cone widening from the wall's top at 7 up to the top face.
      wall(3, [20, 5], 1.5, 0, 7, { top: 60 }),
      {
        index: 60,
        surface: 'cone',
        centroid: [20, 5, 8.5],
        area: 1,
        normal: null,
        axis: null,
        radius: null,
      },
    ];
    // The cone's wide edge, radius 3 at Z 10, with the top face.
    const v = vertices.length;
    vertices.push({ index: v, point: [23, 5, 10], faces: [60, UP] });
    edges.push({
      index: edges.length,
      faces: [60, UP],
      seam: false,
      curve: 'circle',
      midpoint: [17, 5, 10],
      length: 6 * Math.PI,
      vertices: [v],
    });
    const found = holeWallPoints(topo(faces), Z, 10, -10, NO_MESH);
    expect(found.points).toEqual([
      { position: [5, 5, 8], axis: [0, 0, -1], diameter: 4, depth: 8, through: true },
      { position: [20, 5, 7], axis: [0, 0, -1], diameter: 3, depth: 7, through: true },
    ]);
    expect(found.warnings).toEqual([]);
    expect(found.notes).toEqual([
      'The 8 mm step of the 4 mm hole at (5, 5, 8) (face #0, #1) is left to a pocket: only the 4 mm hole is drilled',
    ]);
  });

  it('drills a through hole whose wall is two halves, whatever rounding leaves at mid-height', () => {
    for (const eps of [1e-15, -1e-15, 0, 3e-16]) {
      reset();
      const found = holeWallPoints(
        topo(halves(0, 1, [5, 5], 3, 1.1, 7.45, eps)),
        Z,
        7.45,
        -6.35,
        NO_MESH,
      );
      expect(found.warnings).toEqual([]);
      expect(found.points).toHaveLength(1);
      expect(found.points[0]).toMatchObject({ diameter: 6, through: true });
      expect(found.points[0]!.position.map(r6)).toEqual([5, 5, 7.45]);
      expect(found.points[0]!.depth).toBeCloseTo(6.35, 12);
    }
    // Halves of a blind hole whose mouth opens on the bottom face are still not reachable.
    reset();
    const below = holeWallPoints(
      topo(halves(0, 1, [5, 5], 3, 0, 4, 1e-15, { top: DOWN })),
      Z,
      10,
      -10,
      NO_MESH,
    );
    expect(below.points).toEqual([]);
    expect(below.warnings).toEqual([expect.stringContaining('(face #0, #1) is not reachable')]);
  });

  it('keeps a hole with a sloped top, a chamfered or filleted mouth; an unknown surface is unclassified', () => {
    reset();
    // A 10 degree sloped top: the wall's area is short of a full cylinder of its height, but its
    // flat bottom edge goes all the way round.
    const sloped = wall(0, [5, 5], 2, 0, 10, { area: 2 * Math.PI * 2 * 9.3 });
    const topEdge = edges.find((e) => e.faces.includes(0) && e.faces.includes(UP))!;
    edges = edges.map((e) =>
      e === topEdge ? { ...e, midpoint: [3, 5, 9.3], length: 2 * Math.PI * 2 * 1.008 } : e,
    );
    expect(holeWallPoints(topo([sloped]), Z, 10, -10, NO_MESH).points).toHaveLength(1);

    // A fillet (torus) at the mouth widening up to the top face, and an unknown surface.
    reset();
    const fillet: FaceInfo = {
      index: 60,
      surface: 'torus',
      centroid: [5, 5, 9.7],
      area: 1,
      normal: null,
      axis: null,
      radius: null,
    };
    const spline: FaceInfo = {
      ...fillet,
      index: 61,
      surface: 'bsplinesurface',
      centroid: [15, 5, 9.7],
    };
    const faces = [
      wall(0, [5, 5], 2, 0, 9, { top: 60 }),
      fillet,
      wall(2, [15, 5], 2, 0, 9, { top: 61 }),
      spline,
    ];
    vertices.push({ index: vertices.length, point: [8, 5, 10], faces: [60, UP] });
    edges.push({
      index: edges.length,
      faces: [60, UP],
      seam: false,
      curve: 'circle',
      midpoint: [2, 5, 10],
      length: 6 * Math.PI,
      vertices: [vertices.length - 1],
    });
    const found = holeWallPoints(topo(faces), Z, 10, -10, NO_MESH);
    expect(found.points.map((p) => p.position.map(r6))).toEqual([[5, 5, 9]]);
    expect(found.warnings).toEqual([
      'the 4 mm hole at (15, 5, 9) (face #2) is not drilled: the top could not be classified (a bsplinesurface face #61 above it)',
    ]);
  });

  it('skips a hole opening on the bottom face, with a warning: it is not reachable from above', () => {
    reset();
    // The reviewer's probe: a plate Z 0 to 10, a 4 mm hole 4 deep from the bottom face. Its top
    // end meets the hole's own floor, which faces down.
    const found = holeWallPoints(
      topo([wall(0, [5, 5], 2, 0, 4, { top: DOWN })]),
      Z,
      10,
      -10,
      NO_MESH,
    );
    expect(found.points).toEqual([]);
    expect(found.warnings).toEqual([
      'the 4 mm hole at (5, 5, 4) (face #0) is not reachable from this setup: it is closed above; it is not drilled',
    ]);
    // A drill-point cone at its top end (drilled from below) does not open it either.
    reset();
    const tip: FaceInfo = { ...planes[0]!, index: 70, surface: 'cone', normal: null };
    const v = vertices.length;
    vertices.push({ index: v, point: [5, 5, 5.2], faces: [70] });
    edges.push({
      index: 99,
      faces: [70],
      seam: true,
      curve: 'line',
      midpoint: [5, 5, 5],
      length: 1,
      vertices: [v],
    });
    const pointed = holeWallPoints(
      topo([wall(0, [5, 5], 2, 0, 4, { top: 70 }), tip]),
      Z,
      10,
      -10,
      NO_MESH,
    );
    expect(pointed.points).toEqual([]);
    expect(pointed.warnings).toHaveLength(1);
  });

  it('skips an internal void, closed above and below', () => {
    reset();
    const found = holeWallPoints(
      topo([wall(0, [5, 5], 2, 3, 6, { top: DOWN, bottom: UP })]),
      Z,
      10,
      -10,
      NO_MESH,
    );
    expect(found.points).toEqual([]);
    expect(found.warnings).toEqual([expect.stringContaining('not reachable from this setup')]);
  });

  it('warns about an undercut below a narrower hole, and drills the narrow one', () => {
    reset();
    // A 2 mm hole from the top down to 6, then a 6 mm chamber from 6 down to 2: its top end is the
    // chamber's ceiling, facing down.
    const faces = [
      wall(0, [5, 5], 1, 6, 10, { bottom: 80 }),
      wall(2, [5, 5], 3, 2, 6, { top: 80, bottom: UP }),
    ];
    const ceiling: FaceInfo = { ...planes[1]!, index: 80 };
    const found = holeWallPoints(topo([...faces, ceiling]), Z, 10, -10, NO_MESH);
    expect(found.points.map((p) => [p.diameter, p.depth])).toEqual([[2, 4]]);
    expect(found.warnings).toEqual([
      'the 6 mm hole at (5, 5, 6) (face #2) is an undercut below the 2 mm hole at (5, 5, 10) (face #0): it is not reachable from this setup, and only the narrow hole is drilled',
    ]);
  });

  it('warns when same-radius walls with a gap between them are merged and dropped', () => {
    reset();
    const faces = [
      wall(0, [5, 5], 2, 6, 10, { bottom: UP }),
      wall(2, [5, 5], 2, 0, 3, { top: DOWN }),
    ];
    const found = holeWallPoints(topo(faces), Z, 10, -10, NO_MESH);
    expect(found.points).toEqual([]);
    expect(found.warnings).toEqual([
      'the 4 mm hole at (5, 5, 10) (face #0, #2) is in pieces with a gap between them: it is not drilled',
    ]);
  });

  it('skips partial cylinders, bosses and other surfaces silently, and counts walls across Z', () => {
    reset();
    const faces = [
      wall(0, [5, 5], 2, 0, 10, { share: 0.5 }), // a slot's rounded end
      wall(1, [15, 5], 2, 0, 10, { hole: false }), // a pin
      wall(2, [25, 5], 2, 0, 10, { axis: [1, 0, 0] }), // across
      wall(3, [35, 5], 2, 0, 10, { surface: 'cone' }),
      wall(4, [45, 5], 2, 0, 10, { axisOrigin: null }),
    ];
    expect(holeWallPoints(topo(faces), Z, 10, -10, NO_MESH)).toEqual({
      points: [],
      warnings: ["1 round wall is not along this setup's Z axis and is not drilled"],
      notes: [],
    });
  });

  it('counts a plane within 89 degrees of +Z as an open mouth, and reports the tilt', () => {
    const tilted = (degrees: number): FaceInfo => {
      const a = (degrees * Math.PI) / 180;
      return { ...planes[0]!, index: 90, normal: [Math.sin(a), 0, Math.cos(a)] };
    };
    for (const [degrees, open] of [
      [0, true],
      [30, true],
      [88.9, true],
      [89.1, false],
      [90, false],
    ] as const) {
      reset();
      const found = holeWallPoints(
        topo([wall(0, [5, 5], 2, 0, 10, { top: 90 }), tilted(degrees)]),
        Z,
        10,
        -10,
        NO_MESH,
      );
      expect(found.points.length, `${degrees} degrees`).toBe(open ? 1 : 0);
      if (open && degrees > 0) {
        expect(found.points[0]!.entryTilt).toBeCloseTo((degrees * Math.PI) / 180, 9);
      }
      if (degrees === 0) expect(found.points[0]!.entryTilt).toBeUndefined();
    }
  });

  it('marks a hole through when it exits onto a downward face above the body bottom', () => {
    reset();
    // A web from Z 6 to 10 over a relief pocket: the wall's bottom meets the pocket's ceiling.
    const found = holeWallPoints(
      topo([wall(0, [5, 5], 2, 6, 10), wall(2, [15, 5], 2, 6, 10, { bottom: UP })]),
      Z,
      10,
      -10,
      NO_MESH,
    );
    expect(found.points.map((p) => [p.position[0], p.through])).toEqual([
      [5, true],
      [15, undefined],
    ]);
  });

  it('finds material above a hole and the clear height under its exit in the mesh', () => {
    reset();
    // Model Z (machine Z is 10 less): a square facet over (5, 5) at 14, above a hole whose top is at
    // 10; another at -3, under its exit at 0; and many far-away facets for the grid to skip.
    const quad = (cx: number, cy: number, w: number, z: number): number[] => [
      cx - w,
      cy - w,
      z,
      cx + w,
      cy - w,
      z,
      cx + w,
      cy + w,
      z,
      cx - w,
      cy + w,
      z,
    ];
    const build = (slabs: [number, number, number, number][]) => {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const q of slabs) {
        const base = positions.length / 3;
        positions.push(...quad(...q));
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
    };
    const far: [number, number, number, number][] = Array.from({ length: 200 }, (_, k) => [
      100 + (k % 20) * 3,
      100 + Math.floor(k / 20) * 3,
      1,
      14,
    ]);
    const hole = () => [wall(0, [5, 5], 2, 0, 10, { bottom: DOWN })];
    const over = holeWallPoints(topo(hole()), Z, 10, -20, build([[5, 5, 1, 14], ...far]));
    expect(over.points).toEqual([]);
    expect(over.warnings).toEqual([expect.stringContaining('material above it (from 4 mm)')]);
    reset();
    const under = holeWallPoints(topo(hole()), Z, 10, -20, build([[5, 5, 4, -3], ...far]));
    expect(under.warnings).toEqual([]);
    expect(under.points[0]).toMatchObject({ through: true });
    expect(under.points[0]!.clearBelow).toBeCloseTo(3, 5);
    // A facet inside the wall's ring, but beyond the hole, crosses nothing.
    reset();
    const beside = holeWallPoints(topo(hole()), Z, 10, -20, build([[12, 5, 1, 14], ...far]));
    expect(beside.points).toHaveLength(1);
    expect(beside.points[0]!.clearBelow).toBeUndefined();
  });

  it('finds a 1 mm rib across a 20 mm hole, above its mouth and under its exit', () => {
    // Model Z, machine Z 10 less. A 20 mm hole about (50, 50) from 0 to 10, exiting onto a
    // downward face; a rib 1 mm wide along X at y 5.5 to 6.5 from the axis, 40 mm long.
    const rib = (z: number) => ({
      positions: new Float32Array([30, 55.5, z, 70, 55.5, z, 70, 56.5, z, 30, 56.5, z]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const hole = () => [wall(0, [50, 50], 10, 0, 10, { bottom: DOWN })];
    reset();
    const over = holeWallPoints(topo(hole()), Z, 10, -20, rib(20));
    expect(over.points).toEqual([]);
    expect(over.warnings).toEqual([expect.stringContaining('material above it (from 10 mm)')]);
    reset();
    const under = holeWallPoints(topo(hole()), Z, 10, -20, rib(-5));
    expect(under.warnings).toEqual([]);
    expect(under.points[0]).toMatchObject({ through: true });
    expect(under.points[0]!.clearBelow).toBeCloseTo(5, 5);
    // A sloped floor triangle at -0.5 under the hole, rising to +3 at a far vertex (above the
    // exit's height outside the disk): still the floor, at its highest over the disk.
    reset();
    const sloped = holeWallPoints(topo(hole()), Z, 10, -20, {
      positions: new Float32Array([20, 20, -0.5, 80, 20, -0.5, 50, 1000, 3]),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(sloped.points[0]).toMatchObject({ through: true });
    const clear = sloped.points[0]!.clearBelow!;
    // The plane rises 3.5 mm over 980 mm: over the disk (9.95 mm round (50, 50), 30 mm from the
    // low edge) at most 3.5 * (30 + 9.95) / 980 above -0.5, so a little less than the flat 0.5.
    expect(clear).toBeCloseTo(0.5 - (3.5 * (30 + 9.95)) / 980, 4);
    // Steeper, so the plane reaches the exit's height inside the disk: no clearance at all.
    reset();
    const steep = holeWallPoints(topo(hole()), Z, 10, -20, {
      positions: new Float32Array([20, 20, -0.5, 80, 20, -0.5, 50, 200, 3]),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(steep.points[0]!.clearBelow).toBe(0);
    // A rib wholly outside the disk (beyond the wall) counts for nothing.
    reset();
    const outside = holeWallPoints(topo(hole()), Z, 10, -20, {
      positions: new Float32Array([30, 61, 20, 70, 61, 20, 70, 62, 20, 30, 62, 20]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    expect(outside.points).toHaveLength(1);
    // A facet whose vertices are all outside the disk but which covers the axis is found.
    reset();
    const cover = holeWallPoints(topo(hole()), Z, 10, -20, {
      positions: new Float32Array([0, 0, 20, 100, 0, 20, 50, 100, 20]),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(cover.points).toEqual([]);
  });

  it('works for any up direction', () => {
    reset();
    // Up is model -Y: a hole along Y, its wall from model y 0 to 6, opening on the face at y 0.
    const up: [number, number, number] = [0, -1, 0];
    const face: FaceInfo = {
      index: 0,
      surface: 'cylinder',
      centroid: [3, 3, 3],
      area: 2 * Math.PI * 2 * 6,
      normal: null,
      axis: [0, 1, 0],
      radius: 2,
      axisOrigin: [3, 10, 3],
      hole: true,
    };
    const front: FaceInfo = { ...planes[0]!, index: 1, normal: [0, -1, 0] };
    const back: FaceInfo = { ...planes[0]!, index: 2, normal: [0, 1, 0] };
    const found = holeWallPoints(
      {
        faces: [face, front, back],
        vertices: [
          { index: 0, point: [5, 0, 3], faces: [0, 1] },
          { index: 1, point: [5, 6, 3], faces: [0, 2] },
        ],
        edges: [
          {
            index: 0,
            faces: [0, 1],
            seam: false,
            curve: 'circle',
            midpoint: [1, 0, 3],
            length: 4 * Math.PI,
            vertices: [0],
          },
          {
            index: 1,
            faces: [0, 2],
            seam: false,
            curve: 'circle',
            midpoint: [1, 6, 3],
            length: 4 * Math.PI,
            vertices: [1],
          },
          {
            index: 2,
            faces: [0],
            seam: true,
            curve: 'line',
            midpoint: [5, 3, 3],
            length: 6,
            vertices: [0, 1],
          },
        ],
      },
      up,
      0,
      -6,
      NO_MESH,
    );
    // The stock top at setup Z 0 (model y 0) is the origin; the body's bottom at machine Z -6.
    const [p] = found.points;
    expect(p!.position.map(r6)).toEqual([3, 0, 3]);
    expect(p!.axis.map(r6)).toEqual([0, 1, 0]);
    expect(p).toMatchObject({ diameter: 4, through: true });
    expect(p!.depth).toBeCloseTo(6, 12);
  });
});
