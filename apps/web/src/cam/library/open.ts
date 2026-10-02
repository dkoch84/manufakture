// The user's tool library in the browser's storage, opened once, when the Tools dialog first asks
// for it (the store and the library validator load then, not with the app).

import { openBrowserBackend } from '../../persistence/storage';
import type { ToolLibraryStore } from './store';

let opened: Promise<ToolLibraryStore> | null = null;

export function browserToolLibrary(): Promise<ToolLibraryStore> {
  opened ??= (async () => {
    const [{ ToolLibraryStore }, backend] = await Promise.all([
      import('./store'),
      openBrowserBackend(),
    ]);
    return new ToolLibraryStore(backend);
  })();
  // A failure is not cached: the next attempt opens again.
  opened.catch(() => {
    opened = null;
  });
  return opened;
}
