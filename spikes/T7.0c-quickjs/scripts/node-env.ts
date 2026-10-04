// The Node side of BenchEnv: .wasm files read from node_modules.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import type { BenchEnv } from '../src/bench';
import { VARIANT_PACKAGES, type VariantName } from '../src/variants';

const require = createRequire(import.meta.url);

export function wasmFile(name: VariantName): string {
  return require.resolve(`${VARIANT_PACKAGES[name]}/wasm`);
}

export const nodeEnv: BenchEnv = {
  now: () => performance.now(),
  compile: (name) => WebAssembly.compile(readFileSync(wasmFile(name))),
  macrotask: () => new Promise((resolve) => setImmediate(resolve)),
  // Indirect eval: global scope, the host engine's own Math and number formatting.
  hostEval: (code) => (0, eval)(code) as unknown,
  unsafeChecks: true,
};
