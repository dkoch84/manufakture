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
  type HoleFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CamGeometryResult, CamLoop, CamOperationResult, CamSourceResult } from './cam';
import { CAM_MESH_DEFLECTION } from './cam';
import { RegenEngine } from './engine';
import { PART, add, apply, mm, rectangle, unwrap } from './test-helpers';

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

  it('rejects a setup the document does not have', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    await expect(engine.camGeometry(machined(), 'setup#9')).rejects.toThrow(/no CAM setup/);
  });
});
