import { createDocument, findPart } from '@manufakture/core';
import {
  checkManifold,
  parseStl,
  toBase64,
  validate3mf,
  writeBinaryStl,
  type TriangleSoup,
} from '@manufakture/io';
import type { KernelOp, MeshData } from '@manufakture/kernel';
import type { KernelClient } from '@manufakture/kernel/client';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import type { BodyInput } from '../viewport/bodies';
import { boxBody } from '../viewport/testMeshes';
import {
  MAX_IMPORT_BYTES,
  exportBodies,
  importFile,
  reimportSteps,
  restorableImportIds,
} from './actions';
import { kernelExchange, type Exchanger, type KernelBody } from './exchange';

/** A fake kernel exchange over box meshes (in the kernel's layout: vertices per face). */
function fakeExchanger(names: string[] = ['Demo part']): Exchanger & {
  tessellate: ReturnType<typeof vi.fn>;
} {
  const bodies = names.map((name, i) => ({ id: `body${i + 1}`, name }));
  return {
    bodies: () => bodies,
    tessellate: vi.fn(async (ids: readonly string[]) => ({
      ok: true as const,
      value: ids.map((id, i) => ({
        name: bodies.find((b) => b.id === id)!.name,
        mesh: boxBody({ min: [i * 20, 0, 0], size: [10, 20, 5] }).mesh,
      })),
    })),
    exportStep: vi.fn(async () => ({
      ok: true as const,
      value: new TextEncoder().encode('ISO-10303-21;'),
    })),
    importStep: vi.fn(async (_bytes: Uint8Array, featureId: string) => ({
      ok: true as const,
      value: { ...boxBody({ id: featureId }) } as BodyInput,
    })),
    retain: vi.fn(() => []),
    reimport: vi.fn(async () => []),
  };
}

const documents = () => createDocumentStore(createDocument({ id: 'doc', name: 'Bracket' }));

describe('exportBodies', () => {
  it('STL: one watertight binary file, named after the body, at the chosen tolerance', async () => {
    const ex = fakeExchanger();
    const r = await exportBodies(ex, 'stl', { tolerance: 'fine' });
    if (!r.ok) throw new Error(r.message);
    expect(ex.tessellate).toHaveBeenCalledWith(['body1'], { linear: 0.005, angular: 0.1 });
    expect(r.value.map((f) => [f.name, f.type])).toEqual([['Demo part.stl', 'model/stl']]);
    expect(checkManifold(parseStl(r.value[0]!.bytes).mesh).ok).toBe(true);
    expect(r.message).toMatch(/^Exported Demo part\.stl \(/);
  });

  it('STL per body, and 3MF with one object per body, named after the document when several', async () => {
    const ex = fakeExchanger(['Bracket', 'Pin']);
    const each = await exportBodies(ex, 'stl-each');
    if (!each.ok) throw new Error(each.message);
    expect(each.value.map((f) => f.name)).toEqual(['Bracket.stl', 'Pin.stl']);
    const threemf = await exportBodies(ex, '3mf', { documentName: 'Assembly' });
    if (!threemf.ok) throw new Error(threemf.message);
    expect(threemf.value[0]!.name).toBe('Assembly.3mf');
    const report = validate3mf(threemf.value[0]!.bytes);
    expect(report.problems).toEqual([]);
    expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Bracket', 'Pin']);
  });

  it('exports only the chosen bodies, under the names given', async () => {
    const ex = fakeExchanger(['Body 1', 'Body 2', 'Body 3']);
    const chosen = [
      { id: 'body1', name: 'Base' },
      { id: 'body3', name: 'Lid' },
    ];
    const threemf = await exportBodies(ex, '3mf', { documentName: 'Box', bodies: chosen });
    if (!threemf.ok) throw new Error(threemf.message);
    expect(ex.tessellate).toHaveBeenCalledWith(
      ['body1', 'body3'],
      expect.anything(),
      new Map([
        ['body1', 'Base'],
        ['body3', 'Lid'],
      ]),
    );
    expect(threemf.value[0]!.name).toBe('Box.3mf');
    const one = await exportBodies(ex, 'step', { bodies: [chosen[1]!] });
    if (!one.ok) throw new Error(one.message);
    expect(one.value[0]!.name).toBe('Lid.step');
    expect(ex.exportStep).toHaveBeenLastCalledWith(['body3'], new Map([['body3', 'Lid']]));
    expect((await exportBodies(ex, 'stl', { bodies: [] })).message).toBe(
      'There is nothing to export.',
    );
  });

  it('STEP comes from the kernel', async () => {
    const ex = fakeExchanger();
    const r = await exportBodies(ex, 'step');
    if (!r.ok) throw new Error(r.message);
    expect(r.value[0]).toMatchObject({ name: 'Demo part.step', type: 'model/step' });
    expect(ex.exportStep).toHaveBeenCalledWith(['body1']);
  });

  it('refuses a mesh that is not watertight, and an empty scene', async () => {
    const ex = fakeExchanger();
    ex.tessellate.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          name: 'Open',
          mesh: { ...boxBody().mesh, indices: boxBody().mesh.indices.slice(3) } as MeshData,
        },
      ],
    });
    const r = await exportBodies(ex, '3mf');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Open is not watertight/);
    expect((await exportBodies(fakeExchanger([]), 'stl')).message).toBe(
      'There is nothing to export.',
    );
  });
});

/** A binary STL of a 10 mm cube. */
function cubeStl(header = 'cube'): Uint8Array {
  const mesh: TriangleSoup = boxBody().mesh;
  return writeBinaryStl(
    { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) },
    { header },
  );
}

describe('importFile', () => {
  it('STL: a mesh reference body, and an import feature holding the file, undoable', async () => {
    const docs = documents();
    const bytes = cubeStl();
    const r = await importFile({ name: 'cube.stl', bytes }, docs, null);
    if (!r.ok) throw new Error(r.message);
    expect(r.value.body.id).toBe('part#1/import#1');
    expect(r.value.partId).toBe('part#1');
    expect(r.value.mesh!.positions.length / 3).toBe(8);
    const features = findPart(docs.getState().document, 'part#1')!.features;
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      id: 'import#1',
      kind: 'import',
      name: 'cube',
      operation: 'reference',
      source: { format: 'stl', fileName: 'cube.stl', size: bytes.length, data: toBase64(bytes) },
    });
    expect(docs.getState().undoLabel).toBe('Import cube.stl');
    docs.getState().undo();
    expect(findPart(docs.getState().document, 'part#1')!.features).toHaveLength(0);

    // The next import gets the next id, even after the undo.
    docs.getState().redo();
    const again = await importFile({ name: 'cube.stl', bytes }, docs, null);
    expect(again.ok && again.value.feature.id).toBe('import#2');
  });

  it('STEP: read by the kernel, named after the first product', async () => {
    const docs = documents();
    const ex = fakeExchanger();
    const bytes = new TextEncoder().encode(
      "ISO-10303-21;\nDATA;\n#7 = PRODUCT('Bracket body','Bracket body','',(#8));\nENDSEC;\n",
    );
    const r = await importFile({ name: 'part.step', bytes }, docs, ex);
    if (!r.ok) throw new Error(r.message);
    expect(ex.importStep).toHaveBeenCalledWith(
      bytes,
      'import#1',
      'Bracket body',
      'part#1/import#1',
    );
    expect(r.value.feature).toMatchObject({ name: 'Bracket body', source: { format: 'step' } });
    expect(r.value.mesh).toBeUndefined();
    expect(r.message).toBe('Imported part.step as Bracket body (STEP, a reference body).');
  });

  it('adds nothing when the kernel cannot read the file', async () => {
    const docs = documents();
    const ex = fakeExchanger();
    vi.mocked(ex.importStep).mockResolvedValueOnce({ ok: false, message: 'broken' });
    const r = await importFile(
      { name: 'x.stp', bytes: new TextEncoder().encode('ISO-10303-21;') },
      docs,
      ex,
    );
    expect(r).toEqual({ ok: false, message: 'broken' });
    expect(findPart(docs.getState().document, 'part#1')!.features).toHaveLength(0);
    const without = await importFile(
      { name: 'x.stp', bytes: new TextEncoder().encode('ISO-10303-21;') },
      docs,
      null,
    );
    expect(without.message).toBe('STEP import needs the geometry kernel.');
  });

  it('refuses empty, oversized, unknown and broken files', async () => {
    const docs = documents();
    const enc = (s: string) => new TextEncoder().encode(s);
    expect((await importFile({ name: 'a.stl', bytes: new Uint8Array() }, docs, null)).message).toBe(
      'a.stl is empty.',
    );
    const big = await importFile(
      { name: 'big.stl', bytes: new Uint8Array(MAX_IMPORT_BYTES + 1) },
      docs,
      null,
    );
    expect(big.message).toMatch(/imports are limited to 20\.0 MB/);
    expect((await importFile({ name: 'a.obj', bytes: enc('v 1 2 3') }, docs, null)).message).toBe(
      'a.obj is not a STEP or STL file.',
    );
    const broken = await importFile(
      { name: 'a.stl', bytes: enc('solid a\nendsolid a\n') },
      docs,
      null,
    );
    expect(broken.message).toMatch(/^a\.stl: .*no triangles/);
    expect(findPart(docs.getState().document, 'part#1')!.features).toHaveLength(0);
  });
});

/**
 * The real kernel exchange over a client that answers every batch: a STEP
 * import makes shape 12, a tessellate returns a box, a STEP export some bytes.
 */
function kernelWithPart() {
  const sent: KernelOp[][] = [];
  const released: number[][] = [];
  const box = boxBody();
  let nextShape = 12;
  const client = {
    latestGeneration: 1,
    release: vi.fn(async (shapes: number[]) => {
      released.push([...shapes]);
      return { released: shapes, unknown: [] };
    }),
    submit: vi.fn(async (ops: readonly KernelOp[]) => {
      sent.push([...ops]);
      const results = ops.map((op) => {
        const value =
          op.op === 'feature'
            ? { ok: true, bodies: [{ id: 'import', shape: nextShape++ }], errors: [] }
            : op.op === 'tessellate'
              ? box.mesh
              : op.op === 'topology'
                ? box.topology
                : op.op === 'exportStep'
                  ? { data: new TextEncoder().encode('ISO-10303-21;') }
                  : { released: [], unknown: [] };
        return { ok: true, op: op.op, value, ms: 1 };
      });
      return { status: 'done', names: [], generation: 1, results };
    }),
  } as unknown as KernelClient;
  const registry = new Map<string, KernelBody>([
    ['demo-part', { shape: 3 as never, name: 'Demo part', role: 'part' }],
  ]);
  return { ...kernelExchange(() => client, registry), registry, sent, released };
}

describe('reference bodies and export', () => {
  const step = new TextEncoder().encode(
    "ISO-10303-21;\nDATA;\n#7 = PRODUCT('Ref','Ref','',(#8));\nENDSEC;\n",
  );
  const shapesSent = (ops: KernelOp[][], op: string) =>
    ops
      .flat()
      .flatMap((o) =>
        o.op !== op
          ? []
          : o.op === 'exportStep'
            ? o.bodies.map((b) => b.shape)
            : o.op === 'tessellate' || o.op === 'release'
              ? [o.op === 'tessellate' ? o.shape : o.shapes]
              : [],
      );

  it('an imported STEP body is never exported: only the part is', async () => {
    const k = kernelWithPart();
    const docs = documents();
    const r = await importFile({ name: 'ref.step', bytes: step }, docs, k.exchanger);
    if (!r.ok) throw new Error(r.message);
    expect(k.registry.get('part#1/import#1')).toMatchObject({
      shape: 12,
      role: 'reference',
      featureId: 'import#1',
    });
    expect(k.exchanger.bodies()).toEqual([{ id: 'demo-part', name: 'Demo part' }]);

    k.sent.length = 0;
    const stl = await exportBodies(k.exchanger, 'stl', { documentName: 'Bracket' });
    if (!stl.ok) throw new Error(stl.message);
    // Named after the part, not the document: one body.
    expect(stl.value.map((f) => f.name)).toEqual(['Demo part.stl']);
    const threemf = await exportBodies(k.exchanger, '3mf', { documentName: 'Bracket' });
    if (!threemf.ok) throw new Error(threemf.message);
    expect(validate3mf(threemf.value[0]!.bytes).parsed!.objects.map((o) => o.name)).toEqual([
      'Demo part',
    ]);
    const stepOut = await exportBodies(k.exchanger, 'step', { documentName: 'Bracket' });
    if (!stepOut.ok) throw new Error(stepOut.message);
    expect(stepOut.value[0]!.name).toBe('Demo part.step');
    expect(shapesSent(k.sent, 'tessellate')).toEqual([3, 3]);
    expect(shapesSent(k.sent, 'exportStep')).toEqual([3]);
    // Asking for a reference body by id is refused too.
    expect(await k.exchanger.exportStep(['part#1/import#1'])).toEqual({
      ok: false,
      message: 'The kernel has no body part#1/import#1.',
    });
  });

  it('after undo the body is still not exported, and is released once it cannot come back', async () => {
    const k = kernelWithPart();
    const docs = documents();
    const r = await importFile({ name: 'ref.step', bytes: step }, docs, k.exchanger);
    if (!r.ok) throw new Error(r.message);
    const history = () => [...docs.core.undoStack, ...docs.core.redoStack];
    const keep = () => restorableImportIds(docs.getState().document, history());

    expect([...keep()]).toEqual(['part#1/import#1']);
    docs.getState().undo();
    // Out of the document, but on the redo stack: kept, and still not exported.
    expect(findPart(docs.getState().document, 'part#1')!.features).toHaveLength(0);
    expect([...keep()]).toEqual(['part#1/import#1']);
    expect(k.exchanger.retain(keep())).toEqual([]);
    k.sent.length = 0;
    const stl = await exportBodies(k.exchanger, 'stl');
    if (!stl.ok) throw new Error(stl.message);
    expect(shapesSent(k.sent, 'tessellate')).toEqual([3]);

    // A new edit clears the redo stack: the body is gone for good, its shape released.
    docs.getState().execute({
      type: 'setDisplayUnits',
      units: { length: { unit: 'in' }, angle: { unit: 'deg' } },
    });
    expect(keep().size).toBe(0);
    k.sent.length = 0;
    expect(k.exchanger.retain(keep())).toEqual(['part#1/import#1']);
    expect(k.registry.has('part#1/import#1')).toBe(false);
    expect(k.registry.has('demo-part')).toBe(true);
    expect(k.sent).toEqual([]);
    expect(k.released).toEqual([[12]]);
    // Nothing left to release a second time.
    expect(k.exchanger.retain(keep())).toEqual([]);
  });

  it('rebuilds imported STEP bodies from the files the document stores', async () => {
    const k = kernelWithPart();
    const docs = documents();
    const r = await importFile({ name: 'ref.step', bytes: step }, docs, k.exchanger);
    if (!r.ok) throw new Error(r.message);
    const stl = await importFile({ name: 'a.stl', bytes: cubeStl() }, docs, k.exchanger);
    if (!stl.ok) throw new Error(stl.message);
    expect(k.registry.get('part#1/import#1')).toMatchObject({ shape: 12 });
    k.sent.length = 0;
    // The kernel recycled: shape 12 is gone.
    expect(await reimportSteps(k.exchanger, [r.value, stl.value])).toEqual(['part#1/import#1']);
    expect(k.registry.get('part#1/import#1')).toMatchObject({ shape: 13, role: 'reference' });
    // Only the STEP file goes to the kernel, byte for byte.
    expect(k.sent).toHaveLength(1);
    const op = k.sent[0]![0]!;
    expect(op).toMatchObject({ op: 'feature', feature: { id: 'import#1' } });
    expect(Array.from((op as { feature: { step: Uint8Array } }).feature.step)).toEqual(
      Array.from(step),
    );
  });

  it('keeps apart the imports of two part studios, which share feature ids', async () => {
    const k = kernelWithPart();
    const docs = documents();
    const one = await importFile({ name: 'ref.step', bytes: step }, docs, k.exchanger);
    if (!one.ok) throw new Error(one.message);
    docs.getState().execute({ type: 'addPart', partId: 'part#2', name: 'Two' });
    expect(docs.getState().activePartId).toBe('part#2');
    const two = await importFile({ name: 'ref.step', bytes: step }, docs, k.exchanger);
    if (!two.ok) throw new Error(two.message);
    // Both are import#1 in their own part; the bodies and the kernel shapes stay separate.
    expect([one.value.feature.id, two.value.feature.id]).toEqual(['import#1', 'import#1']);
    expect([one.value.body.id, two.value.body.id]).toEqual(['part#1/import#1', 'part#2/import#1']);
    expect(two.value.partId).toBe('part#2');
    expect(k.registry.get('part#1/import#1')).toMatchObject({ shape: 12 });
    expect(k.registry.get('part#2/import#1')).toMatchObject({ shape: 13 });
    expect(k.released).toEqual([]);

    // Deleting the second part studio keeps its body while undo can bring the part back.
    const history = () => [...docs.core.undoStack, ...docs.core.redoStack];
    const keep = () => restorableImportIds(docs.getState().document, history());
    expect([...keep()].sort()).toEqual(['part#1/import#1', 'part#2/import#1']);
    docs.getState().execute({ type: 'deletePart', partId: 'part#2' });
    expect([...keep()].sort()).toEqual(['part#1/import#1', 'part#2/import#1']);
    expect(k.exchanger.retain(keep())).toEqual([]);

    // Rebuilt after a recycle under their own ids, each read as its own import feature.
    k.sent.length = 0;
    expect(await reimportSteps(k.exchanger, [one.value, two.value])).toEqual([
      'part#1/import#1',
      'part#2/import#1',
    ]);
    expect(k.sent.map((ops) => ops[0])).toMatchObject([
      { op: 'feature', feature: { id: 'import#1' } },
      { op: 'feature', feature: { id: 'import#1' } },
    ]);
    expect(k.registry.get('part#2/import#1')).toMatchObject({ shape: 15, featureId: 'import#1' });
  });

  it('finds imports in a whole part a history command restores', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    const part = {
      id: 'part#3',
      name: 'Three',
      features: [{ id: 'import#2', kind: 'import' }],
      rollbackIndex: null,
      nextIds: {},
      bodies: [],
    };
    const history = [{ command: { type: 'restorePart', part, index: 1 } }] as never;
    expect([...restorableImportIds(doc, history)]).toEqual(['part#3/import#2']);
  });

  it('finds imports in the document and in nested history commands', () => {
    const doc = createDocument({ id: 'd', name: 'D' });
    const feature = { id: 'import#4', kind: 'import' };
    const history = [
      { command: { type: 'batch', commands: [{ type: 'addFeature', partId: 'part#1', feature }] } },
      { command: { type: 'deleteFeature', partId: 'part#1', featureId: 'import#9' } },
    ] as never;
    expect([...restorableImportIds(doc, history)]).toEqual(['part#1/import#4']);
  });
});
