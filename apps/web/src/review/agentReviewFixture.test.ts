// @vitest-environment node
/// <reference types="node" />
// The fixture of the agent review e2e (e2e/agent-review.spec.ts), made here by a real headless
// session (`packages/session`) with the real bundle builder (`packages/review`) on the kernel in
// this thread: the M1 bracket as Main, one agent batch (a boss and a smaller fillet), submitted
// for review. The browser cannot read a branch a Node process wrote (ADR 0016 decision 10) and
// syncing agent branches is T8.4b, so the e2e seeds the browser's library with what this test
// checks in: the base document, the agent's batch as the session logged it, the stored bundle and
// its images. Ids a run makes up (the branch, its base version, the session, the document) are
// placeholders the e2e fills with its own.
//
// The test fails when the fixture no longer matches what the session and the builder make now
// (numbers to a relative 1e-9, images by SHA-256). Rewrite it on purpose, then read the diff:
//
//   UPDATE_FIXTURES=1 ../../node_modules/.bin/vitest run src/review/agentReviewFixture.test.ts
//
// (from apps/web).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleBuilder } from '@manufakture/review';
import * as prettier from 'prettier';
import { BackendBundleStore, type Session } from '@manufakture/session';
import { PART, bracketDocument } from '@manufakture/session/test-fixtures';
import { ok, seeded } from '@manufakture/session/test-setup';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_REVIEW_PLACEHOLDERS as P, type AgentReviewFixture } from './fixture';

const PATH = fileURLToPath(new URL('../../e2e/agent-review.fixture.json', import.meta.url));
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const SIZE = { width: 320, height: 240 } as const;
const CLIENT = 'Test agent';
const NOTE = 'A boss 4 mm tall on the upright, and a 2 mm fillet.';
const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

/** Where `actual` differs from `expected`: numbers to a relative 1e-9, the rest exactly. */
function differences(actual: unknown, expected: unknown, path = '', out: string[] = []): string[] {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const scale = Math.max(Math.abs(actual), Math.abs(expected), 1e-9);
    if (Math.abs(actual - expected) > 1e-9 * scale) out.push(`${path}: ${actual} != ${expected}`);
    return out;
  }
  if (
    typeof actual !== 'object' ||
    actual === null ||
    typeof expected !== 'object' ||
    expected === null
  ) {
    if (actual !== expected)
      out.push(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    return out;
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  for (const k of new Set([...Object.keys(a), ...Object.keys(e)])) {
    const p = `${path}.${k}`;
    if (!(k in a) || !(k in e)) out.push(`${p}: ${k in a ? 'not in the fixture' : 'missing'}`);
    else differences(a[k], e[k], p, out);
  }
  return out;
}

let session: Session | null = null;
afterAll(async () => {
  await session?.close();
});

describe('the agent review e2e fixture', () => {
  it('is what a session and the bundle builder make now', async () => {
    const base = bracketDocument();
    const seed = await seeded(base, { engine: 'in-process' });
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: CLIENT }));
    session = s;
    const fillet = s.document.parts[0]!.features.find((f) => f.id === 'fillet#1')!;
    ok(
      await s.apply({
        label: 'Add a boss and a smaller fillet',
        commands: [
          {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'sketch#$s',
              kind: 'sketch',
              name: 'Boss sketch',
              suppressed: false,
              plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
              entities: [
                { id: 'e$c', kind: 'circle', construction: false, center: [3, 0], radius: 2 },
              ],
              constraints: [],
            },
          },
          {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'extrude#$boss',
              kind: 'extrude',
              name: 'Boss',
              suppressed: false,
              profile: { sketch: 'sketch#$s' },
              operation: 'add',
              extent: { type: 'blind', distance: mm(4) },
              reverse: false,
            },
          },
          { type: 'editFeature', partId: PART, feature: { ...fillet, radius: mm(2) } },
        ],
      }),
    );
    ok(await s.submit(bundleBuilder({ imageSize: SIZE }), NOTE));

    const store = new BackendBundleStore(seed.backend);
    const stored = (await store.latest(seed.documentId, s.branch))!;
    expect(stored).not.toBeNull();
    const log = ok(await seed.library.readLog(seed.documentId, s.branch));
    const branch = ok(await seed.library.listBranches(seed.documentId)).find(
      (b) => b.id === s.branch,
    )!;
    const images: Record<string, string> = {};
    const bundle = stored.bundle as { renders: { base: unknown; head: unknown }[] };
    for (const view of bundle.renders) {
      for (const ref of [view.base, view.head] as ({ sha256: string } | null)[]) {
        if (ref === null) continue;
        const bytes = (await store.readBlob(seed.documentId, ref.sha256))!;
        images[ref.sha256] = Buffer.from(bytes).toString('base64');
      }
    }
    // The ids this run made up, as placeholders.
    const text = JSON.stringify({ ...stored, submittedAt: '2026-10-08T12:00:00.000Z' })
      .split(s.branch)
      .join(P.branch)
      .split(branch.fromVersion!)
      .join(P.baseVersion)
      .split(s.id)
      .join(P.session)
      .split(seed.documentId)
      .join(P.document);
    const made: AgentReviewFixture = {
      about:
        'Made by apps/web/src/review/agentReviewFixture.test.ts for e2e/agent-review.spec.ts: rewrite it there.',
      base,
      clientName: CLIENT,
      batches: log.map((e) => ({ label: e.label, command: e.command })),
      record: JSON.parse(text) as AgentReviewFixture['record'],
      images,
    };
    const json = `${JSON.stringify(made)}\n`;
    if (UPDATE || !existsSync(PATH)) {
      // Written as the repository's formatter writes JSON, so the check of formatting passes.
      const options = (await prettier.resolveConfig(PATH)) ?? {};
      writeFileSync(PATH, await prettier.format(json, { ...options, filepath: PATH }));
      if (!UPDATE) throw new Error('The fixture was missing and has been written: check it, rerun');
    }
    const checked = JSON.parse(readFileSync(PATH, 'utf8')) as AgentReviewFixture;
    expect(differences(JSON.parse(json), checked)).toEqual([]);
    // One batch, at the head revision the bundle names; the review key's ids are placeholders.
    expect(made.batches).toHaveLength(1);
    expect(made.record.revision).toBe(2);
    expect((made.record.bundle as { key: unknown }).key).toEqual({
      documentId: P.document,
      branch: P.branch,
      baseVersion: P.baseVersion,
      headRevision: 2,
    });
  });
});
