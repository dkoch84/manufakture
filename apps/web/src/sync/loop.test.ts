import {
  DocumentStore,
  FORMAT_VERSION,
  PROTOCOL_VERSION,
  type ChangeEvent,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { SyncClient, type ClientMessage, type SyncQueueState } from '@manufakture/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partDocument } from '../persistence/test-fixtures';
import { PERSIST_RETRY_MS, RECONNECT_MS, RETRY_MS, SyncLoop, type LoopStatus } from './loop';
import { Hub, flushPromises, type FakeConnection } from './test-hub';

const rename = (name: string): Command => ({ type: 'renameDocument', name });
const renameFillet = (name: string): Command => ({
  type: 'renameFeature',
  partId: 'part#1',
  featureId: 'fillet#1',
  name,
});

interface Side {
  store: DocumentStore;
  client: SyncClient;
  loop: SyncLoop;
  conn: FakeConnection;
  persisted: { state: SyncQueueState; sentBefore: number }[];
  events: ChangeEvent[];
  statuses: LoopStatus[];
  dropped: string[][];
}

let persistOk = true;

function side(hub: Hub, clientId: string, doc: ManufaktureDocument = hub.server.head): Side {
  const created = DocumentStore.create(doc);
  if (!created.ok) throw new Error(created.error.message);
  const store = created.value;
  const client = new SyncClient(doc, hub.server.revision, { clientId });
  const persisted: Side['persisted'] = [];
  const events: ChangeEvent[] = [];
  store.subscribe((e) => events.push(e));
  const statuses: LoopStatus[] = [];
  const dropped: string[][] = [];
  const s = { store, client, persisted, events, statuses, dropped } as unknown as Side;
  s.loop = new SyncLoop({
    client,
    store,
    connect: hub.connect,
    persist: async () => {
      persisted.push({ state: client.save(), sentBefore: s.conn.sent.length });
      return persistOk;
    },
    online: () => true,
    onStatus: (st) => statuses.push(st),
    onDropped: (drops) => dropped.push(drops.map((d) => d.label)),
  });
  s.loop.start();
  s.conn = hub.last;
  return s;
}

const submits = (c: FakeConnection) =>
  c.sent.filter((m): m is Extract<ClientMessage, { type: 'submit' }> => m.type === 'submit');

describe('SyncLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistOk = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits a local change, saving the state before it is sent', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    expect(a.loop.status).toEqual({ kind: 'synced' });

    a.store.execute(rename('Plate'), 'Rename');
    expect(submits(a.conn)).toHaveLength(0); // not before the save
    await flushPromises();
    const sent = submits(a.conn);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.entries[0]!.command).toEqual(rename('Plate'));
    // The state saved before the send already holds the entry as sent.
    const save = a.persisted.at(-1)!;
    expect(save.sentBefore).toBeLessThan(a.conn.sent.length);
    expect(save.state.entries[0]).toMatchObject({
      state: 'in-flight',
      wire: { clientSeq: 1, transmitted: true },
    });
    expect(a.loop.status).toEqual({ kind: 'pending', pending: 1 });
    await hub.settle();
    expect(a.loop.status).toEqual({ kind: 'synced' });
    expect(hub.server.head.name).toBe('Plate');
  });

  it('sends nothing when the state cannot be saved, and tries again', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    persistOk = false;
    a.store.execute(rename('Plate'), 'Rename');
    await flushPromises();
    expect(submits(a.conn)).toHaveLength(0);
    expect(a.loop.status).toMatchObject({ kind: 'error', pending: 1 });
    persistOk = true;
    await vi.advanceTimersByTimeAsync(PERSIST_RETRY_MS);
    expect(submits(a.conn)).toHaveLength(1);
    expect(submits(a.conn)[0]!.entries[0]!.clientSeq).toBe(1);
    await hub.settle();
    expect(hub.server.head.name).toBe('Plate');
  });

  it('sends entries without a verdict again on the retry timer, under the same clientSeq', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    a.store.execute(rename('Plate'), 'Rename');
    await flushPromises();
    a.conn.outbox.length = 0; // the submit is lost on the way
    expect(submits(a.conn)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    const sent = submits(a.conn);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.entries.map((e) => e.clientSeq)).toEqual([1]);
    await hub.settle();
    expect(hub.server.revision).toBe(1);
    expect(a.loop.status).toEqual({ kind: 'synced' });
  });

  it('reconnects and resends what was in flight', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    a.store.execute(rename('Plate'), 'Rename');
    await flushPromises();
    a.conn.outbox.length = 0;
    hub.drop(a.conn);
    expect(a.loop.status).toEqual({ kind: 'connecting', pending: 1 });
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    const again = hub.last;
    expect(again).not.toBe(a.conn);
    hub.open(again);
    await flushPromises();
    expect(again.sent[0]).toMatchObject({ type: 'hello', clientId: 'a' });
    expect(submits(again)[0]!.entries[0]!.clientSeq).toBe(1);
    await hub.settle();
    expect(hub.server.head.name).toBe('Plate');
  });

  it("shows others' entries as remote changes and leaves the local undo stack alone", async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    const b = side(hub, 'b');
    hub.open(a.conn);
    hub.open(b.conn);
    await hub.settle();
    a.store.execute(renameFillet('Round'), 'Rename fillet');
    await hub.settle();
    const undoBefore = a.store.undoStack;
    b.store.execute(rename('From B'), 'Rename');
    await hub.settle();
    expect(a.store.document.name).toBe('From B');
    const remote = a.events.filter((e) => e.cause === 'remote');
    expect(remote).toHaveLength(1);
    expect(remote[0]!.command).toEqual({ type: 'replaceDocument', document: a.store.document });
    expect(a.store.undoStack).toEqual(undoBefore);
    // Undo still undoes A's own change, and it syncs.
    a.store.undo();
    await hub.settle();
    expect(hub.server.head.parts[0]!.features.find((f) => f.id === 'fillet#1')!.name).not.toBe(
      'Round',
    );
    expect(b.store.document.name).toBe('From B');
  });

  it('drops a command the server refuses after others changed the document, with a notice', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    const b = side(hub, 'b');
    hub.open(a.conn);
    hub.open(b.conn);
    await hub.settle();
    b.store.execute(
      { type: 'deleteFeature', partId: 'part#1', featureId: 'fillet#1' },
      'Delete fillet',
    );
    a.store.execute(renameFillet('Round'), 'Rename fillet');
    await flushPromises();
    // B's delete is judged first, then A's rename, which no longer applies.
    hub.process(b.conn);
    hub.process(a.conn);
    await hub.settle();
    expect(a.dropped).toEqual([['Rename fillet']]);
    expect(a.store.document.parts[0]!.features.some((f) => f.id === 'fillet#1')).toBe(false);
    expect(a.store.canUndo).toBe(false);
    expect(a.loop.status).toEqual({ kind: 'synced' });
  });

  it('stops for good when the server log disagrees (server-fault)', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    a.conn.handlers.onMessage({
      type: 'push',
      entries: [
        {
          rev: 1,
          entry: {
            clientId: 'z',
            clientSeq: 1,
            baseRev: 0,
            format: FORMAT_VERSION,
            cause: 'execute',
            label: 'Bogus',
            command: { ...renameFillet('Nope'), featureId: 'fillet#99' },
            created: {},
            at: '2026-10-04T12:00:00.000Z',
          },
        },
      ],
    });
    expect(a.loop.status.kind).toBe('fault');
    expect(a.conn.closed).toBe(true);
    const sentBefore = a.conn.sent.length;
    a.store.execute(rename('Plate'), 'Rename');
    await vi.advanceTimersByTimeAsync(RETRY_MS + RECONNECT_MS);
    expect(hub.connections).toHaveLength(1);
    expect(a.conn.sent).toHaveLength(sentBefore);
  });

  it('says to update the app when the server speaks a newer protocol', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    a.conn.handlers.onMessage({
      type: 'welcome',
      protocol: PROTOCOL_VERSION + 1,
      format: FORMAT_VERSION,
      head: 0,
    });
    expect(a.loop.status.kind).toBe('update-app');
    expect(a.statuses.at(-1)!.kind).toBe('update-app');
    expect(a.conn.closed).toBe(true);
  });

  it('says the server must be upgraded when it is the older side', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    a.conn.handlers.onMessage({
      type: 'welcome',
      protocol: PROTOCOL_VERSION - 1,
      format: FORMAT_VERSION,
      head: 0,
    });
    expect(a.loop.status.kind).toBe('upgrade-server');
  });

  it('keeps changes made offline and sends them once online', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    hub.open(a.conn);
    await hub.settle();
    a.loop.setOnline(false);
    a.store.execute(rename('Offline'), 'Rename');
    await flushPromises();
    expect(submits(a.conn)).toHaveLength(0);
    expect(a.loop.status).toEqual({ kind: 'offline', pending: 1 });
    a.loop.setOnline(true);
    await hub.settle();
    expect(hub.server.head.name).toBe('Offline');
  });

  it('renames ids in the local undo stack when a concurrent add takes them', async () => {
    const hub = new Hub(partDocument());
    const a = side(hub, 'a');
    const b = side(hub, 'b');
    hub.open(a.conn);
    hub.open(b.conn);
    await hub.settle();
    const extrude = (doc: ManufaktureDocument, name: string) => {
      const p = doc.parts[0]!;
      const id = `extrude#${p.nextIds['extrude'] ?? 1}`;
      const base = p.features.find((f) => f.id === 'extrude#1')!;
      return { type: 'addFeature', partId: 'part#1', feature: { ...base, id, name } } as Command;
    };
    b.store.execute(extrude(b.store.document, 'From B'), 'Add B');
    a.store.execute(extrude(a.store.document, 'From A'), 'Add A');
    const taken = a.store.document.parts[0]!.features.at(-1)!.id;
    await flushPromises();
    hub.process(b.conn);
    hub.process(a.conn);
    await hub.settle();
    const features = a.store.document.parts[0]!.features;
    const mine = features.find((f) => f.name === 'From A')!;
    expect(features.find((f) => f.name === 'From B')!.id).toBe(taken);
    expect(mine.id).not.toBe(taken);
    // Undo removes A's own extrude under its new id, not B's.
    a.store.undo();
    await hub.settle();
    const after = hub.server.head.parts[0]!.features;
    expect(after.some((f) => f.name === 'From B')).toBe(true);
    expect(after.some((f) => f.name === 'From A')).toBe(false);
  });
});
