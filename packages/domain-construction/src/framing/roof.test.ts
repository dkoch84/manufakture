// Hand-computed fixtures for the roof framing generator (M6 plan, T6.2c acceptance). Inputs and
// expectations are in inches; the generator works in millimetres. The hand math follows the M6
// plan, Part 1, "Roof pitch math"; each derivation is written next to the numbers it checks.
//
// Shared numbers at 6/12: tan = 6/12 = 0.5; the rafter's length per unit of run (the common
// factor) is sqrt(12^2 + 6^2) / 12 = sqrt(180) / 12 = 1.118034; cos = 12 / sqrt(180) = 0.894427;
// sin = 6 / sqrt(180) = 0.447214.

import { describe, expect, it } from 'vitest';
import { toWorld, zAxis, type Vec3 } from '../geom';
import { countByRole, shapeKey, type Member } from '../members';
import { S2X4, S2X6, S2X8, inch, toInches } from '../test-helpers';
import {
  formatRoofMemberId,
  frameRoof,
  parseRoofMemberId,
  type FrameRoofInput,
  type RoofFraming,
  type RoofMemberId,
  type RoofSettingsInput,
} from './roof';
import { FramingInputError } from './wall';

const ROOF = 'extension#9';
const SIX_TWELVE = Math.atan(6 / 12);
/** 97-1/8" walls on a floor at 0: the top of the top plates. */
const PLATE = inch(97.125);

/** The 12' x 16' shed: 16' along the ridge, a 12' span, 2x4 walls (3-1/2" seat). */
function shed(
  settings: Partial<RoofSettingsInput> = {},
  rest: Partial<FrameRoofInput> = {},
): FrameRoofInput {
  return {
    roof: ROOF,
    kind: 'gable',
    pitch: SIX_TWELVE,
    footprint: {
      origin: [0, 0],
      length: inch(192),
      width: inch(144),
      plate: PLATE,
      wallThickness: inch(3.5),
    },
    settings: { rafterStock: S2X6, ridgeStock: S2X8, ...settings },
    ...rest,
  };
}

function frame(input: FrameRoofInput): RoofFraming & { byId: Map<string, Member> } {
  const r = frameRoof(input);
  return { ...r, byId: new Map(r.members.map((m) => [m.id, m])) };
}

const ids = (ms: readonly Member[], role: string) =>
  ms.filter((m) => m.role === role).map((m) => m.id);

/** Where a member's local plane cut (n with no y part) meets the line at local z = c, as local x. */
function planeX(m: Member, pick: (n: Vec3) => boolean, c: number): number {
  for (const cut of m.cuts) {
    const planes = cut.kind === 'plane' ? [cut] : [cut.a, cut.b];
    for (const p of planes) if (pick(p.n)) return (p.k - p.n[2] * c) / p.n[0];
  }
  throw new Error(`no such cut on ${m.id}`);
}

describe('roof member ids', () => {
  const FORMS: Array<[string, RoofMemberId]> = [
    ['e1:c0', { form: 'common', edge: 1, slot: 0 }],
    ['e3:c12', { form: 'common', edge: 3, slot: 12 }],
    ['e2:ja1', { form: 'jack', edge: 2, end: 'a', n: 1 }],
    ['e1:jb14', { form: 'jack', edge: 1, end: 'b', n: 14 }],
    ['e3:fly-a', { form: 'fly', edge: 3, end: 'a' }],
    ['e4:g0', { form: 'gable-stud', edge: 4, slot: 0 }],
    ['e2:g8', { form: 'gable-stud', edge: 2, slot: 8 }],
    ['e1:sub:1', { form: 'board', edge: 1, board: 'sub', piece: 1 }],
    ['e4:fascia:2', { form: 'board', edge: 4, board: 'fascia', piece: 2 }],
    ['hip3', { form: 'hip', corner: 3 }],
    ['ridge:1', { form: 'ridge', piece: 1 }],
    ['tie0', { form: 'tie', slot: 0 }],
    ['tie11', { form: 'tie', slot: 11 }],
  ];

  it.each(FORMS)('parses and formats %s back to itself', (id, parsed) => {
    expect(parseRoofMemberId(id)).toEqual(parsed);
    expect(formatRoofMemberId(parsed)).toBe(id);
  });

  it('refuses ids of no roof form and non-canonical spellings', () => {
    for (const id of [
      '',
      'e0:c1',
      'e5:c1',
      'e1:c01',
      'e1:c',
      'e1:j1',
      'e1:ja0',
      'e1:ja01',
      'e1:fly',
      'e1:fly-c',
      'e1:sub:0',
      'e1:sub',
      'e1:fascia:01',
      'hip0',
      'hip5',
      'hip',
      'ridge',
      'ridge:0',
      'ridge1',
      'tie01',
      'tie',
      's12',
      'king-l',
      'e1:c1:x',
    ])
      expect(parseRoofMemberId(id), id).toBeUndefined();
  });
});

describe('frameRoof: a 12 ft x 16 ft gable at 6/12', () => {
  it('lays out 13 pairs of common rafters at 16 in on centre and one ridge board', () => {
    const r = frame(shed());
    expect(r.warnings).toEqual([]);
    expect(countByRole(r.members)).toEqual({ 'common-rafter': 26, ridge: 1 });
    // 192 / 16 = 12 spacings: slot 0 flush at u = 0, slots 1 to 11 centred on 16" multiples, slot
    // 12 flush at u = 192 (as the wall's layout), on both eaves.
    const e1 = ids(r.members, 'common-rafter').filter((id) => id.startsWith('e1:'));
    expect(e1).toEqual(Array.from({ length: 13 }, (_, k) => `e1:c${k}`));
    const centre = (m: Member) => toInches(toWorld(m.placement, [0, m.stock.width / 2, 0])[0]);
    expect(e1.map((id) => centre(r.byId.get(id)!))).toEqual([
      0.75, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 191.25,
    ]);
    const ridge = r.byId.get('ridge:1')!;
    expect(toInches(ridge.length)).toBe(192);
  });

  it('gives the common rafter the hand-computed run, line length, height and birdsmouth', () => {
    const r = frame(shed());
    const g = r.geometry;
    // Run: half the 144" span less half the 1-1/2" ridge: 72 - 0.75 = 71.25".
    expect(toInches(g.commonRun)).toBe(71.25);
    // Line length: 71.25 x 1.118034 = 79.660".
    expect(g.commonFactor).toBeCloseTo(1.118034, 6);
    expect(toInches(g.commonLineLength)).toBeCloseTo(79.66, 2);
    // Birdsmouth on a 3-1/2" seat: heel 3.5 x 0.5 = 1.75", depth square to the edge
    // 3.5 x 0.447214 = 1.565" (28 % of the 2x6's 5-1/2").
    expect(toInches(g.birdsmouth.heel)).toBe(1.75);
    expect(toInches(g.birdsmouth.depth)).toBeCloseTo(1.565, 3);
    // Height above plate at the wall line: the plumb depth 5.5 / 0.894427 = 6.149" less the heel
    // 1.75" = 4.399".
    expect(toInches(g.plumbCut)).toBeCloseTo(6.149, 3);
    expect(toInches(g.heightAbovePlate)).toBeCloseTo(4.399, 3);
    // Ridge: run x 6/12 plus the height above plate: 35.625 + 4.399 = 40.024" above the plates.
    expect(toInches(g.ridgeAbovePlate)).toBeCloseTo(40.024, 3);
    expect(toInches(g.ridgeTop)).toBeCloseTo(97.125 + 40.024, 3);
    // Overhang along the rafter: 12 x 1.118034 = 13.416".
    expect(toInches(g.overhangLineLength)).toBeCloseTo(13.416, 3);
  });

  it('cuts every common rafter from one blank with a tail plumb cut, a birdsmouth and a ridge plumb cut', () => {
    const r = frame(shed());
    const commons = r.members.filter((m) => m.role === 'common-rafter');
    // One shape for all 26: the same stock, blank and cuts in their own frame, mirrored by placement
    // only (no mirroring: both eaves' rafters are rotations of each other).
    expect(new Set(commons.map(shapeKey)).size).toBe(1);
    const m = r.byId.get('e1:c4')!;
    // Blank: from the tail's bottom corner to the ridge cut's top corner,
    // (71.25 + 12) x 1.118034 + 5.5 x 0.5 = 93.076 + 2.75 = 95.826".
    expect(toInches(m.length)).toBeCloseTo(95.826, 3);
    expect(m.cuts.map((c) => c.kind).sort()).toEqual(['notch', 'plane', 'plane']);
    // Along the bottom edge (local z = 0), the heel (wall line) to the ridge cut is the line
    // length, 79.660"; along the top edge (z = 5.5") the tail cut to the ridge cut is
    // (71.25 + 12) x 1.118034 = 93.076".
    const heel = (n: Vec3) => n[0] > 0 && n[2] < 0 && Math.abs(n[0] - Math.cos(SIX_TWELVE)) < 1e-9;
    const notch = m.cuts.find((c) => c.kind === 'notch')!;
    expect(notch.kind === 'notch' && heel(notch.a.n)).toBe(true);
    const ridgeCut = (n: Vec3) => heel(n);
    const tailCut = (n: Vec3) => n[0] < 0;
    const planes = m.cuts.filter((c) => c.kind === 'plane');
    const ridgeX = (c: number) => {
      const p = planes.find((q) => q.kind === 'plane' && ridgeCut(q.n))!;
      return p.kind === 'plane' ? (p.k - p.n[2] * c) / p.n[0] : NaN;
    };
    const heelX = notch.kind === 'notch' ? (notch.a.k - notch.a.n[2] * 0) / notch.a.n[0] : NaN;
    expect(toInches(ridgeX(0) - heelX)).toBeCloseTo(79.66, 2);
    expect(toInches(ridgeX(m.stock.depth) - planeX(m, tailCut, m.stock.depth))).toBeCloseTo(
      93.076,
      3,
    );
    // The ridge cut's top corner is at the ridge board's face and its top.
    const top = toWorld(m.placement, [ridgeX(m.stock.depth), 0, m.stock.depth]);
    expect(toInches(top[1])).toBeCloseTo(71.25, 6);
    expect(toInches(top[2])).toBeCloseTo(97.125 + 40.024, 3);
    const ridge = r.byId.get('ridge:1')!;
    expect(toInches(toWorld(ridge.placement, [0, 0, ridge.stock.depth])[2])).toBeCloseTo(
      97.125 + 40.024,
      3,
    );
    // The seat lies on the plates: the bottom edge crosses the plate's top 3-1/2" in from the
    // wall line.
    const seatCorner = toWorld(m.placement, [heelX + inch(3.5) / Math.cos(SIX_TWELVE), 0, 0]);
    expect(toInches(seatCorner[1])).toBeCloseTo(3.5, 6);
    expect(toInches(seatCorner[2])).toBeCloseTo(97.125, 6);
  });

  it('reports no birdsmouth warning for a 2x6 and a rule-of-thumb one for a 2x4', () => {
    // 1.565" against a third of 5-1/2" (1.833"): fine. Against a third of 3-1/2" (1.167"): deeper.
    expect(frame(shed()).warnings).toEqual([]);
    const r = frame(shed({ rafterStock: S2X4 }));
    expect(r.warnings).toHaveLength(1);
    const w = r.warnings[0]!;
    expect(w).toMatchObject({
      code: 'birdsmouth-deep',
      kind: 'rule-of-thumb',
      role: 'common-rafter',
    });
    expect(w.message).toMatch(/^Rule of thumb:/);
    expect(toInches(w.value!)).toBeCloseTo(1.565, 3);
    expect(toInches(w.limit!)).toBeCloseTo(1.167, 3);
  });

  it('warns, as a rule of thumb, when the ridge board is shallower than the plumb cut', () => {
    // A 2x6 ridge (5-1/2") against the 2x6 rafter's 6.149" plumb cut.
    const r = frame(shed({ ridgeStock: S2X6 }));
    expect(r.warnings.map((w) => [w.code, w.kind])).toEqual([['ridge-shallow', 'rule-of-thumb']]);
    expect(toInches(r.warnings[0]!.limit!)).toBeCloseTo(6.149, 3);
  });

  it('warns below 3/12 with no ties, and not once ties are on', () => {
    const low = { pitch: Math.atan(2 / 12) };
    const r = frame(shed({}, low));
    expect(r.warnings.map((w) => [w.code, w.kind])).toEqual([
      ['low-slope-no-ties', 'rule-of-thumb'],
    ]);
    expect(r.warnings[0]!.message).toMatch(/^Rule of thumb:.*ridge beam/);
    const tied = frame(shed({ ties: { kind: 'ceiling-joists', stock: S2X4, every: 1 } }, low));
    expect(tied.warnings).toEqual([]);
    // At exactly 3/12 there is no warning.
    expect(frame(shed({}, { pitch: Math.atan(3 / 12) })).warnings).toEqual([]);
  });

  it('never calls the framing safe, compliant or OK', () => {
    const all = [
      frame(shed({ rafterStock: S2X4, ridgeStock: S2X4 }, { pitch: Math.atan(2 / 12) })),
      frame(hipShed({ hipStock: S2X8 })),
    ].flatMap((r) => r.warnings.map((w) => w.message));
    expect(all.length).toBeGreaterThan(2);
    for (const m of all) expect(m).not.toMatch(/\b(safe|compliant|OK|passes|adequate)\b/i);
  });
});

describe('frameRoof: gable options', () => {
  it('cuts square tails with the outermost corner at the overhang', () => {
    const r = frame(shed({ tail: 'square' }));
    const m = r.byId.get('e1:c4')!;
    expect(m.cuts.map((c) => c.kind).sort()).toEqual(['notch', 'plane']);
    // The square end's top corner is 12" out; its bottom corner 5.5 x 0.447214 = 2.460" further in.
    const topCorner = toWorld(m.placement, [0, 0, m.stock.depth]);
    const bottomCorner = toWorld(m.placement, [0, 0, 0]);
    expect(toInches(topCorner[1])).toBeCloseTo(-12, 6);
    expect(toInches(bottomCorner[1])).toBeCloseTo(-12 + 2.46, 2);
    // Blank: (71.25 + 12 - 2.460) x 1.118034 + 2.75 = 93.076 - 2.75 + 2.75 = 93.076".
    expect(toInches(m.length)).toBeCloseTo(93.076, 3);
  });

  it('adds fly rafters at a rake overhang and splices the ridge at a rafter centre', () => {
    const r = frame(shed({ rakeOverhang: inch(12) }));
    expect(countByRole(r.members)).toEqual({ 'common-rafter': 26, 'fly-rafter': 4, ridge: 2 });
    // Fly rafters: outer face 12" past each gable end, no birdsmouth (no wall under them).
    const fly = r.byId.get('e1:fly-a')!;
    expect(fly.cuts.map((c) => c.kind).sort()).toEqual(['plane', 'plane']);
    const centre = toWorld(fly.placement, [0, fly.stock.width / 2, 0]);
    expect(toInches(centre[0])).toBe(-11.25);
    // The ridge runs 216" (-12 to 204), more than the 16' stock: the splice falls at the farthest
    // rafter centre within 192" of its start, u = 176 (188" from -12), leaving 28".
    expect(toInches(r.byId.get('ridge:1')!.length)).toBe(188);
    expect(toInches(r.byId.get('ridge:2')!.length)).toBe(28);
  });

  it('refuses a rake overhang narrower than a rafter', () => {
    expect(() => frameRoof(shed({ rakeOverhang: inch(1) }))).toThrow(FramingInputError);
  });

  it('puts rafter ties beside every other interior pair, cut to the roof at their ends', () => {
    const r = frame(
      shed({ ties: { kind: 'rafter-ties', stock: S2X4, every: 2, height: inch(24) } }),
    );
    expect(r.warnings).toEqual([]);
    // Interior slots 1 to 11 (slots 0 and 12 stand over the gable walls); every other one from the
    // first: 1, 3, 5, 7, 9, 11.
    expect(ids(r.members, 'rafter-tie')).toEqual(['tie1', 'tie3', 'tie5', 'tie7', 'tie9', 'tie11']);
    const tie = r.byId.get('tie3')!;
    // Its underside 24" above the plates meets the roof's top plane (4.399" above the plates at the
    // wall line, rising 0.5 per inch) at (24 - 4.399) / 0.5 = 39.202" from each wall line:
    // 144 - 2 x 39.202 = 65.597" long, with both upper ends cut to the roof.
    expect(toInches(tie.length)).toBeCloseTo(65.597, 3);
    expect(tie.cuts).toHaveLength(2);
    // Beside the rafter on the side towards the middle: slot 3 at 48" puts it at 48.75 to 50.25";
    // slot 7 at 112" (past the middle) at 109.75 to 111.25".
    const uOf = (m: Member) => [
      toInches(toWorld(m.placement, [0, m.stock.width, 0])[0]),
      toInches(toWorld(m.placement, [0, 0, 0])[0]),
    ];
    expect(uOf(tie)).toEqual([48.75, 50.25]);
    expect(uOf(r.byId.get('tie7')!)).toEqual([109.75, 111.25]);
    const z = toWorld(tie.placement, [0, 0, 0])[2];
    expect(toInches(z)).toBeCloseTo(97.125 + 24, 6);
  });

  it('puts ceiling joists on the plates, wall line to wall line, ends cut where they rise above the roof', () => {
    const r = frame(shed({ ties: { kind: 'ceiling-joists', stock: S2X6, every: 1 } }));
    expect(ids(r.members, 'ceiling-joist')).toHaveLength(11);
    const j = r.byId.get('tie1')!;
    expect(toInches(j.length)).toBe(144);
    // 5-1/2" deep against the roof's 4.399" at the wall line: both ends cut.
    expect(j.cuts).toHaveLength(2);
    // A 2x4 joist (3-1/2") stays below the roof's top plane: no cuts.
    const low = frame(shed({ ties: { kind: 'ceiling-joists', stock: S2X4, every: 1 } }));
    expect(low.byId.get('tie1')!.cuts).toEqual([]);
  });

  it('refuses ties that would reach the ridge', () => {
    expect(() =>
      frameRoof(shed({ ties: { kind: 'rafter-ties', stock: S2X4, every: 1, height: inch(30) } })),
    ).toThrow(FramingInputError);
  });

  it('frames gable studs on the gable walls, cut to the end rafters', () => {
    const r = frame(shed({ gableStuds: { stock: S2X4, spacing: inch(16) } }));
    // Layout positions 16" to 128" on each end (8 each); none at 0 or 144", where the roof meets
    // the plates.
    expect(ids(r.members, 'gable-stud')).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `e4:g${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `e2:g${i + 1}`),
    ]);
    // The stud centred at 64" spans v = 63.25 to 64.75; the end rafter's underside rises from the
    // plates at the seat's inside edge (v = 3.5) at 0.5 per inch: (63.25 - 3.5) x 0.5 = 29.875"
    // on its low side and (64.75 - 3.5) x 0.5 = 30.625" on its high side, the blank.
    const g4 = r.byId.get('e4:g4')!;
    expect(toInches(g4.length)).toBeCloseTo(30.625, 6);
    expect(g4.cuts).toHaveLength(1);
    // Each end's stud k is the same shape as the other end's.
    expect(shapeKey(r.byId.get('e2:g4')!)).toBe(shapeKey(g4));
    // Inside the gable wall: e4's from u = 0 to 3-1/2", e2's from 188-1/2" to 192".
    const span = (m: Member) => {
      const a = toWorld(m.placement, [0, 0, 0])[0];
      const b = toWorld(m.placement, [0, 0, m.stock.depth])[0];
      return [toInches(Math.min(a, b)), toInches(Math.max(a, b))];
    };
    expect(span(g4)).toEqual([0, 3.5]);
    expect(span(r.byId.get('e2:g4')!)).toEqual([188.5, 192]);
  });

  it('cuts a gable stud under the ridge flat at the ridge board', () => {
    // An origin of 8" puts a stud centred on the ridge at 72". The 2x8 ridge's underside is
    // 40.024 - 7.25 = 32.774" above the plates, below the rafters' underside there
    // ((71.25 - 3.5) x 0.5 = 33.875"), so the stud stops at the ridge.
    const r = frame(
      shed({ gableStuds: { stock: S2X4, spacing: inch(16), origin: { e4: inch(8) } } }),
    );
    const s = r.byId.get('e4:g5')!;
    expect(toInches(toWorld(s.placement, [0, s.stock.width / 2, 0])[1])).toBe(72);
    expect(toInches(s.length)).toBeCloseTo(32.774, 3);
  });

  it('adds a sub-fascia and fascia on the tails, tops flush with the rafter tails', () => {
    const r = frame(shed({ subFascia: S2X6, fascia: S2X6 }));
    expect(ids(r.members, 'sub-fascia')).toEqual(['e1:sub:1', 'e3:sub:1']);
    expect(ids(r.members, 'fascia')).toEqual(['e1:fascia:1', 'e3:fascia:1']);
    const sub = r.byId.get('e1:sub:1')!;
    expect(toInches(sub.length)).toBe(192);
    // Inner face on the tails at v = -12, outer at -13.5; the fascia from -13.5 to -15.
    const vs = (m: Member) =>
      [toWorld(m.placement, [0, 0, 0])[1], toWorld(m.placement, [0, m.stock.width, 0])[1]]
        .map(toInches)
        .sort((a, b) => a - b);
    expect(vs(sub)).toEqual([-13.5, -12]);
    expect(vs(r.byId.get('e1:fascia:1')!)).toEqual([-15, -13.5]);
    expect(vs(r.byId.get('e3:sub:1')!)).toEqual([156, 157.5]);
    // Top: the rafter's top at the tail, 4.399 - 12 x 0.5 = -1.601" below the plates' top.
    expect(toInches(toWorld(sub.placement, [0, 0, sub.stock.depth])[2])).toBeCloseTo(
      97.125 - 1.601,
      3,
    );
  });

  it('refuses a fascia on square tails', () => {
    expect(() => frameRoof(shed({ tail: 'square', fascia: S2X6 }))).toThrow(FramingInputError);
  });

  it('applies overrides by local id and reports lost ones', () => {
    const r = frame(
      shed(
        {},
        {
          overrides: [
            { id: 'e1:c3', delete: true },
            { id: 'e3:c5', stock: S2X8 },
            { id: 'e1:c4', move: inch(2) },
            { id: 'e1:c99', delete: true },
          ],
        },
      ),
    );
    expect(r.byId.has('e1:c3')).toBe(false);
    expect(r.byId.get('e3:c5')!.stock).toEqual(S2X8);
    const c4 = r.byId.get('e1:c4')!;
    expect(toInches(toWorld(c4.placement, [0, c4.stock.width / 2, 0])[0])).toBe(66);
    expect(r.overrides.map((o) => o.status)).toEqual(['applied', 'applied', 'applied', 'lost']);
    expect(r.warnings.map((w) => [w.code, w.member])).toEqual([
      ['override-lost', `${ROOF}:e1:c99`],
    ]);
  });

  it('places the roof by the footprint origin and direction as one rigid motion', () => {
    const a = frame(shed());
    const angle = 0.6;
    const b = frame(
      shed(
        {},
        { footprint: { ...shed().footprint, origin: [inch(100), inch(-50)], direction: angle } },
      ),
    );
    expect(b.members.map((m) => m.id)).toEqual(a.members.map((m) => m.id));
    for (const m of a.members) {
      const n = b.byId.get(m.id)!;
      expect(shapeKey(n)).toBe(shapeKey(m));
      const p = toWorld(m.placement, [m.length, 0, 0]);
      const q = toWorld(n.placement, [n.length, 0, 0]);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      expect(q[0]).toBeCloseTo(c * p[0] - s * p[1] + inch(100), 6);
      expect(q[1]).toBeCloseTo(s * p[0] + c * p[1] - inch(50), 6);
      expect(q[2]).toBeCloseTo(p[2], 6);
    }
  });

  it('refuses input it cannot frame', () => {
    const bad: Array<FrameRoofInput> = [
      shed({}, { roof: 'roof' }),
      shed({}, { pitch: 0 }),
      shed({}, { pitch: Math.PI / 2 }),
      shed({}, { footprint: { ...shed().footprint, width: 0 } }),
      shed({}, { footprint: { ...shed().footprint, wallThickness: 0 } }),
      shed({ spacing: inch(1) }),
      shed({ overhang: -1 }),
      shed({ ties: { kind: 'ceiling-joists', stock: S2X4, every: 0 } }),
      shed({}, { kind: 'hip' }),
    ];
    for (const input of bad) expect(() => frameRoof(input)).toThrow(FramingInputError);
  });
});

/** The shed as a hip roof: 16' x 12', 2x6 commons and jacks, 2x8 ridge. */
function hipShed(settings: Partial<RoofSettingsInput> = {}): FrameRoofInput {
  return shed({ hipStock: S2X6, ...settings }, { kind: 'hip' });
}

describe('frameRoof: a 16 ft x 12 ft hip roof at 6/12', () => {
  it('lays out commons, jacks and hips', () => {
    const r = frame(hipShed());
    expect(r.warnings).toEqual([]);
    // Long sides: commons at the ridge ends (u = 72 and 120) and on layout between (88, 104): 4
    // each. Ends: one king common at v = 72. Jacks on layout from the ridge-end commons out to the
    // corners, 16" apart: 56, 40, 24, 8 towards each corner, 4 per end of every edge: 8 x 4 = 32.
    expect(countByRole(r.members)).toEqual({
      'common-rafter': 10,
      'hip-rafter': 4,
      'jack-rafter': 32,
      ridge: 1,
    });
    expect(ids(r.members, 'jack-rafter').filter((id) => id.startsWith('e1:'))).toEqual([
      'e1:ja1',
      'e1:ja2',
      'e1:ja3',
      'e1:ja4',
      'e1:jb1',
      'e1:jb2',
      'e1:jb3',
      'e1:jb4',
    ]);
    expect(ids(r.members, 'hip-rafter')).toEqual(['hip1', 'hip2', 'hip3', 'hip4']);
    // Ridge: 192 - 144 = 48" between the hips' theoretical ends, plus one ridge thickness so the
    // king commons have the same 71.25" run as the side commons: 49.5", from u = 71.25.
    const ridge = r.byId.get('ridge:1')!;
    expect(toInches(ridge.length)).toBe(49.5);
    expect(toInches(ridge.placement.origin[0])).toBe(71.25);
  });

  it('gives the hip the hand-computed factor, run, line length and drop', () => {
    const g = frame(hipShed()).geometry;
    // The hip runs 45 degrees in plan: 12 x sqrt(2) = 16.97 of run per 12 of common run. At 6/12
    // its length factor is sqrt(16.97^2 + 6^2) / 12 = sqrt(288 + 36) / 12 = 18 / 12 = 1.5, and its
    // angle atan(6 / 16.97) = 19.47 degrees.
    expect(g.hip!.factor).toBeCloseTo(1.5, 9);
    expect((g.hip!.angle * 180) / Math.PI).toBeCloseTo(19.47, 2);
    // Run: the common run along the diagonal, 71.25 x sqrt(2) = 100.763"; line length
    // 71.25 x 1.5 = 106.875".
    expect(toInches(g.hip!.run)).toBeCloseTo(100.763, 3);
    expect(toInches(g.hip!.lineLength)).toBeCloseTo(106.875, 3);
    // Drop: half the hip's 1-1/2" width, off the hip line, is 0.75 / sqrt(2) = 0.530" of common
    // run, where the roof plane is 0.530 x 0.5 = 0.265" lower.
    expect(toInches(g.hip!.drop)).toBeCloseTo(0.265, 3);
    // Jacks shorten by 16 x 1.118034 = 17.889" per space.
    expect(toInches(g.jackStep!)).toBeCloseTo(17.889, 3);
  });

  it('shortens each jack by 17.89 in, with 45 degree side cuts against the hip', () => {
    const r = frame(hipShed());
    const lengths = ['e1:ja1', 'e1:ja2', 'e1:ja3', 'e1:ja4'].map((id) => r.byId.get(id)!.length);
    for (let i = 1; i < lengths.length; i++)
      expect(toInches(lengths[i - 1]! - lengths[i]!)).toBeCloseTo(17.889, 3);
    // Jack 1 is centred at u = 56. Its centre line meets the hip's face 0.75 x sqrt(2) = 1.061"
    // short of the hip line, so its run is 56 - 1.061 = 54.939"; its far side (u = 56.75) reaches
    // 55.689". Blank: (55.689 + 12) x 1.118034 + 2.75 = 75.679 + 2.75 = 78.429".
    expect(toInches(lengths[0]!)).toBeCloseTo(78.429, 3);
    // Jacks pair across the hip: e1's jack 1 and e4's jack 1 meet the hip at the same point, and
    // jacks on opposite sides of a hip are mirror shapes, so their keys differ.
    const ja = r.byId.get('e1:ja1')!;
    const jb = r.byId.get('e1:jb1')!;
    expect(ja.length).toBeCloseTo(jb.length, 9);
    expect(shapeKey(ja)).not.toBe(shapeKey(jb));
    expect(shapeKey(r.byId.get('e4:jb1')!)).toBe(shapeKey(ja));
    // The side cut is plumb (its world normal is level) and at 45 degrees in plan.
    const side = ja.cuts.find((c) => c.kind === 'plane' && Math.abs(c.n[1]) > 1e-6);
    expect(side?.kind).toBe('plane');
    if (side?.kind === 'plane') {
      const z = zAxis(ja.placement);
      const n = [0, 1, 2].map(
        (i) => side.n[0] * ja.placement.x[i]! + side.n[1] * ja.placement.y[i]! + side.n[2] * z[i]!,
      );
      expect(n[2]).toBeCloseTo(0, 9);
      expect(Math.abs(n[0]!)).toBeCloseTo(Math.abs(n[1]!), 9);
    }
  });

  it('meets every common at the ridge board and seats the hips on the corners', () => {
    const r = frame(hipShed());
    const top = r.geometry.ridgeTop;
    for (const id of ['e1:c0', 'e1:c3', 'e2:c0', 'e4:c0']) {
      const m = r.byId.get(id)!;
      const tip = toWorld(m.placement, [m.length, 0, m.stock.depth]);
      expect(tip[2], id).toBeCloseTo(top, 6);
    }
    // e4's king common stops at the ridge's end face (u = 71.25), e2's at the other (u = 120.75).
    const tipU = (id: string) => {
      const m = r.byId.get(id)!;
      return toInches(toWorld(m.placement, [m.length, 0, m.stock.depth])[0]);
    };
    expect(tipU('e4:c0')).toBeCloseTo(71.25, 6);
    expect(tipU('e2:c0')).toBeCloseTo(120.75, 6);
    // A 2x6 hip: its bottom edge, 5.5 / 0.942809 = 5.834" plumb below its dropped top
    // (4.399 - 0.265 = 4.134" above the plates at the corner), meets the plates
    // (5.834 + 0.265 - 4.399) / 0.353553 = 4.807" in along the diagonal: a birdsmouth
    // 4.807 x 1/3 = 1.602" deep, under a third of 5-1/2".
    expect(toInches(r.geometry.hip!.birdsmouthDepth)).toBeCloseTo(1.602, 3);
    const hip = r.byId.get('hip1')!;
    expect(hip.cuts.filter((c) => c.kind === 'notch')).toHaveLength(1);
  });

  it('warns as a rule of thumb when a deeper hip gets a birdsmouth deeper than a third', () => {
    // A 2x8 hip: (7.25 / 0.942809 + 0.265 - 4.399) / 0.353553 = 10.057" of seat, 3.352" deep
    // against a third of 7-1/4" (2.417").
    const r = frame(hipShed({ hipStock: S2X8 }));
    expect(r.warnings.map((w) => [w.code, w.kind, w.role])).toEqual([
      ['birdsmouth-deep', 'rule-of-thumb', 'hip-rafter'],
    ]);
    expect(toInches(r.warnings[0]!.value!)).toBeCloseTo(3.352, 3);
  });

  it('frames a square footprint as a pyramid around a ridge block', () => {
    // 12' x 12': the ridge ends coincide, so one common on each side meets a ridge block one ridge
    // thickness long; jacks as before, 4 towards each corner on every edge.
    const sq = frame({ ...hipShed(), footprint: { ...hipShed().footprint, length: inch(144) } });
    expect(countByRole(sq.members)).toEqual({
      'common-rafter': 4,
      'hip-rafter': 4,
      'jack-rafter': 32,
      ridge: 1,
    });
    expect(toInches(sq.byId.get('ridge:1')!.length)).toBe(1.5);
  });

  it('frames sub-fascia round all four eaves, the long sides running past the corners', () => {
    const r = frame(hipShed({ subFascia: S2X6 }));
    // Long sides: 192 + 2 x (12 + 1.5) = 219" from u = -13.5, more than the 16' stock: spliced at
    // the farthest rafter centre within 192", e1's jack jb3 at u = 168 (181.5"), leaving 37.5".
    // Ends: 144 + 2 x 12 = 168", butting between the long sides' boards.
    expect(ids(r.members, 'sub-fascia')).toEqual([
      'e1:sub:1',
      'e1:sub:2',
      'e2:sub:1',
      'e3:sub:1',
      'e3:sub:2',
      'e4:sub:1',
    ]);
    const len = (id: string) => toInches(r.byId.get(id)!.length);
    expect([len('e1:sub:1'), len('e1:sub:2'), len('e2:sub:1')]).toEqual([181.5, 37.5, 168]);
  });

  it('refuses a hip roof whose width is more than its length, or that has no hip stock', () => {
    const f = hipShed().footprint;
    expect(() => frameRoof({ ...hipShed(), footprint: { ...f, length: inch(100) } })).toThrow(
      FramingInputError,
    );
    expect(() => frameRoof(shed({}, { kind: 'hip' }))).toThrow(/hip stock/);
  });
});
