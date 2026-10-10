// Purchased parts with ratings through the MCP server (T9.2a): the parts resource, a user entry
// from a datasheet and a built-in one, each placed as a part studio with a `mech.placeholder`
// feature and used in an assembly, then the bill of materials with their ratings in `bom-csv`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from '@manufakture/domain-mech';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTS_URI } from '../../src/resources';
import { harness, value, type Data, type Harness } from '../harness';

let h: Harness;
let sessionId: string;
let spoolPart: string;
const call = async (tool: string, args: Record<string, unknown> = {}) =>
  value(await h.call(tool, args));
const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

beforeAll(async () => {
  h = await harness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

const placeholder = (entry: Record<string, unknown>, sizes: Record<string, number>) => ({
  id: 'extension#1',
  kind: 'extension',
  name: 'Placeholder',
  suppressed: false,
  extension: 'mech.placeholder',
  schemaVersion: 1,
  operation: 'new',
  dependsOn: [],
  references: [],
  expressions: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, mm(v)])),
  params: { entry, shape: 'ring' },
});

describe('purchased parts with ratings', () => {
  it('serves the parts catalog as a resource', async () => {
    const { resources } = await h.client.listResources();
    expect(resources.map((r) => r.uri)).toContain(PARTS_URI);
    const first = (await h.client.readResource({ uri: PARTS_URI })).contents[0] as { text: string };
    const tables = JSON.parse(first.text) as Data;
    expect(tables.notice).toMatch(/does not certify/);
    expect(tables.families.map((f: Data) => f.family)).toContain('bearing');
    const entry = tables.entries.find((e: Data) => e.id === 'bearing/skf-6005-2rsh');
    expect(entry).toMatchObject({ version: 1, verified: false });
    expect(tables.placeholder.extension).toBe('mech.placeholder');
  });

  it('places a datasheet entry and a built-in one, and lists both in bom-csv with ratings', async () => {
    sessionId = (await call('open_session', { documentId: h.documentId })).sessionId;
    const user = {
      id: 'entry#1',
      version: 1,
      family: 'bearing',
      fieldsVersion: 1,
      maker: '=Acme',
      partNumber: '6001-2RS',
      description: 'From the datasheet',
      ratings: {
        dynamicLoad: { value: 5100 },
        staticLoad: { value: 2360 },
        limitingSpeed: { value: (3000 * 2 * Math.PI) / 60 },
      },
      dimensions: {
        innerDiameter: { value: 12 },
        outerDiameter: { value: 28 },
        width: { value: 8 },
      },
      sources: [{ title: 'Acme datasheet', url: 'https://acme.example/6001', read: '2026-10-10' }],
      verified: false,
    };
    // An alternate whose maker is a formula: the alternates cell would lead with `=`.
    const formula = {
      ...user,
      id: 'entry#2',
      maker: '=HYPERLINK("https://evil.example","x")',
      partNumber: '6001',
    };
    const parts = await call('apply', {
      sessionId,
      label: 'Add the bearings',
      commands: [
        { type: 'setCatalogEntry', entry: user },
        { type: 'setCatalogEntry', entry: formula },
        { type: 'addPart', partId: 'part#$a', name: 'Spool bearing' },
        { type: 'addPart', partId: 'part#$b', name: 'Idler bearing' },
      ],
    });
    const s = parts.symbols as Record<string, string>;
    spoolPart = s.$a!;
    const builtin = { source: 'builtin', id: 'bearing/skf-6005-2rsh', version: 1 };
    const r = await call('apply', {
      sessionId,
      label: 'Place the bearings',
      commands: [
        {
          type: 'addFeature',
          partId: s.$a,
          feature: placeholder(
            { source: 'document', id: 'entry#1' },
            { outerDiameter: 28, innerDiameter: 12, width: 8 },
          ),
        },
        {
          type: 'addFeature',
          partId: s.$b,
          feature: placeholder(builtin, { outerDiameter: 47, innerDiameter: 25, width: 12 }),
        },
        {
          type: 'setPurchasedUse',
          use: {
            id: 'pp#1',
            entry: { source: 'document', id: 'entry#1' },
            part: s.$a,
            alternates: [{ source: 'document', id: 'entry#2' }, builtin],
          },
        },
        {
          type: 'setPurchasedUse',
          use: { id: 'pp#2', entry: builtin, part: s.$b, alternates: [] },
        },
        { type: 'addAssembly', assemblyId: 'assembly#$m', name: 'Machine' },
        ...['$i1', '$i2'].map((i, n) => ({
          type: 'addInstance',
          assemblyId: 'assembly#$m',
          instance: {
            id: `inst#${i}`,
            name: `Spool bearing ${n + 1}`,
            source: { part: s.$a },
            fixed: n === 0,
            suppressed: false,
            pose: { translation: [0, 0, 20 * n], rotation: [0, 0, 0, 1] },
          },
        })),
        {
          type: 'addInstance',
          assemblyId: 'assembly#$m',
          instance: {
            id: 'inst#$i3',
            name: 'Idler bearing',
            source: { part: s.$b },
            fixed: false,
            suppressed: false,
            pose: { translation: [100, 0, 0], rotation: [0, 0, 0, 1] },
          },
        },
      ],
    });
    const assemblyId = (r.symbols as Record<string, string>)['$m']!;
    expect(value(await h.call('get_errors', { sessionId })).errors).toEqual([]);

    const bom = await call('export', { sessionId, format: 'bom-csv', assemblyId, fileName: 'bom' });
    expect(bom.warnings).toEqual([]);
    const csv = readFileSync(path.join(h.outputDir, bom.files[0].name), 'utf8');
    const rows = parseCsv(csv).map((x) => x.fields);
    expect(rows[0]).toEqual([
      'Item',
      'Size',
      'Quantity',
      'Total',
      'Ratings',
      'Alternates',
      'Notes',
    ]);
    const spool = rows.find((x) => x[0]!.includes('6001-2RS'))!;
    // A maker that looks like a formula stays text: the cell does not start with it.
    expect(spool[0]).toBe('Bearing =Acme 6001-2RS');
    expect(spool[2]).toBe('2');
    expect(spool[4]).toContain('C at least 5100 N; C0 at least 2360 N; n at least 3000 rpm');
    // The alternates cell starts with the formula maker, so it is written with a leading quote.
    expect(spool[5]).toBe(`'=HYPERLINK("https://evil.example","x") 6001; SKF 6005-2RSH`);
    expect(spool[6]).toMatch(/not verified/);
    const idler = rows.find((x) => x[0] === 'Bearing SKF 6005-2RSH')!;
    expect(idler.slice(2, 5)).toEqual([
      '1',
      '0.081 kg',
      expect.stringContaining('C at least 11900 N'),
    ]);
    for (const row of rows) for (const cell of row) expect(cell).not.toMatch(/^[=+\-@]/);
  });

  it('warns by id when a placeholder no longer matches its entry', async () => {
    await call('apply', {
      sessionId,
      label: 'Widen the placeholder',
      commands: [
        {
          type: 'editFeature',
          partId: spoolPart,
          feature: placeholder(
            { source: 'document', id: 'entry#1' },
            { outerDiameter: 28, innerDiameter: 12, width: 9 },
          ),
        },
      ],
    });
    const bom = await call('export', { sessionId, format: 'bom-csv', fileName: 'drift' });
    expect(bom.warnings).toEqual(['pp#1: placeholder sizes differ from the catalog entry.']);
  });
});
