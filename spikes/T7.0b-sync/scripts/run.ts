// The one command of the spike. From the repository root:
//   pnpm --filter @manufakture/spike-sync sim
// or `node scripts/run.ts` in this folder. Bundles src/main.ts for Node with Vite (core's
// sources need its resolver), runs every scenario and the rebase bench, prints Markdown tables
// and writes results/sync.json. Knobs (environment):
//   SEEDS=n          seeds per scenario (default 20)
//   ONLY=a,b         scenarios to run (default all)
//   PARTS=sim,bench  what to run (default both)
//   BENCH_RUNS=n     repetitions per bench case (default 5; the median is reported)

import { cpus, totalmem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { external: [/^node:/] },
  },
  ssr: { noExternal: true, target: 'node' },
});

const mod = (await import(pathToFileURL(`${root}dist/main.js`).href)) as {
  main(o: {
    seeds: number;
    only?: string[];
    benchRuns: number;
    parts: string[];
  }): Promise<Record<string, unknown>>;
};
const parts = (process.env.PARTS ?? 'sim,bench').split(',');
const t = performance.now();
const results = await mod.main({
  seeds: Number(process.env.SEEDS ?? 20),
  ...(process.env.ONLY ? { only: process.env.ONLY.split(',') } : {}),
  benchRuns: Number(process.env.BENCH_RUNS ?? 5),
  parts,
});
const host = {
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCpus: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  node: process.version,
  date: new Date().toISOString().slice(0, 10),
  totalSeconds: Math.round((performance.now() - t) / 100) / 10,
};
console.log(`\n${JSON.stringify(host)}`);
const file = parts.length === 2 && !process.env.ONLY ? 'sync.json' : `sync-${parts.join('-')}.json`;
writeFileSync(`${root}results/${file}`, `${JSON.stringify({ host, ...results }, null, 2)}\n`);
console.log(`wrote results/${file}`);
