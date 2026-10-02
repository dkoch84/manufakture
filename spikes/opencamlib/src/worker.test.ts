// The OCL build loaded in a worker: a Node worker thread (always), and a browser module worker in
// headless Chromium (when Playwright's browser can start here; see README.md). Both must give
// the same points as the TypeScript cutter.

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { meshes, minZ } from './cases.ts';
import { DropCutter } from './dropcutter.ts';
import { bounds, rasterLines } from './geometry.ts';
import { CACHE } from './meshes.ts';
import { OCL_DIR, oclBuilt } from './ocl.ts';
import { round, writeResult } from './results.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLING = 0.1;

async function inputs() {
  const { bracket } = await meshes(); // also fills the cache the workers read
  return {
    mesh: bracket,
    lines: rasterLines(bounds(bracket), 0.5, 4),
    floor: minZ(bracket),
  };
}

function maxDz(points: Float64Array, z: Float64Array): number {
  let worst = 0;
  for (let i = 0; i < z.length; i++) worst = Math.max(worst, Math.abs(points[i * 3 + 2]! - z[i]!));
  return worst;
}

describe.runIf(oclBuilt())('OCL in a worker', () => {
  it('runs in a Node worker thread', async () => {
    const { lines, floor } = await inputs();
    const worker = new NodeWorker(new URL('./node-worker.ts', import.meta.url), {
      workerData: { cache: CACHE, lines, sampling: SAMPLING, floor },
    });
    const reply = await new Promise<{ loadMs: number; points: Float64Array; ts: Float64Array }>(
      (resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      },
    );
    await worker.terminate();
    const dz = maxDz(reply.points, reply.ts);
    writeResult('worker-node', {
      loadMs: round(reply.loadMs),
      points: reply.ts.length,
      maxAbsDz: dz,
    });
    expect(reply.ts.length).toBeGreaterThan(1000);
    expect(dz).toBeLessThan(1e-9);
  });

  it('runs in a browser module worker, the .wasm fetched as its own asset', async () => {
    const require = createRequire(join(HERE, '..', '..', '..', 'apps', 'web', 'package.json'));
    let chromium: Chromium;
    try {
      ({ chromium } = require('@playwright/test') as { chromium: Chromium });
    } catch {
      console.log('skipped: @playwright/test is not installed in apps/web');
      return;
    }
    const { mesh, lines, floor } = await inputs();
    const server = await serve();
    const port = (server.address() as { port: number }).port;
    const requests: string[] = [];
    let browser;
    try {
      browser = await chromium.launch({
        env: {
          ...process.env,
          ...(process.env.PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH
            ? { LD_LIBRARY_PATH: process.env.PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH }
            : {}),
        },
      });
    } catch (e) {
      server.close();
      console.log(`skipped: Chromium did not start (${(e as Error).message.split('\n')[0]})`);
      return;
    }
    try {
      const page = await browser.newPage();
      page.on('request', (r: { url(): string }) => requests.push(new URL(r.url()).pathname));
      await page.goto(`http://127.0.0.1:${port}/blank`);
      const reply = await page.evaluate(
        async ({ lines, sampling, floor }: EvalArgs) => {
          const w = new Worker('/src/browser/worker.js', { type: 'module' });
          const r = new Promise<{ loadMs: number; runMs: number; points: number[] }>(
            (resolve, reject) => {
              w.onmessage = (e) => {
                const d = e.data as { loadMs: number; runMs: number; points: Float64Array };
                resolve({ loadMs: d.loadMs, runMs: d.runMs, points: Array.from(d.points) });
              };
              w.onerror = (e) => reject(new Error(e.message));
            },
          );
          w.postMessage({ lines, sampling, floor });
          return await r;
        },
        { lines, sampling: SAMPLING, floor },
      );
      const points = Float64Array.from(reply.points);
      const dc = new DropCutter(mesh, { kind: 'ball', diameter: 6.35 });
      const ts = new Float64Array(points.length / 3);
      for (let i = 0; i < ts.length; i++)
        ts[i] = dc.drop(points[i * 3]!, points[i * 3 + 1]!, floor);
      const dz = maxDz(points, ts);
      writeResult('worker-browser', {
        browser: browser.version(),
        loadMs: round(reply.loadMs),
        runMs: round(reply.runMs),
        points: ts.length,
        maxAbsDz: dz,
        requests: [...new Set(requests)],
      });
      expect(ts.length).toBeGreaterThan(1000);
      expect(dz).toBeLessThan(1e-9);
      expect(requests).toContain('/out/ocl.wasm');
    } finally {
      await browser.close();
      server.close();
    }
  });
});

/** The few Playwright types the probe uses (the spike does not depend on @playwright/test). */
interface Chromium {
  launch(options: { env: NodeJS.ProcessEnv }): Promise<Browser>;
}
interface Browser {
  version(): string;
  close(): Promise<void>;
  newPage(): Promise<Page>;
}
interface Page {
  on(event: 'request', listener: (r: { url(): string }) => void): void;
  goto(url: string): Promise<unknown>;
  evaluate<A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R>;
}
interface EvalArgs {
  lines: number[][];
  sampling: number;
  floor: number;
}

const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};

/** Serves /out (the build), /cache (meshes) and /src (the worker) from the spike folder. */
function serve(): Promise<Server> {
  const roots: Record<string, string> = {
    out: OCL_DIR,
    cache: CACHE,
    src: HERE,
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>ocl</title>');
      return;
    }
    const [, root, ...rest] = path.split('/');
    const base = roots[root ?? ''];
    if (!base || rest.some((s) => s === '..')) {
      res.writeHead(404).end();
      return;
    }
    readFile(join(base, ...rest)).then(
      (body) =>
        res
          .writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
          .end(body),
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
