// Golden tests for the `tools` feature (M4 plan, T4.2a): named primitives cut from or added to
// chosen bodies. A dado across a board, a tenon and its mortise, a dowel through two boards, a
// counterbore and a drill point from stepped and tipped cylinders, an added block, a hole ending
// in the plane of a rabbet's floor, with volumes computed by hand; the names the tools give;
// per-item errors; and names that survive edits.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  TOOL_OVERLAP,
  validateFeature,
  type ExtrudeInput,
  type FeatureBody,
  type ToolItem,
  type ToolsInput,
} from '../src/features';
import {
  XY,
  apply,
  build,
  expectGolden,
  faceIndex,
  faceNames,
  named,
  profile,
  rectangle,
  type NamedBody,
} from '../src/fixtures/parts';
import type { Kernel } from '../src/kernel';
import { resolveFace } from '../src/naming';
import { createNodeKernel } from '../src/node';
import type { Frame, Vec3 } from '../src/types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const PI = Math.PI;
const DEG = PI / 180;
const ID = 'extension#9';

/** A block from `min` to `max` as a body of its own, made by extrusion `id`. */
function block(id: string, min: Vec3, max: Vec3): ExtrudeInput {
  return {
    kind: 'extrude',
    id,
    profile: profile({ ...XY, origin: [0, 0, min[2]] }, rectangle(min[0], min[1], max[0], max[1])),
    extent: { type: 'blind', distance: max[2] - min[2] },
    mode: 'new',
  };
}

/** An axis-aligned box tool from `min` to `max`. */
function boxItem(
  id: string,
  body: string,
  min: Vec3,
  max: Vec3,
  mode: ToolItem['mode'] = 'subtract',
): ToolItem {
  return {
    id,
    body,
    mode,
    primitive: {
      type: 'box',
      frame: { origin: min, xDir: [1, 0, 0], normal: [0, 0, 1] },
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    },
  };
}

const tools = (...items: ToolItem[]): ToolsInput => ({ kind: 'tools', id: ID, items });
const tool = (item: string, role: string) => `${ID}:${item}:${role}`;
const centroid = (b: NamedBody, name: string) => b.topology.faces[faceIndex(b, name) - 1]!.centroid;

/** A 600 x `width` x 19 board lying flat, with a 19 wide, 6 deep dado across it at x = `at`. */
function dadoBoard(width = 300, at = 200) {
  return build(k, [
    block('extrude#1', [0, 0, 0], [600, width, 19]),
    tools(boxItem('t1', 'extrude#1', [at, 0, 13], [at + 19, width, 19])),
  ]);
}

describe('a dado across a board', () => {
  it('cuts the exact groove, with its floor and walls named after the tool', () => {
    const { shape, last } = dadoBoard();
    expect(last.changed).toEqual(['extrude#1']);
    // The board's top is split in two by the groove: 6 faces + 1 piece + floor and two walls.
    expectGolden(k, shape, {
      volume: 600 * 300 * 19 - 19 * 300 * 6,
      faces: 10,
      min: [0, 0, 0],
      max: [600, 300, 19],
    });
    const b = named(k, shape);
    const names = faceNames(b);
    const made = names.filter((n) => n.startsWith(`${ID}:`)).sort();
    expect(made).toEqual([tool('t1', 'xmax'), tool('t1', 'xmin'), tool('t1', 'zmin')]);
    expect(centroid(b, tool('t1', 'zmin'))[2]).toBeCloseTo(13, 9);
    expect(centroid(b, tool('t1', 'xmin'))[0]).toBeCloseTo(200, 9);
    expect(centroid(b, tool('t1', 'xmax'))[0]).toBeCloseTo(219, 9);
    // The tool's names are not positional; the board keeps its own names.
    for (const n of made) expect(b.names.faces[faceIndex(b, n) - 1]!.fragile).toBe(false);
    expect(names).toContain('extrude#1:cap:start');
    expect(names).toContain('extrude#1:side:e1');
  });

  it('flush faces are moved out by the overlap, so the cut matches the tool exactly', () => {
    expect(TOOL_OVERLAP).toBe(0.01);
    // Turned so the box's frame is not the world's: x along -y, normal down into the board.
    const turned: ToolItem = {
      id: 't1',
      body: 'extrude#1',
      mode: 'subtract',
      primitive: {
        type: 'box',
        frame: { origin: [200, 300, 19], xDir: [0, -1, 0], normal: [0, 0, -1] },
        size: [300, 19, 6],
      },
    };
    const { shape } = build(k, [block('extrude#1', [0, 0, 0], [600, 300, 19]), tools(turned)]);
    expectGolden(k, shape, {
      volume: 600 * 300 * 19 - 19 * 300 * 6,
      faces: 10,
      min: [0, 0, 0],
      max: [600, 300, 19],
    });
    const b = named(k, shape);
    // Frame y = normal x xDir = (0,0,-1) x (0,-1,0) = (-1,0,0): y runs from x = 200 to 181.
    expect(centroid(b, tool('t1', 'zmax'))[2]).toBeCloseTo(13, 9);
    expect(centroid(b, tool('t1', 'ymin'))[0]).toBeCloseTo(200, 9);
    expect(centroid(b, tool('t1', 'ymax'))[0]).toBeCloseTo(181, 9);
  });

  it('names survive a change of board width: the floor resolves exactly', () => {
    const wide = named(k, dadoBoard(300).shape);
    const narrow = named(k, dadoBoard(250).shape);
    expectGolden(k, narrow.shape, {
      volume: 600 * 250 * 19 - 19 * 250 * 6,
      faces: 10,
      min: [0, 0, 0],
      max: [600, 250, 19],
    });
    for (const role of ['zmin', 'xmin', 'xmax']) {
      const r = resolveFace(narrow.names, { face: tool('t1', role) });
      expect(r).toMatchObject({ ok: true, via: 'exact', fragile: false });
    }
    expect(faceNames(narrow).sort()).toEqual(faceNames(wide).sort());
  });

  it('names survive moving the tool: the same faces, at the new place', () => {
    const moved = named(k, dadoBoard(300, 350).shape);
    const r = resolveFace(moved.names, { face: tool('t1', 'xmin') });
    expect(r).toMatchObject({ ok: true, via: 'exact', fragile: false });
    expect(centroid(moved, tool('t1', 'xmin'))[0]).toBeCloseTo(350, 9);
    expect(faceNames(moved).sort()).toEqual(faceNames(named(k, dadoBoard().shape)).sort());
  });

  it('a stopped dado keeps its far end as a face of the tool', () => {
    const { shape } = build(k, [
      block('extrude#1', [0, 0, 0], [600, 300, 19]),
      tools(boxItem('t1', 'extrude#1', [200, 0, 13], [219, 250, 19])),
    ]);
    expectGolden(k, shape, {
      volume: 600 * 300 * 19 - 19 * 250 * 6,
      faces: 10,
      min: [0, 0, 0],
      max: [600, 300, 19],
    });
    expect(faceNames(named(k, shape))).toContain(tool('t1', 'ymax'));
  });
});

describe('keySplits: pieces of a split face named after the tool', () => {
  const TOP = 'extrude#1:cap:end';
  /** The board of `dadoBoard`, its dados (at x) cut by one tools feature with `keySplits`. */
  const keyed = (...at: number[]) =>
    named(
      k,
      build(k, [
        block('extrude#1', [0, 0, 0], [600, 300, 19]),
        {
          ...tools(
            ...at.map((x, i) => boxItem(`t${i + 1}`, 'extrude#1', [x, 0, 13], [x + 19, 300, 19])),
          ),
          keySplits: true,
        },
      ]).shape,
    );
  const pieces = (b: NamedBody) =>
    b.names.faces
      .filter((f) => f.lineage.includes(TOP))
      .map((f) => [f.name, f.fragile, f.aliases])
      .sort();

  it('names each piece of the board top after the dado wall beside it, the old names aliases', () => {
    const b = keyed(200);
    expect(pieces(b)).toEqual([
      [`${TOP}{${tool('t1', 'xmax')}}`, false, [`${TOP}#2`]],
      [`${TOP}{${tool('t1', 'xmin')}}`, false, [`${TOP}#1`]],
    ]);
    expect(centroid(b, `${TOP}{${tool('t1', 'xmin')}}`)[0]).toBeCloseTo(100, 9);
    // A reference stored with the positional name finds the same piece, exactly.
    expect(resolveFace(b.names, { face: `${TOP}#1` })).toMatchObject({
      ok: true,
      index: faceIndex(b, `${TOP}{${tool('t1', 'xmin')}}`),
      via: 'exact',
      fragile: true,
    });
    // Without keySplits the pieces stay positional.
    expect(
      faceNames(named(k, dadoBoard().shape))
        .filter((n) => n.startsWith(TOP))
        .sort(),
    ).toEqual([`${TOP}#1`, `${TOP}#2`]);
  });

  it('keeps the names when the dado moves and when a second dado is added beside it', () => {
    const one = keyed(350);
    expect(pieces(one).map((p) => p[0])).toEqual(pieces(keyed(200)).map((p) => p[0]));
    // A second dado to the right: the pieces beside the first keep their names (the middle one
    // is still named after t1's right wall), and the new piece is named after t2's.
    const two = keyed(200, 400);
    const names = pieces(two).map((p) => p[0]);
    expect(names).toEqual([
      `${TOP}{${tool('t1', 'xmax')}}`,
      `${TOP}{${tool('t1', 'xmin')}}`,
      `${TOP}{${tool('t2', 'xmax')}}`,
    ]);
    expect(centroid(two, `${TOP}{${tool('t1', 'xmax')}}`)[0]).toBeCloseTo(309.5, 9);
  });

  it('keySplits must be a boolean', () => {
    const input = { ...tools(boxItem('t1', 'extrude#1', [0, 0, 15], [10, 30, 20])) };
    expect(validateFeature({ ...input, keySplits: true })).toBeNull();
    expect(validateFeature({ ...input, keySplits: 'yes' })).toMatch(/keySplits must be a boolean/);
  });
});

describe('flush faces next to material', () => {
  it('a blind hole ending in the plane of a rabbet floor is not lengthened', () => {
    // A 100 x 100 x 19 board with a 20 wide rabbet along x = 0, its floor at z = 13; an 8 mm hole
    // drilled up from the bottom 40 mm from the rabbet, 13 deep. Its end lies in the plane of the
    // rabbet floor, facing the same way, but material is above it: it must stay at z = 13.
    const hole: ToolItem = {
      id: 'h1',
      body: 'extrude#1',
      mode: 'subtract',
      primitive: {
        type: 'cylinder',
        axis: { origin: [60, 50, 0], direction: [0, 0, 1] },
        radius: 4,
        length: 13,
      },
    };
    const { shape } = build(k, [
      block('extrude#1', [0, 0, 0], [100, 100, 19]),
      tools(boxItem('r1', 'extrude#1', [0, 0, 13], [20, 100, 19]), hole),
    ]);
    expectGolden(k, shape, {
      volume: 100 * 100 * 19 - 20 * 100 * 6 - PI * 16 * 13,
      faces: 10,
      min: [0, 0, 0],
      max: [100, 100, 19],
    });
    const b = named(k, shape);
    expect(centroid(b, tool('h1', 'end'))[2]).toBeCloseTo(13, 9);
    expect(centroid(b, tool('r1', 'zmin'))[2]).toBeCloseTo(13, 9);
  });

  it('the same hole after the rabbet, in a later run, is not lengthened either', () => {
    const { shape } = build(k, [
      block('extrude#1', [0, 0, 0], [100, 100, 19]),
      tools(boxItem('r1', 'extrude#1', [0, 0, 13], [20, 100, 19])),
      {
        ...tools({
          id: 'h1',
          body: 'extrude#1',
          mode: 'subtract',
          primitive: {
            type: 'cylinder',
            axis: { origin: [60, 50, 0], direction: [0, 0, 1] },
            radius: 4,
            length: 13,
          },
        }),
        id: 'extension#10',
      },
    ]);
    expectGolden(k, shape, {
      volume: 100 * 100 * 19 - 20 * 100 * 6 - PI * 16 * 13,
      faces: 10,
      min: [0, 0, 0],
      max: [100, 100, 19],
    });
  });
});

describe('several bodies', () => {
  it('a tenon cut from one rail and its mortise from the other, in one feature', () => {
    // A: a 100 x 40 x 40 block. B: a 40 x 40 rail along y, running 20 into A (the tenon's
    // length). The tenon is 10 thick (x 45..55) and 30 high (z 5..35): four boxes around it cut
    // from B's end, the mortise one box cut from A.
    const A = 'extrude#1';
    const B = 'extrude#2';
    const { bodies, last } = build(k, [
      block(A, [0, 0, 0], [100, 40, 40]),
      block(B, [30, 20, 0], [70, 240, 40]),
      tools(
        boxItem('t1', B, [30, 20, 0], [45, 40, 40]),
        boxItem('t2', B, [55, 20, 0], [70, 40, 40]),
        boxItem('t3', B, [45, 20, 0], [55, 40, 5]),
        boxItem('t4', B, [45, 20, 35], [55, 40, 40]),
        boxItem('m1', A, [45, 20, 5], [55, 40, 35]),
      ),
    ]);
    expect(last.changed).toEqual([A, B]);
    const [a, b] = bodies;
    // A: 6 faces + the mortise's bottom and four walls.
    expectGolden(k, a!.shape, {
      volume: 100 * 40 * 40 - 10 * 20 * 30,
      faces: 11,
      min: [0, 0, 0],
      max: [100, 40, 40],
    });
    const an = named(k, a!.shape);
    expect(
      faceNames(an)
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual(['xmax', 'xmin', 'ymin', 'zmax', 'zmin'].map((r) => tool('m1', r)));
    // B: its far end, four long sides, the tenon's end and four faces, and the shoulder.
    expectGolden(k, b!.shape, {
      volume: 40 * 220 * 40 - 20 * (40 * 40 - 10 * 30),
      faces: 11,
      min: [30, 20, 0],
      max: [70, 240, 40],
    });
    const bn = named(k, b!.shape);
    const bNames = faceNames(bn);
    for (const name of [
      tool('t1', 'xmax'),
      tool('t2', 'xmin'),
      tool('t3', 'zmax'),
      tool('t4', 'zmin'),
    ]) {
      expect(bNames).toContain(name);
    }
    // The shoulder: the four boxes' ymax faces, fused into one before the cut.
    const shoulder = bn.names.faces.find((f) => f.lineage.includes(tool('t1', 'ymax')));
    expect(shoulder?.lineage).toEqual(
      expect.arrayContaining(['t1', 't2', 't3', 't4'].map((t) => tool(t, 'ymax'))),
    );
    // The tenon fills the mortise exactly: the joined boards no longer overlap.
    const overlap = k.interference([{ shapes: [a!.shape] }, { shapes: [b!.shape] }]);
    expect(overlap.pairs).toEqual([]);
  });

  it('a dowel cut from two boards: blind holes in each, named per body', () => {
    // Two 100 x 100 x 19 boards, one on the other; an 8 mm dowel from z = 5 to z = 33.
    const A = 'extrude#1';
    const B = 'extrude#2';
    const dowel = (id: string, body: string, from: number, to: number): ToolItem => ({
      id,
      body,
      mode: 'subtract',
      primitive: {
        type: 'cylinder',
        axis: { origin: [50, 50, from], direction: [0, 0, 1] },
        radius: 4,
        length: to - from,
      },
    });
    const boards = [block(A, [0, 0, 0], [100, 100, 19]), block(B, [0, 0, 19], [100, 100, 38])];
    const blind = build(k, [...boards, tools(dowel('d1', A, 5, 33), dowel('d2', B, 5, 33))]);
    const [a, b] = blind.bodies;
    expectGolden(k, a!.shape, {
      volume: 100 * 100 * 19 - PI * 16 * 14,
      faces: 8,
      min: [0, 0, 0],
      max: [100, 100, 19],
    });
    expectGolden(k, b!.shape, {
      volume: 100 * 100 * 19 - PI * 16 * 14,
      faces: 8,
      min: [0, 0, 19],
      max: [100, 100, 38],
    });
    expect(
      faceNames(named(k, a!.shape))
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual([tool('d1', 'start'), tool('d1', 'wall')]);
    expect(
      faceNames(named(k, b!.shape))
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual([tool('d2', 'end'), tool('d2', 'wall')]);
    // Right through both, the ends flush with the outer faces: no end faces, exact volumes.
    const through = build(k, [...boards, tools(dowel('d1', A, 0, 38), dowel('d2', B, 0, 38))]);
    for (const [i, body] of through.bodies.entries()) {
      expectGolden(k, body.shape, {
        volume: 100 * 100 * 19 - PI * 16 * 19,
        faces: 7,
        min: [0, 0, 19 * i],
        max: [100, 100, 19 * (i + 1)],
      });
    }
  });

  it('a cut on body 2 leaves body 1 untouched, shape id and all', () => {
    const first = build(k, [
      block('extrude#1', [0, 0, 0], [40, 30, 20]),
      block('extrude#2', [100, 0, 0], [140, 30, 20]),
    ]);
    const out = apply(
      k,
      first.bodies,
      tools(boxItem('t1', 'extrude#2', [110, 10, 10], [120, 20, 20])),
    );
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#2']);
    expect(out.bodies[0]!.shape).toBe(first.bodies[0]!.shape);
    expect(out.bodies[1]!.shape).not.toBe(first.bodies[1]!.shape);
  });
});

describe('cylinders', () => {
  const plate = () => block('extrude#1', [0, 0, 0], [40, 30, 20]);
  const down = (
    extra: Partial<Extract<ToolItem['primitive'], { type: 'cylinder' }>>,
  ): ToolItem => ({
    id: 'h1',
    body: 'extrude#1',
    mode: 'subtract',
    primitive: {
      type: 'cylinder',
      axis: { origin: [20, 15, 20], direction: [0, 0, -1] },
      radius: 2,
      length: 20,
      ...extra,
    },
  });

  it('a stepped cylinder gives a counterbore with the right volume and names', () => {
    const { shape } = build(k, [plate(), tools(down({ step: { radius: 4, length: 5 } }))]);
    expectGolden(k, shape, {
      volume: 24000 - PI * (16 * 5 + 4 * 15),
      faces: 9,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const b = named(k, shape);
    expect(
      faceNames(b)
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual(['shoulder', 'step', 'wall'].map((r) => tool('h1', r)));
    expect(centroid(b, tool('h1', 'shoulder'))[2]).toBeCloseTo(15, 9);
  });

  it('a tip ends a blind hole in a drill point', () => {
    const t = 2 / Math.tan(59 * DEG);
    const { shape } = build(k, [plate(), tools(down({ length: 10, tip: { angle: 118 * DEG } }))]);
    expectGolden(k, shape, {
      volume: 24000 - PI * 4 * 10 - (PI * 4 * t) / 3,
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    expect(
      faceNames(named(k, shape))
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual([tool('h1', 'tip'), tool('h1', 'wall')]);
  });

  it('an angled stepped cylinder (a pocket screw) cuts a valid hole', () => {
    // 15 degrees off the board's face, entering its bottom and leaving through its end.
    const dir: Vec3 = [Math.cos(15 * DEG), 0, Math.sin(15 * DEG)];
    const item: ToolItem = {
      id: 'p1',
      body: 'extrude#1',
      mode: 'subtract',
      primitive: {
        type: 'cylinder',
        axis: { origin: [-20, 15, -2], direction: dir },
        radius: 2,
        length: 70,
        step: { radius: 4.75, length: 50 },
      },
    };
    const { shape } = build(k, [block('extrude#1', [0, 0, 0], [60, 30, 19]), tools(item)]);
    const p = k.properties(shape);
    expect(p.valid).toBe(true);
    expect(p.volume).toBeLessThan(60 * 30 * 19);
    expect(faceNames(named(k, shape))).toEqual(expect.arrayContaining([tool('p1', 'step')]));
  });
});

describe('add', () => {
  it('an added box fuses with its body, named after the tool', () => {
    const { shape, last } = build(k, [
      block('extrude#1', [0, 0, 0], [40, 30, 20]),
      tools(boxItem('a1', 'extrude#1', [10, 10, 20], [20, 20, 25], 'add')),
    ]);
    expect(last.created).toEqual([]);
    expectGolden(k, shape, { volume: 24500, faces: 11, min: [0, 0, 0], max: [40, 30, 25] });
    expect(
      faceNames(named(k, shape))
        .filter((n) => n.startsWith(ID))
        .sort(),
    ).toEqual(['xmax', 'xmin', 'ymax', 'ymin', 'zmax'].map((r) => tool('a1', r)));
  });

  it('a run of subtracts then adds on one body, in item order', () => {
    const { shape } = build(k, [
      block('extrude#1', [0, 0, 0], [40, 30, 20]),
      tools(
        boxItem('c1', 'extrude#1', [0, 0, 15], [10, 30, 20]),
        boxItem('a1', 'extrude#1', [30, 10, 20], [40, 20, 30], 'add'),
      ),
    ]);
    expectGolden(k, shape, {
      volume: 24000 - 10 * 30 * 5 + 10 * 10 * 10,
      faces: 13,
      min: [0, 0, 0],
      max: [40, 30, 30],
    });
  });
});

describe('add', () => {
  it('a subtract, an add and a subtract on one body: each run on the body the last one left', () => {
    // The second cut is a pocket in the added block's top: flush with a face the add made.
    const { shape, last } = build(k, [
      block('extrude#1', [0, 0, 0], [40, 30, 20]),
      tools(
        boxItem('c1', 'extrude#1', [0, 0, 15], [10, 30, 20]),
        boxItem('a1', 'extrude#1', [30, 10, 20], [40, 20, 30], 'add'),
        boxItem('c2', 'extrude#1', [33, 13, 25], [37, 17, 30]),
      ),
    ]);
    expect(last.errors).toEqual([]);
    expectGolden(k, shape, {
      volume: 24000 - 10 * 30 * 5 + 10 * 10 * 10 - 4 * 4 * 5,
      faces: 18,
      min: [0, 0, 0],
      max: [40, 30, 30],
    });
    const b = named(k, shape);
    expect(faceNames(b)).toEqual(
      expect.arrayContaining([tool('c1', 'zmin'), tool('a1', 'zmax'), tool('c2', 'zmin')]),
    );
    expect(centroid(b, tool('c2', 'zmin'))[2]).toBeCloseTo(25, 9);
  });
});

describe('a body in several solids', () => {
  it('a tool that takes a whole solid away counts as touching the body', () => {
    // A bar cut in two by a through slot, then a box around the left piece alone.
    const first = build(k, [
      block('extrude#1', [0, 0, 0], [100, 20, 10]),
      tools(boxItem('s1', 'extrude#1', [45, 0, 0], [55, 20, 10])),
    ]);
    expect(k.solids(first.shape)).toBe(2);
    const out = apply(
      k,
      first.bodies,
      tools(boxItem('t1', 'extrude#1', [-1, -1, -1], [46, 21, 11])),
    );
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#1']);
    expectGolden(k, out.shape!, {
      volume: 45 * 20 * 10,
      faces: 6,
      min: [55, 0, 0],
      max: [100, 20, 10],
    });
  });
});

describe('errors', () => {
  const plate = () => block('extrude#1', [0, 0, 0], [40, 30, 20]);
  const bodiesOf = (): FeatureBody[] => build(k, [plate()]).bodies;

  it('the same tool id twice is refused', () => {
    const input = tools(
      boxItem('t1', 'extrude#1', [0, 0, 15], [10, 30, 20]),
      boxItem('t1', 'extrude#1', [30, 0, 15], [40, 30, 20]),
    );
    expect(validateFeature(input)).toMatch(/'t1' is used twice/);
    const out = apply(k, bodiesOf(), input);
    expect(out).toMatchObject({ ok: false, changed: [], errors: [{ code: 'invalid' }] });
  });

  it('a tool that misses its body is an error of its own; the others still apply', () => {
    const before = bodiesOf();
    const out = apply(
      k,
      before,
      tools(
        boxItem('t1', 'extrude#1', [0, 0, 15], [10, 30, 20]),
        boxItem('t2', 'extrude#1', [100, 0, 0], [110, 10, 10]),
        boxItem('t3', 'extrude#3', [0, 0, 0], [5, 5, 5]),
      ),
    );
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual([
      expect.objectContaining({ code: 'lost', ref: 't3', missing: ['extrude#3'] }),
      expect.objectContaining({ code: 'invalid', ref: 't2', target: 'extrude#1' }),
    ]);
    expect(out.changed).toEqual(['extrude#1']);
    expectGolden(k, out.shape!, {
      volume: 24000 - 10 * 30 * 5,
      faces: 8,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
  });

  it('a tool that only touches its body misses it, and the body keeps its shape', () => {
    const before = bodiesOf();
    const sub = apply(k, before, tools(boxItem('t1', 'extrude#1', [40, 0, 0], [50, 30, 20])));
    expect(sub.errors).toEqual([expect.objectContaining({ code: 'invalid', ref: 't1' })]);
    expect(sub.changed).toEqual([]);
    expect(sub.bodies[0]!.shape).toBe(before[0]!.shape);
    const add = apply(
      k,
      before,
      tools(boxItem('a1', 'extrude#1', [50, 0, 0], [60, 30, 20], 'add')),
    );
    expect(add.errors).toEqual([expect.objectContaining({ code: 'invalid', ref: 'a1' })]);
    expect(add.bodies[0]!.shape).toBe(before[0]!.shape);
  });

  it('a cut that leaves nothing fails the whole feature', () => {
    const before = bodiesOf();
    const out = apply(k, before, tools(boxItem('t1', 'extrude#1', [-1, -1, -1], [41, 31, 21])));
    expect(out).toMatchObject({ ok: false, changed: [], errors: [{ code: 'empty' }] });
    expect(out.bodies[0]!.shape).toBe(before[0]!.shape);
  });

  it('malformed and out-of-range primitives are invalid', () => {
    const cyl = (extra: object): ToolsInput =>
      ({
        kind: 'tools',
        id: ID,
        items: [
          {
            id: 'h1',
            body: 'extrude#1',
            mode: 'subtract',
            primitive: {
              type: 'cylinder',
              axis: { origin: [20, 15, 20], direction: [0, 0, -1] },
              radius: 2,
              length: 10,
              ...extra,
            },
          },
        ],
      }) as ToolsInput;
    expect(validateFeature({ kind: 'tools', id: ID, items: [] })).toMatch(/non-empty/);
    expect(validateFeature(cyl({ radius: 'x' }))).toMatch(/radius/);
    expect(
      validateFeature({ ...tools(boxItem('t1', 'b', [0, 0, 0], [1, 1, 1])), id: 'x' }),
    ).toMatch(/feature id/);
    const bodies = bodiesOf();
    for (const extra of [
      { radius: 0 },
      { step: { radius: 1, length: 2 } },
      { step: { radius: 3, length: 10 } },
      { tip: { angle: PI } },
    ]) {
      const out = apply(k, bodies, cyl(extra));
      expect(out.errors, JSON.stringify(extra)).toEqual([
        expect.objectContaining({ code: 'invalid', ref: 'h1' }),
      ]);
    }
    const flat: Frame = { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [0, 0, 1] };
    const out = apply(k, bodies, {
      kind: 'tools',
      id: ID,
      items: [
        {
          id: 't1',
          body: 'extrude#1',
          mode: 'subtract',
          primitive: { type: 'box', frame: flat, size: [1, 1, 1] },
        },
      ],
    });
    expect(out.errors).toEqual([expect.objectContaining({ code: 'invalid', ref: 't1' })]);
  });
});
