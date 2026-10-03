// The takeoff panel's model and files (M6 plan T6.3b): the shed of T6.3a's fixture, as the app
// sees it after a regen (feature metadata and member sets), gives T6.3a's rows to buy and cost;
// the faces come from the metadata as the fixture measures them; the settings form stores
// `domains.construction.takeoff`; the CSV is exact and opens with the short disclaimer.

import { DISCLAIMER_SHORT, constructionTakeoff, frameRoof } from '@manufakture/domain-construction';
import { readStockData, type Json } from '@manufakture/stock';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '@manufakture/core';
import { documentConstruction } from '../settings';
import { costLines, displayRows, money, takeoffCsv } from './display';
import { faceSpans, takeoffModel } from './input';
import { readTakeoffForm, takeoffForm, takeoffSettingsCommand } from './settings';
import {
  A,
  B,
  D,
  FLOOR,
  IN,
  PART,
  PRICES,
  ROOF,
  ROOF_INPUT,
  shedDocument,
  shedFeatures,
  shedSets,
} from './takeoff.test-fixture';

const FT_IN = shedDocument().units;

function shedTakeoff(
  options: { prices?: boolean; document?: ReturnType<typeof shedDocument> } = {},
) {
  const doc = options.document ?? shedDocument(options);
  const data = documentConstruction(doc);
  if (!data.ok) throw new Error(data.message);
  const stock = options.prices ? readStockData(PRICES as unknown as Json, 1) : undefined;
  if (stock && !stock.ok) throw new Error(stock.message);
  const model = takeoffModel({
    document: doc,
    partId: PART,
    features: shedFeatures(),
    sets: shedSets(),
    settings: data.data?.settings,
    stock: stock?.value,
  });
  return { doc, model, takeoff: constructionTakeoff(model.input) };
}

const inches = (mm: number) => Math.round((mm / IN) * 1000) / 1000;

describe('the takeoff model from the shown model', () => {
  it('measures wall faces on the framing face, mitred at a path corner and square at open ends', () => {
    const meta = {
      ...(shedFeatures()[1]!.metadata as object),
      points: [
        [0, 0],
        [192 * IN, 0],
        [192 * IN, 144 * IN],
      ],
    } as unknown as Parameters<typeof faceSpans>[0];
    // Outside (right of the path) by 1": the first segment runs 1" past the corner.
    expect(faceSpans(meta, -IN).map((s) => [s.segment, inches(s.start), inches(s.end)])).toEqual([
      [1, 0, 193],
      [2, -1, 144],
    ]);
    // Inside by 3-1/2": both stop short of the corner.
    expect(faceSpans(meta, 3.5 * IN).map((s) => [inches(s.start), inches(s.end)])).toEqual([
      [0, 188.5],
      [3.5, 144],
    ]);
  });

  it('turns the walls, floor and roof into the T6.3a fixture faces, named by their bodies', () => {
    const { model } = shedTakeoff();
    const faces = model.input.faces!;
    expect(faces.map((f) => [f.id, f.layer, inches(f.width), inches(f.height)])).toEqual([
      [`${FLOOR}:layer/subfloor`, 'subfloor', 192, 144],
      [`${A}:layer/sheathing`, 'sheathing', 192, 97.125],
      // The gable ends carry the roof's gable fill: 144 / 2 x 6/12 = 36" above the wall.
      [`${B}:layer/sheathing`, 'sheathing', 144, 133.125],
      ['extension#5:layer/sheathing', 'sheathing', 192, 97.125],
      [`${D}:layer/sheathing`, 'sheathing', 144, 133.125],
      [`${ROOF}:layer/sheathing-e1`, 'roof-sheathing', 216, 93.915],
      [`${ROOF}:layer/sheathing-e3`, 'roof-sheathing', 216, 93.915],
    ]);
    const door = faces.find((f) => f.id === `${B}:layer/sheathing`)!.holes!;
    expect(door.map((h) => [inches(h.x), inches(h.y), inches(h.width), inches(h.height)])).toEqual([
      [54, 0, 36, 80],
    ]);
    expect(model.bodies.get(`${B}:layer/sheathing`)).toEqual([
      `${B}:layer/sheathing`,
      `${ROOF}:layer/gable-e2-sheathing`,
    ]);
    expect(model.input.levels).toMatchObject({ [A]: 'level-1', 'extension#9': 'level-1' });
    expect(model.input.members).toHaveLength(156);
    expect(model.notes).toEqual([]);
  });

  it("gives T6.3a's rows to buy and its cost: 51 precuts, 25 + 6 sheets, $1,708.90", () => {
    const { takeoff } = shedTakeoff({ prices: true });
    const bought = takeoff.rows
      .filter((r) => r.category === 'lumber' || r.category === 'sheet')
      .map((r) => `${r.stock} ${r.size?.length ? inches(r.size.length) : ''}: ${r.quantity}`);
    expect(bought).toEqual([
      'us-2x4 192: 13',
      'us-2x4 168: 4',
      'us-2x4 144: 1',
      'us-2x4-precut-92-5-8 92.625: 51',
      'us-2x6 192: 18',
      'us-2x6 144: 13',
      'us-2x8 192: 1',
      'us-2x8 96: 1',
      'us-4x6 192: 3',
      'us-osb-7-16 96: 25',
      'us-osb-23-32 96: 6',
    ]);
    expect(takeoff.cost.total).toBeCloseTo(1708.9, 9);
    expect(takeoff.cost.unpriced).toEqual([]);
    expect(money(takeoff.cost.total, takeoff.cost.currency)).toBe('$1,708.90');
  });

  it('counts both gable fills of a closed wall that carries both gable ends', () => {
    // The shed's four walls as one closed path (as the Wall tool draws a loop): both gable ends
    // stand on the one wall's sheathing layer, and each fill is a face of its own.
    const doc = shedDocument();
    const data = documentConstruction(doc);
    if (!data.ok) throw new Error(data.message);
    const features = shedFeatures()
      .filter((f) => ![B, 'extension#5', D, 'extension#9'].includes(f.featureId))
      .map((f) => {
        const meta = f.metadata as Record<string, unknown>;
        if (f.featureId === A)
          return {
            ...f,
            metadata: {
              ...meta,
              points: [
                [0, 0],
                [192 * IN, 0],
                [192 * IN, 144 * IN],
                [0, 144 * IN],
              ],
              closed: true,
            } as unknown as NonNullable<typeof f.metadata>,
          };
        if (f.featureId === ROOF)
          return {
            ...f,
            metadata: {
              ...meta,
              walls: [A],
              gables: [
                { edge: 2, wall: A, body: `${ROOF}:layer/gable-e2-sheathing` },
                { edge: 4, wall: A, body: `${ROOF}:layer/gable-e4-sheathing` },
              ],
            } as unknown as NonNullable<typeof f.metadata>,
          };
        return f;
      });
    const model = takeoffModel({
      document: doc,
      partId: PART,
      features,
      sets: [],
      settings: data.data?.settings,
      stock: undefined,
    });
    const walls = model.input.faces!.filter((f) => f.layer === 'sheathing');
    expect(walls.map((f) => [f.id, inches(f.width), inches(f.height)])).toEqual([
      [`${A}:layer/sheathing/s1`, 192, 97.125],
      [`${A}:layer/sheathing/s2`, 144, 97.125],
      [`${A}:layer/sheathing/s3`, 192, 97.125],
      [`${A}:layer/sheathing/s4`, 144, 97.125],
      // 144 / 2 x 6/12 = 36" high, one per gable end.
      [`${ROOF}:layer/gable-e2-sheathing`, 144, 36],
      [`${ROOF}:layer/gable-e4-sheathing`, 144, 36],
    ]);
  });

  it('notes a sheet layer with no stock instead of counting it', () => {
    const doc = shedDocument();
    const data = documentConstruction(doc);
    if (!data.ok || !data.data) throw new Error('no data');
    const settings = {
      ...data.data.settings,
      wallTypes: data.data.settings.wallTypes.map((t) => ({
        ...t,
        layers: t.layers.map((l) =>
          l.kind === 'sheathing' ? { id: l.id, kind: l.kind, thickness: 11 } : l,
        ),
      })),
    };
    const model = takeoffModel({
      document: doc,
      partId: PART,
      features: shedFeatures(),
      sets: shedSets(),
      settings,
      stock: undefined,
    });
    expect(model.notes).toHaveLength(4);
    expect(model.notes[0]).toMatch(/no sheet stock, so its sheets are not counted/);
    // The gable fill goes with its wall's layer: not counted either.
    expect(model.input.faces!.map((f) => f.layer)).toEqual([
      'subfloor',
      'roof-sheathing',
      'roof-sheathing',
    ]);
  });
});

describe('the takeoff settings form', () => {
  it('stores precuts, waste, currency and lengths in domains.construction as one command', () => {
    const doc = shedDocument();
    const form = { ...takeoffForm(undefined, ['us-2x4']), precuts: false, waste: '10' };
    form.currency = 'usd';
    form.lengths = { 'us-2x4': `8', 12'`, 'us-2x6': 'cut' };
    const r = takeoffSettingsCommand(doc, form);
    if (!r.ok || r.command === null) throw new Error('no command');
    const next = applyCommand(doc, r.command);
    if (!next.ok) throw new Error(next.error.message);
    const data = documentConstruction(next.value.document);
    if (!data.ok || !data.data) throw new Error('no data');
    expect(data.data.stored.takeoff).toEqual({
      precuts: false,
      wastePercent: 10,
      currency: 'USD',
      lengths: {
        'us-2x4': [
          { source: `8'`, lengthUnit: 'in', angleUnit: 'deg' },
          { source: `12'`, lengthUnit: 'in', angleUnit: 'deg' },
        ],
        'us-2x6': [],
      },
    });
    // The rest of the settings are kept.
    expect(data.data.stored.wallTypes).toHaveLength(1);
    // And the form reads them back.
    expect(takeoffForm(data.data.stored.takeoff, ['us-2x4'])).toEqual({
      precuts: false,
      waste: '10',
      currency: 'USD',
      lengths: { 'us-2x4': `8', 12'`, 'us-2x6': 'cut' },
    });
    // Defaults again remove the takeoff settings.
    const back = takeoffSettingsCommand(next.value.document, takeoffForm(undefined, []));
    if (!back.ok || back.command === null) throw new Error('no command');
    const reset = applyCommand(next.value.document, back.command);
    if (!reset.ok) throw new Error(reset.error.message);
    const after = documentConstruction(reset.value.document);
    expect(after.ok && after.data?.stored.takeoff).toBeUndefined();
  });

  it('refuses bad fields with a message each, and bounds the text', () => {
    const form = takeoffForm(undefined, ['us-2x4']);
    const bad = readTakeoffForm(
      {
        ...form,
        waste: '120',
        currency: 'dollars',
        lengths: { 'us-2x4': `8', 2"`, 'us-2x6': 'x'.repeat(500) },
      },
      FT_IN,
    );
    expect(bad).toMatchObject({
      ok: false,
      errors: {
        waste: 'A percentage from 0 to 100.',
        currency: 'A three-letter code such as USD.',
        lengths: {
          'us-2x4': expect.stringMatching(/^2": Must be at least/),
          'us-2x6': expect.stringMatching(/^Up to 20 lengths/),
        },
      },
    });
    const many = Array.from({ length: 21 }, () => `8'`).join(',');
    expect(readTakeoffForm({ ...form, lengths: { 'us-2x4': many } }, FT_IN)).toMatchObject({
      ok: false,
    });
  });
});

describe('the takeoff files', () => {
  it('writes the CSV exactly, with the disclaimer first and as-framed counts only', () => {
    const { doc, takeoff } = shedTakeoff({ prices: true });
    const rows = displayRows(takeoff, doc.units);
    const csv = takeoffCsv(takeoff, rows, { title: 'Shed', units: doc.units });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Takeoff: Shed');
    expect(lines[1]).toBe(`"${DISCLAIMER_SHORT.replace(/"/g, '""')}"`);
    expect(lines[3]).toBe(
      'Section,#,Item,Stock,Size,Quantity,Total,Also,Price,Cost,Counted from,Notes',
    );
    // Every lumber line, exactly: what to buy, its other totals, price, cost and what it is cut into.
    const n = rows.find((r) => r.key.startsWith('lumber|'))!.number;
    expect(lines.filter((l) => l.startsWith('Lumber to buy,'))).toEqual(
      [
        `2x4,2x4,"16' 0""",13,13 pcs,"208' 0""; 138.67 bd ft",$0.75 per ft,$156.00,cut into 37 members,`,
        `2x4,2x4,"14' 0""",4,4 pcs,"56' 0""; 37.33 bd ft",$0.75 per ft,$42.00,cut into 10 members,`,
        `2x4,2x4,"12' 0""",1,1 pcs,"12' 0""; 8.00 bd ft",$0.75 per ft,$9.00,cut into 2 members,`,
        `"2x4 precut stud 92-5/8""","2x4 precut stud 92-5/8""","7' 8-5/8""",51,51 pcs,"393' 7-7/8""; 262.44 bd ft",$4.50 each,$229.50,cut into 51 members,precut stud`,
        `2x6,2x6,"16' 0""",18,18 pcs,"288' 0""; 288.00 bd ft",$1.10 per ft,$316.80,cut into 38 members,`,
        `2x6,2x6,"12' 0""",13,13 pcs,"156' 0""; 156.00 bd ft",$1.10 per ft,$171.60,cut into 13 members,`,
        `2x8,2x8,"16' 0""",1,1 pcs,"16' 0""; 21.33 bd ft",$1.50 per ft,$24.00,cut into 1 member,`,
        `2x8,2x8,"8' 0""",1,1 pcs,"8' 0""; 10.67 bd ft",$1.50 per ft,$12.00,cut into 1 member,`,
        `4x6,4x6,"16' 0""",3,3 pcs,"48' 0""; 96.00 bd ft",$2.50 per ft,$120.00,cut into 3 members,`,
      ].map((line, i) => `Lumber to buy,${n + i},${line}`),
    );
    expect(lines.filter((l) => l.startsWith('Sheets to buy,'))).toEqual([
      `Sheets to buy,${n + 9},"7/16"" OSB","7/16"" OSB","8' 0"" x 4' 0""",25,25 sheets,800.00 sq ft,$16.00 per sheet,$400.00,for 6 faces and parts,`,
      expect.stringMatching(
        /^Sheets to buy,\d+,.*,6,6 sheets,192\.00 sq ft,\$38\.00 per sheet,\$228\.00,for 1 face or part,$/,
      ),
    ]);
    expect(lines.at(-2)).toBe('"Cost of what to buy: $1,708.90"');
    expect(csv).not.toMatch(/estimate|per foot of wall|rule of thumb/i);
  });

  it('lists the rows the cost leaves out by number', () => {
    const { doc, takeoff } = shedTakeoff();
    const rows = displayRows(takeoff, doc.units);
    const lines = costLines(takeoff, rows);
    expect(lines[0]).toBe('Cost of what to buy: 0.00');
    expect(lines[1]).toMatch(/^Not in the cost .*: rows \d+(, \d+)+$/);
  });
});

describe('the shed as the app frames its roof', () => {
  it('lays the gable studs on the gable walls, which changes only the 2x4 sticks', () => {
    // The app's roof (T6.1c) lays each gable end's studs on the stud layout of the wall under it
    // (the butting 12' walls' layouts start 3-1/2" in), where T6.3a's fixture uses the generator's
    // own origin. Same 16 studs and the same 298" of them, cut to other lengths, so the 1D layout
    // packs the 2x4s differently: still 18 sticks (3265.082" > 17 x 192"), as 15 x 16', 1 x 14'
    // and 2 x 12', 2 ft more than the fixture's: $1.50 more at $0.75 a foot.
    const sets = shedSets();
    const roofSet = sets.find((s) => s.group === ROOF)!;
    const gableStuds = {
      ...ROOF_INPUT.settings.gableStuds!,
      origin: { e2: 3.5 * IN, e4: 140.5 * IN },
    };
    const framed = frameRoof({ ...ROOF_INPUT, settings: { ...ROOF_INPUT.settings, gableStuds } });
    roofSet.members = framed.members as unknown as typeof roofSet.members;
    const doc = shedDocument({ prices: true });
    const data = documentConstruction(doc);
    const stock = readStockData(PRICES as unknown as Json, 1);
    if (!data.ok || !stock.ok) throw new Error('fixture');
    const model = takeoffModel({
      document: doc,
      partId: PART,
      features: shedFeatures(),
      sets,
      settings: data.data?.settings,
      stock: stock.value,
    });
    const t = constructionTakeoff(model.input);
    const studs = model.input.members.filter((m) => m.role === 'gable-stud');
    expect(studs).toHaveLength(16);
    expect(studs.reduce((a, m) => a + m.length, 0) / IN).toBeCloseTo(298, 6);
    expect(
      t.rows
        .filter((r) => r.category === 'lumber' && r.stock === 'us-2x4')
        .map((r) => `${inches(r.size!.length!)}: ${r.quantity}`),
    ).toEqual(['192: 15', '168: 1', '144: 2']);
    expect(t.cost.total).toBeCloseTo(1710.4, 9);
  });
});
