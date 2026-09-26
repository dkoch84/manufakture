// Helpers shared by the measurement script.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const SPIKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

const require = createRequire(import.meta.url);
export const PLANEGCS_DIST = require
  .resolve('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm')
  .replace(/planegcs\.wasm$/, '');

export function stockWasm(): Uint8Array {
  return new Uint8Array(readFileSync(`${PLANEGCS_DIST}planegcs.wasm`));
}

export interface Summary {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

export function summarize(values: number[], digits = 3): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: round(percentile(sorted, 50), digits),
    p95: round(percentile(sorted, 95), digits),
    min: round(sorted[0] ?? NaN, digits),
    max: round(sorted[sorted.length - 1] ?? NaN, digits),
  };
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function roundAll<T extends object>(o: T, digits = 3): T {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v, digits) : v]),
  ) as T;
}

/** Write a results file, formatted with the repo's prettier config so lint passes. */
export async function writeResult(name: string, data: unknown): Promise<string> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = `${RESULTS_DIR}${name}`;
  const config = (await prettier.resolveConfig(path)) ?? {};
  const text = await prettier.format(JSON.stringify(data), { ...config, filepath: path });
  writeFileSync(path, text);
  return path;
}

export function hostInfo() {
  const cpu = cpus()[0];
  return {
    cpu: cpu?.model.trim(),
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    planegcs: execFileSync('node', ['-p', "require('@salusoft89/planegcs/package.json').version"], {
      cwd: SPIKE_DIR,
      encoding: 'utf8',
    }).trim(),
    measuredAt: new Date().toISOString(),
  };
}
