// Node against Chromium: the same documents (each fixture as opened, after its story batches, and
// at points of its long run) regenerated in Node by the session's host and in headless Chromium by
// the app's own regen worker, then compared on mesh hashes, name tables, feature results and the
// kernel's exact measurements (summary.ts). Anything that differs is listed with the difference.
//
// The page (src/browser/) is built with Vite into dist/page and served to Playwright from an HTTP
// server on 127.0.0.1 (a secure context: crypto.subtle, COOP/COEP as the app sends them in
// development). A route on https://spike.test runs only as the failing control: the text worker
// started by the regen worker does not load through it. Playwright comes from apps/web; without Chromium's system
// libraries, unpack them and set BROWSER_LIBS (default /tmp/chromelibs/usr/lib) and
// FONTCONFIG_FILE (see README.md).
//
// Writes results/browser.json.

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyCommand,
  parseDocument,
  serialize,
  type ManufaktureDocument,
} from '../../../packages/core/src/index';
import {
  FIXTURES,
  engraveBatch,
  fixtureDocument,
  longRunBatch,
  storyBatches,
  type Batch,
  type FixtureName,
} from './fixtures';
import { nodeHost, type NodeHost } from './host';
import { nodeSummary } from './node-summary';
import { round, SCRATCH, SPIKE_DIR, writeResult } from './results';
import { compareMath, mathProbe } from './mathprobe';
import { compareSummaries, memberMeshDifferences, type Summary } from './summary';

const DIST = join(SCRATCH, 'page');
const ORIGIN = 'https://spike.test';
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
};

function apply(doc: ManufaktureDocument, batch: Batch): ManufaktureDocument {
  const r = applyCommand(doc, batch.command);
  if (!r.ok) throw new Error(`${batch.label}: ${r.error.message}`);
  return r.value.document;
}

/** The documents compared: each fixture as opened, after its story, and two long-run edits. */
function stages(name: FixtureName): { key: string; doc: ManufaktureDocument }[] {
  const out: { key: string; doc: ManufaktureDocument }[] = [];
  let doc = fixtureDocument(name);
  out.push({ key: `${name}/opened`, doc });
  if (name === 'bracket') {
    doc = apply(doc, engraveBatch('MFK-1'));
    out.push({ key: `${name}/engraved`, doc });
  }
  let story = doc;
  for (const make of storyBatches(name).slice(name === 'bracket' ? 1 : 0)) {
    story = apply(story, make(story));
  }
  out.push({ key: `${name}/story`, doc: story });
  for (const i of [7, 500]) {
    out.push({ key: `${name}/long-${i}`, doc: apply(doc, longRunBatch(name, doc, i)) });
  }
  return out;
}

/** What a library load gives: the serialized text, parsed back. */
function roundTrip(doc: ManufaktureDocument): { text: string; doc: ManufaktureDocument } {
  const text = serialize(doc);
  const parsed = parseDocument(JSON.parse(text));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { text, doc: parsed.value.document };
}

async function buildPage(): Promise<void> {
  const { build } = await import('vite');
  await build({
    root: join(SPIKE_DIR, 'src', 'browser'),
    configFile: false,
    logLevel: 'warn',
    // As apps/web/vite.config.ts: module workers, Manifold's glue served as it is.
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['manifold-3d'] },
    build: { outDir: DIST, emptyOutDir: true, target: 'es2022', reportCompressedSize: false },
  });
}

interface BrowserOutput {
  key: string;
  ok: boolean;
  error?: string;
  summary?: Summary;
  ms?: { workerReady: number; regenWall: number; regenEngine: number };
}

interface Chromium {
  launch(options: object): Promise<{
    version(): string;
    newPage(): Promise<{
      on(event: 'console', listener: (m: { text(): string }) => void): void;
      route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
      goto(url: string): Promise<unknown>;
      waitForFunction(fn: () => unknown, arg: null, options: object): Promise<unknown>;
      evaluate<T>(fn: () => T): Promise<T>;
    }>;
    close(): Promise<void>;
  }>;
}
interface Route {
  request(): { url(): string };
  fulfill(options: {
    status: number;
    body: string | Buffer;
    headers?: Record<string, string>;
  }): Promise<void>;
}

/** The answer to one request of the page: the built files, plus the inputs. */
function respond(
  path: string,
  inputs: string,
): { status: number; body: string | Buffer; type: string } {
  if (path === '/inputs.json') return { status: 200, body: inputs, type: 'application/json' };
  const file = join(DIST, path === '/' ? 'index.html' : path);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    return { status: 404, body: 'not found', type: 'text/plain' };
  }
  return {
    status: 200,
    body: readFileSync(file),
    type: TYPES[extname(file)] ?? 'application/octet-stream',
  };
}

const HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cache-control': 'no-store',
};

/**
 * Serve the page to Chromium and collect its reply. `http`: a server on 127.0.0.1 on a port the
 * system picks (a secure context, as localhost is). `route`: a Playwright route on
 * https://spike.test with no port at all, which the first run used: a worker started by a worker
 * (regen's text worker) does not go through the route, so text fails there (see the report).
 */
async function runChromium(inputs: { key: string; text: string }[], serve: 'http' | 'route') {
  const require = createRequire(join(SPIKE_DIR, '..', '..', 'apps', 'web', 'package.json'));
  const { chromium } = require('@playwright/test') as { chromium: Chromium };
  const libs = process.env.BROWSER_LIBS ?? '/tmp/chromelibs/usr/lib';
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (existsSync(libs)) env.LD_LIBRARY_PATH = libs;
  if (!env.FONTCONFIG_FILE && existsSync('/tmp/chromelibs/fonts.conf')) {
    env.FONTCONFIG_FILE = '/tmp/chromelibs/fonts.conf';
  }
  const body = JSON.stringify(inputs);
  const requests: string[] = [];
  let server: Server | null = null;
  let origin = ORIGIN;
  if (serve === 'http') {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      requests.push(path);
      const r = respond(path, body);
      res.writeHead(r.status, { ...HEADERS, 'content-type': r.type });
      res.end(r.body);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const browser = await chromium.launch({ env, timeout: 60_000 });
  const log: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => log.push(m.text()));
    if (serve === 'route') {
      await page.route(`${ORIGIN}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        const r = respond(path, body);
        return route.fulfill({
          status: r.status,
          body: r.body,
          headers: { ...HEADERS, 'content-type': r.type },
        });
      });
    }
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result, null, {
      timeout: 1_800_000,
      polling: 500,
    });
    const result = await page.evaluate(
      () =>
        (window as unknown as { __result: unknown }).__result as {
          ok: boolean;
          error?: string;
          userAgent: string;
          isolated: boolean;
          secure: boolean;
          math: Record<string, string[]>;
          outputs: BrowserOutput[];
        },
    );
    return { version: browser.version(), log, requests: [...new Set(requests)], ...result };
  } finally {
    await browser.close();
    server?.close();
  }
}

let host: NodeHost;
beforeAll(async () => {
  host = await nodeHost();
});

describe('Node and Chromium regenerate the same documents', () => {
  it('compares mesh hashes, name tables, feature results and measurements', async () => {
    const t = performance.now();
    await buildPage();
    const buildMs = performance.now() - t;

    const inputs: { key: string; text: string }[] = [];
    const node: Record<string, { summary: Summary; regenMs: number }> = {};
    for (const name of FIXTURES) {
      for (const { key, doc } of stages(name)) {
        const { text, doc: loaded } = roundTrip(doc);
        inputs.push({ key, text });
        node[key] = await nodeSummary({ ...host }, loaded);
        // Regenerated twice in Node: Node against itself, so a difference below is the browser's.
        const again = await nodeSummary({ ...host }, loaded);
        expect(compareSummaries(node[key]!.summary, again.summary), key).toEqual([]);
      }
    }

    const chromium = await runChromium(inputs, 'http');
    expect(chromium.ok, chromium.error).toBe(true);
    const rows = chromium.outputs.map((b) => {
      const n = node[b.key]!;
      const differences =
        b.ok && b.summary ? compareSummaries(n.summary, b.summary) : [`browser failed: ${b.error}`];
      return {
        key: b.key,
        identical: differences.length === 0,
        differences,
        memberMeshes: b.summary ? memberMeshDifferences(n.summary, b.summary) : [],
        bodies: n.summary.bodies.length,
        triangles: n.summary.bodies.reduce((s, x) => s + x.triangles, 0),
        members: n.summary.members.reduce((s, m) => s + m.count, 0),
        names: n.summary.names.split('\n').length,
        nodeRegenMs: round(n.regenMs),
        chromiumRegenMs: b.ms ? round(b.ms.regenWall) : null,
        chromiumWorkerReadyMs: b.ms ? round(b.ms.workerReady) : null,
      };
    });
    const math = compareMath(mathProbe(), chromium.math);

    // The first harness: the same page through a Playwright route, for the engraved bracket only.
    const routed = await runChromium(
      inputs.filter((i) => i.key === 'bracket/engraved'),
      'route',
    );
    const routedSketch = routed.outputs[0]?.summary?.features['part#1']?.find(
      (f) => f.id === 'sketch#3',
    );

    writeResult('browser', {
      chromium: chromium.version,
      userAgent: chromium.userAgent,
      secureContext: chromium.secure,
      crossOriginIsolated: chromium.isolated,
      pageBuildMs: round(buildMs),
      requests: chromium.requests,
      rows,
      math,
      routeHarness: {
        requests: routed.requests,
        textSketch: routedSketch ?? null,
      },
      log: chromium.log.slice(-50),
    });
    // Every feature built on both sides, and every body's mesh, names and measurements agree.
    for (const r of rows) {
      const solid = r.differences.filter(
        (d) => !/^(memberMeshes|bodies\[[^\]]+\]\.bodyKey)/.test(d),
      );
      expect(solid, r.key).toEqual([]);
    }
  });
});
