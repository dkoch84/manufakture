import type { ManufaktureDocument } from '@manufakture/core';
import { buildMeshes, meshProperties, parseStl, validate3mf, type TriMesh } from '@manufakture/io';
import type { KernelOp } from '@manufakture/kernel';
import type { KernelClient } from '@manufakture/kernel/kernel-client';
import { describe, expect, it, vi } from 'vitest';
import { insertCommand } from '../assembly/assembly';
import {
  A,
  LIFTED,
  apply,
  box,
  instanceResult,
  lid,
  model,
  result,
  twoInstances,
} from '../assembly/assembly.test-fixture';
import type { ModelState } from '../model/model';
import { boxBody } from '../viewport/testMeshes';
import { assemblyExportPlan, exportAssembly, type AssemblyExportPlan } from './assemblyExport';
import { kernelExchange, type Exchanger, type KernelBody } from './exchange';
import { REFUSED_REVIEWS, agentSource } from './exportGate.test-fixture';
import { UNREVIEWED_EXPORT } from '@manufakture/io';

/** Main: the export gate (T8.3c) lets every export here through. */
const MAIN = { id: 'main' };

/** The fixture's box and lid, and a second box turned a quarter about z and moved along x. */
const TURNED = {
  translation: [100, 0, 0] as [number, number, number],
  rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
};

function threeInstances(): {
  doc: ManufaktureDocument;
  model: Pick<ModelState, 'parts' | 'assemblies' | 'sources'>;
} {
  let doc = twoInstances();
  doc = apply(doc, insertCommand(doc.assemblies[0]!, { part: 'part#1' }, 'Box').command);
  const solved = result();
  solved.instances.push(instanceResult('inst#3', 'part#1', { transform: TURNED }));
  return { doc, model: model([solved]) };
}

function plan(doc: ManufaktureDocument, m: Pick<ModelState, 'parts' | 'assemblies' | 'sources'>) {
  const r = assemblyExportPlan(doc, A, m);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** A fake kernel exchange: every instance body of a part meshes as that part's box. */
function fakeExchanger(): Exchanger & {
  tessellate: ReturnType<typeof vi.fn>;
  exportStep: ReturnType<typeof vi.fn>;
} {
  const meshOf = (id: string) => (id.includes('inst#2') ? lid.mesh : box.mesh);
  return {
    bodies: () => [],
    tessellate: vi.fn(async (ids: readonly string[], _d: unknown, names?: Map<string, string>) => ({
      ok: true as const,
      value: ids.map((id) => ({ name: names?.get(id) ?? id, mesh: meshOf(id) })),
    })),
    exportStep: vi.fn(async () => ({
      ok: true as const,
      value: new TextEncoder().encode('ISO-10303-21;'),
    })),
    importStep: vi.fn(),
    retain: vi.fn(() => []),
    reimport: vi.fn(async () => []),
  };
}

const volumeOf = (m: TriMesh) => meshProperties(m).volume;

describe('assemblyExportPlan', () => {
  it('writes each part once, through its first instance, and every instance with its pose', () => {
    const { doc, model: m } = threeInstances();
    const p = plan(doc, m);
    expect(p).toEqual({
      name: 'Assembly 1',
      bodies: [
        { id: 'assembly#1/inst#1/extrude#1', name: 'Box' },
        { id: 'assembly#1/inst#2/extrude#1', name: 'Lid' },
      ],
      parts: [
        { name: 'Box', bodies: [0] },
        { name: 'Lid', bodies: [1] },
      ],
      instances: [
        { part: 0, name: 'Box 1', pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
        { part: 1, name: 'Lid 1', pose: LIFTED },
        { part: 0, name: 'Box 2', pose: TURNED },
      ],
      skipped: [],
    } satisfies AssemblyExportPlan);
  });

  it('leaves out suppressed instances, and names the ones regen could not build', () => {
    const { doc, model: m } = threeInstances();
    const solved = m.assemblies[0]!;
    const broken = {
      ...m,
      assemblies: [
        {
          ...solved,
          instances: [
            solved.instances[0]!,
            { ...solved.instances[1]!, status: 'suppressed' as const },
            { ...solved.instances[2]!, status: 'error' as const },
          ],
        },
      ],
    };
    const p = plan(doc, broken);
    expect(p.instances.map((i) => i.name)).toEqual(['Box 1']);
    expect(p.parts.map((x) => x.name)).toEqual(['Box']);
    expect(p.skipped).toEqual(['Box 2']);
  });

  it('a part of several bodies lists them, named; a pinned part is named after its version', () => {
    const { doc } = threeInstances();
    const two = {
      partId: 'part#1',
      features: [],
      bodies: ['extrude#1', 'extrude#2'].map((bodyId) => ({
        bodyId,
        creator: bodyId,
        solids: 1,
        view: boxBody({ id: `part#1/${bodyId}` }),
      })),
    };
    const pinned = {
      key: 'source:abc:part#1',
      partId: 'part#1',
      documentName: 'Hinge',
      versionName: 'v2',
      bodies: [two.bodies[0]!],
    };
    const solved = result({
      instances: [
        instanceResult('inst#1', 'part#1', { bodies: ['extrude#1', 'extrude#2'] }),
        instanceResult('inst#2', 'part#2', {
          source: { source: pinned.key },
          bodies: ['extrude#1'],
        }),
      ],
    });
    const p = plan(doc, { parts: [two], assemblies: [solved], sources: [pinned] });
    expect(p.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Hinge (v2)']);
    expect(p.parts).toEqual([
      { name: 'Box', bodies: [0, 1] },
      { name: 'Hinge (v2)', bodies: [2] },
    ]);
  });

  it('names a part in another configuration row after the part and the row, a pinned one after its version and row', () => {
    const { doc } = threeInstances();
    const body = {
      bodyId: 'extrude#1',
      creator: 'extrude#1',
      solids: 1,
      view: boxBody({ id: 'x/extrude#1' }),
    };
    const wide = {
      key: 'part:part#1:row:cfg#2',
      partId: 'part#1',
      documentName: '',
      versionName: '',
      partName: 'Box',
      row: { id: 'cfg#2', name: 'Wide' },
      local: true as const,
      bodies: [body],
    };
    const pinned = {
      key: 'source:abc:part#1:row:cfg#1',
      partId: 'part#1',
      documentName: 'Hinge',
      versionName: 'v2',
      row: { id: 'cfg#1', name: 'Small' },
      bodies: [body],
    };
    const solved = result({
      instances: [
        instanceResult('inst#1', 'part#1'),
        instanceResult('inst#2', 'part#1', { source: { source: wide.key } }),
        instanceResult('inst#3', 'part#1', { source: { source: pinned.key } }),
      ],
    });
    const m = model([solved]);
    const p = plan(doc, { ...m, sources: [wide, pinned] });
    // Each row is a part of its own.
    expect(p.parts.map((x) => x.name)).toEqual(['Box', 'Box (Wide)', 'Hinge (v2, Small)']);
    expect(p.instances.map((i) => i.part)).toEqual([0, 1, 2]);
  });

  it('refuses an assembly that is unknown, unsolved or has nothing to write', () => {
    const { doc, model: m } = threeInstances();
    expect(assemblyExportPlan(doc, 'assembly#9', m).message).toBe(
      'There is no assembly assembly#9.',
    );
    expect(assemblyExportPlan(doc, A, { ...m, assemblies: [] }).message).toBe(
      'Assembly 1 has not been solved yet.',
    );
    expect(
      assemblyExportPlan(doc, A, { ...m, assemblies: [result({ instances: [] })] }).message,
    ).toBe('Assembly 1 has no instances to export.');
  });
});

describe('exportAssembly', () => {
  it('3MF: meshed once, an object per body per instance, each placed by its build item', async () => {
    const { doc, model: m } = threeInstances();
    const ex = fakeExchanger();
    const r = await exportAssembly(ex, '3mf', plan(doc, m), { source: MAIN, tolerance: 'fine' });
    if (!r.ok) throw new Error(r.message);
    expect(ex.tessellate).toHaveBeenCalledWith(
      ['assembly#1/inst#1/extrude#1', 'assembly#1/inst#2/extrude#1'],
      { linear: 0.005, angular: 0.1 },
      expect.any(Map),
    );
    expect(r.value.map((f) => [f.name, f.type])).toEqual([['Assembly 1.3mf', 'model/3mf']]);
    expect(r.message).toMatch(/^Exported Assembly 1\.3mf \(.*\): 3 instances of 2 parts\.$/);
    const report = validate3mf(r.value[0]!.bytes);
    expect(report.problems).toEqual([]);
    expect(report.parsed!.objects.map((o) => o.name)).toEqual(['Box', 'Lid', 'Box']);
    expect(report.parsed!.items.map((i) => i.objectId)).toEqual([1, 2, 3]);
    const built = buildMeshes(report.parsed!);
    const turned = meshProperties(built[2]!.mesh).boundingBox!;
    // The 40 x 30 box turned a quarter about z: x -30..0, y 0..40; then 100 along x.
    turned.min.forEach((v, i) => expect(v).toBeCloseTo([70, 0, 0][i]!, 4));
    turned.max.forEach((v, i) => expect(v).toBeCloseTo([100, 40, 20][i]!, 4));
    expect(meshProperties(built[1]!.mesh).boundingBox!.min[2]).toBeCloseTo(20, 4);
  });

  it('STL: every instance placed, in one file', async () => {
    const { doc, model: m } = threeInstances();
    const r = await exportAssembly(fakeExchanger(), 'stl', plan(doc, m), { source: MAIN });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.map((f) => [f.name, f.type])).toEqual([['Assembly 1.stl', 'model/stl']]);
    const mesh = parseStl(r.value[0]!.bytes).mesh;
    expect(volumeOf(mesh)).toBeCloseTo(2 * 40 * 30 * 20 + 40 * 30 * 5, 1);
  });

  it('STEP: the kernel gets the bodies once and the assembly layout', async () => {
    const { doc, model: m } = threeInstances();
    const ex = fakeExchanger();
    const p = plan(doc, m);
    const r = await exportAssembly(ex, 'step', p, { source: MAIN });
    if (!r.ok) throw new Error(r.message);
    expect(r.value[0]).toMatchObject({ name: 'Assembly 1.step', type: 'model/step' });
    expect(ex.exportStep).toHaveBeenCalledWith(
      ['assembly#1/inst#1/extrude#1', 'assembly#1/inst#2/extrude#1'],
      new Map([
        ['assembly#1/inst#1/extrude#1', 'Box'],
        ['assembly#1/inst#2/extrude#1', 'Lid'],
      ]),
      { name: 'Assembly 1', parts: p.parts, instances: p.instances },
    );
  });

  it('refuses one file per body, and passes on a kernel failure', async () => {
    const { doc, model: m } = threeInstances();
    const ex = fakeExchanger();
    expect((await exportAssembly(ex, 'stl-each', plan(doc, m), { source: MAIN })).message).toMatch(
      /exported as one file/,
    );
    ex.exportStep.mockResolvedValueOnce({ ok: false, message: 'STEP export failed: boom' });
    expect(await exportAssembly(ex, 'step', plan(doc, m), { source: MAIN })).toEqual({
      ok: false,
      message: 'STEP export failed: boom',
    });
  });

  it('through the real kernel exchange, the exportStep op carries the assembly', async () => {
    const sent: KernelOp[][] = [];
    const client = {
      latestGeneration: 4,
      release: vi.fn(),
      submit: vi.fn(async (ops: readonly KernelOp[]) => {
        sent.push([...ops]);
        return {
          status: 'done',
          names: [],
          generation: 4,
          results: [{ ok: true, op: 'exportStep', value: { data: new Uint8Array([1, 2]) }, ms: 1 }],
        };
      }),
    } as unknown as KernelClient;
    const registry = new Map<string, KernelBody>([
      ['assembly#1/inst#1/extrude#1', { shape: 7 as never, name: 'Box 1', role: 'part' }],
      ['assembly#1/inst#2/extrude#1', { shape: 8 as never, name: 'Lid 1', role: 'part' }],
      ['assembly#1/inst#3/extrude#1', { shape: 7 as never, name: 'Box 2', role: 'part' }],
    ]);
    const { exchanger } = kernelExchange(() => client, registry);
    const { doc, model: m } = threeInstances();
    const p = plan(doc, m);
    const r = await exportAssembly(exchanger, 'step', p, { source: MAIN });
    if (!r.ok) throw new Error(r.message);
    expect(sent).toEqual([
      [
        {
          op: 'exportStep',
          bodies: [
            { shape: 7, name: 'Box' },
            { shape: 8, name: 'Lid' },
          ],
          assembly: { name: 'Assembly 1', parts: p.parts, instances: p.instances },
        },
      ],
    ]);
    // A plain export sends no assembly.
    await exchanger.exportStep(['assembly#1/inst#1/extrude#1']);
    expect(sent[1]![0]).not.toHaveProperty('assembly');
  });
});

describe('exportAssembly behind the export gate', () => {
  it('writes no STL, 3MF or STEP of an assembly from an agent’s unreviewed branch', async () => {
    const { doc, model: m } = threeInstances();
    for (const format of ['stl', '3mf', 'step'] as const) {
      for (const review of REFUSED_REVIEWS) {
        const ex = fakeExchanger();
        expect(
          await exportAssembly(ex, format, plan(doc, m), { source: agentSource(review) }),
        ).toEqual({ ok: false, message: UNREVIEWED_EXPORT });
        expect(ex.tessellate).not.toHaveBeenCalled();
        expect(ex.exportStep).not.toHaveBeenCalled();
      }
      const ok = await exportAssembly(fakeExchanger(), format, plan(doc, m), {
        source: agentSource('approved'),
      });
      expect(ok.ok).toBe(true);
    }
  });
});
