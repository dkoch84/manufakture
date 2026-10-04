// Which scripts run on this device (T7.2d; ADR 0010 amendment, item 11). A script is code from
// whoever wrote the document, so until the human security sign-off (T7.6b) has been recorded a
// document's scripts run only after the user allows them here:
//
// - **Run scripts** in the banner allows one whole document (by id), from now on.
// - A script the user writes or edits in the script editor is allowed as saved: its exact source
//   (by SHA-256), in that document. Another script of the same document, or the same script once
//   sync or a merge changes it, is not.
// - The setting **Run scripts in documents automatically** runs every document's scripts. Until the
//   sign-off it is locked off, whatever storage holds: `SCRIPTS_SECURITY_SIGNED_OFF` is the one
//   switch that makes it available (and on by default).
//
// The choices are stored on this device (localStorage), never in the document, so they never
// travel with a file, a link or sync. The regen worker enforces them (`ScriptPolicy` of
// `@manufakture/regen`): a document not allowed regenerates without running any script, and each
// scripted feature fails with "Scripts not run".

import type { Feature, ManufaktureDocument, Script } from '@manufakture/core';
import type { FeatureResult, ScriptPolicy } from '@manufakture/regen';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Whether the human security sign-off of the script sandbox (T7.6b) has been recorded. Until then
 * **Run scripts in documents automatically** is locked off (not tickable, and off even when
 * storage says otherwise), so the per-document opt-in applies to every document. Once it is
 * recorded, the setting can be changed and defaults to on. Change this (and nothing else) then;
 * the user guide (docs/user/scripting.md) says so.
 */
export const SCRIPTS_SECURITY_SIGNED_OFF = false;

/** What the automatic setting is when the user never chose: off before the sign-off, on after. */
export const AUTO_RUN_DEFAULT: boolean = SCRIPTS_SECURITY_SIGNED_OFF;

/** The localStorage key the choices are kept under. */
export const SCRIPT_GRANTS_KEY = 'manufakture.scriptGrants.v1';

/** The most documents remembered as allowed (the oldest are forgotten first). */
export const MAX_ALLOWED_DOCUMENTS = 2000;
/** The most allowed sources remembered per script (undo can bring an older one back). */
export const MAX_SOURCES_PER_SCRIPT = 20;
/** The most allowed sources remembered in all. */
export const MAX_ALLOWED_SOURCES = 20_000;

/** One allowed source: a script of a document, as saved in the editor. */
export interface SourceGrant {
  document: string;
  script: string;
  sha256: string;
}

export interface ScriptGrantsState {
  /** The setting as the user chose it; null when never chosen (on, once it is available). */
  autoChoice: boolean | null;
  /** Documents whose scripts all run, oldest first. */
  documents: readonly string[];
  /** Allowed sources, oldest first. */
  sources: readonly SourceGrant[];
  /** Moves on every change that changes what may run (the app regenerates then). */
  revision: number;
  /** Whether the automatic setting may be changed (after the security sign-off only). */
  autoAvailable: boolean;
  /** **Run scripts in documents automatically**, as it is now: always off while not available. */
  auto(): boolean;
  /** Ignored while the setting is not available. */
  setAuto(on: boolean): void;
  /** **Run scripts** for a document. */
  allowDocument(documentId: string): void;
  /**
   * Allow a script exactly as `source` (the editor saved it). True when this added a grant,
   * false when the source was allowed already.
   */
  allowSource(documentId: string, scriptId: string, source: string): Promise<boolean>;
  /** Take back the grant of exactly `source` (a save that did not happen). */
  revokeSource(documentId: string, scriptId: string, source: string): Promise<void>;
  /** Forget everything allowed for a document (it was deleted, or a file took its id). */
  forget(documentId: string): void;
  /** The policy the regen worker enforces. */
  policy(): ScriptPolicy;
}

export type ScriptGrantsStore = StoreApi<ScriptGrantsState>;

/** The SHA-256 of a script source as stored (its UTF-8 bytes), as lower-case hex. */
export async function sourceSha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Saved {
  autoChoice: boolean | null;
  documents: string[];
  sources: SourceGrant[];
}

const SHA = /^[0-9a-f]{64}$/;

/** What localStorage holds, checked; anything malformed reads as nothing allowed. */
export function readSaved(text: string | null): Saved {
  const empty: Saved = { autoChoice: null, documents: [], sources: [] };
  if (text === null) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (raw === null || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const autoChoice = typeof r.auto === 'boolean' ? r.auto : null;
  const documents = Array.isArray(r.documents)
    ? r.documents.filter((d): d is string => typeof d === 'string').slice(-MAX_ALLOWED_DOCUMENTS)
    : [];
  const sources = Array.isArray(r.sources)
    ? (r.sources as unknown[])
        .filter(
          (g): g is SourceGrant =>
            g !== null &&
            typeof g === 'object' &&
            typeof (g as SourceGrant).document === 'string' &&
            typeof (g as SourceGrant).script === 'string' &&
            typeof (g as SourceGrant).sha256 === 'string' &&
            SHA.test((g as SourceGrant).sha256),
        )
        .map((g) => ({ document: g.document, script: g.script, sha256: g.sha256 }))
        .slice(-MAX_ALLOWED_SOURCES)
    : [];
  return { autoChoice, documents, sources };
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The store of what may run, kept in `storage` (default: the browser's localStorage).
 * `signedOff` (default `SCRIPTS_SECURITY_SIGNED_OFF`) makes the automatic setting available.
 */
export function createScriptGrantsStore(
  storage: () => Storage | null = browserStorage,
  options: { signedOff?: boolean } = {},
): ScriptGrantsStore {
  const signedOff = options.signedOff ?? SCRIPTS_SECURITY_SIGNED_OFF;
  let initial: Saved;
  try {
    initial = readSaved(storage()?.getItem(SCRIPT_GRANTS_KEY) ?? null);
  } catch {
    initial = readSaved(null);
  }
  const store = createStore<ScriptGrantsState>()((set, get) => {
    const save = (next: Saved) => {
      set((s) => ({ ...next, revision: s.revision + 1 }));
      try {
        const out: Record<string, unknown> = { documents: next.documents, sources: next.sources };
        if (next.autoChoice !== null) out.auto = next.autoChoice;
        storage()?.setItem(SCRIPT_GRANTS_KEY, JSON.stringify(out));
      } catch {
        // Storage full or refused: the choice holds for this session only.
      }
    };
    const current = (): Saved => {
      const s = get();
      return { autoChoice: s.autoChoice, documents: [...s.documents], sources: [...s.sources] };
    };
    return {
      ...initial,
      revision: 0,
      autoAvailable: signedOff,
      // Before the sign-off a stored `true` (an older build, a hand edit) counts for nothing.
      auto: () => signedOff && (get().autoChoice ?? true),
      setAuto(on) {
        if (!signedOff) return;
        if (get().auto() === on && get().autoChoice !== null) return;
        save({ ...current(), autoChoice: on });
      },
      allowDocument(documentId) {
        const s = current();
        if (s.documents.includes(documentId)) return;
        save({ ...s, documents: [...s.documents, documentId].slice(-MAX_ALLOWED_DOCUMENTS) });
      },
      async allowSource(documentId, scriptId, source) {
        const sha256 = await sourceSha256(source);
        const s = current();
        const mine = (g: SourceGrant) => g.document === documentId && g.script === scriptId;
        if (s.sources.some((g) => mine(g) && g.sha256 === sha256)) return false;
        const others = s.sources.filter((g) => !mine(g));
        const kept = s.sources.filter(mine).slice(-(MAX_SOURCES_PER_SCRIPT - 1));
        const sources = [...others, ...kept, { document: documentId, script: scriptId, sha256 }];
        save({ ...s, sources: sources.slice(-MAX_ALLOWED_SOURCES) });
        return true;
      },
      async revokeSource(documentId, scriptId, source) {
        const sha256 = await sourceSha256(source);
        const s = current();
        const gone = (g: SourceGrant) =>
          g.document === documentId && g.script === scriptId && g.sha256 === sha256;
        if (!s.sources.some(gone)) return;
        save({ ...s, sources: s.sources.filter((g) => !gone(g)) });
      },
      forget(documentId) {
        const s = current();
        if (
          !s.documents.includes(documentId) &&
          !s.sources.some((g) => g.document === documentId)
        ) {
          return;
        }
        save({
          ...s,
          documents: s.documents.filter((d) => d !== documentId),
          sources: s.sources.filter((g) => g.document !== documentId),
        });
      },
      policy() {
        const s = get();
        return { auto: s.auto(), documents: [...s.documents], scripts: [...s.sources] };
      },
    };
  });
  return store;
}

/** The app's store: one per tab, read from and written to localStorage. */
export const scriptGrantsStore: ScriptGrantsStore = createScriptGrantsStore();

/** A scripted feature of the document, with where it is and the script it runs. */
export interface ScriptedUse {
  partId: string;
  partName: string;
  feature: Feature & { kind: 'scripted' };
  /** Undefined when the document has no such script (regen reports that). */
  script: Script | undefined;
}

/** Every scripted feature of the document, in part and feature order. */
export function scriptedUses(doc: ManufaktureDocument): ScriptedUse[] {
  const out: ScriptedUse[] = [];
  for (const part of doc.parts) {
    for (const f of part.features) {
      if (f.kind !== 'scripted') continue;
      out.push({
        partId: part.id,
        partName: part.name,
        feature: f,
        script: doc.scripts?.find((s) => s.id === f.script),
      });
    }
  }
  return out;
}

/**
 * Whether a script of `documentId` may run under the store's state, given the SHA-256 of its
 * source (`sha`; undefined while it is being computed, which counts as not allowed).
 */
export function mayRun(
  state: Pick<ScriptGrantsState, 'auto' | 'documents' | 'sources'>,
  documentId: string,
  scriptId: string,
  sha: string | undefined,
): boolean {
  if (state.auto() || state.documents.includes(documentId)) return true;
  if (sha === undefined) return false;
  return state.sources.some(
    (g) => g.document === documentId && g.script === scriptId && g.sha256 === sha,
  );
}

/** As `mayRun`, hashing the source itself. */
export async function mayRunScript(
  state: Pick<ScriptGrantsState, 'auto' | 'documents' | 'sources'>,
  documentId: string,
  script: Pick<Script, 'id' | 'source'>,
): Promise<boolean> {
  if (state.auto() || state.documents.includes(documentId)) return true;
  return mayRun(state, documentId, script.id, await sourceSha256(script.source));
}

/**
 * The scripted features whose scripts may not run (what the banner lists), given the SHA-256 of
 * every script source (`shas`, keyed by the source text). Null while a source in use has no hash
 * yet.
 */
export function blockedUses(
  doc: ManufaktureDocument,
  state: Pick<ScriptGrantsState, 'auto' | 'documents' | 'sources'>,
  shas: ReadonlyMap<string, string>,
): ScriptedUse[] | null {
  if (state.auto() || state.documents.includes(doc.id)) return [];
  const out: ScriptedUse[] = [];
  for (const use of scriptedUses(doc)) {
    if (use.script === undefined) continue;
    const sha = shas.get(use.script.source);
    if (sha === undefined) return null;
    if (!mayRun(state, doc.id, use.script.id, sha)) out.push(use);
  }
  return out;
}

/** A derived part whose source document's scripts did not run (regen's `derived-source`). */
export interface BlockedSource {
  partId: string;
  partName: string;
  featureId: string;
  featureName: string;
  /** The source document's name, as the derived feature pins it. */
  documentName: string;
}

/**
 * The derived parts whose source scripts the last regen did not run: a source document's scripts
 * run only when this document is allowed as a whole (regen's `scriptsNotRun`). `parts`: the
 * model's results, built from `built` (only counted when that is this document). Empty when the
 * document is allowed.
 */
export function blockedSources(
  doc: ManufaktureDocument,
  state: Pick<ScriptGrantsState, 'auto' | 'documents'>,
  built: ManufaktureDocument | null,
  parts: readonly { partId: string; features: readonly FeatureResult[] }[],
): BlockedSource[] {
  if (state.auto() || state.documents.includes(doc.id)) return [];
  if (built === null || built.id !== doc.id) return [];
  const out: BlockedSource[] = [];
  for (const part of doc.parts) {
    const results = parts.find((p) => p.partId === part.id)?.features ?? [];
    for (const f of part.features) {
      if (f.kind !== 'derived') continue;
      const r = results.find((x) => x.featureId === f.id);
      const notRun = r?.warnings.some(
        (w) => w.code === 'derived-source' && (w.scriptsNotRun?.length ?? 0) > 0,
      );
      if (!notRun) continue;
      out.push({
        partId: part.id,
        partName: part.name,
        featureId: f.id,
        featureName: f.name,
        documentName: f.source.documentName,
      });
    }
  }
  return out;
}
