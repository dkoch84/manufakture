import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { validate3mf } from '@manufakture/io';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import type { RegenView } from '../model/model';
import { boxDocument, mm } from '../variables/box.test-fixture';
import { boxBody } from '../viewport/testMeshes';
import { configurationFileBase, exportConfigurations } from './configExport';
import type { Exchanger } from './exchange';

/** The box, with #w configured in rows 600, 800 and 1000 (in mm). */
function shelf(): ManufaktureDocument {
  let doc = boxDocument();
  const commands: Command[] = [
    {
      type: 'setConfigParameter',
      parameter: { id: 'cp#1', name: 'Width', kind: 'variable', variable: 'w' },
    },
    ...['600', '800', '1000'].map((w, i): Command => ({
      type: 'setConfigRow',
      row: { id: `cfg#${i + 1}`, name: w, values: { 'cp#1': mm(`${w} mm`) } },
    })),
  ];
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return { ...doc, name: 'Shelf' };
}

const feature = (featureId: string, status: FeatureResult['status'] = 'ok'): FeatureResult => ({
  featureId,
  kind: 'extrude',
  index: 0,
  status,
  errors: status === 'error' ? [{ code: 'invalid', message: 'too thin' } as never] : [],
  warnings: [],
  references: [],
  cached: false,
  ms: 1,
});

/**
 * A fake kernel: a regen of a document makes one box body whose X size is its #w (plus a
 * second body when `two`), and the exchanger meshes the body the last regen made.
 */
function fakeKernel(options: { two?: boolean; failOn?: string; drop?: number } = {}) {
  let width = 0;
  let generation = 0;
  let drops = options.drop ?? 0;
  const regen = vi.fn(async (doc: ManufaktureDocument): Promise<RegenView | null> => {
    if (drops > 0) {
      drops--;
      return null;
    }
    const w = doc.variables.find((v) => v.name === 'w')!.expression.source;
    width = parseFloat(w);
    const failing = options.failOn === w;
    const body = (id: string) => ({
      bodyId: id,
      creator: id,
      solids: 1,
      view: boxBody({ id: `part#1/${id}` }),
    });
    return {
      generation: ++generation,
      ms: 1,
      parts: [
        {
          partId: 'part#1',
          features: [feature('extrude#1', failing ? 'error' : 'ok')],
          bodies: options.two ? [body('extrude#1'), body('extrude#2')] : [body('extrude#1')],
        },
      ],
    };
  });
  const exchanger: Exchanger = {
    bodies: () => [],
    tessellate: vi.fn(async (ids: readonly string[], _d, names?: ReadonlyMap<string, string>) => ({
      ok: true as const,
      value: ids.map((id, i) => ({
        name: names?.get(id) ?? id,
        mesh: boxBody({ min: [0, i * 30, 0], size: [width, 20, 18] }).mesh,
      })),
    })),
    exportStep: vi.fn(async () => ({
      ok: true as const,
      value: new TextEncoder().encode('ISO-10303-21;'),
    })),
    importStep: vi.fn(),
    retain: vi.fn(() => []),
    reimport: vi.fn(async () => []),
  };
  return { regen, exchanger };
}

describe('exporting every configuration', () => {
  it('writes one file per row, named <document>-<row>, each from its own regen', async () => {
    const k = fakeKernel();
    const progress: string[] = [];
    const onFile = vi.fn();
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      partId: 'part#1',
      format: '3mf',
      onProgress: (p) => progress.push(`${p.index + 1}/${p.count} ${p.row.name}`),
      onFile,
    });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.name)).toEqual([
      'Shelf-600.3mf',
      'Shelf-800.3mf',
      'Shelf-1000.3mf',
    ]);
    expect(progress).toEqual(['1/3 600', '2/3 800', '3/3 1000']);
    expect(onFile).toHaveBeenCalledTimes(3);
    expect(r.message).toBe(
      'Exported 3 of 3 configurations: Shelf-600.3mf, Shelf-800.3mf, Shelf-1000.3mf.',
    );
    // Each regen had its row applied and active.
    expect(k.regen.mock.calls.map(([d]) => d.configurations!.active)).toEqual([
      'cfg#1',
      'cfg#2',
      'cfg#3',
    ]);
    const sizes = r.files.map((f) => {
      const report = validate3mf(f.bytes);
      expect(report.problems).toEqual([]);
      const positions = report.parsed!.objects[0]!.mesh.positions;
      let max = -Infinity;
      for (let i = 0; i < positions.length; i += 3) max = Math.max(max, positions[i]!);
      return max;
    });
    expect(sizes).toEqual([600, 800, 1000]);
  });

  it('writes STL and STEP too, and only the rows asked for', async () => {
    const k = fakeKernel();
    const stl = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      rowIds: ['cfg#3', 'cfg#1'],
      partId: 'part#1',
      format: 'stl',
    });
    expect(stl.files.map((f) => f.name)).toEqual(['Shelf-1000.stl', 'Shelf-600.stl']);
    const step = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      rowIds: ['cfg#2'],
      partId: 'part#1',
      format: 'step',
    });
    expect(step.files.map((f) => f.name)).toEqual(['Shelf-800.step']);
  });

  it('skips the bodies asked, and says so when nothing is left', async () => {
    const k = fakeKernel({ two: true });
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      rowIds: ['cfg#1'],
      partId: 'part#1',
      format: '3mf',
      skip: new Set(['part#1/extrude#2']),
    });
    expect(k.exchanger.tessellate).toHaveBeenCalledWith(
      ['part#1/extrude#1'],
      expect.anything(),
      new Map([['part#1/extrude#1', 'Body 1']]),
    );
    expect(r.ok).toBe(true);
    const none = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      rowIds: ['cfg#1'],
      partId: 'part#1',
      format: '3mf',
      skip: new Set(['part#1/extrude#1', 'part#1/extrude#2']),
    });
    expect(none.ok).toBe(false);
    expect(none.files).toEqual([]);
    expect(none.message).toBe(
      'Exported 0 of 1 configuration. 600: There is nothing to export: every body is hidden or not chosen.',
    );
  });

  it('reports a row whose features fail, and exports the others', async () => {
    const k = fakeKernel({ failOn: '800 mm' });
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      partId: 'part#1',
      format: '3mf',
    });
    expect(r.ok).toBe(false);
    expect(r.files.map((f) => f.name)).toEqual(['Shelf-600.3mf', 'Shelf-1000.3mf']);
    expect(r.failures.map((f) => [f.row.name, f.message])).toEqual([
      ['800', 'Extrude 1 fails in this configuration: too thin.'],
    ]);
  });

  it('asks again once when the kernel drops a regen', async () => {
    const k = fakeKernel({ drop: 1 });
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      rowIds: ['cfg#1'],
      partId: 'part#1',
      format: 'stl',
    });
    expect(r.ok).toBe(true);
    expect(k.regen).toHaveBeenCalledTimes(2);
    const dropped = fakeKernel({ drop: 2 });
    const r2 = await exportConfigurations(dropped.exchanger, dropped.regen, {
      document: shelf(),
      rowIds: ['cfg#1'],
      partId: 'part#1',
      format: 'stl',
    });
    expect(r2.failures[0]!.message).toBe('The kernel dropped the regen; try again.');
  });

  it('stops when cancelled, keeping the files made so far', async () => {
    const k = fakeKernel();
    const controller = new AbortController();
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: shelf(),
      partId: 'part#1',
      format: '3mf',
      signal: controller.signal,
      onFile: () => controller.abort(),
    });
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.files.map((f) => f.name)).toEqual(['Shelf-600.3mf']);
    expect(k.regen).toHaveBeenCalledTimes(1);
    expect(r.message).toBe('Export cancelled after 1 of 3 configurations (Shelf-600.3mf).');
  });

  it('has nothing to do without rows', async () => {
    const k = fakeKernel();
    const r = await exportConfigurations(k.exchanger, k.regen, {
      document: boxDocument(),
      partId: 'part#1',
      format: '3mf',
    });
    expect(r).toMatchObject({ ok: false, message: 'There are no configurations to export.' });
    expect(configurationFileBase('Shelf', '600 mm')).toBe('Shelf-600 mm');
  });
});
