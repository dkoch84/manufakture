// Hand-computed fixtures for the floor framing generator (M6 plan, T6.2b acceptance). Inputs and
// expectations are in inches; the generator works in millimetres.

import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../geom';
import { memberCorners, countByRole, type Member, type StockRef } from '../members';
import { S2X6, S2X8, inch, toInches } from '../test-helpers';
import {
  formatFloorMemberId,
  frameFloor,
  parseFloorMemberId,
  type FloorMemberId,
  type FrameFloorInput,
} from './floor';
import { FramingInputError } from './wall';

const S4X6: StockRef = { id: 'us-4x6', name: '4x6', width: inch(3.5), depth: inch(5.5) };
const OSB_23_32: StockRef = {
  id: 'us-osb-23-32',
  name: '23/32" OSB',
  width: inch(23 / 32),
  depth: inch(48),
};

const FLOOR = 'extension#9';
const pts = (...p: Array<[number, number]>): Vec2[] => p.map(([x, y]) => [inch(x), inch(y)]);

/** The shed's floor: 12' along x (the joists' span), 16' along y (the layout). */
function shed(rest: Partial<FrameFloorInput> = {}, settings = {}): FrameFloorInput {
  return {
    floor: FLOOR,
    outline: pts([0, 0], [144, 0], [144, 192], [0, 192]),
    direction: [1, 0],
    settings: { joistStock: S2X6, ...settings },
    ...rest,
  };
}

/** A member's world box in inches, rounded to 1/1000". */
function box(m: Member) {
  const c = memberCorners(m);
  const r = (v: number) => Math.round((v / inch(1)) * 1000) / 1000;
  const range = (k: 0 | 1 | 2): [number, number] => [
    r(Math.min(...c.map((p) => p[k]))),
    r(Math.max(...c.map((p) => p[k]))),
  ];
  return { x: range(0), y: range(1), z: range(2) };
}

const byRole = (ms: readonly Member[], role: string) => ms.filter((m) => m.role === role);

describe('frameFloor: the 12 ft x 16 ft shed floor', () => {
  it('has 13 joists of 141 in at 16 in on centre and 2 rims of 16 ft', () => {
    const r = frameFloor(shed());
    expect(r.warnings).toEqual([]);
    expect(countByRole(r.members)).toEqual({ joist: 13, rim: 2 });
    const joists = byRole(r.members, 'joist');
    expect(joists.map((m) => m.id)).toEqual(Array.from({ length: 13 }, (_, k) => `j${k}`));
    for (const m of joists) {
      expect(toInches(m.length)).toBe(141);
      expect(box(m).x).toEqual([1.5, 142.5]);
      expect(box(m).z).toEqual([0, 5.5]);
      expect(m.owner).toBe(FLOOR);
    }
    // End joists flush at 0 and 190-1/2", the others centred on 16" multiples.
    expect(joists.map((m) => box(m).y)).toEqual([
      [0, 1.5],
      ...Array.from({ length: 11 }, (_, i) => [16 * (i + 1) - 0.75, 16 * (i + 1) + 0.75]),
      [190.5, 192],
    ]);
    const rims = byRole(r.members, 'rim');
    expect(rims.map((m) => [m.id, toInches(m.length), box(m).x, box(m).y])).toEqual([
      ['rim1', 192, [0, 1.5], [0, 192]],
      ['rim2', 192, [142.5, 144], [0, 192]],
    ]);
    expect(toInches(r.top)).toBe(5.5);
  });

  it('puts three 4x6 skids of 16 ft under it when skids are on', () => {
    const r = frameFloor(shed({}, { skids: { stock: S4X6, count: 3 } }));
    const skids = byRole(r.members, 'skid');
    expect(skids.map((m) => [m.id, toInches(m.length), box(m).x, box(m).y, box(m).z])).toEqual([
      ['skid1', 192, [0, 3.5], [0, 192], [-5.5, 0]],
      ['skid2', 192, [70.25, 73.75], [0, 192], [-5.5, 0]],
      ['skid3', 192, [140.5, 144], [0, 192], [-5.5, 0]],
    ]);
    const over = frameFloor(shed({}, { skids: { stock: S4X6, count: 3, overhang: inch(6) } }));
    expect(byRole(over.members, 'skid').map((m) => toInches(m.length))).toEqual([204, 204, 204]);
    const placed = frameFloor(
      shed({}, { skids: { stock: S4X6, count: 2, positions: [inch(24), inch(120)] } }),
    );
    expect(byRole(placed.members, 'skid').map((m) => box(m).x)).toEqual([
      [22.25, 25.75],
      [118.25, 121.75],
    ]);
  });

  it('gives a mid-span blocking row of 10 blocks of 14-1/2 in and 2 of 13-3/4 in', () => {
    const r = frameFloor(shed({}, { blocking: { kind: 'mid-span' } }));
    const blocks = byRole(r.members, 'blocking');
    expect(blocks).toHaveLength(12);
    expect(blocks.map((m) => m.id)).toEqual(
      Array.from({ length: 12 }, (_, n) => `block1:${n + 1}`),
    );
    expect(blocks.map((m) => toInches(m.length))).toEqual([
      13.75,
      ...Array<number>(10).fill(14.5),
      13.75,
    ]);
    // The end bays run from 1-1/2" to 15-1/4" and from 176-3/4" to 190-1/2".
    expect(box(blocks[0]!).y).toEqual([1.5, 15.25]);
    expect(box(blocks[11]!).y).toEqual([176.75, 190.5]);
    for (const b of blocks) {
      expect(box(b).x).toEqual([71.25, 72.75]);
      expect(box(b).z).toEqual([0, 5.5]);
      expect(b.stock).toBe(S2X6);
    }
  });

  it('places blocking rows at given distances along the span', () => {
    const r = frameFloor(shed({}, { blocking: { kind: 'at', positions: [inch(96), inch(48)] } }));
    const blocks = byRole(r.members, 'blocking');
    expect(blocks).toHaveLength(24);
    expect(box(blocks.find((m) => m.id === 'block1:1')!).x).toEqual([47.25, 48.75]);
    expect(box(blocks.find((m) => m.id === 'block2:1')!).x).toEqual([95.25, 96.75]);
    const outside = frameFloor(shed({}, { blocking: { kind: 'at', positions: [inch(500)] } }));
    expect(byRole(outside.members, 'blocking')).toEqual([]);
    expect(outside.warnings.map((w) => w.code)).toEqual(['blocking-row-outside']);
  });

  it('reports the subfloor as a sheet layer on top of the joists', () => {
    const r = frameFloor(shed({ elevation: inch(12) }, { subfloor: OSB_23_32 }));
    expect(r.subfloor).toBeDefined();
    const s = r.subfloor!;
    expect(s.stock).toBe(OSB_23_32);
    expect(s.area / inch(1) ** 2).toBeCloseTo(144 * 192, 6);
    expect(s.z.map(toInches)).toEqual([17.5, 18.219]);
    expect(s.outline.map((p) => p.map(toInches))).toEqual([
      [0, 0],
      [144, 0],
      [144, 192],
      [0, 192],
    ]);
    expect(toInches(r.top)).toBe(17.5);
    expect(box(r.members[0]!).z).toEqual([12, 17.5]);
    expect(frameFloor(shed()).subfloor).toBeUndefined();
  });

  it('frames the same floor at 24 in on centre with 9 joists', () => {
    const r = frameFloor(shed({}, { spacing: inch(24) }));
    expect(byRole(r.members, 'joist')).toHaveLength(9);
  });
});

describe('frameFloor: direction, layout and outline', () => {
  it('frames with the joists along y the same, laid out from the other side', () => {
    // Joists along +y; the layout axis (+y rotated left) is -x, so it starts at x = 144.
    const r = frameFloor(
      shed({ direction: [0, 1], outline: pts([0, 0], [192, 0], [192, 144], [0, 144]) }),
    );
    const joists = byRole(r.members, 'joist');
    expect(joists).toHaveLength(13);
    expect(joists.every((m) => toInches(m.length) === 141)).toBe(true);
    expect(box(joists[0]!).x).toEqual([190.5, 192]);
    expect(box(joists[1]!).x).toEqual([175.25, 176.75]);
    expect(box(joists[12]!).x).toEqual([0, 1.5]);
    expect(box(joists[0]!).y).toEqual([1.5, 142.5]);
  });

  it('lays out from the end when asked, and shifts by the layout origin', () => {
    const end = frameFloor(shed({}, { layoutFrom: 'end' }));
    const j = (r: ReturnType<typeof frameFloor>, id: string) =>
      box(r.members.find((m) => m.id === id)!).y;
    expect(j(end, 'j0')).toEqual([190.5, 192]);
    expect(j(end, 'j1')).toEqual([175.25, 176.75]);
    expect(j(end, 'j12')).toEqual([0, 1.5]);
    const shifted = frameFloor(shed({}, { layoutOrigin: inch(-4) }));
    expect(j(shifted, 'j1')).toEqual([11.25, 12.75]);
  });

  it('accepts either winding, a closing point and collinear points', () => {
    const a = frameFloor(shed());
    const b = frameFloor(
      shed({ outline: pts([0, 192], [144, 192], [144, 96], [144, 0], [0, 0], [0, 192]) }),
    );
    expect(b.members).toEqual(a.members);
  });

  it('frames a rotated floor with the same lengths', () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const rot = ([x, y]: [number, number]): [number, number] => [x * c - y * s, x * s + y * c];
    const r = frameFloor(
      shed({
        outline: pts(rot([0, 0]), rot([144, 0]), rot([144, 192]), rot([0, 192])),
        direction: [c, s],
      }),
    );
    expect(countByRole(r.members)).toEqual({ joist: 13, rim: 2 });
    for (const m of byRole(r.members, 'joist')) expect(m.length).toBeCloseTo(inch(141), 6);
  });

  it('frames an L-shaped floor with a flush joist under the inner edge', () => {
    // 144 x 96 across the bottom, plus 72 x 96 on its left above.
    const r = frameFloor({
      floor: FLOOR,
      outline: pts([0, 0], [144, 0], [144, 96], [72, 96], [72, 192], [0, 192]),
      direction: [1, 0],
      settings: { joistStock: S2X6, blocking: { kind: 'mid-span' } },
    });
    expect(r.warnings).toEqual([]);
    const get = (id: string) => r.members.find((m) => m.id === id)!;
    // The inner edge at y = 96 has its joist flush below it; slot 6 (centred on 96) gives way.
    expect(box(get('f1')).y).toEqual([94.5, 96]);
    expect(box(get('f1')).x).toEqual([1.5, 142.5]);
    expect(r.members.some((m) => m.id === 'j6')).toBe(false);
    expect(toInches(get('j5').length)).toBe(141);
    expect(toInches(get('j7').length)).toBe(69);
    expect(box(get('j7')).x).toEqual([1.5, 70.5]);
    expect(byRole(r.members, 'rim').map((m) => [m.id, box(m).x, box(m).y])).toEqual([
      ['rim1', [0, 1.5], [0, 192]],
      ['rim2', [70.5, 72], [96, 192]],
      ['rim3', [142.5, 144], [0, 96]],
    ]);
    // Blocking in the wide part at x = 72, in the narrow part at x = 36.
    const blocks = byRole(r.members, 'blocking');
    expect(box(blocks.find((b) => box(b).y[0] === 80.75)!).x).toEqual([71.25, 72.75]);
    expect(box(blocks.find((b) => box(b).y[0] === 96)!).x).toEqual([35.25, 36.75]);
  });

  it('splits joists across a U-shaped floor and blocks no bay between the arms', () => {
    // A U open at the top: 192 wide, arms 48 wide, 96 high, base 48 high.
    const r = frameFloor({
      floor: FLOOR,
      outline: pts([0, 0], [192, 0], [192, 96], [144, 96], [144, 48], [48, 48], [48, 96], [0, 96]),
      direction: [0, 1],
      settings: { joistStock: S2X6, blocking: { kind: 'mid-span' } },
    });
    // Joists along y; slots along -x from x = 192. j7 sits at x = 192 - 112 = 80 in the base only.
    const get = (id: string) => r.members.find((m) => m.id === id);
    expect(box(get('j7')!).y).toEqual([1.5, 46.5]);
    expect(get('j7:2')).toBeUndefined();
    // The end joists run up the outer edges of both arms.
    expect(toInches(get('j0')!.length)).toBe(93);
    for (const b of byRole(r.members, 'blocking')) {
      const y = box(b).y;
      const x = box(b).x;
      // A block in the base or in an arm, never across the gap between the arms.
      const inBase = y[1] <= 48;
      const inArm = x[0] >= 0 && (x[1] <= 48 || x[0] >= 144);
      expect(inBase || inArm, `${b.id} at ${JSON.stringify(box(b))}`).toBe(true);
    }
    // Two flush joists inside the arms along their inner edges, at x = 144 and x = 48.
    expect(box(get('f1')!).x).toEqual([144, 145.5]);
    expect(box(get('f2')!).x).toEqual([46.5, 48]);
  });

  it('blocks the bay up into each arm of a U from the full-span joist under both', () => {
    // A U open to +y: 192 wide, 144 high, arms 48 wide, base 48 high. Joists along x.
    const r = frameFloor({
      floor: FLOOR,
      outline: pts(
        [0, 0],
        [192, 0],
        [192, 144],
        [144, 144],
        [144, 48],
        [48, 48],
        [48, 144],
        [0, 144],
      ),
      direction: [1, 0],
      settings: { joistStock: S2X6, blocking: { kind: 'mid-span' } },
    });
    const get = (id: string) => r.members.find((m) => m.id === id)!;
    // f1 runs the full span along the base's top edge; j4 and j4:2 are the first arm joists.
    expect(box(get('f1')).x).toEqual([1.5, 190.5]);
    expect(box(get('j4')).x).toEqual([1.5, 46.5]);
    expect(box(get('j4:2')).x).toEqual([145.5, 190.5]);
    const blocks = byRole(r.members, 'blocking').map((b) => [b.id, box(b).x, box(b).y]);
    expect(blocks.slice(3, 5)).toEqual([
      ['block1:4', [23.25, 24.75], [48, 63.25]],
      ['block1:5', [167.25, 168.75], [48, 63.25]],
    ]);
    // 3 bays in the base and 6 in each arm.
    expect(blocks).toHaveLength(15);
    expect(r.warnings).toEqual([]);
  });

  it('splits a joist band into pieces where the outline does', () => {
    // A U open to the right: the slot joists through both arms come in two pieces.
    const r = frameFloor({
      floor: FLOOR,
      outline: pts(
        [0, 0],
        [144, 0],
        [144, 48],
        [96, 48],
        [96, 144],
        [144, 144],
        [144, 192],
        [0, 192],
      ),
      direction: [0, 1],
      settings: { joistStock: S2X6 },
    });
    const pieces = r.members.filter((m) => /^j\d+:2$/.test(m.id));
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) {
      const first = r.members.find((m) => m.id === p.id.split(':')[0])!;
      expect(box(first).y).toEqual([1.5, 46.5]);
      expect(box(p).y).toEqual([145.5, 190.5]);
    }
  });
});

describe('frameFloor: walls, stock and overrides', () => {
  it('doubles the joists under a wall running along them, hiding the layout joist there', () => {
    const r = frameFloor(
      shed({ walls: [{ id: 'extension#3', start: [0, inch(64)], end: [inch(144), inch(64)] }] }),
    );
    expect(r.warnings).toEqual([]);
    const get = (id: string) => r.members.find((m) => m.id === id);
    expect(box(get('w1a')!).y).toEqual([62.5, 64]);
    expect(box(get('w1b')!).y).toEqual([64, 65.5]);
    expect(toInches(get('w1a')!.length)).toBe(141);
    expect(get('j4')).toBeUndefined();
    expect(byRole(r.members, 'joist')).toHaveLength(14);
  });

  it('ignores walls across the joists and warns about walls at an angle', () => {
    const r = frameFloor(
      shed({
        walls: [
          { id: 'extension#3', start: [inch(72), 0], end: [inch(72), inch(192)] },
          { id: 'extension#4', start: [0, 0], end: [inch(144), inch(192)] },
        ],
      }),
    );
    expect(byRole(r.members, 'joist')).toHaveLength(13);
    expect(r.warnings.map((w) => [w.code, w.wall])).toEqual([['wall-not-parallel', 'extension#4']]);
  });

  it('leaves out doubled joists that would run into an end joist or fall outside the floor', () => {
    const r = frameFloor(
      shed({
        walls: [
          { id: 'extension#3', start: [0, inch(2)], end: [inch(144), inch(2)] },
          { id: 'extension#4', start: [0, inch(300)], end: [inch(144), inch(300)] },
        ],
      }),
    );
    expect(byRole(r.members, 'joist')).toHaveLength(13);
    expect(r.warnings.map((w) => [w.code, w.wall])).toEqual([
      ['framing-conflict', 'extension#3'],
      ['wall-outside-floor', 'extension#4'],
    ]);
    const off = frameFloor(
      shed(
        { walls: [{ id: 'extension#3', start: [0, inch(64)], end: [inch(144), inch(64)] }] },
        { doubleUnderWalls: false },
      ),
    );
    expect(byRole(off.members, 'joist')).toHaveLength(13);
  });

  it('splices rims longer than the stock and warns about joists longer than it', () => {
    const r = frameFloor(
      shed({ outline: pts([0, 0], [264, 0], [264, 288], [0, 288]) }, { joistStock: S2X8 }),
    );
    // 24' rims from 20' stock: 240" and 48".
    expect(byRole(r.members, 'rim').map((m) => [m.id, toInches(m.length)])).toEqual([
      ['rim1', 240],
      ['rim1:2', 48],
      ['rim2', 240],
      ['rim2:2', 48],
    ]);
    // 22' span less two rims: 261", over the 240" stock.
    const long = r.warnings.filter((w) => w.code === 'longer-than-stock');
    expect(long).toHaveLength(byRole(r.members, 'joist').length);
    expect(long[0]!.member).toBe('extension#9:j0');
    expect(long[0]!.kind).toBe('layout');
  });

  it('uses its own rim stock when given', () => {
    const r = frameFloor(shed({}, { rimStock: S2X8 }));
    const rim = byRole(r.members, 'rim')[0]!;
    expect(rim.stock).toBe(S2X8);
    expect(toInches(r.top)).toBe(7.25);
  });

  it('applies overrides by local id and reports lost ones', () => {
    const r = frameFloor(
      shed({
        overrides: [
          { id: 'j3', delete: true },
          { id: 'j5', move: inch(2) },
          { id: 'rim1', stock: S2X8 },
          { id: 'j99', delete: true },
          { id: 'j3', stock: S2X8 },
        ],
      }),
    );
    expect(r.members.some((m) => m.id === 'j3')).toBe(false);
    expect(box(r.members.find((m) => m.id === 'j5')!).y).toEqual([81.25, 82.75]);
    expect(r.members.find((m) => m.id === 'rim1')!.stock).toBe(S2X8);
    expect(r.overrides.map((o) => [o.id, o.status])).toEqual([
      ['j3', 'applied'],
      ['j5', 'applied'],
      ['rim1', 'applied'],
      ['j99', 'lost'],
      ['j3', 'lost'],
    ]);
    expect(r.warnings.map((w) => [w.code, w.member])).toEqual([
      ['override-lost', 'extension#9:j99'],
      ['override-lost', 'extension#9:j3'],
    ]);
  });
});

describe('frameFloor: input it refuses', () => {
  const refuses = (input: FrameFloorInput, msg: RegExp) => {
    expect(() => frameFloor(input)).toThrow(FramingInputError);
    expect(() => frameFloor(input)).toThrow(msg);
  };

  it('refuses a floor past its member budget, before laying out one far past it', () => {
    const n = frameFloor(shed()).members.length;
    expect(frameFloor(shed({ maxMembers: n })).members).toHaveLength(n);
    refuses(
      shed({ maxMembers: n - 1 }),
      new RegExp(`The floor would have more than ${n - 1} members`),
    );
    const t0 = performance.now();
    refuses(
      shed({ outline: pts([0, 0], [144, 0], [144, 4e7], [0, 4e7]) }),
      /more than 50000 members/,
    );
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('refuses floor openings (stairs) with a message', () => {
    refuses(shed({ openings: [{ kind: 'stair' }] }), /openings \(stairs\) are not framed/);
  });

  it('refuses outlines it cannot frame', () => {
    refuses(shed({ outline: pts([0, 0], [144, 0], [100, 192], [0, 192]) }), /along or across/);
    refuses(shed({ outline: pts([0, 0], [144, 0], [144, 192]) }), /along or across|four corners/);
    refuses(
      shed({
        outline: pts(
          [0, 0],
          [144, 0],
          [144, 96],
          [-48, 96],
          [-48, 48],
          [72, 48],
          [72, 192],
          [0, 192],
        ),
      }),
      /crosses or touches itself/,
    );
    refuses(shed({ outline: pts([0, 0], [2, 0], [2, 192], [0, 192]) }), /shorter than two joists/);
    refuses(
      shed({
        outline: [
          [0, 0],
          [Number.NaN, 0],
          [1, 1],
          [0, 1],
        ],
      }),
      /not a number/,
    );
  });

  it('refuses bad settings and ids', () => {
    refuses(shed({ floor: 'floor' }), /not a feature id/);
    refuses(shed({ direction: [0, 0] }), /direction/);
    refuses(shed({}, { spacing: inch(1) }), /spacing/);
    refuses(shed({}, { skids: { stock: S4X6, count: 0 } }), /Skids must be/);
    refuses(shed({}, { skids: { stock: S4X6, count: 2, positions: [0] } }), /one per skid/);
    refuses(shed({ overrides: [{ id: 'j5', move: Number.NaN }] }), /move .* j5 .* not a number/);
    refuses(
      shed({ overrides: [{ id: 'j5', move: Number.POSITIVE_INFINITY }] }),
      /move .* j5 .* not a number/,
    );
  });
});

describe('floor member ids', () => {
  const FORMS: Array<[string, FloorMemberId]> = [
    ['j0', { form: 'joist', slot: 0, piece: 1 }],
    ['j12', { form: 'joist', slot: 12, piece: 1 }],
    ['j3:2', { form: 'joist', slot: 3, piece: 2 }],
    ['f1', { form: 'flush', n: 1, piece: 1 }],
    ['f2:3', { form: 'flush', n: 2, piece: 3 }],
    ['w1a', { form: 'doubled', wall: 1, side: 'a', piece: 1 }],
    ['w2b:2', { form: 'doubled', wall: 2, side: 'b', piece: 2 }],
    ['rim1', { form: 'rim', n: 1, piece: 1 }],
    ['rim2:2', { form: 'rim', n: 2, piece: 2 }],
    ['block1:4', { form: 'block', row: 1, n: 4 }],
    ['skid3', { form: 'skid', n: 3 }],
  ];

  it.each(FORMS)('parses and formats %s back to itself', (id, parsed) => {
    expect(parseFloorMemberId(id)).toEqual(parsed);
    expect(formatFloorMemberId(parsed)).toBe(id);
  });

  it('refuses non-canonical spellings and other forms', () => {
    for (const id of [
      '',
      'j',
      'j01',
      'j3:1',
      'j3:01',
      'j3:0',
      'f0',
      'w1',
      'w1c',
      'w0a',
      'rim0',
      'rim1:1',
      'block1',
      'block0:1',
      'block1:0',
      'skid0',
      'skid1:2',
      's3',
      'king-l',
    ])
      expect(parseFloorMemberId(id), id).toBeUndefined();
  });

  it('gives every member of a framed floor an id that parses', () => {
    const r = frameFloor(
      shed(
        { walls: [{ id: 'extension#3', start: [0, inch(64)], end: [inch(144), inch(64)] }] },
        { blocking: { kind: 'mid-span' }, skids: { stock: S4X6, count: 3 } },
      ),
    );
    for (const m of r.members) {
      const p = parseFloorMemberId(m.id);
      expect(p, m.id).toBeDefined();
      expect(formatFloorMemberId(p!)).toBe(m.id);
    }
  });
});

describe('frameFloor: wording', () => {
  it('never calls anything safe, compliant or OK', () => {
    const r = frameFloor(
      shed(
        {
          outline: pts([0, 0], [264, 0], [264, 288], [0, 288]),
          walls: [
            { id: 'extension#3', start: [0, inch(2)], end: [inch(264), inch(2)] },
            { id: 'extension#4', start: [0, 0], end: [inch(264), inch(288)] },
            { id: 'extension#5', start: [0, inch(400)], end: [inch(264), inch(400)] },
          ],
          overrides: [{ id: 'j99', delete: true }],
        },
        {
          blocking: { kind: 'at', positions: [inch(500)] },
          skids: { stock: S4X6, count: 2, positions: [inch(-50), inch(600)] },
        },
      ),
    );
    const codes = new Set(r.warnings.map((w) => w.code));
    expect(codes.size).toBeGreaterThanOrEqual(7);
    const text = r.warnings.map((w) => w.message).join(' ');
    expect(text).not.toMatch(/\bsafe\b|complian|\bOK\b/i);
  });
});
