import { readStockData, type Json } from '@manufakture/stock';
import { describe, expect, it } from 'vitest';
import {
  CONSTRUCTION_DATA,
  CONSTRUCTION_DATA_VERSION,
  EMPTY_CONSTRUCTION_SETTINGS,
  defaultConstructionSettings,
  layerThickness,
  newWallType,
  readConstructionData,
  wallTypeThickness,
  writeConstructionData,
  type ConstructionData,
  type StoredConstructionSettings,
  type WallType,
} from './data';
import { constructionDomain, registerConstruction } from './domain';
import { DISCLAIMER_SHORT } from './disclaimer';
import { findLevel } from './levels';
import { IN } from './test-helpers';

// JSON-shaped expressions (inferred types, so they also fit where stored JSON is expected).
const inch = (source: string) => ({
  source,
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});
const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

const HEADER = { stock: 'us-2x8', plies: 2, jacks: 1, spacer: 'us-ply-15-32' };

/** A full document's worth of construction data, as stored. */
function full(): Record<string, Json> {
  // A deep copy every time, so a test's edit never reaches `HEADER` or another test.
  return structuredClone({
    levels: [
      { id: 'level-1', name: 'Level 1', elevation: inch('0'), height: inch('97-1/8"') },
      { id: 'basement', name: 'Basement', elevation: inch("-8'"), height: inch("8'") },
    ],
    wallTypes: [
      {
        id: 'ext-2x4',
        name: 'Exterior 2x4',
        layers: [
          { id: 'siding', kind: 'siding', thickness: inch('5/8') },
          { id: 'osb', kind: 'sheathing', stock: 'us-osb-7-16' },
          {
            id: 'studs',
            kind: 'framing',
            stock: 'us-2x4',
            spacing: inch('16'),
            bottomPlates: 1,
            topPlates: 2,
            header: { ...HEADER },
          },
          { id: 'gyp', kind: 'drywall', stock: 'us-gyp-1-2-8ft' },
        ],
      },
    ],
    floorTypes: [
      {
        id: 'shed-floor',
        name: 'Shed floor',
        joistStock: 'us-2x6',
        spacing: inch('16'),
        subfloor: 'us-ply-23-32',
      },
    ],
    roofTypes: [
      {
        id: 'shed-roof',
        name: 'Shed roof',
        rafterStock: 'us-2x6',
        ridgeStock: 'us-2x8',
        spacing: inch('16'),
        overhang: inch('12'),
        tail: 'plumb',
        sheathing: 'us-osb-7-16',
      },
    ],
    framing: {
      spacing: inch('16'),
      layoutOrigin: inch('-3/4'),
      cornerStyle: 'three-stud',
      blocking: { kind: 'heights', heights: [inch('48'), inch('96')] },
      kings: 1,
      spliceOffset: inch('24'),
      plateStockLengths: [inch("12'"), inch("16'")],
      precutLengths: [inch('92-5/8"'), inch('104-5/8"')],
    },
    headerRules: [
      { maxWidth: inch('48'), header: { ...HEADER } },
      { maxWidth: inch('36'), header: { stock: 'us-2x6', plies: 2, jacks: 1 } },
    ],
  });
}

function read(data: Json, version = 1): ConstructionData {
  const r = readConstructionData(data, version);
  if (!r.ok) throw new Error(`${r.message} at ${JSON.stringify(r.field)}`);
  return r.value;
}

function refused(data: Json, field: (string | number)[], message?: RegExp): void {
  const r = readConstructionData(data, 1);
  expect(r.ok, JSON.stringify(data)).toBe(false);
  if (r.ok) return;
  expect(r.field).toEqual(field);
  if (message) expect(r.message).toMatch(message);
}

/**
 * `full()` with one change made by `edit`. The edits reach deep into stored JSON to break it on
 * purpose, so the copy is loosely typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed JSON
type Loose = Record<string, any>;
function edited(edit: (d: Loose) => void): Json {
  const d = full() as Loose;
  edit(d);
  return d as Json;
}

describe('domains.construction: reading', () => {
  it('reads a full document, as stored and evaluated in mm', () => {
    const data = read(full());
    const { settings, stored } = data;
    expect(settings.levels.map((l) => l.id)).toEqual(['level-1', 'basement']);
    expect(settings.levels[0]!.elevation).toBe(0);
    expect(settings.levels[0]!.height).toBeCloseTo(97.125 * IN, 9);
    expect(settings.levels[1]!.elevation).toBeCloseTo(-96 * IN, 9);
    expect(settings.levels[1]!.height).toBeCloseTo(96 * IN, 9);
    expect(stored.levels[1]!.elevation).toEqual(inch("-8'"));
    expect(findLevel(settings.levels, 'basement')!.name).toBe('Basement');

    const wall = settings.wallTypes[0]!;
    expect(wall.layers.map((l) => l.kind)).toEqual(['siding', 'sheathing', 'framing', 'drywall']);
    const framing = wall.layers[2]!;
    expect(framing).toEqual({
      id: 'studs',
      kind: 'framing',
      stock: 'us-2x4',
      spacing: 16 * IN,
      bottomPlates: 1,
      topPlates: 2,
      header: HEADER,
    });
    expect(wall.layers[0]).toEqual({ id: 'siding', kind: 'siding', thickness: 0.625 * IN });
    // Absent optional fields stay absent, not undefined-valued.
    expect(Object.keys(wall.layers[1]!)).toEqual(['id', 'kind', 'stock']);

    expect(settings.floorTypes[0]!.spacing).toBe(16 * IN);
    expect(settings.roofTypes[0]!.overhang).toBe(12 * IN);
    const close = (got: readonly number[] | undefined, inches: number[]) => {
      expect(got).toHaveLength(inches.length);
      inches.forEach((v, i) => expect(got![i]).toBeCloseTo(v * IN, 9));
    };
    close(settings.framing.plateStockLengths, [144, 192]);
    close(settings.framing.precutLengths, [92.625, 104.625]);
    expect(settings.framing.cornerStyle).toBe('three-stud');
    expect(settings.framing.layoutOrigin).toBeCloseTo(-0.75 * IN, 9);
    expect(settings.framing.blocking).toEqual({ kind: 'heights', heights: [48 * IN, 96 * IN] });
    expect(stored.framing.blocking).toEqual({ kind: 'heights', heights: [inch('48'), inch('96')] });
    expect(settings.headerRules.map((r) => r.maxWidth)).toEqual([48 * IN, 36 * IN]);
    expect(stored.headerRules[0]!.maxWidth).toEqual(inch('48'));
  });

  it('reads an empty object as empty settings', () => {
    expect(read({}).stored).toEqual(EMPTY_CONSTRUCTION_SETTINGS);
    expect(read({}).settings.headerRules).toEqual([]);
  });

  it('reads the other blocking kinds and a zero or positive layout origin', () => {
    for (const blocking of [{ kind: 'none' }, { kind: 'mid-height' }]) {
      const data = read(edited((d) => (d.framing.blocking = blocking)));
      expect(data.stored.framing.blocking).toEqual(blocking);
      expect(data.settings.framing.blocking).toEqual(blocking);
    }
    expect(
      read(edited((d) => (d.framing.layoutOrigin = inch('0')))).settings.framing.layoutOrigin,
    ).toBe(0);
    expect(
      read(edited((d) => (d.framing.layoutOrigin = inch('8')))).settings.framing.layoutOrigin,
    ).toBeCloseTo(8 * IN, 9);
  });

  it('refuses a variable in a level, with the domain message (ADR 0015 decision 2)', () => {
    refused(
      edited((d) => (d.levels[0].elevation = inch('#floor_height'))),
      ['levels', 0, 'elevation'],
      /domain settings hold constants only: #floor_height is a variable/,
    );
    refused(
      edited((d) => (d.levels[0].height = inch('#h + 1'))),
      ['levels', 0, 'height'],
      /constants only/,
    );
  });

  it('refuses invalid data with the field at fault', () => {
    const cases: [Json, (string | number)[]][] = [
      [[], []],
      [{ walls: [] }, ['walls']],
      [edited((d) => (d.levels = {})), ['levels']],
      [edited((d) => (d.levels[0].height = inch('0'))), ['levels', 0, 'height']],
      [edited((d) => (d.levels[1].id = 'level-1')), ['levels', 1, 'id']],
      [edited((d) => (d.levels[0].id = 'Level 1')), ['levels', 0, 'id']],
      [edited((d) => (d.levels[0].name = ' ')), ['levels', 0, 'name']],
      [edited((d) => (d.levels[0].extra = 1)), ['levels', 0, 'extra']],
      [
        edited((d) => (d.levels[0].elevation = { source: '0' })),
        ['levels', 0, 'elevation', 'lengthUnit'],
      ],
      // Wall types: kinds, order, the one framing layer, stock kinds, counts.
      [
        edited((d) => (d.wallTypes[0].layers[0].kind = 'paint')),
        ['wallTypes', 0, 'layers', 0, 'kind'],
      ],
      [edited((d) => d.wallTypes[0].layers.reverse()), ['wallTypes', 0, 'layers', 1, 'kind']],
      [edited((d) => d.wallTypes[0].layers.splice(2, 1)), ['wallTypes', 0, 'layers']],
      [
        edited((d) =>
          d.wallTypes[0].layers.splice(3, 0, { ...d.wallTypes[0].layers[2], id: 'studs-2' }),
        ),
        ['wallTypes', 0, 'layers', 3, 'kind'],
      ],
      [edited((d) => (d.wallTypes[0].layers[3].id = 'studs')), ['wallTypes', 0, 'layers', 3, 'id']],
      [
        edited((d) => (d.wallTypes[0].layers[2].stock = 'us-osb-7-16')),
        ['wallTypes', 0, 'layers', 2, 'stock'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[1].stock = 'us-2x4')),
        ['wallTypes', 0, 'layers', 1, 'stock'],
      ],
      [edited((d) => delete d.wallTypes[0].layers[0].thickness), ['wallTypes', 0, 'layers', 0]],
      [
        edited((d) => delete d.wallTypes[0].layers[2].header),
        ['wallTypes', 0, 'layers', 2, 'header'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[2].header.plies = 5)),
        ['wallTypes', 0, 'layers', 2, 'header', 'plies'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[2].header.jacks = 1.5)),
        ['wallTypes', 0, 'layers', 2, 'header', 'jacks'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[2].topPlates = 0)),
        ['wallTypes', 0, 'layers', 2, 'topPlates'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[2].spacing = inch('-16'))),
        ['wallTypes', 0, 'layers', 2, 'spacing'],
      ],
      [
        edited((d) => (d.wallTypes[0].layers[2].thickness = inch('4'))),
        ['wallTypes', 0, 'layers', 2, 'thickness'],
      ],
      [edited((d) => d.wallTypes.push({ ...d.wallTypes[0] })), ['wallTypes', 1, 'id']],
      // Floor and roof types.
      [edited((d) => delete d.floorTypes[0].joistStock), ['floorTypes', 0, 'joistStock']],
      [edited((d) => (d.floorTypes[0].subfloor = 'us-2x6')), ['floorTypes', 0, 'subfloor']],
      [edited((d) => (d.roofTypes[0].tail = 'ogee')), ['roofTypes', 0, 'tail']],
      [edited((d) => (d.roofTypes[0].overhang = inch('-1'))), ['roofTypes', 0, 'overhang']],
      [
        edited((d) => (d.roofTypes[0].ridgeStock = 'us-gyp-1-2-8ft')),
        ['roofTypes', 0, 'ridgeStock'],
      ],
      // Framing settings.
      [edited((d) => (d.framing = [])), ['framing']],
      [edited((d) => (d.framing.cornerStyle = 'four-stud')), ['framing', 'cornerStyle']],
      [edited((d) => (d.framing.kings = 5)), ['framing', 'kings']],
      [edited((d) => (d.framing.plateStockLengths = [])), ['framing', 'plateStockLengths']],
      [edited((d) => (d.framing.precutLengths = [inch('#stud')])), ['framing', 'precutLengths', 0]],
      [edited((d) => (d.framing.layoutFrom = 'middle')), ['framing', 'layoutFrom']],
      [edited((d) => (d.framing.layoutOrigin = inch('#o'))), ['framing', 'layoutOrigin']],
      [edited((d) => (d.framing.blocking = 'mid-height')), ['framing', 'blocking']],
      [edited((d) => (d.framing.blocking = { kind: 'top' })), ['framing', 'blocking', 'kind']],
      [
        edited((d) => (d.framing.blocking = { kind: 'heights', heights: [] })),
        ['framing', 'blocking', 'heights'],
      ],
      [
        edited((d) => (d.framing.blocking = { kind: 'heights' })),
        ['framing', 'blocking', 'heights'],
      ],
      [
        edited((d) => (d.framing.blocking = { kind: 'heights', heights: [inch('0')] })),
        ['framing', 'blocking', 'heights', 0],
      ],
      [
        edited((d) => (d.framing.blocking = { kind: 'none', heights: [inch('48')] })),
        ['framing', 'blocking', 'heights'],
      ],
      // Header rules.
      [edited((d) => (d.headerRules[0].maxWidth = inch('0'))), ['headerRules', 0, 'maxWidth']],
      [edited((d) => (d.headerRules[1].maxWidth = mm('1219.2'))), ['headerRules', 1, 'maxWidth']],
      [
        edited((d) => (d.headerRules[0].header.stock = 'us-osb-7-16')),
        ['headerRules', 0, 'header', 'stock'],
      ],
    ];
    for (const [data, field] of cases) refused(data, field);
  });

  it('bounds the lengths, so a crafted document cannot make the generators lay out without end', () => {
    refused(
      edited((d) => (d.framing = { spacing: mm('49') })),
      ['framing', 'spacing'],
      /at least 50 mm/,
    );
    refused(
      edited((d) => (d.wallTypes[0].layers[2].spacing = mm('0.001'))),
      ['wallTypes', 0, 'layers', 2, 'spacing'],
      /at least 50 mm/,
    );
    refused(
      edited((d) => (d.framing = { ladderSpacing: mm('10') })),
      ['framing', 'ladderSpacing'],
    );
    refused(
      edited((d) => (d.framing = { plateStockLengths: [mm('299')] })),
      ['framing', 'plateStockLengths', 0],
      /at least 300 mm/,
    );
    refused(
      edited((d) => (d.framing = { spliceOffset: mm('100001') })),
      ['framing', 'spliceOffset'],
      /at most 100 m/,
    );
    refused(
      edited((d) => (d.wallTypes[0].layers[0].thickness = mm('200000'))),
      ['wallTypes', 0, 'layers', 0, 'thickness'],
    );
    refused(
      edited((d) => (d.levels[0].height = mm('100001'))),
      ['levels', 0, 'height'],
      /100 m/,
    );
    refused(
      edited((d) => (d.levels[0].elevation = mm('-100001'))),
      ['levels', 0, 'elevation'],
    );
    expect(
      readConstructionData(
        edited((d) => (d.framing = { spacing: mm('50') })),
        1,
      ).ok,
    ).toBe(true);
  });

  it('keeps a stock id this build does not know (it may come from a newer build)', () => {
    const data = read(edited((d) => (d.wallTypes[0].layers[1].stock = 'us-zip-7-16')));
    expect(data.settings.wallTypes[0]!.layers[1]).toMatchObject({ stock: 'us-zip-7-16' });
    const t = layerThickness(data.settings.wallTypes[0]!.layers[1]!);
    expect(t).toMatchObject({ ok: false, message: expect.stringContaining('us-zip-7-16') });
  });

  it('reads keys as data only (no prototype keys)', () => {
    refused(JSON.parse('{"__proto__": {"levels": 1}}') as Json, ['__proto__']);
  });
});

describe('domains.construction: versions and migrations', () => {
  it('is version 1 with no migrations yet', () => {
    expect(CONSTRUCTION_DATA_VERSION).toBe(1);
    expect(CONSTRUCTION_DATA.migrations).toEqual([]);
  });

  it('refuses a newer or malformed version as a domain error (the document still loads)', () => {
    expect(readConstructionData(full(), 2)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/construction data: version 2 is newer than this build/),
    });
    expect(readConstructionData(full(), 0)).toMatchObject({
      ok: false,
      message: expect.stringContaining('is not a version'),
    });
    // Regen checks a newer version against the registered reader's version before reading, and
    // reports it as `unsupported` on `domains.construction` (ADR 0013 decision 4).
    expect(constructionDomain.data!.construction!.schemaVersion).toBe(CONSTRUCTION_DATA_VERSION);
  });
});

describe('domains.construction: writing', () => {
  it('round-trips through the writer', () => {
    const data = read(full());
    const written = writeConstructionData(data.stored);
    expect(written.ok).toBe(true);
    if (!written.ok || written.value === undefined) throw new Error('nothing written');
    expect(written.value.schemaVersion).toBe(CONSTRUCTION_DATA_VERSION);
    expect(read(written.value.data).stored).toEqual(data.stored);
  });

  it('writes nothing for empty settings, and leaves empty lists out', () => {
    expect(writeConstructionData(EMPTY_CONSTRUCTION_SETTINGS)).toEqual({
      ok: true,
      value: undefined,
    });
    const one = writeConstructionData(defaultConstructionSettings('us'));
    expect(one.ok && one.value && Object.keys(one.value.data as object)).toEqual(['levels']);
  });

  it('refuses to write what the reader would refuse', () => {
    const bad: StoredConstructionSettings = {
      ...EMPTY_CONSTRUCTION_SETTINGS,
      levels: [{ id: 'l', name: 'L', elevation: inch('#e'), height: inch('8') }],
    };
    expect(writeConstructionData(bad)).toMatchObject({
      ok: false,
      field: ['levels', 0, 'elevation'],
    });
  });
});

describe('domains.construction: defaults', () => {
  it('a new document has one level and no types, and no header rules (ADR 0015 decision 7)', () => {
    for (const region of ['us', 'metric'] as const) {
      const s = defaultConstructionSettings(region);
      expect(s.levels).toHaveLength(1);
      expect(s.wallTypes).toEqual([]);
      expect(s.floorTypes).toEqual([]);
      expect(s.roofTypes).toEqual([]);
      expect(s.framing).toEqual({});
      expect(s.headerRules).toEqual([]);
    }
    const us = read(writeConstructionDataOrThrow(defaultConstructionSettings('us')));
    expect(us.settings.levels[0]).toEqual({
      id: 'level-1',
      name: 'Level 1',
      elevation: 0,
      height: 97.125 * IN,
    });
    const metric = read(writeConstructionDataOrThrow(defaultConstructionSettings('metric')));
    expect(metric.settings.levels[0]!.height).toBe(2400);
  });

  it('a new wall type needs its default header, and offers no sizing table', () => {
    const type = newWallType({
      id: 'ext',
      name: 'Exterior',
      studStock: 'us-2x4',
      header: HEADER,
      sheathing: 'us-osb-7-16',
      drywall: 'us-gyp-1-2-8ft',
    });
    expect(type.layers.map((l) => l.kind)).toEqual(['sheathing', 'framing', 'drywall']);
    expect(type.layers[1]).toEqual({
      id: 'framing',
      kind: 'framing',
      stock: 'us-2x4',
      header: HEADER,
    });
    const written = writeConstructionDataOrThrow({
      ...EMPTY_CONSTRUCTION_SETTINGS,
      wallTypes: [type],
    });
    expect(read(written).settings.wallTypes[0]!.layers).toHaveLength(3);
    // Without sheathing or drywall, the framing layer alone.
    expect(
      newWallType({ id: 'p', name: 'Partition', studStock: 'us-2x4', header: HEADER }).layers,
    ).toHaveLength(1);
    // @ts-expect-error a wall type cannot be made without a header
    newWallType({ id: 'x', name: 'X', studStock: 'us-2x4' });
  });

  it('nothing in the defaults or messages reads as a structural verdict', () => {
    const text = JSON.stringify([
      defaultConstructionSettings('us'),
      defaultConstructionSettings('metric'),
    ]);
    expect(text).not.toMatch(/\b(safe|compliant|OK|passes)\b/i);
    expect(DISCLAIMER_SHORT.length).toBeGreaterThan(0);
  });
});

function writeConstructionDataOrThrow(s: StoredConstructionSettings): Json {
  const w = writeConstructionData(s);
  if (!w.ok || w.value === undefined) throw new Error('nothing written');
  return w.value.data;
}

describe('wall type thickness', () => {
  const type = (layers: Json[]): WallType =>
    read({ wallTypes: [{ id: 't', name: 'T', layers }] }).settings.wallTypes[0]!;
  const framing = { id: 'studs', kind: 'framing', stock: 'us-2x4', header: HEADER };

  it('is the sum of its layers: 2x4 + 7/16" OSB + 1/2" drywall is 4-7/16"', () => {
    const t = type([
      { id: 'osb', kind: 'sheathing', stock: 'us-osb-7-16' },
      framing,
      { id: 'gyp', kind: 'drywall', stock: 'us-gyp-1-2-8ft' },
    ]);
    const total = wallTypeThickness(t);
    expect(total.ok).toBe(true);
    expect(total.ok && total.value).toBeCloseTo((4 + 7 / 16) * IN, 9);
  });

  it('uses a typed thickness over the stock, and the document stock overrides', () => {
    const t = type([
      { id: 'siding', kind: 'siding', thickness: inch('3/4') },
      { id: 'osb', kind: 'sheathing', stock: 'us-osb-7-16', thickness: mm('11') },
      framing,
    ]);
    expect(wallTypeThickness(t)).toMatchObject({ ok: true, value: 0.75 * IN + 11 + 3.5 * IN });
    const stock = readStockData({ overrides: { 'us-2x4': { width: inch('3-9/16"') } } }, 1);
    if (!stock.ok) throw new Error(stock.message);
    const r = wallTypeThickness(t, stock.value);
    expect(r.ok && r.value).toBeCloseTo(0.75 * IN + 11 + (3 + 9 / 16) * IN, 9);
  });
});

describe('the construction registration (ADR 0015 decision 1)', () => {
  it('owns `construction`, reads `stock`, and builds walls and openings', () => {
    expect(constructionDomain.namespace).toBe('construction');
    expect(Object.keys(constructionDomain.types!).sort()).toEqual([
      'construction.opening',
      'construction.wall',
    ]);
    expect(constructionDomain.reads).toEqual(['stock']);
    expect(Object.keys(constructionDomain.data!)).toEqual(['construction']);
    const r = constructionDomain.data!.construction!.read(full(), 1);
    expect(r.ok).toBe(true);
    expect(constructionDomain.data!.construction!.read({ levels: 1 }, 1)).toMatchObject({
      ok: false,
      field: ['levels'],
    });
  });

  it('registers the stock reader too unless something owns it', () => {
    // A stand-in registry: domain tests do not load regen at run time (boundary.test.ts).
    const registered: string[] = [];
    const owned = new Set<string>();
    const registry = {
      registerDomain(d: { namespace: string; data?: object }) {
        registered.push(d.namespace);
        for (const ns of Object.keys(d.data ?? {})) owned.add(ns);
        return () => {};
      },
      reader(ns: string) {
        return owned.has(ns)
          ? { schemaVersion: 1, read: () => ({ ok: true as const, value: 0 }) }
          : undefined;
      },
    };
    registerConstruction(registry);
    expect(registered).toEqual(['stock', 'construction']);
    registered.length = 0;
    owned.delete('construction');
    registerConstruction(registry);
    expect(registered).toEqual(['construction']);
  });
});
