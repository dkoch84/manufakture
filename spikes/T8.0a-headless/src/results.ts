// Each probe writes its numbers to results/<probe>.json with the machine it ran on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS = join(SPIKE_DIR, 'results');
/** Scratch space for libraries and the browser build (git ignores `dist/`). */
export const SCRATCH = join(SPIKE_DIR, 'dist');

export const round = (x: number, digits = 1): number => Number(x.toFixed(digits));
export const MiB = (bytes: number): number => round(bytes / 1024 / 1024, 1);

export function machine() {
  return {
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: round(totalmem() / 1024 ** 3, 0),
    date: new Date().toISOString().slice(0, 10),
  };
}

export function writeResult(probe: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, `${probe}.json`),
    `${JSON.stringify({ machine: machine(), ...(data as object) }, null, 2)}\n`,
  );
}

/** Resident memory now, after a full collection when `--expose-gc` is on. */
export function memory() {
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  return {
    rss: MiB(m.rss),
    heapUsed: MiB(m.heapUsed),
    external: MiB(m.external),
    arrayBuffers: MiB(m.arrayBuffers),
  };
}
