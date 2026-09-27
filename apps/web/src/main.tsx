import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { logCrossOriginIsolation } from './isolation';
import { openBrowserLibrary } from './persistence/storage';
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

createRoot(container).render(
  <StrictMode>
    <App library={library} />
  </StrictMode>,
);
