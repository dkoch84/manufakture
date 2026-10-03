// The 12' x 16' shed (M6 plan T6.3a and T6.7), framed with the real generators and taken off, with
// every count derived by hand below. Inches throughout; kerf the default 1/8".
//
// The shed: a floor 12' x 16' on three 4x6 skids, 2x6 joists at 16" on centre, 23/32" OSB
// subfloor; four 2x4 walls at 16" on centre, one bottom and two top plates, 92-5/8" precut studs
// (walls 97-1/8" high), 7/16" OSB sheathing, no drywall; the 16' walls run through the corners
// (two-stud corners), the 12' walls butt between them (137" framed); a 36" x 80" door in one 12'
// wall and two 24" x 36" windows (sill 44") in one 16' wall, all with the user's header rule
// "up to 48": two 2x6 plies, one jack"; a 6/12 gable roof with 2x6 rafters at 16", a 2x8 ridge,
// 12" eave and rake overhangs, 2x4 rafter ties 24" above the plates on every other pair, 2x4 gable
// studs at 16", and 7/16" OSB roof sheathing.

import type { StockData } from '@manufakture/stock';
import { describe, expect, it } from 'vitest';
import { frameFloor } from '../framing/floor';
import { frameRoof, type FrameRoofInput } from '../framing/roof';
import { frameWall, type HeaderSpec, type WallOpening } from '../framing/wall';
import { countByRole, type StockRef } from '../members';
import { PRECUT_WALL_HEIGHT, S2X4, S2X6, S2X8, inch, toInches } from '../test-helpers';
import { roofSheathingFaces, subfloorFace, wallFace } from './faces';
import { constructionTakeoff } from './takeoff';
import type { ConstructionRow, SheetFace } from './types';

const S4X6: StockRef = { id: 'us-4x6', name: '4x6', width: inch(3.5), depth: inch(5.5) };
const OSB_23_32: StockRef = {
  id: 'us-osb-23-32',
  name: '3/4" OSB',
  width: inch(23 / 32),
  depth: inch(48),
};
const OSB = 'us-osb-7-16';
const HEADER: HeaderSpec = { stock: S2X6, plies: 2, jacks: 1 };
const L_JOIN = { kind: 'L' as const, otherThickness: inch(3.5) };

function wall(id: string, lengthIn: number, through: boolean, openings: WallOpening[] = []) {
  return frameWall({
    wall: id,
    segments: [
      {
        start: [0, 0],
        end: [inch(lengthIn), 0],
        height: PRECUT_WALL_HEIGHT,
        thickness: inch(3.5),
        justification: 'left',
        joins: { start: { ...L_JOIN, through }, end: { ...L_JOIN, through } },
        openings,
      },
    ],
    settings: {
      studStock: S2X4,
      defaultHeader: HEADER,
      headerRules: [{ maxWidth: inch(48), header: HEADER }],
    },
  });
}

const window = (id: string, at: number): WallOpening => ({
  id,
  position: inch(at),
  width: inch(24),
  height: inch(36),
  sill: inch(44),
});

// Walls: A (front, windows) and C (back) 16' through; B (door) and D 12' butting.
const A = wall('extension#3', 192, true, [window('extension#7', 48), window('extension#8', 144)]);
const B = wall('extension#4', 137, false, [
  { id: 'extension#9', position: inch(68.5), width: inch(36), height: inch(80), sill: 0 },
]);
const C = wall('extension#5', 192, true);
const D = wall('extension#6', 137, false);
const FLOOR = frameFloor({
  floor: 'extension#2',
  outline: [
    [0, 0],
    [inch(144), 0],
    [inch(144), inch(192)],
    [0, inch(192)],
  ],
  direction: [1, 0],
  settings: { joistStock: S2X6, skids: { stock: S4X6, count: 3 }, subfloor: OSB_23_32 },
});
const ROOF_INPUT: FrameRoofInput = {
  roof: 'extension#10',
  kind: 'gable',
  pitch: Math.atan(6 / 12),
  footprint: {
    origin: [0, 0],
    length: inch(192),
    width: inch(144),
    plate: PRECUT_WALL_HEIGHT,
    wallThickness: inch(3.5),
  },
  settings: {
    rafterStock: S2X6,
    ridgeStock: S2X8,
    overhang: inch(12),
    rakeOverhang: inch(12),
    ties: { kind: 'rafter-ties', stock: S2X4, every: 2, height: inch(24) },
    gableStuds: { stock: S2X4, spacing: inch(16) },
  },
};
const ROOF = frameRoof(ROOF_INPUT);
const FRAMINGS = [A, B, C, D, FLOOR, ROOF];
const MEMBERS = FRAMINGS.flatMap((f) => f.members);

// Sheet faces. Wall sheathing covers each wall's framed height (97-1/8") along its outside face:
// 192" on the 16' walls, 144" on the 12' walls (the 7/16" lap at the corners is left out), whose
// openings move 3-1/2" along (their framing starts inside the 16' walls). The 12' walls are the
// gable ends: their faces rise 72 x 6/12 = 36" more to a point at the middle.
const sheathing = (
  id: string,
  lengthIn: number,
  more: Partial<Parameters<typeof wallFace>[0]> = {},
) =>
  wallFace({
    id: `${id}:sheathing`,
    owner: id,
    layer: 'sheathing',
    stock: OSB,
    length: inch(lengthIn),
    height: PRECUT_WALL_HEIGHT,
    ...more,
  });
const FACES: SheetFace[] = [
  sheathing('extension#3', 192, {
    openings: [48, 144].map((at) => ({
      position: inch(at),
      width: inch(24),
      height: inch(36),
      sill: inch(44),
    })),
  }),
  sheathing('extension#4', 144, {
    gableRise: inch(36),
    openings: [{ position: inch(72), width: inch(36), height: inch(80), sill: 0 }],
  }),
  sheathing('extension#5', 192),
  sheathing('extension#6', 144, { gableRise: inch(36) }),
  subfloorFace('extension#2', FLOOR.subfloor!, [1, 0]),
  ...roofSheathingFaces(ROOF_INPUT, OSB),
];

/** Fixed prices for the cost check. */
const PRICES: StockData = {
  stored: new Map(),
  overrides: new Map(
    (
      [
        ['us-2x4-precut-92-5-8', 4.5, 'piece'],
        ['us-2x4', 0.75, 'foot'],
        ['us-2x6', 1.1, 'foot'],
        ['us-2x8', 1.5, 'foot'],
        ['us-4x6', 2.5, 'foot'],
        [OSB, 16, 'sheet'],
        ['us-osb-23-32', 38, 'sheet'],
      ] as const
    ).map(([id, amount, per]) => [id, { price: { amount, per, currency: 'USD' } }]),
  ),
};

const takeoff = () =>
  constructionTakeoff({
    members: MEMBERS,
    faces: FACES,
    stock: PRICES,
    levels: Object.fromEntries(
      [...new Set([...MEMBERS.map((m) => m.owner), ...FACES.map((f) => f.owner)])].map((id) => [
        id,
        'level-1',
      ]),
    ),
  });

const feetOrInches = (inches: number) =>
  Number.isInteger(inches / 12) ? `${inches / 12}'` : `${inches}"`;

/** Bought rows as `stock length: quantity` (sheets with no length). */
function bought(rows: readonly ConstructionRow[], category: 'lumber' | 'sheet'): string[] {
  return rows
    .filter((r) => r.category === category)
    .map((r) =>
      category === 'sheet'
        ? `${r.stock}: ${r.quantity}`
        : `${r.stock} ${feetOrInches(toInches(r.size!.length!))}: ${r.quantity}`,
    );
}

describe('the 12 x 16 ft shed: framing as the generators give it', () => {
  it('frames the members the hand count expects', () => {
    expect(FRAMINGS.map((f) => f.warnings.length)).toEqual([0, 0, 0, 0, 0, 0]);
    // A, 16' through, two windows. Layout slots 0 to 12 (192 / 16 + 1 = 13); each window's
    // framing (kings outside jacks outside the 24" rough opening: 33" to 63" and 129" to 159")
    // removes the slot at 48" and at 144": 11 studs. Two corner studs (one per L). Per window
    // 2 kings and 2 jacks (sill 0 + head 80" less the 1-1/2" plate: 78-1/2"), 2 header plies of
    // 24 + 2 x 1.5 = 27", a rough sill of 24", and on the 48" slot one cripple above the header
    // (94-1/8" plate underside less 85-1/2" header top: 8-5/8") and one below the rough sill
    // (42-1/2" less 1-1/2": 41"). Plates: bottom 192, top 192, cap 192 - 2 x 3.5 = 185 (it stops
    // short so the butting walls' caps lap over).
    expect(countByRole(A.members)).toEqual({
      'bottom-plate': 1,
      corner: 2,
      cripple: 4,
      header: 4,
      jack: 4,
      king: 4,
      'rough-sill': 2,
      stud: 11,
      'top-plate': 2,
    });
    // B, 137" butting, the door: slots 0 (flush), 16" to 128", and the flush end stud: 10. The
    // door's framing (rough opening 50-1/2" to 86-1/2", jacks and kings to 47-1/2" and 89-1/2")
    // removes the slots at 48", 64" and 80": 7 studs. 2 kings, 2 jacks of 78-1/2", 2 plies of
    // 36 + 3 = 39", cripples above on the 64" and 80" slots (the 48" one is outside the header's
    // 49" to 88"): 2 of 8-5/8". Bottom plate in two pieces of (137 - 36) / 2 = 50-1/2"; top 137,
    // cap 137 + 2 x 3.5 = 144.
    expect(countByRole(B.members)).toEqual({
      'bottom-plate': 2,
      cripple: 2,
      header: 2,
      jack: 2,
      king: 2,
      stud: 7,
      'top-plate': 2,
    });
    expect(countByRole(C.members)).toEqual({
      'bottom-plate': 1,
      corner: 2,
      stud: 13,
      'top-plate': 2,
    });
    expect(countByRole(D.members)).toEqual({ 'bottom-plate': 1, stud: 10, 'top-plate': 2 });
    // Floor: 13 joists of 144 - 2 x 1.5 = 141" between two 192" rims; three 192" skids.
    expect(countByRole(FLOOR.members)).toEqual({ joist: 13, rim: 2, skid: 3 });
    // Roof: 13 pairs of commons (slots 0 to 12 on each eave), 4 fly rafters (the 12" rakes), the
    // ridge 216" in two pieces (188 + 28, spliced at a rafter centre within 16'), rafter ties on
    // interior pairs 1, 3, ..., 11 (6), and gable studs on slots 16" to 128" of each end (8 x 2).
    expect(countByRole(ROOF.members)).toEqual({
      'common-rafter': 26,
      'fly-rafter': 4,
      'gable-stud': 16,
      'rafter-tie': 6,
      ridge: 2,
    });
  });
});

describe('the 12 x 16 ft shed: the takeoff', () => {
  const t = takeoff();

  it('buys 51 precut studs and the 1D layout of everything else', () => {
    // Precut 92-5/8" studs: studs, kings and corner studs of 92-5/8".
    //   A 11 + 4 + 2 = 17, B 7 + 2 = 9, C 13 + 2 = 15, D 10: 51.
    //
    // 2x4 to lay out (inches):
    //   plates   192 x 4 (A, C bottom and top), 185 x 2 (A, C caps), 144 x 2 (B, D caps),
    //            137 x 3 (B top, D bottom and top), 50.5 x 2 (B bottom)            = 1938
    //   jacks    78.5 x 6                                                          =  471
    //   sills    24 x 2                                                            =   48
    //   cripples 8.625 x 4, 41 x 2                                                 =  116.5
    //   ties     65.597 x 6 (24" above the plates, they meet the roof (24 - 4.399) / 0.5
    //            = 39.202" in from each wall line: 144 - 2 x 39.202)               =  393.582
    //   gable studs, per end at 16, 32, 48, 64 and mirrored: (centre + 0.75 - 3.5) x 0.5
    //            = 6.625, 14.625, 22.625, 30.625, 4 of each                        =  298
    //   total                                                                      = 3265.082
    // 17 sticks of the longest length, 16', hold at most 17 x 192 = 3264" < 3265.082", so at
    // least 18 sticks. The layout uses 18, each moved to the shortest length that holds it
    // (with a 1/8" kerf between pieces):
    //   16'  192 | 192 | 192 | 192                                           4 sticks
    //   16'  185 + 6.625 (191.75), twice                                    2
    //   16'  78.5 + 78.5 + 8.625 + 24 (190), twice                          2
    //   16'  78.5 + 78.5 + 8.625 + 8.625 + 14.625 (189.375)                 1
    //   16'  41 + 137 + 6.625 + 6.625 (191.625)                             1
    //   16'  50.5 + 50.5 + 41 + 22.625 + 22.625 (187.75)                    1
    //   16'  144 + 3 x 14.625 (188.25)                                      1
    //   16'  144 + 2 x 22.625 (189.5)                                       1
    //   14'  137 + 30.625 (167.75), twice                                   2
    //   14'  2 x 65.597 + 30.625 (162.069), twice                           2
    //   12'  2 x 65.597 (131.319)                                           1
    //   13 x 16', 4 x 14', 1 x 12'.
    //
    // 2x6: rafters (26 commons and 4 flies) all 95.826" blanks: two to a 16' stick (191.777"):
    // 15 sticks. Joists 141": one each, on 12'. Rims 192": a 16' each. Headers 4 x 27 + 2 x 39
    // = 186 + 5 kerfs = 186.625": one 16' (cheaper in length than adding a header to each of 6
    // joists, which would need 16' instead of 12'). 18 x 16' and 13 x 12'.
    //
    // 2x8 ridge: 188" on a 16', 28" on the shortest length sold, an 8'. 4x6 skids: 3 x 16'.
    expect(bought(t.rows, 'lumber')).toEqual([
      "us-2x4 16': 13",
      "us-2x4 14': 4",
      "us-2x4 12': 1",
      'us-2x4-precut-92-5-8 92.625": 51',
      "us-2x6 16': 18",
      "us-2x6 12': 13",
      "us-2x8 16': 1",
      "us-2x8 8': 1",
      "us-4x6 16': 3",
    ]);
    const twoBy4 = t.lumber.find((l) => l.stock === 'us-2x4')!;
    expect(twoBy4.result.sticks).toHaveLength(18);
    expect(twoBy4.result.unplaced).toEqual([]);
    expect(toInches(twoBy4.result.totals.partsLength)).toBeCloseTo(3265.082, 2);
  });

  it('totals the plates in linear feet: 1938 in, 161 ft 6 in', () => {
    const plates = t.rows.find((r) => r.key === 'linear|Plates|us-2x4')!;
    expect([plates.quantity, toInches(plates.extended)]).toEqual([13, 1938]);
  });

  it('buys 25 sheets of 7/16 in OSB and 6 of 23/32 in, from the per-face layouts', () => {
    // Subfloor: 192" across the joists by 144" along them, 96" x 48" sheets across: 2 x 3 = 6.
    //
    // 7/16" OSB, whole sheets first:
    //   A and C (192 x 97-1/8", vertical 48 x 96): 4 whole each, and 4 strips of 48 x 1-1/8"
    //     above them. A's windows (36" to 60", 132" to 156") straddle sheet edges at 48" and
    //     144": four 12" x 36" cut-outs.
    //   B and D (144" with the gable): 3 whole each; above 96" the gable gives 48 x 25-1/8"
    //     (97.125 + 48 x 0.5 = 121.125, less 96) at each end and 48 x 37-1/8" in the middle
    //     (to the apex at 133-1/8"). B's door (54" to 90") lies inside its second sheet: one
    //     36" x 80" cut-out.
    //   Roof planes (216" along the eave by (12 + 72) x 1.118034 = 93.915" up the slope,
    //     horizontal 96 x 48): 2 whole each, a 24 x 48 end, and a second course of
    //     96 x 45.915, 96 x 45.915 and 24 x 45.915.
    //   Whole: 4 + 3 + 4 + 3 + 2 + 2 = 18.
    // Same face: B's 36 x 80 cut-out takes one of its 48 x 25-1/8" pieces (turned).
    // Across faces, no offcut left can hold any piece of 24" or more each way (A's are 12 x 36;
    // what is left of B's cut-out after a 48" length is under 32" long), so those need new
    // sheets: 4 x (96 x 45.915) + 2 x (24 x 48) + 2 x (24 x 45.915) + 2 x (48 x 37.125)
    // + 3 x (48 x 25.125) = 29,321 sq in, more than 6 sheets' 27,648: at least 7. Seven do it:
    // each 96 x 45.915 on its own sheet (4); 37.125 + 25.125 + 25.125 across one (87.625" of
    // 96" with kerfs); 37.125 + 25.125 + a 24 x 48 across another (86.375"); the last 24 x 48
    // and the two 24 x 45.915 side by side on a seventh (72.25"). The eight 1-1/8" strips go on
    // offcuts. 18 + 7 = 25.
    expect(bought(t.rows, 'sheet')).toEqual([`${OSB}: 25`, 'us-osb-23-32: 6']);
    expect(t.sheets.map((s) => [s.stock, s.full, s.packed, s.bought])).toEqual([
      [OSB, 18, 7, 25],
      ['us-osb-23-32', 6, 0, 6],
    ]);
    const b = t.faces.find((f) => f.face === 'extension#4:sheathing')!;
    expect(b.pieces.find((p) => p.id.endsWith('@1.2'))!.from).toBe('offcut');
    expect(b.cutouts.map((c) => [toInches(c.width), toInches(c.height)])).toEqual([[36, 80]]);
  });

  it('costs the shed at fixed prices: $1,708.90', () => {
    // Precuts 51 x $4.50 = $229.50
    // 2x4  (13 x 16 + 4 x 14 + 12) = 276 ft x $0.75 = $207.00
    // 2x6  (18 x 16 + 13 x 12) = 444 ft x $1.10 = $488.40
    // 2x8  (16 + 8) = 24 ft x $1.50 = $36.00
    // 4x6  48 ft x $2.50 = $120.00
    // 7/16" OSB 25 x $16 = $400.00; 23/32" OSB 6 x $38 = $228.00
    expect(t.cost.currency).toBe('USD');
    expect(t.cost.unpriced).toEqual([]);
    expect(t.cost.total).toBeCloseTo(1708.9, 9);
    const totalOf = (category: string) =>
      t.rows.filter((r) => r.category === category).reduce((a, r) => a + (r.cost ?? 0), 0);
    expect(totalOf('lumber')).toBeCloseTo(229.5 + 207 + 488.4 + 36 + 120, 9);
    expect(totalOf('sheet')).toBeCloseTo(628, 9);
  });

  it('subtotals per feature and per level', () => {
    // The door (extension#9) owns its 2 kings, 2 jacks, 2 header plies and 2 cripples: 8.
    const door = t.subtotals.find((s) => s.kind === 'feature' && s.id === 'extension#9')!;
    expect(door.totals.find((x) => x.unit === 'each')!.quantity).toBe(8);
    // Everything is on level 1: all the members (A 34, B 19, C 18, D 13, floor 18, roof 54 =
    // 156, from the role counts above) and the 7 faces as laid.
    const level = t.subtotals.filter((s) => s.kind === 'level');
    expect(level.map((s) => s.id)).toEqual(['level-1']);
    expect(level[0]!.totals.find((x) => x.unit === 'each')!.quantity).toBe(156);
    expect(MEMBERS).toHaveLength(156);
  });

  it('counts as framed only: no estimating row, and no claim about the structure', () => {
    expect(new Set(t.rows.map((r) => r.category))).toEqual(
      new Set(['framing', 'linear', 'faces', 'lumber', 'sheet']),
    );
    for (const r of t.rows) {
      expect(r.item).not.toMatch(/estimate|per foot|rule of thumb/i);
      expect(r.item).not.toMatch(/\b(safe|compliant|OK|adequate|passes)\b/i);
    }
    expect(t.disclaimer).toMatch(/not an engineering tool/i);
  });
});
