// Measurement driver for the planegcs spike. Writes raw results to
// spikes/planegcs/results/*.json; docs/spikes/T0.4-planegcs.md quotes them.
//
//   pnpm --filter @manufakture/spike-planegcs measure            # everything
//   pnpm --filter @manufakture/spike-planegcs measure node browser
//
// Sections: sizes, limits, node, browser.

import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { build, preview } from 'vite';
import type { DragSpec, RunOptions, RunResult, Scenario } from '../src/bench.ts';
import { runInProcess } from '../src/bench.ts';
import type { WorkerRunResult } from '../src/main.ts';
import { chain } from '../src/sketch.ts';
import {
  ALGORITHMS,
  analyze,
  createWrapper,
  loadModule,
  type AlgorithmName,
} from '../src/solver.ts';
import { memoryLimits, WASM_PAGE } from '../src/wasm-memory.ts';
import {
  PLANEGCS_DIST,
  SPIKE_DIR,
  hostInfo,
  round,
  roundAll,
  stockWasm,
  summarize,
  writeResult,
} from './lib.ts';

/**
 * Memory for the benchmark runs, in 64 KiB pages: 64 MiB. The stock 16 MiB
 * aborts with OOM before 200 entities (see the limits section), so every run
 * uses the same patched copy for comparability.
 */
const BENCH_PAGES = 1024;
const ENTITIES = [10, 50, 200];
const OPTIONS: RunOptions = { warmup: 5, moves: 60 };

function log(message: string) {
  process.stdout.write(`[measure] ${message}\n`);
}

/** Every benchmark configuration. `drag` ignores the algorithm (SQP), so it runs once. */
function matrix(): DragSpec[] {
  const specs: DragSpec[] = [];
  for (const scenario of ['drag', 'pin', 'scrub'] as Scenario[]) {
    for (const entities of ENTITIES) {
      const algorithms: AlgorithmName[] = scenario === 'drag' ? ['DogLeg'] : ALGORITHMS;
      for (const algorithm of algorithms) specs.push({ scenario, entities, algorithm });
    }
  }
  return specs;
}

function label(s: DragSpec) {
  return `${s.scenario} ${s.entities} ${s.scenario === 'drag' ? 'SQP' : s.algorithm}`;
}

/** Summaries plus the raw samples (rounded), in one row per configuration. */
function row(r: RunResult | WorkerRunResult) {
  const out: Record<string, unknown> = {
    scenario: r.spec.scenario,
    entities: r.spec.entities,
    algorithm: r.spec.scenario === 'drag' ? 'SQP (temporary constraints)' : r.spec.algorithm,
    setup: roundAll(r.setup),
    solveMs: summarize(r.solveMs),
    moveMs: summarize(r.moveMs),
    failed: r.failed,
    maxErrorMm: r.maxErrorMm,
  };
  if ('roundTripMs' in r) {
    out.roundTripMs = summarize(r.roundTripMs);
    out.roundTripOverheadMs = summarize(r.roundTripMs.map((t, i) => t - (r.moveMs[i] ?? 0)));
  }
  out.raw = {
    solveMs: r.solveMs.map((v) => round(v)),
    moveMs: r.moveMs.map((v) => round(v)),
    ...('roundTripMs' in r ? { roundTripMs: r.roundTripMs.map((v) => round(v)) } : {}),
  };
  return out;
}

// ---------------------------------------------------------------- sizes

function compressed(bytes: Uint8Array) {
  return {
    raw: bytes.length,
    gzip9: gzipSync(bytes, { level: 9 }).length,
    brotli11: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

async function measureSizes() {
  const wasm = stockWasm();
  const limits = memoryLimits(wasm);
  return writeResult('sizes.json', {
    host: hostInfo(),
    files: {
      'planegcs.wasm': compressed(wasm),
      'planegcs.js (Emscripten glue)': compressed(readFileSync(`${PLANEGCS_DIST}planegcs.js`)),
      'gcs_wrapper.js': compressed(readFileSync(`${PLANEGCS_DIST}../sketch/gcs_wrapper.js`)),
    },
    wasmMemory: {
      ...limits,
      minMiB: (limits.minPages * WASM_PAGE) / 2 ** 20,
      maxMiB: limits.maxPages === null ? null : (limits.maxPages * WASM_PAGE) / 2 ** 20,
    },
  });
}

// ---------------------------------------------------------------- limits

/** Load, solve and diagnose one chain in a fresh module; OOM aborts poison a module. */
async function attempt(entities: number, mode: 'full' | 'free', pages?: number) {
  const mod = await loadModule(pages ? { wasmBytes: stockWasm(), memoryPages: pages } : {});
  const w = createWrapper(mod);
  const t0 = performance.now();
  try {
    const r = analyze(w, chain({ entities, mode, perturb: 0.5 }));
    return { ok: true, status: r.status, dof: r.dof, ms: round(performance.now() - t0, 1) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split('.')[0] : String(e) };
  }
}

async function measureLimits() {
  // The glue prints "Aborted(OOM)" itself; keep the log readable.
  const quiet = console.error;
  console.error = () => {};
  const stock: unknown[] = [];
  for (const mode of ['full', 'free'] as const) {
    for (const entities of [50, 100, 125, 130, 135, 140, 145, 150, 200]) {
      log(`limits stock ${mode} ${entities}`);
      stock.push({ mode, entities, ...(await attempt(entities, mode)) });
    }
  }
  const pages: unknown[] = [];
  for (const p of [384, 512, 640, 768, 896, 1024]) {
    log(`limits 200 full at ${p} pages`);
    pages.push({ pages: p, MiB: (p * WASM_PAGE) / 2 ** 20, ...(await attempt(200, 'full', p)) });
  }
  // Repeated clear_data + rebuild in one stock module: does memory leak?
  log('limits rebuild loop');
  const w = createWrapper(await loadModule());
  let rebuilds = 0;
  let rebuildError: string | null = null;
  try {
    for (; rebuilds < 300; rebuilds++)
      analyze(w, chain({ entities: 50, mode: 'full', perturb: 0.5 }));
  } catch (e) {
    rebuildError = e instanceof Error ? e.message.split('.')[0]! : String(e);
  }
  console.error = quiet;
  return writeResult('limits.json', {
    host: hostInfo(),
    note: 'chain() sketches solved once with DogLeg in a fresh module per attempt; "full" is DOF 0, "free" has no dimensions',
    stock16MiB: stock,
    entities200ByMemory: pages,
    rebuildLoop: { entities: 50, rebuildsCompleted: rebuilds, error: rebuildError },
  });
}

// ---------------------------------------------------------------- node

async function measureNode() {
  const wasm = stockWasm();
  const init: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await loadModule({ wasmBytes: wasm, memoryPages: BENCH_PAGES });
    init.push(performance.now() - t0);
  }
  const runs: unknown[] = [];
  for (const spec of matrix()) {
    log(`node ${label(spec)}`);
    // A fresh module per configuration, so runs cannot affect each other.
    const w = createWrapper(await loadModule({ wasmBytes: wasm, memoryPages: BENCH_PAGES }));
    runs.push(row(runInProcess(w, spec, OPTIONS)));
  }
  // Control: the stock 16 MiB binary against the patched one where both fit.
  const control: unknown[] = [];
  for (const pages of [undefined, BENCH_PAGES]) {
    const spec: DragSpec = { scenario: 'scrub', entities: 50, algorithm: 'DogLeg' };
    log(`node control ${label(spec)} pages=${pages ?? 'stock'}`);
    const w = createWrapper(await loadModule(pages ? { wasmBytes: wasm, memoryPages: pages } : {}));
    const r = runInProcess(w, spec, OPTIONS);
    control.push({ pages: pages ?? 'stock (256)', solveMs: summarize(r.solveMs) });
  }
  return writeResult('node.json', {
    host: hostInfo(),
    memoryPages: BENCH_PAGES,
    options: OPTIONS,
    initMs: summarize(init),
    memoryControl: control,
    runs,
  });
}

// ---------------------------------------------------------------- browser

async function measureBrowser() {
  log('vite build');
  await build({ root: SPIKE_DIR, logLevel: 'error' });
  const server = await preview({ root: SPIKE_DIR, preview: { port: 4198, strictPort: false } });
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('preview server has no URL');
  log(`preview at ${base}`);

  // Minimal containers may lack Chromium's shared libraries; they can be
  // unpacked anywhere and passed to the browser process only.
  const extraLibs = process.env.SPIKE_BROWSER_LD_LIBRARY_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(extraLibs ? { env: { ...process.env, LD_LIBRARY_PATH: extraLibs } } : {}),
  });
  const results: Record<string, unknown> = { browserVersion: browser.version() };
  try {
    const ctx = await browser.newContext();
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    await page.goto(base);
    await page.waitForFunction(() => 'spike' in window);
    results.env = await page.evaluate(() => window.spike.env());

    const init: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      init.push(roundAll(await page.evaluate((p) => window.spike.init(p), BENCH_PAGES)));
    }
    results.init = init;
    results.pingMs = summarize(await page.evaluate(() => window.spike.ping(200)));

    const main: unknown[] = [];
    const worker: unknown[] = [];
    for (const spec of matrix()) {
      // Fresh main-thread module and fresh worker for every configuration.
      await page.evaluate((p) => window.spike.init(p), BENCH_PAGES);
      log(`browser main ${label(spec)}`);
      main.push(
        row(await page.evaluate(({ s, o }) => window.spike.runMain(s, o), { s: spec, o: OPTIONS })),
      );
      log(`browser worker ${label(spec)}`);
      worker.push(
        row(
          await page.evaluate(({ s, o }) => window.spike.runWorker(s, o), { s: spec, o: OPTIONS }),
        ),
      );
    }
    results.main = main;
    results.worker = worker;
    await ctx.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
  return writeResult('browser.json', {
    host: hostInfo(),
    memoryPages: BENCH_PAGES,
    options: OPTIONS,
    ...results,
  });
}

// ---------------------------------------------------------------- main

const sections = process.argv.slice(2);
const want = (s: string) => sections.length === 0 || sections.includes(s);
const t0 = performance.now();
if (want('sizes')) log(`wrote ${await measureSizes()}`);
if (want('limits')) log(`wrote ${await measureLimits()}`);
if (want('node')) log(`wrote ${await measureNode()}`);
if (want('browser')) log(`wrote ${await measureBrowser()}`);
log(`done in ${round((performance.now() - t0) / 1000, 0)} s`);
