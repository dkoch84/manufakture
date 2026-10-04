// The read-only viewer's entry (viewer.html; T7.3b). A page of its own, so it loads three.js and
// the viewport engine but none of the kernel, the solver, regen or the editor; the build checks
// that (src/viewer/bundleCheck.ts). It registers no service worker: when the app's worker is
// installed it already serves this page and its chunks from the precache.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerApp } from './ViewerApp';
import '../viewport/viewport.css';
import './viewer.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <ViewerApp />
  </StrictMode>,
);
