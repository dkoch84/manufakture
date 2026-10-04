// Persistent storage at install (T7.4b). Browsers may evict a site's storage, documents included,
// when the disk runs low, unless the site has asked to be kept (`navigator.storage.persist()`)
// and the browser agreed. Installing the app is the natural moment to ask: the user has just said
// they want to keep it, and browsers that decide by themselves (Chrome) favour installed apps. So
// the app asks after the first save, and when the browser reports the install (`appinstalled`) or
// the app first launches in its own window (display mode standalone).
//
// Each answer is remembered in localStorage with where it came from, so a browser that shows a
// prompt (Firefox) does not show it on every visit. An answer from a save is not final when it is
// a denial: the install (or first standalone launch) asks once more, since a tab's silent denial
// says little about an installed app. After that the app never asks by itself again. The home
// screen reads the remembered answer to say when persistence was denied, and its "Keep my
// documents" button asks again (the user asked for that) and records the new answer.
//
// Nothing is asked while documents live in memory (no browser storage at all: nothing to keep);
// App reports the library's kind with `noteLibraryKind` once it has opened the library.

import type { BackendKind } from '../persistence/backend';
import { requestPersistence } from '../persistence/storage';

export const PERSISTENCE_KEY = 'manufakture.persistence';

/** What asked: the first save, the install (or a standalone launch), or the user. */
export type PersistenceSource = 'save' | 'install' | 'user';

/** The browser's last answer to "keep this site's storage". */
export interface PersistenceAnswer {
  granted: boolean;
  /** When it was asked (ISO 8601). */
  at: string;
  source: PersistenceSource;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function localStore(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage blocked by the browser's settings.
    return null;
  }
}

const SOURCES: readonly string[] = ['save', 'install', 'user'];

/** The remembered answer, or null when the app never asked (or cannot remember). */
export function rememberedPersistence(
  store: KeyValue | null = localStore(),
): PersistenceAnswer | null {
  try {
    const raw = store?.getItem(PERSISTENCE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistenceAnswer> | null;
    if (typeof v?.granted !== 'boolean' || typeof v.at !== 'string') return null;
    // An answer without a source is read as one from a save (the install may still ask).
    const source = SOURCES.includes(v.source ?? '') ? v.source! : 'save';
    return { granted: v.granted, at: v.at, source };
  } catch {
    return null;
  }
}

/** Remember the browser's answer. */
export function rememberPersistence(
  granted: boolean,
  source: PersistenceSource = 'user',
  store: KeyValue | null = localStore(),
  now: () => Date = () => new Date(),
): void {
  try {
    const answer: PersistenceAnswer = { granted, at: now().toISOString(), source };
    store?.setItem(PERSISTENCE_KEY, JSON.stringify(answer));
  } catch {
    // Not remembered: it is asked again next time, which is harmless.
  }
}

/** Whether `source` may ask, given what was answered before. */
export function mayAsk(previous: PersistenceAnswer | null, source: PersistenceSource): boolean {
  if (previous === null || source === 'user') return true;
  // The install asks once more after a denial that came from a save.
  return source === 'install' && previous.source === 'save' && !previous.granted;
}

let resolveKind: (kind: BackendKind) => void = () => undefined;
let libraryKind: Promise<BackendKind> = new Promise((r) => (resolveKind = r));

/** App opened its library: where documents are stored. */
export function noteLibraryKind(kind: BackendKind): void {
  resolveKind(kind);
}

/** Tests: forget the library kind (the next ask waits for a new one). */
export function resetLibraryKind(): void {
  libraryKind = new Promise((r) => (resolveKind = r));
}

export interface AskOptions {
  /** Who asks (default: the first save). */
  source?: PersistenceSource;
  request?: () => Promise<boolean>;
  store?: KeyValue | null;
  now?: () => Date;
  /** Where documents are stored (default: what App reported with `noteLibraryKind`). */
  kind?: () => Promise<BackendKind>;
}

/** The question being asked, by store (one store in the app; tests pass their own). */
const asking = new Map<KeyValue | null, Promise<boolean | null>>();

/**
 * Ask for persistent storage unless an earlier answer settles it (see `mayAsk`); resolves to the
 * answer, or null when it did not ask.
 */
export function askPersistenceOnce(options: AskOptions = {}): Promise<boolean | null> {
  const {
    source = 'save',
    request = requestPersistence,
    store = localStore(),
    now,
    kind = () => libraryKind,
  } = options;
  if (!mayAsk(rememberedPersistence(store), source)) return Promise.resolve(null);
  // The install and the first save can ask at the same moment: one question.
  const running = asking.get(store);
  if (running) return running.then(() => null);
  const ask = (async () => {
    try {
      if ((await kind()) === 'memory') return null;
      // Checked again: another question may have been answered while waiting for the library.
      if (!mayAsk(rememberedPersistence(store), source)) return null;
      const granted = await request();
      rememberPersistence(granted, source, store, now);
      return granted;
    } finally {
      asking.delete(store);
    }
  })();
  asking.set(store, ask);
  return ask;
}

export interface InstallWatchOptions extends Omit<AskOptions, 'source'> {
  target?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'matchMedia'>;
}

/** Whether the app runs in its own window (installed), as opposed to a browser tab. */
export function isStandalone(target: Pick<Window, 'matchMedia'>): boolean {
  try {
    return (
      target.matchMedia('(display-mode: standalone)').matches ||
      target.matchMedia('(display-mode: window-controls-overlay)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Ask when the app is installed, or now when it already runs installed (see `mayAsk`). Returns
 * the function that stops listening for the install.
 */
export function askPersistenceAtInstall(options: InstallWatchOptions = {}): () => void {
  const { target = window, ...rest } = options;
  const ask = { ...rest, source: 'install' as const };
  const onInstalled = () => void askPersistenceOnce(ask);
  target.addEventListener('appinstalled', onInstalled);
  if (isStandalone(target)) void askPersistenceOnce(ask);
  return () => target.removeEventListener('appinstalled', onInstalled);
}
