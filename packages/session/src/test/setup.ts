// A library on disk holding one fixture on Main, as a person left it, and a session manager on
// it. Each call makes a new temporary directory.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManufaktureDocument } from '@manufakture/core';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend, NodeBranchLocks } from '@manufakture/library/node';
import { BackendBundleStore } from '../bundles';
import type { EngineKind } from '../engine';
import type { SessionLimits } from '../limits';
import { SessionManager } from '../manager';

export interface Seeded {
  root: string;
  backend: NodeBackend;
  library: DocumentLibrary;
  documentId: string;
  manager: SessionManager;
}

export async function seeded(
  doc: ManufaktureDocument,
  options: { engine?: EngineKind; limits?: Partial<SessionLimits> } = {},
): Promise<Seeded> {
  const root = await mkdtemp(join(tmpdir(), 'mfk-session-'));
  const backend = new NodeBackend(root);
  const library = new DocumentLibrary(backend);
  await library.create(doc);
  const manager = new SessionManager({
    library,
    locks: new NodeBranchLocks(root),
    bundles: new BackendBundleStore(backend),
    engine: options.engine ?? 'in-process',
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { root, backend, library, documentId: doc.id, manager };
}

/** The value of a session or library result, failing the test with its error otherwise. */
export function ok<T>(
  r: { ok: true; value: T } | { ok: false; error: unknown } | { ok: false; message: string },
): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.value;
}
