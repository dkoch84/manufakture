// Regen timing for the T0.5 test part. Node only.
//
//   pnpm --filter @manufakture/spike-topo-naming bench [runs]
//
// Regenerates the four-feature part (block, slot, hole, corner fillet) `runs`
// times (default 20) after a warm-up, and prints the median and range of the
// whole regen and of the time spent in `kernel.topology()`, which naming needs.

import { createInstance } from 'libcascade/single/init';
import { Kernel } from '../src/kernel.ts';
import { type Feature, regenerate } from '../src/model.ts';
import { pickEdge } from '../src/naming.ts';
import { H, fillet, hole, rectangle, slot } from '../src/part.ts';

const runs = Number(process.argv[2] ?? 20);
const WARMUP = 5;

const kernel = new Kernel(await createInstance());

// Instrument topology() to attribute its share of each regen.
let topologyMs = 0;
const topology = kernel.topology.bind(kernel);
kernel.topology = (shape) => {
  const t = performance.now();
  try {
    return topology(shape);
  } finally {
    topologyMs += performance.now() - t;
  }
};

// Pick the corner edge at (40, 0) the way the tests do.
const base = regenerate(kernel, [rectangle(40, 30), slot, hole]);
if (!base.body) throw new Error('base part failed to regenerate');
const corner = base.body.topology.edges.find(
  (e) => Math.hypot(e.midpoint[0] - 40, e.midpoint[1], e.midpoint[2] - H / 2) < 1e-6,
);
if (!corner) throw new Error('corner edge not found');
const features: Feature[] = [
  rectangle(40, 30),
  slot,
  hole,
  fillet(pickEdge(base.body.names, corner.index)),
];
kernel.release(base.body.shape);

const total: number[] = [];
const topo: number[] = [];
for (let i = 0; i < WARMUP + runs; i++) {
  topologyMs = 0;
  const t = performance.now();
  const r = regenerate(kernel, features);
  const elapsed = performance.now() - t;
  if (r.errors.length > 0 || !r.body) throw new Error(`regen failed: ${JSON.stringify(r.errors)}`);
  kernel.release(r.body.shape);
  if (i < WARMUP) continue;
  total.push(elapsed);
  topo.push(topologyMs);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (xs: number[]) =>
  `median ${median(xs).toFixed(1)} ms (min ${Math.min(...xs).toFixed(1)}, max ${Math.max(...xs).toFixed(1)})`;

console.log(`node ${process.version}, ${runs} runs after ${WARMUP} warm-up`);
console.log(`regen of the four-feature part: ${fmt(total)}`);
console.log(`of which kernel.topology():     ${fmt(topo)}`);
