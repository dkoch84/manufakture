import type { ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { startAutosave } from '../persistence/autosave';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary } from '../persistence/library';
import { MAX_MFK_FILE_BYTES } from '../persistence/limits';
import { unpackMfk } from '../persistence/mfk';
import { emptyDocument, partDocument, partWithImport } from '../persistence/test-fixtures';
import { createDocumentStore } from '../state/document';
import { MFK_MIME, homeActions } from './actions';

async function setup(backend = new MemoryBackend()) {
  let n = 0;
  const library = new DocumentLibrary(backend, { newId: () => `new-${++n}`, locks: null });
  await library.save(partDocument('a', 'Alpha'));
  await library.save(await partWithImport('b'));
  const documents = createDocumentStore(emptyDocument('scratch'));
  const autosave = startAutosave(documents, library, { delayMs: 10_000, maxDelayMs: 10_000 });
  const shown: { doc: ManufaktureDocument; stored: boolean; stayHome?: boolean }[] = [];
  const download = vi.fn();
  const actions = homeActions({
    library,
    documents,
    autosave,
    show: (doc, { stored, stayHome }) => {
      shown.push({ doc, stored, ...(stayHome ? { stayHome } : {}) });
      documents.getState().load(doc);
    },
    download,
  });
  return { library, documents, autosave, actions, shown, download, backend };
}

describe('home actions', () => {
  it('opens a stored document in the editor', async () => {
    const { actions, shown, documents } = await setup();
    expect(await actions.open('a')).toEqual({ ok: true, message: 'Opened Alpha.' });
    expect(shown.map((s) => [s.doc.id, s.stored])).toEqual([['a', true]]);
    expect(documents.getState().document.name).toBe('Alpha');
    expect(await actions.open('zzz')).toEqual({
      ok: false,
      message: 'There is no document "zzz".',
    });
  });

  it('creates a new document, saved at once so the list shows it', async () => {
    const { actions, library, shown } = await setup();
    expect(await actions.create()).toEqual({ ok: true, message: 'Created Untitled.' });
    const id = shown[0]!.doc.id;
    expect(shown[0]!.stored).toBe(true);
    expect((await library.list()).map((d) => d.id)).toContain(id);
  });

  it('creates a fit-test coupon from the template, saved and opened', async () => {
    const { actions, library, shown, documents } = await setup();
    const r = await actions.createCoupon();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Created Fit-test coupon: print it/);
    const doc = shown[0]!.doc;
    expect(shown[0]!.stored).toBe(true);
    expect(doc.name).toBe('Fit-test coupon');
    expect(documents.getState().document.variables.map((v) => v.name)).toEqual(['peg_d']);
    expect(doc.print.setups[0]?.printer).toBe('bambu-x1c');
    expect((await library.list()).map((d) => d.id)).toContain(doc.id);
  });

  it('renames a closed document in the library, and the open one through an undoable command', async () => {
    const { actions, library, documents } = await setup();
    expect(await actions.rename('b', 'Bravo')).toEqual({ ok: true, message: 'Renamed to Bravo.' });
    const b = await library.open('b');
    expect(b.ok && b.value.document.name).toBe('Bravo');

    await actions.open('a');
    expect(await actions.rename('a', 'Shelf')).toEqual({ ok: true, message: 'Renamed to Shelf.' });
    expect(documents.getState().document.name).toBe('Shelf');
    expect(documents.getState().undoLabel).toBe('Rename document');
    // Saved straight away (flushed), with the command in the log.
    const a = await library.open('a');
    expect(a.ok && a.value.document.name).toBe('Shelf');
    const log = await library.readLog('a');
    expect(log.ok && log.value.map((e) => e.command)).toEqual([
      { type: 'renameDocument', name: 'Shelf' },
    ]);
    expect(await actions.rename('a', '')).toEqual({
      ok: false,
      message: 'A document name must be 1 to 200 characters',
    });
  });

  it('duplicates a document, saving the open one first', async () => {
    const { actions, library, documents } = await setup();
    await actions.open('a');
    documents.getState().execute({ type: 'renameDocument', name: 'Edited' }, 'Rename document');
    expect(await actions.duplicate('a')).toEqual({ ok: true, message: 'Made Edited (copy).' });
    const copy = await library.open('new-1');
    expect(copy.ok && copy.value.document.name).toBe('Edited (copy)');
  });

  it('deletes a document; deleting the open one opens a new, unsaved one in its place', async () => {
    const { actions, library, shown, documents, autosave } = await setup();
    expect(await actions.remove('b')).toEqual({ ok: true, message: 'Deleted.' });
    expect((await library.list()).map((d) => d.id)).toEqual(['a']);

    await actions.open('a');
    documents.getState().execute({ type: 'renameDocument', name: 'Pending' }, 'Rename document');
    await actions.remove('a');
    expect(shown.at(-1)).toMatchObject({ stored: false, stayHome: true });
    expect(documents.getState().document.id).not.toBe('a');
    // The pending change of the deleted document is dropped, not saved back.
    await autosave.flush();
    expect(await library.list()).toEqual([]);
  });

  it('exports a .mfk download and imports it back as a document it then opens', async () => {
    const { actions, library, download, documents } = await setup();
    expect(await actions.exportFile('b')).toEqual({ ok: true, message: 'Exported Bracket.mfk.' });
    const [bytes, name, type] = download.mock.calls[0]!;
    expect([name, type]).toEqual(['Bracket.mfk', MFK_MIME]);
    const original = await library.open('b');

    await actions.remove('b');
    expect(await actions.importFile({ name: 'Bracket.mfk', bytes })).toEqual({
      ok: true,
      message: 'Imported Bracket.mfk as Bracket.',
    });
    if (!original.ok) throw new Error(original.message);
    expect(documents.getState().document).toEqual(original.value.document);
    expect(await actions.importFile({ name: 'x.mfk', bytes: new Uint8Array(4) })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^x\.mfk: This is not a manufakture file/),
    });
  });

  it('stops instead of replacing the open document when its changes cannot be saved', async () => {
    const { actions, library, documents, download } = await setup();
    await actions.open('a');
    documents.getState().execute({ type: 'renameDocument', name: 'Edited' }, 'Rename document');
    const save = vi.spyOn(library, 'save').mockRejectedValue(new Error('The disk is full'));
    const stopped = {
      ok: false,
      unsaved: true,
      message:
        'The changes to Edited are not saved (The disk is full), so nothing else was opened. ' +
        'Save again, or export it as a .mfk file to keep them.',
    };
    const exported = await actions.exportFile('b');
    expect(exported.ok).toBe(true);
    expect(await actions.open('b')).toEqual(stopped);
    expect(await actions.create()).toEqual(stopped);
    expect(await actions.createCoupon()).toEqual(stopped);
    expect(await actions.duplicate('a')).toEqual(stopped);
    expect(await actions.exportFile('a')).toEqual(stopped);
    const bytes = download.mock.calls[0]![0] as Uint8Array;
    expect(await actions.importFile({ name: 'b.mfk', bytes })).toEqual(stopped);
    expect(documents.getState().document).toMatchObject({ id: 'a', name: 'Edited' });

    // The open document as it is, unsaved change included, can be exported.
    expect(await actions.exportCurrent()).toEqual({
      ok: true,
      message: 'Exported Edited.mfk as it is open, unsaved changes included.',
    });
    const [current, name] = download.mock.calls.at(-1)!;
    expect(name).toBe('Edited.mfk');
    expect(JSON.parse(unpackMfk(current as Uint8Array).document)).toMatchObject({
      id: 'a',
      name: 'Edited',
    });

    save.mockRestore();
    expect(await actions.retrySave()).toEqual({ ok: true, message: 'Saved.' });
    expect(await actions.open('b')).toEqual({ ok: true, message: 'Opened Bracket.' });
    const a = await library.open('a');
    expect(a.ok && a.value.document.name).toBe('Edited');
  });

  it('keeps the changes of a document whose save fails in the switch away from it, and saves them to it later', async () => {
    const t = await setup();
    await t.actions.open('a');
    // Its first flush has nothing to save; a change arrives while B is being read, and the
    // flush that loading B starts then fails.
    const realOpen = t.library.open.bind(t.library);
    const save = vi.spyOn(t.library, 'save');
    vi.spyOn(t.library, 'open').mockImplementationOnce(async (id) => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Late' }, 'Rename document');
      save.mockRejectedValueOnce(new Error('The disk is full'));
      return realOpen(id);
    });
    expect(await t.actions.open('b')).toEqual({ ok: true, message: 'Opened Bracket.' });
    await vi.waitFor(() => expect(t.autosave.status.getState().state).toBe('error'));
    expect(t.autosave.status.getState()).toMatchObject({
      documentId: 'a',
      documentName: 'Late',
      message: 'The disk is full',
    });
    expect(t.autosave.unsaved()).toBe(true);
    const a = await t.library.open('a');
    expect(a.ok && a.value.document.name).toBe('Alpha');

    // The next switch saves them first, to A, and A's log alone has the command.
    expect(await t.actions.open('a')).toEqual({ ok: true, message: 'Opened Late.' });
    const logA = await t.library.readLog('a');
    expect(logA.ok && logA.value.map((e) => e.command)).toEqual([
      { type: 'renameDocument', name: 'Late' },
    ]);
    expect(await t.library.readLog('b')).toEqual({ ok: true, value: [] });
  });

  it('deleting a document drops its waiting changes, even when it is not the open one', async () => {
    const t = await setup();
    await t.actions.open('a');
    const realOpen = t.library.open.bind(t.library);
    const save = vi.spyOn(t.library, 'save');
    vi.spyOn(t.library, 'open').mockImplementationOnce(async (id) => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Late' }, 'Rename document');
      save.mockRejectedValueOnce(new Error('The disk is full'));
      return realOpen(id);
    });
    await t.actions.open('b');
    await vi.waitFor(() => expect(t.autosave.status.getState().state).toBe('error'));
    expect(await t.actions.remove('a')).toEqual({ ok: true, message: 'Deleted.' });
    // The retry does not bring it back.
    expect(await t.autosave.flush()).toBe(true);
    expect(await t.library.has('a')).toBe(false);
    expect(t.autosave.unsaved()).toBe(false);
  });

  it('refuses a picked file over the .mfk size limit without reading it', async () => {
    const { actions } = await setup();
    const arrayBuffer = vi.fn();
    const file = {
      name: 'huge.mfk',
      size: MAX_MFK_FILE_BYTES + 1,
      arrayBuffer,
    } as unknown as Blob & {
      name: string;
    };
    expect(await actions.importPicked(file)).toEqual({
      ok: false,
      message: 'huge.mfk is 256.0 MB; a .mfk file can be at most 256.0 MB.',
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('after another tab saved the open document: reload the newer version, or keep this one as a copy', async () => {
    const t = await setup();
    const other = new DocumentLibrary(t.backend, { locks: null });
    await t.actions.open('a');
    await other.open('a');
    await other.save(partDocument('a', 'Theirs'));
    t.documents.getState().execute({ type: 'renameDocument', name: 'Mine' }, 'Rename document');
    expect(await t.autosave.flush()).toBe(false);
    expect(await t.actions.open('b')).toMatchObject({
      ok: false,
      unsaved: true,
      message: expect.stringMatching(/^Mine was changed in another tab or window/),
    });

    expect(await t.actions.keepAsCopy()).toEqual({
      ok: true,
      message: 'Saved this version as Mine (copy); the other version stays as it was.',
    });
    expect(t.documents.getState().document).toMatchObject({ id: 'new-1', name: 'Mine (copy)' });
    expect(t.autosave.unsaved()).toBe(false);
    const a = await t.library.open('a');
    expect(a.ok && a.value.document.name).toBe('Theirs');

    // Again, choosing the newer version this time.
    await t.actions.open('a');
    await other.open('a');
    await other.save(partDocument('a', 'Theirs 2'));
    t.documents.getState().execute({ type: 'renameDocument', name: 'Mine 2' }, 'Rename document');
    await t.autosave.flush();
    expect(t.autosave.status.getState().state).toBe('conflict');
    expect(await t.actions.reloadNewer()).toEqual({
      ok: true,
      message: 'Opened the newer version of Theirs 2.',
    });
    expect(t.documents.getState().document.name).toBe('Theirs 2');
    expect(t.autosave.unsaved()).toBe(false);
    // And this tab saves again from there.
    t.documents.getState().execute({ type: 'renameDocument', name: 'Agreed' }, 'Rename document');
    expect(await t.autosave.flush()).toBe(true);
  });

  describe('on a branch of the open document', () => {
    async function onBranch() {
      const backend = new MemoryBackend();
      const ids = ['v-1', 'b-1', 'copy-1'];
      const library = new DocumentLibrary(backend, { newId: () => ids.shift()!, locks: null });
      await library.save(partDocument('a', 'Alpha'));
      const version = await library.createVersion('a', { name: 'Base' });
      if (!version.ok) throw new Error(version.message);
      const branch = await library.createBranch('a', version.value.id, 'Wide');
      if (!branch.ok) throw new Error(branch.message);
      await library.save(partDocument('a', 'Alpha on main'), []);
      let current = 'main';
      const documents = createDocumentStore(emptyDocument('scratch'));
      const autosave = startAutosave(documents, library, {
        delayMs: 10_000,
        maxDelayMs: 10_000,
        branch: () => current,
      });
      const actions = homeActions({
        library,
        documents,
        autosave,
        show: (doc, options) => {
          current = options.branch ?? 'main';
          documents.getState().load(doc);
        },
        download: vi.fn(),
        branch: () => current,
      });
      const opened = await library.open('a', 'b-1');
      if (!opened.ok) throw new Error(opened.message);
      current = 'b-1';
      documents.getState().load(opened.value.document);
      return { backend, library, documents, autosave, actions, branch: () => current };
    }

    it('renames Main, not the branch it is open on', async () => {
      const t = await onBranch();
      expect(await t.actions.rename('a', 'Renamed main')).toEqual({
        ok: true,
        message: 'Renamed to Renamed main.',
      });
      // The open branch is untouched, in the editor and in storage; nothing waits to be saved.
      expect(t.documents.getState().document.name).toBe('Alpha');
      expect(t.documents.getState().undoLabel).toBeNull();
      expect(t.autosave.unsaved()).toBe(false);
      const reader = new DocumentLibrary(t.backend, { locks: null });
      const main = await reader.open('a');
      expect(main.ok && main.value.document.name).toBe('Renamed main');
      const branch = await reader.open('a', 'b-1');
      expect(branch.ok && branch.value.document.name).toBe('Alpha');
      expect((await t.actions.list())[0]).toMatchObject({ id: 'a', name: 'Renamed main' });
    });

    it('duplicates the open document as it is open, on its branch', async () => {
      const t = await onBranch();
      const r = await t.actions.duplicate('a');
      expect(r).toEqual({ ok: true, message: 'Made Alpha (copy).' });
      const copy = await t.library.open('copy-1');
      expect(copy.ok && copy.value.document.name).toBe('Alpha (copy)');
    });

    it('a branch deleted in another tab: Load the newer version opens main and drops the changes', async () => {
      const t = await onBranch();
      t.documents.getState().execute({ type: 'renameDocument', name: 'Mine' }, 'Rename document');
      const other = new DocumentLibrary(t.backend, { locks: null });
      expect((await other.deleteBranch('a', 'b-1')).ok).toBe(true);
      expect(await t.autosave.flush()).toBe(false);
      expect(t.autosave.status.getState().state).toBe('conflict');
      expect(await t.actions.reloadNewer()).toEqual({
        ok: true,
        message:
          'Its branch was deleted in another tab or window, so this is the main branch of ' +
          'Alpha on main; the changes made here were dropped.',
      });
      expect(t.branch()).toBe('main');
      expect(t.documents.getState().document.name).toBe('Alpha on main');
      expect(t.autosave.unsaved()).toBe(false);
      // Edits from here go to main.
      t.documents.getState().execute({ type: 'renameDocument', name: 'Main again' }, 'Rename');
      expect(await t.autosave.flush()).toBe(true);
      const main = await other.open('a');
      expect(main.ok && main.value.document.name).toBe('Main again');
    });
  });
});
