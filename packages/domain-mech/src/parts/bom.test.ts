// The acceptance path of T9.2a without the kernel: a part added from a datasheet (CSV), placed in
// an assembly twice, listed in the BOM with its ratings and exported as CSV, plus counting, unknown
// entries, alternates and the formula guard.

import {
  applyCommand,
  createDocument,
  previewIds,
  type Command,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { formatRating } from '@manufakture/takeoff';
import { describe, expect, it } from 'vitest';
import { purchasedBom, purchasedBomCsv, withPurchasedRows, bomRatings } from './bom';
import { builtinRef, latestBuiltin } from './catalog';
import { importCatalogCsv, parseCsv } from './csv';
import { placePurchasedPart, stepBytes, uniqueName } from './place';

const SI: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

function withAssembly(doc: ManufaktureDocument): [ManufaktureDocument, string] {
  const [id] = previewIds(doc.nextIds, 'assembly');
  return [apply(doc, { type: 'addAssembly', assemblyId: id!, name: 'Machine' }), id!];
}

const CSV = [
  'family,maker,partNumber,dim.innerDiameter,dim.outerDiameter,dim.width,dynamicLoad,staticLoad,limitingSpeed,closure,mass',
  'bearing,SKF,6001-2RSH,12,28,8,5.1 kN,2.36 kN,3000 rpm,contact seal,22 g',
].join('\n');

describe('a purchased part from datasheet to bill of materials', () => {
  it('is added, placed in an assembly, listed with its ratings and exported', async () => {
    let doc = createDocument({ id: 'doc-bom', name: 'Trainer' });
    const imported = importCatalogCsv(doc, CSV, { units: SI });
    if (!imported.ok) throw new Error(JSON.stringify(imported.problems));
    doc = apply(doc, imported.command);
    const [withA, assemblyId] = withAssembly(doc);
    doc = withA;

    const placed = await placePurchasedPart(
      doc,
      { source: 'document', id: 'entry#1' },
      {
        assemblyId,
        alternates: [builtinRef('bearing/skf-6005-2rsh')!],
      },
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(placed).toMatchObject({
      partId: 'part#2',
      featureId: 'extension#1',
      useId: 'pp#1',
      instanceId: 'inst#1',
    });
    doc = apply(doc, placed.command);
    const part = doc.parts.find((p) => p.id === 'part#2')!;
    expect(part.name).toBe('Bearing SKF 6001-2RSH');
    expect(part.features[0]).toMatchObject({
      kind: 'extension',
      extension: 'mech.placeholder',
      operation: 'new',
      params: { entry: { source: 'document', id: 'entry#1' }, shape: 'ring', axis: 'z' },
      expressions: {
        outerDiameter: { source: '28 mm' },
        innerDiameter: { source: '12 mm' },
        width: { source: '8 mm' },
      },
    });
    // A second instance of the same part.
    const assembly = doc.assemblies[0]!;
    doc = apply(doc, {
      type: 'addInstance',
      assemblyId,
      instance: { ...assembly.instances[0]!, id: 'inst#2', name: 'Bearing 2', fixed: false },
    });

    const bom = purchasedBom(doc, { assemblyId });
    expect(bom.warnings).toEqual([]);
    expect(bom.rows).toHaveLength(1);
    const row = bom.rows[0]!;
    expect(row).toMatchObject({
      item: 'Bearing SKF 6001-2RSH',
      category: 'purchased',
      quantity: 2,
      flags: ['unverified'],
      alternates: ['SKF 6005-2RSH'],
    });
    expect(row.measures).toEqual([{ unit: 'mass', value: 0.044 }]);
    expect(row.ratings!.map(formatRating)).toEqual([
      'bore d 12 mm',
      'outside diameter D 28 mm',
      'width B 8 mm',
      'C at least 5100 N',
      'C0 at least 2360 N',
      'n at least 3000 rpm',
      'closure contact seal',
    ]);
    // Without an assembly the part studio counts once.
    expect(purchasedBom(doc).rows[0]!.quantity).toBe(1);

    const csv = withPurchasedRows(
      'Item,Size,Quantity,Total\r\nPine (parts),,4,1.2 bd ft\r\n',
      bom.rows,
      doc.units,
    );
    const records = parseCsv(csv);
    expect(records.map((r) => r.fields)).toEqual([
      ['Item', 'Size', 'Quantity', 'Total', 'Ratings', 'Alternates', 'Notes'],
      ['Pine (parts)', '', '4', '1.2 bd ft', '', '', ''],
      [
        'Bearing SKF 6001-2RSH',
        '',
        '2',
        '0.044 kg',
        'bore d 12 mm; outside diameter D 28 mm; width B 8 mm; C at least 5100 N; C0 at least 2360 N; n at least 3000 rpm; closure contact seal',
        'SKF 6005-2RSH',
        'catalog data not verified against the maker',
      ],
    ]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(withPurchasedRows('Item\r\n', [], doc.units)).toBe('Item\r\n');

    // The cut list's own cells carry document text as it is, control characters included: the
    // file is this program's, so they are kept, not refused as an untrusted file's would be.
    const odd = withPurchasedRows(
      'Item,Size,Quantity,Total\r\nPine\u0001 (parts),,4,1.2 bd ft\r\n',
      bom.rows,
      doc.units,
    );
    expect(parseCsv(odd, { keepControls: true })[1]!.fields).toEqual([
      'Pine\u0001 (parts)',
      '',
      '4',
      '1.2 bd ft',
      '',
      '',
      '',
    ]);
    expect(() => parseCsv(odd)).toThrow(/control character/);
  });

  it('flags a placeholder whose sizes no longer match its entry', async () => {
    let doc = createDocument({ id: 'doc-drift', name: 'Drift' });
    const placed = await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!);
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    expect(purchasedBom(doc).rows[0]!.flags).not.toContain('placeholder-drift');
    const part = doc.parts.find((p) => p.id === placed.partId)!;
    const feature = part.features[0] as ExtensionFeature;
    doc = apply(doc, {
      type: 'editFeature',
      partId: placed.partId,
      feature: {
        ...feature,
        expressions: {
          ...feature.expressions,
          width: { source: '13 mm', lengthUnit: 'mm', angleUnit: 'deg' },
        },
      },
    });
    const bom = purchasedBom(doc);
    expect(bom.rows[0]!.flags).toContain('placeholder-drift');
    expect(bom.warnings).toEqual([
      'pp#1 (Bearing SKF 6005-2RSH): placeholder sizes differ: width: 13.00 mm; bearing/skf-6005-2rsh v1 gives 12.00 mm',
    ]);
    expect(purchasedBomCsv(bom.rows, doc.units)).toMatch(
      /placeholder sizes differ from the catalog entry/,
    );
  });

  it('shows ratings in the document display units (US customary here)', () => {
    const entry = latestBuiltin('bearing/skf-6005-2rsh')!;
    const text = bomRatings(entry, { length: { unit: 'in' }, angle: { unit: 'deg' } }).map(
      formatRating,
    );
    expect(text).toContain('C at least 2675 lbf');
    expect(text).toContain('bore d 0.9843 in');
  });

  it('neutralises text a spreadsheet would run as a formula', async () => {
    let doc = createDocument({ id: 'd', name: 'D' });
    const imported = importCatalogCsv(
      doc,
      'family,maker,partNumber,dim.length,dim.width,dim.height\ngeneric,=HYPERLINK(1),+SUM(1),10,10,10\n',
      { units: SI },
    );
    if (!imported.ok) throw new Error(JSON.stringify(imported.problems));
    doc = apply(doc, imported.command);
    const placed = await placePurchasedPart(
      doc,
      { source: 'document', id: 'entry#1' },
      { name: '-cmd|x' },
    );
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    const csv = purchasedBomCsv(purchasedBom(doc).rows, doc.units);
    const cells = parseCsv(csv)[1]!.fields;
    expect(cells[0]).toBe('Other purchased part =HYPERLINK(1) +SUM(1)');
    for (const c of cells) expect(c).not.toMatch(/^[=+\-@]/);
    const named = purchasedBomCsv(
      [{ ...purchasedBom(doc).rows[0]!, item: '=1+1', alternates: ['@x'] }],
      doc.units,
    );
    const guarded = parseCsv(named)[1]!.fields;
    expect(guarded[0]).toBe("'=1+1");
    expect(guarded[5]).toBe("'@x");
  });

  it('counts unmodelled parts by quantity, and warns about what it cannot count', () => {
    let doc = createDocument({ id: 'd', name: 'D' });
    doc = apply(doc, {
      type: 'setVariable',
      name: 'screws',
      expression: { source: '4', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const ref = builtinRef('belt/gates-5mgt-15')!;
    doc = apply(doc, {
      type: 'batch',
      commands: [
        {
          type: 'setPurchasedUse',
          use: {
            id: 'pp#1',
            entry: ref,
            quantity: { source: '2 * #screws', lengthUnit: 'mm', angleUnit: 'deg' },
            alternates: [],
          },
        },
        {
          type: 'setPurchasedUse',
          use: {
            id: 'pp#2',
            entry: { source: 'builtin', id: 'motor/none', version: 3 },
            alternates: [],
            name: 'Mystery motor',
          },
        },
        {
          type: 'setPurchasedUse',
          use: {
            id: 'pp#3',
            entry: ref,
            part: 'part#9',
            alternates: [{ source: 'document', id: 'entry#5' }],
          },
        },
      ],
    });
    const bom = purchasedBom(doc);
    expect(bom.rows.map((r) => [r.item, r.quantity, r.flags])).toEqual([
      [
        'Timing belt Gates 5MGT, 15 mm wide (long-length belting)',
        8,
        ['part-missing', 'unverified'],
      ],
      ['Mystery motor', 1, ['unknown-entry']],
    ]);
    expect(bom.rows[0]!.alternates).toEqual(['entry#5 (not found)']);
    expect(bom.warnings).toEqual([
      'pp#2 (Mystery motor): this build has no catalog entry motor/none v3',
      'pp#3 (belt/gates-5mgt-15 v1): its part part#9 is gone; not counted',
    ]);
  });
});

describe('placing', () => {
  it('refuses an entry without the dimensions its placeholder needs, or an unknown one', async () => {
    let doc = createDocument({ id: 'd', name: 'D' });
    const r = importCatalogCsv(doc, 'family,maker,partNumber\nbearing,A,B\n', { units: SI });
    if (!r.ok) throw new Error('import');
    doc = apply(doc, r.command);
    expect(await placePurchasedPart(doc, { source: 'document', id: 'entry#1' })).toMatchObject({
      ok: false,
      message: /no outerDiameter, innerDiameter, width/,
    });
    expect(await placePurchasedPart(doc, { source: 'document', id: 'entry#2' })).toMatchObject({
      ok: false,
    });
    expect(
      await placePurchasedPart(doc, builtinRef('belt/gates-5mgt-15')!, {
        assemblyId: 'assembly#7',
      }),
    ).toMatchObject({ ok: false });
  });

  it('imports a STEP entry as a reference body, after checking it', async () => {
    let doc = createDocument({ id: 'd', name: 'D' });
    const step = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
    const blob = btoa(step);
    doc = apply(doc, {
      type: 'setCatalogEntry',
      entry: {
        id: 'entry#1',
        version: 1,
        family: 'motor',
        fieldsVersion: 1,
        maker: 'A',
        partNumber: 'M 1/2',
        description: '',
        ratings: {},
        geometry: { kind: 'step', blob },
        sources: [],
        verified: false,
      },
    });
    const placed = await placePurchasedPart(doc, { source: 'document', id: 'entry#1' });
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    expect(doc.parts[1]!.features[0]).toMatchObject({
      kind: 'import',
      operation: 'reference',
      source: { format: 'step', fileName: 'M-1-2.step', size: step.length, data: blob },
    });
    expect(stepBytes(btoa('<html>'))).toMatchObject({ ok: false, message: /not a STEP/ });
    // The full check, whoever wrote the entry: a NUL byte, a missing section, a cut-off end.
    expect(stepBytes(btoa(step.replace('DATA;', 'DA\0TA;')))).toMatchObject({
      ok: false,
      message: /line 4: a NUL byte/,
    });
    expect(stepBytes(btoa(step.replace('DATA;', 'DADA')))).toMatchObject({
      ok: false,
      message: /no DATA; section/,
    });
    expect(stepBytes(btoa(step.replace('END-ISO-10303-21;', '')))).toMatchObject({
      ok: false,
      message: /does not end with END-ISO-10303-21/,
    });
    expect(stepBytes('!!')).toMatchObject({ ok: false, message: /base64/ });
    expect(stepBytes('')).toMatchObject({ ok: false, message: /empty/ });

    // A shared document's entry with a broken file is refused at placement, not placed.
    const broken = apply(doc, {
      type: 'setCatalogEntry',
      entry: {
        ...doc.mech!.catalog!.find((e) => e.id === 'entry#1')!,
        id: 'entry#2',
        geometry: { kind: 'step', blob: btoa('ISO-10303-21;\nHEADER;\nENDSEC;\n') },
      },
    });
    expect(await placePurchasedPart(broken, { source: 'document', id: 'entry#2' })).toMatchObject({
      ok: false,
      message: /no DATA; section/,
    });
  });

  it('names instances uniquely however long the name, and always ends', async () => {
    const long = 'L'.repeat(200);
    expect(uniqueName(long, new Set())).toBe(long);
    const second = uniqueName(long, new Set([long]));
    expect(second).toBe(`${'L'.repeat(196)} (2)`);
    expect(uniqueName(long, new Set([long, second]))).toBe(`${'L'.repeat(196)} (3)`);
    // A surrogate pair is never cut in half.
    expect(
      uniqueName(`${'L'.repeat(195)}\u{1F600}x`, new Set([`${'L'.repeat(195)}\u{1F600}x`])),
    ).toBe(`${'L'.repeat(195)} (2)`);

    const [start, assemblyId] = withAssembly(createDocument({ id: 'd', name: 'D' }));
    let doc = start;
    const [partId] = previewIds(doc.nextIds, 'part');
    doc = apply(doc, { type: 'addPart', partId: partId!, name: 'Other' });
    doc = apply(doc, {
      type: 'addInstance',
      assemblyId,
      instance: {
        id: 'inst#1',
        name: long,
        source: { part: partId! },
        fixed: true,
        suppressed: false,
        pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      },
    });
    const ref = builtinRef('bearing/skf-6005-2rsh')!;
    for (const expected of [`${'L'.repeat(196)} (2)`, `${'L'.repeat(196)} (3)`]) {
      const placed = await placePurchasedPart(doc, ref, { assemblyId, name: long });
      if (!placed.ok) throw new Error(placed.message);
      doc = apply(doc, placed.command);
      const assembly = doc.assemblies.find((a) => a.id === assemblyId)!;
      expect(assembly.instances.find((i) => i.id === placed.instanceId)!.name).toBe(expected);
    }
  });

  it('refuses a name that holds a bidirectional control character', async () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    expect(
      await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!, {
        name: 'Bearing \u202Egnp.exe',
      }),
    ).toMatchObject({ ok: false, message: /bidirectional/ });
  });
});
