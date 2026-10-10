// Node helpers: load gmsh quietly, write results with the machine they ran on.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initialize from '@loumalouomega/gmsh-wasm';
import { buildSolids, type SolidId } from './geometry.ts';
import { type Gmsh } from './mesh.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(here, '..', 'results');
export const STEP_DIR = join(here, '..', 'dist', 'step');

export async function loadGmsh(): Promise<Gmsh> {
  const g = await initialize({ print: () => {}, printErr: () => {} });
  g.initialize();
  g.option.setNumber('General.Terminal', 0);
  g.option.setNumber('General.Verbosity', 1);
  return g;
}

/** STEP bytes per solid, built once by the kernel and cached in dist/step for the browser run. */
export async function solids(): Promise<Record<SolidId, Uint8Array>> {
  const ids: SolidId[] = ['cantilever', 'plate-hole', 'lame', 'bracket'];
  if (ids.every((id) => existsSync(join(STEP_DIR, `${id}.step`)))) {
    return Object.fromEntries(
      ids.map((id) => [id, new Uint8Array(readFileSync(join(STEP_DIR, `${id}.step`)))]),
    ) as Record<SolidId, Uint8Array>;
  }
  const built = await buildSolids();
  mkdirSync(STEP_DIR, { recursive: true });
  for (const id of ids) writeFileSync(join(STEP_DIR, `${id}.step`), built[id]);
  return built;
}

export function machine() {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    v8: process.versions.v8,
    date: new Date().toISOString().slice(0, 10),
  };
}

export function writeResult(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, `${name}.json`),
    `${JSON.stringify({ machine: machine(), ...(data as object) }, null, 2)}\n`,
  );
}

export function rssMiB(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return Math.round(process.memoryUsage().rss / 2 ** 20);
}
