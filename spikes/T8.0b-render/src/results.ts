// Writes a probe's numbers to results/<name>.json with the machine they were measured on, and the
// sample images to docs/spikes/T8.0b-render/.

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(HERE, '..', 'results');
export const IMAGES = join(HERE, '..', '..', '..', 'docs', 'spikes', 'T8.0b-render');
/** Full-size renders that are not kept in the repository (compared, then thrown away). */
export const SCRATCH = process.env.T80B_SCRATCH ?? '/tmp/t80b-render';

export function host() {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
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

export function writeImage(dir: string, name: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

export function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

export const round = (x: number, digits = 1): number => Number(x.toFixed(digits));

/** Milliseconds `run` takes, and what it returned. */
export async function timed<T>(run: () => T | Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const value = await run();
  return [value, performance.now() - t0];
}
