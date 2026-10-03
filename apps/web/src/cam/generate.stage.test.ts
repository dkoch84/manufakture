// @vitest-environment node
/// <reference types="node" />
// The stock the toolpaths use and the stock the stage measured its depths on must be one stock
// (whole-epic review of M5). Through the real regen engine, kernel and solver: the M1 bracket with
// its back top edge chamfered 4 mm, set up with the bevel face up (tilted 45 degrees), a through
// profile of the bevel and a through hole drilled square to it. Adding a 3D surfacing makes the
// stage send the body's mesh, whose tight bounds in the tilted frame are shorter than the box of
// the model bounds' corners; the stock, the WCS frame and every machine-Z depth must not move.

import { readFileSync } from 'node:fs';
import {
  applyCommand,
  parseDocument,
  type CamOperation,
  type CamSetup,
  type CamTool,
  type ChamferFeature,
  type Command,
  type HoleFeature,
  type ManufaktureDocument,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { createNodeService } from '@manufakture/kernel/node';
import { RegenEngine, type CamGeometryResult } from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';
import { describe, expect, it } from 'vitest';
import { STOCK_Z_TOLERANCE, setupInput } from './generate';

const PART = 'part#1';
const S = 'setup#1';
const BEVEL = 'chamfer#1:bevel:r3';
const mm = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const deg = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

const preset = {
  material: 'plywood',
  spindle: mm('18000rpm'),
  feed: mm('1500mm/min'),
  plunge: mm('500mm/min'),
  stepdown: mm('2'),
  stepover: mm('0.4'),
};
const flat: CamTool = {
  id: 'tool#1',
  name: '1/8" flat',
  kind: 'flat',
  number: 201,
  diameter: mm('1/8"'),
  fluteLength: mm('19'),
  flutes: 2,
  presets: [preset],
};
const ball: CamTool = { ...flat, id: 'tool#2', name: '1/8" ball', kind: 'ball', number: 202 };

const chamfer: ChamferFeature = {
  id: 'chamfer#1',
  kind: 'chamfer',
  name: 'Bevel',
  suppressed: false,
  edges: [{ id: 'r3', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e3'] } }],
  distance: mm('4'),
};

/** One point on the bevel, for the hole square to it. */
const holePoint: SketchFeature = {
  id: 'sketch#3',
  kind: 'sketch',
  name: 'Hole point',
  suppressed: false,
  plane: { type: 'face', face: { id: 'r4', ref: { face: BEVEL } } },
  entities: [{ id: 'e6', kind: 'point', construction: false, position: [10, 0] }],
  constraints: [],
};

const hole: HoleFeature = {
  id: 'hole#1',
  kind: 'hole',
  name: 'Hole',
  suppressed: false,
  sketch: 'sketch#3',
  points: ['e6'],
  diameter: mm('3'),
  extent: { type: 'throughAll' },
  head: { type: 'simple' },
};

const profile: CamOperation = {
  id: 'profile#1',
  kind: 'profile',
  name: 'Bevel outline',
  suppressed: false,
  tool: 'tool#1',
  geometry: [{ kind: 'face', face: { id: 'r5', ref: { face: BEVEL } } }],
  side: 'outside',
  depth: { kind: 'through', extra: mm('0.5') },
  finishAllowance: mm('0'),
  entry: { kind: 'plunge' },
  leadIn: { kind: 'none' },
  leadOut: { kind: 'none' },
  climb: true,
} as CamOperation;

const drill: CamOperation = {
  id: 'drill#1',
  kind: 'drill',
  name: 'Hole',
  suppressed: false,
  tool: 'tool#1',
  geometry: [{ kind: 'hole', feature: 'hole#1' }],
} as CamOperation;

const surface: CamOperation = {
  id: 'surface3d#1',
  kind: 'surface3d',
  name: 'Finish',
  suppressed: false,
  tool: 'tool#2',
  geometry: [],
  stepover: mm('0.5'),
  angle: deg('0'),
  strategy: 'parallel',
  tolerance: mm('0.02'),
  sampling: mm('0.2'),
  pattern: 'oneway',
  climb: false,
} as CamOperation;

function setup(operations: CamOperation[]): CamSetup {
  const zero = mm('0');
  return {
    id: S,
    name: 'Bevel up',
    part: PART,
    machine: 'shapeoko-5-pro-4x4',
    post: 'grbl',
    stock: {
      kind: 'fromBody',
      margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: mm('1'), bottom: zero },
      material: 'plywood',
    },
    wcs: {
      up: { kind: 'face', face: { id: 'r6', ref: { face: BEVEL } } },
      origin: { xy: 'front-left', z: 'top' },
    },
    heights: { clearance: mm('10'), retract: mm('5') },
    operations,
  };
}

function document(operations: CamOperation[]): ManufaktureDocument {
  const json = JSON.parse(
    readFileSync(
      new URL('../../../../packages/core/src/fixtures/v14-bracket.json', import.meta.url),
      'utf8',
    ),
  );
  let doc = unwrap(parseDocument(json)).document;
  const commands: Command[] = [
    { type: 'addFeature', partId: PART, feature: chamfer },
    { type: 'addFeature', partId: PART, feature: holePoint },
    { type: 'addFeature', partId: PART, feature: hole },
    { type: 'addCamTool', tool: flat },
    { type: 'addCamTool', tool: ball },
    { type: 'addCamSetup', setup: setup(operations) },
  ];
  for (const c of commands) doc = unwrap(applyCommand(doc, c)).document;
  return doc;
}

/** Everything of a built setup that carries a machine Z, or places the machine's zero. */
function machineZ(g: CamGeometryResult) {
  const r = setupInput(g, { id: S, name: 'Bevel up' });
  if (!r.ok) throw new Error(r.message);
  const s = r.setup;
  const byId = (id: string) => s.operations.find((o) => o.id === id)!;
  const p = byId('profile#1');
  const d = byId('drill#1');
  return {
    stock: s.stock,
    frame: s.frame,
    stockZ: g.setup!.stockZ,
    profile: p.kind === 'profile' ? { depth: p.depth, loops: p.loops } : null,
    drill: d.kind === 'drill' ? d.points : null,
  };
}

describe('the stock with a tilted face up', () => {
  it('stays put, with every depth, when a 3D surfacing brings the mesh along', async () => {
    const engine = new RegenEngine({
      kernel: await createNodeService(),
      solver: createSolverService(),
    });
    const plain = document([profile, drill]);
    await engine.regen(plain);
    const without = (await engine.camGeometry(plain, S))!;
    expect(without.status).toBe('ok');
    expect(without.mesh).toBeUndefined();
    const withSurface = document([profile, drill, surface]);
    await engine.regen(withSurface);
    const withMesh = (await engine.camGeometry(withSurface, S))!;
    expect(withMesh.status).toBe('ok');
    expect(withMesh.mesh).toBeDefined();
    for (const g of [without, withMesh]) {
      for (const id of ['profile#1', 'drill#1']) {
        expect(g.operations.find((o) => o.operationId === id)!.errors).toEqual([]);
      }
    }

    // The up direction is the bevel's normal, tilted 45 degrees from both +y and +z.
    const up = withMesh.setup!.wcs.up;
    expect(up.kind).toBe('face');
    const n = up.kind === 'face' ? up.normal : [0, 0, 0];
    expect(n[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 9);

    // The case under test: the mesh's tight extent along the bevel normal is shorter than the box
    // of the model bounds' corners, by the 4 mm chamfer's corner (4 / sqrt 2 = 2.83 mm).
    const positions = withMesh.mesh!.positions;
    let tightTop = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      tightTop = Math.max(tightTop, positions[i + 1]! * n[1]! + positions[i + 2]! * n[2]!);
    }
    const cornerTop = (20 + 6) * Math.SQRT1_2;
    expect(cornerTop - tightTop).toBeCloseTo(4 * Math.SQRT1_2, 3);

    const a = machineZ(without);
    const b = machineZ(withMesh);
    expect(b).toEqual(a);
    // The stock the toolpaths use is the one the stage measured its depths on: a through cut
    // ends 0.5 mm below the stock's bottom and a through hole at its bottom, not deeper.
    expect(a.stock.max[2] - a.stock.min[2]).toBeCloseTo(a.stockZ.top - a.stockZ.bottom, 9);
    expect(a.stockZ.top).toBe(0);
    expect(a.profile!.depth.bottom).toBeCloseTo(a.stockZ.bottom - 0.5, 9);
    expect(a.drill).toHaveLength(1);
    expect(a.drill![0]!.depth.bottom).toBeGreaterThanOrEqual(a.stockZ.bottom - 1e-9);
  }, 120_000);

  it('refuses to build a setup whose stock disagrees with the depths', async () => {
    const engine = new RegenEngine({
      kernel: await createNodeService(),
      solver: createSolverService(),
    });
    const doc = document([profile, drill, surface]);
    await engine.regen(doc);
    const g = (await engine.camGeometry(doc, S))!;
    expect(setupInput(g, { id: S, name: 'Bevel up' }).ok).toBe(true);
    const drifted = (dz: number): CamGeometryResult => ({
      ...g,
      setup: {
        ...g.setup!,
        stockZ: { top: g.setup!.stockZ.top, bottom: g.setup!.stockZ.bottom + dz },
      },
    });
    // Within the tolerance it builds; past it, nothing is generated.
    expect(setupInput(drifted(STOCK_Z_TOLERANCE / 2), { id: S, name: 'Bevel up' }).ok).toBe(true);
    const r = setupInput(drifted(2 * STOCK_Z_TOLERANCE), { id: S, name: 'Bevel up' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/does not match the depths/);
    // A drift on the top is caught too (as with the mesh's tight box, 2.83 mm short).
    const short = setupInput(
      { ...g, setup: { ...g.setup!, stockZ: { ...g.setup!.stockZ, top: -2.83 } } },
      { id: S, name: 'Bevel up' },
    );
    expect(short.ok).toBe(false);
  }, 120_000);
});
