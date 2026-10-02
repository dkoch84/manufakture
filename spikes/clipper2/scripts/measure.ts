// The T5.0a measurements, in one run:
//
//   pnpm --filter @manufakture/spike-clipper2 measure
//
// Runs under Vitest (the sketch package's extensionless imports need Vite's
// resolver) as one long test, prints every table, and writes
// results/measure.json. RUNS=n scales the timing repetitions (default 1: 20 runs
// for small cases, 10 for 10k-vertex ones, 5 for the 50-ring pocket).

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import {
  type Engine,
  type WasmLoad,
  loadWasm,
  tsEngine,
  wasm64Engine,
  wasmDEngine,
  zCallbackCalls,
} from '../src/engines.ts';
import { type Case, allCases, bracket, circle10k, flower10k } from '../src/fixtures.ts';
import {
  type Flattened,
  type Shape,
  type TaggedPath,
  flatten,
  pathsArea,
  vertexCount,
} from '../src/geometry.ts';
import {
  deviationOfElements,
  deviationOfPaths,
  exactOffsetSamples,
  refitVsPolyline,
} from '../src/metrics.ts';
import {
  type Element,
  type RefitOptions,
  arcSweep,
  grblArcCheck,
  refitTagged,
  refitUntagged,
} from '../src/refit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Installed package directories (clipper2-ts exports only its ESM entry, so no require.resolve). */
const pkgDir = (name: string) => path.join(here, '..', 'node_modules', name);
const RUNS = Number(process.env.RUNS ?? 1);
const SCALE = 1e4;
const ARC_TOL = 0.001;
const REFIT_TOL = 0.002;
const FLATTEN = [0.001, 0.01];
const OPTIONS = { scale: SCALE, arcTol: ARC_TOL };

const results: Record<string, unknown> = {};
const r = (v: number, d = 3) => Number(v.toPrecision(d));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

function table(title: string, rows: Record<string, unknown>[]): void {
  results[title] = rows;
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) =>
    typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(3)) : String(v);
  const lines = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${cols.map((c) => cell(row[c])).join(' | ')} |`),
  ];
  console.log(`\n### ${title}\n\n${lines.join('\n')}`);
}

const allLoops = (shapes: readonly Shape[]): Shape => ({ loops: shapes.flatMap((s) => s.loops) });

function runsFor(c: Case): number {
  const base = c.name === 'pocket' ? 5 : c.polygon ? 10 : 20;
  return Math.max(1, Math.round(base * RUNS));
}

function time<T>(n: number, f: () => T): { first: number; median: number; value: T } {
  let t = performance.now();
  let value = f();
  const first = performance.now() - t;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    t = performance.now();
    value = f();
    times.push(performance.now() - t);
  }
  return { first, median: n > 0 ? median(times) : first, value };
}

const untaggedCount = (paths: readonly TaggedPath[]) =>
  paths.reduce((s, p) => s + p.z.filter((z) => z === 0).length, 0);

// -------------------------------------------------------------------------------------------

test('T5.0a measurements', async () => {
  const wasm = await loadWasm();
  const engines: Engine[] = [tsEngine, wasm64Engine(wasm.module), wasmDEngine(wasm.module)];

  results.environment = {
    node: process.version,
    cpu: os.cpus()[0]?.model,
    platform: `${os.platform()} ${os.release()}`,
    'clipper2-ts': JSON.parse(
      await readFile(path.join(pkgDir('clipper2-ts'), 'package.json'), 'utf8'),
    ).version,
    'clipper2-wasm': JSON.parse(
      await readFile(path.join(pkgDir('clipper2-wasm'), 'package.json'), 'utf8'),
    ).version,
    scale: SCALE,
    arcTol: ARC_TOL,
    refitTol: REFIT_TOL,
    runs: RUNS,
  };
  console.log('environment', results.environment);

  // Warm the JIT for every engine before anything is timed.
  for (const c of [bracket(), flower10k()]) {
    const fl = flatten(allLoops(c.shapes), 0.001);
    for (const e of engines) for (let i = 0; i < 5; i++) e.offset(fl.paths, -3, OPTIONS);
  }

  await licenses();
  await loadCost();

  // Offsets: time, size and correctness, per case, flattening tolerance, offset and engine.
  const offsetRows: Record<string, unknown>[] = [];
  const agreeRows: Record<string, unknown>[] = [];
  const refitRows: Record<string, unknown>[] = [];
  const zRows: Record<string, unknown>[] = [];
  for (const c of allCases()) {
    const shape = allLoops(c.shapes);
    const ref = allLoops(c.reference ?? c.shapes);
    for (const ftol of c.polygon ? [0] : FLATTEN) {
      const fl = flatten(shape, ftol || 1);
      if (c.name === 'pocket') {
        pocketRings(c, fl, ref, ftol, engines, offsetRows, refitRows);
        continue;
      }
      for (const d of c.deltas) {
        const exact = exactOffsetSamples(ref, d, 0.05);
        const outputs: Record<string, TaggedPath[]> = {};
        for (const e of engines) {
          const t = time(runsFor(c), () =>
            e.offset(fl.paths, d, { scale: SCALE, arcTol: ARC_TOL }),
          );
          const out = t.value;
          outputs[e.name] = out;
          const dev = deviationOfPaths(out, ref, d, exact);
          const exactArea = c.exactArea?.(d);
          offsetRows.push({
            case: c.name,
            flatten: ftol || 'polygon',
            delta: d,
            engine: e.name,
            'in vertices': vertexCount(fl.paths),
            'out vertices': vertexCount(out),
            loops: out.length,
            'first ms': r(t.first),
            'median ms': r(t.median),
            'area err mm2': exactArea === undefined ? '' : r(pathsArea(out) - exactArea),
            'hausdorff mm': r(dev.hausdorff),
            'untagged pts': untaggedCount(out),
          });
        }
        agreeRows.push(agreement(c.name, ftol, d, outputs));
        zRows.push(zTags(c.name, ftol, d, fl, outputs.ts!));
        refitRows.push(...refits(c.name, ftol, d, fl, outputs.ts!, ref, exact));
      }
    }
  }
  table('Offsets (scale 1e4, round joins, arcTol 0.001 mm)', offsetRows);
  table('Engines agree (TS against WASM output)', agreeRows);
  table('Z tags through the offset', zRows);
  table('Arc refit (TS output, refit tol 0.002 mm, 3-decimal Grbl check)', refitRows);

  degenerateArcs();
  scaleSweep(engines);
  await memory(wasm);
  await bundleSize();

  // Formatted like the rest of the repository, so `prettier --check .` stays clean.
  const { format } = await import('prettier');
  await writeFile(
    path.join(here, '..', 'results', 'measure.json'),
    await format(JSON.stringify(results), { parser: 'json' }),
  );
  expect(offsetRows.length).toBeGreaterThan(0);
});

// Licenses ------------------------------------------------------------------------------------

async function licenses(): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const pkg of ['clipper2-ts', 'clipper2-wasm']) {
    const dir = pkgDir(pkg);
    const meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const files = await readdir(dir);
    const licenseFile = files.find((f) => /^licen[cs]e/i.test(f));
    const text = licenseFile ? await readFile(path.join(dir, licenseFile), 'utf8') : '';
    rows.push({
      package: `${pkg}@${meta.version}`,
      'package.json license': meta.license,
      'license file': licenseFile ?? '(none shipped)',
      'license file first line': text.split('\n')[0] ?? '',
    });
  }
  table('Licenses (read from the installed packages)', rows);
}

// Load and bundle cost ------------------------------------------------------------------------

async function loadCost(): Promise<void> {
  const probe = path.join(here, 'load-probe.ts');
  const rows: Record<string, unknown>[] = [];
  for (const which of ['ts', 'wasm'] as const) {
    const samples: Record<string, number>[] = [];
    for (let i = 0; i < 7; i++) {
      const w = new Worker(probe, { workerData: { which } });
      samples.push(
        await new Promise((resolve, reject) => {
          w.on('message', resolve);
          w.on('error', reject);
        }),
      );
      await w.terminate();
    }
    const m = (k: string) => r(median(samples.map((s) => s[k]!)));
    rows.push({
      library: which === 'ts' ? 'clipper2-ts' : 'clipper2-wasm',
      'import/read ms': m('load'),
      'compile ms': m('compile'),
      'instantiate + first offset ms': m('instantiateAndFirstCall'),
      'total ms': m('total'),
    });
  }
  table('Cold load in a fresh worker thread (Node, median of 7)', rows);
}

const sizes = (buf: Buffer) => ({
  raw: buf.length,
  gzip: gzipSync(buf, { level: 9 }).length,
  brotli: brotliCompressSync(buf).length,
});

async function bundleSize(): Promise<void> {
  const { build } = await import('vite');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clipper2-bundle-'));
  const rows: Record<string, unknown>[] = [];
  try {
    const tsEntry = path.join(dir, 'ts.js');
    await writeFile(
      tsEntry,
      `export { ClipperOffset, Clipper64, PolyTree64, FillRule, ClipType, JoinType, EndType } from ${JSON.stringify(path.join(pkgDir('clipper2-ts'), 'dist', 'index.js'))};\n`,
    );
    const outDir = path.join(dir, 'out');
    await build({
      root: dir,
      logLevel: 'silent',
      configFile: false,
      build: {
        outDir,
        minify: true,
        emptyOutDir: true,
        lib: { entry: tsEntry, formats: ['es'], fileName: 'out' },
      },
    });
    let total = Buffer.alloc(0);
    for (const f of await readdir(outDir)) {
      if (/\.m?js$/.test(f)) total = Buffer.concat([total, await readFile(path.join(outDir, f))]);
    }
    rows.push({ what: 'clipper2-ts (offset + booleans, tree-shaken)', ...sizes(total) });
    // The glue ships minified; built in Vite's lib mode it would inline the .wasm as base64.
    const glue = await readFile(path.join(pkgDir('clipper2-wasm'), 'dist', 'es', 'clipper2z.js'));
    rows.push({ what: 'clipper2-wasm glue (dist/es/clipper2z.js, as shipped)', ...sizes(glue) });
    const wasmFile = await readFile(
      path.join(pkgDir('clipper2-wasm'), 'dist', 'es', 'clipper2z.wasm'),
    );
    rows.push({ what: 'clipper2-wasm clipper2z.wasm', ...sizes(wasmFile) });
    const unpacked = await dirSize(pkgDir('clipper2-ts'));
    rows.push({
      what: 'clipper2-ts installed package (all files)',
      raw: unpacked,
      gzip: '',
      brotli: '',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  table('Bundle size (bytes; Vite 8 build, minified)', rows);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

// Agreement and Z tags -------------------------------------------------------------------------

function agreement(
  name: string,
  ftol: number,
  d: number,
  outputs: Record<string, TaggedPath[]>,
): Record<string, unknown> {
  const ts = outputs.ts!;
  const w = outputs['wasm-64']!;
  // Same vertex sets? Compare sorted coordinates (paths may start elsewhere).
  const key = (paths: TaggedPath[]) =>
    paths
      .flatMap((p) =>
        Array.from({ length: p.xy.length / 2 }, (_, i) => `${p.xy[2 * i]},${p.xy[2 * i + 1]}`),
      )
      .sort();
  const a = key(ts);
  const b = new Set(key(w));
  const shared = a.filter((k) => b.has(k)).length;
  return {
    case: name,
    flatten: ftol || 'polygon',
    delta: d,
    'ts vertices': a.length,
    'wasm vertices': b.size,
    'identical vertices': shared,
    'area diff mm2': r(pathsArea(ts) - pathsArea(w)),
  };
}

function zTags(
  name: string,
  ftol: number,
  d: number,
  fl: Flattened,
  out: TaggedPath[],
): Record<string, unknown> {
  // Re-run with the TS Z callback to see what it adds.
  const before = zCallbackCalls;
  const withCb = tsEngine.offset(fl.paths, d, { scale: SCALE, arcTol: ARC_TOL, zCallback: true });
  const total = vertexCount(out);
  return {
    case: name,
    flatten: ftol || 'polygon',
    delta: d,
    'out vertices': total,
    'untagged (no callback)': untaggedCount(out),
    'callback calls': zCallbackCalls - before,
    'untagged (with callback)': untaggedCount(withCb),
  };
}

// Refit ---------------------------------------------------------------------------------------

type Refit = (p: TaggedPath, o: RefitOptions) => Element[];

/** Run a refit twice: as shipped (tiny and Grbl-unsafe arcs turned into lines), and without that step. */
function runRefit(out: TaggedPath[], f: Refit) {
  const stats = { demoted: 0 };
  const t = time(3, () => {
    stats.demoted = 0;
    return out.map((p) => f(p, { stats }));
  });
  const raw = out.map((p) => f(p, { demote: false }));
  return { loops: t.value, raw, demoted: stats.demoted, ms: t.median };
}

const arcsIn = (loops: Element[][]) =>
  loops.flat().filter((e): e is Element & { kind: 'arc' } => e.kind === 'arc');

function refitStats(
  method: string,
  run: ReturnType<typeof runRefit>,
  out: TaggedPath[],
  ref: Shape,
  d: number,
  exact: ReturnType<typeof exactOffsetSamples>,
): Record<string, unknown> {
  const { loops } = run;
  const segs = vertexCount(out);
  const els = loops.reduce((s, l) => s + l.length, 0);
  const arcs = arcsIn(loops);
  const grbl = arcs.map((a) => grblArcCheck(a));
  const before = arcsIn(run.raw).map((a) => grblArcCheck(a));
  return {
    method,
    segments: segs,
    elements: els,
    arcs: arcs.length,
    reduction: r(segs / Math.max(1, els)),
    'vs polyline mm': r(refitVsPolyline(out, loops)),
    'hausdorff vs exact mm': r(deviationOfElements(loops, ref, d, exact).hausdorff),
    'grbl max dr mm': r(Math.max(0, ...grbl.map((g) => g.diff))),
    'grbl fails': grbl.filter((g) => !g.ok).length,
    'arcs to G1': run.demoted,
    'grbl travel fails without that': before.filter((g) => !g.travelOk).length,
    'refit ms': r(run.ms),
  };
}

function refits(
  name: string,
  ftol: number,
  d: number,
  fl: Flattened,
  out: TaggedPath[],
  ref: Shape,
  exact: ReturnType<typeof exactOffsetSamples>,
): Record<string, unknown>[] {
  const head = { case: name, flatten: ftol || 'polygon', delta: d };
  const tagTol = (ftol || 0) + ARC_TOL + 0.0005;
  const u = runRefit(out, (p, o) => refitUntagged(p, REFIT_TOL, o));
  const t = runRefit(out, (p, o) => refitTagged(p, fl, d, REFIT_TOL, tagTol, o));
  // The same, on output whose untagged intersections the TS Z callback has tagged.
  const cbOut = tsEngine.offset(fl.paths, d, { ...OPTIONS, zCallback: true });
  const z = runRefit(cbOut, (p, o) => refitTagged(p, fl, d, REFIT_TOL, tagTol, o));
  return [
    { ...head, ...refitStats('untagged', u, out, ref, d, exact) },
    { ...head, ...refitStats('tagged', t, out, ref, d, exact) },
    { ...head, ...refitStats('tagged + Z callback', z, cbOut, ref, d, exact) },
  ];
}

/**
 * The review's case: arcs so short that, written with 3 decimals, Grbl runs them as
 * full circles. Tagged refit with the Z callback on the 10,000-vertex outlines, at
 * the default tag tolerance (0.0015 mm) and at 0.0025 mm, with and without turning them into lines.
 */
function degenerateArcs(): void {
  const rows: Record<string, unknown>[] = [];
  for (const c of [flower10k(), circle10k()]) {
    const shape = allLoops(c.shapes);
    const fl = flatten(shape, 1);
    for (const d of c.deltas) {
      const out = tsEngine.offset(fl.paths, d, { ...OPTIONS, zCallback: true });
      // 0.0015 is the default for polygon input (flatten 0 + arcTol + 0.0005), the review's case.
      for (const tagTol of [ARC_TOL + 0.0005, ARC_TOL + 0.0015]) {
        for (const demote of [false, true]) {
          const loops = out.map((p) => refitTagged(p, fl, d, REFIT_TOL, tagTol, { demote }));
          const arcs = arcsIn(loops);
          const checks = arcs.map((a) => grblArcCheck(a));
          const chords = arcs.map((a) =>
            Math.hypot(
              Math.round(a.b[0] * 1000) / 1000 - Math.round(a.a[0] * 1000) / 1000,
              Math.round(a.b[1] * 1000) / 1000 - Math.round(a.a[1] * 1000) / 1000,
            ),
          );
          rows.push({
            case: c.name,
            delta: d,
            tagTol,
            'tiny arcs to G1': demote ? 'yes' : 'no',
            arcs: arcs.length,
            'smallest rounded chord mm': r(Math.min(Infinity, ...chords)),
            'smallest sweep rad': r(Math.min(Infinity, ...arcs.map((a) => Math.abs(arcSweep(a))))),
            'full circles in Grbl': checks.filter(
              (g) => !g.travelOk && Math.abs(Math.abs(g.travel) - 2 * Math.PI) < 0.5,
            ).length,
            'grbl travel fails': checks.filter((g) => !g.travelOk).length,
          });
        }
      }
    }
  }
  table('Degenerate arcs (tagged + Z callback, 3 decimals)', rows);
}

// Pocket rings ----------------------------------------------------------------------------------

function pocketRings(
  c: Case,
  fl: Flattened,
  ref: Shape,
  ftol: number,
  engines: Engine[],
  offsetRows: Record<string, unknown>[],
  refitRows: Record<string, unknown>[],
): void {
  const o = OPTIONS;
  const last = c.deltas[c.deltas.length - 1]!;
  const exactRings = c.deltas.map((d) => exactOffsetSamples(ref, d, 0.1));
  /** Worst Hausdorff distance over the rings, and how many rings are not empty. */
  const ringStats = (rings: TaggedPath[][]) => ({
    worst: Math.max(
      ...rings.map(
        (ring, i) => deviationOfPaths(ring, ref, c.deltas[i]!, exactRings[i]!).hausdorff,
      ),
    ),
    nonEmpty: rings.filter((ring) => ring.length > 0).length,
  });
  for (const e of engines) {
    // Direct: every ring from the source. Incremental: each ring from the previous one
    // (timed once: it is the slow way, measured to show why not).
    const direct = time(runsFor(c), () => c.deltas.map((d) => e.offset(fl.paths, d, o)));
    const step = c.deltas[1]! - c.deltas[0]!;
    const incremental = time(0, () => {
      const rings = [e.offset(fl.paths, c.deltas[0]!, o)];
      for (let i = 1; i < c.deltas.length; i++) rings.push(e.offset(rings[i - 1]!, step, o));
      return rings;
    });
    for (const [mode, t] of [
      ['50 rings, each from the source', direct],
      ['50 rings, each from the previous ring', incremental],
    ] as const) {
      const rings = t.value;
      const stats = e.name === 'ts' ? ringStats(rings) : undefined;
      offsetRows.push({
        case: `${c.name}: ${mode}`,
        flatten: ftol,
        delta: `-3 .. ${last}`,
        engine: e.name,
        'in vertices': vertexCount(fl.paths),
        'out vertices': rings.reduce((s, ring) => s + vertexCount(ring), 0),
        loops: rings.reduce((s, ring) => s + ring.length, 0),
        'first ms': r(t.first),
        'median ms': r(t.median),
        'area err mm2': '',
        'hausdorff mm': stats ? `worst ring ${r(stats.worst)} (${stats.nonEmpty} rings)` : '',
        'untagged pts': rings.reduce((s, ring) => s + untaggedCount(ring), 0),
      });
    }
  }
  // Refit every ring of the direct TS run (tags index the source vertices).
  const plain = c.deltas.map((d) => tsEngine.offset(fl.paths, d, o));
  const withCb = c.deltas.map((d) => tsEngine.offset(fl.paths, d, { ...o, zCallback: true }));
  for (const method of ['untagged', 'tagged', 'tagged + Z callback'] as const) {
    const rings = method === 'tagged + Z callback' ? withCb : plain;
    const tot = { segs: 0, els: 0, arcs: 0, g1: 0, before: 0, fails: 0, ms: 0 };
    let vsPoly = 0;
    let haus = 0;
    let grblMax = 0;
    c.deltas.forEach((d, i) => {
      const out = rings[i]!;
      const run = runRefit(out, (p, ro) =>
        method !== 'untagged'
          ? refitTagged(p, fl, d, REFIT_TOL, ftol + ARC_TOL + 0.0005, ro)
          : refitUntagged(p, REFIT_TOL, ro),
      );
      const s = refitStats(method, run, out, ref, d, exactRings[i]!);
      tot.segs += s.segments as number;
      tot.els += s.elements as number;
      tot.arcs += s.arcs as number;
      tot.g1 += s['arcs to G1'] as number;
      tot.before += s['grbl travel fails without that'] as number;
      tot.fails += s['grbl fails'] as number;
      tot.ms += run.ms;
      vsPoly = Math.max(vsPoly, s['vs polyline mm'] as number);
      haus = Math.max(haus, s['hausdorff vs exact mm'] as number);
      grblMax = Math.max(grblMax, s['grbl max dr mm'] as number);
    });
    refitRows.push({
      case: `${c.name} (50 rings)`,
      flatten: ftol,
      delta: `-3 .. ${last}`,
      method,
      segments: tot.segs,
      elements: tot.els,
      arcs: tot.arcs,
      reduction: r(tot.segs / tot.els),
      'vs polyline mm': vsPoly,
      'hausdorff vs exact mm': haus,
      'grbl max dr mm': grblMax,
      'grbl fails': tot.fails,
      'arcs to G1': tot.g1,
      'grbl travel fails without that': tot.before,
      'refit ms': r(tot.ms),
    });
  }
}

// Integer scale ---------------------------------------------------------------------------------

function translate(shape: Shape, dx: number, dy: number): Shape {
  return {
    loops: shape.loops.map((l) =>
      l.map((c) =>
        c.kind === 'line'
          ? { ...c, a: [c.a[0] + dx, c.a[1] + dy] as const, b: [c.b[0] + dx, c.b[1] + dy] as const }
          : { ...c, c: [c.c[0] + dx, c.c[1] + dy] as const },
      ),
    ),
  };
}

function scaleSweep(engines: Engine[]): void {
  const rows: Record<string, unknown>[] = [];
  const base = allLoops(bracket().shapes);
  for (const [where, shape, extent] of [
    ['near origin', base, 100],
    ['at (1900, 1900) mm', translate(base, 1900, 1900), 2000],
  ] as const) {
    const fl = flatten(shape, 0.001);
    const exact = exactOffsetSamples(shape, -3, 0.05);
    for (const scale of [1e2, 1e3, 1e4, 1e5, 1e6, 1e8, 1e10, 1e12, 1e13]) {
      // InflatePathsD takes the scale as decimal places, at most 8.
      for (const e of engines.filter((x) => x.name !== 'wasm-d' || scale <= 1e8)) {
        let row: Record<string, unknown>;
        try {
          const t = time(5, () => e.offset(fl.paths, -3, { scale, arcTol: ARC_TOL }));
          row = {
            'hausdorff mm': r(deviationOfPaths(t.value, shape, -3, exact).hausdorff),
            'median ms': r(t.median),
            'out vertices': vertexCount(t.value),
            error: '',
          };
        } catch (err) {
          row = {
            'hausdorff mm': '',
            'median ms': '',
            'out vertices': '',
            error: String(err).slice(0, 80),
          };
        }
        rows.push({ where, scale, engine: e.name, 'max coordinate': extent * scale, ...row });
      }
    }
  }
  table('Integer scale (bracket, inward 3 mm, flatten 0.001, arcTol 0.001)', rows);
}

// Memory ----------------------------------------------------------------------------------------

/** The address malloc returns for a 1 MiB block: moves up when the heap leaks. */
function heapTop(w: WasmLoad): number {
  const p = w.malloc(1 << 20);
  w.free(p);
  return p;
}

async function memory(w: WasmLoad): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  const fl = flatten(allLoops(bracket().shapes), 0.001);
  const o = { scale: SCALE, arcTol: ARC_TOL };
  for (const e of [wasm64Engine(w.module), wasmDEngine(w.module)]) {
    for (let i = 0; i < 20; i++) e.offset(fl.paths, -3, o);
    const mem0 = w.memory.buffer.byteLength;
    const top0 = heapTop(w);
    for (let i = 0; i < 1000; i++) e.offset(fl.paths, -3, o);
    rows.push({
      what: `${e.name}: 1,000 offsets, everything deleted`,
      'memory before': mem0,
      'memory after': w.memory.buffer.byteLength,
      'heap top moved (bytes)': heapTop(w) - top0,
    });
  }
  // The control: the same calls, forgetting to delete the result.
  const fresh = await loadWasm();
  const m = fresh.module;
  const mem0 = fresh.memory.buffer.byteLength;
  const top0 = heapTop(fresh);
  for (let i = 0; i < 1000; i++) {
    const input = new m.Paths64();
    for (const p of fl.paths) {
      const flat = new BigInt64Array((p.xy.length / 2) * 3);
      for (let k = 0; k < p.xy.length / 2; k++) {
        flat[3 * k] = BigInt(Math.round(p.xy[2 * k]! * SCALE));
        flat[3 * k + 1] = BigInt(Math.round(p.xy[2 * k + 1]! * SCALE));
      }
      const path64 = new m.Path64();
      path64.assign(flat);
      input.push_back(path64);
      path64.delete();
    }
    m.InflatePaths64(input, -3 * SCALE, m.JoinType.Round, m.EndType.Polygon, 2, ARC_TOL * SCALE);
    input.delete(); // the result is not deleted
  }
  rows.push({
    what: 'wasm-64: 1,000 offsets, result not deleted (control)',
    'memory before': mem0,
    'memory after': fresh.memory.buffer.byteLength,
    'heap top moved (bytes)': heapTop(fresh) - top0,
  });
  // clipper2-ts: plain JS objects; heap after a forced GC.
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < 20; i++) tsEngine.offset(fl.paths, -3, o);
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 1000; i++) tsEngine.offset(fl.paths, -3, o);
  gc();
  rows.push({
    what: 'ts: 1,000 offsets (JS heap after gc)',
    'memory before': h0,
    'memory after': process.memoryUsage().heapUsed,
    'heap top moved (bytes)': '',
  });
  table('Memory over 1,000 calls (bracket, inward 3 mm)', rows);
}
