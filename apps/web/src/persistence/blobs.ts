// Imported files and pinned versions, stored once by content. An `import` feature carries its
// file as base64 in the document (core README, "Imported geometry"), and a `derived` feature
// carries the pinned source document as JSON text (core README, "Derived parts"), as does an
// assembly instance of a pinned part (core README, "Assemblies"); in storage and in `.mfk` files
// that content moves to a content-addressed blob keyed by the SHA-256 the source already stores,
// and the `source` keeps everything but `data`. The same rewrite applies to logged commands, so
// a 20 MiB file, or a pinned version, is stored once however many snapshots and commands mention
// it, and a version pinned by a derived feature and an instance alike is one blob.
//
// A blob is the bytes the hash is of: an import's file, or the UTF-8 text of a pinned document.
// In the `blobs` maps below both travel as base64, so `BlobStore.put` and `.mfk` packing treat
// them alike.
//
// This is a storage form only: in memory, and to core, regen and the kernel, the document is
// unchanged (`data` inline). Loading puts the content back after checking each blob's SHA-256
// and size against the feature.

import { fromBase64, sha256Hex, toBase64 } from '@manufakture/io';
import type { StorageBackend } from './backend';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `s` is a lower-case hex SHA-256, the only names blobs have. */
export const isSha256 = (s: string): boolean => SHA256.test(s);

/**
 * What a source belongs to: an import (a file), a derived part (a pin), or an assembly instance
 * of a pinned part (a pin, stored exactly like a derived part's).
 */
type SourceKind = 'import' | 'derived' | 'instance';

/**
 * Whether `source` is a pinned version's source (core `DerivedSourceSchema`): the shape a derived
 * feature's and a pinned instance's `source` share. An instance of a part of the same document
 * (`{ part, configuration? }`) is not one, and has no blob.
 */
function isPinnedSource(source: Json): boolean {
  return (
    typeof source.documentId === 'string' &&
    typeof source.versionId === 'string' &&
    typeof source.partId === 'string'
  );
}

/**
 * A source that holds a blob, and what it belongs to: an import or derived feature (in a
 * document or a command, `{ id, kind, source }`), or a pinned source anywhere else, which is an
 * instance's (`{ id, source }` in an assembly or an `addInstance`, or the `source` of an
 * `editInstance`; instances have no `kind`). Null for anything else.
 */
function blobSource(o: Json): { kind: SourceKind; source: Json } | null {
  if (!isObject(o.source)) return null;
  if (o.kind === 'import' || o.kind === 'derived') {
    return typeof o.id === 'string' ? { kind: o.kind, source: o.source } : null;
  }
  return isPinnedSource(o.source) ? { kind: 'instance', source: o.source } : null;
}

/** How errors name a source of each kind with a bad SHA-256. */
const NO_SHA256: Record<SourceKind, string> = {
  import: 'An imported file has no valid SHA-256',
  derived: 'A derived part has no valid SHA-256',
  instance: 'A pinned instance has no valid SHA-256',
};

/** How errors name a stored source of each kind that names no blob. */
const NO_BLOB: Record<SourceKind, string> = {
  import: 'An imported file names no valid blob',
  derived: 'A derived part names no valid blob',
  instance: 'A pinned instance names no valid blob',
};

/** What a stored import or derived source points at: its blob and what it was. */
export interface BlobRef {
  sha256: string;
  size: number;
  /** The imported file's name; for a derived source, the pinned version and its document. */
  fileName: string;
  /** Set for a pinned version (a derived part's or an instance's); absent for an imported file. */
  derived?: true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Nested depth limit: documents and commands nest a few levels; this is far beyond. */
const MAX_DEPTH = 64;

function mapSources(
  value: unknown,
  f: (source: Json, kind: SourceKind) => Json,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) throw new Error('The document nests too deeply');
  if (Array.isArray(value)) return value.map((v) => mapSources(v, f, depth + 1));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    // JSON.parse makes `__proto__` an own key; assigning it would set the copy's prototype.
    // No document or command has one, so it is dropped.
    if (k === '__proto__') continue;
    out[k] = mapSources(v, f, depth + 1);
  }
  const found = blobSource(value);
  if (found) out.source = f(found.source, found.kind);
  return out;
}

/**
 * The storage form of `value` (a document's JSON, or a command): every import's and pinned
 * source's `data` taken out (a derived feature's or an instance's), and the bytes it held by SHA-256, as base64. Throws on a source
 * whose `sha256` is not a hash.
 */
export function externalize(value: unknown): { value: unknown; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  const out = mapSources(value, (source, kind) => {
    if (typeof source.data !== 'string') return source;
    const sha = source.sha256;
    if (typeof sha !== 'string' || !isSha256(sha)) throw new Error(NO_SHA256[kind]);
    blobs.set(sha, kind === 'import' ? source.data : toBase64(encoder.encode(source.data)));
    const { data: _data, ...rest } = source;
    void _data;
    return rest;
  });
  return { value: out, blobs };
}

/**
 * The blobs a stored value needs: every import and pinned source (a derived feature's or an
 * instance's) without `data`. A source with `data` inline (a document stored before instances
 * moved out, or a plain document) needs none.
 */
export function blobRefs(value: unknown): BlobRef[] {
  const refs = new Map<string, BlobRef>();
  mapSources(value, (source, kind) => {
    if (typeof source.data !== 'string') {
      const { sha256, size } = source;
      const fileName =
        kind === 'import'
          ? source.fileName
          : `"${String(source.versionName)}" of ${String(source.documentName)}`;
      if (typeof sha256 !== 'string' || !isSha256(sha256)) throw new Error(NO_BLOB[kind]);
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
        throw new Error(
          kind === 'import'
            ? `The imported file ${String(fileName)} has no valid size`
            : `The pinned version ${fileName} has no valid size`,
        );
      }
      const ref: BlobRef = {
        sha256,
        size,
        fileName: typeof fileName === 'string' ? fileName : '',
      };
      if (kind !== 'import') ref.derived = true;
      // One blob is one set of bytes, however it is used; an import's name reads best in errors.
      if (!refs.has(sha256) || kind === 'import') refs.set(sha256, ref);
    }
    return source;
  });
  return [...refs.values()];
}

/**
 * `value` with each source's `data` put back from `blobs` (base64 by SHA-256): an import's as the
 * base64 text itself, a pinned source's (derived or instance) as the UTF-8 text the bytes hold. A
 * pinned blob that is not UTF-8 is left out, so the source stays without `data` and fails to load.
 */
export function hydrate(value: unknown, blobs: ReadonlyMap<string, string>): unknown {
  return mapSources(value, (source, kind) => {
    if (typeof source.data === 'string' || typeof source.sha256 !== 'string') return source;
    const data = blobs.get(source.sha256);
    if (data === undefined) return source;
    if (kind === 'import') return { ...source, data };
    try {
      return { ...source, data: decoder.decode(fromBase64(data)) };
    } catch {
      return source;
    }
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
 * Check `bytes` against what the import or derived source says it is. Throws a `BlobError`
 * naming the file (or the pinned version) when the size or the SHA-256 differs.
 */
export async function verifyBlob(ref: BlobRef, bytes: Uint8Array | null): Promise<void> {
  const name = ref.fileName || ref.sha256.slice(0, 12);
  const what = ref.derived ? `The pinned version ${name}` : `The imported file ${name}`;
  if (!bytes) throw new BlobError(`${what} is missing.`);
  if (bytes.length !== ref.size || (await sha256Hex(bytes)) !== ref.sha256) {
    throw new BlobError(`${what} is damaged: its SHA-256 does not match.`);
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
   * Store the bytes `base64` holds (an imported file, or a pinned version's UTF-8 text) under
   * `sha256`, unless a blob that matches is there already. Returns the bytes written (0 when it
   * was there).
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
      throw new BlobError('A stored file or pinned version does not match its SHA-256.');
    }
    await this.#backend.write(path, bytes);
    this.#verified.add(sha256);
    return bytes.length;
  }
}
