// Memory of HLR: which classes' delete() frees anything (the destructor audit), whether the
// prototype leaves embind objects behind (the kernel's tracker), and wasm heap per projection
// measured on fresh instances (N = 2 against N = 12 runs, one heap probe per instance, the kernel
// README's method), with and without the release rules. Writes results/memory.json.

import { expect, it } from 'vitest';
import type { Kernel } from '../../../packages/kernel/src/kernel';
import { createNodeKernel } from '../../../packages/kernel/src/node';
import { track } from '../../../packages/kernel/src/track';
import { auditDestructors } from './audit';
import { bookshelf, cabinetRun, holeBoard, type Fixture } from './fixtures';
import { projectExact, projectPoly, shapeOf, type ProjectOptions } from './hlr';
import { round, writeResult } from './results';
import { VIEWS } from './views';

const out: Record<string, unknown> = {};

const CLASSES = [
  'HLRBRep_Algo',
  'HLRBRep_InternalAlgo',
  'HLRBRep_HLRToShape',
  'HLRBRep_PolyAlgo',
  'HLRBRep_PolyHLRToShape',
  'HLRAlgo_Projector',
  'HLRAppli_ReflectLines',
  'HLRTopoBRep_OutLiner',
  'BRepAdaptor_Curve',
  'BRepMesh_IncrementalMesh',
  'gp_Ax2',
  'gp_Dir',
  'gp_Pnt',
  'gp_Pnt2d',
  'gp_Circ',
  'gp_Elips',
  'TopoDS_Shape',
  'TopoDS_Compound',
  'TopoDS_Edge',
  'NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher',
];

it('audits the destructors of the classes HLR uses', async () => {
  const status = await auditDestructors();
  const table = Object.fromEntries(
    CLASSES.map((c) => [c, status.has(c) ? status.get(c) : 'not bound']),
  );
  console.log(table);
  out.destructors = table;
  out.hlrClassesWithEmptyDestructor = [...status]
    .filter(([n, frees]) => /^HLR/.test(n) && !frees)
    .map(([n]) => n)
    .sort();
  out.hlrClasses = [...status.keys()].filter((n) => /^HLR/.test(n)).length;
});

it('leaves no embind object behind (tracker), exact and poly', async () => {
  const k = await createNodeKernel();
  const t = track(k.oc);
  const fixture = holeBoard(k, 10);
  const shapes = fixture.bodies.map((b) => shapeOf(k, b));
  t.reset();
  projectExact(k.oc, shapes, VIEWS.iso, { source: true, perItem: true });
  const exact = { created: t.created(), live: t.live(), liveNames: t.liveNames() };
  t.reset();
  projectPoly(k.oc, shapes, VIEWS.iso);
  const poly = { created: t.created(), live: t.live(), liveNames: t.liveNames() };
  console.log({ exact, poly });
  out.tracker = { exact, poly };
  expect(exact.live).toBe(0);
  expect(poly.live).toBe(0);
});

/** Bytes of wasm heap in use (packages/kernel/src/leaks.test.ts); grows the memory, so once per instance. */
function heapInUse(kernel: Kernel): number {
  const oc = kernel.oc as unknown as {
    wasmMemory: WebAssembly.Memory;
    _emscripten_builtin_malloc(size: number): number;
    _emscripten_builtin_free(ptr: number): void;
  };
  const size = 65536;
  const start = oc.wasmMemory.buffer.byteLength;
  const blocks: number[] = [];
  while (oc.wasmMemory.buffer.byteLength === start)
    blocks.push(oc._emscripten_builtin_malloc(size));
  for (const b of blocks) oc._emscripten_builtin_free(b);
  return start - (blocks.length - 1) * size;
}

const memoryBytes = (k: Kernel) =>
  (k.oc as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory.buffer.byteLength;

async function heapAfter(
  make: (k: Kernel) => Fixture,
  runs: number,
  run: (k: Kernel, shapes: ReturnType<typeof shapeOf>[]) => void,
) {
  const k = await createNodeKernel();
  const fixture = make(k);
  const shapes = fixture.bodies.map((b) => shapeOf(k, b));
  for (let i = 0; i < runs; i++) run(k, shapes);
  return heapInUse(k);
}

it('measures heap per projection on fresh instances, with and without the release rules', async () => {
  const board = (k: Kernel) => holeBoard(k, 40);
  const variants: Record<string, (k: Kernel, s: ReturnType<typeof shapeOf>[]) => void> = {
    'exact, released': (k, s) => projectExact(k.oc, s, VIEWS.iso),
    'exact, no release rule': (k, s) => projectExact(k.oc, s, VIEWS.iso, { release: false }),
    'exact with source and per item': (k, s) =>
      projectExact(k.oc, s, VIEWS.iso, { source: true, perItem: true }),
    'poly, released': (k, s) => projectPoly(k.oc, s, VIEWS.iso),
    'poly, no release rule': (k, s) =>
      projectPoly(k.oc, s, VIEWS.iso, { release: false } as ProjectOptions),
  };
  const rows: unknown[] = [];
  for (const [name, run] of Object.entries(variants)) {
    const h2 = await heapAfter(board, 2, run);
    const h12 = await heapAfter(board, 12, run);
    const perRun = (h12 - h2) / 10;
    rows.push({
      variant: name,
      fixture: 'board-40-holes',
      view: 'iso',
      heapN2: h2,
      heapN12: h12,
      bytesPerRun: Math.round(perRun),
    });
    console.log(`${name}: ${round(perRun / 1024, 1)} KiB per projection`);
  }
  out.heapPerRun = rows;
});

it('measures the memory a single large projection needs', async () => {
  const rows: unknown[] = [];
  for (const [name, make] of [
    ['bookshelf', bookshelf],
    ['cabinet-run-100', (k: Kernel) => cabinetRun(k, 20)],
  ] as const) {
    for (const algorithm of ['exact', 'poly'] as const) {
      const k = await createNodeKernel();
      const fixture = make(k);
      const shapes = fixture.bodies.map((b) => shapeOf(k, b));
      const before = memoryBytes(k);
      const r = (algorithm === 'exact' ? projectExact : projectPoly)(k.oc, shapes, VIEWS.iso);
      const after = memoryBytes(k);
      const retained = heapInUse(k);
      rows.push({
        fixture: name,
        algorithm,
        memoryBefore: before,
        memoryAfter: after,
        heapInUseAfter: retained,
        edges: r.edges.length,
      });
      console.log(name, algorithm, before / 2 ** 20, after / 2 ** 20, round(retained / 2 ** 20, 1));
    }
  }
  out.singleCall = rows;
});

it('writes results/memory.json', () => {
  writeResult('memory', out);
});
