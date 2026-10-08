// Documents and backends for the library's tests, and the app's tests of what uses the library
// (`@manufakture/library/test-fixtures`).

import {
  DocumentStore,
  applyCommand,
  createDocument,
  serialize,
  type Command,
  type DerivedFeature,
  type EdgeReference,
  type Feature,
  type DocumentFont,
  type ImportFeature,
  type Instance,
  type ManufaktureDocument,
  type OutlineEntity,
  type SketchFeature,
} from '@manufakture/core';
import { importSource, sha256Hex, toBase64, writeBinaryStl } from '@manufakture/io';
import { MemoryBackend, type BackendKind, type StorageBackend } from './backend';

/**
 * A binary STL of a cube of `size` mm from the origin: two triangles per face, faces in the
 * order -X, +X, -Y, +Y, -Z, +Z, wound outward (the app's test box mesh, written out).
 */
export function cubeStl(size = 10): Uint8Array {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let a = 0; a < 3; a++) {
    for (const s of [-1, 1]) {
      let u = (a + 1) % 3;
      let v = (a + 2) % 3;
      if (s < 0) [u, v] = [v, u]; // keep u x v = outward normal
      const base = positions.length / 3;
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as const) {
        const p = [0, 0, 0];
        p[a] = s > 0 ? size : 0;
        p[u] = du ? size : 0;
        p[v] = dv ? size : 0;
        positions.push(...p);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return writeBinaryStl({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  });
}

/** An STL reference import feature of `bytes`. */
export async function stlImport(
  bytes: Uint8Array = cubeStl(),
  id = 'import#1',
  fileName = 'cube.stl',
): Promise<ImportFeature> {
  return {
    id,
    kind: 'import',
    name: 'Cube',
    suppressed: false,
    source: await importSource('stl', fileName, bytes),
    operation: 'reference',
  };
}

export function unwrapDoc(r: ReturnType<typeof applyCommand>): ManufaktureDocument {
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/**
 * The demo part (sketches, an extrude, fillets, a cut) under `id`: the app's `?scene=demo`
 * document (apps/web/src/model/demo.ts), built the same way, so the app's tests and these agree.
 */
export function partDocument(id = 'doc-1', name = 'Bracket'): ManufaktureDocument {
  const base = createDocument({ id, name: 'Demo' });
  let doc: ManufaktureDocument = {
    ...base,
    parts: base.parts.map((p) => ({ ...p, name: 'Demo part' })),
  };
  for (const feature of demoFeatures()) {
    const command: Command = { type: 'addFeature', partId: 'part#1', feature };
    doc = unwrapDoc(applyCommand(doc, command));
  }
  return { ...doc, name };
}

/** A 60 x 40 x 20 mm block, every edge filleted at 3 mm, with a through hole of radius 8. */
function demoFeatures(): Feature[] {
  const corners: [number, number][] = [
    [-30, -20],
    [30, -20],
    [30, 20],
    [-30, 20],
  ];
  const outline: SketchFeature = {
    id: 'sketch#1',
    kind: 'sketch',
    name: 'Sketch 1',
    suppressed: false,
    plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
    entities: corners.map((start, i) => ({
      id: `e${i + 1}`,
      kind: 'line' as const,
      construction: false,
      start,
      end: corners[(i + 1) % 4]!,
    })),
    constraints: [
      ...[1, 2, 3, 4].map((i) => ({
        id: `k${i}`,
        kind: 'coincident' as const,
        a: { entity: `e${i}`, at: 'end' as const },
        b: { entity: `e${(i % 4) + 1}`, at: 'start' as const },
      })),
      { id: 'k5', kind: 'horizontal', line: 'e1' },
      { id: 'k6', kind: 'horizontal', line: 'e3' },
      { id: 'k7', kind: 'vertical', line: 'e2' },
      { id: 'k8', kind: 'vertical', line: 'e4' },
    ],
  };
  const side = (i: number) => `extrude#1:side:e${i}`;
  const pairs: [string, string][] = [];
  for (let i = 1; i <= 4; i++) {
    pairs.push(['extrude#1:cap:end', side(i)], ['extrude#1:cap:start', side(i)]);
    pairs.push([side(i), side((i % 4) + 1)]);
  }
  const edges: EdgeReference[] = pairs.map((faces, i) => ({
    id: `r${i + 1}`,
    ref: { faces: [...faces].sort() },
  }));
  return [
    outline,
    {
      id: 'extrude#1',
      kind: 'extrude',
      name: 'Extrude 1',
      suppressed: false,
      profile: { sketch: 'sketch#1' },
      operation: 'new',
      extent: { type: 'blind', distance: mm('20') },
      reverse: false,
    },
    {
      id: 'fillet#1',
      kind: 'fillet',
      name: 'Fillet 1',
      suppressed: false,
      edges,
      radius: mm('3'),
    },
    {
      id: 'sketch#2',
      kind: 'sketch',
      name: 'Sketch 2',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, -5], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [{ id: 'e5', kind: 'circle', construction: false, center: [0, 0], radius: 8 }],
      constraints: [],
    },
    {
      id: 'extrude#2',
      kind: 'extrude',
      name: 'Hole',
      suppressed: false,
      profile: { sketch: 'sketch#2' },
      operation: 'cut',
      extent: { type: 'blind', distance: mm('30') },
      reverse: false,
    },
  ];
}

/** The demo part plus an imported STL reference body. */
export async function partWithImport(id = 'doc-1'): Promise<ManufaktureDocument> {
  const feature = await stlImport();
  return unwrapDoc(
    applyCommand(partDocument(id), { type: 'addFeature', partId: 'part#1', feature }),
  );
}

/**
 * A font a user added, as the document stores it: `bytes` (persistence never parses them; any
 * bytes stand in for a font file) as base64 with their size and SHA-256.
 */
export async function userFont(
  bytes: Uint8Array = cubeStl(12),
  id = 'font#2',
  fileName = 'Label.otf',
): Promise<DocumentFont> {
  return {
    id,
    family: 'Label',
    style: 'Regular',
    source: {
      kind: 'file',
      fileName,
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      data: toBase64(bytes),
    },
  };
}

/** The bundled font as a document records it: by id and SHA-256, no bytes. */
export const BUNDLED_FONT: DocumentFont = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: {
    kind: 'bundled',
    id: 'inter-bold',
    sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
  },
};

/** The demo part with the bundled font and a user font, and a text in that user font. */
export async function partWithFonts(id = 'doc-1'): Promise<ManufaktureDocument> {
  let doc = partDocument(id);
  doc = unwrapDoc(applyCommand(doc, { type: 'addFont', font: BUNDLED_FONT }));
  doc = unwrapDoc(applyCommand(doc, { type: 'addFont', font: await userFont() }));
  const part = doc.parts[0]!;
  const sketch = part.features.find((f) => f.kind === 'sketch')!;
  const text: OutlineEntity = {
    id: `e${part.nextIds.e ?? 1}`,
    kind: 'outline',
    construction: false,
    anchor: [0, 0],
    angle: 0,
    source: {
      kind: 'text',
      text: 'M3',
      font: 'font#2',
      size: mm('5'),
      align: { horizontal: 'left', vertical: 'baseline' },
    },
  };
  return unwrapDoc(
    applyCommand(doc, {
      type: 'editFeature',
      partId: part.id,
      feature: { ...sketch, entities: [...sketch.entities, text] },
    }),
  );
}

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
const deg = mm;

/**
 * A derived feature pinning `source` (by default the demo part with an imported STL, so the pin
 * holds a file of its own) at version `v-1`: `data` is its canonical text, hashed as UTF-8.
 */
export async function derivedFeature(
  source?: ManufaktureDocument,
  id = 'derived#1',
  versionName = 'Release 1',
): Promise<DerivedFeature> {
  const pinned = source ?? (await partWithImport('doc-src'));
  const data = serialize({ ...pinned, name: `${pinned.name} ✓` });
  const bytes = new TextEncoder().encode(data);
  return {
    id,
    kind: 'derived',
    name: 'Derived',
    suppressed: false,
    source: {
      documentId: pinned.id,
      documentName: pinned.name,
      versionId: 'v-1',
      versionName,
      partId: 'part#1',
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      data,
    },
    placement: {
      translation: [mm('0'), mm('0'), mm('0')],
      rotation: [deg('0'), deg('0'), deg('0')],
    },
    operation: 'new',
  };
}

/** An empty document deriving the demo part with an import (one pin, `derived#1`). */
export async function partWithDerived(id = 'doc-1'): Promise<ManufaktureDocument> {
  const feature = await derivedFeature();
  return unwrapDoc(
    applyCommand(emptyDocument(id, 'Deriving'), { type: 'addFeature', partId: 'part#1', feature }),
  );
}

/** An instance (`inst#n`) of the pinned version `derivedFeature` pins, at the origin. */
export async function pinnedInstance(id = 'inst#1'): Promise<Instance> {
  return {
    id,
    name: `Instance ${id.slice(5)}`,
    source: (await derivedFeature()).source,
    fixed: false,
    suppressed: false,
    pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
  };
}

/**
 * An empty document with an assembly (`assembly#1`) placing the pinned version `derivedFeature`
 * pins, as `inst#1`.
 */
export async function assemblyWithPinnedInstance(id = 'doc-1'): Promise<ManufaktureDocument> {
  const doc = unwrapDoc(
    applyCommand(emptyDocument(id, 'Assembling'), {
      type: 'addAssembly',
      assemblyId: 'assembly#1',
      name: 'Box',
    }),
  );
  return unwrapDoc(
    applyCommand(doc, {
      type: 'addInstance',
      assemblyId: 'assembly#1',
      instance: await pinnedInstance(),
    }),
  );
}

/**
 * A core `DocumentStore` with the app editor store's shape (`getState()` with the document, the
 * undo label and `execute`, `undo`, `redo`; `core` for its change events), for tests that edit a
 * document the way the app does and save what it logs.
 */
export function editorStore(doc: ManufaktureDocument) {
  const created = DocumentStore.create(doc);
  if (!created.ok) throw new Error(`Invalid document: ${created.error.message}`);
  const core = created.value;
  return {
    core,
    getState: () => ({
      document: core.document,
      undoLabel: core.undoStack.at(-1)?.label ?? null,
      execute: (command: Command, label?: string) => core.execute(command, label),
      undo: () => core.undo(),
      redo: () => core.redo(),
    }),
  };
}

export function emptyDocument(id = 'doc-1', name = 'Untitled'): ManufaktureDocument {
  return createDocument({ id, name });
}

/**
 * A backend's files as a map from path to bytes, read and changed directly (not through the
 * backend), as the tests damage files to see what the library makes of it.
 */
export interface FileMap extends Iterable<[string, Uint8Array]> {
  get(path: string): Uint8Array | undefined;
  set(path: string, bytes: Uint8Array): unknown;
  has(path: string): boolean;
  delete(path: string): unknown;
  keys(): Iterable<string>;
}

/** A backend the tests can look into: `MemoryBackend`, or a directory on disk in Node. */
export type TestBackend = StorageBackend & { readonly files: FileMap };

/** How the tests make backends. */
export interface TestBackends {
  make(): TestBackend;
  /** A copy of `from`'s files in a new backend of the same kind. */
  clone(from: TestBackend): TestBackend;
}

const memoryBackends: TestBackends = {
  make: () => new MemoryBackend(),
  clone: (from) => {
    const to = new MemoryBackend();
    for (const [k, v] of from.files) to.files.set(k, v.slice());
    return to;
  },
};

let backends: TestBackends = memoryBackends;

/**
 * Make the library's suites run on other backends (a setup file does this for Node: the
 * `library-node` test project). Memory by default.
 */
export function useTestBackends(next: TestBackends | null): void {
  backends = next ?? memoryBackends;
}

/** A new, empty backend of the kind the suite runs on. */
export function newBackend(): TestBackend {
  return backends.make();
}

/** A copy of a backend's files, to replay a crash from the same starting point. */
export function cloneBackend(from: TestBackend): TestBackend {
  return backends.clone(from);
}

/**
 * A backend that dies at its `crashAt`-th mutating operation (write, remove, removeTree),
 * counting from 0: the operation throws, and a torn write leaves the first half of its bytes.
 * Everything before it went through to `inner`, which a new library then reads, as after a
 * reload.
 */
export class CrashingBackend implements StorageBackend {
  readonly inner: TestBackend;
  readonly ops: string[] = [];
  crashAt: number | null;
  torn: boolean;

  constructor(inner: TestBackend, crashAt: number | null = null, torn = false) {
    this.inner = inner;
    this.crashAt = crashAt;
    this.torn = torn;
  }

  get kind(): BackendKind {
    return this.inner.kind;
  }

  #step(op: string): boolean {
    this.ops.push(op);
    return this.crashAt !== null && this.ops.length - 1 === this.crashAt;
  }

  read(path: string) {
    return this.inner.read(path);
  }

  list(dir: string) {
    return this.inner.list(dir);
  }

  async write(path: string, bytes: Uint8Array) {
    if (this.#step(`write ${path}`)) {
      if (this.torn) await this.inner.write(path, bytes.slice(0, Math.floor(bytes.length / 2)));
      throw new Error(`Simulated crash writing ${path}`);
    }
    await this.inner.write(path, bytes);
  }

  async remove(path: string) {
    if (this.#step(`remove ${path}`)) throw new Error(`Simulated crash removing ${path}`);
    await this.inner.remove(path);
  }

  async removeTree(dir: string) {
    if (this.#step(`removeTree ${dir}`)) throw new Error(`Simulated crash removing ${dir}`);
    await this.inner.removeTree(dir);
  }
}
