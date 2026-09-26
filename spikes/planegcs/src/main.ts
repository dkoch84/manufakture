// Spike page: runs the drag benchmark on the main thread and in a worker, and
// exposes window.spike for the Playwright-driven measurement script.

import type { GcsWrapper } from '@salusoft89/planegcs';
import { runInProcess, type DragSpec, type RunOptions, type RunResult } from './bench.ts';
import { loadWrapper } from './load-browser.ts';
import type { Request, Response } from './protocol.ts';

const status = document.querySelector<HTMLPreElement>('#status')!;

let wrapper: GcsWrapper | null = null;
let worker: Worker | null = null;
let pending: ((r: Response) => void) | null = null;

/** One request in flight at a time, like a drag handler that awaits each solve. */
function call(message: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (!worker) throw new Error('worker not started');
    pending = (r) => (r.type === 'error' ? reject(new Error(r.message)) : resolve(r));
    worker.postMessage(message);
  });
}

async function init(memoryPages: number) {
  const t0 = performance.now();
  wrapper = await loadWrapper(memoryPages);
  const mainInitMs = performance.now() - t0;

  worker?.terminate();
  const t1 = performance.now();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Response>) => pending?.(e.data);
  const r = await call({ type: 'init', memoryPages });
  const workerStartMs = performance.now() - t1;
  status.textContent = 'ready';
  return {
    mainInitMs,
    workerInitMs: r.type === 'init' ? r.initMs : NaN,
    workerStartMs,
  };
}

export interface WorkerRunResult extends RunResult {
  /** Page-side time from postMessage to the reply, per move. */
  roundTripMs: number[];
}

function runMain(spec: DragSpec, o: RunOptions): RunResult {
  if (!wrapper) throw new Error('init first');
  return runInProcess(wrapper, spec, o);
}

async function runWorker(spec: DragSpec, o: RunOptions): Promise<WorkerRunResult> {
  const s = await call({ type: 'setup', spec });
  if (s.type !== 'setup') throw new Error('unexpected reply');
  const solveMs: number[] = [];
  const moveMs: number[] = [];
  const roundTripMs: number[] = [];
  let failed = 0;
  let maxErrorMm = 0;
  for (let i = 1; i <= o.warmup + o.moves; i++) {
    const t0 = performance.now();
    const r = await call({ type: 'move', i });
    const t1 = performance.now();
    if (r.type !== 'move') throw new Error('unexpected reply');
    if (i <= o.warmup) continue;
    solveMs.push(r.solveMs);
    moveMs.push(r.moveMs);
    roundTripMs.push(t1 - t0);
    if (r.status === 'Failed') failed++;
    maxErrorMm = Math.max(maxErrorMm, r.errorMm);
  }
  return { spec, setup: s.setup, solveMs, moveMs, roundTripMs, failed, maxErrorMm };
}

/** Empty round trips: the messaging cost alone. */
async function ping(n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await call({ type: 'ping' });
    out.push(performance.now() - t0);
  }
  return out;
}

function env() {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
  };
}

const spike = { init, runMain, runWorker, ping, env };

declare global {
  interface Window {
    spike: typeof spike;
  }
}

window.spike = spike;
status.textContent = 'idle: call window.spike.init(pages)';
