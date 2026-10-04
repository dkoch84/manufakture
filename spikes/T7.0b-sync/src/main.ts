// The harness: every scenario over many seeds, then the rebase bench. Bundled and started by
// scripts/run.ts; prints Markdown tables and returns the results for results/*.json.

import { bench, type BenchRow } from './bench.ts';
import { bigPart, bracket } from './fixtures.ts';
import { SCENARIOS } from './scenarios.ts';
import { runScenario, type RunResult } from './sim.ts';

export interface Options {
  seeds: number;
  only?: string[] | undefined;
  benchRuns: number;
  parts: string[];
}

type Row = Record<string, string | number>;

function table(title: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  console.log(`\n### ${title}\n`);
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
}

const pct = (a: number, b: number) => (b === 0 ? '0.0 %' : `${((100 * a) / b).toFixed(1)} %`);

function summarize(name: string, runs: RunResult[]): Row {
  const s = (f: (r: RunResult) => number) => runs.reduce((t, r) => t + f(r), 0);
  const generated = s((r) => r.generated);
  const dropped = s((r) => r.dropped);
  const stale = s((r) => r.droppedBy['id-reused-stale-edit'] ?? 0);
  const idDrops = s((r) => r.droppedBy['id-reused'] ?? 0);
  return {
    scenario: name,
    runs: runs.length,
    commands: generated,
    accepted: s((r) => r.accepted),
    dropped: `${dropped} (${pct(dropped, generated)})`,
    'of which id-reused': idDrops,
    'stale edit': stale,
    'remapped entries': s((r) => r.remappedEntries),
    'ids renamed': s((r) => r.renamed),
    converged: `${runs.filter((r) => r.converged).length}/${runs.length}`,
    'invalid heads / id reuse': s((r) => r.violations.length),
    'intent checked': s((r) => r.intentChecked),
    misbound: s((r) => r.misbound.length),
    'remap misses': s((r) => r.remapMisses),
    'created guard (takeovers)': `${s((r) => r.createdCaught)} (${s((r) => r.takeovers)})`,
    'certain but accepted': s((r) => r.certainAccepted),
    'order flips': s((r) => r.orderFlips),
    'pred.-unknown / accepted': (
      s((r) => r.refusals['predecessor-unknown'] ?? 0) /
      Math.max(
        1,
        s((r) => r.accepted),
      )
    ).toFixed(2),
    'wall s': (s((r) => r.wallMs) / 1000).toFixed(1),
  };
}

export async function main(opts: Options): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (opts.parts.includes('sim')) {
    const start = bracket();
    const summaries: Row[] = [];
    const drops: Row[] = [];
    const scopes: Record<string, number> = {};
    const dropTypes: Record<string, number> = {};
    const categories: Record<string, { generated: number; accepted: number; dropped: number }> = {};
    const details: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const sc of SCENARIOS) {
      if (opts.only && !opts.only.includes(sc.name)) continue;
      const runs: RunResult[] = [];
      for (let seed = 1; seed <= opts.seeds; seed++) {
        const r = runScenario(sc, seed, start);
        runs.push(r);
        for (const v of [...r.violations.slice(0, 3), ...r.misbound, ...r.missLog]) {
          problems.push(`${sc.name} seed ${seed}: ${v}`);
        }
        if (!r.converged) problems.push(`${sc.name} seed ${seed}: did not converge`);
        if (r.accepted + r.dropped !== r.generated) {
          problems.push(`${sc.name} seed ${seed}: accepted + dropped != generated`);
        }
        if (!sc.ablation) {
          for (const [k, v] of Object.entries(r.byScope)) scopes[k] = (scopes[k] ?? 0) + v;
          for (const [k, v] of Object.entries(r.droppedByType))
            dropTypes[k] = (dropTypes[k] ?? 0) + v;
          for (const [k, v] of Object.entries(r.byCategory)) {
            const o = (categories[k] ??= { generated: 0, accepted: 0, dropped: 0 });
            o.generated += v.generated;
            o.accepted += v.accepted;
            o.dropped += v.dropped;
          }
        }
      }
      summaries.push(summarize(sc.name, runs));
      const codes: Record<string, number> = {};
      for (const r of runs)
        for (const [k, v] of Object.entries(r.droppedBy)) codes[k] = (codes[k] ?? 0) + v;
      const generated = runs.reduce((t, r) => t + r.generated, 0);
      drops.push({
        scenario: sc.name,
        ...Object.fromEntries(
          Object.entries(codes)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, `${v} (${pct(v, generated)})`]),
        ),
      });
      // Per run: the scalars only; the per-category and per-scope breakdowns are aggregated above.
      details[sc.name] = runs.map((r) => {
        const { byCategory, byScope, droppedByType, missLog, ...rest } = r;
        void byCategory;
        void byScope;
        void droppedByType;
        return {
          ...rest,
          missLog: missLog.slice(0, 5),
          misbound: r.misbound.slice(0, 5),
          violations: r.violations.length,
          wallMs: Math.round(r.wallMs),
        };
      });
    }
    table('Scenarios', summaries);
    for (const d of drops) table(`Drops by error: ${d.scenario}`, [d]);
    table(
      'Ids renamed per scope (all scenarios but the ablations)',
      Object.entries(scopes)
        .sort()
        .map(([scope, n]) => ({ scope, renamed: n })),
    );
    table(
      'Drops by error and command type (all scenarios but the ablations, top 20)',
      Object.entries(dropTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, n]) => ({ 'error, command': k, dropped: n })),
    );
    table(
      'Commands per category (all scenarios but the ablations)',
      Object.entries(categories)
        .sort()
        .map(([category, v]) => ({ category, ...v, 'dropped %': pct(v.dropped, v.generated) })),
    );
    console.log(`\n${problems.length} problems${problems.length ? ':' : ''}`);
    for (const p of problems.slice(0, 40)) console.log(`- ${p}`);
    out.summaries = summaries;
    out.drops = drops;
    out.scopes = scopes;
    out.dropTypes = dropTypes;
    out.categories = categories;
    out.problems = problems;
    out.runs = details;
  }
  if (opts.parts.includes('bench')) {
    const t = performance.now();
    const big = bigPart(200);
    const buildMs = performance.now() - t;
    const rows: BenchRow[] = bench(
      [
        ['bracket', bracket()],
        ['part-200', big],
      ],
      [10, 100, 1000],
      opts.benchRuns,
    );
    table('Rebase cost', rows as unknown as Row[]);
    out.bench = rows;
    out.bigPartBuildMs = Math.round(buildMs);
  }
  return out;
}
