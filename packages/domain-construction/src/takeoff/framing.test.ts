// Hand-computed fixtures for the framing producer (M6 plan T6.3a). Inputs and expectations are in
// inches and feet; the takeoff works in millimetres. Kerf is the default 1/8" throughout.

import type { StockData } from '@manufakture/stock';
import { describe, expect, it } from 'vitest';
import { frameRoof } from '../framing/roof';
import { frameWall } from '../framing/wall';
import { S2X4, S2X6, S2X8, inch, straightWall, toInches } from '../test-helpers';
import { constructionTakeoff } from './takeoff';
import type { ConstructionRow, ConstructionTakeoff, TakeoffMember } from './types';

const ft = (...feet: number[]) => feet.map((f) => inch(f * 12));

/** Rows of a category as `[key without category, quantity]`, lengths in inches. */
function rows(t: ConstructionTakeoff, category: string): Array<[string, number]> {
  return t.rows.filter((r) => r.category === category).map((r) => [label(r), r.quantity]);
}

function label(r: ConstructionRow): string {
  const len = r.size?.length;
  return len === undefined ? `${r.stock} ${r.item}` : `${r.stock} ${toInches(len)}`;
}

const prices = (
  entries: Array<[string, number, 'piece' | 'foot' | 'sheet' | 'board-foot' | 'metre', string?]>,
): StockData => ({
  stored: new Map(),
  overrides: new Map(
    entries.map(([id, amount, per, currency]) => [
      id,
      { price: { amount, per, ...(currency === undefined ? {} : { currency }) } },
    ]),
  ),
});

describe('framing takeoff: the T6.2a 16 ft wall', () => {
  // 16' at 16" on centre, free ends: 192 / 16 + 1 = 13 studs of 92-5/8" (one bottom and two top
  // plates of 1-1/2" on a 97-1/8" wall), and three plates of 16'.
  const wall = frameWall(straightWall(192));

  it('lists the members as framed by stock and length', () => {
    const t = constructionTakeoff({ members: wall.members });
    expect(rows(t, 'framing')).toEqual([
      ['us-2x4 192', 3],
      ['us-2x4 92.625', 13],
    ]);
    const studs = t.rows.find((r) => r.key.endsWith(String(Math.round(inch(92.625) * 1e6))))!;
    expect(studs.item).toBe('Stud');
    expect(studs.sources).toHaveLength(13);
    expect(studs.sources[0]).toEqual({ id: 'extension#3:s0', quantity: 1 });
  });

  it('buys the studs as 92-5/8 in precuts and the plates as three 16 ft lengths', () => {
    const t = constructionTakeoff({ members: wall.members });
    expect(rows(t, 'lumber')).toEqual([
      ['us-2x4 192', 3],
      ['us-2x4-precut-92-5-8 92.625', 13],
    ]);
    const precut = t.rows.find((r) => r.stock === 'us-2x4-precut-92-5-8')!;
    expect(precut.flags).toContain('precut');
    expect(precut.item).toBe('2x4 precut stud 92-5/8"');
  });

  it('totals the plates in linear feet: 3 x 16 ft = 48 ft', () => {
    const t = constructionTakeoff({ members: wall.members });
    const plates = t.rows.find((r) => r.category === 'linear')!;
    expect([plates.item, plates.quantity, plates.unit]).toEqual(['Plates', 3, 'length']);
    expect(toInches(plates.extended)).toBe(48 * 12);
  });

  it('with precuts off, lays the studs out on 16 ft lengths, two to a stick', () => {
    // Two studs take 92.625 x 2 + 1/8" kerf = 185.375" of a 192" stick: 13 studs need 6 sticks
    // and one stud on its own, on the shortest length that holds it (8' = 96"). The three 192"
    // plates take a 16' stick each: 9 x 16' and 1 x 8'.
    const t = constructionTakeoff({ members: wall.members, settings: { precuts: false } });
    expect(rows(t, 'lumber')).toEqual([
      ['us-2x4 192', 9],
      ['us-2x4 96', 1],
    ]);
  });

  it('buys 12 ft stock as the 1D layout of the spliced plates when the lengths stop at 12 ft', () => {
    // The generator, given plate stock up to 12', splices each 192" course: bottom 144 + 48,
    // first top 144 + 48, cap 120 + 72 (its splice at 120" keeps 24" from the first top's at
    // 144"). Bought from 8', 10' and 12' with a 1/8" kerf: 144 and 144 take a 12' each; 120 a
    // 10'; the two 48s take 48 + 1/8 + 48 = 96.125", more than 8', so a 10'; 72 an 8'.
    const spliced = frameWall(straightWall(192, {}, { plateStockLengths: ft(8, 10, 12) }));
    expect(spliced.warnings).toEqual([]);
    const top = spliced.members
      .filter((m) => m.role === 'top-plate')
      .map((m) => [m.id, toInches(m.length)]);
    expect(top).toEqual([
      ['top1:1', 144],
      ['top1:2', 48],
      ['top2:1', 120],
      ['top2:2', 72],
    ]);
    const t = constructionTakeoff({
      members: spliced.members,
      settings: { lengths: { 'us-2x4': ft(8, 10, 12) } },
    });
    expect(rows(t, 'lumber')).toEqual([
      ['us-2x4 144', 2],
      ['us-2x4 120', 2],
      ['us-2x4 96', 1],
      ['us-2x4-precut-92-5-8 92.625', 13],
    ]);
    // Linear feet do not change: still 6 pieces making 48 ft.
    const plates = t.rows.find((r) => r.category === 'linear')!;
    expect([plates.quantity, toInches(plates.extended)]).toEqual([6, 576]);
  });

  it('splices 16 ft plates into pieces when the yard sells only up to 12 ft, and says so', () => {
    // Each 192" plate becomes 144 + 48: three 12' sticks, and the three 48s: two on a 10'
    // (96.125") and one on an 8'.
    const t = constructionTakeoff({
      members: wall.members,
      settings: { lengths: { 'us-2x4': ft(8, 10, 12) } },
    });
    expect(rows(t, 'lumber')).toEqual([
      ['us-2x4 144', 3],
      ['us-2x4 120', 1],
      ['us-2x4 96', 1],
      ['us-2x4-precut-92-5-8 92.625', 13],
    ]);
    for (const r of t.rows.filter((x) => x.category === 'lumber' && x.stock === 'us-2x4')) {
      expect(r.flags).toContain('spliced');
    }
  });
});

describe('framing takeoff: other cases', () => {
  const member = (
    id: string,
    role: TakeoffMember['role'],
    stock: TakeoffMember['stock'],
    lengthIn: number,
  ): TakeoffMember => ({
    id,
    owner: 'extension#9',
    role,
    stock,
    length: inch(lengthIn),
  });

  it('lists a member longer than every length sold at its own length', () => {
    // A 21' joist against lengths up to 20'.
    const t = constructionTakeoff({
      members: [member('j0', 'joist', S2X6, 252)],
      settings: { lengths: { 'us-2x6': ft(8, 20) } },
    });
    const r = t.rows.find((x) => x.category === 'lumber')!;
    expect([label(r), r.quantity, r.flags]).toEqual([
      'us-2x6 252',
      1,
      ['longer-than-stock', 'no-price'],
    ]);
  });

  it('buys at the member lengths when the stock has no lengths sold', () => {
    const t = constructionTakeoff({
      members: [member('j0', 'joist', S2X6, 100), member('j1', 'joist', S2X6, 100)],
      settings: { lengths: { 'us-2x6': [] } },
    });
    const r = t.rows.find((x) => x.category === 'lumber')!;
    expect([label(r), r.quantity, r.flags]).toEqual([
      'us-2x6 100',
      2,
      ['no-price', 'no-stock-lengths'],
    ]);
  });

  it('lists a stock the catalog lacks as framed, flagged, and buys none of it', () => {
    const odd = { id: 'us-2x7', name: '2x7', width: inch(1.5), depth: inch(6.5) };
    const t = constructionTakeoff({ members: [member('s0', 'stud', odd, 90)] });
    expect(t.rows.map((r) => [r.category, r.flags])).toEqual([['framing', ['stock-unknown']]]);
  });

  it('matches only studs, kings and corner studs to precuts', () => {
    // A 92-5/8" blocking piece is not a stud: it goes to the 1D layout (one 8' stick).
    const t = constructionTakeoff({
      members: [member('s0', 'stud', S2X4, 92.625), member('b0', 'blocking', S2X4, 92.625)],
    });
    expect(rows(t, 'lumber')).toEqual([
      ['us-2x4 96', 1],
      ['us-2x4-precut-92-5-8 92.625', 1],
    ]);
  });

  it('totals blocking and fascia in linear feet', () => {
    // Mid-height blocking in the 16' wall: 12 bays. The 10 between centred studs are 16" less a
    // stud, 14-1/2"; the two end bays run from the flush end stud (1-1/2") to the stud centred on
    // 16" (15-1/4"), 13-3/4". 10 x 14.5 + 2 x 13.75 = 172-1/2".
    const blocked = frameWall(straightWall(192, {}, { blocking: { kind: 'mid-height' } }));
    const t = constructionTakeoff({ members: blocked.members });
    const b = t.rows.find((r) => r.key === 'linear|Blocking|us-2x4')!;
    expect([b.quantity, toInches(b.extended)]).toEqual([12, 172.5]);
    // A 16' gable with a 2x6 sub-fascia and fascia on both eaves: 4 boards of 192", 64 ft.
    const roof = frameRoof({
      roof: 'extension#9',
      kind: 'gable',
      pitch: Math.atan(0.5),
      footprint: {
        origin: [0, 0],
        length: inch(192),
        width: inch(144),
        plate: inch(97.125),
        wallThickness: inch(3.5),
      },
      settings: { rafterStock: S2X6, ridgeStock: S2X8, subFascia: S2X6, fascia: S2X6 },
    });
    const f = constructionTakeoff({ members: roof.members }).rows.find(
      (r) => r.key === 'linear|Fascia|us-2x6',
    )!;
    expect([f.quantity, toInches(f.extended)]).toEqual([4, 4 * 192]);
  });
});

describe('framing takeoff: cost', () => {
  const wall = frameWall(straightWall(192));

  it('prices precuts per piece and lengths per foot', () => {
    // 13 precuts at $4.25 = $55.25; three 16' plates at $0.80 a foot = 48 x 0.80 = $38.40.
    const t = constructionTakeoff({
      members: wall.members,
      stock: prices([
        ['us-2x4-precut-92-5-8', 4.25, 'piece', 'USD'],
        ['us-2x4', 0.8, 'foot', 'USD'],
      ]),
    });
    expect(t.cost.currency).toBe('USD');
    expect(t.cost.total).toBeCloseTo(55.25 + 38.4, 9);
    expect(t.cost.unpriced).toEqual([]);
    const plates = t.rows.find((r) => r.key === `lumber|us-2x4|${Math.round(inch(192) * 1e6)}`)!;
    expect(plates.cost).toBeCloseTo(38.4, 9);
    expect(plates.price).toEqual({ amount: 0.8, per: 'foot', currency: 'USD' });
  });

  it('prices per stick, per metre and per board foot', () => {
    // Per stick: 3 x $9 = $27. Per metre: 3 x 4.8768 m x $2 = $29.2608. Per board foot on the
    // nominal 2" x 4": a 16' 2x4 is 2 x 4 x 192 / 144 = 10.667 bf, 3 x 10.667 x $0.60 = $19.20.
    const cost = (amount: number, per: 'piece' | 'metre' | 'board-foot') =>
      constructionTakeoff({
        members: wall.members,
        settings: { precuts: true },
        stock: prices([['us-2x4', amount, per]]),
      }).rows.find((r) => r.stock === 'us-2x4' && r.category === 'lumber')!.cost;
    expect(cost(9, 'piece')).toBeCloseTo(27, 9);
    expect(cost(2, 'metre')).toBeCloseTo(3 * 4.8768 * 2, 9);
    expect(cost(0.6, 'board-foot')).toBeCloseTo(19.2, 9);
  });

  it('flags rows with no price, a price per sheet on lumber, or another currency, and leaves them out', () => {
    const t = constructionTakeoff({
      members: wall.members,
      settings: { currency: 'USD' },
      stock: prices([
        ['us-2x4-precut-92-5-8', 4, 'sheet'],
        ['us-2x4', 1, 'foot', 'EUR'],
      ]),
    });
    const flags = Object.fromEntries(
      t.rows.filter((r) => r.category === 'lumber').map((r) => [r.stock, r.flags]),
    );
    expect(flags).toEqual({
      'us-2x4': ['other-currency'],
      'us-2x4-precut-92-5-8': ['precut', 'price-unit'],
    });
    expect(t.cost).toEqual({
      currency: 'USD',
      total: 0,
      unpriced: [`lumber|us-2x4|${Math.round(inch(192) * 1e6)}`, 'lumber|us-2x4-precut-92-5-8'],
    });
    const none = constructionTakeoff({ members: wall.members });
    expect(none.cost.unpriced).toHaveLength(2);
    expect(none.rows.filter((r) => r.flags.includes('no-price')).map((r) => r.category)).toEqual([
      'lumber',
      'lumber',
    ]);
  });

  it('ranks 1D layouts by price when every length is priced', () => {
    // Per piece, a 16' costs the same as an 8': $5 each. Two 92" blocks fit one 16' stick
    // (184.125") or two 8' sticks; the price makes it one 16'.
    const blocks: TakeoffMember[] = [0, 1].map((i) => ({
      id: `b${i}`,
      owner: 'extension#3',
      role: 'blocking',
      stock: S2X4,
      length: inch(92),
    }));
    const t = constructionTakeoff({ members: blocks, stock: prices([['us-2x4', 5, 'piece']]) });
    expect(rows(t, 'lumber')).toEqual([['us-2x4 192', 1]]);
    expect(t.cost.total).toBe(5);
  });
});
