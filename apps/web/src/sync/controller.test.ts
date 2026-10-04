import { serialize, type Command, type ManufaktureDocument } from '@manufakture/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary } from '../persistence/library';
import { partDocument } from '../persistence/test-fixtures';
import { createDocumentStore, type DocumentStoreApi } from '../state/document';
import { SyncController, newClientKey, type SyncLocks } from './controller';
import { Hub } from './test-hub';

const SERVER = { url: 'https://sync.example', token: 't'.repeat(40) };

/** Web Locks shared by the tabs of one browser. */
function sharedLocks(): SyncLocks {
  const held = new Set<string>();
  return {
    acquire: (name) =>
      Promise.resolve(
        held.has(name)
          ? null
          : (held.add(name),
            () => {
              held.delete(name);
            }),
      ),
  };
}

/** The server's HTTP side over the hub's reference server. */
function serverFetch(hub: Hub, created: { value: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/api/documents') && init?.method === 'POST') {
      created.value = true;
      return json(201, { id: 'doc-1', head: 0 });
    }
    if (url.endsWith('/snapshot')) {
      if (!created.value) return json(404, { code: 'not-found', message: 'No such document' });
      return json(200, {
        rev: hub.server.revision,
        document: hub.server.head,
        highWater: hub.server.highWater,
      });
    }
    if (url.endsWith('/api/documents')) {
      return json(200, { documents: created.value ? [{ id: 'doc-1', name: 'Bracket' }] : [] });
    }
    return json(404, {});
  }) as typeof fetch;
}

interface Tab {
  documents: DocumentStoreApi;
  library: DocumentLibrary;
  controller: SyncController;
}

const controllers: SyncController[] = [];

function tab(
  hub: Hub,
  backend: MemoryBackend,
  locks: SyncLocks,
  created: { value: boolean },
  doc: ManufaktureDocument,
): Tab {
  const documents = createDocumentStore(doc);
  const library = new DocumentLibrary(backend, { locks: null, warn: () => undefined });
  const controller = new SyncController({
    documents,
    library,
    settings: () => SERVER,
    branch: () => 'main',
    locks,
    connect: () => hub.connect,
    fetch: serverFetch(hub, created),
    flush: () => Promise.resolve(true),
    online: () => true,
    lockPollMs: 20,
    loop: { saveDelayMs: 5 },
  });
  controllers.push(controller);
  return { documents, library, controller };
}

const renameFillet = (name: string): Command => ({
  type: 'renameFeature',
  partId: 'part#1',
  featureId: 'fillet#1',
  name,
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.stop();
});

describe('SyncController', () => {
  it('makes client keys the server accepts', () => {
    const key = newClientKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(newClientKey()).not.toBe(key);
  });

  it('switches sync on: the document goes to the server, the state to the library', async () => {
    const doc = partDocument();
    const hub = new Hub(doc);
    const created = { value: false };
    const backend = new MemoryBackend();
    const a = tab(hub, backend, sharedLocks(), created, doc);
    await a.library.save(doc);
    a.controller.start();
    await vi.waitFor(() => expect(a.controller.state.getState().status.kind).toBe('off'));

    expect(await a.controller.enable()).toBe(true);
    expect(created.value).toBe(true);
    expect(a.controller.state.getState().enabled).toBe(true);
    const stored = await a.library.readSync('doc-1');
    expect(stored.ok && stored.value?.record).toMatchObject({
      server: SERVER.url,
      clientKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    hub.open(hub.last);
    await hub.settle();
    expect(a.controller.state.getState().status).toEqual({ kind: 'synced' });

    a.documents.getState().execute({ type: 'renameDocument', name: 'Synced' }, 'Rename');
    await hub.settle();
    expect(hub.server.head.name).toBe('Synced');
    // The acknowledged entry is saved as settled soon after.
    await vi.waitFor(async () => {
      const after = await a.library.readSync('doc-1');
      const state = after.ok ? (after.value!.record.state as { latestAccepted?: number }) : null;
      expect(state?.latestAccepted).toBe(1);
    });
    expect(a.controller.state.getState().status).toEqual({ kind: 'synced' });

    expect(await a.controller.disable()).toBe(true);
    expect(await a.library.readSync('doc-1')).toEqual({ ok: true, value: null });
    expect(a.controller.state.getState()).toMatchObject({
      enabled: false,
      status: { kind: 'off' },
    });
  });

  it('one tab syncs; another with the document open says so, and takes over when it is free', async () => {
    const doc = partDocument();
    const hub = new Hub(doc);
    const created = { value: false };
    const backend = new MemoryBackend();
    const locks = sharedLocks();
    const a = tab(hub, backend, locks, created, doc);
    await a.library.save(doc);
    a.controller.start();
    await a.controller.enable();
    expect(a.controller.loop).not.toBeNull();

    const b = tab(hub, backend, locks, created, doc);
    b.controller.start();
    await vi.waitFor(() =>
      expect(b.controller.state.getState().status).toEqual({ kind: 'other-tab' }),
    );
    expect(b.controller.loop).toBeNull();

    a.controller.stop();
    await vi.waitFor(() => expect(b.controller.loop).not.toBeNull());
    expect(b.controller.state.getState().enabled).toBe(true);
  });

  it('opens a document from the server, and keeps work a rebase drops as a branch', async () => {
    const doc = partDocument();
    const hub = new Hub(doc);
    const created = { value: false };
    const a = tab(hub, new MemoryBackend(), sharedLocks(), created, doc);
    await a.library.save(doc);
    a.controller.start();
    await a.controller.enable();
    hub.open(hub.last);
    await hub.settle();
    const connA = hub.last;

    // Another browser: its own storage, opening the document from the server.
    const backendB = new MemoryBackend();
    const libB = new DocumentLibrary(backendB, { locks: null, warn: () => undefined });
    const b0 = tab(hub, backendB, sharedLocks(), created, partDocument('scratch'));
    expect(await b0.controller.listServerDocuments()).toEqual([{ id: 'doc-1', name: 'Bracket' }]);
    expect(await b0.controller.openFromServer('doc-1')).toBe('doc-1');
    const opened = await libB.open('doc-1');
    if (!opened.ok) throw new Error(opened.message);
    const b = tab(hub, backendB, sharedLocks(), created, opened.value.document);
    b.controller.start();
    await vi.waitFor(() => expect(b.controller.loop).not.toBeNull());
    const connB = hub.last;
    hub.open(connB);
    await hub.settle();
    expect(serialize(b.documents.getState().document)).toBe(serialize(doc));

    // B deletes the fillet while A renames it: B's lands first, A's is refused and dropped.
    b.documents
      .getState()
      .execute({ type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' }, 'Delete fillet');
    a.documents.getState().execute(renameFillet('Round'), 'Rename fillet');
    await vi.waitFor(() => expect(connA.outbox.some((m) => m.type === 'submit')).toBe(true));
    await vi.waitFor(() => expect(connB.outbox.some((m) => m.type === 'submit')).toBe(true));
    hub.process(connB);
    hub.process(connA);
    await hub.settle();

    const notices = a.controller.state.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('Rename fillet');
    await vi.waitFor(() => expect(a.controller.state.getState().notices[0]!.branch).toBeDefined());
    const branches = await a.library.listBranches('doc-1');
    expect(branches.ok && branches.value).toHaveLength(2);
    const kept = branches.ok ? branches.value[1]! : null;
    const onBranch = await a.library.open('doc-1', kept!.id);
    expect(
      onBranch.ok &&
        onBranch.value.document.parts[0]!.features.find((f) => f.id === 'fillet#1')?.name,
    ).toBe('Round');
    // Main follows the server: no fillet.
    expect(
      a.documents.getState().document.parts[0]!.features.some((f) => f.id === 'fillet#1'),
    ).toBe(false);
  });

  it('a document whose state names another server does not sync', async () => {
    const doc = partDocument();
    const hub = new Hub(doc);
    const created = { value: false };
    const backend = new MemoryBackend();
    const a = tab(hub, backend, sharedLocks(), created, doc);
    await a.library.save(doc);
    a.controller.start();
    await a.controller.enable();
    a.controller.stop();
    const other = new SyncController({
      documents: a.documents,
      library: a.library,
      settings: () => ({ ...SERVER, url: 'https://other.example' }),
      branch: () => 'main',
      locks: sharedLocks(),
      connect: () => hub.connect,
      flush: () => Promise.resolve(true),
    });
    controllers.push(other);
    other.start();
    await vi.waitFor(() =>
      expect(other.state.getState().status).toMatchObject({ kind: 'no-server' }),
    );
    expect(other.loop).toBeNull();
  });
});
