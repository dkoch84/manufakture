// Review bundles, stored with the branch (ADR 0016 decision 11). The session does not know what a
// bundle holds: `submit` takes a `BundleBuilder` (T8.3a supplies the real one) and stores what it
// returns as JSON, keyed by the branch head's revision, so a bundle whose head moved is stale.

import type { ManufaktureDocument } from '@manufakture/core';
import { ROOT, isBranchId, isStorableId, type StorageBackend } from '@manufakture/library';
import type { RegenResult } from '@manufakture/regen';

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

/** Builds a review bundle (plain JSON data) for the branch's head against its base. */
export type BundleBuilder = (base: BundleBase, head: BundleHead) => Promise<unknown>;

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
}

/** The largest bundle stored, as JSON in UTF-8 bytes. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** The longest note to the reviewer, in characters. */
export const MAX_NOTE = 4000;

function checkIds(documentId: string, branch: string): void {
  if (!isStorableId(documentId) || !isBranchId(branch)) throw new Error('Invalid ids.');
}

/** Bundles in memory (tests). */
export class MemoryBundleStore implements BundleStore {
  readonly #records = new Map<string, StoredBundle[]>();

  async put(record: StoredBundle): Promise<void> {
    checkIds(record.documentId, record.branch);
    const key = `${record.documentId}/${record.branch}`;
    this.#records.set(key, [...(this.#records.get(key) ?? []), structuredClone(record)]);
  }

  async latest(documentId: string, branch: string): Promise<StoredBundle | null> {
    return this.#records.get(`${documentId}/${branch}`)?.at(-1) ?? null;
  }
}

const REVIEW = /^review-(\d{8})\.json$/;

/**
 * Bundles in the library's branch directory: `documents/<id>/branches/<branch>/review-<rev>.json`,
 * beside the branch's own files, which the library leaves alone (and deletes with the branch).
 * Paths are made only from ids the library itself stores and a revision number.
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
}
