// Updating the app on request (T7.4b): what the "update the app" action does when this version is
// too old for something it met. Today that is a document saved by a newer version (ADR 0004
// decision 2, shown by UpdateNeeded.tsx on the home screen). The sync protocol handshake (T7.1d)
// is meant to use the same path: when the server speaks a newer protocol, show
// `<UpdateNeeded reason="sync-protocol" />`.
//
// startPwa (index.ts) installs the running service worker's updater here. Without one (no
// service worker: `vite dev`, an unsupported browser, a test build without the opt-in) the check
// says `no-worker`, and reloading the page is all it takes to load the newest build from the host.

import type { UpdateCheck } from './register';
import type { UpdateFlow } from './updateFlow';

/** Why this version of the app is too old (the wording of UpdateNeeded.tsx). */
export type UpdateNeededReason =
  /** A document saved by a newer version (refused, never modified). */
  | 'document'
  /** The sync server speaks a newer protocol (T7.1d). */
  | 'sync-protocol';

export interface AppUpdater {
  /** Ask the host for a new version; a new one is then offered through `flow`. */
  check(): Promise<UpdateCheck>;
  /** The update flow (null with no service worker). */
  flow: UpdateFlow | null;
  /** Reload the page. */
  reloadPage(): void;
}

const reloadPage = () => window.location.reload();

const NO_WORKER: AppUpdater = {
  check: () => Promise.resolve('no-worker'),
  flow: null,
  reloadPage,
};

let current: AppUpdater | null = null;

/** Install the running service worker's updater (startPwa). */
export function setAppUpdater(updater: Omit<AppUpdater, 'reloadPage'> | null): void {
  current = updater ? { ...updater, reloadPage } : null;
}

/** The running updater, or one that says there is no service worker. */
export function appUpdater(): AppUpdater {
  return current ?? NO_WORKER;
}
