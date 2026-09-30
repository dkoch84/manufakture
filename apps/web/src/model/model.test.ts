import { createDocument, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { boxBody } from '../viewport/testMeshes';
import {
  createModelStore,
  featureResult,
  modelBodies,
  startRegen,
  type Regenerator,
  type RegenView,
} from './model';

/** A regenerator the test answers by hand, request by request. */
function manualRegenerator() {
  const requests: {
    document: ManufaktureDocument;
    resolve: (v: RegenView | null) => void;
    reject: (e: Error) => void;
  }[] = [];
  const listeners = new Set<() => void>();
  const regenerator: Regenerator = {
    regen: (document) =>
      new Promise((resolve, reject) => requests.push({ document, resolve, reject })),
    onInvalidated: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { regenerator, requests, invalidate: () => listeners.forEach((l) => l()) };
}

const view = (generation: number, featureId = 'sketch#1'): RegenView => ({
  generation,
  ms: 3,
  parts: [
    {
      partId: 'part#1',
      bodies: [
        {
          bodyId: 'extrude#1',
          creator: 'extrude#1',
          solids: 1,
          view: boxBody({ id: 'part#1/extrude#1' }),
        },
      ],
      features: [
        {
          featureId,
          kind: 'sketch',
          index: 0,
          status: 'ok',
          errors: [],
          warnings: [],
          references: [],
          cached: false,
          ms: 1,
        },
      ],
    },
  ],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('keeping the model current', () => {
  it('regenerates now, on every document change, and after a recycle', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    const stop = startRegen(manual.regenerator, documents, model);
    expect(manual.requests).toHaveLength(1);
    expect(model.getState()).toMatchObject({ available: true, pending: true });

    documents.getState().execute({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
    expect(manual.requests).toHaveLength(2);
    expect(manual.requests[1]!.document).toBe(documents.getState().document);

    // The first regen was superseded; the second completes.
    manual.requests[0]!.resolve(null);
    manual.requests[1]!.resolve(view(2));
    await flush();
    const s = model.getState();
    expect(s).toMatchObject({ generation: 2, pending: false, error: null, ms: 3 });
    expect(s.document).toBe(documents.getState().document);
    expect(featureResult(s, 'part#1', 'sketch#1')?.status).toBe('ok');
    expect(modelBodies(s).map((b) => b.id)).toEqual(['part#1/extrude#1']);

    manual.invalidate();
    expect(manual.requests).toHaveLength(3);
    expect(manual.requests[2]!.document).toBe(documents.getState().document);

    stop();
    documents.getState().undo();
    manual.invalidate();
    expect(manual.requests).toHaveLength(3);
  });

  it('never goes back to an older result, and marks a newer document pending', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    startRegen(manual.regenerator, documents, model);
    documents.getState().execute({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
    manual.requests[1]!.resolve(view(5, 'new'));
    await flush();
    manual.requests[0]!.resolve(view(4, 'old'));
    await flush();
    expect(model.getState().generation).toBe(5);
    expect(featureResult(model.getState(), 'part#1', 'new')).toBeDefined();

    documents.getState().undo();
    expect(model.getState().pending).toBe(true);
  });

  it('asks again when the newest regen was dropped, since nobody else will report', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    startRegen(manual.regenerator, documents, model);
    // Something other than a regen (a STEP import at a new generation, a worker restart)
    // superseded the only regen requested.
    manual.requests[0]!.resolve(null);
    await flush();
    expect(manual.requests).toHaveLength(2);
    expect(manual.requests[1]!.document).toBe(documents.getState().document);
    expect(model.getState().pending).toBe(true);
    manual.requests[1]!.resolve(view(3));
    await flush();
    expect(model.getState()).toMatchObject({ generation: 3, pending: false });
    expect(manual.requests).toHaveLength(2);
  });

  it('does not ask again for a dropped regen that a newer request replaced', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    startRegen(manual.regenerator, documents, model);
    // A recycle asks for the same document again: the first regen's null is expected.
    manual.invalidate();
    manual.requests[0]!.resolve(null);
    await flush();
    expect(manual.requests).toHaveLength(2);
    manual.requests[1]!.resolve(null);
    await flush();
    expect(manual.requests).toHaveLength(3);
  });

  it('gives up on a regen that keeps being dropped, instead of spinning', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const regen = vi.fn(async () => null);
    startRegen({ regen, onInvalidated: () => () => {} }, documents, model);
    for (let i = 0; i < 10; i++) await flush();
    expect(regen.mock.calls.length).toBeGreaterThan(1);
    expect(regen.mock.calls.length).toBeLessThan(10);
    expect(model.getState().pending).toBe(false);
    expect(model.getState().error).toMatch(/kept dropping/);
    // The next edit tries again.
    const before = regen.mock.calls.length;
    documents.getState().execute({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
    expect(regen.mock.calls.length).toBe(before + 1);
  });

  it('reports a regen that failed as a whole', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    startRegen(manual.regenerator, documents, model);
    manual.requests[0]!.reject(new Error('worker crashed'));
    await flush();
    expect(model.getState()).toMatchObject({ error: 'worker crashed', pending: false });
    const spy = vi.fn();
    model.subscribe(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
