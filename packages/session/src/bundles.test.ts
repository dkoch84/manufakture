// A bundle a session stores (`BackendBundleStore`, in Node) is what the app's Review view reads
// through the library (`DocumentLibrary.reviewBundle` and `reviewImage`, T8.3b): the same file
// names, envelope and blobs, on the same storage.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendBundleStore, type StoredBundle } from './bundles';
import { bracketDocument } from './test/fixtures';
import { ok } from './test/setup';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function agentBranch() {
  const root = await mkdtemp(join(tmpdir(), 'mfk-bundles-'));
  roots.push(root);
  const backend = new NodeBackend(root);
  const library = new DocumentLibrary(backend);
  const doc = bracketDocument();
  await library.create(doc);
  const made = ok(
    await library.branchFromRevision(doc.id, {
      version: { name: 'Agent session s-1 start' },
      name: 'Agent session s-1',
      provenance: { origin: 'agent', sessionId: 's-1', clientName: 'Test', review: 'open' },
    }),
  );
  const record = (revision: number): StoredBundle => ({
    format: 'manufakture-review-bundle',
    documentId: doc.id,
    branch: made.branch.id,
    revision,
    baseVersion: made.version.id,
    note: `At ${revision}`,
    submittedAt: '2026-10-08T12:00:00.000Z',
    bundle: { revision },
  });
  return {
    backend,
    library,
    store: new BackendBundleStore(backend),
    id: doc.id,
    branch: made.branch.id,
    record,
  };
}

describe('BackendBundleStore and the library', () => {
  it('a bundle and its image a session stores read back through the library', async () => {
    const { library, store, id, branch, record } = await agentBranch();
    await store.put(record(2));
    await store.put(record(3));
    expect(ok(await library.reviewBundle(id, branch))).toEqual({
      revision: 3,
      record: record(3),
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const sha = await store.putBlob(id, png);
    expect(await library.reviewImage(id, sha)).toEqual(png);
    // And the other way: what the library stores, a session reads.
    ok(await library.storeReviewBundle(id, branch, 4, record(4)));
    expect((await store.latest(id, branch))?.revision).toBe(4);
    const shaBack = ok(await library.storeReviewImage(id, new Uint8Array([1, 2, 3])));
    expect(await store.readBlob(id, shaBack)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads revisions past eight digits, newest by number, on both sides', async () => {
    const { library, store, id, branch, record } = await agentBranch();
    await store.put(record(99_999_999));
    await store.put(record(100_000_001));
    await store.put(record(12));
    expect(ok(await library.reviewBundle(id, branch))?.revision).toBe(100_000_001);
    expect((await store.latest(id, branch))?.revision).toBe(100_000_001);
    ok(await library.storeReviewBundle(id, branch, 1_000_000_000_000, record(1_000_000_000_000)));
    expect(ok(await library.reviewBundle(id, branch))?.revision).toBe(1_000_000_000_000);
    expect((await store.latest(id, branch))?.revision).toBe(1_000_000_000_000);
  });
});
