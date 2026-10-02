// Writes a probe's numbers to results/<name>.json with the machine they were measured on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');
const BUILD_INFO = join(ROOT, 'build', 'dist', 'build-info.json');

export function host() {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    libcascade: '3.0.2 (single-threaded build), meshes only',
    ocl: existsSync(BUILD_INFO) ? (JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as unknown) : null,
    measuredAt: new Date().toISOString(),
  };
}

export function writeResult(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, `${name}.json`),
    JSON.stringify({ host: host(), ...(data as object) }, null, 2) + '\n',
  );
}

export function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export const round = (x: number, digits = 2): number => Number(x.toFixed(digits));
