// Measurement driver for the T0.3 kernel wrapper spike. Node only.
//
//   node scripts/measure.ts [sizes] [audit] [node] [memory] [maintenance]
//
// With no arguments every section runs. Each section writes one JSON file in
// results/. `maintenance` needs network access (npm registry, GitHub API).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { CANDIDATES } from '../src/candidates/index.ts';
import type { CandidateName, RunOptions } from '../src/candidates/types.ts';
import type { BuildName } from '../src/loaders.ts';
import { child, hostInfo, packageDir, round, summarize, writeResult, KiB } from './lib.ts';

const sections = process.argv.slice(2);
const want = (name: string) => sections.length === 0 || sections.includes(name);

const BUILDS: BuildName[] = ['libcascade', 'replicad-opencascadejs', 'occt-wasm'];
const resolve = (spec: string) => fileURLToPath(import.meta.resolve(spec));

function compressed(path: string) {
  const bytes = readFileSync(path);
  return {
    raw: bytes.length,
    gzip9: gzipSync(bytes, { level: 9 }).length,
    brotli11: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length,
  };
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

// ---------------------------------------------------------------------------

async function sizes() {
  const files: Record<string, ReturnType<typeof compressed>> = {
    'libcascade: opencascade_single.wasm': compressed(resolve('libcascade/single/wasm')),
    'libcascade: opencascade_single.js': compressed(resolve('libcascade/single')),
    'replicad-opencascadejs: replicad_single.wasm': compressed(
      resolve('replicad-opencascadejs/wasm'),
    ),
    'replicad-opencascadejs: replicad_single.js': compressed(resolve('replicad-opencascadejs')),
    'occt-wasm: occt-wasm.wasm': compressed(resolve('occt-wasm/dist/occt-wasm.wasm')),
    'occt-wasm: occt-wasm.js (glue)': compressed(resolve('occt-wasm/dist/occt-wasm.js')),
    'occt-wasm: index.js (TS wrapper)': compressed(join(packageDir('occt-wasm'), 'dist/index.js')),
  };
  // The wrapper libraries' ESM entry points and the chunks they import. Not
  // tree-shaken: an upper bound on the JS each one adds.
  const esmTotal = (pkg: string, filter: (f: string) => boolean) => {
    const dist = join(packageDir(pkg), 'dist');
    const list: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (filter(p)) list.push(p);
      }
    };
    walk(dist);
    let raw = 0;
    let brotli11 = 0;
    for (const f of list) {
      const c = compressed(f);
      raw += c.raw;
      brotli11 += c.brotli11;
    }
    return { files: list.length, raw, brotli11 };
  };
  const wrapperJs = {
    replicad: esmTotal('replicad', (f) => f.endsWith('.js') && !f.endsWith('.umd.cjs')),
    brepjs: esmTotal('brepjs', (f) => f.endsWith('.js')),
  };
  // Bytes on disk of each package this spike adds (libcascade was already there).
  const installed = {
    ...Object.fromEntries(
      ['libcascade', 'replicad', 'replicad-opencascadejs', 'brepjs', 'occt-wasm'].map((p) => [
        p,
        dirBytes(packageDir(p)),
      ]),
    ),
    'opentype.js': dirBytes(packageDir('opentype.js', 'replicad')),
    flatbush: dirBytes(packageDir('flatbush', 'replicad')),
  };
  // Size of each library's public surface: named exports of the main entry,
  // and for occt-wasm the methods of its one kernel class.
  const { OcctKernel } = await import('occt-wasm');
  const apiSurface = {
    replicadExports: Object.keys(await import('replicad')).length,
    brepjsExports: Object.keys(await import('brepjs')).length,
    occtWasmKernelMethods: Object.getOwnPropertyNames(OcctKernel.prototype).filter(
      (n) => n !== 'constructor',
    ).length,
  };
  const path = await writeResult('sizes.json', {
    host: hostInfo(),
    files,
    wrapperJs,
    installed,
    apiSurface,
  });
  console.log(`sizes -> ${path}`);
}

async function audit() {
  const out: Record<string, unknown> = {};
  for (const build of BUILDS) {
    const r = child<{ emptyClasses: string[] } & Record<string, unknown>>([
      'scripts/destructor-audit.ts',
      build,
    ]);
    // libcascade's full list of 2102 is in the T0.2 results; keep the others.
    out[build] = build === 'libcascade' ? { ...r, emptyClasses: undefined } : r;
    console.log(`audit ${build}: ${String(r.emptyDestructorClasses)} of ${String(r.classes)}`);
  }
  const path = await writeResult('destructor-audit.json', { host: hostInfo(), builds: out });
  console.log(`audit -> ${path}`);
}

const CONFIGS: Record<string, RunOptions> = {
  model: { mesh: false, history: false },
  scenario: { mesh: true, history: false },
  history: { mesh: false, history: true },
  fine: { mesh: true, history: false, fine: true },
};
const CAN_MESH: Record<CandidateName, boolean> = {
  'own-libcascade': true,
  replicad: true,
  'replicad-libcascade': false,
  'occt-wasm': true,
  brepjs: true,
};

async function node() {
  const SAMPLES = 5;
  const init: Record<string, unknown> = {};
  for (const build of BUILDS) {
    const samples = Array.from({ length: SAMPLES }, () =>
      child<Record<string, number>>(['scripts/node-child.ts', 'init', JSON.stringify({ build })]),
    );
    const keys = Object.keys(samples[0]!).filter((k) => k !== 'heapBytesAfterInit');
    init[build] = {
      ...Object.fromEntries(keys.map((k) => [k, summarize(samples.map((s) => s[k]!))])),
      heapBytesAfterInit: samples[0]!.heapBytesAfterInit,
    };
    console.log(`init ${build}`);
  }
  const imports: Record<string, unknown> = {};
  for (const library of ['replicad', 'brepjs', 'occt-wasm']) {
    const samples = Array.from(
      { length: SAMPLES },
      () => child<{ importMs: number }>(['scripts/import-time.ts', library]).importMs,
    );
    imports[library] = summarize(samples);
  }

  const timing: unknown[] = [];
  for (const candidate of CANDIDATES) {
    for (const [config, options] of Object.entries(CONFIGS)) {
      if (options.mesh && !CAN_MESH[candidate]) continue;
      const r = child<Record<string, unknown>>([
        'scripts/node-child.ts',
        'timing',
        JSON.stringify({ candidate, options, runs: 20 }),
      ]);
      timing.push({ config, ...r });
      console.log(`timing ${candidate} ${config}`);
    }
  }

  const calls: unknown[] = [];
  for (const candidate of CANDIDATES) {
    calls.push(
      child(['scripts/node-child.ts', 'calls', JSON.stringify({ candidate, n: 500, repeats: 5 })]),
    );
    console.log(`calls ${candidate}`);
  }

  const replicadBoxes = child(['scripts/node-child.ts', 'replicadBoxes', '{"n":500,"runs":20}']);
  console.log('replicad box idioms');

  const path = await writeResult('node.json', {
    host: hostInfo(),
    init,
    imports,
    timing,
    calls,
    replicadBoxes,
  });
  console.log(`node -> ${path}`);
}

async function memory() {
  const LOW = 10;
  const HIGH = 60;
  type Leak = { usedBytes: number; heapBytes: number; liveHandles: number | null };
  const rows: unknown[] = [];
  for (const candidate of CANDIDATES) {
    for (const config of ['model', 'scenario'] as const) {
      const options = CONFIGS[config]!;
      if (options.mesh && !CAN_MESH[candidate]) continue;
      for (const mode of ['sync', 'gc'] as const) {
        const probe = (n: number) =>
          child<Leak>(
            ['scripts/node-child.ts', 'leak', JSON.stringify({ candidate, options, n, mode })],
            ['--expose-gc'],
          );
        const low = probe(LOW);
        const high = probe(HIGH);
        rows.push({
          candidate,
          config,
          mode,
          usedBytesAfter: { [LOW]: low.usedBytes, [HIGH]: high.usedBytes },
          heapBytesAfter: { [LOW]: low.heapBytes, [HIGH]: high.heapBytes },
          liveHandlesAfter: high.liveHandles,
          leakKiBPerRun: round((high.usedBytes - low.usedBytes) / (HIGH - LOW) / KiB, 1),
        });
        console.log(`memory ${candidate} ${config} ${mode}`);
      }
    }
  }
  const path = await writeResult('memory.json', {
    host: hostInfo(),
    method:
      'bytes in use after N runs (allocator probe, 64 KiB blocks) in fresh processes; leak per run = (used after 60 - used after 10) / 50. sync: no yield between runs; gc: gc() and three event-loop turns after each run.',
    rows,
  });
  console.log(`memory -> ${path}`);
}

async function maintenance() {
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const gh = async (path: string) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
    return { json: (await res.json()) as unknown, link: res.headers.get('link') ?? '' };
  };
  /** Count items of a paginated list with per_page=1: the last page number. */
  const countList = async (path: string) => {
    const { json, link } = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=1`);
    const last = /[?&]page=(\d+)>; rel="last"/.exec(link);
    return last ? Number(last[1]) : (json as unknown[]).length;
  };
  const npm = async (name: string) => {
    const doc = (await (await fetch(`https://registry.npmjs.org/${name}`)).json()) as {
      time: Record<string, string>;
      'dist-tags': { latest: string };
      license?: string;
      versions: Record<string, { license?: string }>;
    };
    const versions = Object.entries(doc.time).filter(([k]) => k !== 'created' && k !== 'modified');
    const last90 = versions.filter(([, t]) => t >= since).length;
    const majors = new Set(versions.map(([v]) => v.split('.')[0])).size;
    const downloads = (await (
      await fetch(`https://api.npmjs.org/downloads/point/last-month/${name}`)
    ).json()) as { downloads?: number };
    return {
      latest: doc['dist-tags'].latest,
      license: doc.versions[doc['dist-tags'].latest]?.license ?? doc.license,
      versions: versions.length,
      majorVersions: majors,
      releasesLast90Days: last90,
      created: doc.time.created,
      lastPublish: versions
        .map(([, t]) => t)
        .sort()
        .at(-1),
      downloadsLastMonth: downloads.downloads ?? null,
    };
  };
  const repos: Record<string, string> = {
    brepjs: 'andymai/brepjs',
    'occt-wasm': 'andymai/occt-wasm',
    replicad: 'sgenoud/replicad',
    libcascade: 'taucad/opencascade.js',
  };
  const out: Record<string, unknown> = {};
  for (const [pkg, repo] of Object.entries(repos)) {
    const { json } = await gh(`repos/${repo}`);
    const r = json as Record<string, unknown>;
    out[pkg] = {
      repo,
      npm: await npm(pkg),
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssuesAndPrs: r.open_issues_count,
      createdAt: r.created_at,
      pushedAt: r.pushed_at,
      license: (r.license as { spdx_id?: string } | null)?.spdx_id ?? null,
      contributors: await countList(`repos/${repo}/contributors?anon=1`),
      commitsLast90Days: await countList(`repos/${repo}/commits?since=${since}`),
    };
    console.log(`maintenance ${pkg}`);
  }
  for (const pkg of ['replicad-opencascadejs']) out[pkg] = { npm: await npm(pkg) };
  const path = await writeResult('maintenance.json', {
    fetchedAt: new Date().toISOString(),
    window: { since },
    packages: out,
  });
  console.log(`maintenance -> ${path}`);
}

if (want('sizes')) await sizes();
if (want('audit')) await audit();
if (want('node')) await node();
if (want('memory')) await memory();
if (want('maintenance')) await maintenance();
