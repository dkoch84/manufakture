// Runs the real OCCT pipeline in Node (not part of the root test run: loading
// the 42 MB kernel is slow). Run with: pnpm --filter @manufakture/spike-occt-worker test

import { createInstance } from 'libcascade/single/init';
import { beforeAll, describe, expect, it } from 'vitest';
import { CASES } from './cases.ts';
import { runPipeline, type MeshData } from './pipeline.ts';
import { track, type Tracker } from './track.ts';

let tracker: Tracker;

beforeAll(async () => {
  tracker = track(await createInstance());
});

function expectValidMesh(mesh: MeshData) {
  const vertexCount = mesh.positions.length / 3;
  expect(mesh.normals.length).toBe(mesh.positions.length);
  expect(mesh.indices.length % 3).toBe(0);
  for (const index of mesh.indices) expect(index).toBeLessThan(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const [x, y, z] = [mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!];
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 3);
  }
  // Face ranges tile the index buffer in order, with no gaps.
  let next = 0;
  for (let f = 0; f < mesh.faceRanges.length / 2; f++) {
    expect(mesh.faceRanges[f * 2]).toBe(next);
    next += mesh.faceRanges[f * 2 + 1]!;
  }
  expect(next).toBe(mesh.indices.length);
}

describe('OCCT pipeline', () => {
  it('fillets all 12 box edges into 26 faces', () => {
    const mesh = runPipeline(tracker.oc, { ...CASES.box, parallel: false });
    expect(mesh.stats.filletedEdges).toBe(12);
    expect(mesh.stats.faces).toBe(26);
    expectValidMesh(mesh);
  });

  it('fillets 30 edges on the bracket', () => {
    const mesh = runPipeline(tracker.oc, { ...CASES.bracket, parallel: false });
    expect(mesh.stats.filletedEdges).toBe(30);
    expectValidMesh(mesh);
  });

  it('outward normals: box face normals point away from the centre', () => {
    const mesh = runPipeline(tracker.oc, { ...CASES.box, parallel: false });
    const centre = [20, 15, 10];
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const d = [0, 1, 2].map((k) => mesh.positions[i * 3 + k]! - centre[k]!);
      const dot = d.reduce((acc, dk, k) => acc + dk * mesh.normals[i * 3 + k]!, 0);
      expect(dot).toBeGreaterThan(0);
    }
  });

  for (const memory of ['strict', 'mitigated'] as const) {
    it(`${memory}: deletes every embind object it creates`, () => {
      tracker.reset();
      runPipeline(tracker.oc, { ...CASES.bracket, parallel: false, memory });
      expect(tracker.created()).toBeGreaterThan(1000);
      expect(tracker.liveNames()).toEqual([]);
    });
  }

  it('deletes everything when OCCT throws mid-pipeline', () => {
    tracker.reset();
    expect(() =>
      runPipeline(tracker.oc, { ...CASES.box, linearDeflection: 0, parallel: false }),
    ).toThrow(/Standard_NumericError/);
    expect(tracker.created()).toBeGreaterThan(10);
    expect(tracker.live()).toBe(0);
  });

  it('the control mode really leaks, so the tracker can see leaks', () => {
    tracker.reset();
    runPipeline(tracker.oc, { ...CASES.box, parallel: false, memory: 'none' });
    expect(tracker.live()).toBe(tracker.created());
  });
});
