import { serialize, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  DocumentLibrary,
  RevisionConflict,
  parseUploads,
  type LogEntry,
  type SyncRecord,
} from './library';
import {
  CrashingBackend,
  cloneBackend,
  partDocument,
  partWithImport,
  newBackend,
  type TestBackend,
} from './test-fixtures';

// The sync state beside the snapshot (T7.1d; README, "Sync"): saved with the revision
// it belongs to and committed by the same head, so a crash at any step leaves the old pair or the
// new pair, never a queue with another revision's document.

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, clock++));

function library(backend: TestBackend | CrashingBackend = newBackend()) {
  return new DocumentLibrary(backend, { now, locks: null, warn: () => undefined });
}

function record(confirmed: ManufaktureDocument, marker: string): SyncRecord {
  return {
    server: 'https://sync.example',
    clientKey: 'k'.repeat(43),
    confirmed,
    state: { marker, entries: [{ command: { type: 'renameDocument', name: marker } }] },
  };
}

const renamed = (doc: ManufaktureDocument, name: string): ManufaktureDocument => ({
  ...doc,
  name,
});

const entry = (name: string): LogEntry => ({
  cause: 'execute',
  label: 'Rename',
  command: { type: 'renameDocument', name },
  at: '2026-10-04T12:00:00.000Z',
});

async function read(lib: DocumentLibrary, id = 'doc-1') {
  const r = await lib.readSync(id);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('sync state in the library', () => {
  it('saves the state with a revision and reads it back, files and all', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = await partWithImport();
    await lib.save(doc, [], undefined, record(doc, 'one'));
    const stored = await read(lib);
    expect(stored?.paired).toBe(true);
    expect(serialize(stored!.record.confirmed)).toBe(serialize(doc));
    expect(stored!.record.state).toEqual(record(doc, 'one').state);
    expect(stored!.record.clientKey).toBe('k'.repeat(43));
    // The imported file is a blob, not inline in the sync file.
    const syncFile = new TextDecoder().decode(
      backend.files.get('documents/doc-1/sync-00000001.json')!,
    );
    expect(syncFile).not.toContain('"data"');
    expect(JSON.parse(syncFile)).toMatchObject({ format: 'manufakture-sync', revision: 1 });
  });

  it('a document that never synced has none, and a branch never syncs', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc);
    expect(await read(lib)).toBeNull();
    await expect(lib.save(doc, [], 'some-branch', record(doc, 'x'))).rejects.toThrow(/main/);
  });

  it('saves the state alone for the revision the head names, keeping one spare', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, [], undefined, record(doc, 'one'));
    await lib.saveSync('doc-1', record(doc, 'two'));
    await lib.saveSync('doc-1', record(doc, 'three'));
    const stored = await read(lib);
    expect(stored).toMatchObject({ paired: true, record: { state: { marker: 'three' } } });
    const syncFiles = [...backend.files.keys()].filter((k) => k.includes('/sync-'));
    expect(syncFiles.sort()).toEqual([
      'documents/doc-1/sync-00000002.json',
      'documents/doc-1/sync-00000003.json',
    ]);
    // Revision unchanged: no new snapshot for a state alone.
    expect((await lib.open('doc-1')).ok && (await lib.open('doc-1'))).toMatchObject({
      value: { revision: 1 },
    });
  });

  it('says when a later save did not carry the state', async () => {
    const lib = library();
    const doc = partDocument();
    await lib.save(doc, [], undefined, record(doc, 'one'));
    await lib.save(renamed(doc, 'Elsewhere'), [entry('Elsewhere')]);
    expect(await read(lib)).toMatchObject({ paired: false, record: { state: { marker: 'one' } } });
    await lib.save(renamed(doc, 'Again'), [entry('Again')], undefined, record(doc, 'two'));
    expect(await read(lib)).toMatchObject({ paired: true, record: { state: { marker: 'two' } } });
  });

  it('refuses to save the state when another tab saved the document', async () => {
    const backend = newBackend();
    const a = library(backend);
    const b = library(backend);
    const doc = partDocument();
    await a.save(doc, [], undefined, record(doc, 'one'));
    await b.open('doc-1');
    await b.save(renamed(doc, 'B'), [entry('B')]);
    await expect(a.saveSync('doc-1', record(doc, 'two'))).rejects.toBeInstanceOf(RevisionConflict);
    expect(await read(a)).toMatchObject({ record: { state: { marker: 'one' } } });
  });

  it('stops syncing: the head names no state and the files go', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, [], undefined, record(doc, 'one'));
    await lib.dropSync('doc-1');
    expect(await read(lib)).toBeNull();
    expect([...backend.files.keys()].some((k) => k.includes('/sync-'))).toBe(false);
    // The document itself is untouched.
    const opened = await lib.open('doc-1');
    expect(opened.ok && serialize(opened.value.document)).toBe(serialize(doc));
  });

  // A crash at every step of a save with sync state, clean or torn: after a reload the document
  // and the state are the old pair or the new pair, and the next save works.
  for (const torn of [false, true]) {
    it(`a save crashed at any step leaves a matching pair (${torn ? 'torn' : 'clean'})`, async () => {
      const base = newBackend();
      const doc = await partWithImport();
      await library(base).save(doc, [], undefined, record(doc, 'old'));
      const next = renamed(doc, 'New');
      const counting = new CrashingBackend(cloneBackend(base));
      const lib0 = library(counting);
      await lib0.open('doc-1');
      await lib0.save(next, [entry('New')], undefined, record(next, 'new'));
      const steps = counting.ops.length;
      expect(counting.ops).toContain('write documents/doc-1/sync-00000002.json');
      for (let at = 0; at < steps; at++) {
        const crashing = new CrashingBackend(cloneBackend(base), at, torn);
        const lib = library(crashing);
        await lib.open('doc-1');
        await lib.save(next, [entry('New')], undefined, record(next, 'new')).catch(() => undefined);
        const after = library(crashing.inner);
        const opened = await after.open('doc-1');
        if (!opened.ok) throw new Error(opened.message);
        const stored = await read(after);
        const isNew = opened.value.document.name === 'New';
        expect(stored?.paired, `step ${at}`).toBe(true);
        expect((stored?.record.state as { marker: string }).marker, `step ${at}`).toBe(
          isNew ? 'new' : 'old',
        );
        expect(stored?.record.confirmed.name).toBe(isNew ? 'New' : doc.name);
        // The next save works and pairs.
        const third = renamed(next, 'Third');
        await after.save(third, [entry('Third')], undefined, record(third, 'third'));
        expect(await read(after)).toMatchObject({
          paired: true,
          record: { state: { marker: 'third' } },
        });
      }
    });

    it(`saving the state alone crashed at any step leaves old or new (${torn ? 'torn' : 'clean'})`, async () => {
      const base = newBackend();
      const doc = partDocument();
      const seed = library(base);
      await seed.save(doc, [], undefined, record(doc, 'old'));
      await seed.saveSync('doc-1', record(doc, 'older-spare'));
      await seed.saveSync('doc-1', record(doc, 'old'));
      const counting = new CrashingBackend(cloneBackend(base));
      const lib0 = library(counting);
      await lib0.open('doc-1');
      await lib0.saveSync('doc-1', record(doc, 'new'));
      const steps = counting.ops.length;
      for (let at = 0; at < steps; at++) {
        const crashing = new CrashingBackend(cloneBackend(base), at, torn);
        const lib = library(crashing);
        await lib.open('doc-1');
        await lib.saveSync('doc-1', record(doc, 'new')).catch(() => undefined);
        const after = library(crashing.inner);
        const opened = await after.open('doc-1');
        if (!opened.ok) throw new Error(opened.message);
        const stored = await read(after);
        expect(stored?.paired, `step ${at}`).toBe(true);
        expect(['old', 'new'], `step ${at}`).toContain(
          (stored?.record.state as { marker: string }).marker,
        );
        await after.saveSync('doc-1', record(doc, 'next'));
        expect(await read(after)).toMatchObject({ record: { state: { marker: 'next' } } });
      }
    });
  }

  it('fails, never falls back to an older state, when the state the head names cannot be read', async () => {
    const backend = newBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc, [], undefined, record(doc, 'one'));
    await lib.saveSync('doc-1', record(doc, 'two'));
    // The older state is still there as the spare; the named one is torn.
    expect(backend.files.has('documents/doc-1/sync-00000001.json')).toBe(true);
    backend.files.set('documents/doc-1/sync-00000002.json', new TextEncoder().encode('{"form'));
    const r = await library(backend).readSync('doc-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^Its sync state cannot be read/);
      expect(r.message).toContain('Switch sync off and on again');
    }
  });

  it('keeps the uploads waiting for the server with the state', async () => {
    const lib = library();
    const doc = partDocument();
    const uploads = {
      versions: [
        { id: 'v-1', after: 3 },
        { id: 'v-2', rev: 7 },
      ],
      branches: ['b-1'],
    };
    await lib.save(doc, [], undefined, { ...record(doc, 'one'), uploads });
    expect((await read(lib))!.record.uploads).toEqual(uploads);
    await lib.saveSync('doc-1', record(doc, 'two'));
    expect((await read(lib))!.record.uploads).toBeUndefined();
  });

  it('keeps the agent branches’ review states last known on the server (T8.4b)', async () => {
    const lib = library();
    const doc = partDocument();
    const uploads = {
      versions: [],
      branches: [],
      reviews: [
        { branch: 'b-1', review: 'changes-requested' as const, comment: 'Taller.' },
        { branch: 'b-2', review: 'submitted' as const },
      ],
    };
    await lib.save(doc, [], undefined, { ...record(doc, 'one'), uploads });
    expect((await read(lib))!.record.uploads).toEqual(uploads);
    for (const reviews of [
      [{ branch: 'main', review: 'open' }],
      [{ branch: 'b-1', review: 'merged' }],
      [{ branch: 'b-1', review: 'open', comment: '' }],
      [{ branch: '../x', review: 'open' }],
      'b-1',
    ]) {
      expect(parseUploads({ versions: [], branches: [], reviews }), JSON.stringify(reviews)).toBe(
        null,
      );
    }
  });
});
