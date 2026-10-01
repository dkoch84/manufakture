import { applyCommand, createDocument, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { boxBody } from '../viewport/testMeshes';
import {
  buildable,
  createModelStore,
  shareRegenerator,
  featureResult,
  modelBodies,
  startRegen,
  startView,
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

/** A document with a variable #w configured in a row `Wide` (80 mm), active when `active`. */
function configuredDocument(active: boolean): ManufaktureDocument {
  let doc = createDocument({ id: 'd', name: 'D' });
  const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
  for (const command of [
    { type: 'setVariable' as const, name: 'w', expression: mm('40 mm') },
    {
      type: 'setConfigParameter' as const,
      parameter: { id: 'cp#1', name: 'w', kind: 'variable' as const, variable: 'w' },
    },
    {
      type: 'setConfigRow' as const,
      row: { id: 'cfg#1', name: 'Wide', values: { 'cp#1': mm('80 mm') } },
    },
    ...(active ? [{ type: 'setActiveConfiguration' as const, rowId: 'cfg#1' }] : []),
  ]) {
    const r = applyCommand(doc, command);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

describe('building the active configuration', () => {
  it('regenerates the document with its active row applied, and keeps the stored one', async () => {
    const documents = createDocumentStore(configuredDocument(true));
    const model = createModelStore();
    const manual = manualRegenerator();
    startRegen(manual.regenerator, documents, model);
    const built = manual.requests[0]!.document;
    expect(built).not.toBe(documents.getState().document);
    expect(built.variables[0]!.expression.source).toBe('80 mm');
    manual.requests[0]!.resolve(view(1));
    await flush();
    expect(model.getState().document).toBe(documents.getState().document);
    expect(model.getState().configurationError).toBeNull();
  });

  it('builds a document with no active row as it is', () => {
    const doc = configuredDocument(false);
    expect(buildable(doc)).toEqual({ document: doc, error: null });
  });

  it('builds the document without a row that cannot be applied, and says why', () => {
    const doc = configuredDocument(true);
    // Not reachable through commands (they are checked); a document damaged some other way.
    const broken: ManufaktureDocument = {
      ...doc,
      configurations: { ...doc.configurations!, active: 'cfg#9' },
    };
    const r = buildable(broken);
    expect(r.document).toBe(broken);
    expect(r.error).toMatch(/^The active configuration cannot be applied/);
  });
});

describe('sharing the regenerator', () => {
  it('holds the open document back while exclusive work runs, then builds it again', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    const shared = shareRegenerator(manual.regenerator);
    startRegen(shared.regenerator, documents, model);
    expect(manual.requests).toHaveLength(1);
    const variant = createDocument({ id: 'v', name: 'V' });

    let finish!: () => void;
    const work = shared.exclusive(async (regen) => {
      const r = regen(variant);
      expect(manual.requests.at(-1)!.document).toBe(variant);
      // The open document's regen was superseded by the variant's: startRegen asks again,
      // and so does an edit; both are held.
      manual.requests[0]!.resolve(null);
      await flush();
      documents.getState().execute({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
      expect(manual.requests).toHaveLength(2);
      manual.requests[1]!.resolve(view(7));
      await new Promise<void>((resolve) => (finish = resolve));
      return r;
    });
    expect(shared.busy()).toBe(true);
    await expect(shared.exclusive(async () => 1)).rejects.toThrow(/Another export/);
    await flush();
    finish();
    expect((await work)?.generation).toBe(7);
    expect(shared.busy()).toBe(false);
    // Afterwards the open document is built again, once.
    await flush();
    expect(manual.requests).toHaveLength(3);
    expect(manual.requests[2]!.document).toBe(documents.getState().document);
    manual.requests[2]!.resolve(view(8));
    await flush();
    expect(model.getState()).toMatchObject({ generation: 8, pending: false });
  });

  it('passes regens straight through when nothing exclusive runs', () => {
    const manual = manualRegenerator();
    const shared = shareRegenerator(manual.regenerator);
    const listener = vi.fn();
    const off = shared.regenerator.onInvalidated(listener);
    void shared.regenerator.regen(createDocument({ id: 'd', name: 'D' }));
    expect(manual.requests).toHaveLength(1);
    manual.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    manual.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('viewing another document', () => {
  it('builds it in its own model, leaves the open one alone, and builds that again after', async () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const model = createModelStore();
    const manual = manualRegenerator();
    const shared = shareRegenerator(manual.regenerator);
    startRegen(shared.regenerator, documents, model);
    manual.requests[0]!.resolve(view(1));
    await flush();
    const past = createDocument({ id: 'd', name: 'Past' });

    const session = startView(shared, past);
    expect(session.model).not.toBe(model);
    expect(manual.requests).toHaveLength(2);
    expect(manual.requests[1]!.document).toBe(past);
    expect(session.model.getState()).toMatchObject({ available: true, pending: true });
    manual.requests[1]!.resolve(view(2, 'sketch#9'));
    await flush();
    expect(session.model.getState()).toMatchObject({
      generation: 2,
      pending: false,
      document: past,
    });
    expect(featureResult(session.model.getState(), 'part#1', 'sketch#9')).toBeDefined();
    // The open document's model still shows its own result.
    expect(model.getState()).toMatchObject({ generation: 1 });
    expect(shared.busy()).toBe(true);

    // A recycle while viewing builds the viewed document again, not the open one.
    manual.invalidate();
    expect(manual.requests.at(-1)!.document).toBe(past);
    manual.requests.at(-1)!.resolve(view(3, 'sketch#9'));
    await flush();
    expect(session.model.getState().generation).toBe(3);

    const before = manual.requests.length;
    session.stop();
    session.stop();
    await session.done;
    expect(shared.busy()).toBe(false);
    await flush();
    // Once: the view's listener is gone, so the open document is the only one built.
    expect(manual.requests.slice(before).map((r) => r.document)).toEqual([
      documents.getState().document,
    ]);
    manual.requests.at(-1)!.resolve(view(4));
    await flush();
    expect(model.getState()).toMatchObject({ generation: 4, pending: false });
    expect(session.model.getState().generation).toBe(3);
  });

  it('asks again for a dropped regen, then gives up and says so', async () => {
    const manual = manualRegenerator();
    const shared = shareRegenerator(manual.regenerator);
    const session = startView(shared, createDocument({ id: 'd', name: 'D' }));
    for (let i = 0; i < 4; i++) {
      manual.requests.at(-1)!.resolve(null);
      await flush();
    }
    expect(manual.requests).toHaveLength(4);
    expect(session.model.getState()).toMatchObject({ pending: false });
    expect(session.model.getState().error).toMatch(/kept dropping/);
    session.stop();
    await session.done;
  });

  it('refuses while an export holds the worker', async () => {
    const manual = manualRegenerator();
    const shared = shareRegenerator(manual.regenerator);
    let finish!: () => void;
    const work = shared.exclusive(() => new Promise<void>((r) => (finish = r)));
    const session = startView(shared, createDocument({ id: 'd', name: 'D' }));
    await expect(session.done).rejects.toThrow();
    expect(manual.requests).toHaveLength(0);
    finish();
    await work;
  });
});
