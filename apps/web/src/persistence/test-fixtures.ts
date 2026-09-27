// Documents and backends for the persistence tests.

import {
  applyCommand,
  createDocument,
  type ImportFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { importSource, writeBinaryStl } from '@manufakture/io';
import { demoDocument } from '../model/demo';
import { boxBody } from '../viewport/testMeshes';
import { MemoryBackend, type StorageBackend } from './backend';

/** A binary STL of a 10 mm cube. */
export function cubeStl(size = 10): Uint8Array {
  const mesh = boxBody({ size: [size, size, size] }).mesh;
  return writeBinaryStl({
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
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

/** The demo part (sketches, an extrude, fillets, a cut) under `id`. */
export function partDocument(id = 'doc-1', name = 'Bracket'): ManufaktureDocument {
  return { ...demoDocument(id), name };
}

/** The demo part plus an imported STL reference body. */
export async function partWithImport(id = 'doc-1'): Promise<ManufaktureDocument> {
  const feature = await stlImport();
  return unwrapDoc(
    applyCommand(partDocument(id), { type: 'addFeature', partId: 'part#1', feature }),
  );
}

export function emptyDocument(id = 'doc-1', name = 'Untitled'): ManufaktureDocument {
  return createDocument({ id, name });
}

/** A copy of a memory backend's files, to replay a crash from the same starting point. */
export function cloneBackend(from: MemoryBackend): MemoryBackend {
  const to = new MemoryBackend();
  for (const [k, v] of from.files) to.files.set(k, v.slice());
  return to;
}

/**
 * A backend that dies at its `crashAt`-th mutating operation (write, remove, removeTree),
 * counting from 0: the operation throws, and a torn write leaves the first half of its bytes.
 * Everything before it went through to `inner`, which a new library then reads, as after a
 * reload.
 */
export class CrashingBackend implements StorageBackend {
  readonly kind = 'memory';
  readonly inner: MemoryBackend;
  readonly ops: string[] = [];
  crashAt: number | null;
  torn: boolean;

  constructor(inner: MemoryBackend, crashAt: number | null = null, torn = false) {
    this.inner = inner;
    this.crashAt = crashAt;
    this.torn = torn;
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
