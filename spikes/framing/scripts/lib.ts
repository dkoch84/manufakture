// Helpers shared by the measurement scripts.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const SPIKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
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
  const version = (pkg: string) =>
    (
      JSON.parse(readFileSync(`${SPIKE_DIR}node_modules/${pkg}/package.json`, 'utf8')) as {
        version: string;
      }
    ).version;
  return {
    cpu: cpus()[0]?.model.trim(),
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    libcascade: version('libcascade'),
    manifold: version('manifold-3d'),
    three: version('three'),
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Run a child Node process and parse the JSON on its last stdout line. Each measurement gets a
 * fresh process: cold V8, a fresh wasm instance, a fresh heap.
 */
export function child<T>(script: string, task: string, args: object = {}): T {
  const result = spawnSync('node', [script, task, JSON.stringify(args)], {
    cwd: SPIKE_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.status !== 0) {
    throw new Error(`child ${script} ${task} failed (${result.status}):\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}
