// The kernel memory bench's models and measurements (docs/research/end-of-m1-checkpoints.md):
// the acceptance models of M1 to M6 as documents, built with the same commands as the e2e
// fixtures, and regenerated in Node with the real kernel, solver, text engine and domains, as the
// app's regen worker does.
//
// - **full**: n full regens on one fresh kernel instance (a new engine each time, disposed after,
//   so every body is built and released), then `heapInUse` once at the end;
// - **edit**: one cold regen, then n edits on the same engine, each distinct so that the cache
//   never serves it, with a cache that keeps no spare entries (replaced bodies are released at
//   once, so what stays behind is leaked, not cached).
//
// Each runs in a fresh process (`memory.bench.ts`): the heap probe disturbs the allocator and may
// be used once per instance. Compare two n: the difference over the regens between them is the
// leak per regen (the T0.2 method; T6.5a rule 5).

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  MOVED_POSITION_IN,
  houseCommands,
  movedWindow,
} from '@manufakture/domain-construction/fixtures/house';
import { registerConstruction } from '@manufakture/domain-construction';
import { registerWood } from '@manufakture/domain-wood';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { heapInUse, occtAllocator } from '@manufakture/kernel/testing';
import {
  ExtensionRegistry,
  MemoryCache,
  RegenEngine,
  createTextOutliner,
  type RegenResult,
} from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';
import { registerStock } from '@manufakture/stock';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shelfDocumentCommands } from '../e2e/m2-fixtures';
import { jigCommands } from '../e2e/m3-fixtures';
import {
  BOARDS,
  INCH_UNITS,
  JOINTS,
  SHELF as BOOKSHELF,
  boardFeature,
  boardNames,
  carcassSketches,
  configurationCommands,
  frameSketch,
  jointFeature,
} from '../e2e/m4-fixtures';
import { SIGN, cutCommands, plateCommands } from '../e2e/m5-fixtures';

const PART = 'part#1';
const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const add = (feature: unknown) => ({ type: 'addFeature', partId: PART, feature });

function apply(doc: ManufaktureDocument, commands: readonly unknown[]): ManufaktureDocument {
  for (const command of commands) {
    const r = applyCommand(doc, command as Command);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const build = (id: string, commands: readonly unknown[]) =>
  apply(createDocument({ id, name: id }), commands);

/**
 * The M1 bracket of docs/m1-acceptance.md as commands: what `e2e/bracket.ts` makes through the
 * UI (the L-profile on Front (XZ), 30 mm symmetric, two M4 counterbored holes, the 4 mm round).
 */
function bracketCommands(): unknown[] {
  const t = 6;
  const corners: [number, number][] = [
    [0, 0],
    [50, 0],
    [50, t],
    [t, t],
    [t, 40],
    [0, 40],
  ];
  const id = (i: number) => `e${i + 1}`;
  const from = (i: number) => ({ entity: id(i), at: 'start' });
  const to = (i: number) => ({ entity: id(i), at: 'end' });
  return [
    { type: 'setVariable', name: 'thickness', expression: mm(`${t}`) },
    add({
      id: 'sketch#1',
      kind: 'sketch',
      name: 'Sketch 1',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] },
      entities: corners.map((start, i) => ({
        id: id(i),
        kind: 'line',
        construction: false,
        start,
        end: corners[(i + 1) % 6],
      })),
      constraints: [
        ...corners.map((_, i) => ({
          id: `k${i + 1}`,
          kind: 'coincident',
          a: to(i),
          b: from((i + 1) % 6),
        })),
        { id: 'k7', kind: 'coincident', a: from(0), b: { entity: '@origin' } },
        ...[0, 2, 4].map((i) => ({ id: `k${8 + i}`, kind: 'horizontal', line: id(i) })),
        ...[1, 3, 5].map((i) => ({ id: `k${8 + i}`, kind: 'vertical', line: id(i) })),
        { id: 'k14', kind: 'horizontalDistance', a: from(0), b: to(0), value: mm('50') },
        { id: 'k15', kind: 'verticalDistance', a: to(5), b: from(5), value: mm('40') },
        { id: 'k16', kind: 'verticalDistance', a: from(1), b: to(1), value: mm('#thickness') },
        { id: 'k17', kind: 'horizontalDistance', a: to(4), b: from(4), value: mm('#thickness') },
      ],
    }),
    add({
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'symmetric', distance: mm('30') },
      reverse: false,
    }),
    add({
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Sketch 2',
      suppressed: false,
      plane: { type: 'face', face: { id: 'r1', ref: { face: 'extrude#1:side:e3' } } },
      entities: [
        { id: 'e7', kind: 'point', construction: false, position: [25, 0] },
        { id: 'e8', kind: 'point', construction: false, position: [40, 0] },
      ],
      constraints: [],
    }),
    add({
      id: 'hole#1',
      kind: 'hole',
      name: 'Hole 1',
      suppressed: false,
      sketch: 'sketch#2',
      points: ['e7', 'e8'],
      diameter: mm('4.5'),
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: mm('8'), depth: mm('4.4') },
      standard: { size: 'M4', fit: 'normal' },
    }),
    add({
      id: 'fillet#1',
      kind: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
      radius: mm('4'),
    }),
  ];
}

/** The bundled font as the Text tool records it (ADR 0011). */
const INTER = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: {
    kind: 'bundled',
    id: 'inter-bold',
    sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
  },
};

/**
 * The M5 sign. The walkthrough imports its lettering from an SVG of the word in Inter Bold; here
 * the same word is a text outline in the bundled Inter Bold, at about the same size.
 */
function signCommands(): unknown[] {
  return [
    { type: 'setVariable', name: 'thickness', expression: mm(`${SIGN.thickness} mm`) },
    { type: 'addFont', font: INTER },
    ...plateCommands(),
    add({
      id: 'sketch#4',
      kind: 'sketch',
      name: 'Sketch 4',
      suppressed: false,
      plane: { type: 'face', face: { id: 'r4', ref: { face: 'extrude#1:cap:end' } } },
      entities: [
        {
          id: 'e27',
          kind: 'outline',
          construction: false,
          anchor: SIGN.lettering.centre,
          angle: 0,
          source: {
            kind: 'text',
            text: 'WOODSHOP',
            font: INTER.id,
            size: mm('55 mm'),
            align: { horizontal: 'center', vertical: 'middle' },
          },
        },
      ],
      constraints: [],
    }),
    ...cutCommands(),
  ];
}

/** The M4 bookshelf: what `buildBookshelf` (e2e/m4-fixtures.ts) runs as one batch. */
function bookshelfCommands(): unknown[] {
  return [
    INCH_UNITS,
    { type: 'renamePart', partId: PART, name: 'Carcass' },
    {
      type: 'setVariable',
      name: 'width',
      expression: { source: `${BOOKSHELF.modelled} in`, lengthUnit: 'in', angleUnit: 'deg' },
    },
    add(frameSketch()),
    ...BOARDS.slice(0, 4).map((b) => add(boardFeature(b))),
    ...carcassSketches(),
    ...BOARDS.slice(4).map((b) => add(boardFeature(b))),
    ...JOINTS.map((j) => add(jointFeature(j))),
    ...boardNames(),
    ...configurationCommands(),
  ];
}

export interface Model {
  name: string;
  doc(): ManufaktureDocument;
  /** The i-th edit: every one distinct, so the feature cache never serves it. */
  edit?(base: ManufaktureDocument, i: number): ManufaktureDocument;
}

export const MODELS: Record<string, Model> = {
  bracket: {
    name: 'M1 bracket',
    doc: () => build('bracket', bracketCommands()),
    edit: (base, i) =>
      apply(base, [
        {
          type: 'setVariable',
          name: 'thickness',
          expression: mm(`${(i % 2 === 0 ? 8 : 6) + (i + 1) / 1024}`),
        },
      ]),
  },
  shelf: {
    name: 'M2 wall shelf (shelf and drawer)',
    doc: () => build('shelf', shelfDocumentCommands()),
  },
  jig: {
    name: 'M3 jig',
    doc: () => build('jig', jigCommands()),
    edit: (base, i) =>
      apply(base, [
        {
          type: 'setVariable',
          name: 'fit_slip',
          expression: mm(`${0.2 + ((i % 2) + 1) / 100 + (i + 1) / 100_000} mm`),
        },
      ]),
  },
  bookshelf: { name: 'M4 bookshelf', doc: () => build('bookshelf', bookshelfCommands()) },
  sign: { name: 'M5 sign', doc: () => build('sign', signCommands()) },
  house: {
    name: 'M6 house',
    doc: () => build('house', [houseCommands(PART)]),
    edit: (base, i) =>
      apply(base, [
        {
          type: 'editFeature',
          partId: PART,
          feature: movedWindow(MOVED_POSITION_IN + (i % 2 === 0 ? 12 : 0) + (i + 1) / 64),
        },
      ]),
  },
};

// Measurements -------------------------------------------------------------------------------

const fromDisk = async (url: URL): Promise<Response> =>
  new Response(readFileSync(fileURLToPath(url)));

const extensions = new ExtensionRegistry();
registerStock(extensions);
registerWood(extensions);
registerConstruction(extensions);
const solver = createSolverService();
const text = createTextOutliner({ fetchImpl: fromDisk });

function engineFor(service: KernelService, cache?: MemoryCache): RegenEngine {
  return new RegenEngine({
    kernel: service,
    solver,
    text,
    extensions,
    ...(cache ? { cache } : {}),
  });
}

async function regen(engine: RegenEngine, service: KernelService, doc: ManufaktureDocument) {
  const s = service.stats();
  const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return checked(result);
}

function checked(result: RegenResult): RegenResult {
  const bad = result.parts.flatMap((p) =>
    p.features
      .filter((f) => f.status !== 'ok')
      .map((f) => `${p.partId}/${f.featureId}: ${JSON.stringify(f.errors)}`),
  );
  if (bad.length > 0) throw new Error(`features failed: ${bad.join('; ')}`);
  return result;
}

export interface Sample {
  model: string;
  mode: 'full' | 'edit';
  n: number;
  /** `heapInUse` with 4 KiB blocks after the n regens, bytes. */
  heapInUse: number;
  /** The wasm memory's size, bytes. */
  heapBytes: number;
  /** 1 unless the instance recycled (the probe is then void). */
  instance: number;
  /** Shapes left alive at the end (0: every body was released). */
  liveShapes: number;
  /** Time of each regen, ms (the first of `full` is the cold one). */
  ms: number[];
}

/** The service for a measurement: no recycle, so the probe reads the instance that ran. */
const service = () => createNodeService({ heapThresholdBytes: 3.9 * 1024 ** 3 });

async function probe(
  s: KernelService,
  model: string,
  mode: Sample['mode'],
  n: number,
  ms: number[],
) {
  const sample: Sample = {
    model,
    mode,
    n,
    heapInUse: 0,
    heapBytes: s.stats().heapBytes,
    instance: s.instance,
    liveShapes: s.leaks().length,
    ms,
  };
  // 4 KiB blocks: 64 KiB blocks read a leak of small pieces at 0.70 to 0.85 (T6.5a).
  sample.heapInUse = heapInUse(occtAllocator(s.kernel.oc), 4096);
  return sample;
}

export async function full(model: string, n: number): Promise<Sample> {
  const s = await service();
  const doc = MODELS[model]!.doc();
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const engine = engineFor(s);
    const t = performance.now();
    await regen(engine, s, doc);
    ms.push(performance.now() - t);
    await engine.dispose();
    await s.idle();
  }
  return probe(s, model, 'full', n, ms);
}

export async function edit(model: string, n: number): Promise<Sample> {
  const m = MODELS[model]!;
  if (!m.edit) throw new Error(`${model} has no edit`);
  const s = await service();
  const base = m.doc();
  const engine = engineFor(s, new MemoryCache({ spare: 0 }));
  await regen(engine, s, base);
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await regen(engine, s, m.edit(base, i));
    ms.push(performance.now() - t);
  }
  await engine.dispose();
  await s.idle();
  return probe(s, model, 'edit', n, ms);
}
