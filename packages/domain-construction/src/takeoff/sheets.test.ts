// Hand-computed fixtures for the sheet faces and the sheet producer (M6 plan T6.3a). Inputs and
// expectations in inches; kerf the default 1/8".

import type { StockData } from '@manufakture/stock';
import { describe, expect, it } from 'vitest';
import type { SubfloorReport } from '../framing/floor';
import { S2X6, S2X8, inch, toInches } from '../test-helpers';
import { faceArea, layoutFace, roofSheathingFaces, subfloorFace, wallFace } from './faces';
import { constructionTakeoff } from './takeoff';
import type { FaceLayout, SheetFace, TakeoffMember } from './types';

const OSB = 'us-osb-7-16';
const GYP12 = 'us-gyp-1-2-12ft';
const GYP8 = 'us-gyp-1-2-8ft';
const SHEET_4X8 = { length: inch(96), width: inch(48) };

/** Pieces as `col.row WxH from`, in inches. */
const pieces = (l: FaceLayout) =>
  l.pieces.map((p) => `${p.id.split('@')[1]} ${toInches(p.width)}x${toInches(p.height)} ${p.from}`);

const sheetsOf = (faces: SheetFace[], members: TakeoffMember[] = [], wastePercent = 0) =>
  constructionTakeoff({ members, faces, settings: { wastePercent } });

describe('sheet faces', () => {
  it('lays 4 x 8 sheathing on a 16 x 8 ft wall face with a 36 x 80 in door as 4 sheets, the door cut out', () => {
    // 192" / 48" = 4 columns of vertical sheets, 96" / 96" = 1 row: 4 whole sheets. The door
    // (54" to 90" along, 0 to 80" up) lies inside the second sheet (48" to 96"); that sheet is
    // still a whole sheet, and the 36" x 80" cut out of it is an offcut.
    const face = wallFace({
      id: 'extension#3:sheathing',
      owner: 'extension#3',
      layer: 'sheathing',
      stock: OSB,
      length: inch(192),
      height: inch(96),
      openings: [{ position: inch(72), width: inch(36), height: inch(80), sill: 0 }],
    });
    const t = sheetsOf([face]);
    expect(pieces(t.faces[0]!)).toEqual([
      '1.1 48x96 sheet',
      '2.1 48x96 sheet',
      '3.1 48x96 sheet',
      '4.1 48x96 sheet',
    ]);
    expect(
      t.faces[0]!.cutouts.map((c) => [toInches(c.x), toInches(c.width), toInches(c.height)]),
    ).toEqual([[54, 36, 80]]);
    const row = t.rows.find((r) => r.category === 'sheet')!;
    expect([row.item, row.quantity, row.unit]).toEqual(['7/16" OSB', 4, 'sheet']);
    expect(t.sheets[0]).toMatchObject({ stock: OSB, full: 4, packed: 0, sheets: 4, bought: 4 });
    // Area as laid: 192 x 96 - 36 x 80 = 15,552 sq in.
    const laid = t.rows.find((r) => r.category === 'faces')!;
    expect(laid.extended / inch(1) ** 2).toBeCloseTo(15552, 6);
    expect(laid.item).toBe('Wall sheathing');
  });

  it('lays 4 x 12 drywall across a 16 x 8 ft face: 2 whole sheets and 1 for the two 4 ft ends', () => {
    // Horizontal 144" x 48" sheets: columns of 144" and 48", rows of 48" and 48". The two
    // 48" x 48" ends are packed onto one new sheet: 48 + 1/8 + 48 = 96.125" of its 144".
    const face = wallFace({
      id: 'extension#3:drywall',
      owner: 'extension#3',
      layer: 'drywall',
      stock: GYP12,
      length: inch(192),
      height: inch(96),
    });
    const t = sheetsOf([face]);
    expect(pieces(t.faces[0]!)).toEqual([
      '1.1 144x48 sheet',
      '2.1 48x48 new',
      '1.2 144x48 sheet',
      '2.2 48x48 new',
    ]);
    expect(t.rows.find((r) => r.category === 'sheet')!.quantity).toBe(3);
    expect(t.rows.find((r) => r.category === 'faces')!.item).toBe('Drywall');
  });

  it('reuses a cut-out on the same face before opening a sheet', () => {
    // 168" x 96" of drywall in 4 x 8 sheets laid horizontally: columns 96" and 72", rows 48"
    // and 48": 2 whole sheets and two 72" x 48" ends. A 72" x 48" pass-through at 12" to 84",
    // 0 to 48" leaves the first sheet whole (its bounding box) with a 72" x 48" cut-out; one end
    // is cut from that, the other needs a new sheet: 3 sheets. With no opening, the two ends
    // (72 + 1/8 + 72 > 96) need a new sheet each: 4.
    const face = (holes: boolean): SheetFace => ({
      id: 'extension#3:drywall',
      owner: 'extension#3',
      layer: 'drywall',
      stock: GYP8,
      width: inch(168),
      height: inch(96),
      ...(holes ? { holes: [{ x: inch(12), y: 0, width: inch(72), height: inch(48) }] } : {}),
    });
    const t = sheetsOf([face(true)]);
    expect(pieces(t.faces[0]!)).toEqual([
      '1.1 96x48 sheet',
      '2.1 72x48 offcut',
      '1.2 96x48 sheet',
      '2.2 72x48 new',
    ]);
    expect(t.sheets[0]).toMatchObject({ full: 2, packed: 1, bought: 3 });
    expect(sheetsOf([face(false)]).sheets[0]).toMatchObject({ full: 2, packed: 2, bought: 4 });
  });

  it('packs partial pieces across faces: two 10 ft faces share one sheet for their ends', () => {
    // Each 120" x 48" face: one 96" x 48" sheet and a 24" x 48" end. The two ends take
    // 24 + 1/8 + 24 = 48.125" of one sheet: 3 sheets, not 4.
    const face = (n: number): SheetFace => ({
      id: `extension#${n}:drywall`,
      owner: `extension#${n}`,
      layer: 'drywall',
      stock: GYP8,
      width: inch(120),
      height: inch(48),
    });
    const t = sheetsOf([face(3), face(4)]);
    expect(t.sheets[0]).toMatchObject({ full: 2, packed: 1, bought: 3 });
    expect(t.rows.find((r) => r.category === 'sheet')!.sources).toEqual([
      { id: 'extension#3:drywall', quantity: 2 },
      { id: 'extension#4:drywall', quantity: 2 },
    ]);
  });

  it('adds the waste percentage and rounds up', () => {
    // 4 sheets plus 10 % = 4.4: 5.
    const face = wallFace({
      id: 'w:s',
      owner: 'extension#3',
      layer: 'sheathing',
      stock: OSB,
      length: inch(192),
      height: inch(96),
    });
    const t = sheetsOf([face], [], 10);
    const row = t.rows.find((r) => r.category === 'sheet')!;
    expect([row.quantity, row.flags]).toEqual([5, ['no-price', 'waste-added']]);
    expect(t.sheets[0]).toMatchObject({ sheets: 4, bought: 5 });
  });

  it('cuts a header spacer from the sheet stock with the faces', () => {
    // A 1/2" plywood spacer 39" x 7-1/4" and a 96" x 48" face of the same plywood: the face is
    // one whole sheet, the spacer needs a sheet of its own.
    const spacer: TakeoffMember = {
      id: 'spacer',
      owner: 'extension#7',
      role: 'header-spacer',
      stock: { id: 'us-ply-15-32', name: '1/2" plywood', width: inch(0.5), depth: inch(7.25) },
      length: inch(39),
    };
    const face: SheetFace = {
      id: 'f',
      owner: 'extension#3',
      layer: 'sheathing',
      stock: 'us-ply-15-32',
      width: inch(48),
      height: inch(96),
    };
    const t = sheetsOf([face], [spacer]);
    expect(t.sheets[0]).toMatchObject({ full: 1, packed: 1, bought: 2 });
    expect(t.rows.find((r) => r.category === 'framing')!.item).toBe('Header spacer');
  });

  it('prices sheets per sheet', () => {
    const stock: StockData = {
      stored: new Map(),
      overrides: new Map([[OSB, { price: { amount: 15.5, per: 'sheet' } }]]),
    };
    const face = wallFace({
      id: 'w:s',
      owner: 'extension#3',
      layer: 'sheathing',
      stock: OSB,
      length: inch(192),
      height: inch(96),
    });
    const t = constructionTakeoff({ members: [], faces: [face], stock });
    expect(t.cost.total).toBe(62);
    expect(t.cost.currency).toBeUndefined();
    const perFoot: StockData = {
      stored: new Map(),
      overrides: new Map([[OSB, { price: { amount: 1, per: 'foot' } }]]),
    };
    expect(
      constructionTakeoff({ members: [], faces: [face], stock: perFoot }).rows.find(
        (r) => r.category === 'sheet',
      )!.flags,
    ).toEqual(['price-unit']);
  });
  it('lists a face of a sheet stock the catalog lacks as unpriced, and buys none of it', () => {
    const face = wallFace({
      id: 'extension#3:sheathing',
      owner: 'extension#3',
      layer: 'sheathing',
      stock: 'us-osb-9-99',
      length: inch(96),
      height: inch(96),
    });
    const t = sheetsOf([face]);
    expect(t.rows.map((r) => [r.category, r.flags])).toEqual([['faces', ['stock-unknown']]]);
    expect(t.cost.unpriced).toEqual(['faces|us-osb-9-99|sheathing']);
  });
});

describe('faces from the model', () => {
  it('builds a gable end face and lays its triangle as rectangles to the slope', () => {
    // A 144" x 96" wall with a gable rising 36" to its middle: 3 whole sheets of 48" x 96", then
    // one piece per column above them, each the bounding box of the gable inside that column.
    const face = wallFace({
      id: 'g',
      owner: 'extension#4',
      layer: 'sheathing',
      stock: OSB,
      length: inch(144),
      height: inch(96),
      gableRise: inch(36),
    });
    // Area: 144 x 96 + 144 x 36 / 2 = 13,824 + 2,592 = 16,416 sq in.
    expect(faceArea(face) / inch(1) ** 2).toBeCloseTo(16416, 6);
    // Above 96": the slope rises 36 / 72 = 0.5 per inch, so the end columns reach 24" up, the
    // middle one (48" to 96", under the apex) 36".
    expect(pieces(layoutFace(face, SHEET_4X8))).toEqual([
      '1.1 48x96 sheet',
      '2.1 48x96 sheet',
      '3.1 48x96 sheet',
      '1.2 48x24 new',
      '2.2 48x36 new',
      '3.2 48x24 new',
    ]);
  });

  it('lays from the end corner when asked', () => {
    const face: SheetFace = {
      id: 'f',
      owner: 'extension#3',
      layer: 'drywall',
      stock: GYP8,
      width: inch(120),
      height: inch(48),
      from: 'end',
    };
    expect(
      layoutFace(face, SHEET_4X8).pieces.map((p) => [toInches(p.x), toInches(p.width)]),
    ).toEqual([
      [24, 96],
      [0, 24],
    ]);
  });

  it('turns an L-shaped subfloor into its box less the missing corner, sheets across the joists', () => {
    // An L: 144" x 192" less 48" x 96" at one corner; joists span x. The face's x runs across
    // the joists (plan y), its y along them (plan x).
    const report: SubfloorReport = {
      stock: { id: 'us-osb-23-32', name: '3/4" OSB', width: inch(23 / 32), depth: inch(48) },
      outline: [
        [0, 0],
        [inch(96), 0],
        [inch(96), inch(96)],
        [inch(144), inch(96)],
        [inch(144), inch(192)],
        [0, inch(192)],
      ],
      area: inch(144) * inch(192) - inch(48) * inch(96),
      z: [0, inch(23 / 32)],
    };
    const face = subfloorFace('extension#2', report, [1, 0]);
    expect([toInches(face.width), toInches(face.height)]).toEqual([192, 144]);
    expect(
      face.holes!.map((h) => [toInches(h.x), toInches(h.y), toInches(h.width), toInches(h.height)]),
    ).toEqual([[0, 96, 96, 48]]);
    expect(faceArea(face)).toBeCloseTo(report.area, 3);
    // 2 x 3 sheets of 96" x 48" less the one where the corner is missing: 5.
    expect(layoutFace(face, SHEET_4X8).pieces.map((p) => p.id.split('@')[1])).toEqual([
      '1.1',
      '2.1',
      '1.2',
      '2.2',
      '2.3',
    ]);
  });

  it('gives a 6/12 gable roof two rectangles and a hip roof two trapezoids and two triangles', () => {
    // Slope: (12" overhang + 72" half span) x sqrt(12^2 + 6^2) / 12 = 84 x 1.118034 = 93.915".
    const input = {
      roof: 'extension#10',
      kind: 'gable' as const,
      pitch: Math.atan(0.5),
      footprint: {
        origin: [0, 0] as const,
        length: inch(192),
        width: inch(144),
        plate: inch(97.125),
        wallThickness: inch(3.5),
      },
      settings: { rafterStock: S2X6, ridgeStock: S2X8, rakeOverhang: inch(12) },
    };
    const gable = roofSheathingFaces(input, OSB);
    expect(gable.map((f) => [f.id, toInches(f.width), toInches(f.height), f.outline])).toEqual([
      ['extension#10:sheathing:e1', 216, 93.915, undefined],
      ['extension#10:sheathing:e3', 216, 93.915, undefined],
    ]);
    // Hip: eaves 192 + 24 = 216" with a 192 - 144 = 48" ridge; ends 144 + 24 = 168", to a point.
    const hip = roofSheathingFaces(
      { ...input, kind: 'hip', settings: { ...input.settings, hipStock: S2X8 } },
      OSB,
    );
    expect(
      hip.map((f) => [
        f.id.split(':').at(-1),
        toInches(f.width),
        f.outline!.map((p) => toInches(p[0])),
      ]),
    ).toEqual([
      ['e1', 216, [0, 216, 132, 84]],
      ['e2', 168, [0, 168, 84]],
      ['e3', 216, [0, 216, 132, 84]],
      ['e4', 168, [0, 168, 84]],
    ]);
    // Areas: (216 + 48) / 2 x 93.915 and 168 / 2 x 93.915; the four add to the plan area with
    // overhangs (216 x 168) times the slope factor.
    const total = hip.reduce((a, f) => a + faceArea(f), 0) / inch(1) ** 2;
    expect(total).toBeCloseTo((216 * 168 * Math.sqrt(180)) / 12, 3);
  });
});
