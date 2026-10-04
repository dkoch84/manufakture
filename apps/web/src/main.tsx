import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { logCrossOriginIsolation } from './isolation';
import { openBrowserLibrary } from './persistence/storage';
import { startPwa } from './pwa';
import { PwaStatus } from './pwa/PwaStatus';
import { testHooksEnabled } from './testHooks';
import { sceneFromSearch } from './viewport/scenes';

logCrossOriginIsolation();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// Documents are saved in the browser for the real app; the test scenes (only where the test
// hooks are on) keep theirs in memory.
const persisted = !testHooksEnabled || sceneFromSearch(window.location.search).scene === 'default';
const library = persisted ? openBrowserLibrary() : null;

// The service worker (production builds only; src/pwa/register.ts says when).
const pwa = startPwa();

createRoot(container).render(
  <StrictMode>
    <App library={library} />
    {pwa && <PwaStatus flow={pwa.flow} status={pwa.status} />}
  </StrictMode>,
);
