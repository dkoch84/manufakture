// The page: starts the FEA worker with the plan the test serves, and puts the worker's reply on
// window.__result for Playwright to read.

const plan = await (await fetch('/plan.json')).json();
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const result = await new Promise((resolve) => {
  worker.onmessage = (e) => {
    if (e.data && 'progress' in e.data)
      console.log(`__progress ${e.data.phase} ${e.data.progress}`);
    else resolve(e.data);
  };
  worker.onerror = (e) => resolve({ error: `worker error: ${e.message}` });
  worker.postMessage(plan);
});
(window as unknown as { __result: unknown }).__result = {
  crossOriginIsolated,
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
  ...(result as object),
};
