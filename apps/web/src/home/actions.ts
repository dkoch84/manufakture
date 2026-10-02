// What the home screen's buttons do, apart from React so it can be tested against a library in
// memory. The open document is special: its pending changes are saved before it is copied or
// exported, or another document replaces it, and when that save fails the action stops, saying
// so and offering to save again or export the unsaved version, so changes are never dropped by
// opening something else. It is renamed through the document store (an undoable command, which
// autosave then saves), and deleting it opens a new document in its place.

import type { ManufaktureDocument } from '@manufakture/core';
import { formatBytes, readFileBytes } from '../io/files';
import type { Autosave } from '../persistence/autosave';
import {
  MAIN_BRANCH,
  packDocument,
  type DocumentLibrary,
  type DocumentSummary,
  type Opened,
} from '../persistence/library';
import { MAX_MFK_FILE_BYTES } from '../persistence/limits';
import { newDocument, type DocumentStoreApi } from '../state/document';
import { couponDocument } from './coupon';

export const MFK_MIME = 'application/vnd.manufakture+zip';

export interface ActionOutcome {
  ok: boolean;
  message: string;
  /**
   * The action stopped because a document's changes are not saved: the home screen offers to
   * save again (`retrySave`) or to export the open document as it is (`exportCurrent`).
   */
  unsaved?: boolean;
}

export interface HomeHost {
  library: DocumentLibrary;
  documents: DocumentStoreApi;
  autosave: Autosave | null;
  /**
   * Show `document` in the editor (it replaces the open one). `stored`: it is in the library
   * (not a new document that is saved on its first change). `stayHome`: keep the home screen
   * showing.
   */
  show(
    document: ManufaktureDocument,
    options: { stored: boolean; migrated?: boolean; stayHome?: boolean; branch?: string },
  ): void;
  download(bytes: Uint8Array, fileName: string, type: string): void;
  /**
   * The branch the open document is on (default: main). Only the open document's actions use
   * it; every other document is acted on as its main branch.
   */
  branch?: () => string;
}

export interface HomeActions {
  list(): Promise<DocumentSummary[]>;
  open(id: string): Promise<ActionOutcome>;
  create(): Promise<ActionOutcome>;
  /** A new fit-test coupon document (coupon.ts), opened like a new document. */
  createCoupon(): Promise<ActionOutcome>;
  rename(id: string, name: string): Promise<ActionOutcome>;
  duplicate(id: string): Promise<ActionOutcome>;
  remove(id: string): Promise<ActionOutcome>;
  exportFile(id: string): Promise<ActionOutcome>;
  importFile(file: { name: string; bytes: Uint8Array }): Promise<ActionOutcome>;
  /** Import a picked or dropped file: refused unread when it is over the `.mfk` size limit. */
  importPicked(file: Blob & { name: string }): Promise<ActionOutcome>;
  /** Save the pending changes again (after a failed save). */
  retrySave(): Promise<ActionOutcome>;
  /** Download the open document, as it is in the editor, as a `.mfk` file. */
  exportCurrent(): Promise<ActionOutcome>;
  /** Another tab saved the open document: drop this tab's changes and open the stored version. */
  reloadNewer(): Promise<ActionOutcome>;
  /** Another tab saved the open document: save this tab's version as a new document, and open it. */
  keepAsCopy(): Promise<ActionOutcome>;
}

const failed = (message: string): ActionOutcome => ({ ok: false, message });

/**
 * What to say about a document just opened: "Opened <name>.", with a note when it was recovered
 * from its last complete save or updated from an older file format. `quiet`: null when there is
 * nothing to note.
 */
export function openedMessage(opened: Opened, quiet?: false): string;
export function openedMessage(opened: Opened, quiet: true): string | null;
export function openedMessage(opened: Opened, quiet = false): string | null {
  const notes = [
    opened.recovered ? 'recovered from its last complete save' : null,
    opened.migrated ? 'updated from an older file format' : null,
  ].filter((n) => n !== null);
  const name = opened.document.name;
  if (notes.length === 0) return quiet ? null : `Opened ${name}.`;
  return `Opened ${name} (${notes.join('; ')}).`;
}

export function homeActions(host: HomeHost): HomeActions {
  const { library, documents } = host;
  const currentId = () => documents.getState().document.id;
  const currentBranch = () => host.branch?.() ?? MAIN_BRANCH;

  /**
   * Save every pending change. Null when that worked (or there is no autosave); otherwise the
   * outcome that stops the action, naming the document whose changes are not saved.
   */
  const saveFirst = async (): Promise<ActionOutcome | null> => {
    if (!host.autosave || (await host.autosave.flush())) return null;
    const { state, message, documentName: name } = host.autosave.status.getState();
    return {
      ok: false,
      unsaved: true,
      message:
        state === 'conflict'
          ? `${name} was changed in another tab or window, so the changes made here are not saved. ` +
            'Go back to it to choose which version to keep, or export this version as a .mfk file.'
          : `The changes to ${name} are not saved (${message ?? 'the save failed'}), so nothing ` +
            'else was opened. Save again, or export it as a .mfk file to keep them.',
    };
  };
  /** `saveFirst` when `id` is the open document (it is about to be copied or exported). */
  const settle = async (id: string) => (id === currentId() ? saveFirst() : null);

  const open = async (id: string): Promise<ActionOutcome> => {
    const stop = await saveFirst();
    if (stop) return stop;
    const opened = await library.open(id);
    if (!opened.ok) return failed(opened.message);
    host.show(opened.value.document, { stored: true, migrated: opened.value.migrated });
    return { ok: true, message: openedMessage(opened.value) };
  };

  const importFile = async (file: { name: string; bytes: Uint8Array }): Promise<ActionOutcome> => {
    const stop = await saveFirst();
    if (stop) return stop;
    const r = await library.importMfk(file.bytes);
    if (!r.ok) return failed(`${file.name}: ${r.message}`);
    const opened = await open(r.value.summary.id);
    if (!opened.ok) return opened;
    const note = r.value.migrated ? ', updated from an older file format' : '';
    return { ok: true, message: `Imported ${file.name} as ${r.value.summary.name}${note}.` };
  };

  return {
    list: () => library.list(),
    open,

    async create() {
      const stop = await saveFirst();
      if (stop) return stop;
      const doc = newDocument();
      await library.create(doc);
      host.show(doc, { stored: true });
      return { ok: true, message: `Created ${doc.name}.` };
    },

    async createCoupon() {
      const stop = await saveFirst();
      if (stop) return stop;
      const doc = couponDocument();
      await library.create(doc);
      host.show(doc, { stored: true });
      return {
        ok: true,
        message:
          `Created ${doc.name}: print it, then set #fit_press, #fit_slip and #fit_sliding from ` +
          'the clearances debossed next to the holes that fit.',
      };
    },

    async rename(id, name) {
      // The open document on Main: renamed as an undoable command, which autosave saves. Open on
      // another branch, it is Main that is renamed (the home screen lists Main's name), in the
      // library; the branch keeps its own name.
      if (id === currentId() && currentBranch() === MAIN_BRANCH) {
        const r = documents.getState().execute({ type: 'renameDocument', name }, 'Rename document');
        if (!r.ok) return failed(r.error.message);
        const stop = await saveFirst();
        if (stop) return stop;
        return { ok: true, message: `Renamed to ${documents.getState().document.name}.` };
      }
      const r = await library.rename(id, name);
      return r.ok ? { ok: true, message: `Renamed to ${r.value.name}.` } : failed(r.message);
    },

    async duplicate(id) {
      const stop = await settle(id);
      if (stop) return stop;
      // The open document is copied as it is open: its branch. Any other one: its main branch.
      const r = await library.duplicate(id, id === currentId() ? currentBranch() : MAIN_BRANCH);
      return r.ok ? { ok: true, message: `Made ${r.value.name}.` } : failed(r.message);
    },

    async remove(id) {
      const open = id === currentId();
      // Any document's changes still waiting (a save that failed after switching away, say)
      // would bring it back.
      host.autosave?.discard(id);
      await library.remove(id);
      // The open document is gone: an empty one takes its place (saved on its first change).
      if (open) host.show(newDocument(), { stored: false, stayHome: true });
      return { ok: true, message: 'Deleted.' };
    },

    async exportFile(id) {
      const stop = await settle(id);
      if (stop) return stop;
      const r = await library.exportMfk(id);
      if (!r.ok) return failed(r.message);
      host.download(r.value.bytes, r.value.name, MFK_MIME);
      return { ok: true, message: `Exported ${r.value.name}.` };
    },

    importFile,

    async importPicked(file) {
      if (file.size > MAX_MFK_FILE_BYTES) {
        return failed(
          `${file.name} is ${formatBytes(file.size)}; a .mfk file can be at most ${formatBytes(MAX_MFK_FILE_BYTES)}.`,
        );
      }
      return importFile({ name: file.name, bytes: await readFileBytes(file) });
    },

    async retrySave() {
      const stop = await saveFirst();
      return stop ?? { ok: true, message: 'Saved.' };
    },

    async exportCurrent() {
      const { name, bytes } = await packDocument(documents.getState().document);
      host.download(bytes, name, MFK_MIME);
      return { ok: true, message: `Exported ${name} as it is open, unsaved changes included.` };
    },

    async reloadNewer() {
      const id = currentId();
      // The branch it is open on: the newer version is that branch's. When another tab deleted
      // that branch, its main branch opens instead; this tab's changes are dropped either way.
      let branch = currentBranch();
      let opened = await library.open(id, branch);
      let gone = false;
      if (!opened.ok && opened.noBranch && branch !== MAIN_BRANCH) {
        gone = true;
        branch = MAIN_BRANCH;
        opened = await library.open(id, branch);
      }
      if (!opened.ok) return failed(opened.message);
      host.autosave?.forget(id);
      host.show(opened.value.document, {
        stored: true,
        migrated: opened.value.migrated,
        branch,
      });
      const name = opened.value.document.name;
      return {
        ok: true,
        message: gone
          ? `Its branch was deleted in another tab or window, so this is the main branch of ${name}; the changes made here were dropped.`
          : `Opened the newer version of ${name}.`,
      };
    },

    async keepAsCopy() {
      const doc = documents.getState().document;
      const copy = await library.saveCopy(doc);
      host.autosave?.forget(doc.id);
      host.show(copy.document, { stored: true });
      return {
        ok: true,
        message: `Saved this version as ${copy.summary.name}; the other version stays as it was.`,
      };
    },
  };
}
