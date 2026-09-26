// Measurement driver for the OCCT worker spike. Writes raw results to
// spikes/occt-worker/results/*.json; docs/spikes/T0.2-occt.md quotes them.
//
//   pnpm --filter @manufakture/spike-occt-worker measure            # everything
//   pnpm --filter @manufakture/spike-occt-worker measure node browser
//
// Sections: sizes, audit, node, browser.

import { readFileSync, readdirSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { build, preview } from 'vite';
import { CASES, type CaseName } from '../src/cases.ts';
import type { MemoryMode } from '../src/pipeline.ts';
import type { HeapTrace, InitOptions, InitReport, LoadMode, Variant } from '../src/protocol.ts';
import {
  LIBCASCADE_DIST,
  MiB,
  RESULTS_DIR,
  SPIKE_DIR,
  child,
  hostInfo,
  round,
  summarize,
  writeResult,
} from './lib.ts';

const VARIANTS: Variant[] = ['single', 'multi'];
const MEMORY_MODES: MemoryMode[] = ['strict', 'mitigated', 'none'];

function log(message: string) {
  process.stdout.write(`[measure] ${message}\n`);
}

// ---------------------------------------------------------------- sizes

function compressed(bytes: Buffer) {
  const t0 = performance.now();
  const gzip9 = gzipSync(bytes, { level: 9 }).length;
  const gzip6 = gzipSync(bytes, { level: 6 }).length;
  const t1 = performance.now();
  const brotli11 = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
  const t2 = performance.now();
  const brotli5 = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
  }).length;
  return {
    raw: bytes.length,
    gzip6,
    gzip9,
    brotli5,
    brotli11,
    gzipMs: round(t1 - t0, 0),
    brotli11Ms: round(t2 - t1, 0),
  };
}

async function measureSizes() {
  const files: Record<string, unknown> = {};
  for (const v of VARIANTS) {
    for (const name of [`opencascade_${v}.wasm`, `opencascade_${v}.js`, `init.${v}.js`]) {
      log(`compressing ${name}`);
      files[name] = compressed(readFileSync(`${LIBCASCADE_DIST}${name}`));
    }
  }
  // The spike's own bundle (three.js + page code, and the worker chunk).
  const assets = `${SPIKE_DIR}dist/assets/`;
  const app: Record<string, unknown> = {};
  try {
    for (const name of readdirSync(assets)) {
      if (/^(index|worker)-.*\.js$/.test(name)) {
        app[name.replace(/-[^-.]+\.js$/, '.js')] = compressed(readFileSync(assets + name));
      }
    }
  } catch {
    log('no dist/ yet; app bundle sizes skipped (run the browser section first)');
  }
  return writeResult('sizes.json', { host: hostInfo(), libcascade: files, spikeBundle: app });
}

// ---------------------------------------------------------------- audit

async function measureAudit() {
  type Audit = { emptyClasses: string[] } & Record<string, unknown>;
  log('destructor audit single');
  const single = child<Audit>(['scripts/destructor-audit.ts', 'single']);
  log('destructor audit multi');
  const { emptyClasses: multiEmpty, ...multi } = child<Audit>([
    'scripts/destructor-audit.ts',
    'multi',
  ]);
  return writeResult('destructor-audit.json', {
    host: hostInfo(),
    single,
    // The list is only stored once when both builds agree.
    multi: {
      ...multi,
      emptyClassesSameAsSingle: JSON.stringify(multiEmpty) === JSON.stringify(single.emptyClasses),
    },
  });
}

// ---------------------------------------------------------------- node

async function measureNode() {
  const init: Record<string, unknown[]> = {};
  const bench: Record<string, unknown> = {};
  for (const v of VARIANTS) {
    init[v] = [];
    for (let i = 0; i < 5; i++) {
      log(`node init ${v} #${i + 1}`);
      init[v].push(child(['scripts/node-child.ts', 'init', JSON.stringify({ variant: v })]));
    }
    log(`node bench ${v}`);
    bench[v] = child(['scripts/node-child.ts', 'bench', JSON.stringify({ variant: v, runs: 10 })]);
  }

  log('node tracker');
  const tracker = child([
    'scripts/node-child.ts',
    'tracker',
    JSON.stringify({ variant: 'single' }),
  ]);

  // Heap size (WebAssembly.Memory byteLength) after each of 200 runs.
  const traces: Record<string, unknown> = {};
  for (const memory of MEMORY_MODES) {
    log(`node heap trace bracket ${memory}`);
    const t = child<{ before: number; after: number[]; ms: number }>([
      'scripts/node-child.ts',
      'trace',
      JSON.stringify({ variant: 'single', caseName: 'bracket', memory, runs: 200 }),
    ]);
    traces[memory] = { ...t, ...heapTraceSummary(t.before, t.after) };
  }

  // Leak per run: used bytes after n1 and n2 runs, each in a fresh process.
  const n1 = 10;
  const n2 = 60;
  const leakRate: unknown[] = [];
  for (const caseName of ['box', 'bracket'] as CaseName[]) {
    for (const memory of MEMORY_MODES) {
      log(`node leak rate ${caseName} ${memory}`);
      const probe = (n: number) =>
        child<{ heapBytes: number; usedBytes: number }>([
          'scripts/node-child.ts',
          'leakprobe',
          JSON.stringify({ variant: 'single', caseName, memory, n }),
        ]);
      const a = probe(n1);
      const b = probe(n2);
      leakRate.push({
        case: caseName,
        memory,
        n1,
        usedBytesAtN1: a.usedBytes,
        n2,
        usedBytesAtN2: b.usedBytes,
        leakKiBPerRun: round((b.usedBytes - a.usedBytes) / (n2 - n1) / 1024, 1),
      });
    }
  }

  // What is in use right after init (no pipeline run yet), per build.
  const afterInit: Record<string, unknown> = {};
  for (const v of VARIANTS) {
    log(`node used bytes after init ${v}`);
    afterInit[v] = child([
      'scripts/node-child.ts',
      'leakprobe',
      JSON.stringify({ variant: v, caseName: 'box', memory: 'mitigated', n: 0 }),
    ]);
  }

  log('node recycle');
  const recycle = child(
    [
      'scripts/node-child.ts',
      'recycle',
      JSON.stringify({ variant: 'single', cycles: 8, runsPerCycle: 60, caseName: 'bracket' }),
    ],
    ['--expose-gc'],
  );

  return writeResult('node.json', {
    host: hostInfo(),
    init: Object.fromEntries(
      Object.entries(init).map(([v, rows]) => [
        v,
        {
          runs: rows,
          totalMs: summarize(rows.map((r) => (r as { totalMs: number }).totalMs)),
          runtimeInitMs: summarize(rows.map((r) => (r as { runtimeInitMs: number }).runtimeInitMs)),
        },
      ]),
    ),
    bench,
    memory: { afterInit, tracker, heapTraces: traces, leakRate, recycle },
  });
}

function heapTraceSummary(before: number, after: number[]) {
  const growthAtRun: number[] = [];
  let last = before;
  after.forEach((bytes, i) => {
    if (bytes !== last) growthAtRun.push(i + 1);
    last = bytes;
  });
  const at = (n: number) => round((after[n - 1] ?? NaN) / MiB, 2);
  return {
    beforeMiB: round(before / MiB, 2),
    afterRunMiB: { 1: at(1), 10: at(10), 50: at(50), 100: at(100), 200: at(200) },
    growthAtRun,
  };
}

// ---------------------------------------------------------------- browser

interface StartResult {
  mainThreadMs: number;
  report: InitReport;
  env: { crossOriginIsolated: boolean; hardwareConcurrency: number; userAgent: string };
}

async function start(page: Page, options: InitOptions): Promise<StartResult> {
  return page.evaluate((o) => window.spike.start(o), options);
}

async function measureBrowser() {
  log('vite build');
  await build({ root: SPIKE_DIR, logLevel: 'warn' });
  const server = await preview({ root: SPIKE_DIR, preview: { port: 4199, strictPort: false } });
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('preview server has no URL');
  const url = `${base}?manual=0`;
  log(`preview at ${base}`);

  // Minimal containers may lack Chromium's shared libraries; they can be
  // unpacked anywhere and passed to the browser process only.
  const extraLibs = process.env.SPIKE_BROWSER_LD_LIBRARY_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(extraLibs ? { env: { ...process.env, LD_LIBRARY_PATH: extraLibs } } : {}),
    // Software WebGL in the headless shell, so the render and screenshot work.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const results: Record<string, unknown> = { browserVersion: browser.version() };
  try {
    // Response headers the wasm is served with (cache policy, isolation).
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const wasmHeaders: Record<string, string> = {};
      page.on('response', (r) => {
        if (r.url().endsWith('.wasm')) Object.assign(wasmHeaders, r.headers());
      });
      await page.goto(url);
      const s = await start(page, { variant: 'single', load: 'streaming' });
      results.env = s.env;
      results.wasmResponseHeaders = wasmHeaders;
      await ctx.close();
    }

    // Cold start: a fresh browser context each time (empty HTTP and code
    // caches), then a warm start after a reload in the same context.
    const coldStart: unknown[] = [];
    for (const variant of VARIANTS) {
      for (const load of ['streaming', 'arraybuffer', 'glue'] as LoadMode[]) {
        for (let rep = 0; rep < 5; rep++) {
          log(`browser cold start ${variant}/${load} #${rep + 1}`);
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto(url);
          const cold = await start(page, { variant, load });
          await page.reload();
          const warm = await start(page, { variant, load });
          // Recycling by worker restart, same page: terminate, then start again.
          await page.evaluate(() => window.spike.stop());
          const restart = await start(page, { variant, load });
          coldStart.push({
            variant,
            load,
            rep,
            cold: { mainThreadMs: round(cold.mainThreadMs), ...roundAll(cold.report) },
            warm: { mainThreadMs: round(warm.mainThreadMs), ...roundAll(warm.report) },
            workerRestartMs: round(restart.mainThreadMs),
          });
          await ctx.close();
        }
      }
    }
    results.coldStart = coldStart;
    results.coldStartSummary = summarizeColdStart(coldStart as ColdRow[]);

    // Pipeline timings inside the worker, plus transfer and render on the page.
    const bench: unknown[] = [];
    for (const variant of VARIANTS) {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 650 } });
      const page = await ctx.newPage();
      await page.goto(url);
      await start(page, { variant, load: 'streaming' });
      for (const parallel of variant === 'multi' ? [false, true] : [false]) {
        for (const name of Object.keys(CASES) as CaseName[]) {
          log(`browser bench ${variant} ${name} parallel=${parallel}`);
          const options = { ...CASES[name], parallel };
          const runs = await page.evaluate(
            async ({ o, n }) => {
              const out = [];
              for (let i = 0; i < n; i++) out.push(await window.spike.run(o, i === n - 1));
              return out;
            },
            { o: options, n: 11 },
          );
          const [first, ...rest] = runs;
          const phase = (k: 'buildMs' | 'filletMs' | 'meshMs' | 'extractMs' | 'totalMs') =>
            summarize(rest.map((r) => r.timings[k]));
          bench.push({
            variant,
            case: name,
            parallel,
            stats: first!.stats,
            firstRun: roundAll(first!.timings),
            buildMs: phase('buildMs'),
            filletMs: phase('filletMs'),
            meshMs: phase('meshMs'),
            extractMs: phase('extractMs'),
            totalMs: phase('totalMs'),
            roundTripMs: summarize(rest.map((r) => r.roundTripMs)),
            // Only the last run renders; geometry upload plus one frame.
            renderMs: round(rest[rest.length - 1]!.renderMs ?? NaN),
          });
          if (name === 'bracket' && !parallel) {
            await page.screenshot({ path: `${RESULTS_DIR}bracket-${variant}.png` });
          }
        }
      }
      results.heapAfterBenchBytes = {
        ...(results.heapAfterBenchBytes as object),
        [variant]: await page.evaluate(() => window.spike.heap()),
      };
      await ctx.close();
    }
    results.bench = bench;

    // Heap traces in the worker: 200 bracket runs per memory mode, fresh worker each.
    const traces: unknown[] = [];
    for (const variant of VARIANTS) {
      for (const memory of MEMORY_MODES) {
        log(`browser heap trace ${variant} ${memory}`);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(url);
        await start(page, { variant, load: 'streaming' });
        const t: HeapTrace = await page.evaluate((o) => window.spike.heapTrace(o, 200), {
          ...CASES.bracket,
          parallel: false,
          memory,
        });
        traces.push({ variant, memory, ms: round(t.ms), ...heapTraceSummary(t.before, t.after) });
        await ctx.close();
      }
    }
    results.heapTraces = traces;
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
  return writeResult('browser.json', { host: hostInfo(), ...results });
}

type ColdRow = {
  variant: Variant;
  load: LoadMode;
  cold: Record<string, number | null>;
  warm: Record<string, number | null>;
  workerRestartMs: number;
};

function summarizeColdStart(rows: ColdRow[]) {
  const out: unknown[] = [];
  for (const variant of VARIANTS) {
    for (const load of ['streaming', 'arraybuffer', 'glue'] as LoadMode[]) {
      const sel = rows.filter((r) => r.variant === variant && r.load === load);
      const field = (which: 'cold' | 'warm', k: string) => {
        const values = sel
          .map((r) => r[which][k])
          .filter((x): x is number => typeof x === 'number');
        return values.length ? summarize(values).median : null;
      };
      const keys = [
        'mainThreadMs',
        'totalMs',
        'fetchMs',
        'compileMs',
        'fetchAndCompileMs',
        'instantiateMs',
        'runtimeInitMs',
      ];
      out.push({
        variant,
        load,
        medianOf: sel.length,
        cold: Object.fromEntries(keys.map((k) => [k, field('cold', k)])),
        warm: Object.fromEntries(keys.map((k) => [k, field('warm', k)])),
        workerRestartMs: summarize(sel.map((r) => r.workerRestartMs)).median,
      });
    }
  }
  return out;
}

function roundAll(o: object): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]),
  );
}

// ---------------------------------------------------------------- main

const sections = process.argv.slice(2);
const want = (s: string) => sections.length === 0 || sections.includes(s);
const t0 = performance.now();
if (want('audit')) log(`wrote ${await measureAudit()}`);
if (want('node')) log(`wrote ${await measureNode()}`);
if (want('browser')) log(`wrote ${await measureBrowser()}`);
// Last, so the spike bundle from the browser section's build is included.
if (want('sizes')) log(`wrote ${await measureSizes()}`);
log(`done in ${round((performance.now() - t0) / 1000, 0)} s`);
