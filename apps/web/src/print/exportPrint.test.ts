// Export for printing: a setup's items oriented and packed onto the plate as a coloured 3MF (or
// one STL per body), refused when bed fit fails, an item does not resolve or the copies need a
// second plate; and one file per configuration row.

import { type Command, type ManufaktureDocument, type PrintItem } from '@manufakture/core';
import {
  buildMeshes,
  meshProperties,
  parseStl,
  validate3mf,
  type ParsedThreeMf,
} from '@manufakture/io';
import type { MeshData } from '@manufakture/kernel';
import { checkBedFit, findPrinter } from '@manufakture/print';
import { describe, expect, it, vi } from 'vitest';
import type { PartModel, RegenView } from '../model/model';
import type { Exchanger } from '../io/exchange';
import { editSetupCommand } from './commands';
import {
  exportPrintConfigurations,
  exportPrintSetup,
  exportRefusal,
  MAX_PLATE_COPIES,
  printFileBase,
} from './exportPrint';
import type { PrintIssue } from './issues';
import { apply, boxPart, partsDocument, setupOf, withSetup } from './print.test-fixture';
import { resolveSetup } from './resolve';
import { REFUSED_REVIEWS, agentSource } from '../io/exportGate.test-fixture';
import { UNREVIEWED_EXPORT } from '@manufakture/io';

/** Main: the export gate (T8.3c) lets every export here through. */
const MAIN = { id: 'main' };

const UNITS = partsDocument().units;
const x1c = findPrinter('bambu-x1c')!;

/** Meshes the kernel would make: the view meshes of `parts`, by view id. */
function fakeExchanger(parts: () => readonly PartModel[]) {
  return {
    tessellate: vi.fn(
      async (ids: readonly string[], _d: unknown, names?: ReadonlyMap<string, string>) => {
        const views = parts().flatMap((p) => p.bodies.map((b) => b.view));
        return {
          ok: true as const,
          value: ids.map((id) => ({
            name: names?.get(id) ?? id,
            mesh: views.find((v) => v.id === id)!.mesh as MeshData,
          })),
        };
      },
    ),
  } satisfies Pick<Exchanger, 'tessellate'>;
}

/** A two-body part: a 10 x 20 x 30 block and a 10 x 10 x 5 pad beside it, named and coloured. */
function twoColour(copies = 2, orientation?: PrintItem['orientation']) {
  const { doc: base, setupId } = withSetup(partsDocument(), [
    {
      part: 'part#1',
      edit: (item) => ({ ...item, copies, ...(orientation ? { orientation } : {}) }),
    },
  ]);
  let doc = base;
  doc = apply(doc, { type: 'renameDocument', name: 'Jig' });
  // Body names and colours as the user would set them (set directly: these test parts have no
  // features for `setBodyProps` to check the bodies against).
  doc = {
    ...doc,
    parts: doc.parts.map((p) =>
      p.id === 'part#1'
        ? {
            ...p,
            bodies: [
              { id: 'extrude#1', name: 'Block', color: '#ff0000' },
              { id: 'extrude#3', name: 'Pad', color: '#0000ff' },
            ],
          }
        : p,
    ),
  };
  const parts = [
    boxPart('part#1', [
      { bodyId: 'extrude#1', size: [10, 20, 30] },
      { bodyId: 'extrude#3', min: [10, 0, 0], size: [10, 10, 5] },
    ]),
  ];
  return { doc, setupId, parts };
}

function items(parsed: ParsedThreeMf) {
  return buildMeshes(parsed).map((m) => ({ ...m, box: meshProperties(m.mesh).boundingBox! }));
}

describe('exportPrintSetup', () => {
  it('writes a coloured 3MF: one object per copy with a part per body, packed on the plate', async () => {
    const { doc, setupId, parts } = twoColour(2);
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const ex = fakeExchanger(() => parts);
    const r = await exportPrintSetup(ex, resolved, {
      source: MAIN,
      documentName: doc.name,
      units: UNITS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((f) => [f.name, f.type])).toEqual([['Jig-Plate 1.3mf', 'model/3mf']]);
    expect(r.message).toMatch(
      /^Exported Jig-Plate 1\.3mf \(.*\): 2 copies of 1 item on the Bambu Lab X1 Carbon's plate\.$/,
    );
    // Meshed once per body, at the normal export tolerance.
    expect(ex.tessellate).toHaveBeenCalledTimes(1);
    expect(ex.tessellate.mock.calls[0]![0]).toEqual(['part#1/extrude#1', 'part#1/extrude#3']);
    expect(ex.tessellate.mock.calls[0]![1]).toEqual({ linear: 0.02, angular: 0.25 });

    const report = validate3mf(r.value[0]!.bytes);
    expect(report.problems).toEqual([]);
    const parsed = report.parsed!;
    expect(parsed.colorGroups.map((g) => g.colors)).toEqual([['#FF0000'], ['#0000FF']]);
    // Per copy: the two bodies' meshes and a components object holding them, which the build
    // item places; the slicer keeps a two-colour part together that way.
    expect(parsed.objects.map((o) => o.name)).toEqual([
      'Block',
      'Pad',
      'Part 1',
      'Block',
      'Pad',
      'Part 1',
    ]);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.modelSettings!.map((s) => s.metadata.name)).toEqual(['Part 1', 'Part 1']);
    expect(
      parsed.modelSettings![0]!.parts.map((p) => [p.metadata.name, p.metadata.extruder]),
    ).toEqual([
      ['Block', '1'],
      ['Pad', '2'],
    ]);
    const built = items(parsed);
    expect(built).toHaveLength(4);
    for (const m of built) {
      expect(checkBedFit(x1c, { box: m.box }).fits).toBe(true);
      expect(m.box.min[2]).toBeCloseTo(0, 5);
    }
    // The two copies side by side, 5 mm apart, each 20 x 20 as oriented (as modelled here).
    const [a, b] = [built[0]!.box, built[2]!.box];
    expect(a.max[0] - a.min[0]).toBeCloseTo(10, 5);
    expect(b.min[0] - (a.min[0] + 20)).toBeCloseTo(5, 5);
  });

  it('writes each copy as oriented: laid flat on a face, then dropped onto the bed', async () => {
    const {
      doc: laid,
      setupId,
      parts,
    } = twoColour(1, {
      kind: 'layFlat',
      face: { id: 'r1', ref: { face: 'part#1/extrude#1/front' } },
    });
    const resolved = resolveSetup(laid, setupOf(laid, setupId), parts);
    expect(resolved.items[0]!.status).toBe('ok');
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: laid.name, units: UNITS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const built = items(validate3mf(r.value[0]!.bytes).parsed!);
    // The front face (y = 0, both bodies) down: the 20 mm depth is now the height.
    const block = built.find((m) => m.name === 'Block')!.box;
    expect(block.max[2] - block.min[2]).toBeCloseTo(20, 5);
    expect(block.min[2]).toBeCloseTo(0, 5);
    expect(block.max[1] - block.min[1]).toBeCloseTo(30, 5);
    const pad = built.find((m) => m.name === 'Pad')!.box;
    expect(pad.min[2]).toBeCloseTo(0, 5);
    expect(pad.max[2] - pad.min[2]).toBeCloseTo(10, 5);
  });

  it('refuses a part too big for the bed, naming the axis and not the corner', async () => {
    const { doc: base, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    let doc = base;
    doc = apply(doc, editSetupCommand(setupId, { printer: 'bambu-x1c' }));
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [300, 20, 10] }])];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const refusal = exportRefusal(resolved, UNITS);
    expect(refusal).toBe(
      "Not exported. Part 1 does not fit the Bambu Lab X1 Carbon's bed: too big by x 44.00 mm.",
    );
    const ex = fakeExchanger(() => parts);
    const r = await exportPrintSetup(ex, resolved, {
      source: MAIN,
      documentName: doc.name,
      units: UNITS,
    });
    expect(r).toEqual({ ok: false, message: refusal });
    expect(ex.tessellate).not.toHaveBeenCalled();
  });

  it('refuses a lost reference, and an unknown printer', () => {
    const lost = withSetup(partsDocument(), [{ part: 'part#1', body: 'extrude#9' }]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
    const r = resolveSetup(lost.doc, setupOf(lost.doc, lost.setupId), parts);
    expect(exportRefusal(r, UNITS)).toBe(
      'Not exported. Part 1: The body it prints (extrude#9) is gone. Pick another body.',
    );
    const known = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const setup = { ...setupOf(known.doc, known.setupId), printer: 'acme-9000' };
    expect(exportRefusal(resolveSetup(known.doc, setup, parts), UNITS)).toContain('acme-9000');
    const empty = withSetup(partsDocument(), []);
    expect(
      exportRefusal(resolveSetup(empty.doc, setupOf(empty.doc, empty.setupId), []), UNITS),
    ).toBe('There is nothing to print: add an item first.');
  });

  it('refuses copies that need a second plate', async () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 30 }) },
    ]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [40, 40, 10] }])];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    expect(exportRefusal(resolved, UNITS)).toBeNull();
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: doc.name, units: UNITS },
    );
    expect(r).toEqual({
      ok: false,
      message:
        "Not exported. The 30 copies need more than one plate: the Bambu Lab X1 Carbon's holds 25 of them as they are listed. An export writes one plate, so lower the copies or move some items to another setup.",
    });
  });

  it('exports a part that fits only close to the excluded corner, saying so', async () => {
    // 236 x 226 on the X1 Carbon: 5 mm clear of the corner (0 to 18 by 0 to 28) it fits neither
    // beside it nor behind it, so the plate is packed with no clearance from the corner.
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [236, 226, 10] }])];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    expect(exportRefusal(resolved, UNITS)).toBeNull();
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: doc.name, units: UNITS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toMatch(
      /: 1 copy of 1 item on the Bambu Lab X1 Carbon's plate\. Part 1 sits within 5 mm of an excluded area of the Bambu Lab X1 Carbon, since the plate has no room to keep 5 mm clear of it; slicers flag parts very close to an excluded area, so check the plate in the slicer\.$/,
    );
    const [m] = items(validate3mf(r.value[0]!.bytes).parsed!);
    expect(checkBedFit(x1c, { box: m!.box }).fits).toBe(true);
  });

  it('keeps 5 mm clear of the excluded corner when it can, with no note', async () => {
    // 230 x 256: as deep as the bed, it fits beside the corner with the 5 mm kept.
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [230, 256, 10] }])];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: doc.name, units: UNITS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toMatch(/: 1 copy of 1 item on the Bambu Lab X1 Carbon's plate\.$/);
    const [m] = items(validate3mf(r.value[0]!.bytes).parsed!);
    expect(m!.box.min[0]).toBeGreaterThanOrEqual(18 + 5 - 1e-6);
  });

  it('names an item that cannot be placed at all on a two-nozzle plate, without blaming an excluded area', async () => {
    // H2D: a two-colour part keeps every copy where both nozzles reach (x 25 to 325), so a
    // one-colour part 340 mm wide, which fits the bed alone, has no spot on that plate.
    let { doc } = withSetup(partsDocument(2), [{ part: 'part#1' }, { part: 'part#2' }]);
    const setupId = doc.print.setups[0]!.id;
    doc = apply(doc, editSetupCommand(setupId, { printer: 'bambu-h2d' }));
    doc = {
      ...doc,
      parts: doc.parts.map((p) =>
        p.id === 'part#1'
          ? {
              ...p,
              bodies: [
                { id: 'extrude#1', name: 'Block', color: '#ff0000' },
                { id: 'extrude#3', name: 'Pad', color: '#0000ff' },
              ],
            }
          : p,
      ),
    };
    const parts = [
      boxPart('part#1', [
        { bodyId: 'extrude#1', size: [10, 20, 30] },
        { bodyId: 'extrude#3', min: [10, 0, 0], size: [10, 10, 5] },
      ]),
      boxPart('part#2', [{ bodyId: 'extrude#1', size: [340, 20, 10] }]),
    ];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    expect(exportRefusal(resolved, UNITS)).toBeNull();
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: doc.name, units: UNITS },
    );
    expect(r).toEqual({
      ok: false,
      message:
        "Not exported. Part 2 fits the Bambu Lab H2D's bed only where one nozzle reaches, and a two-colour item on the plate keeps every copy in the area both nozzles reach: move it to another setup.",
    });
    expect(r.message).not.toMatch(/excluded|more than one plate/);
  });

  it('refuses plainly too many copies before listing them one by one', async () => {
    // 1000 copies of a 10 mm cube need more room than the plate has, 5 mm apart.
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 1000 }) },
    ]);
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [10, 10, 10] }])];
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const message =
      "Not exported. The 1000 copies need more than one plate: they need more room than the Bambu Lab X1 Carbon's plate has. An export writes one plate, so lower the copies or move some items to another setup.";
    expect(
      await exportPrintSetup(
        fakeExchanger(() => parts),
        resolved,
        { source: MAIN, documentName: doc.name, units: UNITS },
      ),
    ).toEqual({ ok: false, message });

    // More copies than any plate holds: refused before anything is meshed.
    const many = withSetup(
      partsDocument(),
      Array.from({ length: Math.ceil(MAX_PLATE_COPIES / 1000) + 1 }, () => ({
        part: 'part#1',
        edit: (item: PrintItem) => ({ ...item, copies: 1000 }),
      })),
    );
    const ex = fakeExchanger(() => parts);
    const r = await exportPrintSetup(
      ex,
      resolveSetup(many.doc, setupOf(many.doc, many.setupId), parts),
      { source: MAIN, documentName: doc.name, units: UNITS },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Not exported\. The \d+ copies need more than one plate/);
    expect(ex.tessellate).not.toHaveBeenCalled();
  });

  it('names the issues that did not block it', async () => {
    const { doc, setupId, parts } = twoColour(1);
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const issue = (kind: PrintIssue['kind']): PrintIssue => ({
      key: kind,
      kind,
      itemId: 'item#1',
      item: 'Part 1',
      worst: '',
      detail: '',
      targets: [],
    });
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      {
        source: MAIN,
        documentName: doc.name,
        units: UNITS,
        issues: [issue('overhang'), issue('thinWall'), issue('thinWall')],
      },
    );
    expect(r.message).toMatch(/ 3 issues in the list did not block it \(overhang, thin wall\)\.$/);
  });

  it('writes one STL per body, oriented, at the first copy', async () => {
    const { doc, setupId, parts } = twoColour(2);
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: doc.name, units: UNITS, format: 'stl' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((f) => f.name)).toEqual([
      'Jig-Plate 1-Part 1 Block.stl',
      'Jig-Plate 1-Part 1 Pad.stl',
    ]);
    expect(r.message).toContain('STL holds no copies or colours');
    const block = meshProperties(parseStl(r.value[0]!.bytes).mesh).boundingBox!;
    expect(checkBedFit(x1c, { box: block }).fits).toBe(true);
    expect(block.min[2]).toBeCloseTo(0, 5);
  });

  it('gives STL files names that stay unique once made safe for a file system', async () => {
    const { doc, setupId, parts } = twoColour(1);
    // Two body names that clean to one file name, but for case.
    const named: ManufaktureDocument = {
      ...doc,
      parts: doc.parts.map((p) =>
        p.id === 'part#1'
          ? {
              ...p,
              bodies: [
                { id: 'extrude#1', name: 'a:b', color: '#ff0000' },
                { id: 'extrude#3', name: 'A*b', color: '#0000ff' },
              ],
            }
          : p,
      ),
    };
    const resolved = resolveSetup(named, setupOf(named, setupId), parts);
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: named.name, units: UNITS, format: 'stl' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((f) => f.name)).toEqual([
      'Jig-Plate 1-Part 1 a_b.stl',
      'Jig-Plate 1-Part 1 A_b (2).stl',
    ]);
  });

  it('makes file names safe from document and setup names', async () => {
    const { doc, setupId, parts } = twoColour(1);
    // Set directly, like the body props (see `twoColour`).
    const named: ManufaktureDocument = {
      ...doc,
      name: '../../etc/x\u202Egpj.',
      print: {
        ...doc.print,
        setups: doc.print.setups.map((s) => (s.id === setupId ? { ...s, name: 'a<b>:c' } : s)),
      },
    };
    const resolved = resolveSetup(named, setupOf(named, setupId), parts);
    const r = await exportPrintSetup(
      fakeExchanger(() => parts),
      resolved,
      { source: MAIN, documentName: named.name, units: UNITS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.name).toBe('.._.._etc_xgpj.-a_b_c.3mf');
    expect(printFileBase('Doc', 'Plate', 'Row')).toBe('Doc-Plate-Row');
  });
});

describe('exportPrintConfigurations', () => {
  /** The box with #w in rows 20, 40 and 400 mm; a setup printing it on the X1 Carbon. */
  function configuredDoc(): { doc: ManufaktureDocument; setupId: string } {
    const { doc: base, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    let doc = base;
    const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
    const commands: Command[] = [
      { type: 'renameDocument', name: 'Shelf' },
      { type: 'setVariable', name: 'w', expression: mm('20 mm') },
      {
        type: 'setConfigParameter',
        parameter: { id: 'cp#1', name: 'Width', kind: 'variable', variable: 'w' },
      },
      ...['20', '40', '400'].map((w, i): Command => ({
        type: 'setConfigRow',
        row: { id: `cfg#${i + 1}`, name: `${w} wide`, values: { 'cp#1': mm(`${w} mm`) } },
      })),
    ];
    for (const c of commands) doc = apply(doc, c);
    return { doc, setupId };
  }

  it('exports one file per row, reporting a row that does not fit', async () => {
    const { doc, setupId } = configuredDoc();
    let parts: PartModel[] = [];
    const regen = vi.fn(async (d: ManufaktureDocument): Promise<RegenView> => {
      const w = parseFloat(d.variables.find((v) => v.name === 'w')!.expression.source);
      parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [w, 10, 5] }])];
      return { generation: 1, ms: 1, parts };
    });
    const files: string[] = [];
    const progress: string[] = [];
    const r = await exportPrintConfigurations(
      fakeExchanger(() => parts),
      regen,
      {
        source: MAIN,
        document: doc,
        setupId,
        onFile: (f) => files.push(f.name),
        onProgress: ({ row }) => progress.push(row.name),
      },
    );
    expect(progress).toEqual(['20 wide', '40 wide', '400 wide']);
    expect(files).toEqual(['Shelf-Plate 1-20 wide.3mf', 'Shelf-Plate 1-40 wide.3mf']);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => [f.row.name, f.message])).toEqual([
      ['400 wide', "Part 1 does not fit the Bambu Lab X1 Carbon's bed: too big by x 144.00 mm."],
    ]);
    expect(r.message).toBe(
      "Exported 2 of 3 configurations (Shelf-Plate 1-20 wide.3mf, Shelf-Plate 1-40 wide.3mf). 400 wide: Part 1 does not fit the Bambu Lab X1 Carbon's bed: too big by x 144.00 mm.",
    );
    // Each row's file is of that row's model.
    expect(regen).toHaveBeenCalledTimes(3);
  });

  it('reports a row where a feature of a printed part fails, and exports the others', async () => {
    const { doc, setupId } = configuredDoc();
    let parts: PartModel[] = [];
    const regen = async (d: ManufaktureDocument): Promise<RegenView> => {
      const w = parseFloat(d.variables.find((v) => v.name === 'w')!.expression.source);
      const part = boxPart('part#1', [{ bodyId: 'extrude#1', size: [Math.min(w, 40), 10, 5] }]);
      // At 400 mm a feature fails; the bodies left are those of the features before it.
      const failed = {
        featureId: 'extrude#7',
        status: 'error',
        errors: [{ message: 'The cut misses the part' }],
      } as unknown as PartModel['features'][number];
      parts = [w === 400 ? { ...part, features: [failed] } : part];
      return { generation: 1, ms: 1, parts };
    };
    const files: string[] = [];
    const r = await exportPrintConfigurations(
      fakeExchanger(() => parts),
      regen,
      { source: MAIN, document: doc, setupId, onFile: (f) => files.push(f.name) },
    );
    expect(files).toEqual(['Shelf-Plate 1-20 wide.3mf', 'Shelf-Plate 1-40 wide.3mf']);
    expect(r.files).toEqual(files);
    expect(r.failures.map((f) => [f.row.name, f.message])).toEqual([
      ['400 wide', 'extrude#7 fails in this configuration: The cut misses the part.'],
    ]);
    expect(r.ok).toBe(false);
  });

  it('stops when cancelled, keeping the files made', async () => {
    const { doc, setupId } = configuredDoc();
    const parts = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [20, 10, 5] }])];
    const controller = new AbortController();
    const r = await exportPrintConfigurations(
      fakeExchanger(() => parts),
      async () => ({ generation: 1, ms: 1, parts }),
      {
        source: MAIN,
        document: doc,
        setupId,
        signal: controller.signal,
        onFile: () => controller.abort(),
      },
    );
    expect(r.cancelled).toBe(true);
    expect(r.files).toEqual(['Shelf-Plate 1-20 wide.3mf']);
    expect(r.message).toBe(
      'Export cancelled after 1 of 3 configurations (Shelf-Plate 1-20 wide.3mf).',
    );
  });
});

describe('print exports behind the export gate', () => {
  it('writes no plate, as 3MF or STL, from an agent’s unreviewed branch', async () => {
    const { doc, setupId, parts } = twoColour(2);
    const resolved = resolveSetup(doc, setupOf(doc, setupId), parts);
    for (const format of ['3mf', 'stl'] as const) {
      for (const review of REFUSED_REVIEWS) {
        const ex = fakeExchanger(() => parts);
        expect(
          await exportPrintSetup(ex, resolved, {
            source: agentSource(review),
            documentName: doc.name,
            units: UNITS,
            format,
          }),
        ).toEqual({ ok: false, message: UNREVIEWED_EXPORT });
        expect(ex.tessellate).not.toHaveBeenCalled();
        const regen = vi.fn();
        const all = await exportPrintConfigurations(ex, regen, {
          source: agentSource(review),
          document: doc,
          setupId,
          format,
        });
        expect(all).toMatchObject({ ok: false, files: [], message: UNREVIEWED_EXPORT });
        expect(regen).not.toHaveBeenCalled();
      }
      const ok = await exportPrintSetup(
        fakeExchanger(() => parts),
        resolved,
        {
          source: agentSource('approved'),
          documentName: doc.name,
          units: UNITS,
          format,
        },
      );
      expect(ok.ok).toBe(true);
    }
  });
});
