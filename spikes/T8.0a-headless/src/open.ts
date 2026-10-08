// Shared setup of the probes: a library on disk holding one fixture on Main, and a session host.

import { join } from 'node:path';
import { fixtureDocument, type FixtureName } from './fixtures';
import { freshRoot, NodeFsBackend } from './fs-backend';
import { nodeHost, type NodeHost } from './host';
import { SCRATCH } from './results';
import { HeadlessSession, PLAN_LIMITS, type SessionLimits } from './session';
import { DocumentLibrary } from './vendor/persistence/library';

export interface Opened {
  host: NodeHost;
  library: DocumentLibrary;
  backend: NodeFsBackend;
  root: string;
  session: HeadlessSession;
  ms: Record<string, number>;
}

/** A library directory with `name` saved on Main (revision 1), as a person left it. */
export async function seedLibrary(name: FixtureName, dir: string) {
  const root = await freshRoot(join(SCRATCH, 'libraries'), dir);
  const backend = new NodeFsBackend(root);
  const library = new DocumentLibrary(backend, { warn: (m) => console.warn(m) });
  const doc = fixtureDocument(name);
  await library.create(doc);
  return { root, backend, library, documentId: doc.id };
}

export function libraryAt(root: string) {
  const backend = new NodeFsBackend(root);
  return { backend, library: new DocumentLibrary(backend, { warn: (m) => console.warn(m) }) };
}

export async function openFixture(
  name: FixtureName,
  options: { dir?: string; host?: NodeHost; limits?: SessionLimits; sessionId?: string } = {},
): Promise<Opened> {
  const { root, backend, library, documentId } = await seedLibrary(name, options.dir ?? name);
  const host = options.host ?? (await nodeHost());
  const { session, ms } = await HeadlessSession.open({ library, root, ...host }, documentId, {
    sessionId: options.sessionId ?? `s-${name}`,
    limits: options.limits ?? PLAN_LIMITS,
  });
  return { host, library, backend, root, session, ms };
}
