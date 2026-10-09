// An agent branch with its review bundle in a memory library, for the Review view's tests: the
// checked-in e2e fixture (a real session's bracket edit and bundle, agentReviewFixture.test.ts)
// replayed the way the e2e seeds a browser: Main is the base document, the agent branch is made
// from its head with provenance, the agent's batch is saved on it, and the stored bundle is put
// with the branch, its placeholders filled with this library's ids.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { DocumentLibrary, MemoryBackend, type Branch, type LogEntry } from '@manufakture/library';
import { readBundle, type ReviewBundle } from '@manufakture/review/data';
import fixtureJson from '../../e2e/agent-review.fixture.json';
import type { PartModel } from '../model/model';
import { AGENT_REVIEW_PLACEHOLDERS as P, type AgentReviewFixture } from './fixture';
import type { AgentBranch, MeasuredHere } from './review';

export const FIXTURE = fixtureJson as unknown as AgentReviewFixture;
export const SESSION = 'session-1';

/** The fixture's stored bundle with the placeholders filled. */
export function filledRecord(ids: {
  document: string;
  branch: string;
  baseVersion: string;
  session?: string;
}): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(FIXTURE.record)
      .split(P.document)
      .join(ids.document)
      .split(P.branch)
      .join(ids.branch)
      .split(P.baseVersion)
      .join(ids.baseVersion)
      .split(P.session)
      .join(ids.session ?? SESSION),
  ) as Record<string, unknown>;
}

export function apply(doc: ManufaktureDocument, command: unknown): ManufaktureDocument {
  const r = applyCommand(doc, command as Command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

export interface Seeded {
  lib: DocumentLibrary;
  id: string;
  branch: AgentBranch;
  base: ManufaktureDocument;
  head: ManufaktureDocument;
  bundle: ReviewBundle;
  /** The library's branch list now, Main first. */
  branches(): Promise<Branch[]>;
}

/**
 * Main and the agent branch with its bundle, submitted. `edit` changes the stored record before
 * it is put (a measurement made to disagree, say).
 */
export async function seeded(
  options: { edit?: (record: Record<string, unknown>) => void; submit?: boolean } = {},
): Promise<Seeded> {
  let n = 0;
  const lib = new DocumentLibrary(new MemoryBackend(), {
    locks: null,
    newId: () => `id-${++n}`,
  });
  const base = FIXTURE.base as unknown as ManufaktureDocument;
  const id = base.id;
  await lib.save(base);
  const made = await lib.branchFromRevision(id, {
    version: { name: `Agent session ${SESSION} start` },
    name: `Agent session ${SESSION}`,
    provenance: {
      origin: 'agent',
      sessionId: SESSION,
      clientName: FIXTURE.clientName,
      review: 'open',
    },
  });
  if (!made.ok) throw new Error(made.message);
  const branchId = made.value.branch.id;
  await lib.open(id, branchId);
  let head = base;
  const entries: LogEntry[] = FIXTURE.batches.map((b) => {
    head = apply(head, b.command);
    return { cause: 'execute', label: b.label, command: b.command as Command, at: 'now' };
  });
  await lib.save(head, entries, branchId);
  const record = filledRecord({
    document: id,
    branch: branchId,
    baseVersion: made.value.version.id,
  });
  options.edit?.(record);
  const stored = await lib.storeReviewBundle(id, branchId, FIXTURE.record.revision, record);
  if (!stored.ok) throw new Error(stored.message);
  for (const b64 of Object.values(FIXTURE.images)) {
    const r = await lib.storeReviewImage(
      id,
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    if (!r.ok) throw new Error(r.message);
  }
  if (options.submit !== false) {
    const r = await lib.setBranchReview(id, branchId, 'submitted', { expected: 'open' });
    if (!r.ok) throw new Error(r.message);
  }
  const branches = async () => {
    const r = await lib.listBranches(id);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const branch = (await branches()).find((b) => b.id === branchId) as AgentBranch;
  // An edited record may not read (that is what such a test checks): it is passed on as it is.
  const read = readBundle(record.bundle);
  const bundle = read.ok ? read.bundle : (record.bundle as ReviewBundle);
  return { lib, id, branch, base, head, bundle, branches };
}

/** The bracket's one body as this app's model lists it. */
export const PARTS: PartModel[] = [
  {
    partId: 'part#1',
    features: [],
    bodies: [
      {
        bodyId: 'extrude#1',
        creator: 'extrude#1',
        solids: 1,
        view: { id: 'part#1/extrude#1' } as PartModel['bodies'][number]['view'],
      },
    ],
  },
];

/** Measures every body as the bundle's head has it, times `scale` for the volume. */
export function measureAsBundle(bundle: ReviewBundle, scale = 1) {
  return async (viewId: string): Promise<MeasuredHere> => {
    const body = bundle.measurements.bodies.items.find((b) => `${b.partId}/${b.bodyId}` === viewId);
    if (!body?.head) return { ok: false, message: 'No such body.' };
    return {
      ok: true,
      volume: body.head.volume * scale,
      area: body.head.area,
      boundingBox: body.head.boundingBox,
    };
  };
}

/**
 * Threat model N-1: a rename saved on the branch after its bundle, and the same bundle stored
 * again for the new head, as an agent with its token could `PUT` it: not stale, its measurements
 * still right (a rename changes no body), but its command list leaves the rename out. Returns
 * the head now.
 */
export function renameLeftOut(s: Seeded): Promise<ManufaktureDocument> {
  return savedAfterBundle(
    s,
    { type: 'renameFeature', partId: 'part#1', featureId: 'fillet#1', name: 'Quiet round' },
    'Rename a fillet',
  );
}

/** `command` saved on the branch after its bundle, and the bundle stored again for that head. */
export async function savedAfterBundle(
  s: Seeded,
  command: unknown,
  label: string,
): Promise<ManufaktureDocument> {
  const head = apply(s.head, command);
  await s.lib.save(
    head,
    [{ cause: 'execute', label, command: command as Command, at: 'x' }],
    s.branch.id,
  );
  const opened = await s.lib.open(s.id, s.branch.id);
  if (!opened.ok) throw new Error(opened.message);
  const stored = await s.lib.reviewBundle(s.id, s.branch.id);
  if (!stored.ok || stored.value === null) throw new Error('There is no bundle.');
  const record = structuredClone(stored.value.record) as {
    revision: number;
    bundle: { key: { headRevision: number } };
  };
  record.revision = opened.value.revision;
  record.bundle.key.headRevision = opened.value.revision;
  const put = await s.lib.storeReviewBundle(s.id, s.branch.id, opened.value.revision, record);
  if (!put.ok) throw new Error(put.message);
  return head;
}
