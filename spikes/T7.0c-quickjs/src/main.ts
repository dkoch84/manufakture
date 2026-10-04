// The page: start the module worker, forward the task list from the URL, publish the reply on
// `window.__result` for Playwright.

import type { Task } from './tasks';

const tasks = (new URLSearchParams(location.search).get('tasks') ?? 'all').split(',') as Task[];
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (event: MessageEvent<{ log?: string }>) => {
  // Progress lines go to the console, which Playwright records even if the page crashes later.
  if (typeof event.data.log === 'string') console.log(event.data.log);
  else (window as unknown as { __result: unknown }).__result = event.data;
};
worker.onerror = (event) => {
  (window as unknown as { __result: unknown }).__result = { ok: false, error: event.message };
};
worker.postMessage({ tasks });
