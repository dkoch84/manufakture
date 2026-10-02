// A document's history, as the History panel and the version viewer use it: named versions and
// the timeline of saved revisions from the command log, grouped into sessions; reading a version
// or a revision back; and a short comparison of what differs from the current state.
//
// Everything here goes through `HistorySource`, the part of the document library it needs, so
// other places that pick a version (a derived part choosing the version of its source, T2.2c) use
// the same reading and labels.

import {
  diffDocuments,
  restoredDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { LibraryResult, LoggedRevision, Version, VersionMeta } from '../persistence/library';
import { importBodyId } from '../io/restorable';
import { createDocumentStore, type DocumentStoreApi } from '../state/document';
import {
  createViewSettingsStore,
  hiddenBodiesOf,
  type ViewSettingsStore,
} from '../state/viewSettings';

/**
 * What the history needs of the document library. The branch arguments are optional: without
 * one, `listVersions` lists every branch's versions (a version names its own branch) and the
 * others mean the branch the library has the document open on (main when none).
 */
export interface HistorySource {
  listVersions(id: string, branch?: string): Promise<LibraryResult<Version[]>>;
  readHistory(id: string, branch?: string): Promise<LibraryResult<LoggedRevision[]>>;
  historyStart(id: string, branch?: string): Promise<LibraryResult<number>>;
  readVersion(
    id: string,
    versionId: string,
  ): Promise<LibraryResult<{ version: Version; document: ManufaktureDocument }>>;
  readRevision(
    id: string,
    rev: number,
    options?: { branch?: string },
  ): Promise<LibraryResult<{ document: ManufaktureDocument; revision: number }>>;
}

/** Name the open document's current state (autosave's `createVersion`: it saves first). */
export type CreateVersion = (meta: VersionMeta) => Promise<LibraryResult<Version>>;

/**
 * Something in the history that can be viewed: a named version (which knows its branch), or a
 * saved revision of a branch (`branch` absent: the one the library has open).
 */
export type HistoryTarget =
  { kind: 'version'; version: Version } | { kind: 'revision'; revision: number; branch?: string };

/** How the viewer's banner and the restore's undo label name a target. */
export function targetLabel(target: HistoryTarget): string {
  return target.kind === 'version'
    ? `Version "${target.version.name}"`
    : `Revision ${target.revision}`;
}

/** Whether two targets are the same version or revision. */
export function sameTarget(a: HistoryTarget | null, b: HistoryTarget | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'version') return a.version.id === (b as { version: Version }).version.id;
  const other = b as { revision: number; branch?: string };
  return a.revision === other.revision && a.branch === other.branch;
}

/** The document a target names, read back from the library (checked there). */
export async function readTarget(
  source: HistorySource,
  documentId: string,
  target: HistoryTarget,
): Promise<LibraryResult<ManufaktureDocument>> {
  try {
    if (target.kind === 'version') {
      const r = await source.readVersion(documentId, target.version.id);
      return r.ok ? { ok: true, value: r.value.document } : r;
    }
    const r = await (target.branch === undefined
      ? source.readRevision(documentId, target.revision)
      : source.readRevision(documentId, target.revision, { branch: target.branch }));
    return r.ok ? { ok: true, value: r.value.document } : r;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The command that restores `past` over `current`: a `replaceDocument` of `past` under the
 * current id, with no id counter going back (core `restoredDocument`). One undo step.
 */
export function restoreCommand(current: ManufaktureDocument, past: ManufaktureDocument): Command {
  return { type: 'replaceDocument', document: restoredDocument(current, past) };
}

/**
 * A read-only store of a viewed document, for the tree, the part tabs and the panels that take a
 * store: every change (a command, undo, redo, load) is ignored and changes nothing, so nothing
 * shown while viewing can edit it. Switching part studios still works. Starts on `activePartId`
 * when the document has that part studio. Throws for an invalid document.
 */
export function viewDocuments(
  document: ManufaktureDocument,
  activePartId?: string,
): DocumentStoreApi {
  const store = createDocumentStore(document);
  if (activePartId !== undefined) store.getState().setActivePart(activePartId);
  const unchanged = () => ({ ok: true as const, value: diffDocuments(document, document) });
  store.setState({ execute: unchanged, undo: unchanged, redo: unchanged, load: unchanged });
  return store;
}

/**
 * Where hidden bodies are kept while a past state is viewed: a store of its own (in memory),
 * starting with what is hidden in the open document `documentId`, so hiding or showing a body
 * in the view leaves the open document's choice alone.
 */
export function viewSettingsFor(from: ViewSettingsStore, documentId: string): ViewSettingsStore {
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (key) => memory.get(key) ?? null,
    key: (i) => [...memory.keys()][i] ?? null,
    removeItem: (key) => void memory.delete(key),
    setItem: (key, value) => void memory.set(key, value),
  };
  const store = createViewSettingsStore(() => storage);
  const hidden = hiddenBodiesOf(from.getState(), documentId);
  if (hidden.length > 0) store.getState().setHiddenBodies(documentId, [], hidden);
  return store;
}

/** The body ids (`importBodyId`) of every reference import in `document`, in document order. */
export function referenceImportIds(document: ManufaktureDocument): string[] {
  return document.parts.flatMap((p) =>
    p.features
      .filter((f) => f.kind === 'import' && f.operation === 'reference')
      .map((f) => importBodyId(p.id, f.id)),
  );
}

/** Two saved revisions further apart than this start a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** One saved revision on the timeline. */
export interface TimelineRevision {
  revision: number;
  /** When its last command ran (ISO 8601). */
  at: string;
  /** What led to it, in order: "Edit Extrude 1", "Undo Add Sketch 2". */
  labels: string[];
  /** The versions that name it. */
  versions: Version[];
  /** Whether it can be read back (at or after the oldest retained snapshot). */
  readable: boolean;
}

/** Revisions saved close together, newest first. */
export interface Session {
  /** When its first and last commands ran (ISO 8601). */
  start: string;
  end: string;
  revisions: TimelineRevision[];
}

const CAUSE_PREFIX = { execute: '', undo: 'Undo ', redo: 'Redo ' } as const;

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * The timeline: every logged revision with its labels and the versions naming it, grouped into
 * sessions (a pause of more than `gapMs` between two revisions starts a new one), newest session
 * and newest revision first. `start` is the oldest readable revision (`historyStart`).
 */
export function timeline(
  logged: readonly LoggedRevision[],
  versions: readonly Version[],
  start: number | null,
  gapMs = SESSION_GAP_MS,
): Session[] {
  const sessions: Session[] = [];
  let current: Session | null = null;
  let last: number | null = null;
  for (const r of logged) {
    if (r.entries.length === 0) continue;
    const first = r.entries[0]!.at;
    const end = r.entries.at(-1)!.at;
    const t = time(first);
    if (!current || (t !== null && last !== null && t - last > gapMs)) {
      current = { start: first, end, revisions: [] };
      sessions.push(current);
    }
    current.end = end;
    last = time(end) ?? t ?? last;
    current.revisions.push({
      revision: r.revision,
      at: end,
      labels: r.entries.map((e) => `${CAUSE_PREFIX[e.cause]}${e.label}`),
      versions: versions.filter((v) => v.revision === r.revision),
      readable: start !== null && r.revision >= start,
    });
  }
  for (const s of sessions) s.revisions.reverse();
  return sessions.reverse();
}

/** A short, local date and time. */
export function formatWhen(iso: string): string {
  const t = time(iso);
  if (t === null) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A session's span: "30 Sep 2026, 14:02 to 14:40" (the date once when it is the same day). */
export function sessionSpan(session: Session): string {
  const a = time(session.start);
  const b = time(session.end);
  if (a === null || b === null) return `${session.start} to ${session.end}`;
  const start = formatWhen(session.start);
  if (a === b) return start;
  const sameDay = new Date(a).toDateString() === new Date(b).toDateString();
  const end = sameDay
    ? new Date(b).toLocaleTimeString(undefined, { timeStyle: 'short' })
    : formatWhen(session.end);
  return `${start} to ${end}`;
}

const listOf = (items: readonly string[]) => items.join(', ');

/**
 * What differs between the viewed document and the current state, one line each, from the
 * viewed document's side ("only here" means in the viewed one): features and part studios added,
 * removed and changed, variables, assemblies, the configuration table, name and units. Empty
 * when they are the same.
 */
export function compareDocuments(
  current: ManufaktureDocument,
  viewed: ManufaktureDocument,
): string[] {
  const change = diffDocuments(current, viewed);
  if (change.empty) return [];
  const lines: string[] = [];
  const several = current.parts.length > 1 || viewed.parts.length > 1;
  const partOf = (partId: string) =>
    viewed.parts.find((p) => p.id === partId) ?? current.parts.find((p) => p.id === partId);
  const featureName = (partId: string, featureId: string) => {
    const part = partOf(partId);
    const inViewed = viewed.parts.find((p) => p.id === partId)?.features;
    const inCurrent = current.parts.find((p) => p.id === partId)?.features;
    const f = [...(inViewed ?? []), ...(inCurrent ?? [])].find((x) => x.id === featureId);
    const name = f?.name ?? featureId;
    return several && part ? `${name} (${part.name})` : name;
  };
  if (change.nameChanged) lines.push(`Named "${viewed.name}" here, "${current.name}" now.`);
  const partsOnlyHere = change.parts.filter((p) => p.status === 'added');
  const partsOnlyNow = change.parts.filter((p) => p.status === 'removed');
  if (partsOnlyHere.length > 0) {
    lines.push(
      `Part studios only here: ${listOf(partsOnlyHere.map((p) => partOf(p.partId)!.name))}.`,
    );
  }
  if (partsOnlyNow.length > 0) {
    lines.push(
      `Part studios only in the current state: ${listOf(partsOnlyNow.map((p) => partOf(p.partId)!.name))}.`,
    );
  }
  const both = change.parts.filter((p) => p.status === 'changed');
  const added = both.flatMap((p) => p.added.map((f) => featureName(p.partId, f)));
  const removed = both.flatMap((p) => p.removed.map((f) => featureName(p.partId, f)));
  const changed = both.flatMap((p) => p.changed.map((f) => featureName(p.partId, f)));
  if (added.length > 0) lines.push(`Features only here: ${listOf(added)}.`);
  if (removed.length > 0) lines.push(`Features only in the current state: ${listOf(removed)}.`);
  if (changed.length > 0) lines.push(`Features that differ: ${listOf(changed)}.`);
  if (both.some((p) => p.reordered)) lines.push('Features are in a different order.');
  const other = both.filter(
    (p) =>
      p.added.length + p.removed.length + p.changed.length === 0 &&
      !p.reordered &&
      (p.rollbackChanged || p.materialChanged || p.bodyPropsChanged),
  );
  if (other.length > 0) {
    lines.push(
      `Rollback, material or body settings differ: ${listOf(other.map((p) => partOf(p.partId)!.name))}.`,
    );
  }
  const v = change.variables;
  const hash = (names: readonly string[]) => listOf(names.map((n) => `#${n}`));
  if (v.added.length > 0) lines.push(`Variables only here: ${hash(v.added)}.`);
  if (v.removed.length > 0) lines.push(`Variables only in the current state: ${hash(v.removed)}.`);
  if (v.changed.length > 0) lines.push(`Variables that differ: ${hash(v.changed)}.`);
  const assemblies = change.assemblies;
  if (assemblies.length > 0) {
    const name = (id: string) =>
      (viewed.assemblies.find((a) => a.id === id) ?? current.assemblies.find((a) => a.id === id))
        ?.name ?? id;
    lines.push(`Assemblies that differ: ${listOf(assemblies.map((a) => name(a.assemblyId)))}.`);
  }
  if (change.printChanged) {
    const setupName = (id: string) =>
      (
        viewed.print.setups.find((s) => s.id === id) ??
        current.print.setups.find((s) => s.id === id)
      )?.name ?? id;
    const p = change.print.setups;
    if (p.added.length > 0)
      lines.push(`Print setups only here: ${listOf(p.added.map(setupName))}.`);
    if (p.removed.length > 0) {
      lines.push(`Print setups only in the current state: ${listOf(p.removed.map(setupName))}.`);
    }
    if (p.changed.length > 0)
      lines.push(`Print setups that differ: ${listOf(p.changed.map(setupName))}.`);
    if (p.added.length + p.removed.length + p.changed.length === 0) {
      lines.push(
        change.print.reordered
          ? 'Print setups are in a different order.'
          : 'Print settings differ.',
      );
    }
  }
  if (change.camChanged) {
    const setupName = (id: string) =>
      (viewed.cam.setups.find((s) => s.id === id) ?? current.cam.setups.find((s) => s.id === id))
        ?.name ?? id;
    const toolName = (id: string) =>
      (viewed.cam.tools.find((t) => t.id === id) ?? current.cam.tools.find((t) => t.id === id))
        ?.name ?? id;
    const c = change.cam.setups;
    const t = change.cam.tools;
    if (c.added.length > 0) lines.push(`CAM setups only here: ${listOf(c.added.map(setupName))}.`);
    if (c.removed.length > 0) {
      lines.push(`CAM setups only in the current state: ${listOf(c.removed.map(setupName))}.`);
    }
    if (c.changed.length > 0) {
      lines.push(`CAM setups that differ: ${listOf(c.changed.map(setupName))}.`);
    }
    if (t.added.length > 0) lines.push(`CAM tools only here: ${listOf(t.added.map(toolName))}.`);
    if (t.removed.length > 0) {
      lines.push(`CAM tools only in the current state: ${listOf(t.removed.map(toolName))}.`);
    }
    if (t.changed.length > 0)
      lines.push(`CAM tools that differ: ${listOf(t.changed.map(toolName))}.`);
    if (
      c.added.length + c.removed.length + c.changed.length === 0 &&
      t.added.length + t.removed.length + t.changed.length === 0
    ) {
      lines.push(
        change.cam.reordered ? 'CAM setups are in a different order.' : 'CAM settings differ.',
      );
    }
  }
  if (change.drawingChanged) {
    const drawingName = (id: string) =>
      (viewed.drawings?.find((d) => d.id === id) ?? current.drawings?.find((d) => d.id === id))
        ?.name ?? id;
    const d = change.drawings.drawings;
    if (d.added.length > 0) lines.push(`Drawings only here: ${listOf(d.added.map(drawingName))}.`);
    if (d.removed.length > 0) {
      lines.push(`Drawings only in the current state: ${listOf(d.removed.map(drawingName))}.`);
    }
    if (d.changed.length > 0)
      lines.push(`Drawings that differ: ${listOf(d.changed.map(drawingName))}.`);
    if (d.added.length + d.removed.length + d.changed.length === 0) {
      lines.push(
        change.drawings.reordered ? 'Drawings are in a different order.' : 'The drawings differ.',
      );
    }
  }
  if (change.fontsChanged) {
    const ids = (doc: ManufaktureDocument) => new Set(doc.fonts.map((f) => f.id));
    const [inViewed, inCurrent] = [ids(viewed), ids(current)];
    const label = (f: ManufaktureDocument['fonts'][number]) => `${f.family} ${f.style}`;
    const onlyHere = viewed.fonts.filter((f) => !inCurrent.has(f.id)).map(label);
    const onlyNow = current.fonts.filter((f) => !inViewed.has(f.id)).map(label);
    if (onlyHere.length > 0) lines.push(`Fonts only here: ${listOf(onlyHere)}.`);
    if (onlyNow.length > 0) lines.push(`Fonts only in the current state: ${listOf(onlyNow)}.`);
    if (onlyHere.length + onlyNow.length === 0) lines.push('The font list differs.');
  }
  if (change.domainChanged.length > 0) {
    lines.push(`Settings that differ: ${listOf(change.domainChanged.map(domainLabel))}.`);
  }
  if (change.configurationsChanged) lines.push('The configuration table differs.');
  if (change.unitsChanged) lines.push('Display units differ.');
  return lines;
}

/** What the user knows a document's domain data namespace as (ADR 0013 decision 3). */
const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  stock: 'stock overrides',
  wood: 'woodworking settings',
};

function domainLabel(namespace: string): string {
  return Object.hasOwn(DOMAIN_LABELS, namespace)
    ? DOMAIN_LABELS[namespace]!
    : `"${namespace}" data`;
}
