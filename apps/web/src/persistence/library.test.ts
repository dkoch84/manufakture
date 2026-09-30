import { applyCommand, FORMAT_VERSION, serialize, type Command } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { MemoryBackend, type StorageBackend } from './backend';
import {
  CHECKPOINT_EVERY,
  DocumentLibrary,
  MAX_VERSIONS,
  RevisionConflict,
  encodeStored,
  type DocumentLocks,
  type LogEntry,
  type Version,
} from './library';
import { MFK_LIMITS, packMfk, unpackMfk } from './mfk';
import {
  CrashingBackend,
  cloneBackend,
  emptyDocument,
  partDocument,
  partWithDerived,
  partWithImport,
  stlImport,
  unwrapDoc,
} from './test-fixtures';

const decoder = new TextDecoder();
const text = (backend: MemoryBackend, path: string) => decoder.decode(backend.files.get(path)!);
const files = (backend: MemoryBackend) => [...backend.files.keys()].sort();

let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 26, 12, 0, clock++));

function library(
  backend: MemoryBackend | CrashingBackend = new MemoryBackend(),
  locks?: DocumentLocks,
) {
  let n = 0;
  return new DocumentLibrary(backend, { now, newId: () => `copy-${++n}`, locks: locks ?? null });
}

/** Web Locks between the libraries sharing it (tabs), recording each lock taken. */
function sharedLocks(): DocumentLocks & { names: string[] } {
  const tails = new Map<string, Promise<unknown>>();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

const renameEntry = (name: string): LogEntry => ({
  cause: 'execute',
  label: 'Rename document',
  command: { type: 'renameDocument', name },
  at: `at ${name}`,
});

async function opened(lib: DocumentLibrary, id: string) {
  const r = await lib.open(id);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('DocumentLibrary', () => {
  it('saves and opens a document unchanged, as numbered snapshots behind a head', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    const doc = partDocument();
    const s1 = await lib.save(doc);
    expect(s1).toMatchObject({ id: 'doc-1', name: 'Bracket', revision: 1 });
    expect((await opened(lib, 'doc-1')).document).toEqual(doc);

    const renamed = unwrapDoc(applyCommand(doc, { type: 'renameDocument', name: 'Shelf' }));
    const s2 = await lib.save(renamed);
    expect(s2.revision).toBe(2);
    expect(s2.createdAt).toBe(s1.createdAt);
    expect(files(backend)).toEqual([
      'documents/doc-1/head.json',
      'documents/doc-1/snapshot-00000001.json',
      'documents/doc-1/snapshot-00000002.json',
    ]);
    // A fourth save drops revision 2 and keeps the previous one as a spare; revision 1 is a
    // checkpoint, and stays.
    await lib.save(doc);
    await lib.save(doc);
    expect(files(backend).filter((f) => f.includes('snapshot'))).toEqual([
      'documents/doc-1/snapshot-00000001.json',
      'documents/doc-1/snapshot-00000003.json',
      'documents/doc-1/snapshot-00000004.json',
    ]);
    const head = JSON.parse(text(backend, 'documents/doc-1/head.json'));
    expect(head).toMatchObject({ format: 'manufakture-head', revision: 4, name: 'Bracket' });
    expect((await opened(lib, 'doc-1')).recovered).toBe(false);
  });

  it('stores an imported file once, as a blob keyed by its SHA-256, outside the snapshot', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    const doc = await partWithImport();
    const source = (doc.parts[0]!.features.at(-1) as Awaited<ReturnType<typeof stlImport>>).source;
    await lib.save(doc);
    await lib.save(doc);
    const blobPath = `documents/doc-1/blobs/${source.sha256}`;
    expect(files(backend).filter((f) => f.includes('/blobs/'))).toEqual([blobPath]);
    expect(backend.files.get(blobPath)!.length).toBe(source.size);
    const snapshot = text(backend, 'documents/doc-1/snapshot-00000002.json');
    expect(snapshot).not.toContain(source.data);
    expect(JSON.parse(snapshot).parts[0].features.at(-1).source).toEqual({
      format: 'stl',
      fileName: 'cube.stl',
      size: source.size,
      sha256: source.sha256,
    });
    expect((await opened(library(backend), 'doc-1')).document).toEqual(doc);
    const [summary] = await lib.list();
    expect(summary!.bytes).toBe(
      backend.files.get('documents/doc-1/snapshot-00000002.json')!.length + source.size,
    );
  });

  it('stores a pinned version once, as a blob of its UTF-8 text, and opens it again', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    const doc = await partWithDerived();
    const feature = doc.parts[0]!.features.at(-1)!;
    if (feature.kind !== 'derived') throw new Error('expected a derived feature');
    await lib.save(doc);
    await lib.save(doc);
    const blobPath = `documents/doc-1/blobs/${feature.source.sha256}`;
    expect(files(backend).filter((f) => f.includes('/blobs/'))).toEqual([blobPath]);
    expect(new TextDecoder().decode(backend.files.get(blobPath)!)).toBe(feature.source.data);
    const snapshot = text(backend, 'documents/doc-1/snapshot-00000002.json');
    expect(JSON.parse(snapshot).parts[0].features.at(-1).source.data).toBeUndefined();
    expect((await opened(library(backend), 'doc-1')).document).toEqual(doc);
  });

  it('refuses a blob that does not match its SHA-256 or is missing', async () => {
    const backend = new MemoryBackend();
    const doc = await partWithImport();
    const { sha256 } = (doc.parts[0]!.features.at(-1) as Awaited<ReturnType<typeof stlImport>>)
      .source;
    await library(backend).save(doc);
    const path = `documents/doc-1/blobs/${sha256}`;
    const bytes = backend.files.get(path)!;
    bytes[100] = bytes[100]! ^ 0xff;
    let r = await library(backend).open('doc-1');
    expect(r.ok ? null : r.message).toBe(
      'The imported file cube.stl is damaged: its SHA-256 does not match.',
    );
    backend.files.delete(path);
    r = await library(backend).open('doc-1');
    expect(r.ok ? null : r.message).toBe('The imported file cube.stl is missing.');
    // The list trusts the head (reading every blob would be slow): opening finds the damage.
    expect((await library(backend).list())[0]).toMatchObject({ id: 'doc-1', name: 'Bracket' });
  });

  it('logs commands beside the snapshots, imported files by reference, and reads them back', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    const doc = partDocument();
    await lib.save(doc);
    const feature = await stlImport();
    const add: Command = { type: 'addFeature', partId: 'part#1', feature };
    const withImport = unwrapDoc(applyCommand(doc, add));
    const entries: LogEntry[] = [
      { cause: 'execute', label: 'Import cube.stl', command: add, at: '2026-09-26T12:00:00.000Z' },
      {
        cause: 'undo',
        label: 'Import cube.stl',
        command: { type: 'deleteFeature', partId: 'part#1', featureId: 'import#1' },
        at: '2026-09-26T12:00:01.000Z',
      },
      {
        cause: 'redo',
        label: 'Import cube.stl',
        command: {
          type: 'restoreFeature',
          partId: 'part#1',
          feature,
          index: 5,
          rollbackIndex: null,
        },
        at: '2026-09-26T12:00:02.000Z',
      },
    ];
    await lib.save(withImport, entries);
    const log = text(backend, 'documents/doc-1/log-00000002.json');
    expect(log).not.toContain(feature.source.data);
    expect(JSON.parse(log)).toMatchObject({ format: 'manufakture-log', revision: 2, base: 1 });
    // The file is stored once for the snapshot and both logged commands.
    expect(files(backend).filter((f) => f.includes('/blobs/'))).toHaveLength(1);
    const read = await library(backend).readLog('doc-1');
    expect(read).toEqual({ ok: true, value: entries });
  });

  it('keeps a logged import even once the document no longer holds it', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    const doc = partDocument();
    const feature = await stlImport();
    const add: Command = { type: 'addFeature', partId: 'part#1', feature };
    // Imported and undone before the first save: only the log has the file.
    await lib.save(doc, [{ cause: 'execute', label: 'Import', command: add, at: 'x' }]);
    expect(await library(backend).readLog('doc-1')).toEqual({
      ok: true,
      value: [{ cause: 'execute', label: 'Import', command: add, at: 'x' }],
    });
  });

  it('refuses a document saved by a newer app, without falling back or changing anything', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(partDocument());
    await lib.save(partDocument());
    const path = 'documents/doc-1/snapshot-00000002.json';
    const json = JSON.parse(text(backend, path));
    json.version = FORMAT_VERSION + 1;
    backend.files.set(path, new TextEncoder().encode(JSON.stringify(json)));
    backend.files.delete('documents/doc-1/head.json');
    const before = files(backend);
    const r = await library(backend).open('doc-1');
    expect(r.ok ? null : r.message).toMatch(/saved by a newer version of manufakture/);
    expect(files(backend)).toEqual(before);
  });

  it('lists documents most recent first, and renames, duplicates and deletes them', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(emptyDocument('a', 'Alpha'));
    await lib.save(await partWithImport('b'));
    expect((await lib.list()).map((d) => d.id)).toEqual(['b', 'a']);

    const renamed = await lib.rename('a', '  Shelf  ');
    expect(renamed).toMatchObject({ ok: true, value: { id: 'a', name: 'Shelf', revision: 2 } });
    expect((await opened(lib, 'a')).document.name).toBe('Shelf');
    const log = await lib.readLog('a');
    expect(log.ok && log.value.map((e) => e.command)).toEqual([
      { type: 'renameDocument', name: '  Shelf  ' },
    ]);
    expect(await lib.rename('a', '   ')).toEqual({
      ok: false,
      message: 'A document name must be 1 to 200 characters',
    });

    const copy = await lib.duplicate('b');
    expect(copy).toMatchObject({ ok: true, value: { id: 'copy-1', name: 'Bracket (copy)' } });
    const original = (await opened(lib, 'b')).document;
    expect((await opened(lib, 'copy-1')).document).toEqual({
      ...original,
      id: 'copy-1',
      name: 'Bracket (copy)',
    });
    // The copy has its own files: deleting the original leaves it whole.
    await lib.remove('b');
    expect(files(backend).some((f) => f.startsWith('documents/b/'))).toBe(false);
    expect((await opened(library(backend), 'copy-1')).document.parts).toEqual(original.parts);
    expect((await lib.list()).map((d) => d.id)).toEqual(['copy-1', 'a']);
    expect(await lib.open('b')).toEqual({ ok: false, message: 'There is no document "b".' });
  });

  it('refuses ids that are not safe as directory names', async () => {
    const lib = library();
    await expect(lib.save(emptyDocument('../evil'))).rejects.toThrow(/Cannot store/);
    expect(await lib.open('../evil')).toEqual({
      ok: false,
      message: 'There is no document "../evil".',
    });
  });

  it('refuses to delete an unsafe id before taking any lock', async () => {
    const locks = sharedLocks();
    const lib = library(new MemoryBackend(), locks);
    await expect(lib.remove('../evil')).rejects.toThrow('Cannot delete a document "../evil"');
    expect(locks.names).toEqual([]);
  });
});

describe('crash safety', () => {
  /** Revision 1 of the part, and the change saved as revision 2 (which adds an import). */
  async function start() {
    const backend = new MemoryBackend();
    const before = partDocument();
    await library(backend).save(before);
    const after = await partWithImport();
    const entries: LogEntry[] = [
      {
        cause: 'execute',
        label: 'Import',
        command: { type: 'renameDocument', name: 'x' },
        at: 'a',
      },
    ];
    return { backend, before, after, entries };
  }

  it('lists the steps of a save: blobs, log, snapshot, then the head', async () => {
    const { backend, after, entries } = await start();
    const counting = new CrashingBackend(backend);
    await new DocumentLibrary(counting, { now }).save(after, entries);
    expect(counting.ops.map((o) => o.replace(/[0-9a-f]{64}/, '<sha>'))).toEqual([
      'write documents/doc-1/blobs/<sha>',
      'write documents/doc-1/log-00000002.json',
      'write documents/doc-1/snapshot-00000002.json',
      'write documents/doc-1/head.json',
    ]);
  });

  // A crash at every step of the save, clean or leaving a torn file: after a reload the
  // document is the old one or the new one, never damaged, and the next save works.
  const steps = [0, 1, 2, 3, 4];
  for (const torn of [false, true]) {
    it.each(steps)(
      `recovers from a crash at step %i (${torn ? 'torn write' : 'clean'})`,
      async (at) => {
        const { backend: base, before, after, entries } = await start();
        // Step 4 is the cleanup after the head (a fourth save removes revision 2; revision 1
        // is a checkpoint).
        if (at === 4) {
          await library(base).save(before);
          await library(base).save(before);
        }
        const backend = cloneBackend(base);
        const crashing = new CrashingBackend(backend, at, torn);
        const save = new DocumentLibrary(crashing, { now }).save(after, entries);
        // The cleanup after the head is best effort: a failure there does not fail the save.
        if (at === 4) await save;
        else await expect(save).rejects.toThrow(/Simulated crash/);
        expect(crashing.ops).toHaveLength(at + 1);

        const reloaded = library(backend);
        const r = await opened(reloaded, 'doc-1');
        // The snapshot is complete from step 3 on (a torn head is recovered forward).
        expect(r.document).toEqual(at >= 3 ? after : before);
        expect(r.recovered).toBe(at === 3);
        const [listed] = await reloaded.list();
        const saved = at === 4 ? 3 : 1;
        expect(listed).toMatchObject({ name: 'Bracket', revision: at >= 3 ? saved + 1 : saved });

        // The next save and open work, and the log still reads.
        await reloaded.save(after, entries);
        expect((await opened(library(backend), 'doc-1')).document).toEqual(after);
        expect((await reloaded.readLog('doc-1')).ok).toBe(true);
      },
    );
  }

  it('recovers when the head is missing and deletes the files of a later broken save', async () => {
    const { backend, before, after } = await start();
    await library(backend).save(after);
    // A third save died with its snapshot torn, and the head is gone too.
    backend.files.set('documents/doc-1/snapshot-00000003.json', new TextEncoder().encode('{"form'));
    backend.files.set('documents/doc-1/log-00000003.json', new TextEncoder().encode('{}'));
    backend.files.delete('documents/doc-1/head.json');
    const lib = library(backend);
    const r = await opened(lib, 'doc-1');
    expect(r).toMatchObject({ document: after, recovered: true });
    expect(files(backend).filter((f) => !f.includes('/blobs/'))).toEqual([
      'documents/doc-1/head.json',
      'documents/doc-1/snapshot-00000001.json',
      'documents/doc-1/snapshot-00000002.json',
    ]);
    expect((await lib.list())[0]).toMatchObject({ id: 'doc-1', revision: 2, name: 'Bracket' });
    void before;
  });

  it('uses the snapshot the head names when it reads, even with another SHA-256, and keeps it', async () => {
    // Two tabs saving at once without locks: one tab's head over the other's snapshot. Both
    // are real work; the one on disk is used, the head corrected, and nothing deleted.
    const { backend, after } = await start();
    await library(backend).save(after);
    const path = 'documents/doc-1/snapshot-00000002.json';
    const changed = text(backend, path).replace('"Bracket"', '"Brackex"');
    backend.files.set(path, new TextEncoder().encode(changed));
    const warnings: string[] = [];
    const lib = new DocumentLibrary(backend, { now, locks: null, warn: (m) => warnings.push(m) });
    const r = await opened(lib, 'doc-1');
    expect(r).toMatchObject({ document: { ...after, name: 'Brackex' }, recovered: true });
    expect(warnings).toEqual([
      expect.stringMatching(/revision 2 of document doc-1 does not match/),
    ]);
    expect(backend.files.has(path)).toBe(true);
    expect((await opened(library(backend), 'doc-1')).recovered).toBe(false);
  });

  it('falls back when the snapshot the head names cannot be read, without deleting it', async () => {
    const { backend, before, after } = await start();
    await library(backend).save(after);
    const path = 'documents/doc-1/snapshot-00000002.json';
    const invalid = { ...JSON.parse(text(backend, path)), parts: [] };
    backend.files.set(path, new TextEncoder().encode(JSON.stringify(invalid)));
    const r = await opened(library(backend), 'doc-1');
    expect(r).toMatchObject({ document: before, recovered: true });
    expect(backend.files.has(path)).toBe(true);
  });
});

describe('a complete snapshot that cannot be read', () => {
  it('is kept aside, with its log, before the head moves off it: later opens and saves never delete it', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Two'), [renameEntry('Two')]);
    const three = await partWithImport();
    await lib.save(three, [renameEntry('Three')]);
    const snapshot3 = backend.files.get('documents/doc-1/snapshot-00000003.json')!;
    const log3 = backend.files.get('documents/doc-1/log-00000003.json')!;
    // Only the blob revision 3 needs goes missing: revision 3 is whole, and committed.
    const source = (three.parts[0]!.features.at(-1) as Awaited<ReturnType<typeof stlImport>>)
      .source;
    backend.files.delete(`documents/doc-1/blobs/${source.sha256}`);

    const warnings: string[] = [];
    const reopen = () =>
      new DocumentLibrary(backend, { now, locks: null, warn: (m) => warnings.push(m) });
    const first = await opened(reopen(), 'doc-1');
    expect(first).toMatchObject({ document: { name: 'Two' }, recovered: true, revision: 2 });
    const damaged = files(backend).filter((f) => f.includes('/damaged-'));
    expect(damaged.map((f) => f.replace(/-[0-9a-f]{16}\.json$/, ''))).toEqual([
      'documents/doc-1/damaged-log-00000003',
      'documents/doc-1/damaged-snapshot-00000003',
    ]);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^manufakture: revision 3 of document doc-1 is complete but cannot be read \(The imported file cube\.stl is missing\.\); it is kept as damaged-snapshot-00000003-/,
      ),
    ]);

    // The second open (the head now names 2) drops revision 3's files above the head, and a
    // save goes on from 2; the copies stay, byte for byte.
    const second = reopen();
    expect(await opened(second, 'doc-1')).toMatchObject({ recovered: false, revision: 2 });
    expect(backend.files.has('documents/doc-1/snapshot-00000003.json')).toBe(false);
    expect(await second.save(partDocument('doc-1', 'Four'))).toMatchObject({ revision: 3 });
    const [damagedLog, damagedSnapshot] = damaged;
    expect(backend.files.get(damagedSnapshot!)).toEqual(snapshot3);
    expect(backend.files.get(damagedLog!)).toEqual(log3);
    expect(warnings).toHaveLength(1);
    // Nothing reads them as a revision.
    expect((await opened(reopen(), 'doc-1')).document.name).toBe('Four');
    // Deleting the document deletes them too.
    await second.remove('doc-1');
    expect(files(backend)).toEqual([]);
  });

  it('is not kept when it is cut short (a torn write), nor when it is missing', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Two'));
    const path = 'documents/doc-1/snapshot-00000002.json';
    const bytes = backend.files.get(path)!;
    backend.files.set(path, bytes.slice(0, bytes.length / 2));
    expect(await opened(library(backend), 'doc-1')).toMatchObject({ recovered: true });
    expect(files(backend).some((f) => f.includes('damaged'))).toBe(false);
  });
});

describe('a failed save, retried in the same session', () => {
  it('logs each command once and keeps the last committed snapshot as the spare', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    await library(backend).save(partDocument('doc-1', 'Two'));
    // The next save writes its log segment, then fails on the snapshot (a full disk, say).
    const failing = new CrashingBackend(backend, 1);
    const lib = library(failing);
    await opened(lib, 'doc-1');
    const three = partDocument('doc-1', 'Three');
    await expect(lib.save(three, [renameEntry('Three')])).rejects.toThrow(/Simulated crash/);
    expect(files(backend)).toContain('documents/doc-1/log-00000003.json');

    // The retry (autosave's, without reopening) commits revision 3 with the one command.
    expect(await lib.save(three, [renameEntry('Three')])).toMatchObject({ revision: 3 });
    expect(await lib.readLog('doc-1')).toEqual({ ok: true, value: [renameEntry('Three')] });
    expect(files(backend).filter((f) => !f.includes('/blobs/'))).toEqual([
      'documents/doc-1/head.json',
      'documents/doc-1/log-00000003.json',
      'documents/doc-1/snapshot-00000001.json',
      'documents/doc-1/snapshot-00000002.json',
      'documents/doc-1/snapshot-00000003.json',
    ]);
  });

  it('logs its commands once when the head was written but the write then failed', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument(), [renameEntry('One')]);
    // The head's bytes land, then the write reports a failure (a quota error on close, say).
    let failHead = true;
    const flaky: StorageBackend = Object.assign(Object.create(backend) as MemoryBackend, {
      async write(path: string, bytes: Uint8Array) {
        await backend.write(path, bytes);
        if (failHead && path.endsWith('/head.json')) {
          failHead = false;
          throw new Error('The write failed after all');
        }
      },
    });
    const lib = library(flaky as MemoryBackend);
    await opened(lib, 'doc-1');
    const two = [renameEntry('Two')];
    await expect(lib.save(partDocument('doc-1', 'Two'), two)).rejects.toThrow(/after all/);
    // Autosave retries with the same commands first, then the newer ones.
    const three = [...two, renameEntry('Three')];
    expect(await lib.save(partDocument('doc-1', 'Three'), three)).toMatchObject({ revision: 3 });
    const log = await library(backend).readLog('doc-1');
    expect(log.ok && log.value.map((e) => e.at)).toEqual(['at One', 'at Two', 'at Three']);
  });

  it('builds on its own recovered snapshot when the failure tore the head', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    // Blob-free save: log, snapshot, then a torn head.
    const failing = new CrashingBackend(backend, 2, true);
    const lib = library(failing);
    await opened(lib, 'doc-1');
    await expect(lib.save(partDocument('doc-1', 'Two'), [renameEntry('Two')])).rejects.toThrow();
    await lib.save(partDocument('doc-1', 'Three'), [renameEntry('Three')]);
    expect((await opened(library(backend), 'doc-1')).document.name).toBe('Three');
    const log = await library(backend).readLog('doc-1');
    expect(log.ok && log.value.map((e) => e.at)).toEqual(['at Two', 'at Three']);
  });
});

describe('the command log', () => {
  it('follows the chain back from the head, and refuses a segment of the wrong shape', async () => {
    const backend = new MemoryBackend();
    const lib = library(backend);
    await lib.save(partDocument(), [renameEntry('One')]);
    await lib.save(partDocument());
    await lib.save(partDocument(), [renameEntry('Three')]);
    const log = await lib.readLog('doc-1');
    expect(log.ok && log.value.map((e) => e.at)).toEqual(['at One', 'at Three']);

    const path = 'documents/doc-1/log-00000003.json';
    const segment = JSON.parse(text(backend, path));
    for (const bad of [
      { ...segment, entries: [{ cause: 'explode', label: 'x', command: { type: 'x' }, at: 'x' }] },
      { ...segment, entries: [{ cause: 'execute', label: 'x', command: 'x', at: 'x' }] },
      { ...segment, entries: 'nope' },
      { ...segment, base: 3 },
      { ...segment, revision: 7 },
      { ...segment, format: 'other' },
    ]) {
      backend.files.set(path, new TextEncoder().encode(JSON.stringify(bad)));
      expect(await lib.readLog('doc-1')).toEqual({
        ok: false,
        message: 'The command log is damaged at revision 3.',
      });
    }
    backend.files.set(path, new TextEncoder().encode('{"torn'));
    expect(await lib.readLog('doc-1')).toMatchObject({ ok: false });
  });
});

describe('listing', () => {
  it('describes a document without a head from its snapshots, without writing anything', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    await library(backend).save(partDocument('doc-1', 'Two'));
    backend.files.delete('documents/doc-1/head.json');
    const before = files(backend);
    expect(await library(backend).list()).toEqual([
      expect.objectContaining({ id: 'doc-1', name: 'Two', revision: 2 }),
    ]);
    expect(files(backend)).toEqual(before);
    // Opening repairs it.
    await opened(library(backend), 'doc-1');
    expect(files(backend)).toContain('documents/doc-1/head.json');
  });
});

describe('several tabs on one document', () => {
  it('takes the document lock for open, save, rename, duplicate, export and delete', async () => {
    const locks = sharedLocks();
    const lib = library(new MemoryBackend(), locks);
    await lib.save(partDocument('d'));
    await lib.open('d');
    await lib.rename('d', 'New');
    await lib.duplicate('d');
    await lib.exportMfk('d');
    await lib.remove('d');
    expect(locks.names).toEqual([
      'manufakture-document-d',
      'manufakture-document-d',
      'manufakture-document-d',
      'manufakture-document-d',
      'manufakture-document-copy-1',
      'manufakture-document-d',
      'manufakture-document-d',
    ]);
  });

  it('two tabs saving at once: one commits, the other is refused, and nothing interleaves', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    const locks = sharedLocks();
    const tabA = library(backend, locks);
    const tabB = library(backend, locks);
    await opened(tabA, 'doc-1');
    await opened(tabB, 'doc-1');
    const [a, b] = await Promise.allSettled([
      tabA.save(partDocument('doc-1', 'From A'), [renameEntry('From A')]),
      tabB.save(partDocument('doc-1', 'From B'), [renameEntry('From B')]),
    ]);
    expect(a).toMatchObject({ status: 'fulfilled', value: { revision: 2 } });
    expect(b).toMatchObject({ status: 'rejected', reason: expect.any(RevisionConflict) });
    const r = await opened(library(backend), 'doc-1');
    expect(r).toMatchObject({ document: { name: 'From A' }, recovered: false });
    expect(await library(backend).readLog('doc-1')).toEqual({
      ok: true,
      value: [renameEntry('From A')],
    });
  });

  it('without Web Locks: a save that finds the head moved just before its commit is refused, and overwrites nothing', async () => {
    // IndexedDB on an insecure origin: no locks. Tab B has written its snapshot when tab A's
    // whole save runs; only B's last look at the head stands between B and dropping A's work.
    const backend = new MemoryBackend();
    await library(backend).save(partDocument(), [renameEntry('One')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => (paused = resolve));
    const gated: StorageBackend = Object.assign(Object.create(backend) as MemoryBackend, {
      async write(path: string, bytes: Uint8Array) {
        await backend.write(path, bytes);
        if (path.endsWith('/snapshot-00000002.json')) {
          paused();
          await gate;
        }
      },
    });
    const tabA = new DocumentLibrary(backend, { now, locks: null });
    const tabB = new DocumentLibrary(gated, { now, locks: null });
    await opened(tabA, 'doc-1');
    await opened(tabB, 'doc-1');
    const b = tabB.save(partDocument('doc-1', 'From B'), [renameEntry('From B')]);
    await reached;
    expect(await tabA.save(partDocument('doc-1', 'From A'), [renameEntry('From A')])).toMatchObject(
      { revision: 2 },
    );
    release();
    await expect(b).rejects.toThrow(RevisionConflict);

    const r = await opened(library(backend), 'doc-1');
    expect(r).toMatchObject({ document: { name: 'From A' }, recovered: false, revision: 2 });
    expect(await library(backend).readLog('doc-1')).toEqual({
      ok: true,
      value: [renameEntry('One'), renameEntry('From A')],
    });
  });

  it('refuses to save over a newer revision from another tab; the tab can keep its version as a copy', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    const tabA = library(backend);
    const tabB = library(backend);
    await opened(tabA, 'doc-1');
    await opened(tabB, 'doc-1');
    await tabB.save(partDocument('doc-1', 'From B'));
    const mine = partDocument('doc-1', 'From A');
    const refused = tabA.save(mine);
    await expect(refused).rejects.toThrow(RevisionConflict);
    await expect(refused).rejects.toThrow(/changed in another tab or window/);
    expect((await opened(library(backend), 'doc-1')).document.name).toBe('From B');

    const copy = await tabA.saveCopy(mine);
    expect(copy.summary).toMatchObject({ id: 'copy-1', name: 'From A (copy)', revision: 1 });
    expect((await opened(library(backend), 'copy-1')).document).toEqual(copy.document);
    // Reloading the newer version lets the tab save again.
    await opened(tabA, 'doc-1');
    expect(await tabA.save(mine)).toMatchObject({ revision: 3 });
  });
});

/** A library that records what it warns about. */
function watched(backend: MemoryBackend | CrashingBackend = new MemoryBackend()) {
  const warnings: string[] = [];
  let n = 0;
  const lib = new DocumentLibrary(backend, {
    now,
    newId: () => `v-${++n}`,
    locks: null,
    warn: (m) => warnings.push(m),
  });
  return { lib, warnings };
}

function value<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/**
 * Edit the demo part through a real document store and save after each step, as autosave
 * does: feature renames, suppress toggles, undo, redo, several commands per save, and saves
 * without commands. Returns each revision's canonical text.
 */
async function edit(lib: DocumentLibrary, saves: number, from = 1): Promise<Map<number, string>> {
  const store = createDocumentStore(
    from === 1 ? partDocument() : (await opened(lib, 'doc-1')).document,
  );
  const entries: LogEntry[] = [];
  store.core.subscribe((e) => {
    if (e.command && e.cause !== 'load') {
      entries.push({ cause: e.cause, label: e.label, command: e.command, at: 'x' });
    }
  });
  const texts = new Map<number, string>();
  if (from === 1) {
    await lib.save(store.getState().document);
    texts.set(1, serialize(store.getState().document));
  }
  for (let rev = from + 1; rev <= from + saves - (from === 1 ? 1 : 0); rev++) {
    const s = store.getState();
    const fillet = s.document.parts[0]!.features.find((f) => f.id === 'fillet#1')!;
    const step = rev % 6;
    if (step === 0) {
      s.execute(
        { type: 'renameFeature', partId: 'part#1', featureId: 'fillet#1', name: `Round ${rev}` },
        'Rename',
      );
    } else if (step === 1) {
      s.execute(
        {
          type: 'suppressFeature',
          partId: 'part#1',
          featureId: 'fillet#1',
          suppressed: !fillet.suppressed,
        },
        'Suppress',
      );
    } else if (step === 2) {
      s.undo();
    } else if (step === 3) {
      s.redo();
    } else if (step === 4) {
      s.execute({ type: 'renameDocument', name: `Doc ${rev}` }, 'Rename document');
      store
        .getState()
        .execute(
          { type: 'renameFeature', partId: 'part#1', featureId: 'extrude#1', name: `Pad ${rev}` },
          'Rename',
        );
    }
    // Step 5 changes nothing: a save without commands.
    await lib.save(store.getState().document, entries.splice(0));
    texts.set(rev, serialize(store.getState().document));
  }
  return texts;
}

const snapshotRevisions = (backend: MemoryBackend) =>
  files(backend)
    .map((f) => /snapshot-(\d+)\.json$/.exec(f)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(Number);

describe('named versions', () => {
  it('names the current revision, lists, renames and reads versions back', async () => {
    const backend = new MemoryBackend();
    const { lib } = watched(backend);
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Two'), [renameEntry('Two')]);
    const v = value(await lib.createVersion('doc-1', { name: '  First  ', description: 'Why' }));
    const head = JSON.parse(text(backend, 'documents/doc-1/head.json'));
    expect(v).toEqual({
      id: 'v-1',
      name: 'First',
      description: 'Why',
      revision: 2,
      snapshotSha256: head.snapshotSha256,
      createdAt: expect.any(String),
    });
    expect(head).toMatchObject({ revision: 2, versions: 1 });
    expect(JSON.parse(text(backend, 'documents/doc-1/versions-00000001.json'))).toEqual({
      format: 'manufakture-versions',
      id: 'doc-1',
      generation: 1,
      versions: [v],
    });

    await lib.save(partDocument('doc-1', 'Three'), [renameEntry('Three')]);
    const w = value(await lib.createVersion('doc-1', { name: 'Second' }));
    expect(w).toMatchObject({ id: 'v-2', revision: 3, description: '' });
    const renamed = value(await lib.renameVersion('doc-1', 'v-1', 'Renamed'));
    expect(renamed).toEqual({ ...v, name: 'Renamed' });
    expect(value(await library(backend).listVersions('doc-1'))).toEqual([renamed, w]);
    // The current list is kept, and the one before as the spare.
    expect(files(backend).filter((f) => f.includes('versions-'))).toEqual([
      'documents/doc-1/versions-00000002.json',
      'documents/doc-1/versions-00000003.json',
    ]);

    const read = value(await library(backend).readVersion('doc-1', 'v-1'));
    expect(read.document).toEqual(partDocument('doc-1', 'Two'));
    expect(await lib.readVersion('doc-1', 'nope')).toEqual({
      ok: false,
      message: 'There is no version "nope" of it.',
    });
    expect(await lib.createVersion('doc-1', { name: '  ' })).toEqual({
      ok: false,
      message: 'A version name must be 1 to 200 characters.',
    });
    expect(await lib.createVersion('doc-1', { name: 'x', description: 'd'.repeat(2001) })).toEqual({
      ok: false,
      message: 'A version description must be at most 2000 characters.',
    });
    expect(await lib.renameVersion('doc-1', 'nope', 'x')).toMatchObject({ ok: false });
    expect(await lib.createVersion('missing', { name: 'x' })).toEqual({
      ok: false,
      message: 'There is no document "missing".',
    });
    expect(await lib.listVersions('missing')).toMatchObject({ ok: false });
    // A document saved before versions existed has none.
    await lib.save(partDocument('old'));
    expect(await lib.listVersions('old')).toEqual({ ok: true, value: [] });
  });

  it('refuses to name a revision another tab saved over this one', async () => {
    const backend = new MemoryBackend();
    await library(backend).save(partDocument());
    const tabA = library(backend);
    await opened(tabA, 'doc-1');
    await library(backend).save(partDocument('doc-1', 'From B'));
    await expect(tabA.createVersion('doc-1', { name: 'Mine' })).rejects.toThrow(RevisionConflict);
    expect(value(await library(backend).listVersions('doc-1'))).toEqual([]);
  });

  it('keeps the snapshot a version names through 200 later saves', async () => {
    const backend = new MemoryBackend();
    const { lib } = watched(backend);
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Named'), [renameEntry('Named')]);
    const v = value(await lib.createVersion('doc-1', { name: 'Keep' }));
    for (let i = 0; i < 200; i++) {
      await lib.save(partDocument('doc-1', `Later ${i}`), [renameEntry(`Later ${i}`)]);
    }
    expect(snapshotRevisions(backend)).toEqual([1, 2, 65, 129, 193, 201, 202]);
    const read = value(await library(backend).readVersion('doc-1', v.id));
    expect(read.document.name).toBe('Named');
    expect(value(await library(backend).listVersions('doc-1'))).toEqual([v]);
    // Even without its snapshot, the version is rebuilt from the log and checked.
    backend.files.delete('documents/doc-1/snapshot-00000002.json');
    expect(value(await library(backend).readVersion('doc-1', v.id)).document.name).toBe('Named');
  });

  it('refuses a version whose snapshot and log no longer give its SHA-256', async () => {
    const backend = new MemoryBackend();
    const { lib } = watched(backend);
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Named'));
    const v = value(await lib.createVersion('doc-1', { name: 'Keep' }));
    const path = 'documents/doc-1/snapshot-00000002.json';
    backend.files.set(
      path,
      new TextEncoder().encode(text(backend, path).replace('Named', 'Other')),
    );
    expect(await lib.readVersion('doc-1', v.id)).toEqual({
      ok: false,
      message: 'The saved copy of the version "Keep" is damaged.',
    });
  });
});

describe('crash safety of a version', () => {
  /**
   * A document at revision 3 with one version (A, at revision 2), its list written twice (a
   * rename), so the next change deletes the list before the spare.
   */
  async function start() {
    const backend = new MemoryBackend();
    let n = 0;
    const lib = new DocumentLibrary(backend, { now, locks: null, newId: () => `a-${++n}` });
    await lib.save(partDocument());
    await lib.save(partDocument('doc-1', 'Two'), [renameEntry('Two')]);
    const created = value(await lib.createVersion('doc-1', { name: 'A (draft)' }));
    const a = value(await lib.renameVersion('doc-1', created.id, 'A'));
    await lib.save(partDocument('doc-1', 'Three'), [renameEntry('Three')]);
    return { backend, a };
  }

  it('lists the steps: the new list, the head, then the lists before the spare go', async () => {
    const { backend } = await start();
    const counting = new CrashingBackend(backend);
    await new DocumentLibrary(counting, { now, locks: null }).createVersion('doc-1', {
      name: 'B',
    });
    expect(counting.ops).toEqual([
      'write documents/doc-1/versions-00000003.json',
      'write documents/doc-1/head.json',
      'remove documents/doc-1/versions-00000001.json',
    ]);
  });

  for (const torn of [false, true]) {
    it.each([0, 1, 2])(
      `a crash at step %i (${torn ? 'torn write' : 'clean'}) leaves the old list or the new one`,
      async (at) => {
        const { backend: base, a } = await start();
        const backend = cloneBackend(base);
        const crashing = new CrashingBackend(backend, at, torn);
        const create = new DocumentLibrary(crashing, {
          now,
          locks: null,
          newId: () => 'b',
        }).createVersion('doc-1', { name: 'B' });
        // Deleting the old list after the commit is best effort.
        if (at === 2) await create;
        else await expect(create).rejects.toThrow(/Simulated crash/);
        expect(crashing.ops).toHaveLength(at + 1);

        const reloaded = library(backend);
        const listed = value(await reloaded.listVersions('doc-1'));
        // The list is new once its file is complete and the head is written or torn (a torn
        // head is recovered from the newest list that reads).
        const isNew = at === 2 || (at === 1 && torn);
        expect(listed.map((v) => v.name)).toEqual(isNew ? ['A', 'B'] : ['A']);
        expect(listed[0]).toEqual(a);
        const r = await opened(reloaded, 'doc-1');
        expect(r.document.name).toBe('Three');
        expect(r.revision).toBe(3);
        expect(value(await reloaded.listVersions('doc-1'))).toEqual(listed);

        // Then naming, saving and reading go on as normal.
        const c = value(await reloaded.createVersion('doc-1', { name: 'C' }));
        await reloaded.save(partDocument('doc-1', 'Four'), [renameEntry('Four')]);
        const after = value(await library(backend).listVersions('doc-1'));
        expect(after.map((v) => v.name)).toEqual([...listed.map((v) => v.name), 'C']);
        expect(value(await library(backend).readVersion('doc-1', a.id)).document.name).toBe('Two');
        expect(value(await library(backend).readVersion('doc-1', c.id)).document.name).toBe(
          'Three',
        );
        expect((await opened(library(backend), 'doc-1')).document.name).toBe('Four');
        expect(files(backend).filter((f) => f.includes('versions-'))).toHaveLength(2);
      },
    );
  }

  it('a save after a failed version change drops the stray list and keeps the old one', async () => {
    const { backend } = await start();
    const crashing = new CrashingBackend(backend, 1);
    await expect(
      new DocumentLibrary(crashing, { now, locks: null }).createVersion('doc-1', { name: 'B' }),
    ).rejects.toThrow();
    expect(files(backend)).toContain('documents/doc-1/versions-00000003.json');
    const lib = library(backend);
    await lib.save(partDocument('doc-1', 'Four'));
    expect(files(backend).filter((f) => f.includes('versions-'))).toEqual([
      'documents/doc-1/versions-00000001.json',
      'documents/doc-1/versions-00000002.json',
    ]);
    expect(value(await lib.listVersions('doc-1')).map((v) => v.name)).toEqual(['A']);
  });

  it('without Web Locks: a save that finds a version committed just before its own commit is refused', async () => {
    // Tab B has written its snapshot when tab A names a version; B's last look at the head
    // must see the new list, or its head would drop it (and later prunes its snapshot).
    const { backend } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => (paused = resolve));
    const gated: StorageBackend = Object.assign(Object.create(backend) as MemoryBackend, {
      async write(path: string, bytes: Uint8Array) {
        await backend.write(path, bytes);
        if (path.endsWith('/snapshot-00000004.json')) {
          paused();
          await gate;
        }
      },
    });
    // Tab A does not see B's new files yet (they are above the head, and not committed).
    const hiding: StorageBackend = Object.assign(Object.create(backend) as MemoryBackend, {
      async list(dir: string) {
        return (await backend.list(dir)).filter((n) => !n.endsWith('00000004.json'));
      },
    });
    const tabA = new DocumentLibrary(hiding, { now, locks: null, newId: () => 'b' });
    const tabB = new DocumentLibrary(gated, { now, locks: null });
    await opened(tabA, 'doc-1');
    await opened(tabB, 'doc-1');
    const b = tabB.save(partDocument('doc-1', 'From B'), [renameEntry('From B')]);
    await reached;
    const version = value(await tabA.createVersion('doc-1', { name: 'B' }));
    release();
    await expect(b).rejects.toThrow(RevisionConflict);

    const lib = library(backend);
    expect(value(await lib.listVersions('doc-1')).map((v) => v.name)).toEqual(['A', 'B']);
    // Later saves keep the snapshot it names.
    for (let i = 0; i < 3; i++) await lib.save(partDocument('doc-1', `Later ${i}`));
    expect(value(await lib.readVersion('doc-1', version.id)).document.name).toBe('Three');
  });

  it('without Web Locks: a list another tab deleted as stale before its head named it falls back to the spare', async () => {
    // Tab B has written versions-3 but not the head; tab A opens (nothing hidden), sees the
    // list above the head and deletes it; then B writes the head naming the missing list.
    const { backend, a } = await start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => (paused = resolve));
    const gated: StorageBackend = Object.assign(Object.create(backend) as MemoryBackend, {
      async write(path: string, bytes: Uint8Array) {
        await backend.write(path, bytes);
        if (path.endsWith('/versions-00000003.json')) {
          paused();
          await gate;
        }
      },
    });
    const tabB = new DocumentLibrary(gated, { now, locks: null, newId: () => 'b' });
    const creating = tabB.createVersion('doc-1', { name: 'B' });
    await reached;
    const { lib: tabA, warnings } = watched(backend);
    expect((await opened(tabA, 'doc-1')).document.name).toBe('Three');
    expect(files(backend)).not.toContain('documents/doc-1/versions-00000003.json');
    release();
    // B's head check passes (A changed no head): its version is lost, but not A's.
    expect(await creating).toMatchObject({ ok: true });
    expect(JSON.parse(text(backend, 'documents/doc-1/head.json')).versions).toBe(3);

    expect(value(await tabA.listVersions('doc-1'))).toEqual([a]);
    expect(value(await tabA.readVersion('doc-1', a.id)).document.name).toBe('Two');
    // Saves go on, deleting no snapshot while the list is the fallback.
    const before = snapshotRevisions(backend);
    await tabA.save(partDocument('doc-1', 'Four'));
    await tabA.save(partDocument('doc-1', 'Five'));
    expect(snapshotRevisions(backend)).toEqual([...before, 4, 5]);
    expect(warnings.at(-1)).toMatch(/version list of document doc-1 cannot be read/);
    // The next version change writes a whole list again, above the missing one.
    const c = value(await tabA.createVersion('doc-1', { name: 'C' }));
    expect(value(await library(backend).listVersions('doc-1'))).toEqual([a, c]);
    expect(JSON.parse(text(backend, 'documents/doc-1/head.json')).versions).toBe(4);
  });

  it('a save over a document with no readable head or snapshot keeps its version list', async () => {
    const { backend } = await start();
    for (const f of files(backend)) {
      if (/head\.json|snapshot-/.test(f)) backend.files.delete(f);
    }
    const lib = library(backend);
    await lib.save(partDocument('doc-1', 'Again'));
    expect(files(backend)).toContain('documents/doc-1/versions-00000001.json');
    expect(value(await lib.listVersions('doc-1')).map((v) => v.name)).toEqual(['A']);
  });

  it('keeps every snapshot when the version list cannot be read', async () => {
    const { backend } = await start();
    backend.files.set('documents/doc-1/versions-00000002.json', new TextEncoder().encode('{'));
    const { lib, warnings } = watched(backend);
    const before = snapshotRevisions(backend);
    await lib.save(partDocument('doc-1', 'Four'));
    await lib.save(partDocument('doc-1', 'Five'));
    expect(snapshotRevisions(backend)).toEqual([...before, 4, 5]);
    expect(warnings[0]).toMatch(/version list of document doc-1 cannot be read/);
    expect(await lib.listVersions('doc-1')).toEqual({
      ok: false,
      message: 'Its list of versions is damaged.',
    });
    expect(await lib.createVersion('doc-1', { name: 'B' })).toMatchObject({ ok: false });
  });
});

describe('replaying the log', () => {
  it(`keeps a checkpoint every ${CHECKPOINT_EVERY} revisions and rebuilds every revision exactly`, async () => {
    const backend = new MemoryBackend();
    const { lib, warnings } = watched(backend);
    const texts = await edit(lib, 140);
    const v = value(await lib.createVersion('doc-1', { name: 'At 140' }));
    expect(v.revision).toBe(140);
    const more = await edit(lib, 5, 140);
    for (const [rev, t] of more) texts.set(rev, t);
    expect(snapshotRevisions(backend)).toEqual([1, 65, 129, 140, 144, 145]);

    // Replay from a checkpoint reproduces every retained snapshot byte for byte.
    for (const rev of snapshotRevisions(backend)) {
      for (const from of [1, 65, 129].filter((c) => c <= rev)) {
        const r = value(await lib.readRevision('doc-1', rev, { from }));
        expect(r).toMatchObject({ revision: rev, from, mismatches: [] });
        const stored = text(
          backend,
          `documents/doc-1/snapshot-${String(rev).padStart(8, '0')}.json`,
        );
        expect(encodeStored(r.document).text).toBe(stored);
        expect(serialize(r.document)).toBe(texts.get(rev));
      }
    }
    // And every revision, from the nearest retained snapshot.
    for (const [rev, t] of texts) {
      const r = value(await lib.readRevision('doc-1', rev));
      expect(serialize(r.document)).toBe(t);
      expect(rev - r.from).toBeLessThan(CHECKPOINT_EVERY);
    }
    expect(warnings).toEqual([]);
    expect(await lib.readRevision('doc-1', 146)).toEqual({
      ok: false,
      message: 'There is no revision 146 of it.',
    });
    expect(await lib.readRevision('doc-1', 10, { from: 65 })).toMatchObject({ ok: false });
    expect(value(await lib.historyStart('doc-1'))).toBe(1);
  });

  it('logs a replay that does not reproduce a retained snapshot, and goes on from it', async () => {
    const backend = new MemoryBackend();
    const { lib, warnings } = watched(backend);
    const texts = await edit(lib, 70);
    // A command whose meaning changed: revision 64's rename now says something else.
    const path = 'documents/doc-1/log-00000064.json';
    backend.files.set(path, new TextEncoder().encode(text(backend, path).replace(/Doc 64/g, 'Xx')));
    const r = value(await lib.readRevision('doc-1', 69, { from: 1 }));
    expect(r.mismatches).toEqual([65]);
    expect(serialize(r.document)).toBe(texts.get(69));
    expect(warnings).toEqual([
      expect.stringMatching(/does not reproduce revision 65; the snapshot is used/),
    ]);
    // Between the checkpoints there is no snapshot to check against: the replay is what it is.
    expect(value(await lib.readRevision('doc-1', 64)).document.name).toBe('Xx');
  });

  it('goes on from a later snapshot past a command that no longer applies, or says why it cannot', async () => {
    const backend = new MemoryBackend();
    const { lib, warnings } = watched(backend);
    const texts = await edit(lib, 70);
    const path = 'documents/doc-1/log-00000006.json';
    backend.files.set(
      path,
      new TextEncoder().encode(text(backend, path).replace('"fillet#1"', '"fillet#9"')),
    );
    const r = value(await lib.readRevision('doc-1', 66, { from: 1 }));
    expect(r.mismatches).toEqual([65]);
    expect(serialize(r.document)).toBe(texts.get(66));
    expect(warnings[0]).toMatch(
      /revision 6 of document doc-1 cannot be rebuilt .*going on from revision 65/,
    );
    const failed = await lib.readRevision('doc-1', 7);
    expect(failed).toMatchObject({ ok: false });
    expect(failed.ok ? '' : failed.message).toMatch(
      /^Revision 7 cannot be rebuilt: a logged command no longer applies at revision 6/,
    );
    // A damaged segment is refused the same way.
    backend.files.set('documents/doc-1/log-00000004.json', new TextEncoder().encode('{"torn'));
    expect(await lib.readRevision('doc-1', 5)).toEqual({
      ok: false,
      message: 'Revision 5 cannot be rebuilt: the command log is damaged at revision 4.',
    });
  });

  it('a document saved before checkpoints has history from its oldest remaining snapshot', async () => {
    const backend = new MemoryBackend();
    const { lib } = watched(backend);
    const texts = await edit(lib, 10);
    // What the old pruning left: the last two snapshots only.
    for (const rev of [1]) backend.files.delete(`documents/doc-1/snapshot-0000000${rev}.json`);
    expect(value(await lib.historyStart('doc-1'))).toBe(9);
    expect(await lib.readRevision('doc-1', 5)).toEqual({
      ok: false,
      message: 'Revision 5 is older than its history, which starts at revision 9.',
    });
    expect(serialize(value(await lib.readRevision('doc-1', 10)).document)).toBe(texts.get(10));
    // Its later saves keep checkpoints from then on, and its oldest snapshot stays the root.
    await edit(lib, 60, 10);
    expect(snapshotRevisions(backend)).toEqual([9, 65, 69, 70]);
    expect(value(await lib.historyStart('doc-1'))).toBe(9);
    for (const rev of [9, 30, 64, 66]) {
      expect(serialize(value(await lib.readRevision('doc-1', rev)).document)).toBeDefined();
    }
    expect(value(await lib.readRevision('doc-1', 64, { from: 9 })).mismatches).toEqual([]);
  });
});

describe('.mfk files with versions', () => {
  it('an export with every version a document may hold fits the entry limit of an import', () => {
    // The document, the manifest, one entry per version, and room for the blobs.
    expect(2 * MAX_VERSIONS).toBeLessThanOrEqual(MFK_LIMITS.maxEntries);
  });

  async function versioned() {
    const backend = new MemoryBackend();
    const { lib } = watched(backend);
    await lib.save(partDocument());
    await lib.save(await partWithImport(), [renameEntry('Imported')]);
    const a = value(await lib.createVersion('doc-1', { name: 'With import', description: 'd' }));
    const b = value(await lib.createVersion('doc-1', { name: 'Same revision' }));
    await lib.save(partDocument('doc-1', 'Later'), [renameEntry('Later')]);
    const c = value(await lib.createVersion('doc-1', { name: 'Later' }));
    await lib.save(partDocument('doc-1', 'Current'), [renameEntry('Current')]);
    return { backend, lib, versions: [a, b, c] };
  }

  const fields = (v: Version) => ({
    id: v.id,
    name: v.name,
    description: v.description,
    createdAt: v.createdAt,
  });

  it('round trip keeps the versions, their ids and documents', async () => {
    const { lib, versions } = await versioned();
    const originals = await Promise.all(
      versions.map(async (v) => value(await lib.readVersion('doc-1', v.id)).document),
    );
    const plain = value(await lib.exportMfk('doc-1'));
    expect(unpackMfk(plain.bytes)).toMatchObject({ manifest: null, versions: new Map() });
    const exported = value(await lib.exportMfk('doc-1', { versions: true }));
    const contents = unpackMfk(exported.bytes);
    expect([...contents.versions.keys()]).toEqual(versions.map((v) => v.id));
    expect(contents.blobs.size).toBe(1);

    await lib.remove('doc-1');
    const imported = value(await lib.importMfk(exported.bytes));
    expect(imported.summary).toMatchObject({ id: 'doc-1', name: 'Current' });
    const listed = value(await lib.listVersions('doc-1'));
    expect(listed.map(fields)).toEqual(versions.map(fields));
    // Two versions of one revision share one snapshot; the document is the newest revision.
    expect(listed.map((v) => v.revision)).toEqual([1, 1, 2]);
    for (const [i, v] of listed.entries()) {
      expect(value(await lib.readVersion('doc-1', v.id)).document).toEqual(originals[i]);
    }
    expect((await opened(lib, 'doc-1')).document.name).toBe('Current');
    expect(await lib.readLog('doc-1')).toEqual({ ok: true, value: [] });

    // Its history starts over: no replay crosses from one imported revision into the next.
    await lib.save(partDocument('doc-1', 'After'), [renameEntry('After')]);
    for (let i = 0; i < 3; i++) await lib.save(partDocument('doc-1', `After ${i}`));
    expect(value(await lib.readRevision('doc-1', 3)).document.name).toBe('Current');
    expect(value(await lib.readRevision('doc-1', 4)).document.name).toBe('After');
    for (const v of listed) expect((await lib.readVersion('doc-1', v.id)).ok).toBe(true);

    // Imported again under a new id (this one is taken), the version ids stay.
    const again = value(await lib.importMfk(exported.bytes));
    expect(again.summary.id).toBe('v-4');
    const copies = value(await lib.listVersions('v-4'));
    expect(copies.map(fields)).toEqual(versions.map(fields));
    const first = value(await lib.readVersion('v-4', copies[0]!.id)).document;
    expect(first).toEqual({ ...originals[0], id: 'v-4' });
  });

  it('refuses to export a file with more entries than an import reads', async () => {
    const { lib } = await versioned();
    const max = MFK_LIMITS.maxEntries;
    try {
      // The document, the manifest, three versions and one blob.
      MFK_LIMITS.maxEntries = 5;
      expect(await lib.exportMfk('doc-1', { versions: true })).toEqual({
        ok: false,
        message:
          'It holds too many versions and imported files for one .mfk file (6 entries; at most 5).',
      });
      MFK_LIMITS.maxEntries = 6;
      expect((await lib.exportMfk('doc-1', { versions: true })).ok).toBe(true);
    } finally {
      MFK_LIMITS.maxEntries = max;
    }
  });

  it('refuses a file whose versions do not check out, storing nothing', async () => {
    const { lib } = await versioned();
    const exported = unpackMfk(value(await lib.exportMfk('doc-1', { versions: true })).bytes);
    await lib.remove('doc-1');
    const manifest = JSON.parse(exported.manifest!);
    const [first] = manifest.versions;
    const repack = (m: unknown, versions = exported.versions) =>
      packMfk(exported.document, exported.blobs, {
        manifest: typeof m === 'string' ? m : JSON.stringify(m),
        versions,
      });
    const cases: [Uint8Array, string | RegExp][] = [
      [repack('{'), 'The file is damaged: its manifest is not valid JSON.'],
      [repack({ ...manifest, format: 'x' }), /not one this app reads/],
      [repack({ ...manifest, versions: 'x' }), /its list of versions is invalid/],
      [
        repack({ ...manifest, versions: [first, first] }),
        'The file is damaged: its list of versions is invalid.',
      ],
      [
        repack({ ...manifest, versions: [{ ...first, id: '../x' }] }),
        /list of versions is invalid/,
      ],
      [repack({ ...manifest, versions: [{ ...first, revision: 0 }] }), /invalid/],
      [repack({ ...manifest, versions: [{ ...first, createdAt: 'soon' }] }), /invalid/],
      [repack({ ...manifest, versions: [{ ...first, name: ' padded ' }] }), /invalid/],
      [repack({ ...manifest, versions: [{ ...first, snapshotSha256: 'ab' }] }), /invalid/],
      [
        repack(manifest, new Map([...exported.versions].slice(1))),
        'The file lists the version "With import" but does not hold it.',
      ],
      [
        repack(
          manifest,
          new Map(
            [...exported.versions].map(([id, t]) => [id, t.replace('"Bracket"', '"Brackex"')]),
          ),
        ),
        'The version "With import" in the file is damaged: its SHA-256 does not match.',
      ],
    ];
    // A version of another document, with a matching SHA-256.
    const foreign = new Map(exported.versions);
    const other = exported.versions.get(first.id)!.replace('"id": "doc-1"', '"id": "doc-2"');
    foreign.set(first.id, other);
    const { sha256Hex } = await import('@manufakture/io');
    const sha = await sha256Hex(new TextEncoder().encode(other));
    cases.push([
      repack({ ...manifest, versions: [{ ...first, snapshotSha256: sha }] }, foreign),
      'The version "With import" in the file belongs to another document.',
    ]);
    for (const [bytes, message] of cases) {
      const r = await lib.importMfk(bytes);
      expect(r.ok ? 'ok' : r.message).toMatch(message);
      expect(await lib.has('doc-1')).toBe(false);
    }
  });
});
