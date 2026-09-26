// STEP export and import against the real libcascade, in Node: round trips
// (volume, face count, bounding box), product names and units in the file,
// the `import` feature (fragile face names, booleans against the body), the
// `exportStep` and `importStep` ops through the service, and no leaked
// embind objects. One instance per describe block that needs its own.

import { beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
import { MAX_STEP_BYTES } from './exchange';
import { applyFeature, type ExtrudeInput, type ImportInput } from './features';
import {
  XY,
  build,
  circle,
  expectGolden,
  faceNames,
  named,
  profile,
  rectangle,
} from './fixtures/parts';
import { Kernel } from './kernel';
import { isPositional, pickFace, resolveFace } from './naming';
import { createNodeInstance, createNodeKernel, createNodeService } from './node';
import { collectTransferables, type KernelService } from './service';
import { track, type Tracker } from './track';
import type { ShapeId } from './types';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The demo part of the app: a 60 x 40 x 20 block, every edge filleted at 3, a hole of radius 8. */
function demoPart(kernel: Kernel): ShapeId {
  const box = kernel.box(60, 40, 20, [-30, -20, 0]);
  const edges = Array.from({ length: 12 }, (_, i) => i + 1);
  const filleted = kernel.fillet(box, edges, 3, { history: false }).shape;
  const tool = kernel.cylinder(8, 30, [0, 0, -5]);
  const cut = kernel.boolean('cut', filleted, [tool], { history: false }).shape;
  for (const id of [box, filleted, tool]) kernel.release(id);
  return cut;
}

const block: ExtrudeInput = {
  kind: 'extrude',
  id: 'extrude#1',
  profile: profile(XY, rectangle(0, 0, 40, 30)),
  extent: { type: 'blind', distance: 20 },
  mode: 'new',
};

describe('exportStep and importStep', () => {
  it('round trips the demo part: volume, face count and bounding box', () => {
    const part = demoPart(k);
    const before = k.properties(part);
    const step = k.exportStep([{ shape: part, name: 'Demo part' }]);
    const back = k.importStep(step);
    const after = k.properties(back);
    expect(after.valid).toBe(true);
    expect(after.faces).toBe(before.faces);
    expect(after.edges).toBe(before.edges);
    expect(after.vertices).toBe(before.vertices);
    expect(Math.abs(after.volume - before.volume)).toBeLessThan(1e-6 * before.volume);
    expect(Math.abs(after.area - before.area)).toBeLessThan(1e-6 * before.area);
    // Tight boxes from the exact B-rep: the block itself.
    const box = k.measure(back, [], { body: true }).body!.boundingBox!;
    box.min.forEach((v, i) => expect(v).toBeCloseTo([-30, -20, 0][i]!, 6));
    box.max.forEach((v, i) => expect(v).toBeCloseTo([30, 20, 20][i]!, 6));
    k.release(part);
    k.release(back);
  });

  it('writes AP214 in millimetres with one named product per body', () => {
    const a = k.box(10, 20, 30);
    const b = k.cylinder(5, 10, [50, 0, 0]);
    const bytes = k.exportStep([
      { shape: a, name: 'Bracket' },
      { shape: b, name: 'Pin, 5 mm' },
    ]);
    const step = text(bytes);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
    expect(step).toMatch(/LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
    const products = [...step.matchAll(/PRODUCT\('([^']*)'/g)].map((m) => m[1]);
    expect(products).toEqual(['Bracket', 'Pin, 5 mm']);

    // Both come back, as one compound of two solids.
    const back = k.importStep(bytes);
    const p = k.properties(back);
    expect(p.faces).toBe(6 + 3);
    expect(p.volume).toBeCloseTo(10 * 20 * 30 + Math.PI * 25 * 10, 6);
    for (const id of [a, b, back]) k.release(id);
  });

  it('accepts base64 text, as the document stores the file', () => {
    const a = k.box(4, 5, 6);
    const bytes = k.exportStep([{ shape: a, name: 'b64' }]);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const back = k.importStep(btoa(binary));
    expect(k.properties(back).volume).toBeCloseTo(120, 9);
    k.release(a);
    k.release(back);
  });

  it('refuses files that are not STEP, empty input, bad base64 and nothing to export', () => {
    const count = k.shapeCount;
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(KernelError);
        return (e as KernelError).code;
      }
      return null;
    };
    expect(codeOf(() => k.importStep(new TextEncoder().encode('solid x\nendsolid x\n')))).toBe(
      'invalid-argument',
    );
    expect(codeOf(() => k.importStep(new Uint8Array()))).toBe('invalid-argument');
    expect(codeOf(() => k.importStep('***'))).toBe('invalid-argument');
    expect(codeOf(() => k.importStep(new Uint8Array(MAX_STEP_BYTES + 1)))).toBe('invalid-argument');
    expect(codeOf(() => k.importStep('A'.repeat(Math.ceil(MAX_STEP_BYTES / 3) * 4 + 8)))).toBe(
      'invalid-argument',
    );
    expect(codeOf(() => k.exportStep([]))).toBe('invalid-argument');
    const box = k.box(1, 1, 1);
    expect(codeOf(() => k.exportStep([{ shape: box, name: '' }]))).toBe('invalid-argument');
    expect(codeOf(() => k.exportStep([{ shape: 99_999 as ShapeId, name: 'x' }]))).toBe(
      'unknown-shape',
    );
    k.release(box);
    expect(k.shapeCount).toBe(count);
  });
});

describe('the import feature', () => {
  let stepOfPin: Uint8Array;

  beforeAll(() => {
    // A pin standing through the block: radius 4 at (20, 15), z from -5 to 25.
    const pin = k.cylinder(4, 30, [20, 15, -5]);
    stepOfPin = k.exportStep([{ shape: pin, name: 'Pin' }]);
    k.release(pin);
  });

  const importPin = (mode: ImportInput['mode'], id = 'import#2'): ImportInput => ({
    kind: 'import',
    id,
    step: stepOfPin,
    mode,
  });

  it('makes the first body, every face named import#k:face:<n> and fragile', () => {
    const out = applyFeature(k, null, importPin('new', 'import#1'));
    expect(out.errors).toEqual([]);
    expect(out.created).toBe(true);
    const body = named(k, out.shape!);
    expect(faceNames(body)).toEqual(['import#1:face:1', 'import#1:face:2', 'import#1:face:3']);
    expect(body.names.faces.every((f) => f.fragile)).toBe(true);
    expect(body.names.edges.every((e) => e.fragile)).toBe(true);
    expect(isPositional('import#1:face:3')).toBe(true);
    expect(isPositional('pattern#3:i2/import#1:face:3')).toBe(true);
    expect(isPositional('import#1:cap:end')).toBe(false);
    // A reference to an imported face resolves, and says it is fragile.
    const ref = pickFace(body.names, 2);
    expect(ref).toEqual({ face: 'import#1:face:2' });
    expect(resolveFace(body.names, ref!)).toMatchObject({ ok: true, via: 'exact', fragile: true });
    k.release(out.shape!);
  });

  it('can be booleaned against the body: subtract drills the pin out of the block', () => {
    const { shape: blockShape } = build(k, [block]);
    const out = applyFeature(k, blockShape, importPin('subtract'));
    expect(out.errors).toEqual([]);
    expectGolden(k, out.shape!, {
      volume: 40 * 30 * 20 - Math.PI * 16 * 20,
      faces: 7,
      min: [0, 0, 0],
      max: [40, 30, 20],
    });
    const names = faceNames(named(k, out.shape!));
    // The hole wall is the pin's side face, carried through the cut by history.
    expect(names.filter((n) => n.startsWith('import#2:'))).toEqual(['import#2:face:1']);
    expect(names.filter((n) => n.startsWith('extrude#1:')).length).toBe(6);
    k.release(out.shape!);
    k.release(blockShape);
  });

  it('adds and intersects like any tool', () => {
    const { shape: blockShape } = build(k, [block]);
    const added = applyFeature(k, blockShape, importPin('add'));
    expect(added.errors).toEqual([]);
    expect(k.properties(added.shape!).volume).toBeCloseTo(24_000 + Math.PI * 16 * 10, 6);
    const common = applyFeature(k, blockShape, importPin('intersect'));
    expect(common.errors).toEqual([]);
    expect(k.properties(common.shape!).volume).toBeCloseTo(Math.PI * 16 * 20, 6);
    for (const id of [added.shape!, common.shape!, blockShape]) k.release(id);
  });

  it('fails cleanly on a bad file, passing the body through', () => {
    const { shape: blockShape } = build(k, [block]);
    const count = k.shapeCount;
    const out = applyFeature(k, blockShape, {
      kind: 'import',
      id: 'import#3',
      step: new TextEncoder().encode('not a step file'),
      mode: 'add',
    });
    expect(out.ok).toBe(false);
    expect(out.shape).toBe(blockShape);
    expect(out.errors[0]).toMatchObject({ code: 'invalid', featureId: 'import#3' });
    expect(k.shapeCount).toBe(count);
    const malformed = applyFeature(k, blockShape, {
      kind: 'import',
      id: 'import#4',
      step: 42,
      mode: 'add',
    } as unknown as ImportInput);
    expect(malformed.errors[0]).toMatchObject({ code: 'invalid' });
    k.release(blockShape);
  });

  it('with a body-less subtract, says it needs a body', () => {
    const out = applyFeature(k, null, importPin('subtract'));
    expect(out.errors[0]).toMatchObject({ code: 'no-body' });
  });

  it('keeps a hole through an imported part named after the import', () => {
    const plate = applyFeature(k, null, importPin('new', 'import#1'));
    const drilled = build(
      k,
      [
        {
          kind: 'extrude',
          id: 'extrude#2',
          profile: profile({ ...XY, origin: [0, 0, 10] }, circle([20, 15], 1)),
          extent: { type: 'blind', distance: 5 },
          mode: 'subtract',
        },
      ],
      plate.shape,
    );
    const names = faceNames(named(k, drilled.shape));
    expect(names).toContain('extrude#2:side:c1');
    expect(names.some((n) => n.startsWith('import#1:face:'))).toBe(true);
    k.release(drilled.shape);
    k.release(plate.shape!);
  });
});

describe('the exportStep and importStep ops', () => {
  let service: KernelService;
  let generation = 0;

  beforeAll(async () => {
    service = await createNodeService();
  }, 60_000);

  it('export, then import in one round trip, with the file as a transferable', async () => {
    const reply = await service.run({
      generation: ++generation,
      ops: [
        { op: 'box', size: [10, 10, 10], keep: false },
        { op: 'exportStep', bodies: [{ shape: { result: 0 }, name: 'Cube' }] },
      ],
    });
    expect(reply.status).toBe('done');
    const exported = reply.results[1]!;
    expect(exported.ok).toBe(true);
    const data = (exported as { value: { data: Uint8Array } }).value.data;
    expect(collectTransferables(reply)).toContain(data.buffer);
    // Its own buffer, never a view of the wasm heap: transferring that would detach the heap.
    expect(data.buffer.byteLength).toBe(data.byteLength);
    expect(data.buffer).not.toBe(service.kernel.oc.wasmMemory.buffer);
    expect(text(data)).toContain("PRODUCT('Cube'");

    const back = await service.run({
      generation: ++generation,
      ops: [
        { op: 'importStep', data, keep: false },
        { op: 'properties', shape: { result: 0 } },
      ],
    });
    expect(back.results.every((r) => r.ok)).toBe(true);
    expect((back.results[1] as { value: { volume: number } }).value.volume).toBeCloseTo(1000, 9);
    expect(service.stats().shapeCount).toBe(0);
  });

  it('reports malformed ops and bad files as data', async () => {
    const reply = await service.run({
      generation: ++generation,
      ops: [
        { op: 'importStep', data: 12 } as never,
        { op: 'exportStep', bodies: [] },
        { op: 'importStep', data: new Uint8Array([1, 2, 3]) },
      ],
    });
    expect(reply.results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'invalid-op',
      'invalid-op',
      'invalid-argument',
    ]);
  });
});

describe('no leaks', () => {
  let tracker: Tracker;
  let tk: Kernel;

  beforeAll(async () => {
    tracker = track(await createNodeInstance());
    tk = new Kernel(tracker.oc);
  }, 60_000);

  it('export and import delete every temporary, on success and on failure', () => {
    const box = tk.box(10, 20, 30);
    tracker.reset();
    const step = tk.exportStep([{ shape: box, name: 'Box' }]);
    expect(tracker.created()).toBeGreaterThan(5);
    expect(tracker.liveNames()).toEqual([]);
    const back = tk.importStep(step);
    expect(tracker.liveNames()).toEqual(['TopoDS_Shape']);
    expect(() => tk.importStep(new Uint8Array([60, 61]))).toThrow(KernelError);
    expect(tracker.liveNames()).toEqual(['TopoDS_Shape']);
    // Malformed files from outside: a truncated copy, and a valid header with no data.
    const text = new TextDecoder().decode(step);
    const truncated = new TextEncoder().encode(text.slice(0, Math.floor(text.length / 2)));
    const headerOnly = new TextEncoder().encode(
      text.slice(0, text.indexOf('DATA;')) + 'DATA;\nENDSEC;\nEND-ISO-10303-21;\n',
    );
    for (const bad of [truncated, headerOnly]) {
      try {
        tk.release(tk.importStep(bad));
      } catch (e) {
        expect(e).toBeInstanceOf(KernelError);
      }
      expect(tracker.liveNames()).toEqual(['TopoDS_Shape']);
    }
    tk.release(back);
    tk.release(box);
    expect(tracker.liveNames()).toEqual([]);
    expect(tk.shapeCount).toBe(0);
  });

  it('removes the scratch file when writing it fails part way', () => {
    const fs = tracker.oc.FS;
    const scratch = () => fs.readdir('/tmp').filter((n: string) => n.startsWith('manufakture-'));
    const write = fs.writeFile;
    fs.writeFile = (path, data) => {
      write.call(fs, path, (data as Uint8Array).subarray(0, 4));
      throw new Error('out of memory');
    };
    try {
      expect(() => tk.importStep(new TextEncoder().encode('ISO-10303-21;'))).toThrow();
    } finally {
      fs.writeFile = write;
    }
    expect(scratch()).toEqual([]);
    expect(tracker.liveNames()).toEqual([]);
  });

  it('the import feature leaves only its body', () => {
    const box = tk.box(10, 20, 30);
    const step = tk.exportStep([{ shape: box, name: 'Box' }]);
    tk.release(box);
    tracker.reset();
    const out = applyFeature(tk, null, { kind: 'import', id: 'import#1', step, mode: 'new' });
    expect(out.errors).toEqual([]);
    expect(tk.shapeCount).toBe(1);
    tk.release(out.shape!);
    expect(tracker.liveNames()).toEqual([]);
  });

  it('repeated exports and imports do not grow the heap without bound', () => {
    const box = tk.box(10, 20, 30);
    const cycle = () => {
      const back = tk.importStep(tk.exportStep([{ shape: box, name: 'Box' }]));
      tk.release(back);
    };
    for (let i = 0; i < 5; i++) cycle();
    const warm = tk.heapBytes();
    for (let i = 0; i < 20; i++) cycle();
    // Some growth is libcascade's empty destructors (ADR 0002); a real leak of
    // the file or the model would add megabytes per cycle.
    expect(tk.heapBytes() - warm).toBeLessThan(32 * 1024 * 1024);
    tk.release(box);
  });
});
