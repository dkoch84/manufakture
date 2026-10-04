import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { nodeScriptEngine, quickjsWasmPath } from '../../../packages/script/src/node';
import { headersFor } from '../src/hosting/headers';
import { EXAMPLES, runExamples } from './script-examples';

// Determinism of scripted features across browsers (T7.2e; ADR 0010 decision 5): the example
// scripts (script-examples.ts) run in a dedicated module worker of this browser, under the
// production worker Content-Security-Policy, and every recorded host call, result and error must
// equal the same run in Node bit for bit. Every browser runs the same QuickJS .wasm, so this
// catches what is left: the host side of the binding (JSON, the codec), TypeScript erasure and
// its error positions, and a browser whose own stack or time behaviour reaches a script.
//
// The default run is Chromium only. With E2E_CROSS_BROWSER=1 the Firefox and WebKit projects run
// this spec too (playwright.config.ts); CI's `script-browsers` job does that on every push.
//
// The harness is bundled with Vite on the fly and served by a throwaway HTTP server on a free
// port, with the headers src/hosting/headers.ts gives each path; it needs nothing of the app.

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = 'assets/script-harness-worker.js';
const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};
const PAGE =
  '<!doctype html><meta charset="utf-8"><title>script harness</title><script type="module" src="/main.js"></script>';
const main = (other: string) => `window.__violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI));
const worker = new Worker('/${WORKER}?other=' + encodeURIComponent(${JSON.stringify(other)}), { type: 'module' });
worker.onmessage = (e) => { window.__harness = e.data; };
worker.onerror = (e) => { window.__harness = { ok: false, error: 'worker error: ' + (e.message || 'unknown') }; };
window.__probes = {};
for (const [name, url] of [['policy', '/assets/probe-worker.js'], ['none', '/plain/probe.js']]) {
  const probe = new Worker(url + '?other=' + encodeURIComponent(${JSON.stringify(other)}));
  probe.onmessage = (e) => { window.__probes[name] = e.data; };
  probe.onerror = (e) => { window.__probes[name] = 'error: ' + (e.message || 'unknown'); };
}
`;
/**
 * A worker that tries to reach the other origin. Served under the worker policy and, as the
 * control that shows the probe can tell, with no policy at all.
 */
const PROBE = `const other = new URL(self.location.href).searchParams.get('other');
fetch(other, { mode: 'no-cors' }).then(() => postMessage('allowed'), () => postMessage('refused'));
`;

let outDir = '';
let server: Server | null = null;
/** Another origin, answering anything with CORS allowed: only the policy can keep a worker out. */
let otherServer: Server | null = null;
let origin = '';
let other = '';
let expected: unknown;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  outDir = await mkdtemp(join(tmpdir(), 'mfk-script-harness-'));
  await build({
    configFile: false,
    root: here,
    logLevel: 'warn',
    base: '/',
    // The .wasm is a dependency of packages/script, not of this app: point the import there.
    resolve: {
      alias: [
        {
          find: /^@jitl\/quickjs-wasmfile-release-sync\/wasm(?=\?|$)/,
          replacement: quickjsWasmPath(),
        },
      ],
    },
    build: {
      outDir,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: join(here, 'script-harness.worker.ts'),
        output: {
          entryFileNames: WORKER,
          chunkFileNames: 'assets/[name]-worker-chunk-[hash].js',
        },
      },
    },
  });
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const respond = (body: string | Buffer, type: string, policy = true) => {
      const headers: Record<string, string> = { ...headersFor(path), 'Content-Type': type };
      if (!policy) delete headers['Content-Security-Policy'];
      res.writeHead(200, headers);
      res.end(body);
    };
    if (path === '/assets/probe-worker.js') return respond(PROBE, TYPES['.js']!);
    if (path === '/plain/probe.js') return respond(PROBE, TYPES['.js']!, false);
    if (path === '/') return respond(PAGE, TYPES['.html']!);
    if (path === '/main.js') return respond(main(other), TYPES['.js']!);
    const file = normalize(join(outDir, path));
    if (!file.startsWith(outDir) || TYPES[extname(file)] === undefined) {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (body) => respond(body, TYPES[extname(file)]!),
      () => res.writeHead(404).end(),
    );
  });
  otherServer = createServer((_req, res) => {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.end('reached');
  });
  const listen = (s: Server) =>
    new Promise<string>((resolve) =>
      s.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
      ),
    );
  origin = await listen(server);
  other = await listen(otherServer);
  expected = await runExamples(await nodeScriptEngine());
});

test.afterAll(async () => {
  for (const s of [server, otherServer]) {
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
  if (outDir !== '') await rm(outDir, { recursive: true, force: true });
});

// The policy is the point here: the worker runs under WORKER_CSP, the page under DOCUMENT_CSP.
test.use({ bypassCSP: false });

test('the example scripts give bit-identical results in this browser and in Node', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  // The reference itself: the examples ran, and the limits ended the runs they should.
  const reference = expected as Record<
    string,
    { log?: unknown[]; outcome?: { ok: boolean; error?: { code: string; line?: number } } }
  >;
  expect(Object.keys(reference)).toEqual(EXAMPLES.map((e) => e.name));
  expect(reference['box']!.log!.map((c) => (c as [string])[0])).toEqual([
    'sketch',
    'extrude',
    'edges',
    'fillet',
  ]);
  expect(reference['spiral']!.log).toHaveLength(46);
  expect(reference['numerics']!.outcome!.ok).toBe(true);
  expect(reference['TypeScript error position']!.outcome!.error).toMatchObject({
    code: 'runtime',
    line: 5,
  });
  expect(reference['deep recursion']!.outcome!.error!.code).toBe('stack-limit');
  expect(reference['time limit']!.outcome!.error!.code).toBe('timeout');
  expect(reference['value limit']!.outcome!.error!.code).toBe('value-too-large');

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => (window as unknown as { __harness?: unknown }).__harness, null, {
    timeout: 90_000,
  });
  const got = await page.evaluate(
    () =>
      (
        window as unknown as {
          __harness: { ok: boolean; connect?: string; results?: unknown; error?: string };
        }
      ).__harness,
  );
  expect(got.error, `${browserName}: the harness failed`).toBeUndefined();
  // The worker policy keeps the worker where scripts run to its own origin; the same request
  // from a worker without the policy goes through, so the refusal is the policy's doing.
  expect(got.connect).toBe('refused');
  await page.waitForFunction(
    () => Object.keys((window as unknown as { __probes: object }).__probes).length === 2,
  );
  expect(await page.evaluate(() => (window as unknown as { __probes: unknown }).__probes)).toEqual({
    policy: 'refused',
    none: 'allowed',
  });
  expect(got.results, `${browserName} differs from Node`).toEqual(expected);
  // The worker ran under its policy without tripping it, and the page under its own.
  const violations = await page.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );
  expect(violations).toEqual([]);
});
