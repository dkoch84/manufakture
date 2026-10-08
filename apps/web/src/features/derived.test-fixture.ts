// A document library in memory for the derived part tests: documents with named versions, each
// version a document as it was. Counts its calls, so tests can say what was read.

import {
  applyCommand,
  createDocument,
  storedExpression,
  type Command,
  type DerivedFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { DocumentSummary, LibraryResult, Version } from '@manufakture/library';
import { pinOf, type PinLibrary } from './derived';

export interface FakeDocument {
  document: ManufaktureDocument;
  versions: { version: Version; document: ManufaktureDocument }[];
}

export function version(id: string, name: string, revision = 1): Version {
  return {
    id,
    name,
    description: '',
    revision,
    snapshotSha256: '0'.repeat(64),
    createdAt: `2026-09-${String(10 + revision).padStart(2, '0')}T10:00:00.000Z`,
  };
}

export type FakeLibrary = PinLibrary & {
  docs: Map<string, FakeDocument>;
  calls: string[];
};

export function fakeLibrary(docs: FakeDocument[]): FakeLibrary {
  const map = new Map(docs.map((d) => [d.document.id, d]));
  const calls: string[] = [];
  const missing = (id: string): LibraryResult<never> => ({
    ok: false,
    message: `There is no document "${id}".`,
  });
  return {
    docs: map,
    calls,
    async list(): Promise<DocumentSummary[]> {
      calls.push('list');
      return [...map.values()].map((d) => ({
        id: d.document.id,
        name: d.document.name,
        createdAt: '2026-09-01T10:00:00.000Z',
        savedAt: '2026-09-01T10:00:00.000Z',
        revision: 1,
        bytes: 1,
      }));
    },
    async listVersions(id) {
      calls.push(`listVersions ${id}`);
      const d = map.get(id);
      return d ? { ok: true, value: d.versions.map((v) => v.version) } : missing(id);
    },
    async readVersion(id, versionId) {
      calls.push(`readVersion ${id} ${versionId}`);
      const d = map.get(id);
      if (!d) return missing(id);
      const v = d.versions.find((x) => x.version.id === versionId);
      return v
        ? { ok: true, value: v }
        : { ok: false, message: `There is no version "${versionId}" of it.` };
    },
    async createVersion(id, meta) {
      calls.push(`createVersion ${id} ${meta.name}`);
      const d = map.get(id);
      if (!d) return missing(id);
      const made = version(`${id}-v${d.versions.length + 1}`, meta.name, d.versions.length + 1);
      d.versions.push({ version: made, document: d.document });
      return { ok: true, value: made };
    },
  };
}

export function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/** A derived feature pinning part#1 of `source` at `v`, at the origin, as a new body. */
export async function derivedOf(
  source: ManufaktureDocument,
  v: Version,
  extra: Partial<DerivedFeature> = {},
): Promise<DerivedFeature> {
  const pinned = await pinOf(source, v, 'part#1');
  if (!pinned.ok) throw new Error(pinned.message);
  const zero = storedExpression('0', source.units);
  return {
    id: 'derived#1',
    kind: 'derived',
    name: 'Derived 1',
    suppressed: false,
    source: pinned.value,
    placement: { translation: [zero, zero, zero], rotation: [zero, zero, zero] },
    operation: 'new',
    ...extra,
  };
}

/** An empty document deriving `feature` into part#1. */
export function deriving(feature: DerivedFeature, id = 'doc-b'): ManufaktureDocument {
  return apply(createDocument({ id, name: 'Deriving' }), {
    type: 'addFeature',
    partId: 'part#1',
    feature,
  });
}
