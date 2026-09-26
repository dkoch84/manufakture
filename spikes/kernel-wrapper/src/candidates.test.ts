// Proves that every candidate builds the same geometry, and pins down what each
// one exposes of OCCT's history. Not part of the root test run (it loads four
// OCCT builds). Run with: pnpm --filter @manufakture/spike-kernel-wrapper test

import * as brepjs from 'brepjs';
import * as replicad from 'replicad';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBrepjs } from './candidates/brepjs.ts';
import { createOcctWasm } from './candidates/occtWasm.ts';
import { createOwn } from './candidates/own.ts';
import { createReplicad, createReplicadOnLibcascade } from './candidates/replicad.ts';
import type { Candidate, CandidateName, HistorySummary, RunResult } from './candidates/types.ts';
import { KernelError } from './own/kernel.ts';
import { EXPECTED, VOLUME_TOLERANCE } from './scenario.ts';

const candidates = new Map<CandidateName, Candidate>();
let own: Awaited<ReturnType<typeof createOwn>>;
let replicadOnLibcascade: Awaited<ReturnType<typeof createReplicadOnLibcascade>>;

beforeAll(async () => {
  own = await createOwn();
  candidates.set('own-libcascade', own);
  candidates.set('replicad', await createReplicad());
  replicadOnLibcascade = await createReplicadOnLibcascade();
  candidates.set('replicad-libcascade', replicadOnLibcascade);
  candidates.set('occt-wasm', await createOcctWasm());
  candidates.set('brepjs', await createBrepjs());
});

function expectVolume(actual: number, expected: number) {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(VOLUME_TOLERANCE);
}

function get(name: CandidateName): Candidate {
  const c = candidates.get(name);
  if (!c) throw new Error(`candidate ${name} not loaded`);
  return c;
}

const ALL: CandidateName[] = [
  'own-libcascade',
  'replicad',
  'replicad-libcascade',
  'occt-wasm',
  'brepjs',
];

describe.each(ALL)('%s: geometry', (name) => {
  let result: RunResult;
  beforeAll(() => {
    const c = get(name);
    result = c.run({ mesh: c.canMesh, history: false });
  });

  it('fillets all 12 box edges: 26 faces, exact volume', () => {
    expect(result.report.filleted.faces).toBe(EXPECTED.filleted.faces);
    expectVolume(result.report.filleted.volume, EXPECTED.filleted.volume);
  });

  it('extrudes the closed L polyline: 8 faces, area x height', () => {
    expect(result.report.extruded.faces).toBe(EXPECTED.extruded.faces);
    expectVolume(result.report.extruded.volume, EXPECTED.extruded.volume);
  });

  it('drills the extrusion: 9 faces, volume minus the hole', () => {
    expect(result.report.cut.faces).toBe(EXPECTED.cut.faces);
    expectVolume(result.report.cut.volume, EXPECTED.cut.volume);
  });
});

describe('meshing', () => {
  it('every candidate that can mesh gives the same triangulation (same OCCT 8.0.1 mesher)', () => {
    const reference = own.run({ mesh: true, history: false }).report;
    expect(reference.filleted.triangles).toBeGreaterThan(0);
    expect(reference.cut.triangles).toBeGreaterThan(0);
    for (const name of ['replicad', 'occt-wasm', 'brepjs'] as const) {
      const r = get(name).run({ mesh: true, history: false }).report;
      expect(r.filleted.triangles, name).toBe(reference.filleted.triangles);
      expect(r.cut.triangles, name).toBe(reference.cut.triangles);
    }
  });

  it('replicad cannot mesh on libcascade: its C++ mesh extractor is not in that build', () => {
    replicad.setOC(replicadOnLibcascade.oc);
    const box = replicad.makeBaseBox(10, 10, 10);
    try {
      expect(() => box.mesh()).toThrow(/reading 'extract'/);
      expect('ReplicadMeshExtractor' in replicadOnLibcascade.oc).toBe(false);
    } finally {
      box.delete();
    }
  });
});

/** Full OCCT history, as the own wrapper and replicad's escape hatch report it. */
function expectFullHistory(h: { fillet: HistorySummary; cut: HistorySummary }) {
  // Fillet: every box face is trimmed, each edge generates its fillet face and
  // each vertex its corner blend, so all 26 result faces trace to an input.
  expect(h.fillet).toEqual({
    inputFaces: 6,
    modifiedFaces: 6,
    deletedFaces: 0,
    keptFaces: 0,
    generatedFrom: { face: 0, edge: 12, vertex: 8 },
    resultFaces: 26,
    tracedResultFaces: 26,
  });
  // Cut: the two faces the drill passes through and the drill's side are
  // modified, its two caps are deleted, the other six prism faces are kept.
  expect(h.cut).toEqual({
    inputFaces: 11,
    modifiedFaces: 3,
    deletedFaces: 2,
    keptFaces: 6,
    generatedFrom: { face: 0, edge: 0, vertex: 0 },
    resultFaces: 9,
    tracedResultFaces: 9,
  });
}

describe('history', () => {
  it('own wrapper: Modified / Generated / IsDeleted for faces, edges and vertices', () => {
    const r = own.run({ mesh: false, history: true });
    expectFullHistory(r.history!);
  });

  it('own wrapper: history entries name input and output sub-shapes by index', () => {
    const k = own.kernel;
    const mark = k.checkpoint();
    try {
      const box = k.box(40, 30, 20);
      const { shape, history } = k.fillet(box, 2, [1], { history: true });
      // One edge filleted: the edge generates exactly one face; the two faces
      // meeting at it are trimmed and the two end faces gain the fillet's arc,
      // so four faces are modified and the other two pass through unchanged.
      const edge = history.filter((e) => e.input.kind === 'edge');
      expect(edge).toHaveLength(1);
      expect(edge[0]!.input.index).toBe(1);
      expect(edge[0]!.generated).toHaveLength(1);
      const faces = history.filter((e) => e.input.kind === 'face');
      expect(faces.filter((e) => e.modified.length > 0)).toHaveLength(4);
      expect(faces.filter((e) => e.modified.length === 0 && e.kept > 0)).toHaveLength(2);
      expect(k.count(shape, 'face')).toBe(7);
    } finally {
      k.releaseSince(mark);
    }
  });

  it('replicad: no history API; the raw escape hatch gives the full history', () => {
    const c = get('replicad');
    expect(c.historyApi).toBe('none');
    expectFullHistory(c.run({ mesh: false, history: true }).history!);
  });

  for (const name of ['occt-wasm', 'brepjs'] as const) {
    it(`${name}: face history by hash; fillet faces generated by edges and vertices are missing`, () => {
      const h = get(name).run({ mesh: false, history: true }).history!;
      expect(h.cut.tracedResultFaces).toBe(9);
      expect(h.cut.modifiedFaces).toBe(3);
      expect(h.cut.deletedFaces).toBe(2);
      expect(h.cut.keptFaces).toBe(6);
      // Only the 6 trimmed box faces trace back: the 12 fillet faces and 8
      // corner blends come from edges and vertices, which are never asked.
      expect(h.fillet.modifiedFaces).toBe(6);
      expect(h.fillet.tracedResultFaces).toBe(6);
      expect(h.fillet.resultFaces).toBe(26);
    });
  }

  it('brepjs: *WithEvolution returns empty maps unless an input carries metadata', () => {
    const box = brepjs.box(40, 30, 20);
    const plain = brepjs.unwrap(brepjs.filletWithEvolution(box, undefined, 2));
    expect(plain.evolution.modified.size).toBe(0);
    expect(plain.evolution.generated.size).toBe(0);
    brepjs.setShapeOrigin(box, 1);
    const tagged = brepjs.unwrap(brepjs.filletWithEvolution(box, undefined, 2));
    expect(tagged.evolution.modified.size).toBe(6);
    for (const s of [plain.shape, tagged.shape, box]) s.delete();
  });
});

describe('memory management', () => {
  it('own wrapper: every arena shape is released after a run, errors included', () => {
    own.run({ mesh: true, history: true });
    expect(own.kernel.shapeCount).toBe(0);
    const k = own.kernel;
    const box = k.box(10, 10, 10);
    expect(() => k.fillet(box, 50)).toThrow(KernelError);
    expect(k.shapeCount).toBe(1);
    k.release(box);
    expect(k.shapeCount).toBe(0);
  });

  it('occt-wasm: its arena is empty again after a run', () => {
    const c = get('occt-wasm');
    c.run({ mesh: true, history: true });
    expect(c.liveHandles()).toBe(0);
  });

  it('brepjs: every handle it tracks is disposed after a run', () => {
    const c = get('brepjs');
    const before = c.liveHandles()!;
    c.run({ mesh: true, history: true });
    expect(c.liveHandles()).toBe(before);
  });
});
