// The measurement run: `pnpm --filter @manufakture/spike-t7-0c-quickjs measure` (vitest, so the
// kernel's extensionless TypeScript resolves). Writes results/*.json; docs/spikes/T7.0c-quickjs.md
// is written from them. ONLY=sizes,node,browsers runs some parts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createNodeService } from '@manufakture/kernel/node';
import * as prettier from 'prettier';
import { expect, it } from 'vitest';
import { flatten, type DeterminismOutput } from '../src/determinism';
import { newScriptContext } from '../src/sandbox';
import { runTasks } from '../src/tasks';
import { instantiateSync, VARIANT_NAMES, VARIANT_PACKAGES } from '../src/variants';
import { BROWSERS, buildPage, runInBrowser, type BrowserRun } from './browser';
import {
  brotli,
  bundleSize,
  eraseWith,
  linesKept,
  nonErasableCases,
  positionsKept,
  SAMPLE,
} from './erasure';
import { nodeEnv, wasmFile } from './node-env';

const SPIKE_DIR = new URL('..', import.meta.url).pathname;
const RESULTS = join(SPIKE_DIR, 'results');
const require = createRequire(import.meta.url);
const only = new Set((process.env.ONLY ?? 'sizes,node,browsers').split(','));

async function write(name: string, data: unknown): Promise<void> {
  mkdirSync(RESULTS, { recursive: true });
  const path = join(RESULTS, name);
  const config = (await prettier.resolveConfig(path)) ?? {};
  writeFileSync(path, await prettier.format(JSON.stringify(data), { ...config, filepath: path }));
  console.log(`wrote ${path}`);
}

/** A package's directory, found from its main entry (not every package exports package.json). */
function packageDir(resolver: NodeJS.Require, name: string): string {
  let dir = dirname(resolver.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === name) return dir;
    } catch {
      // No package.json here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package directory for ${name}`);
    dir = parent;
  }
}

/** License fields of an installed package; `from` resolves a transitive one from its dependent. */
function pkgInfo(name: string, from?: string) {
  const resolver = from ? createRequire(packageDir(require, from) + '/') : require;
  const dir = packageDir(resolver, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string;
    license: string;
  };
  const file = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find((f) => existsSync(join(dir, f)));
  const firstLine = (f: string) => readFileSync(join(dir, f), 'utf8').trim().split('\n')[0]!.trim();
  const licenseFile = file ? `${file}: ${firstLine(file)}` : '(no license file)';
  return { name, version: pkg.version, license: pkg.license, licenseFile };
}

function host() {
  return {
    cpu: cpus()[0]?.model.trim(),
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    measuredAt: new Date().toISOString(),
  };
}

it('measures sizes, erasure and licenses', async () => {
  if (!only.has('sizes')) return;
  const wasm = VARIANT_NAMES.map((name) => {
    const bytes = readFileSync(wasmFile(name));
    return {
      variant: name,
      package: VARIANT_PACKAGES[name],
      rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
      brotliBytes: brotli(bytes),
    };
  });
  const bundles = [];
  for (const entry of ['quickjs-host', 'ts-blank-space', 'sucrase'])
    bundles.push(await bundleSize(entry));

  // Erasure: time, positions, and whether QuickJS parses the output as a module.
  const mod = await instantiateSync('quickjs-sync', await nodeEnv.compile('quickjs-sync'));
  const erasure = [];
  for (const tool of ['ts-blank-space', 'sucrase'] as const) {
    const times: number[] = [];
    let code = '';
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      code = eraseWith(tool, SAMPLE).code;
      times.push(performance.now() - t0);
    }
    const rt = mod.newRuntime();
    const ctx = newScriptContext(rt);
    const parsed = ctx.evalCode(code, 'script.js', { type: 'module' });
    const parses = !parsed.error;
    (parsed.error ?? parsed.value).dispose();
    ctx.dispose();
    rt.dispose();
    times.sort((a, b) => a - b);
    erasure.push({
      tool,
      firstMs: Math.round(times[times.length - 1]! * 100) / 100,
      medianMs: Math.round(times[30]! * 1000) / 1000,
      sampleChars: SAMPLE.length,
      linesKept: linesKept(SAMPLE, code),
      columnsKept: positionsKept(SAMPLE, code),
      quickjsParsesOutput: parses,
    });
  }
  const licenses = [
    pkgInfo('quickjs-emscripten-core'),
    pkgInfo('@jitl/quickjs-ffi-types', 'quickjs-emscripten-core'),
    ...Object.values(VARIANT_PACKAGES).map((n) => pkgInfo(n)),
    pkgInfo('ts-blank-space'),
    pkgInfo('typescript', 'ts-blank-space'),
    pkgInfo('sucrase'),
  ];
  const sizes = { host: host(), wasm, bundles, erasure, nonErasable: nonErasableCases(), licenses };
  console.log(JSON.stringify(sizes, null, 1));
  await write('sizes.json', sizes);
});

it('measures in Node', async () => {
  if (!only.has('node')) return;
  const results = await runTasks(nodeEnv, ['all'], () => createNodeService());
  const { determinism, ...rest } = results;
  await write('node.json', { host: host(), results: rest });
  // The raw outputs are large; they go to dist/ (git-ignored) for the browser part to compare.
  mkdirSync(join(SPIKE_DIR, 'dist'), { recursive: true });
  writeFileSync(join(SPIKE_DIR, 'dist', 'determinism-node.json'), JSON.stringify(determinism));
});

function compare(outputs: Record<string, DeterminismOutput>) {
  const names = Object.keys(outputs);
  const flat = Object.fromEntries(names.map((n) => [n, flatten(outputs[n]!)]));
  const total = flat[names[0]!]!.size;
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = flat[names[i]!]!;
      const b = flat[names[j]!]!;
      const diff = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
      // Both values NaN with different bit patterns (QuickJS gives 7ff8..., x86 hosts fff8...).
      const isNaNBits = (v: string | undefined) =>
        v !== undefined && /^[0-9a-f]{16}$/.test(v) && /^[7f]ff[89a-f]/.test(v);
      const nanOnly = diff.filter((k) => isNaNBits(a.get(k)) && isNaNBits(b.get(k))).length;
      const byGroup: Record<string, number> = {};
      for (const k of diff) {
        const g = k.replace(/\[\d+\]$/, '');
        byGroup[g] = (byGroup[g] ?? 0) + 1;
      }
      pairs.push({
        a: names[i],
        b: names[j],
        differing: diff.length,
        nanOnly,
        byGroup,
        examples: diff.slice(0, 4).map((k) => ({ key: k, a: a.get(k), b: b.get(k) })),
      });
    }
  }
  return { entries: total, pairs };
}

it('measures in Chromium, Firefox and WebKit', async () => {
  if (!only.has('browsers')) return;
  await buildPage();
  const runs: BrowserRun[] = [];
  const loads: Record<string, unknown[]> = {};
  for (const browser of BROWSERS) {
    // Cold loads, each in a fresh browser: three per browser.
    loads[browser] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runInBrowser(browser, ['load']);
      loads[browser].push(r.ok ? r.results?.load : r.error);
    }
    const run = await runInBrowser(browser, ['all']);
    console.log(browser, run.ok ? 'ok' : run.error);
    delete run.log;
    // QuickJS's own memory limit alone: in its own page, since it may crash it.
    const unbounded = await runInBrowser(browser, ['memoryUnbounded']);
    console.log(browser, 'memoryUnbounded', unbounded.ok ? 'ok' : unbounded.error);
    if (run.results) {
      run.results.memoryUnbounded = unbounded.ok
        ? unbounded.results?.memoryUnbounded
        : { failed: unbounded.error, log: unbounded.log };
    }
    runs.push(run);
  }
  const outputs: Record<string, DeterminismOutput> = {};
  try {
    const node = JSON.parse(
      readFileSync(join(SPIKE_DIR, 'dist', 'determinism-node.json'), 'utf8'),
    ) as Record<string, DeterminismOutput>;
    for (const [k, v] of Object.entries(node)) outputs[`node:${k}`] = v;
  } catch {
    // Node part not run.
  }
  for (const run of runs) {
    const det = run.results?.determinism as Record<string, DeterminismOutput> | undefined;
    if (det && !('failed' in det))
      for (const [k, v] of Object.entries(det)) outputs[`${run.browser}:${k}`] = v;
    if (run.results) delete run.results.determinism;
  }
  await write('browsers.json', { host: host(), loads, runs });
  await write('determinism.json', compare(outputs));
  expect(runs.length).toBe(3);
});
