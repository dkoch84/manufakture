import { applyCommand, FORMAT_VERSION, type Command } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { MemoryBackend, type StorageBackend } from './backend';
import { DocumentLibrary, RevisionConflict, type DocumentLocks, type LogEntry } from './library';
import {
  CrashingBackend,
  cloneBackend,
  emptyDocument,
  partDocument,
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
    // A third save drops the oldest snapshot and keeps the previous one as a spare.
    await lib.save(doc);
    expect(files(backend).filter((f) => f.includes('snapshot'))).toEqual([
      'documents/doc-1/snapshot-00000002.json',
      'documents/doc-1/snapshot-00000003.json',
    ]);
    const head = JSON.parse(text(backend, 'documents/doc-1/head.json'));
    expect(head).toMatchObject({ format: 'manufakture-head', revision: 3, name: 'Bracket' });
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
        // Step 4 is the cleanup after the head (a third save removes the oldest snapshot).
        if (at === 4) await library(base).save(before);
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
        const saved = at === 4 ? 2 : 1;
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
