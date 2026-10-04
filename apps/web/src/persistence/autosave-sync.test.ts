import type { Command } from '@manufakture/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { flushForSync, registerSyncSource, startAutosave } from './autosave';
import { MemoryBackend } from './backend';
import { DocumentLibrary, type SyncRecord } from './library';
import { emptyDocument } from './test-fixtures';

// Autosave and sync (T7.1d): a syncing document is saved with its sync state as it is at the
// moment of the save, and with every change made up to then, so the snapshot and the queue state
// are one commit; a remote change is logged as a whole-document replace.

const rename = (name: string): Command => ({ type: 'renameDocument', name });

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup() {
  const library = new DocumentLibrary(new MemoryBackend(), { locks: null });
  const documents = createDocumentStore(emptyDocument('doc-1', 'One'));
  const autosave = startAutosave(documents, library, { delayMs: 60_000, maxDelayMs: 60_000 });
  cleanups.push(() => autosave.stop());
  let marker = 0;
  const unregister = registerSyncSource((id, branch): SyncRecord | null =>
    id === 'doc-1' && branch === 'main'
      ? {
          server: 'https://sync.example',
          clientKey: 'k'.repeat(43),
          confirmed: documents.core.document,
          state: { marker: ++marker, name: documents.core.document.name },
        }
      : null,
  );
  cleanups.push(unregister);
  return { library, documents, autosave };
}

describe('autosave with sync', () => {
  it('saves the sync state with the document, taken at the moment of the save', async () => {
    const { library, documents } = setup();
    documents.getState().execute(rename('Two'), 'Rename');
    expect(await flushForSync('doc-1')).toBe(true);
    const stored = await library.readSync('doc-1');
    expect(stored.ok && stored.value).toMatchObject({
      paired: true,
      record: { state: { name: 'Two' } },
    });
    const opened = await library.open('doc-1');
    expect(opened.ok && opened.value.document.name).toBe('Two');
  });

  it('takes changes made after the flush began into the same save', async () => {
    const { library, documents } = setup();
    documents.getState().execute(rename('Two'), 'Rename');
    const flushed = flushForSync('doc-1');
    // Before the save runs (it waits for the library), another change.
    documents.getState().execute(rename('Three'), 'Rename');
    expect(await flushed).toBe(true);
    const opened = await library.open('doc-1');
    expect(opened.ok && opened.value.document.name).toBe('Three');
    const stored = await library.readSync('doc-1');
    expect(stored.ok && stored.value).toMatchObject({
      paired: true,
      record: { state: { name: 'Three' } },
    });
    const log = await library.readLog('doc-1');
    expect(log.ok && log.value.map((e) => (e.command as { name?: string }).name)).toEqual([
      'Two',
      'Three',
    ]);
  });

  it('logs a remote change as a whole-document replace, which replays', async () => {
    const { library, documents } = setup();
    documents.getState().execute(rename('Two'), 'Rename');
    expect(await flushForSync('doc-1')).toBe(true);
    documents.core.applyRemote({ ...documents.core.document, name: 'From elsewhere' }, 'Synced');
    expect(await flushForSync('doc-1')).toBe(true);
    const log = await library.readLog('doc-1');
    expect(log.ok && log.value.at(-1)).toMatchObject({
      cause: 'execute',
      label: 'Synced',
      command: { type: 'replaceDocument' },
    });
    const head = await library.readRevision('doc-1', 2);
    expect(head.ok && head.value.document.name).toBe('From elsewhere');
    expect(head.ok && head.value.mismatches).toEqual([]);
  });

  it('a failed save means the document is not flushed for sync', async () => {
    const { library, documents } = setup();
    library.save = () => Promise.reject(new Error('disk full'));
    documents.getState().execute(rename('Two'), 'Rename');
    expect(await flushForSync('doc-1')).toBe(false);
  });
});
