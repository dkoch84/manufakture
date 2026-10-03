// Every number in docs/spikes/T6.5a-framing.md. Run from the repository root:
//   pnpm --filter @manufakture/spike-framing measure
// or `node scripts/measure.ts` in this folder. Prints Markdown tables and writes
// results/measure.json. Knobs (environment):
//   ONLY=node,kernel,browser   parts to run (default all)
//   RUNS=n                     fresh processes per cold measurement (default 5; kernel: 3)
//   FRAMES=n                   frames per viewport measurement (default 60)
//   PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH  unpacked Chromium libraries, for minimal containers

import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { bundleKernelChild, bundleViewport } from './bundle.ts';
import { child, hostInfo, median, round, writeResult } from './lib.ts';

type Row = Record<string, unknown>;
const only = new Set((process.env.ONLY ?? 'node,kernel,browser').split(','));
const RUNS = Number(process.env.RUNS ?? 5);
const KERNEL_RUNS = Number(process.env.RUNS ?? 3);
const FRAMES = Number(process.env.FRAMES ?? 60);
const FIXTURES = ['shed', 'house'] as const;
const NODE = 'scripts/node-child.ts';

const results: Record<string, unknown> = { host: hostInfo() };

function table(title: string, rows: Row[]) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  console.log(`\n### ${title}\n`);
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
}

/** Median of each numeric field over several fresh-process runs. */
function medians<T extends Row>(runs: T[]): Row {
  const out: Row = {};
  for (const k of Object.keys(runs[0]!)) {
    const v = runs[0]![k];
    out[k] = typeof v === 'number' ? round(median(runs.map((r) => r[k] as number)), 2) : v;
  }
  return out;
}

const log = (s: string) => process.stderr.write(`${s}\n`);

// Node: member counts, B and C ---------------------------------------------------------------

if (only.has('node')) {
  log('counts');
  const counts = child<Record<string, Row>>(NODE, 'counts');
  results.counts = counts;
  table(
    'Members',
    FIXTURES.map((f) => {
      const c = counts[f]!;
      const clip = c.clip as Row;
      const man = c.manifold as Row;
      return {
        fixture: f,
        members: c.members,
        cut: c.cutMembers,
        notched: c.notched,
        shapes: c.distinctShapes,
        'cut shapes': c.distinctCutShapes,
        'triangles (B / C)': `${clip.sceneTriangles} / ${man.sceneTriangles}`,
        'mesh KiB (B / C)': `${round((clip.meshBytes as number) / 1024)} / ${round((man.meshBytes as number) / 1024)}`,
      };
    }),
  );
  for (const f of FIXTURES) console.log(`\n${f} by role: ${JSON.stringify(counts[f]!.byRole)}`);

  const cold: Row[] = [];
  const warm: Row[] = [];
  for (const f of FIXTURES)
    for (const mesher of ['clip', 'manifold']) {
      log(`cold ${f} ${mesher}`);
      const runs = Array.from({ length: RUNS }, () =>
        child<Row>(NODE, 'cold', { fixture: f, mesher }),
      );
      cold.push({ fixture: f, rep: mesher === 'clip' ? 'B' : 'C', ...medians(runs) });
      log(`warm ${f} ${mesher}`);
      warm.push({
        fixture: f,
        rep: mesher === 'clip' ? 'B' : 'C',
        ...child<Row>(NODE, 'warm', { fixture: f, mesher, runs: 41 }),
      });
    }
  results.bcCold = cold;
  results.bcWarm = warm;
  table(
    `B and C cold regen (median of ${RUNS} fresh processes, ms)`,
    cold.map((r) => ({
      fixture: r.fixture,
      rep: r.rep,
      'load manifold': r.loadMs,
      generate: r.generateMs,
      mesh: r.meshMs,
      instances: r.instancesMs,
      total: r.totalMs,
      meshes: r.meshes,
      'JS heap growth MiB': r.heapUsedGrowthMiB,
    })),
  );
  table(
    'B and C warm regen (move one opening, median of 41, ms)',
    warm.map((r) => ({
      fixture: r.fixture,
      rep: r.rep,
      wall: r.wall,
      first: r.firstMs,
      median: r.medianMs,
      'new shapes': r.newShapesOnFirstMove,
      'all groups, warm cache': r.allGroupsWarmCacheMs,
    })),
  );

  log('meshers');
  const meshers = child<Row>(NODE, 'meshers', { runs: 20 });
  results.meshers = meshers;
  table('Own planar clip against Manifold (every distinct cut shape of both fixtures)', [meshers]);

  const leaks: Row[] = [];
  for (const leak of [false, true])
    for (const n of [10, 60]) {
      log(`manifold leak n=${n} leak=${leak}`);
      leaks.push(child<Row>(NODE, 'manifoldLeak', { n, leak }));
    }
  results.manifoldLeak = leaks;
  table(
    'Manifold delete() (house cut shapes, N runs on a fresh module, heap probe)',
    leaks.map((r) => ({
      n: r.n,
      deletes: r.leak ? 'skipped (control)' : 'all',
      created: r.created,
      deleted: r.deleted,
      'memory MiB': round((r.memoryBytes as number) / 2 ** 20),
      'in use MiB': round((r.usedBytes as number) / 2 ** 20, 2),
    })),
  );
}

// Kernel: representation A -------------------------------------------------------------------

if (only.has('kernel')) {
  log('bundle kernel child');
  const script = await bundleKernelChild();
  const cold: Row[] = [];
  const warm: Row[] = [];
  const demand: Row[] = [];
  for (const f of FIXTURES) {
    log(`A cold ${f}`);
    const runs = Array.from({ length: KERNEL_RUNS }, () =>
      child<Row>(script, 'cold', { fixture: f }),
    );
    cold.push({ fixture: f, ...medians(runs), errors: runs[0]!.errors });
    log(`A warm ${f}`);
    warm.push({ fixture: f, ...child<Row>(script, 'warm', { fixture: f, runs: 11 }) });
    log(`A on demand ${f}`);
    demand.push({ fixture: f, ...child<Row>(script, 'ondemand', { fixture: f }) });
  }
  results.aCold = cold;
  results.aWarm = warm;
  results.aOnDemand = demand;
  table(
    `A cold regen (kernel service, median of ${KERNEL_RUNS} fresh processes)`,
    cold.map((r) => ({
      fixture: r.fixture,
      members: r.members,
      'kernel ops': r.ops,
      'init ms': r.initMs,
      'regen ms': r.regenMs,
      triangles: r.triangles,
      'transfer MiB': r.transferMiB,
      'transfer ms': r.transferMs,
      'heap MiB': r.heapMiB,
      failed: r.failed,
    })),
  );
  table('A warm regen (move one opening; release and rebuild its wall, ms)', warm);
  table('A on demand (every member B-rep, no mesh, then one STEP file)', demand);

  const leak: Row[] = [];
  const plan: Array<[string, number[]]> = [
    ['shed', [10, 60]],
    ['house', [5, 20]],
  ];
  for (const [f, ns] of plan)
    for (const n of ns) {
      log(`A leak ${f} n=${n}`);
      leak.push({ fixture: f, ...child<Row>(script, 'leak', { fixture: f, n }) });
    }
  results.aLeak = leak;
  const perRegen = plan.map(([f, [a, b]]) => {
    const ra = leak.find((r) => r.fixture === f && r.n === a)!;
    const rb = leak.find((r) => r.fixture === f && r.n === b)!;
    const bytes = ((rb.usedBytes as number) - (ra.usedBytes as number)) / (b! - a!);
    return {
      fixture: f,
      n: `${a} / ${b}`,
      'in use MiB': `${round((ra.usedBytes as number) / 2 ** 20)} / ${round((rb.usedBytes as number) / 2 ** 20)}`,
      'MiB per regen': round(bytes / 2 ** 20, 2),
    };
  });
  results.aLeakPerRegen = perRegen;
  table('A heap growth per full regen (T0.2 leak probe, fresh process per N)', perRegen);

  log('A recycle house');
  const recycle = child<Row>(script, 'recycle', { fixture: 'house', max: 120 });
  results.aRecycle = recycle;
  table('A until the 1 GiB recycle (house, full regens)', [
    {
      'regens before recycle': recycle.regensBeforeRecycle,
      'heap at recycle MiB': recycle.heapAtRecycleMiB,
      'recycle ms': recycle.recycleMs,
      'median regen ms': recycle.medianRegenMs,
    },
  ]);
}

// Browser: viewport --------------------------------------------------------------------------

if (only.has('browser')) {
  log('bundle viewport');
  const dir = await bundleViewport();
  const extraLibs = process.env.PLAYWRIGHT_BROWSER_LD_LIBRARY_PATH;
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    ...(extraLibs ? { env: { ...process.env, LD_LIBRARY_PATH: extraLibs } } : {}),
  });
  // Served through a route, so no port is needed (other agents may be serving builds).
  const open = async (): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    await page.route('http://framing.spike/**', (r) => {
      const path = new URL(r.request().url()).pathname.replace(/^\//, '') || 'index.html';
      void r.fulfill({
        body: readFileSync(dir + path),
        contentType: path.endsWith('.js') ? 'text/javascript' : 'text/html',
      });
    });
    await page.goto('http://framing.spike/index.html');
    await page.waitForFunction(() => !!window.spike);
    return page;
  };
  const page0 = await open();
  results.renderer = await page0.evaluate(() => window.spike.renderer());
  await page0.close();

  const cases: Array<{
    label: string;
    rep: string;
    setup: Omit<Parameters<Window['spike']['setup']>[0], 'fixture'>;
    cut?: boolean;
  }> = [
    {
      label: 'object per member (A, as bodies.ts)',
      rep: 'A',
      setup: { mode: 'per-member', edges: true },
    },
    {
      label: 'InstancedMesh per role and shape',
      rep: 'B',
      setup: { mode: 'instanced', edges: true },
    },
    {
      label: 'InstancedMesh, Manifold cut meshes',
      rep: 'C',
      setup: { mode: 'instanced', edges: true },
      cut: true,
    },
    { label: 'BatchedMesh', rep: 'B', setup: { mode: 'batched', edges: true } },
    { label: 'InstancedMesh, no edges', rep: 'B', setup: { mode: 'instanced', edges: false } },
    {
      label: 'LOD near: blocking and cripples hidden',
      rep: 'B',
      setup: { mode: 'instanced', edges: true, hide: ['blocking', 'cripple'] },
    },
    {
      label: 'LOD far: one merged mesh per group',
      rep: 'B',
      setup: { mode: 'merged', edges: true },
    },
  ];
  const rows: Row[] = [];
  for (const f of FIXTURES) {
    const cutMeshes = child<Record<string, unknown>>(NODE, 'cutMeshes', { fixture: f });
    for (const c of cases) {
      log(`viewport ${f} ${c.label}`);
      const page = await open(); // a fresh page per case: no state carried over
      const setup = { fixture: f, ...c.setup, ...(c.cut ? { cutMeshes } : {}) };
      const s = await page.evaluate((o) => window.spike.setup(o as never), setup);
      const fr = await page.evaluate((n) => window.spike.frames(n), FRAMES);
      rows.push({
        fixture: f,
        rep: c.rep,
        case: c.label,
        members: s.members,
        'scene ms': round(s.generateMs + s.meshMs + s.sceneMs),
        'first frame ms': round(s.firstFrameMs),
        'draw calls': fr.drawCalls,
        triangles: fr.triangles,
        'frame ms (median)': round(fr.medianMs),
        'frame ms (p95)': round(fr.p95Ms),
        'GPU geometry KiB': round(s.geometryBytes / 1024),
      });
      await page.close();
    }
  }
  results.viewport = rows;
  table(`Viewport, 1280 x 800, ${results.renderer} (SwiftShader: software rendering)`, rows);

  const picks: Row[] = [];
  for (const f of FIXTURES) {
    const page = await open();
    await page.evaluate(
      (fx) => window.spike.setup({ fixture: fx, mode: 'instanced', edges: true }),
      f,
    );
    picks.push({ fixture: f, ...(await page.evaluate(() => window.spike.pick(200))) });
    await page.close();
  }
  results.picking = picks;
  table(
    'Picking: GPU pick pass with a per-instance id, against three.js raycasting',
    picks.map((p) => ({
      fixture: p.fixture,
      picks: p.picks,
      hits: p.hits,
      'same member': p.agree,
      'GPU pick ms': round(p.gpuMedianMs as number),
      'raycast ms': round(p.rayMedianMs as number),
    })),
  );
  for (const p of picks)
    console.log(`\n${p.fixture} pick mismatches (GPU, raycast): ${JSON.stringify(p.mismatches)}`);
  await browser.close();
}

const path = await writeResult(
  only.size === 3 ? 'measure.json' : `measure-${[...only].join('-')}.json`,
  results,
);
log(`wrote ${path}`);
