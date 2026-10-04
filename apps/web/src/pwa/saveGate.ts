// The seam between autosave (owned by App) and the update flow (owned by main.tsx): App registers
// its autosave here while it runs, and the update flow flushes whatever is registered before it
// offers or performs a reload. With nothing registered (no library: the test scenes) there is
// nothing to save, so a flush succeeds at once.

import type { Autosave } from '../persistence/autosave';

let current: Pick<Autosave, 'flush'> | null = null;

/** Register the running autosave; returns the function that unregisters it. */
export function registerAutosave(autosave: Pick<Autosave, 'flush'>): () => void {
  current = autosave;
  return () => {
    if (current === autosave) current = null;
  };
}

/** Flush the registered autosave: true when every change is saved (or none is registered). */
export function flushAutosave(): Promise<boolean> {
  return current ? current.flush() : Promise.resolve(true);
}
