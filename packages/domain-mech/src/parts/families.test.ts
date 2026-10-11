import {
  CATALOG_FAMILIES,
  CatalogEntrySchema,
  FIELD_NAME_PATTERN,
  createDocument,
  type CatalogEntry,
} from '@manufakture/core';
import { isPhysicalKind } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ENTRIES,
  builtinRef,
  copyBuiltin,
  latestBuiltin,
  refText,
  resolveEntry,
} from './catalog';
import {
  DIMENSION_NAMES,
  FAMILY_SCHEMAS,
  entryProblems,
  familySchema,
  migrateEntry,
} from './families';

describe('the family field schemas', () => {
  it('cover every family once, with valid, unique field names', () => {
    expect(FAMILY_SCHEMAS.map((s) => s.family).sort()).toEqual([...CATALOG_FAMILIES].sort());
    for (const s of FAMILY_SCHEMAS) {
      const names = s.fields.map((f) => f.name);
      expect(new Set(names).size, s.family).toBe(names.length);
      for (const n of names) expect(n, `${s.family}.${n}`).toMatch(FIELD_NAME_PATTERN);
      for (const d of s.dimensions) expect(DIMENSION_NAMES).toContain(d.name);
      // Motors and controllers (T9.2b), cells, packs and BMS (T9.2c), bearings, belts, pulleys,
      // gears and rope (T9.2d), wire, connectors, fuses, switches and resistors (T9.2e) are at 2;
      // only the generic family is still at 1.
      expect(s.fieldsVersion, s.family).toBe(s.family === 'generic' ? 1 : 2);
    }
  });

  it('give conventions and bases only to numbers, and choices only to texts', () => {
    for (const s of FAMILY_SCHEMAS) {
      for (const f of s.fields) {
        if (f.conventions || f.basis) expect(isPhysicalKind(f.kind), f.name).toBe(true);
        if (f.options) expect(f.kind, f.name).toBe('text');
        if (f.unit) expect(f.kind, f.name).toBe('number');
      }
    }
  });

  it('list the ratings a bearing line relies on: C, C0 and n at least, the closure exact', () => {
    const bom = familySchema('bearing')
      .fields.filter((f) => f.bom)
      .map((f) => [f.symbol ?? f.name, f.bom]);
    expect(bom).toEqual([
      ['C', 'at-least'],
      ['C0', 'at-least'],
      ['n', 'at-least'],
      ['closure', 'equals'],
    ]);
  });
});

describe('the built-in sample entries', () => {
  it('are valid entries of their family, unverified, sourced, http or https only', () => {
    expect(BUILTIN_ENTRIES.length).toBeGreaterThanOrEqual(3);
    for (const e of BUILTIN_ENTRIES) {
      const rest: Partial<typeof e> = { ...e };
      delete rest.deprecated;
      const asUser = { ...rest, id: 'entry#1' } as CatalogEntry;
      const parsed = CatalogEntrySchema.safeParse(asUser);
      expect(parsed.success, `${e.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(entryProblems(asUser), e.id).toEqual([]);
      expect(e.verified, e.id).toBe(false);
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      for (const s of e.sources) if (s.url) expect(s.url).toMatch(/^https?:\/\//);
    }
  });

  it('resolve by pinned version, and refuse what this build does not have', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    const ref = builtinRef('bearing/skf-6001-2rsh')!;
    expect(ref).toEqual({ source: 'builtin', id: 'bearing/skf-6001-2rsh', version: 1 });
    const r = resolveEntry(doc, ref);
    expect(r.ok && r.entry.partNumber).toBe('6001-2RSH');
    expect(r.ok && r.newer).toBeUndefined();
    const missing = resolveEntry(doc, {
      source: 'builtin',
      id: 'bearing/skf-6001-2rsh',
      version: 99,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'unknown-entry' });
    expect(resolveEntry(doc, { source: 'document', id: 'entry#4' })).toMatchObject({
      ok: false,
      reason: 'unknown-entry',
    });
    expect(refText(ref)).toBe('bearing/skf-6001-2rsh v1');
    expect(latestBuiltin('nope/x')).toBeUndefined();
  });

  it('cannot carry a link of any scheme but http or https into a document', () => {
    const entry = copyBuiltin(latestBuiltin('bearing/skf-6005-2rsh')!, 'entry#1');
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'ftp://x',
    ]) {
      const bad = { ...entry, sources: [{ title: 'x', url, read: '2026-10-10' }] };
      expect(CatalogEntrySchema.safeParse(bad).success, url).toBe(false);
    }
  });

  it('copy into a user entry that remembers where it came from', () => {
    const copy = copyBuiltin(latestBuiltin('bearing/skf-6005-2rsh')!, 'entry#2');
    expect(copy.id).toBe('entry#2');
    expect(copy.derivedFrom).toEqual({
      source: 'builtin',
      id: 'bearing/skf-6005-2rsh',
      version: 1,
    });
    expect(CatalogEntrySchema.safeParse(copy).success).toBe(true);
  });
});

describe('checking an entry against its family', () => {
  const base = { ...copyBuiltin(latestBuiltin('bearing/skf-6001-2rsh')!, 'entry#1') };

  it('names a rating the family lacks, a wrong type, a bad choice, count or dimension', () => {
    const bad: CatalogEntry = {
      ...base,
      ratings: {
        ...base.ratings,
        kv: { value: 1 },
        dynamicLoad: { text: 'big' },
        type: { value: 3 },
        closure: { text: 'welded' },
      },
      dimensions: { innerDiameter: { value: -1 }, height: { value: 3 } },
      mass: { value: 0 },
    };
    const fields = entryProblems(bad).map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'kv',
        'dynamicLoad',
        'type',
        'closure',
        'dimensions.innerDiameter',
        'dimensions.height',
        'mass',
      ]),
    );
    const belt = copyBuiltin(latestBuiltin('belt/gates-5mgt-15')!, 'entry#2');
    expect(
      entryProblems({ ...belt, ratings: { minimumPulleyGrooves: { value: 2.5 } } })[0]?.message,
    ).toMatch(/whole/);
  });

  it('refuses negative magnitudes and bidirectional controls in short texts', () => {
    const bad: CatalogEntry = {
      ...base,
      maker: 'SKF\u202E',
      partNumber: '\u2067600',
      ratings: {
        ...base.ratings,
        dynamicLoad: { value: -5100 },
        limitingSpeed: { value: -1 },
        closure: { text: 'contact seal' },
      },
      sources: [{ title: 'Datasheet \u202D', read: '2026-10-10' }],
    };
    expect(entryProblems(bad)).toEqual([
      { field: 'maker', message: 'a bidirectional control character' },
      { field: 'partNumber', message: 'a bidirectional control character' },
      { field: 'sourceTitle', message: 'a bidirectional control character' },
      { field: 'dynamicLoad', message: 'dynamic load rating C is not below zero' },
      { field: 'limitingSpeed', message: expect.stringMatching(/is not below zero$/) },
    ]);
    // Zero and right-to-left letters are fine.
    expect(
      entryProblems({
        ...base,
        maker: '\u05e9\u05dc\u05d5\u05dd',
        ratings: { staticLoad: { value: 0 } },
      }),
    ).toEqual([]);
  });

  it('refuses fields written by a newer build rather than guessing', () => {
    expect(migrateEntry({ ...base, fieldsVersion: 7 })).toMatchObject({
      ok: false,
      reason: 'newer-fields',
    });
    // T9.2a's sample is at bearing fields version 1; T9.2d's version 2 only added fields.
    expect(migrateEntry(base)).toEqual({ ok: true, entry: { ...base, fieldsVersion: 2 } });
    const current = { ...base, fieldsVersion: 2 };
    expect(migrateEntry(current)).toEqual({ ok: true, entry: current });
  });
});
