// STEP export and import against the real libcascade, in Node: round trips
// (volume, face count, bounding box), product names and units in the file,
// the `import` feature (fragile face names, booleans against the body), the
// `exportStep` and `importStep` ops through the service, assemblies (each
// part once, instances as located components, read back through XCAF), and
// no leaked embind objects. One instance per describe block that needs its own.

import { beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from './errors';
import {
  MAX_STEP_BYTES,
  stepAssemblyProblem,
  writeStepAssembly,
  type StepAssemblyLayout,
  type StepPose,
} from './exchange';
import { type ExtrudeInput, type ImportInput } from './features';
import {
  apply,
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
import { withScope, type Oc } from './occt';
import { collectTransferables, type KernelService } from './service';
import { track, type Tracker } from './track';
import type { ShapeId, Vec3 } from './types';
import type { TopoDS_Shape } from 'libcascade/single/init';

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
    const out = apply(k, null, importPin('new', 'import#1'));
    expect(out.errors).toEqual([]);
    expect(out.created).toEqual(['import#1']);
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
    const out = apply(k, blockShape, importPin('subtract'));
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
    const added = apply(k, blockShape, importPin('add'));
    expect(added.errors).toEqual([]);
    expect(k.properties(added.shape!).volume).toBeCloseTo(24_000 + Math.PI * 16 * 10, 6);
    const common = apply(k, blockShape, importPin('intersect'));
    expect(common.errors).toEqual([]);
    expect(k.properties(common.shape!).volume).toBeCloseTo(Math.PI * 16 * 20, 6);
    for (const id of [added.shape!, common.shape!, blockShape]) k.release(id);
  });

  it('fails cleanly on a bad file, passing the body through', () => {
    const { shape: blockShape } = build(k, [block]);
    const count = k.shapeCount;
    const out = apply(k, blockShape, {
      kind: 'import',
      id: 'import#3',
      step: new TextEncoder().encode('not a step file'),
      mode: 'add',
    });
    expect(out.ok).toBe(false);
    expect(out.shape).toBe(blockShape);
    expect(out.errors[0]).toMatchObject({ code: 'invalid', featureId: 'import#3' });
    expect(k.shapeCount).toBe(count);
    const malformed = apply(k, blockShape, {
      kind: 'import',
      id: 'import#4',
      step: 42,
      mode: 'add',
    } as unknown as ImportInput);
    expect(malformed.errors[0]).toMatchObject({ code: 'invalid' });
    k.release(blockShape);
  });

  it('with a body-less subtract, says it needs a body', () => {
    const out = apply(k, null, importPin('subtract'));
    expect(out.errors[0]).toMatchObject({ code: 'no-body' });
  });

  it('keeps a hole through an imported part named after the import', () => {
    const plate = apply(k, null, importPin('new', 'import#1'));
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

  it('exports an assembly: two boxes from one batch, one product placed twice', async () => {
    const assembly: StepAssemblyLayout = {
      name: 'Pair',
      parts: [{ name: 'Cube', bodies: [0] }],
      instances: [
        { part: 0, name: 'Cube 1', pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
        { part: 0, name: 'Cube 2', pose: { translation: [20, 0, 0], rotation: [0, 0, 0, 1] } },
      ],
    };
    const reply = await service.run({
      generation: ++generation,
      ops: [
        { op: 'box', size: [10, 10, 10], keep: false },
        { op: 'exportStep', bodies: [{ shape: { result: 0 }, name: 'Cube body' }], assembly },
        {
          op: 'exportStep',
          bodies: [{ shape: { result: 0 }, name: 'Cube body' }],
          assembly: { ...assembly, instances: [] },
        },
        { op: 'exportStep', bodies: [{ shape: { result: 0 }, name: 'x' }], assembly: 7 as never },
      ],
    });
    expect(reply.results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'ok',
      'ok',
      'invalid-argument',
      'invalid-op',
    ]);
    const data = (reply.results[1] as { value: { data: Uint8Array } }).value.data;
    expect(collectTransferables(reply)).toContain(data.buffer);
    const read = readAssembly(service.kernel.oc, data);
    expect(read.components).toHaveLength(2);
    expect(read.components[0]!.referred).toBe(read.components[1]!.referred);
    expectMatrix(read.components[1]!.matrix, assembly.instances[1]!.pose);
    expect(service.stats().shapeCount).toBe(0);
  });

  it('Kernel.exportStep writes the same assembly as writeStepAssembly', () => {
    const box = k.box(10, 20, 30);
    const bodies = [{ shape: box, name: 'Box body' }];
    const layout: StepAssemblyLayout = {
      name: 'Two boxes',
      parts: [{ name: 'Box', bodies: [0] }],
      instances: [
        { part: 0, name: 'Box 1', pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
        { part: 0, name: 'Box 2', pose: { translation: [0, 50, 0], rotation: [0, 0, 0, 1] } },
      ],
    };
    const step = text(k.exportStep(bodies, layout));
    expect(
      [...step.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','([^']*)'/g)].map((m) => m[1]),
    ).toEqual(['Box 1', 'Box 2']);
    const back = k.importStep(k.exportStep(bodies, layout));
    expect(k.properties(back).volume).toBeCloseTo(2 * 6000, 6);
    expect(() => k.exportStep(bodies, { ...layout, parts: [] })).toThrow(KernelError);
    k.release(back);
    k.release(box);
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
    const out = apply(tk, null, { kind: 'import', id: 'import#1', step, mode: 'new' });
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

// Assemblies ---------------------------------------------------------------------------------

/** The arena's shape for an id (what `Kernel.exportStep` resolves before writing). */
function shapeOf(kernel: Kernel, id: ShapeId): TopoDS_Shape {
  return (kernel as unknown as { get(id: ShapeId, op: string): TopoDS_Shape }).get(id, 'test');
}

function writeAssembly(
  kernel: Kernel,
  bodies: readonly { shape: ShapeId; name: string }[],
  layout: StepAssemblyLayout,
): Uint8Array {
  return withScope(kernel.oc, (s) =>
    writeStepAssembly(
      kernel.oc,
      s,
      bodies.map((b) => ({ shape: shapeOf(kernel, b.shape), name: b.name })),
      layout,
    ),
  );
}

/** A unit quaternion turning `angle` radians about the unit axis `axis`. */
function turn(axis: Vec3, angle: number): StepPose['rotation'] {
  const h = Math.sin(angle / 2);
  return [axis[0] * h, axis[1] * h, axis[2] * h, Math.cos(angle / 2)];
}

/** A pose's 3 x 4 matrix (rows of rotation and translation), as `gp_Trsf.Value` gives it. */
function matrixOf(pose: StepPose): number[][] {
  const [x, y, z, w] = pose.rotation;
  const t = pose.translation;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), t[0]],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), t[1]],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), t[2]],
  ];
}

interface ReadComponent {
  /** The tag of the label of the shape it places: equal tags, one product. */
  referred: number;
  matrix: number[][];
  /** Components of the shape it places (0 for a simple shape). */
  subComponents: number;
}

/**
 * Read a STEP file back with XCAF (`STEPCAFControl_Reader`) and list the components of its one
 * top-level assembly: which shape each places and where.
 */
function readAssembly(oc: Oc, bytes: Uint8Array): { roots: number; components: ReadComponent[] } {
  return withScope(oc, (s) => {
    const path = '/tmp/assembly-read.step';
    oc.FS.writeFile(path, bytes);
    const format = s.own(new oc.TCollection_ExtendedString('MDTV-XCAF'));
    const doc = s.own(new oc.TDocStd_Document(format));
    s.own(oc.XCAFApp_Application.GetApplication()).InitDocument(doc);
    const main = s.own(doc.Main());
    const reader = s.own(new oc.STEPCAFControl_Reader());
    try {
      expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      expect(reader.Transfer(doc, s.own(new oc.Message_ProgressRange()))).toBe(true);
      const tool = s.own(oc.XCAFDoc_DocumentTool.ShapeTool(main));
      const free = s.own(new oc.NCollection_Sequence_TDF_Label());
      tool.GetFreeShapes(free);
      const root = s.own(free.Value(1));
      expect(oc.XCAFDoc_ShapeTool.IsAssembly(root)).toBe(true);
      const list = s.own(new oc.NCollection_Sequence_TDF_Label());
      oc.XCAFDoc_ShapeTool.GetComponents(root, list, false);
      const components: ReadComponent[] = [];
      for (let i = 1; i <= list.Length(); i++) {
        const component = s.own(list.Value(i));
        const referred = s.own(new oc.TDF_Label());
        expect(oc.XCAFDoc_ShapeTool.GetReferredShape(component, referred)).toBe(true);
        const trsf = s.own(s.own(oc.XCAFDoc_ShapeTool.GetLocation(component)).Transformation());
        components.push({
          referred: referred.Tag(),
          matrix: [1, 2, 3].map((r) => [1, 2, 3, 4].map((c) => trsf.Value(r, c))),
          subComponents: oc.XCAFDoc_ShapeTool.NbComponents(referred, false),
        });
      }
      return { roots: free.Length(), components };
    } finally {
      oc.FS.unlink(path);
      s.own(main.Root()).ForgetAllAttributes(true);
      reader.ChangeReader().ClearShapes();
      s.own(reader.ChangeReader().WS()).ClearData(1);
    }
  });
}

function expectMatrix(actual: number[][], pose: StepPose): void {
  const expected = matrixOf(pose);
  actual.forEach((row, r) => row.forEach((v, c) => expect(v).toBeCloseTo(expected[r]![c]!, 9)));
}

describe('STEP assemblies', () => {
  const near: StepPose = { translation: [100, 0, 0], rotation: [0, 0, 0, 1] };
  const turned: StepPose = { translation: [0, 50, 10], rotation: turn([0, 0, 1], Math.PI / 2) };
  const twoBoxes = (box: ShapeId): [{ shape: ShapeId; name: string }[], StepAssemblyLayout] => [
    [{ shape: box, name: 'Box body' }],
    {
      name: 'Two boxes',
      parts: [{ name: 'Box', bodies: [0] }],
      instances: [
        { part: 0, name: 'Box <1>', pose: near },
        { part: 0, name: 'Box <2>', pose: turned },
      ],
    },
  ];

  it('writes each part once and each instance as a placed occurrence of it', () => {
    const box = k.box(10, 20, 30);
    const step = text(writeAssembly(k, ...twoBoxes(box)));
    expect(step).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
    const products = [...step.matchAll(/PRODUCT\('([^']*)'/g)].map((m) => m[1]);
    expect(products.sort()).toEqual(['Box', 'Two boxes']);
    const occurrences = [...step.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','([^']*)'/g)];
    expect(occurrences.map((m) => m[1])).toEqual(['Box <1>', 'Box <2>']);
    k.release(box);
  });

  it('round trips two instances of one part with their two placements', () => {
    const box = k.box(10, 20, 30);
    const bytes = writeAssembly(k, ...twoBoxes(box));

    // Through XCAF: one assembly, two components, both the same product, each placed.
    const read = readAssembly(k.oc, bytes);
    expect(read.roots).toBe(1);
    expect(read.components).toHaveLength(2);
    expect(read.components[0]!.referred).toBe(read.components[1]!.referred);
    expect(read.components.map((c) => c.subComponents)).toEqual([0, 0]);
    expectMatrix(read.components[0]!.matrix, near);
    expectMatrix(read.components[1]!.matrix, turned);

    // As geometry: two solids where the placements put them.
    const back = k.importStep(bytes);
    const p = k.properties(back);
    expect(k.solids(back)).toBe(2);
    expect(p.volume).toBeCloseTo(2 * 6000, 6);
    const bbox = k.measure(back, [], { body: true }).body!.boundingBox!;
    // Near: x 100..110, y 0..20, z 0..30. Turned a quarter about z: x -20..0, y 50..60, z 10..40.
    bbox.min.forEach((v, i) => expect(v).toBeCloseTo([-20, 0, 0][i]!, 6));
    bbox.max.forEach((v, i) => expect(v).toBeCloseTo([110, 60, 40][i]!, 6));
    k.release(back);
    k.release(box);
  });

  it('writes a part of several bodies as a sub-assembly of named bodies', () => {
    const plate = k.box(40, 40, 5);
    const pin = k.cylinder(3, 20, [20, 20, 5]);
    const lid = k.box(40, 40, 2);
    const bytes = writeAssembly(
      k,
      [
        { shape: plate, name: 'Plate' },
        { shape: pin, name: 'Pin' },
        { shape: lid, name: 'Lid body' },
      ],
      {
        name: 'Fixture',
        parts: [
          { name: 'Base', bodies: [0, 1] },
          { name: 'Lid', bodies: [2] },
        ],
        instances: [
          { part: 0, name: 'Base <1>', pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
          { part: 1, name: 'Lid <1>', pose: { translation: [0, 0, 30], rotation: [0, 0, 0, 1] } },
        ],
      },
    );
    const step = text(bytes);
    const products = [...step.matchAll(/PRODUCT\('([^']*)'/g)].map((m) => m[1]);
    expect(products.sort()).toEqual(['Base', 'Fixture', 'Lid', 'Pin', 'Plate']);
    const read = readAssembly(k.oc, bytes);
    expect(read.roots).toBe(1);
    expect(read.components.map((c) => c.subComponents)).toEqual([2, 0]);
    const back = k.importStep(bytes);
    const p = k.properties(back);
    expect(k.solids(back)).toBe(3);
    expect(p.volume).toBeCloseTo(40 * 40 * 5 + Math.PI * 9 * 20 + 40 * 40 * 2, 6);
    const bbox = k.measure(back, [], { body: true }).body!.boundingBox!;
    expect(bbox.max[2]).toBeCloseTo(32, 6);
    for (const id of [plate, pin, lid, back]) k.release(id);
  });

  it('refuses a layout that does not describe an assembly of the bodies', () => {
    const pose: StepPose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };
    const good: StepAssemblyLayout = {
      name: 'A',
      parts: [{ name: 'P', bodies: [0] }],
      instances: [{ part: 0, name: 'P <1>', pose }],
    };
    expect(stepAssemblyProblem(good, 1)).toBeNull();
    const bad: [Partial<StepAssemblyLayout> | null, number, RegExp][] = [
      [null, 1, /must be an object/],
      [{ ...good, name: '' }, 1, /needs a name/],
      [{ ...good, parts: [] }, 1, /no parts/],
      [{ ...good, instances: [] }, 1, /no instances/],
      [{ ...good, parts: [{ name: 'P', bodies: [] }] }, 1, /part 0 has no bodies/],
      [{ ...good, parts: [{ name: 'P', bodies: [1] }] }, 1, /body 1, which is not/],
      [{ ...good, parts: [{ name: 'P', bodies: [0] }] }, 2, /every body must belong/],
      [
        {
          ...good,
          parts: [
            { name: 'P', bodies: [0] },
            { name: 'Q', bodies: [0] },
          ],
        },
        1,
        /body 0 is in parts 0 and 1/,
      ],
      [
        {
          ...good,
          parts: [
            { name: 'P', bodies: [0] },
            { name: 'Q', bodies: [1] },
          ],
        },
        2,
        /every part needs an instance/,
      ],
      [{ ...good, instances: [{ part: 3, name: 'x', pose }] }, 1, /part 3, which is not/],
      [{ ...good, instances: [{ part: 0, name: '', pose }] }, 1, /instance 0 needs a name/],
      [
        {
          ...good,
          instances: [{ part: 0, name: 'x', pose: { ...pose, translation: [0, NaN, 0] } }],
        },
        1,
        /needs a pose/,
      ],
      [
        { ...good, instances: [{ part: 0, name: 'x', pose: { ...pose, rotation: [0, 0, 0, 2] } }] },
        1,
        /not a unit quaternion/,
      ],
    ];
    for (const [layout, count, why] of bad) {
      expect(stepAssemblyProblem(layout as StepAssemblyLayout, count)).toMatch(why);
    }
    const box = k.box(1, 1, 1);
    let error: unknown = null;
    try {
      writeAssembly(k, [{ shape: box, name: 'B' }], { ...good, instances: [] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe('invalid-argument');
    k.release(box);
  });
});

describe('STEP assemblies leak nothing', () => {
  let tracker: Tracker;
  let tk: Kernel;

  beforeAll(async () => {
    tracker = track(await createNodeInstance());
    tk = new Kernel(tracker.oc);
  }, 60_000);

  it('deletes every temporary of an assembly export', () => {
    const a = tk.box(10, 20, 30);
    const b = tk.cylinder(2, 5);
    tracker.reset();
    const layout: StepAssemblyLayout = {
      name: 'A',
      parts: [{ name: 'P', bodies: [0, 1] }],
      instances: [
        { part: 0, name: 'P <1>', pose: { translation: [1, 2, 3], rotation: [0, 0, 0, 1] } },
        { part: 0, name: 'P <2>', pose: { translation: [0, 0, 0], rotation: turn([1, 0, 0], 1) } },
      ],
    };
    const bytes = writeAssembly(
      tk,
      [
        { shape: a, name: 'A body' },
        { shape: b, name: 'B body' },
      ],
      layout,
    );
    expect(bytes.length).toBeGreaterThan(0);
    expect(tracker.created()).toBeGreaterThan(10);
    expect(tracker.liveNames()).toEqual([]);
    tk.release(a);
    tk.release(b);
  });
});
