import { applyCommand, type ImportFeature } from '@manufakture/core';
import { importSource } from '@manufakture/io';
import { describe, expect, it, vi } from 'vitest';
import type { Exchanger } from '../io/exchange';
import { boxBody } from '../viewport/testMeshes';
import { referenceImports, restoreImports } from './imports';
import { partWithImport, unwrapDoc } from '@manufakture/library/test-fixtures';

function exchanger(ok = true): Exchanger {
  return {
    bodies: () => [],
    tessellate: vi.fn(),
    exportStep: vi.fn(),
    importStep: vi.fn(async (_bytes: Uint8Array, _feature: string, _name: string, id: string) =>
      ok
        ? { ok: true as const, value: boxBody({ id }) }
        : { ok: false as const, message: 'bad STEP' },
    ),
    retain: vi.fn(() => []),
    reimport: vi.fn(async () => []),
  } as unknown as Exchanger;
}

async function withStep() {
  const doc = await partWithImport();
  const step: ImportFeature = {
    id: 'import#2',
    kind: 'import',
    name: 'Bracket',
    suppressed: false,
    source: await importSource('step', 'b.step', new TextEncoder().encode('ISO-10303-21;')),
    operation: 'reference',
  };
  return unwrapDoc(applyCommand(doc, { type: 'addFeature', partId: 'part#1', feature: step }));
}

describe('restoreImports', () => {
  it('reads STL references here and STEP references through the kernel', async () => {
    const doc = await withStep();
    expect(referenceImports(doc).map((f) => f.id)).toEqual(['import#1', 'import#2']);
    const ex = exchanger();
    const r = await restoreImports(doc, ex);
    expect(r.errors).toEqual([]);
    expect(r.bodies.map((b) => [b.feature.id, b.body.id, b.mesh !== undefined])).toEqual([
      ['import#1', 'part#1/import#1', true],
      ['import#2', 'part#1/import#2', false],
    ]);
    // A 10 mm cube: 12 triangles.
    expect(r.bodies[0]!.mesh!.indices.length).toBe(36);
    expect(ex.importStep).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'import#2',
      'Bracket',
      'part#1/import#2',
    );
  });

  it('keeps apart the same import id in two part studios', async () => {
    const doc = await withStep();
    const two = unwrapDoc(
      applyCommand(doc, {
        type: 'duplicatePart',
        sourcePartId: 'part#1',
        partId: 'part#2',
        name: 'Copy',
      }),
    );
    const r = await restoreImports(two, exchanger());
    expect(r.errors).toEqual([]);
    expect(r.bodies.map((b) => [b.partId, b.feature.id, b.body.id])).toEqual([
      ['part#1', 'import#1', 'part#1/import#1'],
      ['part#1', 'import#2', 'part#1/import#2'],
      ['part#2', 'import#1', 'part#2/import#1'],
      ['part#2', 'import#2', 'part#2/import#2'],
    ]);
  });

  it('reports what it cannot read, and keeps the rest', async () => {
    const doc = await withStep();
    let r = await restoreImports(doc, null);
    expect(r.bodies.map((b) => b.feature.id)).toEqual(['import#1']);
    expect(r.errors).toEqual(['Bracket: STEP needs the geometry kernel.']);
    r = await restoreImports(doc, exchanger(false));
    expect(r.errors).toEqual(['Bracket: bad STEP']);
  });
});
