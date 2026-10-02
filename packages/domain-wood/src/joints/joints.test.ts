// The joint translators in Node, with no kernel: each kind's tool primitives against boxes and
// cylinders computed by hand from the boards' frames.

import type { ExtensionFeature } from '@manufakture/core';
import type { ToolItem, ToolsInput } from '@manufakture/kernel';
import type { ExtensionContext, ExtensionInputs } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import type { BoardFrame, BoardMetadata } from '../board';
import type { Json } from '../migrations';
import { pocketScrew, POCKET_JIG } from './fasteners';
import { rowOf } from './geometry';
import { readJointParams, type JointParams } from './params';
import { jointType, readJointMetadata, translateJoint, type JointMetadata } from './translate';

type V = [number, number, number];
const X: V = [1, 0, 0];
const Y: V = [0, 1, 0];
const Z: V = [0, 0, 1];
const neg = (v: V): V => [-v[0], -v[1], -v[2]];
const DEG = Math.PI / 180;

function frame(origin: V, axes: [V, V, V], size: V): BoardFrame {
  return {
    origin,
    axes: { length: axes[0], width: axes[1], thickness: axes[2] },
    size: { length: size[0], width: size[1], thickness: size[2] },
  };
}

/** A panel lying on the XY plane from the origin: length along x, width along y, up by `t`. */
const flat = (length: number, width: number, t: number) =>
  frame([0, 0, 0], [X, Y, Z], [length, width, t]);

/**
 * A panel standing in the YZ plane at `x`, its region from `y0` to `y0 + width` and from `z0` up by
 * `height`, extruded along +x by `t`: as `wood.board` reports a panel drawn on a YZ sketch with
 * the grain up (length +z, width -y, thickness +x; origin the min corner in that frame).
 */
const standing = (x: number, y0: number, width: number, z0: number, height: number, t: number) =>
  frame([x, y0 + width, z0], [Z, neg(Y), X], [height, width, t]);

function boardMeta(f: BoardFrame): BoardMetadata {
  return {
    form: 'panel',
    stock: 'mm-ply-18',
    material: 'plywood',
    grain: true,
    frame: f,
    overridden: { thickness: false, width: false },
  };
}

function feature(params: Json, extra: Partial<ExtensionFeature> = {}): ExtensionFeature {
  return {
    id: 'extension#3',
    kind: 'extension',
    name: 'Joint 1',
    suppressed: false,
    extension: 'wood.joint',
    schemaVersion: 1,
    dependsOn: ['extension#1', 'extension#2'],
    references: [],
    expressions: {},
    params: params as ExtensionFeature['params'],
    scope: ['extension#1', 'extension#2'],
    ...extra,
  };
}

const expr = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

/** The context regen builds for a joint between board A (`extension#1`) and B (`extension#2`). */
function context(
  params: Json,
  a: BoardFrame,
  b: BoardFrame,
  values: Record<string, number> = {},
  extra: Partial<ExtensionFeature> = {},
): ExtensionContext<JointParams> {
  const read = readJointParams(params, 1);
  if (!read.ok) throw new Error(read.message);
  const expressions = Object.fromEntries(Object.keys(values).map((k) => [k, expr('0')]));
  return {
    feature: feature(params, { expressions, ...extra }),
    params: read.value,
    values,
    references: {},
    data: {},
    sketches: new Map(),
    upstream: new Map([
      ['extension#1', { type: 'wood.board', inputs: [], metadata: boardMeta(a) as never }],
      ['extension#2', { type: 'wood.board', inputs: [], metadata: boardMeta(b) as never }],
    ]),
    bodies: ['extension#1', 'extension#2'],
    profile: () => ({ ok: false, message: 'no sketches' }),
  };
}

function built(ctx: ExtensionContext<JointParams>): { items: ToolItem[]; meta: JointMetadata } {
  const out = translateJoint(ctx);
  if ('error' in out) throw new Error(out.error);
  const { inputs, metadata } = out as ExtensionInputs;
  expect(inputs).toHaveLength(1);
  const input = inputs[0] as ToolsInput;
  expect(input).toMatchObject({ kind: 'tools', id: 'extension#3' });
  const meta = readJointMetadata(metadata);
  expect(meta).toBeDefined();
  return { items: [...input.items], meta: meta! };
}

function refused(ctx: ExtensionContext<JointParams>) {
  const out = translateJoint(ctx);
  expect(out, JSON.stringify(out)).toHaveProperty('error');
  return out as { error: string; field?: readonly (string | number)[] };
}

const close = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((x, i) => expect(x, `component ${i} of [${a.join(', ')}]`).toBeCloseTo(b[i]!, digits));

/** A box tool: the corner, frame and size in the model. */
function expectBox(
  item: ToolItem | undefined,
  id: string,
  body: string,
  lo: V,
  hi: V,
  axes: { x: V; n: V } = { x: X, n: Z },
) {
  expect(item, id).toBeDefined();
  expect(item!.id).toBe(id);
  expect(item!.body).toBe(body);
  expect(item!.mode).toBe('subtract');
  const p = item!.primitive;
  if (p.type !== 'box') throw new Error(`${id} is not a box`);
  close(p.frame.origin, lo);
  close(p.frame.xDir, axes.x);
  close(p.frame.normal, axes.n);
  // The box's own y axis is normal x xDir: compare the size along each of its axes.
  close(p.size, [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map(Math.abs));
}

/** A cylinder tool's axis. */
function axisOf(p: ToolItem['primitive'] | undefined) {
  if (p?.type !== 'cylinder') throw new Error('not a cylinder');
  return p.axis;
}

const byId = (items: readonly ToolItem[], id: string) => items.find((i) => i.id === id);

// Boards used throughout ---------------------------------------------------------------------------

/** A side panel 600 x 300 x 18 and a shelf standing on it at x = 200, entering 6 mm. */
const SIDE = flat(600, 300, 18);
const shelfAt = (x: number, z0 = 12) => standing(x, 0, 300, z0, 400, 18);

describe('wood.joint params', () => {
  it('reads every kind with its defaults', () => {
    const r = (p: Json) => readJointParams(p, 1);
    const ab = { a: 'extension#1', b: 'extension#2' };
    expect(r({ kind: 'dado', ...ab })).toEqual({
      ok: true,
      value: { kind: 'dado', ...ab, stopped: 'none' },
    });
    expect(r({ kind: 'rabbet', ...ab })).toEqual({ ok: true, value: { kind: 'rabbet', ...ab } });
    expect(r({ kind: 'mortise-tenon', ...ab })).toMatchObject({ value: { ends: 'square' } });
    expect(r({ kind: 'dowel', ...ab })).toEqual({ ok: true, value: { kind: 'dowel', ...ab } });
    expect(r({ kind: 'pocket-screw', ...ab })).toMatchObject({ value: { face: 'low' } });
    expect(r({ kind: 'box-joint', ...ab, start: 'b' })).toMatchObject({ value: { start: 'b' } });
  });

  it('refuses malformed params with the field at fault', () => {
    const r = (p: Json) => readJointParams(p, 1);
    expect(r({ kind: 'biscuit', a: 'extension#1', b: 'extension#2' })).toMatchObject({
      ok: false,
      field: ['kind'],
    });
    expect(r({ kind: 'dado', a: 'extension#1', b: 'extension#1' })).toMatchObject({
      ok: false,
      field: ['b'],
    });
    expect(r({ kind: 'dado', a: 'board 1', b: 'extension#2' })).toMatchObject({
      ok: false,
      field: ['a'],
    });
    expect(r({ kind: 'dado', a: 'extension#1', b: 'extension#2', ends: 'rounded' })).toMatchObject({
      ok: false,
      field: ['ends'],
    });
    expect(
      r({ kind: 'dado', a: 'extension#1', b: 'extension#2', stopped: 'middle' }),
    ).toMatchObject({
      ok: false,
      field: ['stopped'],
    });
    expect(r([])).toMatchObject({ ok: false });
    expect(readJointParams({ kind: 'dado', a: 'extension#1', b: 'extension#2' }, 2)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/newer than this build/),
    });
  });

  it('is registered as a type with its expression kinds', () => {
    expect(jointType.schemaVersion).toBe(1);
    expect(jointType.expressions).toMatchObject({
      count: 'number',
      angle: 'angle',
      depthA: 'length',
    });
  });
});

describe('dado and rabbet', () => {
  it('cuts a through dado the width of B where B enters A, as deep as it enters', () => {
    const { items, meta } = built(
      context({ kind: 'dado', a: 'extension#1', b: 'extension#2' }, SIDE, shelfAt(200)),
    );
    expect(items).toHaveLength(1);
    expectBox(items[0], 'groove', 'extension#1', [200, 0, 12], [218, 300, 18]);
    expect(meta).toMatchObject({
      kind: 'dado',
      a: 'extension#1',
      b: 'extension#2',
      hardware: [],
      warnings: [],
    });
    close([meta.details.depth!, meta.details.width!, meta.details.length!], [6, 18, 300]);
  });

  it('widens the groove by the clearance, split on both sides, and warns when it is deep', () => {
    const { items } = built(
      context({ kind: 'dado', a: 'extension#1', b: 'extension#2' }, SIDE, shelfAt(200), {
        clearance: 0.4,
      }),
    );
    expectBox(items[0], 'groove', 'extension#1', [199.8, 0, 12], [218.2, 300, 18]);
    const deep = built(
      context({ kind: 'dado', a: 'extension#1', b: 'extension#2' }, SIDE, shelfAt(200, 8)),
    );
    expect(deep.meta.warnings).toEqual([
      {
        code: 'rule-of-thumb',
        message: expect.stringMatching(/^Rule of thumb, not engineering: the dado is 10 mm deep/),
      },
    ]);
  });

  it('stops short of an edge and notches B to match', () => {
    const { items, meta } = built(
      context(
        { kind: 'dado', a: 'extension#1', b: 'extension#2', stopped: 'low' },
        SIDE,
        shelfAt(200),
        { stop: 20 },
      ),
    );
    expectBox(byId(items, 'groove'), 'groove', 'extension#1', [200, 20, 12], [218, 300, 18]);
    expectBox(byId(items, 'notch-low'), 'notch-low', 'extension#2', [200, 0, 12], [218, 20, 18]);
    expect(byId(items, 'notch-high')).toBeUndefined();
    expect(meta.details.length).toBeCloseTo(280, 9);
    // A shallower shelf that stops short already needs no notch.
    const short = standing(200, 50, 250, 12, 400, 18);
    const s = built(
      context({ kind: 'dado', a: 'extension#1', b: 'extension#2', stopped: 'both' }, SIDE, short, {
        stop: 20,
      }),
    );
    expect(s.items.map((i) => i.id)).toEqual(['groove', 'notch-high']);
    expectBox(
      byId(s.items, 'notch-high'),
      'notch-high',
      'extension#2',
      [200, 280, 12],
      [218, 300, 18],
    );
  });

  it('cuts a rabbet along A edge, the clearance on its inner side only', () => {
    const { items } = built(
      context({ kind: 'rabbet', a: 'extension#1', b: 'extension#2' }, SIDE, shelfAt(582), {
        clearance: 0.5,
      }),
    );
    expectBox(items[0], 'groove', 'extension#1', [581.5, 0, 12], [600, 300, 18]);
  });

  it('follows A frame: the same dado with A turned about z', () => {
    // A's length along +y and width along -x: the same 600 x 300 side, standing the other way.
    const turned = frame([300, 0, 0], [Y, neg(X), Z], [600, 300, 18]);
    const b = frame([300, 218, 12], [Z, neg(X), neg(Y)], [400, 300, 18]);
    const { items } = built(
      context({ kind: 'dado', a: 'extension#1', b: 'extension#2' }, turned, b),
    );
    const p = items[0]!.primitive;
    if (p.type !== 'box') throw new Error('not a box');
    close(p.frame.xDir, Y);
    close(p.frame.normal, Z);
    // A corner at A's (200, 0, 12): model (300, 200, 12); 18 along A's length (y), 300 along -x.
    close(p.frame.origin, [300, 200, 12]);
    close(p.size, [18, 300, 6]);
  });

  it('refuses boards that do not make the joint asked for', () => {
    const ab = { a: 'extension#1', b: 'extension#2' };
    expect(refused(context({ kind: 'rabbet', ...ab }, SIDE, shelfAt(200)))).toMatchObject({
      field: ['params', 'kind'],
      error: expect.stringMatching(/that is a dado/),
    });
    expect(refused(context({ kind: 'dado', ...ab }, SIDE, shelfAt(582)))).toMatchObject({
      error: expect.stringMatching(/that is a rabbet/),
    });
    // Touching, not entering.
    expect(refused(context({ kind: 'dado', ...ab }, SIDE, shelfAt(200, 18))).error).toMatch(
      /only touches/,
    );
    // Apart.
    expect(refused(context({ kind: 'dado', ...ab }, SIDE, shelfAt(200, 30))).error).toMatch(
      /does not meet/,
    );
    // Lying flat in A (B's face in the groove).
    const lying = frame([100, 0, 12], [X, Y, Z], [200, 300, 18]);
    expect(refused(context({ kind: 'dado', ...ab }, SIDE, lying)).error).toMatch(
      /lies with its face/,
    );
    // A stop on a through dado, and none on a stopped one.
    expect(
      refused(context({ kind: 'dado', ...ab }, SIDE, shelfAt(200), { stop: 5 })),
    ).toMatchObject({
      field: ['expressions', 'stop'],
    });
    expect(
      refused(context({ kind: 'dado', ...ab, stopped: 'low' }, SIDE, shelfAt(200))),
    ).toMatchObject({
      field: ['expressions', 'stop'],
    });
  });
});

describe('mortise and tenon', () => {
  // A 400 x 100 x 38.1 leg lying flat; a rail standing at x = 150 entering its top 25 mm.
  const LEG = flat(400, 100, 38.1);
  const RAIL = standing(150, 10, 80, 13.1, 300, 18);
  const ab = { a: 'extension#1', b: 'extension#2' };

  it('cuts cheeks and shoulders from B and the mortise from A, a third of B thick by default', () => {
    const { items, meta } = built(context({ kind: 'mortise-tenon', ...ab }, LEG, RAIL));
    expect(items.map((i) => [i.id, i.body])).toEqual([
      ['mortise', 'extension#1'],
      ['cheek-0', 'extension#2'],
      ['cheek-1', 'extension#2'],
      ['shoulder-0', 'extension#2'],
      ['shoulder-1', 'extension#2'],
    ]);
    expectBox(items[0], 'mortise', 'extension#1', [156, 16, 13.1], [162, 84, 38.1]);
    expectBox(items[1], 'cheek-0', 'extension#2', [150, 10, 13.1], [156, 90, 38.1]);
    expectBox(items[2], 'cheek-1', 'extension#2', [162, 10, 13.1], [168, 90, 38.1]);
    expectBox(items[3], 'shoulder-0', 'extension#2', [156, 10, 13.1], [162, 16, 38.1]);
    expectBox(items[4], 'shoulder-1', 'extension#2', [156, 84, 13.1], [162, 90, 38.1]);
    close([meta.details.length!, meta.details.thickness!, meta.details.width!], [25, 6, 68]);
  });

  it('adds the clearance to the mortise, moves the tenon by the offset, and leaves out empty shoulders', () => {
    const { items } = built(
      context({ kind: 'mortise-tenon', ...ab }, LEG, RAIL, {
        thickness: 8,
        width: 80,
        offset: 2,
        clearance: 1,
      }),
    );
    // Tenon x [157, 165] (centre 159 + 2), full width: no shoulders.
    expect(items.map((i) => i.id)).toEqual(['mortise', 'cheek-0', 'cheek-1']);
    expectBox(items[0], 'mortise', 'extension#1', [156.5, 9.5, 12.1], [165.5, 90.5, 38.1]);
    expectBox(items[1], 'cheek-0', 'extension#2', [150, 10, 13.1], [157, 90, 38.1]);
  });

  it('rounds the mortise ends with cylinders and the tenon edges to match', () => {
    const { items } = built(context({ kind: 'mortise-tenon', ...ab, ends: 'rounded' }, LEG, RAIL));
    expectBox(byId(items, 'mortise'), 'mortise', 'extension#1', [156, 19, 13.1], [162, 81, 38.1]);
    for (const [id, body, y, r, mode] of [
      ['mortise-end-0', 'extension#1', 19, 3, 'subtract'],
      ['mortise-end-1', 'extension#1', 81, 3, 'subtract'],
      ['round-0', 'extension#2', 19, 3, 'add'],
      ['round-1', 'extension#2', 81, 3, 'add'],
    ] as const) {
      const item = byId(items, id)!;
      expect(item.body).toBe(body);
      expect(item.mode).toBe(mode);
      const p = item.primitive;
      if (p.type !== 'cylinder') throw new Error(`${id} is not a cylinder`);
      close(p.axis.origin, [159, y, 38.1]);
      close(p.axis.direction, [0, 0, -1]);
      expect(p.radius).toBeCloseTo(r, 12);
      expect(p.length).toBeCloseTo(25, 9);
    }
    expectBox(
      byId(items, 'shoulder-0'),
      'shoulder-0',
      'extension#2',
      [156, 10, 13.1],
      [162, 19, 38.1],
    );
    // The subtracting items of B come before the adding ones: one run each.
    expect(items.filter((i) => i.body === 'extension#2').map((i) => i.mode)).toEqual([
      'subtract',
      'subtract',
      'subtract',
      'subtract',
      'add',
      'add',
    ]);
  });

  it('refuses a tenon that does not fit, a mortise breaking out, and B entering with its edge', () => {
    expect(
      refused(context({ kind: 'mortise-tenon', ...ab }, LEG, RAIL, { thickness: 20 })),
    ).toMatchObject({
      field: ['expressions', 'thickness'],
    });
    expect(
      refused(context({ kind: 'mortise-tenon', ...ab }, LEG, RAIL, { width: 90 })),
    ).toMatchObject({
      field: ['expressions', 'width'],
    });
    const flushRail = standing(150, 0, 80, 13.1, 300, 18);
    expect(
      refused(
        context({ kind: 'mortise-tenon', ...ab }, LEG, flushRail, { width: 80, clearance: 1 }),
      ).error,
    ).toMatch(/breaks out/);
    // The same rail laid on its edge: its width runs into the leg.
    const onEdge = frame([168, 10, 313.1], [Y, neg(Z), neg(X)], [80, 300, 18]);
    expect(refused(context({ kind: 'mortise-tenon', ...ab }, LEG, onEdge)).error).toMatch(/edge/);
  });
});

describe('box joint', () => {
  // A 300 x 100 x 18 board and B standing on its end, flush with its end and its bottom face.
  const A = flat(300, 100, 18);
  const B = standing(282, 0, 100, 0, 200, 18);
  const ab = { a: 'extension#1', b: 'extension#2' };

  it('alternates fingers across the common width, one slot per finger of the other board', () => {
    const { items, meta } = built(context({ kind: 'box-joint', ...ab }, A, B));
    // The thinner board's thickness as the finger width: 100 / 18 rounds to 6 fingers.
    const w = 100 / 6;
    expect(meta.details).toMatchObject({ fingers: 6 });
    expect(meta.details.finger).toBeCloseTo(w, 12);
    expect(items.map((i) => i.id)).toEqual([
      'a-slot-2',
      'a-slot-4',
      'a-slot-6',
      'b-slot-1',
      'b-slot-3',
      'b-slot-5',
    ]);
    expectBox(items[0], 'a-slot-2', 'extension#1', [282, w, 0], [300, 2 * w, 18]);
    expectBox(items[3], 'b-slot-1', 'extension#2', [282, 0, 0], [300, w, 18]);
  });

  it('starts with B, takes a count, and widens slots by the clearance inside the joint', () => {
    const { items } = built(
      context({ kind: 'box-joint', ...ab, start: 'b' }, A, B, { count: 5, clearance: 0.2 }),
    );
    expect(items.map((i) => i.id)).toEqual([
      'a-slot-1',
      'a-slot-3',
      'a-slot-5',
      'b-slot-2',
      'b-slot-4',
    ]);
    expectBox(items[0], 'a-slot-1', 'extension#1', [282, 0, 0], [300, 20.1, 18]);
    expectBox(items[3], 'b-slot-2', 'extension#2', [282, 19.9, 0], [300, 40.1, 18]);
  });

  it('refuses boards that do not meet end to end at a flush corner', () => {
    expect(
      refused(context({ kind: 'box-joint', ...ab }, A, standing(270, 0, 100, 0, 200, 18))).error,
    ).toMatch(/flush with the end/);
    expect(
      refused(context({ kind: 'box-joint', ...ab }, A, standing(282, 0, 100, 5, 200, 18))).error,
    ).toMatch(/end must be flush/);
    expect(
      refused(context({ kind: 'box-joint', ...ab }, A, B, { count: 4, finger: 10 })),
    ).toMatchObject({
      field: ['expressions', 'finger'],
    });
  });
});

describe('dowels', () => {
  // The shelf standing on the side panel, touching it.
  const ab = { a: 'extension#1', b: 'extension#2' };
  const B = shelfAt(200, 18);

  it('drills a row along the contact into both boards, with the hardware for the BOM', () => {
    const { items, meta } = built(context({ kind: 'dowel', ...ab }, SIDE, B));
    // 8 mm dowels 12 into A (1.5 d) and 20 into B (2.5 d), 16 from each end, 4 evenly in 268.
    const ys = [16, 16 + 268 / 3, 16 + (2 * 268) / 3, 284];
    expect(items.map((i) => i.id)).toEqual([
      'a-hole-1',
      'a-hole-2',
      'a-hole-3',
      'a-hole-4',
      'b-hole-1',
      'b-hole-2',
      'b-hole-3',
      'b-hole-4',
    ]);
    items.forEach((item, i) => {
      const p = item.primitive;
      if (p.type !== 'cylinder') throw new Error('not a cylinder');
      const intoA = i < 4;
      expect(item.body).toBe(intoA ? 'extension#1' : 'extension#2');
      close(p.axis.origin, [209, ys[i % 4]!, 18]);
      close(p.axis.direction, intoA ? [0, 0, -1] : [0, 0, 1]);
      expect(p.radius).toBe(4);
      expect(p.length).toBeCloseTo(intoA ? 12 : 20, 12);
    });
    expect(meta.hardware).toEqual([{ item: 'dowel', diameter: 8, length: 32, quantity: 4 }]);
    expect(meta.warnings).toEqual([]);
  });

  it('takes a count, a spacing, depths and an offset', () => {
    const counted = built(
      context({ kind: 'dowel', ...ab }, SIDE, B, {
        count: 2,
        edge: 50,
        depthA: 10,
        depthB: 25,
        diameter: 6,
        offset: 2,
      }),
    );
    const p = counted.items.map((i) => i.primitive);
    expect(p).toHaveLength(4);
    close(axisOf(p[0]).origin, [211, 50, 18]);
    close(axisOf(p[1]).origin, [211, 250, 18]);
    expect(counted.meta.hardware).toEqual([
      { item: 'dowel', diameter: 6, length: 35, quantity: 2 },
    ]);
    const spaced = built(context({ kind: 'dowel', ...ab }, SIDE, B, { spacing: 100 }));
    // 268 / 100: 3 dowels 100 apart, centred: 50, 150, 250.
    close(
      spaced.items.slice(0, 3).map((i) => axisOf(i.primitive).origin[1]),
      [50, 150, 250],
    );
  });

  it('refuses overlapping boards, holes through a board, and dowels too thick for the joint', () => {
    expect(refused(context({ kind: 'dowel', ...ab }, SIDE, shelfAt(200))).error).toMatch(
      /overlaps/,
    );
    expect(refused(context({ kind: 'dowel', ...ab }, SIDE, B, { depthA: 18 }))).toMatchObject({
      field: ['expressions', 'depthA'],
    });
    expect(refused(context({ kind: 'dowel', ...ab }, SIDE, B, { diameter: 20 }))).toMatchObject({
      field: ['expressions', 'diameter'],
    });
    expect(
      refused(context({ kind: 'dowel', ...ab }, SIDE, B, { count: 2, spacing: 50 })),
    ).toMatchObject({
      field: ['expressions', 'spacing'],
    });
    const thick = built(context({ kind: 'dowel', ...ab }, SIDE, B, { diameter: 10, depthA: 10 }));
    expect(thick.meta.warnings[0]!.message).toMatch(/^Rule of thumb, not engineering/);
  });
});

describe('pocket screws', () => {
  const ab = { a: 'extension#1', b: 'extension#2' };
  const B = shelfAt(200, 18);

  it('drills angled stepped holes in B at the jig angle, coming out mid-thickness', () => {
    const { items, meta } = built(context({ kind: 'pocket-screw', ...ab }, SIDE, B));
    // 18 mm stock is nearest the chart's 3/4": 1-1/4" screws.
    const screw = 1.25 * 25.4;
    expect(meta.hardware).toEqual([{ item: 'pocket-screw', length: screw, quantity: 3 }]);
    const t = 15 * DEG;
    const rs = (3 / 8) * 25.4 * 0.5;
    const rp = (11 / 64) * 25.4 * 0.5;
    const back = 9 / Math.sin(t) + rs / Math.tan(t) + 1;
    // The pocket opens on B's low thickness face (x = 200): the axis runs down and toward +x.
    const u: V = [Math.sin(t), 0, -Math.cos(t)];
    const ys = [19.05, 150, 300 - 19.05];
    items.forEach((item, i) => {
      expect(item.id).toBe(`pocket-${i + 1}`);
      expect(item.body).toBe('extension#2');
      const p = item.primitive;
      if (p.type !== 'cylinder') throw new Error('not a cylinder');
      close(p.axis.direction, u);
      close(p.axis.origin, [209 - u[0] * back, ys[i]!, 18 - u[2] * back]);
      expect(p.radius).toBeCloseTo(rp, 12);
      expect(p.length).toBeCloseTo(back + rp * Math.tan(t) + 1, 9);
      expect(p.step!.radius).toBeCloseTo(rs, 12);
      expect(p.step!.length).toBeCloseTo(back - screw / 2, 9);
    });
    expect(meta.details.angle).toBeCloseTo(t, 12);
    // On the high face the axis tilts the other way.
    const high = built(
      context({ kind: 'pocket-screw', ...ab, face: 'high' }, SIDE, B, { count: 1 }),
    );
    close(axisOf(high.items[0]!.primitive).direction, [-u[0], 0, u[2]]);
  });

  it('follows the screw chart, and refuses thin stock, a face against A and a stock off the chart', () => {
    expect(pocketScrew(12.7)).toBeCloseTo(25.4, 12);
    expect(pocketScrew((23 / 32) * 25.4)).toBeCloseTo(31.75, 12);
    expect(pocketScrew(38.1)).toBeCloseTo(63.5, 12);
    expect(pocketScrew(45)).toBeUndefined();
    expect(POCKET_JIG.angle).toBeCloseTo(15 * DEG, 15);
    const thin = standing(200, 0, 300, 18, 400, 9);
    expect(refused(context({ kind: 'pocket-screw', ...ab }, SIDE, thin)).error).toMatch(/too thin/);
    const thick = standing(200, 0, 300, 18, 400, 45);
    expect(refused(context({ kind: 'pocket-screw', ...ab }, SIDE, thick))).toMatchObject({
      field: ['expressions', 'screw'],
    });
    expect(
      built(context({ kind: 'pocket-screw', ...ab }, SIDE, thick, { screw: 70 })).meta.hardware[0],
    ).toMatchObject({
      length: 70,
    });
    const lying = frame([0, 0, 18], [X, Y, Z], [600, 300, 18]);
    expect(refused(context({ kind: 'pocket-screw', ...ab }, SIDE, lying)).error).toMatch(
      /face against/,
    );
    expect(
      refused(context({ kind: 'pocket-screw', ...ab }, SIDE, B, { angle: 40 * DEG })),
    ).toMatchObject({
      field: ['expressions', 'angle'],
    });
  });
});

describe('the joint translator', () => {
  const ab = { a: 'extension#1', b: 'extension#2' };

  it('refuses boards at an odd angle with a clear message', () => {
    const c = Math.cos(30 * DEG);
    const s = Math.sin(30 * DEG);
    const turned = frame([200, 0, 12], [Z, [-s, c, 0], [c, s, 0]], [400, 300, 18]);
    const out = refused(context({ kind: 'dado', ...ab }, SIDE, turned));
    expect(out.field).toEqual(['params', 'b']);
    expect(out.error).toMatch(/extension#2 is not square to extension#1 \(about 30° off\)/);
    expect(out.error).toMatch(/splayed or angled joint is not supported/);
  });

  it('refuses an operation, a value the kind does not read, and boards it cannot see', () => {
    const base = () => context({ kind: 'dado', ...ab }, SIDE, shelfAt(200));
    expect(refused({ ...base(), feature: { ...base().feature, operation: 'cut' } })).toMatchObject({
      field: ['operation'],
    });
    expect(
      refused(context({ kind: 'dado', ...ab }, SIDE, shelfAt(200), { diameter: 8 })),
    ).toMatchObject({
      field: ['expressions', 'diameter'],
    });
    expect(refused({ ...base(), upstream: new Map() })).toMatchObject({ field: ['dependsOn'] });
    expect(refused({ ...base(), bodies: ['extension#1'] })).toMatchObject({
      field: ['params', 'b'],
    });
    expect(
      refused({ ...base(), feature: { ...base().feature, scope: ['extension#1'] } }),
    ).toMatchObject({
      field: ['scope'],
    });
    const notBoard = base();
    expect(
      refused({
        ...notBoard,
        upstream: new Map([
          ...notBoard.upstream,
          ['extension#2', { type: 'wood.joint', inputs: [] }],
        ]),
      }).error,
    ).toMatch(/not a board/);
    // No scope at all: every body, which includes both boards.
    const noScope = { ...base().feature };
    delete noScope.scope;
    expect(translateJoint({ ...base(), feature: noScope })).not.toHaveProperty('error');
  });

  it('reads back its metadata, and nothing else', () => {
    const { meta } = built(context({ kind: 'dowel', ...ab }, SIDE, shelfAt(200, 18)));
    expect(readJointMetadata(meta)).toEqual(meta);
    expect(readJointMetadata({ ...meta, kind: 'biscuit' })).toBeUndefined();
    expect(readJointMetadata({ ...meta, hardware: [{ item: 'nail' }] })).toBeUndefined();
    expect(readJointMetadata(null)).toBeUndefined();
  });
});

describe('rows', () => {
  it('spreads a default row from end to end, and centres one at a given spacing', () => {
    expect(rowOf(0, 100, 10, { defaultSpacing: 100, min: 2 })).toEqual({ ok: true, at: [10, 90] });
    const four = rowOf(0, 100, 10, { defaultSpacing: 30, min: 2 });
    close(four.ok ? four.at : [], [10, 10 + 80 / 3, 10 + 160 / 3, 90]);
    expect(rowOf(0, 100, 10, { spacing: 30, defaultSpacing: 1, min: 1 })).toEqual({
      ok: true,
      at: [20, 50, 80],
    });
    expect(rowOf(0, 100, 10, { count: 1, defaultSpacing: 1, min: 1 })).toEqual({
      ok: true,
      at: [50],
    });
    expect(rowOf(0, 20, 10, { defaultSpacing: 5, min: 2 })).toEqual({ ok: true, at: [10] });
    expect(rowOf(0, 10, 10, { defaultSpacing: 5, min: 2 })).toMatchObject({ ok: false });
  });
});
