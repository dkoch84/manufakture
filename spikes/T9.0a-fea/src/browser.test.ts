// The same pipeline in a browser worker: gmsh-wasm and the TypeScript solver, on the kernel's STEP
// files, for the accuracy cases and the scaling sizes the Node run found (results/scaling-node.json).
// BROWSER (chromium | firefox | webkit, default chromium) picks the engine; see README.md for the
// no-root browser setup.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { RESULTS, solids, STEP_DIR, writeResult } from './node-env.ts';

const SPIKE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SPIKE, 'dist', 'page');
const GMSH = join(SPIKE, 'node_modules', '@loumalouomega', 'gmsh-wasm', 'dist');
const ENGINE = (process.env.BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

/**
 * Resident memory of the browser's processes, from /proc: the largest single process (the
 * renderer, where the worker runs) and the sum over all of them (an upper bound: shared pages count
 * once per process).
 */
function browserRss(pattern: RegExp): { max: number; sum: number } {
  let max = 0,
    sum = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!pattern.test(cmd)) continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (!m) continue;
      const kb = Number(m[1]);
      max = Math.max(max, kb);
      sum += kb;
    } catch {
      // The process ended between listing and reading.
    }
  }
  return { max: Math.round(max / 1024), sum: Math.round(sum / 1024) };
}

const PROCESS: Record<typeof ENGINE, RegExp> = {
  chromium: /chrome-headless-shell|chromium/,
  firefox: /firefox/,
  webkit: /webkit|WPE|MiniBrowser/i,
};

test(`FEA in ${ENGINE}`, async () => {
  await solids(); // writes dist/step if missing
  const { build } = await import('vite');
  await build({
    root: join(SPIKE, 'src', 'browser'),
    configFile: false,
    logLevel: 'warn',
    worker: { format: 'es' },
    build: { outDir: DIST, emptyOutDir: true, target: 'es2022', reportCompressedSize: false },
  });

  const node = JSON.parse(readFileSync(join(RESULTS, 'scaling-node.json'), 'utf8')) as {
    runs: { solid: string; target: number; sizeMax: number; preconditioner: string }[];
  };
  const only = (process.env.PRECONDITIONERS ?? 'amg').split(',');
  // SCALING="bracket:1000000:1.365,..." (solid:target:sizeMax, AMG) replaces the Node run's sizes.
  const custom = process.env.SCALING?.split(',').map((item) => {
    const [solid, target, sizeMax] = item.split(':');
    return {
      solid: solid!,
      target: Number(target),
      sizeMax: Number(sizeMax),
      preconditioner: 'amg',
    };
  });
  const scaling =
    custom ??
    node.runs
      .filter((r) => only.includes(r.preconditioner))
      .map(({ solid, target, sizeMax, preconditioner }) => ({
        solid,
        target,
        sizeMax,
        preconditioner,
      }));
  const plan = {
    accuracy: process.env.ACCURACY !== '0',
    threads: Number(process.env.GMSH_THREADS ?? 1),
    scaling,
  };

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    let file: string | null = null;
    let body: string | Buffer | null = null;
    if (path === '/plan.json') body = JSON.stringify(plan);
    else if (path.startsWith('/gmsh/')) file = join(GMSH, path.slice(6));
    else if (path.startsWith('/step/')) file = join(STEP_DIR, path.slice(6));
    else file = join(DIST, path === '/' ? 'index.html' : path);
    if (body === null && (file === null || !existsSync(file))) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type':
        body !== null ? 'application/json' : (TYPES[extname(file!)] ?? 'application/octet-stream'),
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    res.end(body ?? readFileSync(file!));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const require = createRequire(join(SPIKE, '..', '..', 'apps', 'web', 'package.json'));
  const pw = require('@playwright/test');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const libs = process.env.BROWSER_LIBS ?? '/tmp/chromelibs/usr/lib';
  if (existsSync(libs)) env.LD_LIBRARY_PATH = libs;
  if (!env.FONTCONFIG_FILE && existsSync('/tmp/chromelibs/fonts.conf'))
    env.FONTCONFIG_FILE = '/tmp/chromelibs/fonts.conf';
  const launch: Record<string, unknown> = { env, timeout: 60_000 };
  if (ENGINE === 'webkit' && process.env.WEBKIT_EXECUTABLE)
    launch.executablePath = process.env.WEBKIT_EXECUTABLE;
  const browser = await pw[ENGINE].launch(launch);
  const log: string[] = [];
  // Peak resident memory per run, sampled every 100 ms while the worker reports that run in progress.
  const peaks: Record<string, { maxMiB: number; sumMiB: number }> = {};
  let current: string | null = null;
  const idle = browserRss(PROCESS[ENGINE]);
  const sampler = setInterval(() => {
    if (current === null) return;
    const r = browserRss(PROCESS[ENGINE]);
    const p = (peaks[current] ??= { maxMiB: 0, sumMiB: 0 });
    p.maxMiB = Math.max(p.maxMiB, r.max);
    p.sumMiB = Math.max(p.sumMiB, r.sum);
  }, 100);
  try {
    const page = await browser.newPage();
    page.on('console', (m: { text(): string }) => {
      const text = m.text();
      const pm = /^__progress (start|end) (.+)$/.exec(text);
      if (pm) current = pm[1] === 'start' ? pm[2]! : null;
      else log.push(text);
    });
    page.on('pageerror', (e: Error) => log.push(`pageerror: ${e.message}`));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result, null, {
      timeout: 3_000_000,
      polling: 1000,
    });
    const result = await page.evaluate(() => (window as unknown as { __result: unknown }).__result);
    writeResult(process.env.OUT ?? `browser-${ENGINE}`, {
      browser: `${ENGINE} ${browser.version()}`,
      loadAverage: (await import('node:os')).loadavg(),
      plan,
      log: log.slice(0, 50),
      rssIdleMiB: idle,
      rssPeakMiB: peaks,
      ...result,
    });
    console.log(JSON.stringify(result, null, 1).slice(0, 3000));
    expect((result as { error?: string }).error).toBeUndefined();
  } finally {
    clearInterval(sampler);
    await browser.close();
    server.close();
  }
});
