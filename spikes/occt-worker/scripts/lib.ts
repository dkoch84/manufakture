// Helpers shared by the measurement scripts.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const SPIKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));
export const LIBCASCADE_DIST = fileURLToPath(
  new URL('../node_modules/libcascade/dist/', import.meta.url),
);

export const MiB = 1024 * 1024;

export interface Summary {
  n: number;
  median: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return {
    n: sorted.length,
    median: round(median),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

export function round(value: number, digits = 2): number {
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
  const cpu = cpus()[0];
  return {
    cpu: cpu?.model.trim(),
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    libcascade: execFileSync('node', ['-p', "require('libcascade/package.json').version"], {
      cwd: SPIKE_DIR,
      encoding: 'utf8',
    }).trim(),
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Run a child Node process and parse the JSON it prints on its last stdout
 * line. Children give each measurement a fresh process (cold V8, fresh heap).
 */
export function child<T>(args: string[], nodeFlags: string[] = []): T {
  const result = spawnSync('node', [...nodeFlags, ...args], {
    cwd: SPIKE_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * MiB,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.status !== 0) {
    throw new Error(`child ${args.join(' ')} failed (${result.status}):\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as T;
}
