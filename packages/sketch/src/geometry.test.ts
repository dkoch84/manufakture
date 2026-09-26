// `@manufakture/sketch/geometry` and `/rpc` must load no solver: the app's main bundle imports
// them for drawing and placement, and planegcs belongs in the solver worker alone. Walks the
// runtime imports of both entry points and checks that none reaches planegcs or the service.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as geometry from './geometry';
import * as index from './index';

const here = dirname(fileURLToPath(import.meta.url));

/** Every module reached through runtime (non-type) imports from `entry`. */
function runtimeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(join(here, `${entry}.ts`), 'utf8');
  const re = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms;
  for (const m of text.matchAll(re)) {
    const spec = m[1]!;
    if (!spec.startsWith('.')) {
      seen.add(spec);
      continue;
    }
    runtimeImports(join(dirname(entry), spec).replace(/\\/g, '/'), seen);
  }
  return seen;
}

describe('the solver-free entry points', () => {
  it.each(['geometry', 'rpc'])('%s reaches no planegcs and no solver service', (entry) => {
    const reached = [...runtimeImports(entry)];
    expect(reached.filter((m) => /planegcs|service|solver/.test(m))).toEqual([]);
  });

  it('sees the solver behind the package root (the walk is not vacuous)', () => {
    expect([...runtimeImports('index')].some((m) => m.includes('@salusoft89/planegcs'))).toBe(true);
  });

  it('geometry exports what the package root does, less the solver', () => {
    const solverOnly = [
      'packageName',
      'SolverAbortedError',
      'loadPlanegcsBackend',
      'SolverService',
      'createSolverService',
      'connectSolver',
      'serveSolver',
    ];
    expect(Object.keys(geometry).sort()).toEqual(
      Object.keys(index)
        .filter((k) => !solverOnly.includes(k))
        .sort(),
    );
  });
});
