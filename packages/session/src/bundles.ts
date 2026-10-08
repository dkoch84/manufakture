// Review bundles, stored with the branch (ADR 0016 decision 11). The session does not know what a
// bundle holds: `submit` takes a `BundleBuilder` (`@manufakture/review`'s `bundleBuilder`) and
// stores what it returns as JSON, keyed by the branch head's revision, so a bundle whose head
// moved is stale. Images go in as the document's blobs, by SHA-256, through `BundleContext.putBlob`.

import { createHash } from 'node:crypto';
import type { ManufaktureDocument } from '@manufakture/core';
import {
  BlobStore,
  ROOT,
  isBranchId,
  isSha256,
  isStorableId,
  type DocumentLibrary,
  type StorageBackend,
} from '@manufakture/library';
import type { RegenResult } from '@manufakture/regen';
import type { Engine } from './engine';
import type { SessionLimits } from './limits';

/** The branch's base: the version of Main it was made from. */
export interface BundleBase {
  versionId: string;
  document: ManufaktureDocument;
}

/** The branch's head as the session has it: its document, revision and last regen. */
export interface BundleHead {
  branch: string;
  revision: number;
  document: ManufaktureDocument;
  regen: RegenResult | null;
}

/** What a builder may use besides the two documents: reads, an engine of its own, blob storage. */
export interface BundleContext {
  documentId: string;
  /** The library, for reads: the branch's log and history, and the merge preview against Main. */
  library: DocumentLibrary;
  /**
   * Starts a new engine of the host's kind (a kernel of its own, never the session's). The
   * builder closes it.
   */
  engine: () => Promise<Engine>;
  /** The session's limits: the builder's regens and kernel calls keep to them. */
  limits: SessionLimits;
  /**
   * Store `bytes` (an image) as a blob of the document; returns its SHA-256, which the bundle
   * names it by. At most `MAX_BUNDLE_BLOB_BYTES` each.
   */
  putBlob: (bytes: Uint8Array) => Promise<string>;
}

/** Builds a review bundle (plain JSON data) for the branch's head against its base. */
export type BundleBuilder = (
  base: BundleBase,
  head: BundleHead,
  context: BundleContext,
) => Promise<unknown>;

export interface StoredBundle {
  format: 'manufakture-review-bundle';
  documentId: string;
  branch: string;
  /** The head revision it was built for. */
  revision: number;
  baseVersion: string;
  /** The agent's note to the reviewer (shown as text, never trusted). */
  note: string;
  /** ISO 8601. */
  submittedAt: string;
  bundle: unknown;
}

export interface BundleStore {
  put(record: StoredBundle): Promise<void>;
  /** The newest bundle stored for the branch, or null. */
  latest(documentId: string, branch: string): Promise<StoredBundle | null>;
  /** Store a bundle's image as a blob of the document; returns its SHA-256. */
  putBlob(documentId: string, bytes: Uint8Array): Promise<string>;
  /** A blob a bundle names, checked against its SHA-256; null when missing or damaged. */
  readBlob(documentId: string, sha256: string): Promise<Uint8Array | null>;
}

/** The largest bundle stored, as JSON in UTF-8 bytes. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** The largest blob (image) one bundle stores, in bytes. */
export const MAX_BUNDLE_BLOB_BYTES = 16 * 1024 * 1024;
/** The longest note to the reviewer, in characters. */
export const MAX_NOTE = 4000;

function checkIds(documentId: string, branch: string): void {
  if (!isStorableId(documentId) || !isBranchId(branch)) throw new Error('Invalid ids.');
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function checkBlob(bytes: Uint8Array): void {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > MAX_BUNDLE_BLOB_BYTES
  ) {
    throw new Error(`A bundle blob is 1 to ${MAX_BUNDLE_BLOB_BYTES} bytes.`);
  }
}

/** Bundles in memory (tests). */
export class MemoryBundleStore implements BundleStore {
  readonly #records = new Map<string, StoredBundle[]>();
  readonly #blobs = new Map<string, Uint8Array>();

  async put(record: StoredBundle): Promise<void> {
    checkIds(record.documentId, record.branch);
    const key = `${record.documentId}/${record.branch}`;
    this.#records.set(key, [...(this.#records.get(key) ?? []), structuredClone(record)]);
  }

  async latest(documentId: string, branch: string): Promise<StoredBundle | null> {
    return this.#records.get(`${documentId}/${branch}`)?.at(-1) ?? null;
  }

  async putBlob(documentId: string, bytes: Uint8Array): Promise<string> {
    if (!isStorableId(documentId)) throw new Error('Invalid ids.');
    checkBlob(bytes);
    const sha = sha256Of(bytes);
    this.#blobs.set(`${documentId}/${sha}`, bytes.slice());
    return sha;
  }

  async readBlob(documentId: string, sha256: string): Promise<Uint8Array | null> {
    return this.#blobs.get(`${documentId}/${sha256}`)?.slice() ?? null;
  }
}

const REVIEW = /^review-(\d{8})\.json$/;

/**
 * Bundles in the library's branch directory: `documents/<id>/branches/<branch>/review-<rev>.json`,
 * beside the branch's own files, which the library leaves alone (and deletes with the branch).
 * Their images are blobs of the document (`documents/<id>/blobs/<sha256>`, as imported files
 * are), which the library never prunes, so a bundle kept with a merge still finds them after its
 * branch is deleted. Paths are made only from ids the library itself stores, a revision number
 * and a SHA-256.
 */
export class BackendBundleStore implements BundleStore {
  readonly #backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.#backend = backend;
  }

  #dir(documentId: string, branch: string): string {
    checkIds(documentId, branch);
    return `${ROOT}/${documentId}/branches/${branch}`;
  }

  async put(record: StoredBundle): Promise<void> {
    const dir = this.#dir(record.documentId, record.branch);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw new Error('Invalid revision.');
    }
    const name = `review-${String(record.revision).padStart(8, '0')}.json`;
    await this.#backend.write(`${dir}/${name}`, new TextEncoder().encode(JSON.stringify(record)));
  }

  async latest(documentId: string, branch: string): Promise<StoredBundle | null> {
    const dir = this.#dir(documentId, branch);
    const names = (await this.#backend.list(dir)).filter((n) => REVIEW.test(n)).sort();
    for (const name of names.reverse()) {
      const bytes = await this.#backend.read(`${dir}/${name}`);
      if (bytes === null || bytes.length > MAX_BUNDLE_BYTES) continue;
      try {
        const record = JSON.parse(new TextDecoder().decode(bytes)) as StoredBundle;
        if (record.format === 'manufakture-review-bundle') return record;
      } catch {
        // A torn file: try the one before.
      }
    }
    return null;
  }

  async putBlob(documentId: string, bytes: Uint8Array): Promise<string> {
    if (!isStorableId(documentId)) throw new Error('Invalid ids.');
    checkBlob(bytes);
    const sha = sha256Of(bytes);
    await new BlobStore(this.#backend, `${ROOT}/${documentId}/blobs`).put(
      sha,
      Buffer.from(bytes).toString('base64'),
    );
    return sha;
  }

  async readBlob(documentId: string, sha256: string): Promise<Uint8Array | null> {
    if (!isStorableId(documentId) || !isSha256(sha256)) return null;
    const bytes = await this.#backend.read(`${ROOT}/${documentId}/blobs/${sha256}`);
    if (bytes === null || bytes.length > MAX_BUNDLE_BLOB_BYTES || sha256Of(bytes) !== sha256) {
      return null;
    }
    return bytes;
  }
}
