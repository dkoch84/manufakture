import { createDocument, type ManufaktureDocument } from '@manufakture/core';
import { IDENTITY_MATRIX, placementMatrix, readMfkview } from '@manufakture/io';
import { describe, expect, it, vi } from 'vitest';
import { insertCommand } from '../assembly/assembly';
import {
  A,
  LIFTED,
  apply,
  box,
  instanceResult,
  model,
  result,
  twoInstances,
} from '../assembly/assembly.test-fixture';
import type { Measurer } from '../measure/measurer';
import { partBodies } from '../model/bodies';
import type { PartModel } from '../model/model';
import { fillPlaceholderNames } from '../viewport/naming';
import { boxBody } from '../viewport/testMeshes';
import {
  assemblyPublishPlan,
  partPublishPlan,
  publishView,
  publishedMesh,
  type PublishPlan,
} from './publishView';

const TURNED = {
  translation: [100, 0, 0] as [number, number, number],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
};

/** A part studio "Bracket" of two bodies, the second hidden or not, made of PLA. */
function bracketPart(hidden: string[] = []) {
  let doc = createDocument({ id: 'd', name: 'Doc' });
  doc = apply(
    doc,
    { type: 'renamePart', partId: 'part#1', name: 'Bracket' },
    { type: 'setMaterial', partId: 'part#1', material: 'pla' },
  );
  const views = [
    boxBody({ id: 'part#1/extrude#1', size: [40, 30, 20] }),
    boxBody({ id: 'part#1/extrude#2', min: [50, 0, 0], size: [10, 10, 10] }),
  ];
  const partModel: PartModel = {
    partId: 'part#1',
    features: [],
    bodies: views.map((view, i) => ({
      bodyId: `extrude#${i + 1}`,
      creator: `extrude#${i + 1}`,
      solids: 1,
      view,
    })),
  };
  const bodies = partBodies(doc.parts[0], partModel, new Set(hidden));
  return { doc, bodies };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** A Measure tool that knows exact volumes by viewport id. */
function measurerOf(
  volumes: Record<string, number>,
): Measurer & { measure: ReturnType<typeof vi.fn> } {
  return {
    measure: vi.fn(async (bodyId: string) => {
      const volume = volumes[bodyId];
      if (volume === undefined) return { ok: false as const, message: 'unknown' };
      return {
        ok: true as const,
        result: {
          items: [],
          distance: null,
          angle: null,
          body: { volume, area: 0, centerOfMass: [0, 0, 0], boundingBox: null },
        },
      };
    }),
  } as never;
}

describe('partPublishPlan', () => {
  it('publishes the shown bodies as one part at the identity', () => {
    const { doc, bodies } = bracketPart(['part#1/extrude#2']);
    const plan = ok(partPublishPlan(doc, 'part#1', bodies));
    expect(plan).toMatchObject({
      name: 'Bracket',
      kind: 'part',
      parts: [{ name: 'Bracket', bodies: [0] }],
      instances: [{ name: 'Bracket', part: 0, transform: [...IDENTITY_MATRIX] }],
    });
    expect(plan.bodies.map((b) => [b.viewId, b.name, b.material])).toEqual([
      ['part#1/extrude#1', 'Body 1', 'pla'],
    ]);
  });

  it('says why when there is nothing to publish', () => {
    const { doc, bodies } = bracketPart(['part#1/extrude#1', 'part#1/extrude#2']);
    expect(partPublishPlan(doc, 'part#1', bodies)).toEqual({
      ok: false,
      message: 'Every body is hidden: show one to publish it.',
    });
    expect(partPublishPlan(doc, 'part#1', [])).toMatchObject({ ok: false });
  });
});

describe('publishView', () => {
  it('writes a bundle that reads back with the meshes, names, colours, volumes and masses', async () => {
    const { doc, bodies } = bracketPart();
    const plan = ok(partPublishPlan(doc, 'part#1', bodies));
    const measurer = measurerOf({ 'part#1/extrude#1': 24000 });
    const r = await publishView(plan, { displayUnits: 'in', measurer });
    const [file] = ok(r);
    expect(file!.name).toBe('Bracket.mfkview');
    expect(file!.type).toBe('application/vnd.manufakture.view+zip');
    expect(r.ok && r.message).toMatch(/^Published Bracket\.mfkview \(.+\): 2 bodies\.$/);
    const view = readMfkview(file!.bytes);
    expect(view.manifest.units).toEqual({ length: 'mm', display: 'in' });
    expect(view.readSource()).toBeNull();
    const [first, second] = view.manifest.bodies;
    // The kernel's exact volume for the first body; the mesh's for the second, which the
    // Measure tool does not know. PLA at 1240 kg/m3.
    expect(first).toMatchObject({ name: 'Body 1', color: '#c2cad3', volume: 24000 });
    expect(first!.material).toEqual({ id: 'pla', name: 'PLA', density: 1240 });
    expect(first!.mass).toBeCloseTo(29.76, 9);
    expect(second!.volume).toBeCloseTo(1000, 6);
    expect(second!.color).toBe('#8fb8de');
    expect(measurer.measure).toHaveBeenCalledWith('part#1/extrude#1', [], true);
    // Meshes and names as the viewport holds them.
    const mesh = view.meshes[0]!;
    const want = publishedMesh(bodies[0]!.view);
    expect(mesh.positions).toEqual(want.positions);
    expect(mesh.indices).toEqual(want.indices);
    expect(mesh.normals).toEqual(want.normals);
    expect(mesh.faceNames).toEqual(want.faceNames);
    expect(mesh.faceNames[0]).toBe('part#1/extrude#1/left');
    expect(mesh.edgeNames).toEqual(want.edgeNames);
  });

  it('includes the source when asked, and works without a kernel', async () => {
    const { doc, bodies } = bracketPart();
    const plan = ok(partPublishPlan(doc, 'part#1', bodies));
    const source = new Uint8Array([1, 2, 3, 4]);
    const r = await publishView(plan, { source, measurer: null });
    expect(r.ok && r.message).toMatch(/, with its source\.$/);
    const view = readMfkview(ok(r)[0]!.bytes);
    expect(view.readSource()).toEqual(source);
    expect(view.manifest.bodies[0]!.volume).toBeCloseTo(24000, 6);
  });

  it('falls back to the mesh volume when the Measure tool fails', async () => {
    const { doc, bodies } = bracketPart();
    const plan = ok(partPublishPlan(doc, 'part#1', bodies));
    const measurer = { measure: vi.fn(async () => Promise.reject(new Error('gone'))) };
    const view = readMfkview(ok(await publishView(plan, { measurer }))[0]!.bytes);
    expect(view.manifest.bodies[0]!.volume).toBeCloseTo(24000, 6);
  });

  it('writes placeholder names as no name', () => {
    const unnamed = boxBody({ id: 'b', named: false });
    const view = { ...unnamed, names: fillPlaceholderNames(unnamed.mesh, unnamed.names) };
    const mesh = publishedMesh(view);
    expect(mesh.faceNames.every((n) => n === null)).toBe(true);
    expect(mesh.edgeNames.every((n) => n === null)).toBe(true);
  });

  it('reports a bundle that cannot be written instead of throwing', async () => {
    const { doc, bodies } = bracketPart();
    const plan: PublishPlan = { ...ok(partPublishPlan(doc, 'part#1', bodies)), instances: [] };
    const r = await publishView(plan);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/cannot be published: part 0 has no instance/);
  });
});

describe('assemblyPublishPlan', () => {
  function threeInstances(): { doc: ManufaktureDocument; m: ReturnType<typeof model> } {
    let doc = twoInstances();
    doc = apply(doc, insertCommand(doc.assemblies[0]!, { part: 'part#1' }, 'Box').command);
    doc = apply(doc, { type: 'setMaterial', partId: 'part#1', material: 'pla' });
    const solved = result();
    solved.instances.push(instanceResult('inst#3', 'part#1', { transform: TURNED }));
    return { doc, m: model([solved]) };
  }

  it('publishes each part once and every instance at its solved pose', async () => {
    const { doc, m } = threeInstances();
    const plan = ok(assemblyPublishPlan(doc, A, m));
    expect(plan.kind).toBe('assembly');
    expect(plan.parts).toEqual([
      { name: 'Box', bodies: [0] },
      { name: 'Lid', bodies: [1] },
    ]);
    expect(plan.bodies.map((b) => [b.viewId, b.name, b.material])).toEqual([
      ['assembly#1/inst#1/extrude#1', 'Box', 'pla'],
      ['assembly#1/inst#2/extrude#1', 'Lid', null],
    ]);
    expect(plan.instances).toEqual([
      {
        name: 'Box 1',
        part: 0,
        transform: placementMatrix({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] }),
      },
      { name: 'Lid 1', part: 1, transform: placementMatrix(LIFTED) },
      { name: 'Box 2', part: 0, transform: placementMatrix(TURNED) },
    ]);
    const r = await publishView(plan);
    expect(r.ok && r.message).toMatch(/: 3 instances of 2 parts\.$/);
    const view = readMfkview(ok(r)[0]!.bytes);
    expect(view.manifest.instances.map((i) => i.part)).toEqual([0, 1, 0]);
    expect(view.meshes[0]!.positions).toEqual(box.mesh.positions);
    expect(view.manifest.bodies[0]!.mass).toBeCloseTo(24000 * 1240 * 1e-6, 6);
    expect(view.manifest.bodies[1]!.mass).toBeNull();
  });

  it('passes on why an assembly cannot be published', () => {
    const doc = twoInstances();
    expect(assemblyPublishPlan(doc, A, model([]))).toMatchObject({ ok: false });
  });
});
