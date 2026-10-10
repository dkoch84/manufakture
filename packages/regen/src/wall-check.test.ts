// The wall check around holes (#1210) end to end, with the real kernel and solver: a hole near the
// edge of a block is checked against the insert's minimum wall, against a print setup's, or not at
// all, and the measurement follows edits and is not made again for a body that did not change.

import {
  createPrintSetup,
  type Feature,
  type ManufaktureDocument,
  type PrintSetup,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { PART, add, apply, build, extrude, mm, rectangle, setVariable } from './test-helpers';
import type { RegenResult, RegenWarning } from './types';
import { printSetupMinimum, thinWallWarnings, wallRange } from './wall-check';
import { evaluateVariables } from './values';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

type HoleFeature = Extract<Feature, { kind: 'hole' }>;

/** A point on the block's top (z = 20) at x, 15. */
const points = (x: number): Feature => ({
  id: 'sketch#2',
  kind: 'sketch',
  name: 'Hole points',
  suppressed: false,
  plane: { type: 'plane', origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] },
  entities: [{ id: 'e5', kind: 'point', construction: false, position: [x, 15] }],
  constraints: [],
});

/** A 4 mm hole at the point: plain through, or an M3 insert hole, 6 mm deep and flat. */
function hole(insert: boolean): HoleFeature {
  return {
    id: 'hole#1',
    kind: 'hole',
    name: 'Hole',
    suppressed: false,
    sketch: 'sketch#2',
    points: ['e5'],
    diameter: mm('4'),
    extent: insert
      ? { type: 'blind', depth: mm('6'), tipAngle: mm('180 deg') }
      : { type: 'throughAll' },
    head: { type: 'simple' },
    ...(insert ? { standard: { size: 'M3', purpose: 'heat-set-insert' as const } } : {}),
  };
}

/** A 40 x 30 x 20 block with the hole `x` from its left side (a wall of x - 2 mm). */
function drilled(insert: boolean, x = 3): ManufaktureDocument {
  return build([
    add(rectangle('sketch#1', { width: '40', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    add(points(x)),
    add(hole(insert)),
  ]);
}

function printSetup(minWall?: string): PrintSetup {
  return {
    ...createPrintSetup('print#1', 'Plate 1', 'bambu-a1-mini', 0.4),
    items: [{ id: 'item#1', part: PART, orientation: { kind: 'asModelled' } }],
    ...(minWall === undefined ? {} : { thresholds: { minWall: mm(minWall) } }),
  };
}

function thinWalls(r: RegenResult): Extract<RegenWarning, { code: 'thin-wall' }>[] {
  const f = r.parts[0]!.features.find((x) => x.featureId === 'hole#1')!;
  expect(f.status).toBe('ok');
  return f.warnings.filter((w) => w.code === 'thin-wall');
}

describe('the wall check around holes', () => {
  it('warns when an insert hole leaves less than the insert minimum, and stops when it does not', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = drilled(true, 3.5);
    const thin = thinWalls((await engine.regen(doc))!);
    expect(thin).toHaveLength(1);
    expect(thin[0]).toMatchObject({
      point: 'e5',
      bodyId: 'extrude#1',
      minimum: 1.6,
      source: { kind: 'insert', size: 'M3' },
      toFace: 'extrude#1:side:e4',
    });
    expect(thin[0]!.wall).toBeCloseTo(1.5, 9);
    expect(thin[0]!.message).toBe(
      "The wall around hole#1 at e5 on extrude#1 is 1.5 mm, under the M3 heat-set insert's minimum of 1.6 mm (to extrude#1:side:e4)",
    );
    // A regen of the same document measures nothing again, and still warns.
    const ops = engine.stats.otherOps;
    expect(thinWalls((await engine.regen(doc))!)).toEqual(thin);
    expect(engine.stats.otherOps).toBe(ops);
    // 4 mm in: a 2 mm wall.
    const wide = drilled(true, 4);
    expect(thinWalls((await engine.regen(wide))!)).toEqual([]);
    // The wall at exactly the minimum is not under it.
    expect(thinWalls((await engine.regen(drilled(true, 3.6)))!)).toEqual([]);
    await engine.dispose();
  });

  it('warns that a hole breaking out of the side has no wall, at the block edge and a boss side', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    // 1.5 mm from the left side, the 4 mm insert hole opens through it.
    const edge = thinWalls((await engine.regen(drilled(true, 1.5)))!);
    expect(
      edge.map((w) => [w.point, w.wall, w.breakout, w.toFace?.replace(/#[0-9]+$/, '')]),
    ).toEqual([['e5', 0, true, 'extrude#1:side:e4']]);
    expect(edge[0]!.message).toMatch(
      /^The hole hole#1 at e5 \(face hole#1:wall:e5#[0-9]+\) on extrude#1 breaks out of extrude#1:side:e4(#[0-9]+)?: it has no wall there, under the M3 heat-set insert's minimum of 1\.6 mm$/,
    );
    // A 7 mm boss on the block's top, the insert hole 1.7 mm off its centre: out through its side.
    const boss = build([
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add({
        id: 'sketch#2',
        kind: 'sketch',
        name: 'Boss',
        suppressed: false,
        plane: { type: 'plane', origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] },
        entities: [
          { id: 'e5', kind: 'circle', construction: false, center: [20, 15], radius: 3.5 },
        ],
        constraints: [],
      }),
      add(extrude('extrude#2', 'sketch#2', '10', 'add')),
      add({
        ...points(21.7),
        id: 'sketch#3',
        entities: [{ id: 'e6', kind: 'point', construction: false, position: [21.7, 15] }],
        plane: { type: 'plane', origin: [0, 0, 30], normal: [0, 0, 1], xDir: [1, 0, 0] },
      } as Feature),
      add({ ...hole(true), sketch: 'sketch#3', points: ['e6'] }),
    ]);
    const side = thinWalls((await engine.regen(boss))!);
    expect(side.map((w) => [w.point, w.wall, w.breakout, w.toFace])).toEqual([
      ['e6', 0, true, 'extrude#2:side:e5'],
    ]);
    await engine.dispose();
  });

  it('checks a plain hole only against the print setups that print the part', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    // A 1 mm wall: no print setup, nothing to check against.
    const plain = drilled(false);
    expect(thinWalls((await engine.regen(plain))!)).toEqual([]);
    // A setup with a 0.4 mm nozzle: two line widths, 0.84 mm, which 1 mm passes.
    const printed = apply(plain, { type: 'addPrintSetup', setup: printSetup() });
    expect(thinWalls((await engine.regen(printed))!)).toEqual([]);
    // Its own minimum of 1.2 mm does not.
    const strict = apply(plain, { type: 'addPrintSetup', setup: printSetup('1.2 mm') });
    const thin = thinWalls((await engine.regen(strict))!);
    expect(thin.map((w) => [w.point, w.minimum, w.source, Math.round(w.wall * 1e9) / 1e9])).toEqual(
      [['e5', 1.2, { kind: 'print-setup', setupId: 'print#1' }, 1]],
    );
    expect(thin[0]!.message).toBe(
      'The wall around hole#1 at e5 on extrude#1 is 1 mm, under the minimum wall of print#1, 1.2 mm (to extrude#1:side:e4)',
    );
    await engine.dispose();
  });
});

describe('wall-check.ts', () => {
  const docT = apply(drilled(false), setVariable('t', '3'), {
    type: 'addPrintSetup',
    setup: {
      ...printSetup('#t / 2'),
      items: [{ id: 'item#1', part: PART, body: 'extrude#9', orientation: { kind: 'asModelled' } }],
    },
  });

  it('takes a setup minimum for the bodies it prints, its own value where it evaluates', () => {
    const part = docT.parts[0]!;
    const vars = evaluateVariables(docT.variables);
    expect(printSetupMinimum(docT, part, 'extrude#1', vars)).toBeNull();
    expect(printSetupMinimum(docT, part, 'extrude#9', vars)).toEqual({
      minimum: 1.5,
      source: { kind: 'print-setup', setupId: 'print#1' },
    });
  });

  it('reaches at least 10 mm, and twice the largest minimum', () => {
    const m = (minimum: number) => ({ minimum, source: { kind: 'insert', size: 'M3' } }) as const;
    expect(wallRange([m(1.6)])).toBe(10);
    expect(wallRange([m(1.6), m(7)])).toBe(14);
  });

  it('warns once per point, for the thinnest of its faces, in the order of the points', () => {
    const h = { ...hole(true), points: ['e5', 'e6'] };
    const wall = (point: string, face: string, w: number | null) => ({
      hole: 'hole#1',
      point,
      face,
      radius: 2,
      wall: w,
      from: w === null ? null : ([0, 0, 0] as [number, number, number]),
      to: w === null ? null : ([w, 0, 0] as [number, number, number]),
      toFace: w === null ? null : 'extrude#1:side:e4',
    });
    const warnings = thinWallWarnings(
      h,
      'extrude#1',
      [
        wall('e6', 'hole#1:wall:e6', 1.2),
        wall('e5', 'hole#1:wall:e5#1', 1.5),
        wall('e5', 'hole#1:wall:e5#2', 1.4),
        wall('e5', 'pattern#2:i2/hole#1:wall:e5', null),
        { ...wall('e7', 'hole#2:wall:e7', 0.1), hole: 'hole#2' },
      ],
      { minimum: 1.6, source: { kind: 'insert', size: 'M3' } },
    );
    expect(warnings.map((w) => (w.code === 'thin-wall' ? [w.point, w.face, w.wall] : []))).toEqual([
      ['e5', 'hole#1:wall:e5#2', 1.4],
      ['e6', 'hole#1:wall:e6', 1.2],
    ]);
    // A piece of a split wall (or a pattern copy) is named; the point's own wall is not.
    expect(warnings.map((w) => w.message)).toEqual([
      "The wall around hole#1 at e5 (face hole#1:wall:e5#2) on extrude#1 is 1.4 mm, under the M3 heat-set insert's minimum of 1.6 mm (to extrude#1:side:e4)",
      "The wall around hole#1 at e6 on extrude#1 is 1.2 mm, under the M3 heat-set insert's minimum of 1.6 mm (to extrude#1:side:e4)",
    ]);
  });

  it('says once which points were not checked, when the kernel skipped their walls', () => {
    const h = { ...hole(true), points: ['e5', 'e6'] };
    const skipped = (point: string, face: string) => ({
      hole: 'hole#1',
      point,
      face,
      radius: 2,
      wall: null,
      from: null,
      to: null,
      toFace: null,
      skipped: true as const,
    });
    const warnings = thinWallWarnings(
      h,
      'extrude#1',
      [skipped('e6', 'hole#1:wall:e6'), skipped('e5', 'pattern#2:i2/hole#1:wall:e5')],
      { minimum: 1.6, source: { kind: 'insert', size: 'M3' } },
    );
    expect(warnings).toEqual([
      {
        code: 'wall-unchecked',
        message:
          'The wall around hole#1 at e5, e6 on extrude#1 was not checked: extrude#1 has more than 256 hole walls to check',
        bodyId: 'extrude#1',
        points: ['e5', 'e6'],
      },
    ]);
  });
});
