import type { Command } from '@manufakture/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { startAutosave } from './autosave';
import { MemoryBackend, DocumentLibrary, type DocumentSummary } from '@manufakture/library';
import { emptyDocument, partDocument } from '@manufakture/library/test-fixtures';

const rename = (name: string): Command => ({ type: 'renameDocument', name });

function setup(
  options: { delayMs?: number; maxDelayMs?: number; retryMs?: number; maxRetryMs?: number } = {},
  backend = new MemoryBackend(),
) {
  const library = new DocumentLibrary(backend, { locks: null });
  const save = vi.spyOn(library, 'save');
  const documents = createDocumentStore(emptyDocument('doc-1', 'One'));
  const onSaved = vi.fn();
  const autosave = startAutosave(documents, library, {
    delayMs: 500,
    maxDelayMs: 2000,
    onSaved,
    ...options,
  });
  return { backend, library, save, documents, autosave, onSaved };
}

/** Let the save's promise chain run (timers are fake, promises are not). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.waitFor(() => undefined);
};

/** Only the promise chain, without moving the fake clock (vi.waitFor moves it). */
const microtasks = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves once edits pause, with every command since the last save in the log', async () => {
    const { save, documents, autosave, library, onSaved } = setup();
    documents.getState().execute(rename('Two'), 'Rename');
    vi.advanceTimersByTime(300);
    documents.getState().execute(rename('Three'), 'Rename');
    documents.getState().undo();
    expect(autosave.status.getState().state).toBe('pending');
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(autosave.status.getState().state).toBe('saved'));
    expect(save).toHaveBeenCalledTimes(1);
    const [doc, entries] = save.mock.calls[0]!;
    expect(doc.name).toBe('Two');
    expect(entries!.map((e) => [e.cause, e.command])).toEqual([
      ['execute', rename('Two')],
      ['execute', rename('Three')],
      ['undo', rename('Two')],
    ]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1', name: 'Two' }));
    const opened = await library.open('doc-1');
    expect(opened.ok && opened.value.document.name).toBe('Two');
  });

  it('saves at least every maxDelayMs while edits keep coming', async () => {
    const { save, documents } = setup();
    for (let i = 0; i < 10; i++) {
      documents.getState().execute(rename(`Name ${i}`), 'Rename');
      vi.advanceTimersByTime(300);
    }
    await settle();
    // 3 s of edits 300 ms apart: the quiet timer never fires, the deadline does (at 2 s).
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toHaveLength(7);
  });

  it('does nothing for a load, or a command that changed nothing', async () => {
    const { save, documents } = setup();
    documents.getState().load(partDocument('doc-2'));
    documents.getState().execute(rename('Bracket'), 'Rename');
    vi.advanceTimersByTime(5000);
    await settle();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the pending changes of a document before another one is opened', async () => {
    const { save, documents, autosave } = setup();
    documents.getState().execute(rename('Changed'), 'Rename');
    documents.getState().load(partDocument('doc-2'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ id: 'doc-1', name: 'Changed' });
    expect(autosave.status.getState().documentId).toBe('doc-2');
  });

  it('keeps the changes when a save fails, and saves them all on the next attempt', async () => {
    const { save, documents, autosave, library } = setup();
    save.mockRejectedValueOnce(new Error('The quota is exceeded'));
    documents.getState().execute(rename('A'), 'Rename');
    await autosave.flush();
    expect(autosave.status.getState()).toMatchObject({
      state: 'error',
      message: 'The quota is exceeded',
    });
    documents.getState().execute(rename('B'), 'Rename');
    await autosave.flush();
    expect(autosave.status.getState().state).toBe('saved');
    expect(save.mock.calls[1]![1]!.map((e) => e.command)).toEqual([rename('A'), rename('B')]);
    const log = await library.readLog('doc-1');
    expect(log.ok && log.value).toHaveLength(2);
  });

  it('flush saves now, discard drops a deleted document, stop saves and stops listening', async () => {
    const { save, documents, autosave } = setup();
    documents.getState().execute(rename('Now'), 'Rename');
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    documents.getState().execute(rename('Dropped'), 'Rename');
    autosave.discard('doc-1');
    vi.advanceTimersByTime(5000);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);

    documents.getState().execute(rename('Last'), 'Rename');
    await autosave.stop();
    expect(save).toHaveBeenCalledTimes(2);
    documents.getState().execute(rename('Ignored'), 'Rename');
    vi.advanceTimersByTime(5000);
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('keeps the changes of each document apart: a failed save never moves them into another log', async () => {
    const { save, documents, autosave, library } = setup();
    save.mockRejectedValue(new Error('The quota is exceeded'));
    documents.getState().execute(rename('A1'), 'Rename');
    expect(await autosave.flush()).toBe(false);
    // Another document opens while doc-1's changes are still unsaved, and is edited.
    documents.getState().load(emptyDocument('doc-2', 'Two'));
    documents.getState().execute(rename('B1'), 'Rename');
    save.mockRestore();
    expect(await autosave.flush()).toBe(true);
    const one = await library.readLog('doc-1');
    const two = await library.readLog('doc-2');
    expect(one.ok && one.value.map((e) => e.command)).toEqual([rename('A1')]);
    expect(two.ok && two.value.map((e) => e.command)).toEqual([rename('B1')]);
    const opened = await library.open('doc-1');
    expect(opened.ok && opened.value.document.name).toBe('A1');
    expect(autosave.unsaved()).toBe(false);
  });

  it('says which document a failure is about', async () => {
    const { save, documents, autosave } = setup();
    save.mockRejectedValue(new Error('The quota is exceeded'));
    documents.getState().execute(rename('A1'), 'Rename');
    documents.getState().load(emptyDocument('doc-2', 'Two'));
    await autosave.flush();
    expect(autosave.status.getState()).toMatchObject({
      state: 'error',
      documentId: 'doc-1',
      documentName: 'A1',
    });
  });

  it('never saves a document deleted while its failing save was in flight', async () => {
    const { save, documents, autosave, library } = setup();
    let fail!: (e: Error) => void;
    save.mockImplementationOnce(
      () => new Promise<DocumentSummary>((_resolve, reject) => (fail = reject)),
    );
    documents.getState().execute(rename('Doomed'), 'Rename');
    const first = autosave.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    autosave.discard('doc-1');
    fail(new Error('The quota is exceeded'));
    await first;
    await autosave.flush();
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await library.has('doc-1')).toBe(false);
    expect(autosave.unsaved()).toBe(false);
  });

  it('tries a failed save again by itself, waiting longer after each failure', async () => {
    const { save, documents, autosave } = setup({ retryMs: 1000, maxRetryMs: 3000 });
    save
      .mockRejectedValueOnce(new Error('full'))
      .mockRejectedValueOnce(new Error('full'))
      .mockRejectedValueOnce(new Error('full'));
    documents.getState().execute(rename('A'), 'Rename');
    await autosave.flush();
    // Waits of 1 s, 2 s, then the 3 s cap; time moves only here (microtasks run in between).
    const calls: number[] = [];
    for (const wait of [999, 1, 1999, 1, 2999, 1]) {
      vi.advanceTimersByTime(wait);
      await microtasks();
      calls.push(save.mock.calls.length);
    }
    expect(calls).toEqual([1, 2, 2, 3, 3, 4]);
    await vi.waitFor(() => expect(autosave.status.getState().state).toBe('saved'));
    expect(save.mock.calls[3]![1]!.map((e) => e.command)).toEqual([rename('A')]);
  });

  it('stops on a conflict with another tab, without retrying, until the change is forgotten', async () => {
    const backend = new MemoryBackend();
    const seed = new DocumentLibrary(backend, { locks: null });
    await seed.save(emptyDocument('doc-1', 'One'));
    const { save, documents, autosave, library } = setup({}, backend);
    await library.open('doc-1');
    // Another tab saves the document.
    const other = new DocumentLibrary(backend, { locks: null });
    await other.open('doc-1');
    await other.save(emptyDocument('doc-1', 'Theirs'));

    documents.getState().execute(rename('Mine'), 'Rename');
    expect(await autosave.flush()).toBe(false);
    expect(autosave.status.getState()).toMatchObject({
      state: 'conflict',
      documentId: 'doc-1',
      message: expect.stringMatching(/changed in another tab or window/),
    });
    documents.getState().execute(rename('Mine again'), 'Rename');
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave.status.getState().state).toBe('conflict');
    expect(autosave.unsaved()).toBe(true);
    const stored = await other.open('doc-1');
    expect(stored.ok && stored.value.document.name).toBe('Theirs');

    autosave.forget('doc-1');
    expect(autosave.unsaved()).toBe(false);
    expect(autosave.status.getState().state).toBe('idle');
  });

  it('reports unsaved changes until they are saved', async () => {
    const { documents, autosave } = setup();
    expect(autosave.unsaved()).toBe(false);
    documents.getState().execute(rename('A'), 'Rename');
    expect(autosave.unsaved()).toBe(true);
    const flushing = autosave.flush();
    // Taken for saving, not saved yet.
    expect(autosave.unsaved()).toBe(true);
    await flushing;
    expect(autosave.unsaved()).toBe(false);
  });

  it('names a version of what the user sees: pending changes are saved first', async () => {
    const { documents, autosave, library, onSaved } = setup();
    // Never stored yet: the version stores it first.
    const first = await autosave.createVersion({ name: 'Blank' });
    expect(first).toMatchObject({ ok: true, value: { name: 'Blank', revision: 1 } });
    expect(onSaved).toHaveBeenCalledTimes(1);
    documents.getState().execute(rename('Two'), 'Rename');
    expect(autosave.status.getState().state).toBe('pending');
    const second = await autosave.createVersion({ name: 'Named', description: 'After a rename' });
    expect(second).toMatchObject({ ok: true, value: { name: 'Named', revision: 2 } });
    expect(autosave.status.getState().state).toBe('saved');
    const versions = await library.listVersions('doc-1');
    expect(versions.ok && versions.value.map((v) => v.name)).toEqual(['Blank', 'Named']);
    const read = await library.readVersion('doc-1', second.ok ? second.value.id : '');
    expect(read.ok && read.value.document.name).toBe('Two');
  });

  it('records no version when the save before it fails', async () => {
    const { documents, autosave, library, save } = setup();
    save.mockRejectedValueOnce(new Error('The disk is full'));
    documents.getState().execute(rename('Two'), 'Rename');
    const r = await autosave.createVersion({ name: 'Named' });
    expect(r).toEqual({ ok: false, message: 'The document could not be saved: The disk is full' });
    expect(await library.has('doc-1')).toBe(false);
  });

  describe('on branches', () => {
    /** doc-1 stored as "One" with version A, and the branch b-1 from it. */
    async function branched() {
      const backend = new MemoryBackend();
      const ids = ['v-1', 'b-1', 'v-2'];
      const library = new DocumentLibrary(backend, { locks: null, newId: () => ids.shift()! });
      await library.save(emptyDocument('doc-1', 'One'));
      const version = await library.createVersion('doc-1', { name: 'A' });
      if (!version.ok) throw new Error(version.message);
      const created = await library.createBranch('doc-1', version.value.id, 'Try');
      if (!created.ok) throw new Error(created.message);
      let current = 'main';
      const documents = createDocumentStore(emptyDocument('doc-1', 'One'));
      const autosave = startAutosave(documents, library, {
        delayMs: 500,
        maxDelayMs: 2000,
        branch: () => current,
      });
      const reader = () => new DocumentLibrary(backend, { locks: null });
      const nameOn = async (branch: string) => {
        const r = await reader().open('doc-1', branch);
        return r.ok ? r.value.document.name : r.message;
      };
      return {
        backend,
        library,
        documents,
        autosave,
        nameOn,
        setBranch: (b: string) => (current = b),
      };
    }

    it('saves an edit made during a branch switch to the branch it was made on', async () => {
      const { library, documents, autosave, nameOn, setBranch } = await branched();
      documents.getState().execute(rename('Main edit'), 'Rename');
      // The switch has opened the branch in the library, but not shown it yet.
      const opened = await library.open('doc-1', 'b-1');
      if (!opened.ok) throw new Error(opened.message);
      documents.getState().execute(rename('During the switch'), 'Rename');
      // Shown: from now on, edits are the branch's.
      setBranch('b-1');
      documents.getState().load(opened.value.document);
      documents.getState().execute(rename('On the branch'), 'Rename');
      expect(await autosave.flush()).toBe(true);
      expect(await nameOn('main')).toBe('During the switch');
      expect(await nameOn('b-1')).toBe('On the branch');
      const mainLog = await library.readLog('doc-1');
      expect(mainLog.ok && mainLog.value.map((e) => e.command)).toEqual([
        rename('Main edit'),
        rename('During the switch'),
      ]);
      const branchLog = await library.readLog('doc-1', 'b-1');
      expect(branchLog.ok && branchLog.value.map((e) => e.command)).toEqual([
        rename('On the branch'),
      ]);
      // A version is of the branch the document is on.
      const version = await autosave.createVersion({ name: 'B' });
      expect(version).toMatchObject({ ok: true, value: { branch: 'b-1', revision: 2 } });
    });

    it('refuses an edit made on a branch deleted meanwhile, without saving it onto main', async () => {
      const { library, documents, autosave, nameOn, setBranch } = await branched();
      const opened = await library.open('doc-1', 'b-1');
      if (!opened.ok) throw new Error(opened.message);
      setBranch('b-1');
      documents.getState().load(opened.value.document);
      documents.getState().execute(rename('Lost'), 'Rename');
      const deleted = await library.deleteBranch('doc-1', 'b-1');
      expect(deleted.ok).toBe(true);
      setBranch('main');
      expect(await autosave.flush()).toBe(false);
      expect(autosave.status.getState()).toMatchObject({
        state: 'conflict',
        message: expect.stringMatching(/^Its branch was deleted/) as string,
      });
      expect(await nameOn('main')).toBe('One');
      // Dropping it (the user reloads the stored version) clears the conflict.
      autosave.forget('doc-1');
      expect(autosave.unsaved()).toBe(false);
    });
  });
});
