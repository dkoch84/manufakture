// Hand-computed fixtures for the wall framing generator (M6 plan, T6.2a acceptance). Inputs and
// expectations are in inches; the generator works in millimetres.

import { describe, expect, it } from 'vitest';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { memberFullId } from '../member-ids';
import { MEMBER_BUDGET, countByRole, type Member } from '../members';
import {
  DOUBLE_2X8,
  S2X10,
  S2X4,
  S2X6,
  S2X8,
  extentIn,
  extentInches,
  inch,
  straightWall,
  toInches,
} from '../test-helpers';
import {
  FramingInputError,
  MemberBudget,
  frameWall,
  type AddedMember,
  type FrameWallInput,
  type WallFraming,
  type WallOpening,
} from './wall';

const DOOR: WallOpening = {
  id: 'extension#7',
  position: inch(48),
  width: inch(36),
  height: inch(80),
  sill: 0,
};
const WINDOW: WallOpening = {
  id: 'extension#8',
  position: inch(112),
  width: inch(36),
  height: inch(48),
  sill: inch(36),
};

/** The wall's own members by local id, the openings' by full id (`extension#7:king-l`). */
const WALL = 'extension#3';
const key = (m: Member) => (m.owner === WALL ? m.id : memberFullId(m));

function frame(input: FrameWallInput): WallFraming & { byId: Map<string, Member> } {
  const r = frameWall(input);
  return { ...r, byId: new Map(r.members.map((m) => [key(m), m])) };
}

const ids = (ms: readonly Member[], role: string) => ms.filter((m) => m.role === role).map(key);

describe('frameWall: layout', () => {
  it('frames a 16 ft wall at 16 in on centre with 13 studs, 1 bottom and 2 top plates', () => {
    const input = straightWall(192);
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(r.warnings).toEqual([]);
    expect(countByRole(r.members)).toEqual({ 'bottom-plate': 1, stud: 13, 'top-plate': 2 });
    const studs = r.members.filter((m) => m.role === 'stud');
    expect(studs.map((m) => m.id)).toEqual(Array.from({ length: 13 }, (_, k) => `s${k}`));
    // s0 flush at the start, s1..s11 centred on 16k, s12 flush at the end.
    const expected = [
      [0, 1.5],
      ...Array.from({ length: 11 }, (_, i) => [16 * (i + 1) - 0.75, 16 * (i + 1) + 0.75]),
      [190.5, 192],
    ];
    expect(studs.map((m) => extentInches(seg, m).s)).toEqual(expected);
    for (const m of studs) {
      expect(m.length).toBe(inch(92.625));
      expect(extentInches(seg, m).z).toEqual([1.5, 94.125]);
      expect(extentInches(seg, m).t).toEqual([0, 3.5]);
    }
    const plates = r.members.filter((m) => m.role !== 'stud');
    expect(plates.map((m) => [m.id, toInches(m.length), extentInches(seg, m).z])).toEqual([
      ['bottom1:1', 192, [0, 1.5]],
      ['top1:1', 192, [94.125, 95.625]],
      ['top2:1', 192, [95.625, 97.125]],
    ]);
    for (const m of r.members) expect(m.owner).toBe(WALL);
  });

  it('has 9 studs at 24 in on centre', () => {
    const r = frame(straightWall(192, {}, { spacing: inch(24) }));
    const seg = straightWall(192).segments[0]!;
    const studs = r.members.filter((m) => m.role === 'stud');
    expect(studs).toHaveLength(9);
    expect(studs.map((m) => m.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    expect(extentInches(seg, studs[3]!).s).toEqual([71.25, 72.75]);
  });

  it('lays out from the end when asked, numbering slots from there', () => {
    const input = straightWall(100, {}, { layoutFrom: 'end' });
    const seg = input.segments[0]!;
    const r = frame(input);
    const s0 = r.byId.get('s0')!;
    const s1 = r.byId.get('s1')!;
    expect(extentInches(seg, s0).s).toEqual([98.5, 100]);
    expect(extentInches(seg, s1).s).toEqual([83.25, 84.75]);
    // The last slot is flush with the start.
    expect(extentInches(seg, r.byId.get('s7')!).s).toEqual([0, 1.5]);
  });

  it('shifts the layout by its origin', () => {
    const input = straightWall(100, {}, { layoutOrigin: inch(-3.5) });
    const r = frame(input);
    expect(extentInches(input.segments[0]!, r.byId.get('s1')!).s).toEqual([11.75, 13.25]);
  });

  it('snaps studs to a precut length only when the wall height is within 0.5 mm of one', () => {
    const r = frame(straightWall(96, { height: inch(100) }));
    expect(toInches(r.byId.get('s1')!.length)).toBe(95.5);
    const nine = frame(straightWall(96, { height: inch(1.5 + 104.625 + 3) + 0.4 })).byId.get('s1')!;
    expect(nine.length).toBe(inch(104.625));
  });

  it('brings a layout origin of a spacing or more back, leaving no gap after s0', () => {
    const seg = straightWall(100).segments[0]!;
    const plain = frame(straightWall(100, {}, { layoutOrigin: inch(-3.5) }));
    for (const origin of [inch(12.5), inch(28.5), inch(-19.5), inch(44.5)]) {
      const r = frame(straightWall(100, {}, { layoutOrigin: origin }));
      expect(ids(r.members, 'stud'), `${origin}`).toEqual(ids(plain.members, 'stud'));
      expect(extentInches(seg, r.byId.get('s1')!).s).toEqual([11.75, 13.25]);
    }
    // An origin of a whole number of spacings is the default layout.
    const whole = frame(straightWall(100, {}, { layoutOrigin: inch(32) }));
    expect(whole.members).toEqual(frame(straightWall(100)).members);
    // 8 in: slot 1 is centred at 8 in, not 24 in.
    const half = frame(straightWall(100, {}, { layoutOrigin: inch(8) }));
    expect(extentInches(seg, half.byId.get('s1')!).s).toEqual([7.25, 8.75]);
  });

  it('places members in world coordinates for a wall at any angle', () => {
    // A wall along +y: the left face of the line is towards -x.
    const input = straightWall(96, {
      start: [1000, 2000],
      end: [1000, 2000 + inch(96)],
      base: 500,
    });
    const r = frame(input);
    const s1 = r.byId.get('s1')!;
    expect(s1.placement.x).toEqual([0, 0, 1]);
    expect(s1.placement.y).toEqual([0, 1, 0]);
    expect(s1.placement.origin[0]).toBeCloseTo(1000, 9);
    expect(s1.placement.origin[1]).toBeCloseTo(2000 + inch(15.25), 9);
    expect(s1.placement.origin[2]).toBeCloseTo(500 + inch(1.5), 9);
    // Its depth runs along z = x cross y = -x, the wall's left side.
    expect(extentInches(input.segments[0]!, s1).t).toEqual([0, 3.5]);
  });

  it('centres or right-justifies the framing on the reference line', () => {
    const centre = straightWall(96, { justification: 'center' });
    const right = straightWall(96, { justification: 'right' });
    expect(extentInches(centre.segments[0]!, frame(centre).byId.get('s1')!).t).toEqual([
      -1.75, 1.75,
    ]);
    expect(extentInches(right.segments[0]!, frame(right).byId.get('top1:1')!).t).toEqual([-3.5, 0]);
  });
});

describe('frameWall: plates', () => {
  it('splices plates longer than the stock with top splices at least 24 in apart', () => {
    const input = straightWall(360);
    const seg = input.segments[0]!;
    const r = frame(input);
    const pieces = (prefix: string) =>
      r.members.filter((m) => m.id.startsWith(prefix)).map((m) => [m.id, extentInches(seg, m).s]);
    expect(pieces('bottom')).toEqual([
      ['bottom1:1', [0, 192]],
      ['bottom1:2', [192, 360]],
    ]);
    expect(pieces('top1')).toEqual([
      ['top1:1', [0, 192]],
      ['top1:2', [192, 360]],
    ]);
    expect(pieces('top2')).toEqual([
      ['top2:1', [0, 168]],
      ['top2:2', [168, 360]],
    ]);
    expect(r.warnings).toEqual([]);
    for (const m of r.members)
      if (m.role.endsWith('plate')) expect(m.length).toBeLessThanOrEqual(inch(192) + 1e-9);
  });

  it('splices to the longest stock length given', () => {
    const input = straightWall(
      250,
      {},
      { plateStockLengths: [inch(96), inch(120)], spliceOffset: inch(24) },
    );
    const r = frame(input);
    const top2 = r.members.filter((m) => m.id.startsWith('top2')).map((m) => toInches(m.length));
    const top1 = r.members.filter((m) => m.id.startsWith('top1')).map((m) => toInches(m.length));
    expect(top1).toEqual([120, 106, 24]);
    expect(Math.max(...top2)).toBeLessThanOrEqual(120);
    expect(top2.reduce((a, b) => a + b, 0)).toBeCloseTo(250, 9);
  });

  it('laps the cap plate at L corners: short where the wall runs through, long where it butts', () => {
    const input = straightWall(192, {
      joins: {
        start: { kind: 'L', through: true, otherThickness: inch(3.5) },
        end: { kind: 'L', through: false, otherThickness: inch(3.5) },
      },
    });
    const r = frame(input);
    const seg = input.segments[0]!;
    expect(extentInches(seg, r.byId.get('top2:1')!).s).toEqual([3.5, 195.5]);
    expect(extentInches(seg, r.byId.get('top1:1')!).s).toEqual([0, 192]);
    expect(extentInches(seg, r.byId.get('bottom1:1')!).s).toEqual([0, 192]);
  });

  it('runs two bottom plates when asked, studs on the upper one', () => {
    const input = straightWall(96, { height: inch(3 + 92.625 + 3) }, { bottomPlates: 2 });
    const r = frame(input);
    const seg = input.segments[0]!;
    expect(extentInches(seg, r.byId.get('bottom2:1')!).z).toEqual([1.5, 3]);
    expect(extentInches(seg, r.byId.get('s1')!).z).toEqual([3, 95.625]);
  });
});

describe('frameWall: corners and tees', () => {
  const corner = (style: 'two-stud' | 'three-stud' | 'ladder') => {
    const input = straightWall(
      192,
      { joins: { start: { kind: 'L', through: true, otherThickness: inch(3.5) } } },
      { cornerStyle: style },
    );
    return { seg: input.segments[0]!, r: frame(input) };
  };

  it('adds one corner stud past the other wall for a two-stud corner', () => {
    const { seg, r } = corner('two-stud');
    expect(countByRole(r.members)).toEqual({
      'bottom-plate': 1,
      corner: 1,
      stud: 13,
      'top-plate': 2,
    });
    expect(extentInches(seg, r.byId.get('start:corner')!).s).toEqual([3.5, 5]);
    expect(r.byId.get('start:corner')!.length).toBe(inch(92.625));
  });

  it('adds two corner studs for a three-stud corner', () => {
    const { seg, r } = corner('three-stud');
    expect(ids(r.members, 'corner')).toEqual(['start:corner', 'start:corner-2']);
    expect(extentInches(seg, r.byId.get('start:corner-2')!).s).toEqual([1.5, 3]);
  });

  it('adds a corner stud and ladder backing for a ladder corner', () => {
    const { seg, r } = corner('ladder');
    expect(ids(r.members, 'corner')).toEqual(['start:corner']);
    expect(extentInches(seg, r.byId.get('start:corner')!).s).toEqual([5, 6.5]);
    // Rows every 24 in above the bottom plate: centres at 25.5, 49.5 and 73.5 in.
    expect(ids(r.members, 'backing')).toEqual([
      'start:backing1',
      'start:backing2',
      'start:backing3',
    ]);
    const b = r.byId.get('start:backing2')!;
    expect(extentInches(seg, b)).toEqual({ s: [1.5, 5], t: [0, 3.5], z: [48.75, 50.25] });
  });

  it('mirrors corner framing at the end of the wall', () => {
    const input = straightWall(192, {
      joins: { end: { kind: 'L', through: true, otherThickness: inch(5.5) } },
    });
    const r = frame(input);
    expect(extentInches(input.segments[0]!, r.byId.get('end:corner')!).s).toEqual([185, 186.5]);
    expect(extentInches(input.segments[0]!, r.byId.get('top2:1')!).s).toEqual([0, 186.5]);
  });

  it('frames a tee with a stud each side and stops the cap plate for the other wall', () => {
    const input = straightWall(192, { tees: [{ at: inch(100), otherThickness: inch(3.5) }] });
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(extentInches(seg, r.byId.get('t1:corner-l')!).s).toEqual([96.75, 98.25]);
    expect(extentInches(seg, r.byId.get('t1:corner-r')!).s).toEqual([101.75, 103.25]);
    // s6 (96 in) only touches the left tee stud, so it stays.
    expect(r.byId.has('s6')).toBe(true);
    expect(
      r.members.filter((m) => m.id.startsWith('top2')).map((m) => extentInches(seg, m).s),
    ).toEqual([
      [0, 98.25],
      [101.75, 192],
    ]);
  });

  it('keeps the layout stud where a tee stud would stand on it', () => {
    // A tee centred at 98.5 in puts its left stud at 95.25 to 96.75 in, exactly s6.
    const r = frame(straightWall(192, { tees: [{ at: inch(98.5), otherThickness: inch(3.5) }] }));
    expect(r.byId.has('s6')).toBe(true);
    expect(r.byId.has('t1:corner-l')).toBe(false);
    expect(r.byId.has('t1:corner-r')).toBe(true);
  });
});

describe('frameWall: openings', () => {
  it('frames a 36 x 80 in door in a wall of 92-5/8 in precut studs', () => {
    const input = straightWall(192, { openings: [DOOR] });
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(r.warnings).toEqual([]);
    const at = (id: string) => extentInches(seg, r.byId.get(`extension#7:${id}`)!);
    const len = (id: string) => toInches(r.byId.get(`extension#7:${id}`)!.length);

    expect(len('king-l')).toBe(92.625);
    expect(len('king-r')).toBe(92.625);
    expect(at('king-l').s).toEqual([27, 28.5]);
    expect(at('king-r').s).toEqual([67.5, 69]);
    // Jacks: the 80 in rough opening less the bottom plate.
    expect(len('jack-l')).toBe(78.5);
    expect(len('jack-r')).toBe(78.5);
    expect(at('jack-l')).toEqual({ s: [28.5, 30], t: [0, 3.5], z: [1.5, 80] });
    // A doubled 2x8 header with a 1/2 in spacer, on the jacks.
    expect(r.byId.get('extension#7:header')!.stock).toBe(S2X8);
    expect(at('header')).toEqual({ s: [28.5, 67.5], t: [0, 1.5], z: [80, 87.25] });
    expect(at('spacer')).toEqual({ s: [28.5, 67.5], t: [1.5, 2], z: [80, 87.25] });
    expect(at('header-2')).toEqual({ s: [28.5, 67.5], t: [2, 3.5], z: [80, 87.25] });
    expect(r.byId.get('extension#7:spacer')!.role).toBe('header-spacer');
    // Cripples on layout (32, 48 and 64 in) above the header: 92-5/8 - 78-1/2 - 7-1/4 = 6-7/8.
    expect(ids(r.members, 'cripple')).toEqual([
      'extension#7:cripple-a1',
      'extension#7:cripple-a2',
      'extension#7:cripple-a3',
    ]);
    for (const [i, c] of [32, 48, 64].entries()) {
      expect(len(`cripple-a${i + 1}`)).toBe(6.875);
      expect(at(`cripple-a${i + 1}`).s).toEqual([c - 0.75, c + 0.75]);
    }
    // The layout studs inside the opening are gone; the others keep their slots.
    expect(ids(r.members, 'stud')).toEqual([
      's0',
      's1',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
    ]);
    // The bottom plate is cut out across the rough opening.
    expect(
      r.members.filter((m) => m.role === 'bottom-plate').map((m) => [m.id, at2(seg, m)]),
    ).toEqual([
      ['bottom1:1', [0, 30]],
      ['bottom1:2', [66, 192]],
    ]);
    expect(r.openings).toEqual([
      {
        id: 'extension#7',
        segment: 1,
        header: { source: 'default', stock: '2x8', plies: 2, jacks: 1 },
        kings: 1,
        framed: true,
      },
    ]);
  });

  it('frames a 36 x 48 in window at a 36 in sill with a rough sill and cripples below', () => {
    const input = straightWall(192, { openings: [WINDOW] });
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(r.warnings).toEqual([]);
    const at = (id: string) => extentInches(seg, r.byId.get(`extension#8:${id}`)!);
    const len = (id: string) => toInches(r.byId.get(`extension#8:${id}`)!.length);
    expect(r.byId.get('extension#8:sill')!.role).toBe('rough-sill');
    expect(at('sill')).toEqual({ s: [94, 130], t: [0, 3.5], z: [34.5, 36] });
    // Jacks to the 84 in head; the header's top at 91.25 leaves 2-7/8 in cripples above.
    expect(len('jack-l')).toBe(82.5);
    expect(at('header').z).toEqual([84, 91.25]);
    const cripples = r.members.filter((m) => m.role === 'cripple');
    expect(cripples.map((m) => [key(m), toInches(m.length), extentInches(seg, m).s])).toEqual(
      [
        ['extension#8:cripple-b1', 33, [95.25, 96.75]],
        ['extension#8:cripple-b2', 33, [111.25, 112.75]],
        ['extension#8:cripple-b3', 33, [127.25, 128.75]],
        ['extension#8:cripple-a1', 2.875, [95.25, 96.75]],
        ['extension#8:cripple-a2', 2.875, [111.25, 112.75]],
        ['extension#8:cripple-a3', 2.875, [127.25, 128.75]],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    // A window keeps the bottom plate whole.
    expect(ids(r.members, 'bottom-plate')).toEqual(['bottom1:1']);
  });

  it('puts the header under the top plates with no cripples when it reaches them', () => {
    // 2x10 (9-1/4 in) on an 84-7/8 in head reaches the studs' top at 94-1/8 in.
    const input = straightWall(192, {
      openings: [{ ...DOOR, height: inch(84.875), header: { stock: S2X10, plies: 2, jacks: 1 } }],
    });
    const r = frame(input);
    expect(ids(r.members, 'cripple')).toEqual([]);
    // jack = king - header - cripples above: 92-5/8 - 9-1/4 = 83-3/8.
    expect(toInches(r.byId.get('extension#7:jack-l')!.length)).toBe(83.375);
    expect(r.openings[0]!.header.source).toBe('opening');
  });

  it('frames doubled jacks and kings when asked', () => {
    const input = straightWall(192, { openings: [{ ...DOOR, kings: 2, jacks: 2 }] });
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(ids(r.members, 'jack')).toEqual([
      'extension#7:jack-l',
      'extension#7:jack-l2',
      'extension#7:jack-r',
      'extension#7:jack-r2',
    ]);
    expect(ids(r.members, 'king')).toEqual([
      'extension#7:king-l',
      'extension#7:king-l2',
      'extension#7:king-r',
      'extension#7:king-r2',
    ]);
    expect(extentInches(seg, r.byId.get('extension#7:king-l2')!).s).toEqual([24, 25.5]);
    expect(extentInches(seg, r.byId.get('extension#7:header')!).s).toEqual([27, 69]);
  });

  it('keeps stud ids before an opening when the wall is lengthened', () => {
    const short = frame(straightWall(192, { openings: [DOOR] }));
    const long = frame(straightWall(240, { openings: [DOOR] }));
    const seg = straightWall(240).segments[0]!;
    for (const m of short.members) {
      if (m.role === 'stud' && m.id !== 's12') {
        const same = long.byId.get(m.id);
        expect(same, m.id).toBeDefined();
        expect(extentInches(seg, same!)).toEqual(extentInches(seg, m));
      }
      if (m.owner === 'extension#7')
        expect(extentInches(seg, long.byId.get(key(m))!)).toEqual(extentInches(seg, m));
    }
    expect(ids(long.members, 'stud').at(-1)).toBe('s15');
  });

  it('uses the narrowest header rule that fits and reports it', () => {
    const rules = [
      { maxWidth: inch(72), header: { stock: S2X10, plies: 2, jacks: 2 } },
      { maxWidth: inch(48), header: { stock: S2X6, plies: 2, jacks: 1 } },
    ];
    const r = frame(straightWall(192, { openings: [DOOR] }, { headerRules: rules }));
    expect(r.openings[0]!.header).toEqual({
      source: 'rule',
      rule: 1,
      stock: '2x6',
      plies: 2,
      jacks: 1,
    });
    expect(r.byId.get('extension#7:header')!.stock).toBe(S2X6);
    expect(r.warnings).toEqual([]);
  });

  it('says, as a layout warning, when an opening is wider than every rule', () => {
    const rules = [{ maxWidth: inch(30), header: { stock: S2X6, plies: 2, jacks: 1 } }];
    const r = frame(straightWall(192, { openings: [DOOR] }, { headerRules: rules }));
    expect(r.openings[0]!.header.source).toBe('default');
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'no-header-rule',
        kind: 'layout',
        opening: 'extension#7',
        segment: 1,
      }),
    ]);
  });

  it('skips an opening that does not fit, with a warning, and keeps the layout studs', () => {
    const r = frame(straightWall(192, { openings: [{ ...DOOR, position: inch(10) }] }));
    expect(r.warnings.map((w) => w.code)).toEqual(['opening-outside-wall']);
    expect(r.openings[0]!.framed).toBe(false);
    expect(ids(r.members, 'stud')).toHaveLength(13);
    const tall = frame(straightWall(192, { openings: [{ ...DOOR, height: inch(90) }] }));
    expect(tall.warnings.map((w) => w.code)).toEqual(['opening-does-not-fit']);
    const both = frame(straightWall(192, { openings: [DOOR, { ...WINDOW, position: inch(60) }] }));
    expect(both.warnings.map((w) => [w.code, w.opening])).toEqual([
      ['openings-overlap', 'extension#8'],
    ]);
  });
});

describe('frameWall: blocking', () => {
  it('puts a mid-height row between studs, outside openings', () => {
    const input = straightWall(192, { openings: [DOOR] }, { blocking: { kind: 'mid-height' } });
    const seg = input.segments[0]!;
    const r = frame(input);
    const blocks = r.members.filter((m) => m.role === 'blocking');
    // Bays: s0-s1, s1-king-l, king-r-s5, s5-s6, ... s11-s12: 2 + 8.
    expect(blocks.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `block1:${i + 1}`),
    );
    expect(extentInches(seg, blocks[0]!).s).toEqual([1.5, 15.25]);
    // Centred between the bottom plate (1-1/2 in) and the studs' top (94-1/8 in).
    const z = extentIn(seg, blocks[0]!).z;
    expect(z[0]).toBeCloseTo(inch(47.0625), 9);
    expect(z[1]).toBeCloseTo(inch(48.5625), 9);
    expect(extentInches(seg, blocks[1]!).s).toEqual([16.75, 27]);
    expect(extentInches(seg, blocks[2]!).s).toEqual([69, 79.25]);
  });

  it('puts rows at given heights, leaving out a row outside the studs', () => {
    const r = frame(
      straightWall(
        48,
        {},
        { blocking: { kind: 'heights', heights: [inch(60), inch(30), inch(200)] } },
      ),
    );
    expect(ids(r.members, 'blocking')).toEqual([
      'block1:1',
      'block1:2',
      'block1:3',
      'block2:1',
      'block2:2',
      'block2:3',
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['blocking-row-outside']);
  });
});

describe('frameWall: added members', () => {
  it('adds a stud, a doubled stud and blocks the layout does not make, owned by the wall', () => {
    const input = straightWall(
      192,
      {},
      {},
      {
        add: [
          { id: 'add1', role: 'stud', at: inch(30) },
          { id: 'add2', role: 'stud', at: inch(56), plies: 2, stock: S2X6 },
          { id: 'add3', role: 'blocking', at: inch(40) },
          { id: 'add4', role: 'blocking', at: inch(24), z: inch(48) },
        ],
      },
    );
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(r.warnings).toEqual([]);
    expect(countByRole(r.members)).toEqual({
      blocking: 2,
      'bottom-plate': 1,
      stud: 16,
      'top-plate': 2,
    });
    const add1 = r.byId.get('add1')!;
    expect(add1).toMatchObject({ owner: WALL, role: 'stud', stock: S2X4, length: inch(92.625) });
    expect(extentInches(seg, add1)).toEqual({ s: [29.25, 30.75], t: [0, 3.5], z: [1.5, 94.125] });
    // A doubled stud: two plies side by side, centred on its position, `add2` then `add2-2`.
    expect(extentInches(seg, r.byId.get('add2')!).s).toEqual([54.5, 56]);
    expect(extentInches(seg, r.byId.get('add2-2')!).s).toEqual([56, 57.5]);
    expect(r.byId.get('add2-2')!.stock).toBe(S2X6);
    // Blocks fit between the verticals either side: s2 and s3, and s1 and the added stud.
    const add3 = r.byId.get('add3')!;
    expect(add3.role).toBe('blocking');
    expect(extentInches(seg, add3)).toEqual({
      s: [32.75, 47.25],
      t: [0, 3.5],
      z: [47.062, 48.562],
    });
    expect(extentInches(seg, r.byId.get('add4')!)).toMatchObject({
      s: [16.75, 29.25],
      z: [47.25, 48.75],
    });
  });

  it('applies overrides to added members, a block fitting between the studs as overridden', () => {
    const input = straightWall(
      192,
      {},
      {},
      {
        add: [
          { id: 'add2', role: 'stud', at: inch(56), plies: 2 },
          { id: 'add3', role: 'blocking', at: inch(40) },
        ],
        overrides: [
          { id: 'add3', stock: S2X6 },
          { id: 's3', move: inch(2) },
          { id: 'add2-2', delete: true },
        ],
      },
    );
    const r = frame(input);
    expect(r.overrides).toEqual([
      { owner: WALL, id: 'add3', status: 'applied' },
      { owner: WALL, id: 's3', status: 'applied' },
      { owner: WALL, id: 'add2-2', status: 'applied' },
    ]);
    expect(r.byId.has('add2-2')).toBe(false);
    expect(r.byId.has('add2')).toBe(true);
    // s3 nudged from 47.25" to 49.25": the block reaches it.
    expect(extentInches(input.segments[0]!, r.byId.get('add3')!).s).toEqual([32.75, 49.25]);
    expect(r.byId.get('add3')!.stock).toBe(S2X6);
  });

  it("adds an opening's members from its centre line, owned by the opening", () => {
    const input = straightWall(192, {
      openings: [
        {
          ...DOOR,
          add: [
            { id: 'add1', role: 'stud', at: inch(-22.75) },
            { id: 'add2', role: 'blocking', at: inch(8), z: inch(90.5) },
          ],
        },
      ],
    });
    const seg = input.segments[0]!;
    const r = frame(input);
    expect(r.warnings).toEqual([]);
    const stud = r.byId.get('extension#7:add1')!;
    expect(stud).toMatchObject({ owner: 'extension#7', role: 'stud' });
    expect(extentInches(seg, stud).s).toEqual([24.5, 26]);
    // Above the header, between the cripples over 48" and 64".
    expect(extentInches(seg, r.byId.get('extension#7:add2')!)).toMatchObject({
      s: [48.75, 63.25],
      z: [89.75, 91.25],
    });
  });

  it('warns when an added stud overlaps a stud the wall already has, and keeps both', () => {
    const r = frame(
      straightWall(192, {}, {}, { add: [{ id: 'add1', role: 'stud', at: inch(33) }] }),
    );
    expect(r.byId.has('add1') && r.byId.has('s2')).toBe(true);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'framing-conflict',
        member: `${WALL}:add1`,
        message: `The added stud add1 of ${WALL} overlaps ${WALL}:s2; both are kept.`,
      }),
    ]);
  });

  it('leaves out an added member that does not fit, and says so', () => {
    const r = frame(
      straightWall(
        192,
        { openings: [DOOR] },
        {},
        {
          add: [
            { id: 'add1', role: 'stud', at: inch(48) },
            { id: 'add2', role: 'stud', at: inch(500) },
            { id: 'add3', role: 'blocking', at: inch(80) },
            { id: 'add4', role: 'blocking', at: inch(88), z: inch(200) },
            { id: 'add5', role: 'blocking', at: inch(48), z: inch(40) },
          ],
          overrides: [{ id: 'add1', delete: true }],
        },
      ),
    );
    expect(r.warnings.filter((w) => w.code === 'added-member-left-out')).toEqual([
      expect.objectContaining({
        member: `${WALL}:add1`,
        message: `The added stud add1 of ${WALL} runs into the framing of opening extension#7; it is left out.`,
      }),
      expect.objectContaining({
        member: `${WALL}:add2`,
        message: `The added stud add2 of ${WALL} is outside the wall; it is left out.`,
      }),
      expect.objectContaining({
        member: `${WALL}:add3`,
        message: `The added block add3 of ${WALL} is on a stud, not between two; it is left out.`,
      }),
      expect.objectContaining({
        member: `${WALL}:add4`,
        message: `The added block add4 of ${WALL} is outside the studs; it is left out.`,
      }),
      expect.objectContaining({
        member: `${WALL}:add5`,
        message: `The added block add5 of ${WALL} runs into the framing of opening extension#7; it is left out.`,
      }),
    ]);
    expect(r.members.some((m) => m.id.startsWith('add'))).toBe(false);
    expect(r.overrides).toEqual([{ owner: WALL, id: 'add1', status: 'lost' }]);
    expect(r.warnings.map((w) => w.message)).toContain(
      `The override of add1 on ${WALL} is lost: the wall adds that member, but it is left out (see its warning).`,
    );
  });

  it("drops an unframed opening's added members with one warning", () => {
    const r = frame(
      straightWall(192, {
        openings: [
          { ...DOOR, position: inch(10), add: [{ id: 'add1', role: 'stud', at: inch(30) }] },
        ],
      }),
    );
    expect(r.members.some((m) => m.owner === 'extension#7')).toBe(false);
    expect(r.warnings).toContainEqual(
      expect.objectContaining({
        code: 'added-member-left-out',
        opening: 'extension#7',
        message: 'Opening extension#7 is not framed, so the members it adds are left out.',
      }),
    );
  });

  it('says an override of a member the feature never had was never had, not "no longer"', () => {
    const r = frame(
      straightWall(
        192,
        { openings: [DOOR] },
        {},
        {
          overrides: [{ id: 'extra1' }, { id: 'king-l' }, { id: 'add9' }, { id: 's40' }],
        },
      ),
    );
    expect(r.overrides.map((o) => o.status)).toEqual(['lost', 'lost', 'lost', 'lost']);
    const never = (id: string) =>
      `The override of ${id} on ${WALL} is lost: the wall never had that member (to add a member its layout does not make, list it in the wall's "add" params).`;
    expect(r.warnings.map((w) => w.message)).toEqual([
      never('extra1'),
      never('king-l'),
      never('add9'),
      `The override of s40 on ${WALL} is lost: the wall no longer has that member.`,
    ]);
  });

  it.each([
    [{ id: 'extra1', role: 'stud', at: 0 }, /not of the form add<k>/],
    [{ id: 'add1-2', role: 'stud', at: 0 }, /not of the form add<k>/],
    [{ id: 'add1', role: 'blocking', at: 0, plies: 2 }, /a block: it has one ply/],
    [{ id: 'add1', role: 'stud', at: 0, plies: 5 }, /1 to 4 plies/],
    [{ id: 'add1', role: 'stud', at: Number.NaN }, /position that is a number/],
    [{ id: 'add1', role: 'stud', at: 0, segment: 2 }, /segment 2, which the wall does not have/],
  ])('refuses %j', (add, message) => {
    expect(() => frameWall(straightWall(192, {}, {}, { add: [add as AddedMember] }))).toThrow(
      message,
    );
  });

  it('refuses an added member id twice in one owner', () => {
    expect(() =>
      frameWall(
        straightWall(
          192,
          {},
          {},
          {
            add: [
              { id: 'add1', role: 'stud', at: inch(30) },
              { id: 'add1', role: 'stud', at: inch(40) },
            ],
          },
        ),
      ),
    ).toThrow(FramingInputError);
  });
});

describe('frameWall: overrides', () => {
  it('deletes, restocks and moves members by id, and reports overrides it cannot apply', () => {
    const input = straightWall(
      192,
      {},
      {},
      {
        overrides: [
          { id: 's5', delete: true },
          { id: 's6', stock: S2X6 },
          { id: 's7', move: inch(2) },
          { id: 's40', delete: true },
        ],
      },
    );
    const r = frame(input);
    expect(r.byId.has('s5')).toBe(false);
    expect(r.byId.get('s6')!.stock).toBe(S2X6);
    expect(extentInches(input.segments[0]!, r.byId.get('s7')!).s).toEqual([113.25, 114.75]);
    expect(r.overrides).toEqual([
      { owner: WALL, id: 's5', status: 'applied' },
      { owner: WALL, id: 's6', status: 'applied' },
      { owner: WALL, id: 's7', status: 'applied' },
      { owner: WALL, id: 's40', status: 'lost' },
    ]);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'override-lost',
        member: 'extension#3:s40',
        message: 'The override of s40 on extension#3 is lost: the wall no longer has that member.',
      }),
    ]);
    expect(r.members.filter((m) => m.role === 'stud')).toHaveLength(12);
  });

  it("applies an opening's overrides to the opening's own members, by local id", () => {
    const r = frame(
      straightWall(192, {
        openings: [
          {
            ...DOOR,
            overrides: [
              { id: 'king-l', stock: S2X6 },
              { id: 'cripple-a2', delete: true },
              { id: 'sill', delete: true },
            ],
          },
        ],
      }),
    );
    expect(r.byId.get('extension#7:king-l')!.stock).toBe(S2X6);
    expect(r.byId.has('extension#7:cripple-a2')).toBe(false);
    expect(r.overrides).toEqual([
      { owner: 'extension#7', id: 'king-l', status: 'applied' },
      { owner: 'extension#7', id: 'cripple-a2', status: 'applied' },
      { owner: 'extension#7', id: 'sill', status: 'lost' },
    ]);
    // A door has no rough sill.
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'override-lost',
        opening: 'extension#7',
        member: 'extension#7:sill',
        message:
          'The override of sill on extension#7 is lost: the opening no longer has that member.',
      }),
    ]);
  });

  it('says why an override is lost when its opening is not framed', () => {
    const r = frame(
      straightWall(192, {
        openings: [{ ...DOOR, position: inch(10), overrides: [{ id: 'king-l', delete: true }] }],
      }),
    );
    expect(r.overrides).toEqual([{ owner: 'extension#7', id: 'king-l', status: 'lost' }]);
    expect(r.warnings.map((w) => w.message)).toContain(
      'The override of king-l on extension#7 is lost: the opening is not framed.',
    );
  });

  it('does not claim a member is gone from the wall when an earlier override deleted it', () => {
    const r = frame(
      straightWall(
        192,
        {},
        {},
        {
          overrides: [
            { id: 's5', delete: true },
            { id: 's5', stock: S2X6 },
          ],
        },
      ),
    );
    expect(r.overrides).toEqual([
      { owner: WALL, id: 's5', status: 'applied' },
      { owner: WALL, id: 's5', status: 'lost' },
    ]);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'override-lost',
        member: 'extension#3:s5',
        message:
          'The override of s5 on extension#3 is lost: an earlier override of the same member deletes it.',
      }),
    ]);
  });

  it('keeps the wall and an opening apart when their local ids could meet', () => {
    // Both owners are separate: an override of the wall never reaches an opening's member.
    const r = frame(
      straightWall(192, { openings: [DOOR] }, {}, { overrides: [{ id: 'king-l', delete: true }] }),
    );
    expect(r.byId.has('extension#7:king-l')).toBe(true);
    expect(r.overrides).toEqual([{ owner: WALL, id: 'king-l', status: 'lost' }]);
  });
});

describe('frameWall: overrides by position (#1215)', () => {
  // The as-built overrides of the remodel-frame probe: s4 and s8 deleted, s3 nudged 3", each
  // with where its stud was on 16" centres.
  const asBuilt = {
    overrides: [
      { id: 's4', delete: true, at: inch(64) },
      { id: 's8', delete: true, at: inch(128) },
      { id: 's3', move: inch(3), at: inch(48) },
    ],
  };
  const centre = (r: WallFraming & { byId: Map<string, Member> }, id: string) => {
    const s = at2(straightWall(192).segments[0]!, r.byId.get(id)!);
    return (s[0] + s[1]) / 2;
  };

  it('applies overrides with a position to the member they name while the layout holds', () => {
    const r = frame(straightWall(192, {}, {}, asBuilt));
    expect(r.overrides).toEqual([
      { owner: WALL, id: 's4', status: 'applied' },
      { owner: WALL, id: 's8', status: 'applied' },
      { owner: WALL, id: 's3', status: 'applied' },
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.byId.has('s4')).toBe(false);
    expect(r.byId.has('s8')).toBe(false);
    expect(centre(r, 's3')).toBe(51);
  });

  it('follows a stud renumbered by a spacing change, and loses one nothing is at', () => {
    const r = frame(straightWall(192, {}, { spacing: inch(24) }, asBuilt));
    expect(r.overrides).toEqual([
      { owner: WALL, id: 's4', status: 'lost' },
      { owner: WALL, id: 's8', status: 'lost' },
      { owner: WALL, id: 's3', status: 'moved', appliedTo: 's2' },
    ]);
    // s4 is now the stud at 96": left as framed. s2 is the stud at 48": nudged.
    expect(centre(r, 's4')).toBe(96);
    expect(centre(r, 's2')).toBe(51);
    expect(centre(r, 's3')).toBe(72);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'override-lost',
        member: `${WALL}:s4`,
        message: `The override of s4 on ${WALL} is lost: the layout changed, and the wall has no layout stud where s4 was (s4 is now another stud, left as framed).`,
      }),
      expect.objectContaining({
        code: 'override-lost',
        member: `${WALL}:s8`,
        message: `The override of s8 on ${WALL} is lost: the layout changed, and the wall has no layout stud where s8 was (s8 is now another stud, left as framed).`,
      }),
      expect.objectContaining({
        code: 'override-moved',
        member: `${WALL}:s2`,
        message: `The override of s3 on ${WALL} now applies to s2: the layout changed, and s2 is the member where s3 was.`,
      }),
    ]);
  });

  it('says a stud whose id is gone is gone', () => {
    const r = frame(
      straightWall(
        192,
        {},
        { spacing: inch(48) },
        {
          overrides: [{ id: 's8', delete: true, at: inch(128) }],
        },
      ),
    );
    expect(r.overrides).toEqual([{ owner: WALL, id: 's8', status: 'lost' }]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      `The override of s8 on ${WALL} is lost: the layout changed, and the wall has no layout stud where s8 was.`,
    ]);
  });

  it('follows a stud renumbered by a change of layout direction, and blocks by position', () => {
    const blocking = { kind: 'mid-height' } as const;
    const before = frame(straightWall(192, {}, { blocking }));
    // The block between s3 and s4, centred at 56".
    const mid = (m: Member) => {
      const s = at2(straightWall(192).segments[0]!, m);
      return (s[0] + s[1]) / 2;
    };
    const block = before.members.find((m) => m.role === 'blocking' && mid(m) === 56)!;
    const r = frame(
      straightWall(
        192,
        {},
        { blocking, layoutFrom: 'end' },
        {
          overrides: [
            { id: 's3', stock: S2X6, at: inch(48) },
            { id: block.id, delete: true, at: inch(56) },
          ],
        },
      ),
    );
    // s3 is renumbered from the far end; blocks are numbered along the wall either way, so the
    // block keeps its id (and its override applies as written).
    const to = r.overrides[0]!.appliedTo!;
    expect(r.overrides[0]).toEqual({ owner: WALL, id: 's3', status: 'moved', appliedTo: to });
    expect(to).not.toBe('s3');
    expect(centre(r, to)).toBe(48);
    expect(r.byId.get(to)!.stock).toBe(S2X6);
    expect(r.overrides[1]).toEqual({ owner: WALL, id: block.id, status: 'applied' });
    expect(r.members.some((m) => m.role === 'blocking' && mid(m) === 56)).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(['override-moved']);
    // A block found by position in another bay moves with it: the same override at 72" (the bay
    // between s4 and s5) deletes that bay's block, whatever this one's id.
    const other = frame(
      straightWall(
        192,
        {},
        { blocking },
        { overrides: [{ id: block.id, delete: true, at: inch(72) }] },
      ),
    );
    expect(other.overrides[0]!.status).toBe('moved');
    expect(other.byId.has(block.id)).toBe(true);
    expect(other.members.some((m) => m.role === 'blocking' && mid(m) === 72)).toBe(false);
  });

  it('matches within 1/2", the nearest stud first', () => {
    const near = frame(
      straightWall(192, {}, {}, { overrides: [{ id: 's9', delete: true, at: inch(48.4) }] }),
    );
    expect(near.overrides).toEqual([{ owner: WALL, id: 's9', status: 'moved', appliedTo: 's3' }]);
    const far = frame(
      straightWall(192, {}, {}, { overrides: [{ id: 's3', delete: true, at: inch(48.6) }] }),
    );
    expect(far.overrides).toEqual([{ owner: WALL, id: 's3', status: 'lost' }]);
    expect(far.byId.has('s3')).toBe(true);
  });

  it('keeps matching by id without a position (older overrides), and on other members', () => {
    // Without `at` a spacing change re-targets as before #1215: s4 deletes the stud at 96".
    const old = frame(
      straightWall(192, {}, { spacing: inch(24) }, { overrides: [{ id: 's4', delete: true }] }),
    );
    expect(old.overrides).toEqual([{ owner: WALL, id: 's4', status: 'applied' }]);
    expect(old.warnings).toEqual([]);
    // Plates, an opening's members and added members keep their ids: `at` is not used.
    const r = frame(
      straightWall(
        192,
        { openings: [{ ...DOOR, overrides: [{ id: 'king-l', stock: S2X6, at: inch(900) }] }] },
        { spacing: inch(24) },
        {
          add: [{ id: 'add1', role: 'stud', at: inch(100) }],
          overrides: [
            { id: 'top1:1', stock: S2X6, at: inch(900) },
            { id: 'add1', stock: S2X6, at: inch(900) },
          ],
        },
      ),
    );
    expect(r.overrides.map((o) => o.status)).toEqual(['applied', 'applied', 'applied']);
  });
});

describe('frameWall: segments', () => {
  it('prefixes every id but opening members with the segment in later segments', () => {
    const input: FrameWallInput = {
      wall: WALL,
      segments: [
        {
          start: [0, 0],
          end: [inch(96), 0],
          height: inch(97.125),
          thickness: inch(3.5),
          justification: 'left',
          joins: { end: { kind: 'L', through: true, otherThickness: inch(3.5) } },
        },
        {
          start: [inch(96), inch(3.5)],
          end: [inch(96), inch(99.5)],
          height: inch(97.125),
          thickness: inch(3.5),
          justification: 'left',
          joins: { start: { kind: 'L', through: false, otherThickness: inch(3.5) } },
          openings: [{ ...WINDOW, position: inch(48) }],
        },
      ],
      settings: { studStock: S2X4, defaultHeader: DOUBLE_2X8 },
    };
    const r = frame(input);
    expect(r.byId.has('s0')).toBe(true);
    expect(r.byId.has('seg2/s0')).toBe(true);
    expect(r.byId.has('seg2/top2:1')).toBe(true);
    expect(r.byId.has('end:corner')).toBe(true);
    expect(r.byId.has('extension#8:header')).toBe(true);
    expect(r.openings[0]!.segment).toBe(2);
    expect(new Set(r.members.map(memberFullId)).size).toBe(r.members.length);
    expect(r.byId.get('extension#8:header')!.owner).toBe('extension#8');
  });
});

describe('frameWall: input errors', () => {
  it('refuses input it cannot frame', () => {
    expect(() => frameWall(straightWall(2))).toThrow(FramingInputError);
    expect(() => frameWall(straightWall(96, { thickness: inch(5.5) }))).toThrow(/thick/);
    expect(() => frameWall(straightWall(96, {}, { spacing: inch(1) }))).toThrow(/spacing/);
    expect(() => frameWall(straightWall(96, { height: inch(5) }))).toThrow(/too low/);
    expect(() => frameWall(straightWall(96, { openings: [{ ...DOOR, id: 'door' }] }))).toThrow(
      /feature id/,
    );
    expect(() => frameWall({ ...straightWall(96), segments: [] })).toThrow(/segment/);
  });

  it('refuses a wall past the member budget as soon as it passes, not after building it', () => {
    // The review's case: 64 points 100 m apart, 50 mm spacing, 20 blocking rows. Built in full it
    // was 2.6 million members (2.27 GB, 6.5 s) before regen's cap refused it.
    const zigzag = Array.from({ length: 64 }, (_, i) => [0, (i % 2) * 100_000] as const);
    const heights = Array.from({ length: 20 }, (_, r) => 200 + r * 100);
    const base = straightWall(96, {}, { spacing: 50, blocking: { kind: 'heights', heights } });
    const seg = base.segments[0]!;
    const input: FrameWallInput = {
      ...base,
      segments: zigzag.slice(1).map((p, i) => ({
        ...seg,
        start: [i * 1000, zigzag[i]![1]],
        end: [i * 1000, p[1]],
      })),
    };
    const t0 = performance.now();
    expect(() => frameWall(input)).toThrow(
      new FramingInputError(
        `The wall would have more than ${MEMBER_BUDGET} members, the most one may have: widen its spacing, shorten it or drop some blocking rows.`,
      ),
    );
    expect(performance.now() - t0).toBeLessThan(500);
    // A wall whose layout alone is far past the budget is refused before it is laid out.
    const t1 = performance.now();
    expect(() => frameWall(straightWall(1e9 / 25.4))).toThrow(/more than 50000 members/);
    expect(performance.now() - t1).toBeLessThan(200);
  });

  it('refuses many ladder tees before building their backing rows', () => {
    // The review's case: 5,000 tees, 30 m high, ladder rows every 50 mm. Each tee built its own
    // rows before any was counted (997 MB before the refusal).
    const L = 5000 * 300;
    const base = straightWall(
      L / 25.4,
      {
        height: 30_000,
        tees: Array.from({ length: 5000 }, (_, i) => ({ at: 150 + i * 300, otherThickness: 89 })),
      },
      { cornerStyle: 'ladder', ladderSpacing: 50, spacing: 300 },
    );
    const t0 = performance.now();
    expect(() => frameWall(base)).toThrow(/more than 50000 members/);
    expect(performance.now() - t0).toBeLessThan(200);
    // Two through corners with a set of rows each are counted too.
    const corners = straightWall(
      96,
      {
        height: 30_000,
        joins: {
          start: { kind: 'L', through: true, otherThickness: 89 },
          end: { kind: 'L', through: true, otherThickness: 89 },
        },
      },
      { cornerStyle: 'ladder', ladderSpacing: 50 },
    );
    expect(() => frameWall({ ...corners, maxMembers: 1000 })).toThrow(/more than 1000 members/);
  });

  it('refuses many openings before comparing each with every accepted one', () => {
    // The review's case: 20,000 openings, each compared with every accepted one before anything
    // was counted (13.7 s before the member budget refused).
    const n = 20_000;
    const pitch = inch(12);
    const input = straightWall((n * pitch) / 25.4 + 24, {
      openings: Array.from({ length: n }, (_, i) => ({
        id: `extension#${100 + i}`,
        position: inch(12) + i * pitch,
        width: inch(4),
        height: inch(24),
        sill: inch(36),
      })),
    });
    const t0 = performance.now();
    expect(() => frameWall(input)).toThrow(/more than 50000 members/);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('frames thousands of openings over close-set slots without comparing every pair', () => {
    // The audit's case: openings packed along a wall whose studs are just over a stud apart, so
    // ~36,000 slots each met every accepted opening (3.6 s before the budget refused at 8,300
    // openings; 1.3 s to frame 4,000).
    const sw = inch(1.5);
    const pitch = 4 * sw + 20;
    const wall = (n: number, layoutFrom: 'start' | 'end', sill: number) =>
      straightWall(
        (n * pitch + 40) / 25.4,
        {
          openings: Array.from({ length: n }, (_, i) => ({
            id: `extension#${100 + i}`,
            position: 20 + pitch / 2 + i * pitch,
            width: 10,
            height: inch(24),
            sill,
          })),
        },
        { spacing: sw + 0.1, layoutFrom, blocking: { kind: 'mid-height' } },
      );
    for (const from of ['start', 'end'] as const)
      for (const sill of [inch(36), 0]) {
        const t0 = performance.now();
        expect(() => frameWall(wall(8000, from, sill))).toThrow(/more than 50000 members/);
        expect(performance.now() - t0).toBeLessThan(200);
        const t1 = performance.now();
        const r = frameWall(wall(4000, from, sill));
        expect(performance.now() - t1).toBeLessThan(300);
        expect(r.openings.every((o) => o.framed)).toBe(true);
        expect(countByRole(r.members).cripple).toBeGreaterThan(0);
      }
  });

  it('refuses a wall type with too many blocking heights', () => {
    const heights = Array.from({ length: 1001 }, (_, r) => 200 + r);
    const t0 = performance.now();
    expect(() =>
      frameWall(straightWall(96, {}, { blocking: { kind: 'heights', heights } })),
    ).toThrow(/at most 1000 blocking heights/);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('frames up to the budget it is given and refuses one member past it', () => {
    const input = straightWall(192);
    const n = frameWall(input).members.length;
    expect(frameWall({ ...input, maxMembers: n }).members).toHaveLength(n);
    expect(() => frameWall({ ...input, maxMembers: n - 1 })).toThrow(/more than 15 members/);
    for (const bad of [0, 1.5, MEMBER_BUDGET + 1, Number.NaN])
      expect(() => frameWall({ ...input, maxMembers: bad })).toThrow(/member budget/);
    const budget = new MemberBudget(undefined, 'The floor');
    expect(budget.limit).toBe(MEMBER_BUDGET);
    budget.take(MEMBER_BUDGET);
    expect(budget.count).toBe(MEMBER_BUDGET);
    expect(() => budget.expect(1)).toThrow(/The floor would have more than/);
    expect(() => budget.take()).toThrow(FramingInputError);
  });

  it('is deterministic', () => {
    const input = straightWall(
      300,
      { openings: [DOOR, WINDOW], tees: [{ at: inch(200), otherThickness: inch(3.5) }] },
      { blocking: { kind: 'mid-height' } },
    );
    expect(frameWall(input)).toEqual(frameWall(input));
  });
});

describe('wording', () => {
  it('never calls anything safe, compliant or OK', () => {
    const r = frameWall(
      straightWall(
        192,
        {
          openings: [
            { ...DOOR, position: inch(10) },
            WINDOW,
            { ...DOOR, id: 'extension#9', position: inch(120) },
          ],
        },
        { headerRules: [{ maxWidth: inch(1), header: DOUBLE_2X8 }] },
        { overrides: [{ id: 'king-l', delete: true }] },
      ),
    );
    const text = [DISCLAIMER_SHORT, ...r.warnings.map((w) => w.message)].join(' ');
    expect(r.warnings.length).toBeGreaterThan(2);
    expect(text).not.toMatch(/\bsafe\b|complian|\bOK\b/i);
  });
});

function at2(seg: Parameters<typeof extentInches>[0], m: Member): [number, number] {
  return extentInches(seg, m).s;
}
