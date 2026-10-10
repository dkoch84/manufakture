import {
  MAX_CATALOG_ENTRIES,
  applyCommand,
  createDocument,
  mechItems,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  CsvError,
  MAX_CSV_CHARS,
  MAX_CSV_COLUMNS,
  importCatalogCsv,
  parseCsv,
  problemText,
} from './csv';
import { entryFields, readEntryFields } from './entry';
import { ratingField } from './families';
import { readDimension, readMass, readRating } from './input';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const US: DisplayUnits = { length: { unit: 'in-fraction' }, angle: { unit: 'deg' } };

const doc = (): ManufaktureDocument => createDocument({ id: 'd', name: 'D' });

const errorOf = (text: string, limits?: Parameters<typeof parseCsv>[1]) => {
  try {
    parseCsv(text, limits);
  } catch (e) {
    if (e instanceof CsvError) return { line: e.line, message: e.message };
    throw e;
  }
  return null;
};

describe('typing a rating in', () => {
  const C = ratingField('bearing', 'dynamicLoad')!;
  const n = ratingField('bearing', 'limitingSpeed')!;

  it('reads units, and a bare number in the display unit', () => {
    expect(readRating(C, '5.4 kN', SI)).toEqual({ ok: true, value: { value: 5400 } });
    expect(readRating(C, '5400', SI)).toEqual({ ok: true, value: { value: 5400 } });
    const lbf = readRating(C, '1000', US);
    expect(lbf.ok && lbf.value && 'value' in lbf.value && lbf.value.value).toBeCloseTo(4448.22, 1);
    const speed = readRating(n, '17000 rpm', SI);
    expect(speed.ok && speed.value && 'value' in speed.value && speed.value.value).toBeCloseTo(
      (17000 * 2 * Math.PI) / 60,
      6,
    );
  });

  it('refuses the wrong kind, rpm in a frequency field, and a count that is not whole', () => {
    expect(readRating(C, '5 N*m', SI).ok).toBe(false);
    const loop = ratingField('controller', 'loopRate')!;
    expect(readRating(loop, '8000 rpm', SI).ok).toBe(false);
    expect(readRating(loop, '8 kHz', SI)).toEqual({ ok: true, value: { value: 8000 } });
    const poles = ratingField('connector', 'poles')!;
    expect(readRating(poles, '2.5', SI)).toMatchObject({ ok: false, message: /whole/ });
    expect(readRating(poles, '2', SI)).toEqual({ ok: true, value: { value: 2 } });
  });

  it('reads choices case-insensitively, unknown values and empty cells', () => {
    const closure = ratingField('bearing', 'closure')!;
    expect(readRating(closure, 'Contact Seal', SI)).toEqual({
      ok: true,
      value: { text: 'contact seal' },
    });
    expect(readRating(closure, 'welded', SI).ok).toBe(false);
    expect(readRating(C, 'unknown', SI)).toEqual({ ok: true, value: { unknown: true } });
    expect(readRating(C, '  ', SI)).toEqual({ ok: true, value: undefined });
  });

  it('reads dimensions in the length unit and masses in the mass unit', () => {
    expect(readDimension('12', SI)).toEqual({ ok: true, value: { value: 12 } });
    expect(readDimension('1/2', US)).toEqual({ ok: true, value: { value: 12.7 } });
    expect(readDimension('0', SI).ok).toBe(false);
    expect(readMass('80 g', SI)).toEqual({ ok: true, value: { value: 0.08 } });
    expect(readMass('-1 kg', SI).ok).toBe(false);
  });
});

describe('reading CSV', () => {
  it('reads quoted fields, doubled quotes, line breaks inside quotes and CRLF', () => {
    const records = parseCsv('﻿a,b\r\n"x, ""y""","multi\nline"\r\nlast,\n');
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, "y"', 'multi\nline'] },
      { line: 4, fields: ['last', ''] },
    ]);
  });

  it('names the line of every malformed input', () => {
    expect(errorOf('a,b\n1,"open\n2,3\n')).toMatchObject({ line: 2, message: /never closed/ });
    expect(errorOf('a,b\n1,x"y\n')).toMatchObject({ line: 2, message: /quote inside/ });
    expect(errorOf('a,b\n"1"x,2\n')).toMatchObject({ line: 2, message: /after a closing quote/ });
    expect(errorOf('a,b\n1,\u0000\n')).toMatchObject({ line: 2, message: /control/ });
    expect(errorOf('a\n1\n2\n3\n', { rows: 2 })).toMatchObject({ line: 4, message: /rows/ });
    expect(errorOf(`${'x,'.repeat(MAX_CSV_COLUMNS)}x\n`)).toMatchObject({ message: /columns/ });
    expect(errorOf(`a\n${'x'.repeat(20)}\n`, { field: 10 })).toMatchObject({
      line: 2,
      message: /longer than 10/,
    });
    expect(errorOf('x'.repeat(MAX_CSV_CHARS + 1))).toMatchObject({
      line: 1,
      message: /characters/,
    });
  });

  it('keeps control characters only when asked, for text this program wrote', () => {
    expect(errorOf('a,b\u0001\n')).toMatchObject({ line: 1, message: /control character/ });
    expect(parseCsv('a,b\u0001\n', { keepControls: true })[0]!.fields).toEqual(['a', 'b\u0001']);
  });

  it('never hangs on hostile input', () => {
    const t = performance.now();
    // Quotes everywhere, a long quoted field, many empty fields: all linear.
    expect(errorOf('"'.repeat(1_000_001))).not.toBeNull();
    parseCsv(`"${'""'.repeat(4000)}"\n`);
    parseCsv(`${','.repeat(200)}\n`.repeat(1000));
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

const HEADER =
  'family,maker,partNumber,description,dim.innerDiameter,dim.outerDiameter,dim.width,dynamicLoad,staticLoad,limitingSpeed,closure,mass,sourceTitle,sourceUrl,sourceRead,verified,ratedWorkingTension,ratedWorkingTension.basis,dim.pitch';

describe('importing catalog entries from CSV', () => {
  it('imports a file of mixed families as one batch, every entry unverified unless marked', () => {
    const csv = [
      HEADER,
      'bearing,Acme,6001-2RS,"12 x 28 x 8",12,28,8,5.1 kN,2.36 kN,15000 rpm,contact seal,22 g,Acme catalogue,https://acme.example/6001,2026-10-01,,,,',
      'belt,Acme,GT2-6,,,,6 mm,,,,,,,,,yes,169 N,12 grooves,2',
      '',
    ].join('\n');
    const r = importCatalogCsv(doc(), csv, { units: SI });
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => [e.id, e.family, e.verified])).toEqual([
      ['entry#1', 'bearing', false],
      ['entry#2', 'belt', true],
    ]);
    const [bearing, belt] = r.entries;
    expect(bearing!.ratings.dynamicLoad).toEqual({ value: 5100 });
    expect(bearing!.dimensions).toEqual({
      innerDiameter: { value: 12 },
      outerDiameter: { value: 28 },
      width: { value: 8 },
    });
    expect(bearing!.mass).toEqual({ value: 0.022 });
    expect(bearing!.sources).toEqual([
      { title: 'Acme catalogue', url: 'https://acme.example/6001', read: '2026-10-01' },
    ]);
    expect(belt!.ratings.ratedWorkingTension).toEqual({ value: 169, basis: '12 grooves' });
    const applied = applyCommand(doc(), r.command);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(mechItems(applied.value.document.mech, 'catalog')).toHaveLength(2);
  });

  it('refuses malformed rows with their line numbers, and imports nothing', () => {
    const csv = [
      HEADER,
      'bearing,Acme,A1,,12,28,8,5.1 kN,,,,,,,,,,,',
      'gearbox,Acme,A2,,,,,,,,,,,,,,,,',
      'bearing,Acme,A3,,12,28,8,5.1 N*m,,,,,,,,,,,',
      'bearing,Acme,A4,,12,28,8,,,8000 V,,,,,,,,,',
      'bearing,,A5,,12,28,8,,,,,,,,,,,,',
      'bearing,Acme,A6,,12,28,8,,,,,,Evil,javascript:alert(1),2026-10-01,,,,',
      'bearing,Acme,A7,,12,28,8,,,,,,,,,,169 N,,',
      'bearing,Acme,A8,,12,28',
      'bearing,Acme,A9,,12,28,8,,,,,,,,,maybe,,,',
    ].join('\n');
    const r = importCatalogCsv(doc(), csv, { units: SI });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const lines = r.problems.map((p) => [p.line, p.column]);
    expect(lines).toEqual([
      [3, 'family'],
      [4, 'dynamicLoad'],
      [5, 'limitingSpeed'],
      [6, 'maker'],
      [7, 'sourceUrl'],
      [8, 'ratedWorkingTension'],
      [9, undefined],
      [10, 'verified'],
    ]);
    expect(problemText(r.problems[0]!)).toMatch(/^line 3, family: "gearbox" is not a family/);
    expect(problemText(r.problems[6]!)).toMatch(/^line 9: 6 fields where the header has 19/);
  });

  it('refuses a bad header, an empty file and more rows than the document can hold', () => {
    const bad = importCatalogCsv(doc(), 'family,maker,partNumber,colour\n', { units: SI });
    expect(bad).toMatchObject({ ok: false, problems: [{ line: 1, column: 'colour' }] });
    expect(importCatalogCsv(doc(), 'maker\n', { units: SI })).toMatchObject({
      ok: false,
      problems: [{ line: 1, message: /no "family" column/ }, { line: 1 }],
    });
    expect(importCatalogCsv(doc(), '', { units: SI })).toMatchObject({ ok: false });
    expect(importCatalogCsv(doc(), 'family,maker,partNumber\n', { units: SI })).toMatchObject({
      ok: false,
      problems: [{ message: /no rows/ }],
    });
    const many = ['family,maker,partNumber', ...Array(MAX_CATALOG_ENTRIES + 1).fill('generic,A,B')];
    const r = importCatalogCsv(doc(), many.join('\n'), { units: SI });
    expect(r).toMatchObject({ ok: false, problems: [{ message: /more than 2000 rows/ }] });
  });

  it('does not count empty lines against the row limit, and keeps line numbers right', () => {
    const rows = Array(MAX_CATALOG_ENTRIES).fill('generic,A,B');
    const spaced = ['family,maker,partNumber', '', ...rows.flatMap((r) => [r, '']), ''];
    const r = importCatalogCsv(doc(), spaced.join('\r\n'), { units: SI });
    expect(r.ok && r.entries.length).toBe(MAX_CATALOG_ENTRIES);
    expect(parseCsv('a\n\n\nb\n').map((x) => [x.line, x.fields])).toEqual([
      [1, ['a']],
      [4, ['b']],
    ]);
    // A quoted empty field is a record, not an empty line.
    expect(parseCsv('a\n""\n').map((x) => x.fields)).toEqual([['a'], ['']]);
    expect(errorOf('a\n\n\nb\n', { rows: 0 })).toMatchObject({ line: 4, message: /more than 0/ });
  });

  it('refuses bidirectional controls in short fields, with the line and column', () => {
    const csv = [
      'family,maker,partNumber,description',
      'generic,Acme\u202E,A1,',
      'generic,Acme,A\u2066 2\u2069,',
      'generic,Acme,A3,\u05e9\u05dc\u05d5\u05dd',
    ].join('\n');
    const r = importCatalogCsv(doc(), csv, { units: SI });
    expect(r).toMatchObject({
      ok: false,
      problems: [
        { line: 2, column: 'maker', message: /bidirectional/ },
        { line: 3, column: 'partNumber', message: /bidirectional/ },
      ],
    });
    if (!r.ok) expect(r.problems).toHaveLength(2);
  });

  it('refuses a negative rating where the value is a magnitude', () => {
    const r = importCatalogCsv(
      doc(),
      'family,maker,partNumber,dynamicLoad,limitingSpeed\nbearing,Acme,A1,-5.1 kN,-3000 rpm\n',
      { units: SI },
    );
    expect(r).toMatchObject({
      ok: false,
      problems: [
        { line: 2, column: 'dynamicLoad', message: /not below zero/ },
        { line: 2, column: 'limitingSpeed', message: /not below zero/ },
      ],
    });
  });

  it('keeps formula-looking text as text; the BOM writer guards it on the way out', () => {
    const r = importCatalogCsv(doc(), 'family,maker,partNumber\ngeneric,=HYPERLINK(1),@SUM(1)\n', {
      units: SI,
    });
    expect(r.ok && r.entries[0]!.maker).toBe('=HYPERLINK(1)');
  });
});

describe('the datasheet form', () => {
  it('round trips an entry through its text fields', () => {
    const r = importCatalogCsv(
      doc(),
      `${HEADER}\nbearing,Acme,6001,,12,28,8,5.1 kN,2.36 kN,15000 rpm,shield,22 g,Acme,,2026-10-01,no,,,\n`,
      { units: SI },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = r.entries[0]!;
    const again = readEntryFields(entryFields(entry), entry.id, US);
    expect(again.ok && again.entry).toEqual(entry);
  });

  it('round trips tiny and huge numbers', () => {
    const fields = {
      family: 'motor',
      maker: 'A',
      partNumber: 'B',
      inductance: '0.000000123 H',
      kv: '150 rpm/V',
      rotorInertia: '1.5e-7 kg*m^2',
    };
    const r = readEntryFields(fields, 'entry#1', SI);
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
    if (!r.ok) return;
    const again = readEntryFields(entryFields(r.entry), 'entry#1', SI);
    expect(again.ok && again.entry).toEqual(r.entry);
  });

  it('refuses a field name it does not read', () => {
    const r = readEntryFields(
      { family: 'generic', maker: 'A', partNumber: 'B', x: '1' },
      'entry#1',
      SI,
    );
    expect(r).toMatchObject({ ok: false, problems: [{ column: 'x' }] });
  });
});
