// Imported files, stored once by content. An `import` feature carries its file as base64 in the
// document (core README, "Imported geometry"); in storage and in `.mfk` files the bytes move to
// a content-addressed blob keyed by the SHA-256 the feature already stores, and the feature's
// `source` keeps everything but `data`. The same rewrite applies to logged commands, so a
// 20 MiB file is stored once however many snapshots and commands mention it.
//
// This is a storage form only: in memory, and to core, regen and the kernel, the document is
// unchanged (file format version 3, `data` inline). Loading puts the bytes back after checking
// each blob's SHA-256 and size against the feature.

import { fromBase64, sha256Hex, toBase64 } from '@manufakture/io';
import type { StorageBackend } from './backend';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `s` is a lower-case hex SHA-256, the only names blobs have. */
export const isSha256 = (s: string): boolean => SHA256.test(s);

/** An import feature (in a document or a command): `{ id, kind: 'import', source }`. */
function importSource(o: Json): Json | null {
  return o.kind === 'import' && typeof o.id === 'string' && isObject(o.source) ? o.source : null;
}

/** What a stored import points at: its blob and the file it was. */
export interface BlobRef {
  sha256: string;
  size: number;
  fileName: string;
}

/** Nested depth limit: documents and commands nest a few levels; this is far beyond. */
const MAX_DEPTH = 64;

function mapImports(value: unknown, f: (source: Json) => Json, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error('The document nests too deeply');
  if (Array.isArray(value)) return value.map((v) => mapImports(v, f, depth + 1));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    // JSON.parse makes `__proto__` an own key; assigning it would set the copy's prototype.
    // No document or command has one, so it is dropped.
    if (k === '__proto__') continue;
    out[k] = mapImports(v, f, depth + 1);
  }
  const source = importSource(value);
  if (source) out.source = f(source);
  return out;
}

/**
 * The storage form of `value` (a document's JSON, or a command): every import's `data` taken
 * out, and the bytes it held by SHA-256. Throws on a source whose `sha256` is not a hash.
 */
export function externalize(value: unknown): { value: unknown; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  const out = mapImports(value, (source) => {
    if (typeof source.data !== 'string') return source;
    const sha = source.sha256;
    if (typeof sha !== 'string' || !isSha256(sha)) {
      throw new Error('An imported file has no valid SHA-256');
    }
    blobs.set(sha, source.data);
    const { data: _data, ...rest } = source;
    void _data;
    return rest;
  });
  return { value: out, blobs };
}

/** The blobs a stored value needs: every import source without `data`. */
export function blobRefs(value: unknown): BlobRef[] {
  const refs = new Map<string, BlobRef>();
  mapImports(value, (source) => {
    if (typeof source.data !== 'string') {
      const { sha256, size, fileName } = source;
      if (typeof sha256 !== 'string' || !isSha256(sha256)) {
        throw new Error('An imported file names no valid blob');
      }
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
        throw new Error(`The imported file ${String(fileName)} has no valid size`);
      }
      refs.set(sha256, { sha256, size, fileName: typeof fileName === 'string' ? fileName : '' });
    }
    return source;
  });
  return [...refs.values()];
}

/** `value` with each import's `data` put back from `blobs` (base64 by SHA-256). */
export function hydrate(value: unknown, blobs: ReadonlyMap<string, string>): unknown {
  return mapImports(value, (source) => {
    if (typeof source.data === 'string' || typeof source.sha256 !== 'string') return source;
    const data = blobs.get(source.sha256);
    return data === undefined ? source : { ...source, data };
  });
}

/** A blob that is missing or does not match its hash or size. */
export class BlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobError';
  }
}

/**
 * Check `bytes` against what the import says it is. Throws a `BlobError` naming the file when
 * the size or the SHA-256 differs.
 */
export async function verifyBlob(ref: BlobRef, bytes: Uint8Array | null): Promise<void> {
  const name = ref.fileName || ref.sha256.slice(0, 12);
  if (!bytes) throw new BlobError(`The imported file ${name} is missing.`);
  if (bytes.length !== ref.size || (await sha256Hex(bytes)) !== ref.sha256) {
    throw new BlobError(`The imported file ${name} is damaged: its SHA-256 does not match.`);
  }
}

/**
 * Load and check every blob `value` needs through `read`, and return `value` with the bytes
 * back in place. Throws a `BlobError` for a missing or damaged blob.
 */
export async function hydrateFrom(
  value: unknown,
  read: (sha256: string) => Promise<Uint8Array | null>,
): Promise<unknown> {
  const blobs = new Map<string, string>();
  for (const ref of blobRefs(value)) {
    const bytes = await read(ref.sha256);
    await verifyBlob(ref, bytes);
    blobs.set(ref.sha256, toBase64(bytes!));
  }
  return hydrate(value, blobs);
}

/**
 * Blobs in one directory of a backend, named by SHA-256. A blob is written whole under its
 * final name: one cut short by a crash does not match its hash, so it is found on the next
 * write (which rewrites it) and on every load (which refuses it), never used.
 */
export class BlobStore {
  readonly #backend: StorageBackend;
  readonly #dir: string;
  /** Blobs checked against their hash since this store was made. */
  readonly #verified = new Set<string>();

  constructor(backend: StorageBackend, dir: string) {
    this.#backend = backend;
    this.#dir = dir;
  }

  #path(sha256: string): string {
    if (!isSha256(sha256)) throw new BlobError(`Not a blob name: ${sha256}`);
    return `${this.#dir}/${sha256}`;
  }

  /** The bytes stored under `sha256`, unchecked; null when there are none. */
  read(sha256: string): Promise<Uint8Array | null> {
    return this.#backend.read(this.#path(sha256));
  }

  /**
   * Store the file `base64` holds under `sha256`, unless a blob that matches is there already.
   * Returns the bytes written (0 when it was there).
   */
  async put(sha256: string, base64: string): Promise<number> {
    const path = this.#path(sha256);
    if (this.#verified.has(sha256)) return 0;
    const bytes = fromBase64(base64);
    const existing = await this.#backend.read(path);
    if (existing && existing.length === bytes.length && (await sha256Hex(existing)) === sha256) {
      this.#verified.add(sha256);
      return 0;
    }
    if ((await sha256Hex(bytes)) !== sha256) {
      throw new BlobError('An imported file does not match its SHA-256.');
    }
    await this.#backend.write(path, bytes);
    this.#verified.add(sha256);
    return bytes.length;
  }
}
