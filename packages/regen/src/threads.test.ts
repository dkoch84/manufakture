// Threads in regen (M3 plan, T3.2f): translation to the kernel's thread on a face, and end to end
// with the real kernel and solver: modelled and cosmetic threads on a shaft and in a hole, names
// that stay exact through a length change, a wrong-size cylinder failing with the range, and the
// cache keeping the thread from rebuilding on an unrelated edit.

import {
  DocumentStore,
  type ChangeEvent,
  type Command,
  type SketchFeature,
  type ThreadFeature,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { BODY_KINDS, buildGraph } from './graph';
import {
  add,
  apply,
  build,
  extrude,
  mm,
  rectangle,
  setVariable,
  statuses,
  unwrap,
} from './test-helpers';
import { translateFeature } from './translate';
import type { FeatureResult, RegenResult } from './types';

function thread(extra: Partial<ThreadFeature> = {}): ThreadFeature {
  return {
    id: 'thread#1',
    kind: 'thread',
    name: 'Thread 1',
    suppressed: false,
    face: { id: 'r1', ref: { face: 'extrude#1:side:e1' } },
    length: 'full',
    standard: { system: 'iso-metric', size: 'M6' },
    hand: 'right',
    clearance: mm('0.2'),
    representation: 'modelled',
    ...extra,
  };
}

function translate(f: ThreadFeature, values: Record<string, number>) {
  return translateFeature(f, {
    values: new Map(Object.entries(values)),
    sketches: new Map(),
    inputs: new Map(),
  });
}

describe('translation', () => {
  it('passes the face, the standard sizes and half the clearance to the kernel', () => {
    const r = translate(
      thread({
        start: { id: 'r2', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } },
        length: mm('8'),
        hand: 'left',
        representation: 'cosmetic',
      }),
      { length: 8, clearance: 0.2 },
    );
    expect(r).toEqual({
      ok: true,
      input: {
        kind: 'thread',
        id: 'thread#1',
        face: { id: 'r1', ref: { face: 'extrude#1:side:e1' } },
        start: { id: 'r2', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } },
        length: 8,
        major: 6,
        pitch: 1,
        tapDrill: 5,
        hand: 'left',
        clearance: 0.1,
        representation: 'cosmetic',
        label: 'M6',
      },
    });
  });

  it('finds UNC sizes with or without their threads per inch', () => {
    for (const size of ['1/4', '1/4-20']) {
      const r = translate(thread({ standard: { system: 'unc', size } }), { clearance: 0 });
      expect(r.ok && r.input.kind === 'thread' && 'face' in r.input && r.input.label).toBe(
        '1/4-20',
      );
    }
  });

  it('refuses an unknown size, a negative clearance and a length of zero', () => {
    expect(
      translate(thread({ standard: { system: 'unc', size: 'M6' } }), { clearance: 0 }),
    ).toEqual({
      ok: false,
      errors: [
        {
          code: 'invalid',
          field: ['standard', 'size'],
          message: 'M6 is not an UNC thread size this version knows',
        },
      ],
    });
    const negative = translate(thread(), { clearance: -0.1 });
    expect(negative).toMatchObject({ ok: false, errors: [{ field: ['clearance'] }] });
    const zero = translate(thread({ length: mm('0') }), { clearance: 0.2, length: 0 });
    expect(zero).toMatchObject({ ok: false, errors: [{ field: ['length'] }] });
  });
});

// End to end ----------------------------------------------------------------------------------

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

/** A circle of diameter `d` centred at the origin of the XY plane, as entity `e1`. */
function circleSketch(id: string, d: string): SketchFeature {
  return {
    id,
    kind: 'sketch',
    name: id,
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: [
      { id: 'e1', kind: 'circle', construction: false, center: [0, 0], radius: 3 },
      { id: 'e2', kind: 'point', construction: true, position: [0, 0] },
    ],
    constraints: [
      { id: 'k1', kind: 'fix', point: { entity: 'e2' } },
      { id: 'k2', kind: 'coincident', a: { entity: 'e1', at: 'center' }, b: { entity: 'e2' } },
      { id: 'k3', kind: 'diameter', entity: 'e1', value: mm(d) },
    ],
  };
}

/** A shaft of diameter `d` (variable `dia`), 12 mm long, threaded M6. */
function shaftDoc(d: string, t: Partial<ThreadFeature> = {}, more: Command[] = []) {
  return build([
    setVariable('dia', d),
    setVariable('len', '12'),
    add(circleSketch('sketch#1', 'dia')),
    add(extrude('extrude#1', 'sketch#1', 'len')),
    ...more,
    add(thread(t)),
  ]);
}

/** A 20 x 20 x 10 block with a centred hole of diameter `d` (`extrude#1:side:e5`). */
function blockDoc(d: string, t: Partial<ThreadFeature> = {}) {
  const sketch = rectangle('sketch#1', { width: '20', depth: '20', at: [-10, -10] });
  sketch.entities.push({
    id: 'e5',
    kind: 'circle',
    construction: false,
    center: [0, 0],
    radius: 2.5,
  });
  sketch.entities.push({ id: 'e6', kind: 'point', construction: true, position: [0, 0] });
  sketch.constraints.push(
    { id: 'k20', kind: 'fix', point: { entity: 'e6' } },
    { id: 'k21', kind: 'coincident', a: { entity: 'e5', at: 'center' }, b: { entity: 'e6' } },
    { id: 'k22', kind: 'diameter', entity: 'e5', value: mm(d) },
  );
  return build([
    add(sketch),
    add(extrude('extrude#1', 'sketch#1', '10')),
    add(thread({ face: { id: 'r1', ref: { face: 'extrude#1:side:e5' } }, ...t })),
  ]);
}

function threadResult(result: RegenResult): FeatureResult {
  return result.parts[0]!.features.find((f) => f.featureId === 'thread#1')!;
}

function faceNames(result: RegenResult): string[] {
  const mesh = result.parts[0]!.bodies[0]!.mesh!;
  return Array.from(mesh.faceNames, (slot) => result.names[slot]!);
}

describe('threads with the real kernel', () => {
  it('builds a modelled thread on a shaft and one in a hole', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const shaft = (await engine.regen(shaftDoc('6')))!;
    expect(statuses(shaft)['thread#1']).toBe('ok');
    expect(threadResult(shaft).thread).toMatchObject({
      bodyId: 'extrude#1',
      side: 'external',
      representation: 'modelled',
      radius: 3,
      length: 12,
      pitch: 1,
    });
    expect(faceNames(shaft).some((n) => n.startsWith('thread#1:thread:root:'))).toBe(true);
    expect(threadResult(shaft).references).toEqual([
      { referenceId: 'r1', target: 'extrude#1:side:e1', via: 'exact', fragile: false },
    ]);

    const hole = (await engine.regen(blockDoc('4.917')))!;
    expect(statuses(hole)['thread#1']).toBe('ok');
    expect(threadResult(hole).thread).toMatchObject({ side: 'internal', length: 10 });
    expect(faceNames(hole).some((n) => n.startsWith('thread#1:thread:flank-a:'))).toBe(true);
  }, 120_000);

  it('builds cosmetic threads by resizing the cylinder, and reports them', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const shaft = (await engine.regen(shaftDoc('6', { representation: 'cosmetic' })))!;
    expect(statuses(shaft)['thread#1']).toBe('ok');
    // The major diameter less the (diametral) clearance: 5.8 mm.
    expect(threadResult(shaft).thread).toMatchObject({ representation: 'cosmetic', radius: 2.9 });
    expect(faceNames(shaft)).toContain('thread#1:thread:cosmetic');

    const hole = (await engine.regen(blockDoc('5.5', { representation: 'cosmetic' })))!;
    expect(statuses(hole)['thread#1']).toBe('ok');
    // The tap drill: 5 mm.
    expect(threadResult(hole).thread).toMatchObject({ side: 'internal', radius: 2.5 });
    expect(faceNames(hole)).toContain('thread#1:thread:cosmetic');
    expect(faceNames(hole)).not.toContain('extrude#1:side:e5');
  }, 120_000);

  it('keeps the thread names exact through a length change', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const start = { id: 'r2', ref: { faces: ['extrude#1:cap:start', 'extrude#1:side:e1'] } };
    const store = unwrap(
      DocumentStore.create(shaftDoc('6', { length: mm('tl'), start }, [setVariable('tl', '6')])),
    );
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    const first = (await engine.regen(store.document))!;
    expect(statuses(first)['thread#1']).toBe('ok');
    const turns = (r: RegenResult) =>
      new Set(faceNames(r).filter((n) => /^thread#1:thread:(root|flank-a|flank-b):[1-4]$/.test(n)));
    unwrap(store.execute(setVariable('tl', '8')));
    const second = (await engine.update(events.at(-1)!))!;
    expect(statuses(second)['thread#1']).toBe('ok');
    expect(turns(first).size).toBeGreaterThan(0);
    expect(turns(second)).toEqual(turns(first));
    expect(threadResult(second).thread!.length).toBe(8);
    // Only the thread was rebuilt.
    expect(second.counters).toMatchObject({ featureOps: 1, cacheHits: 2 });
  }, 120_000);

  it('fails a cylinder the size cannot be cut into, naming the range on the face', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const result = (await engine.regen(shaftDoc('10')))!;
    const f = threadResult(result);
    expect(f.status).toBe('error');
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toMatchObject({ code: 'invalid', referenceId: 'r1' });
    expect(f.errors[0]!.message).toMatch(
      /^M6 \(external\) needs a shaft [\d.]+ to 8 mm across; extrude#1:side:e1 is 10 mm$/,
    );
    expect(f.thread).toBeUndefined();
    // The body passes through unchanged.
    expect(result.parts[0]!.bodies).toHaveLength(1);
  }, 120_000);

  it('serves the thread from the cache on an edit that does not reach it', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = shaftDoc('6', {}, [setVariable('unused', '1')]);
    const store = unwrap(DocumentStore.create(doc));
    const events: ChangeEvent[] = [];
    store.subscribe((e) => events.push(e));
    const first = (await engine.regen(store.document))!;
    expect(statuses(first)['thread#1']).toBe('ok');
    unwrap(store.execute(setVariable('unused', '2')));
    const second = (await engine.update(events.at(-1)!))!;
    expect(second.counters.featureOps).toBe(0);
    expect(threadResult(second).cached).toBe(true);
    // The report comes back with the cached result.
    expect(threadResult(second).thread).toEqual(threadResult(first).thread);
  }, 120_000);

  it('acts on the body owning its face, like a fillet, depending on what changed that body', () => {
    // A body kind: it changes an existing body rather than adding one.
    expect(BODY_KINDS.has('thread')).toBe(true);
    const doc = apply(shaftDoc('6'));
    const graph = buildGraph(doc.parts[0]!, doc.variables);
    expect(graph.depends.get('thread#1')).toEqual(['extrude#1']);
    expect(graph.body.get('thread#1')).toEqual(['extrude#1']);
    expect(graph.variables.get('thread#1')).toEqual([]);
  });
});
