// `.mfkview` bundles: written with three's GLTFExporter and read back by our own strict reader,
// meshes and name tables equal; the M1 bracket from the real kernel, with its bundle size; and
// every kind of malformed or oversized bundle refused with a message, never a crash.

import {
  applyFeature,
  holeSize,
  type FeatureBody,
  type FeatureInput,
  type Frame,
  type Kernel,
  type MeshData,
  type ProfileEntity,
  type Vec2,
} from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { meshProperties } from './mesh';
import {
  MFKVIEW_LIMITS,
  MFKVIEW_MANIFEST,
  MFKVIEW_SOURCE,
  MFKVIEW_VIEWER_LIMITS,
  MfkviewError,
  isRigidMatrix,
  mfkviewBodyEntry,
  readMfkview,
  withFileReaderShim,
  writeMfkview,
  type MfkviewInput,
  type MfkviewMesh,
} from './mfkview';
import { IDENTITY_MATRIX, placementMatrix } from './placement';

/** An axis-aligned box as the kernel meshes it: four vertices per face, 12 edges of 2 points. */
function boxMesh(size: [number, number, number], prefix: string): MfkviewMesh {
  const [sx, sy, sz] = size;
  const corner = (i: number) => [i & 1 ? sx : 0, i & 2 ? sy : 0, i & 4 ? sz : 0] as const;
  // Each face: four corners counter-clockwise from outside, and its normal.
  const faces: [number[], [number, number, number]][] = [
    [
      [0, 2, 3, 1],
      [0, 0, -1],
    ],
    [
      [4, 5, 7, 6],
      [0, 0, 1],
    ],
    [
      [0, 1, 5, 4],
      [0, -1, 0],
    ],
    [
      [2, 6, 7, 3],
      [0, 1, 0],
    ],
    [
      [0, 4, 6, 2],
      [-1, 0, 0],
    ],
    [
      [1, 3, 7, 5],
      [1, 0, 0],
    ],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: number[] = [];
  faces.forEach(([quad, n]) => {
    const base = positions.length / 3;
    for (const c of quad) {
      positions.push(...corner(c));
      normals.push(...n);
    }
    faceRanges.push(indices.length, 6);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const edgeList = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const edgePositions: number[] = [];
  const edgeRanges: number[] = [];
  for (const [a, b] of edgeList) {
    edgeRanges.push(edgePositions.length / 3, 2);
    edgePositions.push(...corner(a!), ...corner(b!));
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    faceRanges: Uint32Array.from(faceRanges),
    edgePositions: Float32Array.from(edgePositions),
    edgeRanges: Uint32Array.from(edgeRanges),
    faceNames: faces.map((_, i) => (i === 5 ? null : `${prefix}:face:${i}`)),
    edgeNames: edgeList.map((_, i) => (i === 0 ? null : `${prefix}:edge:${i}`)),
  };
}

const plate = boxMesh([40, 30, 5], 'extrude#1');
const post = boxMesh([10, 10, 50], 'extrude#2');

/** An assembly: a plate and a post, the post placed twice, and the source. */
const assembly: MfkviewInput = {
  name: 'Stand "A" é <b>',
  kind: 'assembly',
  displayUnits: 'in',
  bodies: [
    {
      name: 'Plate',
      color: '#8fb8de',
      material: { id: 'pla', name: 'PLA', density: 1240 },
      volume: 6000,
      mass: 7.44,
      mesh: plate,
    },
    { name: 'Post', color: null, material: null, volume: null, mass: null, mesh: post },
  ],
  parts: [
    { name: 'Plate', bodies: [0] },
    { name: 'Post', bodies: [1] },
  ],
  instances: [
    { name: 'Plate 1', part: 0, transform: [...IDENTITY_MATRIX] },
    {
      name: 'Post 1',
      part: 1,
      transform: placementMatrix({ translation: [5, 5, 5], rotation: [0, 0, 0, 1] }),
    },
    {
      name: 'Post 2',
      part: 1,
      transform: placementMatrix({
        translation: [25, 15, 5],
        rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)],
      }),
    },
  ],
  source: new Uint8Array([0x50, 0x4b, 5, 6, 1, 2, 3]),
};

function expectMeshEqual(got: MfkviewMesh, want: MfkviewMesh) {
  expect(got.positions).toEqual(want.positions);
  expect(got.normals).toEqual(want.normals);
  expect(got.indices).toEqual(want.indices);
  expect(got.faceRanges).toEqual(want.faceRanges);
  expect(got.edgePositions).toEqual(want.edgePositions);
  expect(got.edgeRanges).toEqual(want.edgeRanges);
  expect(got.faceNames).toEqual(want.faceNames);
  expect(got.edgeNames).toEqual(want.edgeNames);
}

describe('writing and reading a bundle', () => {
  it('round-trips an assembly: manifest, meshes, name tables and source', async () => {
    const bytes = await writeMfkview(assembly);
    const view = readMfkview(bytes);
    expect(view.manifest).toMatchObject({
      format: 'manufakture-view',
      version: 1,
      generator: 'manufakture',
      name: assembly.name,
      kind: 'assembly',
      units: { length: 'mm', display: 'in' },
      source: true,
      parts: assembly.parts,
    });
    expect(view.manifest.bodies).toEqual([
      {
        name: 'Plate',
        color: '#8fb8de',
        material: { id: 'pla', name: 'PLA', density: 1240 },
        volume: 6000,
        mass: 7.44,
        faces: 6,
        edges: 12,
        triangles: 12,
      },
      {
        name: 'Post',
        color: null,
        material: null,
        volume: null,
        mass: null,
        faces: 6,
        edges: 12,
        triangles: 12,
      },
    ]);
    expect(view.manifest.instances).toEqual(assembly.instances);
    expect(view.meshes).toHaveLength(2);
    expectMeshEqual(view.meshes[0]!, plate);
    expectMeshEqual(view.meshes[1]!, post);
    expect(view.readSource()).toEqual(assembly.source);
  });

  it('writes standard binary glTF that names its nodes, with colours as materials', async () => {
    const files = unzipSync(await writeMfkview(assembly));
    expect(Object.keys(files).sort()).toEqual([
      'bodies/0.glb',
      'bodies/1.glb',
      MFKVIEW_MANIFEST,
      MFKVIEW_SOURCE,
    ]);
    const { json } = splitGlb(files['bodies/0.glb']!);
    expect(json.asset.version).toBe('2.0');
    expect(json.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['edges', 'faces']);
    const faces = json.nodes.find((n: { name: string }) => n.name === 'faces');
    expect(json.meshes[faces.mesh].primitives[0].mode ?? 4).toBe(4);
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toHaveLength(4);
    // The manifest is plain, readable JSON.
    const manifest = JSON.parse(new TextDecoder().decode(files[MFKVIEW_MANIFEST]));
    expect(manifest.instances[0].transform).toEqual([...IDENTITY_MATRIX]);
  });

  it('leaves the source out unless asked, and works without FileReader in Node', async () => {
    expect(typeof (globalThis as { FileReader?: unknown }).FileReader).toBe('undefined');
    const bytes = await writeMfkview({ ...assembly, source: null });
    // The shim is gone again afterwards.
    expect(typeof (globalThis as { FileReader?: unknown }).FileReader).toBe('undefined');
    const view = readMfkview(bytes);
    expect(view.readSource()).toBeNull();
    expect(view.manifest.source).toBe(false);
    expect(Object.keys(unzipSync(bytes))).not.toContain(MFKVIEW_SOURCE);
  });

  it('rejects instead of hanging when the shim cannot read a blob', async () => {
    const failing = { arrayBuffer: () => Promise.reject(new Error('read failed')) };
    await expect(
      withFileReaderShim(
        () =>
          new Promise((resolve) => {
            type Reader = {
              result: unknown;
              onloadend: () => void;
              readAsArrayBuffer(b: typeof failing): void;
            };
            const R = (globalThis as unknown as { FileReader: new () => Reader }).FileReader;
            const reader = new R();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsArrayBuffer(failing);
          }),
      ),
    ).rejects.toThrow('read failed');
    expect(typeof (globalThis as { FileReader?: unknown }).FileReader).toBe('undefined');
  });

  it('leaves a real FileReader installed while the shim was active in place', async () => {
    class Real {}
    const g = globalThis as { FileReader?: unknown };
    try {
      await withFileReaderShim(async () => {
        g.FileReader = Real;
      });
      expect(g.FileReader).toBe(Real);
    } finally {
      delete g.FileReader;
    }
  });

  it('writes several bundles at once', async () => {
    const all = await Promise.all(
      [1, 2, 3].map((n) => writeMfkview({ ...assembly, name: `N${n}` })),
    );
    expect(all.map((b) => readMfkview(b).manifest.name)).toEqual(['N1', 'N2', 'N3']);
  });

  it('refuses to write what it would not read', async () => {
    await expect(
      writeMfkview({ ...assembly, instances: assembly.instances.slice(0, 1) }),
    ).rejects.toThrow(/part 1 has no instance/);
    await expect(
      writeMfkview({ ...assembly, name: 'x'.repeat(MFKVIEW_LIMITS.maxNameLength + 1) }),
    ).rejects.toThrow(MfkviewError);
    const scaled = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
    await expect(
      writeMfkview({
        ...assembly,
        instances: [assembly.instances[0]!, { name: 'big', part: 1, transform: scaled }],
      }),
    ).rejects.toThrow(/not rigid/);
    const lonely = { ...plate, edgeRanges: Uint32Array.from([0, 1]), edgeNames: ['x'] };
    await expect(
      writeMfkview({
        ...assembly,
        bodies: [{ ...assembly.bodies[0]!, mesh: lonely }, assembly.bodies[1]!],
      }),
    ).rejects.toThrow(/single point/);
  });

  it('checks rigid matrices', () => {
    expect(isRigidMatrix([...IDENTITY_MATRIX])).toBe(true);
    // A mirror: orthonormal but left-handed.
    expect(isRigidMatrix([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).toBe(false);
    expect(isRigidMatrix([1, 0, 0, 0, 1, 0, 0, 0.1, 1, 0, 0, 0])).toBe(false);
    expect(isRigidMatrix([1, 0, 0])).toBe(false);
  });
});

// The M1 bracket, from the real kernel ---------------------------------------------------------

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const FRONT: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };

function polygon(points: readonly Vec2[], ids: readonly string[]): ProfileEntity[] {
  return points.map((start, i) => ({
    kind: 'line' as const,
    id: ids[i]!,
    start,
    end: points[(i + 1) % points.length]!,
  }));
}

/** The M1 bracket (packages/kernel/test/bracket.test.ts) with 6 mm walls. */
function bracket(): FeatureInput[] {
  const t = 6;
  const M4 = holeSize('M4')!;
  return [
    {
      kind: 'extrude',
      id: 'extrude#1',
      profile: {
        frame: FRONT,
        loops: [
          {
            entities: polygon(
              [
                [0, 0],
                [50, 0],
                [50, t],
                [t, t],
                [t, 40],
                [0, 40],
              ],
              ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
            ),
          },
        ],
      },
      extent: { type: 'symmetric', distance: 30 },
      mode: 'new',
    },
    {
      kind: 'hole',
      id: 'hole#1',
      frame: { origin: [0, 0, t], xDir: [1, 0, 0], normal: [0, 0, 1] },
      points: [
        { id: 'e7', at: [25, 0] },
        { id: 'e8', at: [40, 0] },
      ],
      diameter: M4.clearance.normal,
      extent: { type: 'throughAll' },
      head: { type: 'counterbore', diameter: M4.counterbore.diameter, depth: M4.counterbore.depth },
    },
    {
      kind: 'fillet',
      id: 'fillet#1',
      radius: 4,
      edges: [{ id: 'r2', ref: { faces: ['extrude#1:side:e3', 'extrude#1:side:e4'] } }],
    },
  ];
}

/** A kernel mesh with the body's names, as the app's viewport holds it. */
function viewMesh(mesh: MeshData, faces: readonly string[], edges: readonly string[]): MfkviewMesh {
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    faceRanges: mesh.faceRanges,
    edgePositions: mesh.edgePositions,
    edgeRanges: mesh.edgeRanges,
    faceNames: Array.from({ length: mesh.faceRanges.length / 2 }, (_, i) => faces[i] ?? null),
    edgeNames: Array.from({ length: mesh.edgeRanges.length / 2 }, (_, i) => edges[i] ?? null),
  };
}

describe('the M1 bracket', () => {
  it('round-trips from the kernel; its bundle size is recorded', async () => {
    let bodies: FeatureBody[] = [];
    let last: ReturnType<typeof applyFeature> | null = null;
    for (const f of bracket()) {
      last = applyFeature(k, bodies, f);
      expect(last.errors, f.id).toEqual([]);
      bodies = last.bodies.map((b) => ({ id: b.id, shape: b.shape }));
    }
    const body = last!.bodies[0]!;
    // The viewport's tessellation (the kernel's default deflection).
    const mesh = viewMesh(
      k.mesh(body.shape),
      body.names!.faces.map((f) => f.name),
      body.names!.edges.map((e) => e.name),
    );
    const volume = Math.abs(meshProperties(mesh).volume);
    const input: MfkviewInput = {
      name: 'M1 bracket',
      kind: 'part',
      bodies: [
        {
          name: 'Bracket',
          color: '#c2cad3',
          material: { id: 'pla', name: 'PLA', density: 1240 },
          volume,
          mass: volume * 1240 * 1e-6,
          mesh,
        },
      ],
      parts: [{ name: 'Bracket', bodies: [0] }],
      instances: [{ name: 'Bracket', part: 0, transform: [...IDENTITY_MATRIX] }],
    };
    const bytes = await writeMfkview(input);
    const view = readMfkview(bytes);
    expectMeshEqual(view.meshes[0]!, mesh);
    expect(view.manifest.bodies[0]!.faces).toBe(15);
    expect(view.meshes[0]!.faceNames).toContain('fillet#1:round:r2');
    expect(view.meshes[0]!.faceNames).toContain('hole#1:wall:e7');
    // Recorded in the io README ("Published views"): the bundle of the M1 bracket at the
    // viewport's tessellation, without its source. A tolerance for the deflate and the kernel.
    console.log(
      `M1 bracket .mfkview: ${bytes.length} bytes, ${view.manifest.bodies[0]!.triangles} triangles, ${mesh.positions.length / 3} vertices`,
    );
    expect(bytes.length).toBeGreaterThan(3_000);
    expect(bytes.length).toBeLessThan(12_000);
    k.release(body.shape);
  }, 60_000);
});

/* eslint-disable @typescript-eslint/no-explicit-any -- the hostile cases edit parsed JSON freely */

// Hostile bundles ------------------------------------------------------------------------------

/** A glb's JSON (parsed) and binary chunk. */
function splitGlb(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const bin = glb.subarray(20 + jsonLength + 8);
  return { json, bin };
}

/** A glb from JSON and a binary chunk, padded as the format wants. */
function joinGlb(json: unknown, bin: Uint8Array): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const j = new TextEncoder().encode(text);
  const out = new Uint8Array(12 + 8 + j.length + 8 + bin.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, j.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  v.setUint32(20 + j.length, bin.length, true);
  v.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

let good: Uint8Array;

beforeAll(async () => {
  good = await writeMfkview(assembly);
});

/** The good bundle with its files changed by `edit`. */
function edited(edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(good);
  edit(files);
  return zipSync(files as Zippable);
}

function editManifest(edit: (m: Record<string, unknown>) => void): Uint8Array {
  return edited((files) => {
    const m = JSON.parse(new TextDecoder().decode(files[MFKVIEW_MANIFEST]));
    edit(m);
    files[MFKVIEW_MANIFEST] = new TextEncoder().encode(JSON.stringify(m));
  });
}

function editGlb(edit: (json: any, bin: Uint8Array) => unknown): Uint8Array {
  return edited((files) => {
    const { json, bin } = splitGlb(files[mfkviewBodyEntry(0)]!);
    const copy = bin.slice();
    const out = edit(json, copy);
    files[mfkviewBodyEntry(0)] = joinGlb(json, out instanceof Uint8Array ? out : copy);
  });
}

const refused = (bytes: Uint8Array, message: RegExp) => {
  expect(() => readMfkview(bytes)).toThrow(MfkviewError);
  expect(() => readMfkview(bytes)).toThrow(message);
};

describe('reading a hostile bundle', () => {
  it('refuses what is not a zip, or a zip without a manifest', () => {
    refused(new Uint8Array(10), /cannot be read/);
    refused(new TextEncoder().encode('x'.repeat(100)), /no end of central directory/);
    refused(zipSync({ 'other.txt': new Uint8Array(3) }), /no manifest\.json/);
    refused(
      edited((f) => (f[MFKVIEW_MANIFEST] = new Uint8Array([0xff, 0xfe]))),
      /not UTF-8/,
    );
    refused(
      edited((f) => (f[MFKVIEW_MANIFEST] = new TextEncoder().encode('{'))),
      /not JSON/,
    );
  });

  it('refuses another format, and a newer version with a clear message', () => {
    refused(
      editManifest((m) => (m.format = 'manufakture-manifest')),
      /another format/,
    );
    refused(
      editManifest((m) => (m.version = 2)),
      /newer manufakture/,
    );
    refused(
      editManifest((m) => (m.version = 0)),
      /format version/,
    );
  });

  it('checks every manifest field', () => {
    const cases: [(m: any) => void, RegExp][] = [
      [(m) => (m.name = 42), /the name is not text/],
      [(m) => (m.kind = 'drawing'), /kind/],
      [(m) => (m.units = { length: 'in', display: 'in' }), /length unit/],
      [(m) => (m.units.display = '<script>'), /display unit/],
      [(m) => (m.bodies = []), /no bodies/],
      [(m) => (m.bodies = {}), /not a list/],
      [(m) => (m.bodies[0].color = 'red'), /#rrggbb/],
      [(m) => (m.bodies[0].material.density = -1), /density/],
      [(m) => (m.bodies[0].material.id = '../x'), /material id/],
      [(m) => (m.bodies[0].volume = 'NaN'), /volume/],
      [(m) => (m.bodies[0].mass = -3), /mass/],
      [(m) => (m.bodies[0].faces = 1.5), /face count/],
      [(m) => (m.bodies[0].triangles = 0), /triangle count/],
      [(m) => (m.parts[1].bodies = [0]), /two parts/],
      [(m) => (m.parts = [m.parts[0]]), /belongs to no part/],
      [(m) => (m.parts[0].bodies = []), /no bodies/],
      [(m) => (m.parts[0].bodies = [7]), /a body of part 0/],
      [(m) => (m.instances[0].part = 9), /the part of instance 0/],
      [(m) => (m.instances = [m.instances[0]]), /part 1 has no instance/],
      [(m) => (m.instances[1].transform = [1, 2, 3]), /12 numbers/],
      [(m) => (m.instances[1].transform[9] = 1e12), /transform/],
      [(m) => (m.instances[1].transform[0] = 2), /not rigid/],
      [(m) => (m.source = 'yes'), /source/],
      [(m) => (m.bodies[0].name = 'n'.repeat(1001)), /longer than 1000/],
    ];
    for (const [edit, message] of cases) refused(editManifest(edit), message);
  });

  it('drops fields the format does not define', () => {
    const view = readMfkview(
      editManifest((m: any) => {
        m.script = 'alert(1)';
        m.bodies[0].onclick = 'x';
      }),
    );
    expect(view.manifest).not.toHaveProperty('script');
    expect(view.manifest.bodies[0]).not.toHaveProperty('onclick');
  });

  it('refuses a missing mesh or source', () => {
    refused(
      edited((f) => delete f[mfkviewBodyEntry(1)]),
      /mesh of body 1 is missing/,
    );
    refused(
      edited((f) => delete f[MFKVIEW_SOURCE]),
      /source is missing/,
    );
  });

  it('refuses a damaged glb', () => {
    refused(
      edited((f) => (f[mfkviewBodyEntry(0)] = new Uint8Array(8))),
      /too short/,
    );
    refused(
      edited((f) => (f[mfkviewBodyEntry(0)] = f[mfkviewBodyEntry(0)]!.slice(0, 200))),
      /wrong length/,
    );
    refused(
      edited((f) => {
        const g = f[mfkviewBodyEntry(0)]!.slice();
        g[0] = 0;
        f[mfkviewBodyEntry(0)] = g;
      }),
      /not binary glTF/,
    );
  });

  it('refuses glTF that does not match what the manifest says, or lies about its buffers', () => {
    const faceAccessor = (json: any) => {
      const node = json.nodes.find((n: any) => n.name === 'faces');
      return json.meshes[node.mesh].primitives[0];
    };
    const cases: [(json: any, bin: Uint8Array) => unknown, RegExp][] = [
      [(j) => (j.nodes = j.nodes.filter((n: any) => n.name !== 'faces')), /has no faces/],
      [(j) => j.nodes.push({ ...j.nodes[0] }), /two/],
      [(j) => (j.accessors[faceAccessor(j).attributes.POSITION].count = 1e6), /outside its buffer/],
      [(j) => (j.accessors[faceAccessor(j).attributes.POSITION].count = 1e9), /accessor count/],
      [(j) => (j.accessors[faceAccessor(j).attributes.POSITION].type = 'VEC2'), /not VEC3/],
      [(j) => (j.accessors[faceAccessor(j).indices].sparse = {}), /sparse/],
      [(j) => (j.bufferViews[0].byteStride = 32), /interleaved/],
      [(j) => (j.bufferViews[0].buffer = 1), /outside the binary chunk/],
      [(j) => (faceAccessor(j).mode = 1), /not triangles/],
      [(j) => (faceAccessor(j).attributes.POSITION = 99), /an accessor of body 0/],
      [(j) => (j.nodes.find((n: any) => n.name === 'faces').extras = {}), /name table/],
      [
        (j) => (j.nodes.find((n: any) => n.name === 'faces').extras.manufakture.faceNames = [1]),
        /face names/,
      ],
      [
        (j) => {
          const r = j.nodes.find((n: any) => n.name === 'faces').extras.manufakture.faceRanges;
          r[1] = 1e6;
        },
        /face ranges/,
      ],
      [
        (j) => {
          const r = j.nodes.find((n: any) => n.name === 'faces').extras.manufakture.faceRanges;
          r[1] = 4;
        },
        /splits a triangle/,
      ],
      [
        (j) => {
          const r = j.nodes.find((n: any) => n.name === 'faces').extras.manufakture.edgeRanges;
          r[0] = 1e6;
        },
        /edge ranges/,
      ],
      [
        (j, bin) => {
          // The first index of the faces points past the vertices.
          const a = j.accessors[faceAccessor(j).indices];
          const view = j.bufferViews[a.bufferView];
          new DataView(bin.buffer).setUint32(
            (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
            999,
            true,
          );
          return bin;
        },
        /index past its vertices/,
      ],
      [
        (j, bin) => {
          const a = j.accessors[faceAccessor(j).attributes.POSITION];
          const view = j.bufferViews[a.bufferView];
          new DataView(bin.buffer).setFloat32(
            (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
            NaN,
            true,
          );
          return bin;
        },
        /coordinate/,
      ],
    ];
    for (const [edit, message] of cases) refused(editGlb(edit), message);
  });

  it('refuses a bundle whose triangle count differs from the manifest', () => {
    refused(
      editManifest((m: any) => (m.bodies[0].triangles = 11)),
      /triangles it lists/,
    );
    refused(
      editManifest((m: any) => (m.bodies[0].faces = 5)),
      /face ranges/,
    );
  });

  it('enforces the size and count limits before inflating', () => {
    const tight = (over: Partial<typeof MFKVIEW_LIMITS>) => ({ ...MFKVIEW_LIMITS, ...over });
    expect(() => readMfkview(good, tight({ maxFileBytes: good.length - 1 }))).toThrow(
      /larger than/,
    );
    expect(() => readMfkview(good, tight({ maxEntries: 3 }))).toThrow(/more than 3 entries/);
    expect(() => readMfkview(good, tight({ maxManifestBytes: 100 }))).toThrow(
      /manifest\.json is larger than/,
    );
    expect(() => readMfkview(good, tight({ maxMeshBytes: 1000 }))).toThrow(
      /bodies\/0\.glb is larger than/,
    );
    // The source is read only when asked for, within its own limit.
    const lazy = readMfkview(good, tight({ maxSourceBytes: 3 }));
    expect(() => lazy.readSource()).toThrow(/source\.mfk is larger/);
    expect(() => readMfkview(good, tight({ maxTotalBytes: 2000 }))).toThrow(/holds more than/);
    expect(() => readMfkview(good, tight({ maxBodies: 1 }))).toThrow(/more than 1 items/);
    expect(() => readMfkview(good, tight({ maxInstances: 2 }))).toThrow(/more than 2 items/);
    expect(() => readMfkview(good, tight({ maxTriangles: 11 }))).toThrow(/triangle count/);
    expect(() => readMfkview(good, tight({ maxTotalTriangles: 20 }))).toThrow(/more than 20/);
    expect(() => readMfkview(good, tight({ maxFaces: 5 }))).toThrow(/face count/);
  });

  it('reads within the lower viewer limits, which refuse a file over 64 MiB at once', () => {
    expect(readMfkview(good, MFKVIEW_VIEWER_LIMITS).meshes).toHaveLength(2);
    expect(() => readMfkview(new Uint8Array(64 * 1024 * 1024 + 1), MFKVIEW_VIEWER_LIMITS)).toThrow(
      'The file is larger than 64.0 MB.',
    );
    expect(MFKVIEW_VIEWER_LIMITS.maxTotalBytes).toBeLessThan(MFKVIEW_LIMITS.maxTotalBytes);
  });

  it('does not inflate the source until asked, and reads it once', () => {
    // A source whose deflate stream is garbage: the view still opens; the source fails on demand.
    const broken = edited((f) => {
      f[MFKVIEW_SOURCE] = new Uint8Array(4096).fill(7);
    });
    const patched = broken.slice();
    const dv = new DataView(patched.buffer);
    for (let p = 0; p + 46 < patched.length; p++) {
      if (dv.getUint32(p, true) !== 0x02014b50) continue;
      const n = dv.getUint16(p + 28, true);
      if (new TextDecoder().decode(patched.subarray(p + 46, p + 46 + n)) !== MFKVIEW_SOURCE)
        continue;
      const local = dv.getUint32(p + 42, true);
      const dataStart =
        local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      patched.fill(0xff, dataStart, dataStart + 8);
    }
    const view = readMfkview(patched);
    expect(view.meshes).toHaveLength(2);
    expect(() => view.readSource()).toThrow(/source\.mfk is damaged/);
    const ok = readMfkview(good);
    expect(ok.readSource()).toBe(ok.readSource());
  });

  it('refuses an entry that inflates past the size it claims (a zip bomb)', () => {
    // A manifest padded with 1 MB of spaces deflates to almost nothing; its directory entry is
    // then made to claim 1 KB, inside the limit.
    const bomb = edited((f) => {
      const text = new TextDecoder().decode(f[MFKVIEW_MANIFEST]);
      f[MFKVIEW_MANIFEST] = new TextEncoder().encode(text + ' '.repeat(1 << 20));
    });
    const view = new DataView(bomb.buffer);
    for (let p = 0; p + 46 < bomb.length; p++) {
      if (view.getUint32(p, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bomb.subarray(p + 46, p + 46 + nameLength));
      if (name === MFKVIEW_MANIFEST) view.setUint32(p + 24, 1024, true);
    }
    refused(bomb, /inflates to more than/);
  });

  it('refuses a name listed twice in the zip', () => {
    const m = unzipSync(good)[MFKVIEW_MANIFEST]!;
    refused(
      storedZip([
        [MFKVIEW_MANIFEST, m],
        [MFKVIEW_MANIFEST, m],
      ]),
      /twice/,
    );
  });
});

/** A zip of stored entries, written by hand (fflate refuses duplicate names). */
function storedZip(entries: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
