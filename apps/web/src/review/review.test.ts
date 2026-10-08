import { describe, expect, it } from 'vitest';
import {
  approvalLabel,
  approvalRecorded,
  approveBlockers,
  branchScripts,
  close,
  compareRegen,
  hasHiddenCharacters,
  loadReview,
  reviewStateText,
  type LoadedReview,
  type MergeStatus,
  type RegenStatus,
} from './review';
import { FIXTURE, PARTS, apply, measureAsBundle, seeded } from './review.test-fixture';

describe('loadReview', () => {
  it('reads the newest bundle of an agent branch, checked against its head', async () => {
    const s = await seeded();
    const r = await loadReview(s.lib, s.id, s.branch);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.stale).toBe(false);
    expect(r.revision).toBe(2);
    expect(r.head.revision).toBe(2);
    expect(r.note).toBe(FIXTURE.record.note);
    expect(r.bundle.key.branch).toBe(s.branch.id);
  });

  it('is stale once the branch was written after its bundle', async () => {
    const s = await seeded();
    const later = apply(s.head, { type: 'renameDocument', name: 'Later' });
    await s.lib.save(
      later,
      [
        {
          cause: 'execute',
          label: 'Rename',
          command: { type: 'renameDocument', name: 'Later' },
          at: 'x',
        },
      ],
      s.branch.id,
    );
    const r = await loadReview(s.lib, s.id, s.branch);
    expect(r.kind === 'ready' && r.stale).toBe(true);
  });

  it('says when there is none, and refuses a bundle for another branch or a broken one', async () => {
    const none = await seeded();
    // A second agent branch with no bundle.
    const other = await none.lib.branchFromRevision(none.id, {
      version: { name: 'Other start' },
      name: 'Other',
      provenance: { origin: 'agent', sessionId: 'session-2', clientName: 'X', review: 'open' },
    });
    if (!other.ok) throw new Error(other.message);
    const otherBranch = (await none.branches()).find((b) => b.id === other.value.branch.id)!;
    expect(await loadReview(none.lib, none.id, otherBranch as never)).toEqual({ kind: 'none' });

    const wrong = await seeded({
      edit: (r) => {
        (r.bundle as { key: { branch: string } }).key.branch = 'someone-else';
      },
    });
    expect(await loadReview(wrong.lib, wrong.id, wrong.branch)).toEqual({
      kind: 'error',
      message: 'The bundle is for another document or branch.',
    });
    const broken = await seeded({
      edit: (r) => {
        (r.bundle as { documentName: string }).documentName = 'x'.repeat(501);
      },
    });
    const read = await loadReview(broken.lib, broken.id, broken.branch);
    expect(read.kind).toBe('error');
  });
});

describe('compareRegen', () => {
  it('matches a regen that measures what the bundle says', async () => {
    const s = await seeded();
    const check = await compareRegen({
      bundle: s.bundle,
      document: s.head,
      parts: PARTS,
      measure: measureAsBundle(s.bundle),
    });
    expect(check).toEqual({ mismatches: [], unverified: [], notes: [], bodies: 1 });
  });

  it('is within an ULP or two, never beyond the tolerance', () => {
    expect(close(14702.7876562, 14702.7876562 * (1 + 2 * Number.EPSILON))).toBe(true);
    expect(close(0, 1e-12)).toBe(true);
    expect(close(14702.7876562, 14702.7876562 * (1 + 1e-6))).toBe(false);
  });

  it('lists every difference: a volume, a body only on one side, a name, an error', async () => {
    const s = await seeded();
    const off = await compareRegen({
      bundle: s.bundle,
      document: s.head,
      parts: PARTS,
      measure: measureAsBundle(s.bundle, 1.001),
    });
    expect(off.mismatches).toEqual([
      expect.stringMatching(
        /^Part 1 \/ Extrude 1: volume 14702\.78766 mm³ in the bundle, 14717\.\d+ mm³ here\.$/,
      ),
    ]);

    const extra = await compareRegen({
      bundle: s.bundle,
      document: s.head,
      parts: [
        {
          ...PARTS[0]!,
          bodies: [
            ...PARTS[0]!.bodies,
            {
              bodyId: 'extrude#9',
              creator: 'extrude#9',
              solids: 1,
              view: { id: 'part#1/extrude#9' } as never,
            },
          ],
          features: [
            {
              featureId: 'extrude#2',
              kind: 'extrude',
              errors: [{ code: 'no-profile', message: 'x' }],
            } as never,
          ],
        },
      ],
      measure: measureAsBundle(s.bundle),
    });
    expect(extra.mismatches).toEqual([
      'Part 1 / extrude#9: in this regen, not in the bundle.',
      'Part 1 / Boss: error "no-profile" 0 times in the bundle, 1 here.',
    ]);

    const renamed = await compareRegen({
      bundle: s.bundle,
      document: {
        ...s.head,
        parts: s.head.parts.map((p) => ({ ...p, bodies: [{ id: 'extrude#1', name: 'Bracket' }] })),
      } as never,
      parts: PARTS,
      measure: measureAsBundle(s.bundle),
    });
    expect(renamed.mismatches).toEqual(['Part 1 / Extrude 1: named "Bracket" here.']);
  });

  it('fails closed on a body it cannot measure and on a malformed bundle, without throwing', async () => {
    const s = await seeded();
    const failing = await compareRegen({
      bundle: s.bundle,
      document: s.head,
      parts: PARTS,
      measure: async () => ({ ok: false, message: 'The kernel has no body.' }),
    });
    expect(failing.mismatches).toEqual([
      'Part 1 / Extrude 1: cannot be measured here (The kernel has no body.).',
    ]);
    const malformed = {
      ...s.bundle,
      measurements: {
        bodies: { items: [{ partId: 3 }, 'x', null], omitted: 'many' },
        interference: 7,
      },
      regen: { new: { items: 'no' }, remaining: null },
    } as never;
    const check = await compareRegen({
      bundle: malformed,
      document: s.head,
      parts: PARTS,
      measure: measureAsBundle(s.bundle),
    });
    expect(check.mismatches).toContain('The bundle lists a body without a part or body id.');
    expect(check.mismatches).toContain('Part 1 / extrude#1: in this regen, not in the bundle.');
  });
});

const ready = (stale = false): LoadedReview => ({
  kind: 'ready',
  bundle: {} as never,
  note: '',
  revision: 2,
  head: { revision: 2, document: {} as never },
  stale,
});
const merge = { kind: 'ready', plan: { applied: [{}], dropped: [], changed: true } } as never;

describe('compareRegen with lists the bundle cut short', () => {
  const extraBody = {
    bodyId: 'extrude#9',
    creator: 'extrude#9',
    solids: 1,
    view: { id: 'part#1/extrude#9' } as never,
  };
  const errorFeature = {
    featureId: 'extrude#2',
    kind: 'extrude',
    errors: [{ code: 'no-profile', message: 'x' }],
  } as never;

  it('never passes a bundle that lists no bodies and says it left them out', async () => {
    const s = await seeded();
    const bundle = {
      ...s.bundle,
      measurements: { ...s.bundle.measurements, bodies: { items: [], omitted: 3 } },
    } as never;
    const check = await compareRegen({
      bundle,
      document: s.head,
      parts: PARTS,
      measure: measureAsBundle(s.bundle),
    });
    expect(check.mismatches).toEqual([]);
    expect(check.bodies).toBe(0);
    expect(check.unverified).toEqual([
      '1 body of this regen is not in the bundle, which left out 3 of its bodies: it is not compared (Part 1 / extrude#1).',
    ]);
    // It waits for the reviewer's acknowledgement.
    const regen = { kind: 'done', check } as const;
    const base = { state: 'submitted', review: ready(), regen, merge, scripts: [] };
    expect(approveBlockers({ ...base, acknowledged: false })).toEqual([
      'Acknowledge what the bundle left out and this app could not compare.',
    ]);
    expect(approveBlockers({ ...base, acknowledged: true })).toEqual([]);
  });

  it('is a mismatch when this regen has more bodies than the bundle can have left out', async () => {
    const s = await seeded();
    const bundle = {
      ...s.bundle,
      measurements: { ...s.bundle.measurements, bodies: { items: [], omitted: 1 } },
    } as never;
    const check = await compareRegen({
      bundle,
      document: s.head,
      parts: [{ ...PARTS[0]!, bodies: [...PARTS[0]!.bodies, extraBody] }],
      measure: measureAsBundle(s.bundle),
    });
    expect(check.mismatches).toEqual([
      'Part 1 / extrude#1: in this regen, not in the bundle.',
      'Part 1 / extrude#9: in this regen, not in the bundle.',
    ]);
    expect(check.unverified).toEqual([]);
  });

  it('still compares errors when the bundle left some out: an error it lists must be here', async () => {
    const s = await seeded();
    const issue = {
      where: 'feature',
      severity: 'error',
      partId: 'part#1',
      featureId: 'extrude#2',
      code: 'no-profile',
      message: 'x',
    };
    const cut = (items: unknown[], omitted: number) =>
      ({
        ...s.bundle,
        regen: { ...s.bundle.regen, new: { items, omitted }, remaining: { items: [], omitted: 0 } },
      }) as never;
    // Listed in the bundle, not here: a difference, whatever was left out.
    const listed = await compareRegen({
      bundle: cut([issue], 5),
      document: s.head,
      parts: PARTS,
      measure: measureAsBundle(s.bundle),
    });
    expect(listed.mismatches).toEqual([
      'Part 1 / Boss: error "no-profile" 1 times in the bundle, 0 here.',
    ]);
    // Here, not listed, and the bundle left one out: unverified.
    const withError = [{ ...PARTS[0]!, features: [errorFeature] }];
    const maybe = await compareRegen({
      bundle: cut([], 1),
      document: s.head,
      parts: withError,
      measure: measureAsBundle(s.bundle),
    });
    expect(maybe.mismatches).toEqual([]);
    expect(maybe.unverified).toEqual([
      'This regen has 1 feature error the bundle does not list, which left out 1 errors at head: Part 1 / Boss: error "no-profile" 0 times in the bundle, 1 here.',
    ]);
    // More than it left out: a difference.
    const more = await compareRegen({
      bundle: cut([], 0),
      document: s.head,
      parts: withError,
      measure: measureAsBundle(s.bundle),
    });
    expect(more.mismatches).toEqual([
      'Part 1 / Boss: error "no-profile" 0 times in the bundle, 1 here.',
    ]);
  });
});

describe('branchScripts', () => {
  const script = (id: string, source: string, name = id) => ({
    id,
    name,
    language: 'javascript',
    apiVersion: 1,
    source,
  });
  const entry = (scriptId: string, source: string, extra: Record<string, unknown> = {}) => ({
    scriptId,
    name: scriptId,
    language: 'javascript',
    apiVersion: 1,
    change: 'added',
    source,
    truncated: false,
    hiddenCharacters: false,
    features: [],
    ...extra,
  });
  const withScripts = (head: object, scripts: unknown[]) =>
    ({ ...(head as object), scripts }) as never;

  it('shows the head’s sources, and a bundle that shows other sources is a mismatch', async () => {
    const s = await seeded();
    const head = withScripts(s.head, [
      script('script#1', 'return 1;'),
      script('script#2', 'return 2;'),
      script('script#3', 'return 3;'),
    ]);
    const bundle = {
      ...s.bundle,
      scripts: [
        // Same as the head.
        entry('script#1', 'return 1;'),
        // A harmless text where the head runs something else.
        entry('script#2', 'return "harmless";', { change: 'changed', previous: 'return 0;' }),
        // Cut short, and the start matches.
        entry('script#3', 'return', { truncated: true }),
        // Not on the branch at all.
        entry('script#4', 'return 4;'),
        // Deleted: shown from the bundle, runs nowhere.
        entry('script#5', 'return 5;', { change: 'deleted' }),
      ],
    } as never;
    const check = branchScripts(bundle, head);
    expect(check.mismatches).toEqual([
      'Script script#2: the bundle shows a source other than the branch head’s.',
      'Script script#4: in the bundle, not on the branch head.',
    ]);
    expect(check.scripts.map((x) => [x.id, x.change, x.source, x.differs])).toEqual([
      ['script#1', 'added', 'return 1;', false],
      ['script#2', 'changed', 'return 2;', true],
      ['script#3', 'added', 'return 3;', false],
      ['script#4', 'not on the branch', 'return 4;', true],
      ['script#5', 'deleted', 'return 5;', false],
    ]);
    expect(check.scripts[1]!.previous).toBe('return 0;');
  });

  it('lists a head script the bundle leaves out, and finds hidden characters itself', async () => {
    const s = await seeded();
    const sneaky = 'const ok = true; // \u202e }; evil(); {';
    const head = withScripts(s.head, [script('script#1', sneaky)]) as unknown as {
      scripts: { source: string }[];
    };
    // The bundle lists nothing and claims nothing is hidden.
    const check = branchScripts({ ...s.bundle, scripts: [] } as never, head as never);
    expect(check.mismatches).toEqual([]);
    expect(check.scripts).toHaveLength(1);
    expect(check.scripts[0]).toMatchObject({ change: 'unlisted', hiddenCharacters: true });
    // A bundle that says hiddenCharacters: false for it changes nothing.
    const lying = branchScripts(
      {
        ...s.bundle,
        scripts: [entry('script#1', head.scripts[0]!.source, { hiddenCharacters: false })],
      } as never,
      head as never,
    );
    expect(lying.scripts[0]!.hiddenCharacters).toBe(true);
    expect(hasHiddenCharacters('a\tb\nc\r\n')).toBe(false);
    expect(hasHiddenCharacters('a\u200bb')).toBe(true);
    expect(hasHiddenCharacters('a\ud800')).toBe(true);
    // A deleted script the head still has is a mismatch.
    const deleted = branchScripts(
      { ...s.bundle, scripts: [entry('script#1', 'x', { change: 'deleted' })] } as never,
      head as never,
    );
    expect(deleted.mismatches).toEqual([
      'Script script#1: the bundle says it was deleted, but the branch has it.',
    ]);
  });
});

describe('approveBlockers', () => {
  const matched: RegenStatus = {
    kind: 'done',
    check: { mismatches: [], unverified: [], notes: [], bodies: 1 },
  };
  const gate = { scripts: [] as string[], acknowledged: false };

  it('offers Approve only when every check passes', () => {
    expect(
      approveBlockers({ ...gate, state: 'submitted', review: ready(), regen: matched, merge }),
    ).toEqual([]);
    expect(
      approveBlockers({ ...gate, state: 'open', review: ready(), regen: matched, merge }),
    ).toEqual(['The branch is not submitted for review (Open: the agent is working).']);
    expect(
      approveBlockers({ ...gate, state: 'submitted', review: ready(true), regen: matched, merge }),
    ).toEqual(['The branch changed after its bundle was made.']);
    expect(
      approveBlockers({
        ...gate,
        state: 'submitted',
        review: ready(),
        regen: { kind: 'done', check: { mismatches: ['x'], unverified: [], notes: [], bodies: 1 } },
        merge,
      }),
    ).toEqual(['This app’s regen does not match the bundle.']);
    expect(
      approveBlockers({
        ...gate,
        state: 'submitted',
        review: ready(),
        regen: matched,
        merge: { kind: 'ready', plan: { applied: [], dropped: [{} as never], changed: true } },
      }),
    ).toEqual(['Some of its changes would not apply on Main.']);
    expect(
      approveBlockers({
        ...gate,
        state: 'submitted',
        review: ready(),
        regen: { kind: 'not-open' },
        merge,
      }),
    ).toEqual(['Open the branch so this app can regenerate it and compare.']);
    expect(
      approveBlockers({
        ...gate,
        state: 'submitted',
        review: { kind: 'none' },
        regen: matched,
        merge,
      }),
    ).toEqual(['The branch has no review bundle.']);
  });

  it('blocks on scripts that are not the head’s, and finishes only an approved branch', () => {
    expect(
      approveBlockers({
        ...gate,
        scripts: ['x'],
        state: 'submitted',
        review: ready(),
        regen: matched,
        merge,
      }),
    ).toEqual(['The bundle’s scripts are not the branch head’s.']);
    const unchanged: MergeStatus = {
      kind: 'ready',
      plan: { applied: [], dropped: [], changed: false },
    };
    const finish = { ...gate, review: ready(), regen: matched, finishing: true };
    expect(approveBlockers({ ...finish, state: 'approved', merge: unchanged })).toEqual([]);
    expect(approveBlockers({ ...finish, state: 'approved', merge })).toEqual([]);
    expect(approveBlockers({ ...finish, state: 'submitted', merge })).toEqual([
      'The branch is not approved (Submitted for review).',
    ]);
    expect(
      approveBlockers({
        ...gate,
        state: 'submitted',
        review: ready(),
        regen: matched,
        merge: unchanged,
      }),
    ).toEqual(['Main already has everything it changed.']);
  });
});

describe('labels', () => {
  it('names the session in the approval label, within 200 characters', () => {
    expect(approvalLabel({ sessionId: 'session-1', clientName: 'Test agent' })).toBe(
      'Approve agent session session-1 (Test agent)',
    );
    const long = approvalLabel({ sessionId: 's', clientName: 'x'.repeat(200) });
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith('Approve agent session s (')).toBe(true);
    expect(reviewStateText('changes-requested')).toBe('Changes requested');
    expect(reviewStateText('merged')).toBe('merged');
  });
});

describe('sameJson', () => {
  it('ignores key order and undefined keys, and nothing else', async () => {
    const { sameJson } = await import('./review');
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: [] }, { a: {} })).toBe(false);
  });
});

describe('approvalRecorded', () => {
  it('tells an approval Main records from one it does not', async () => {
    const s = await seeded();
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(false);
    const v = await s.lib.createVersion(s.id, {
      name: 'Approved',
      review: {
        branch: s.branch.id,
        sessionId: 'session-1',
        clientName: 'Test agent',
        bundleRevision: 2,
        label: 'Approve agent session session-1 (Test agent)',
      },
    });
    expect(v.ok).toBe(true);
    expect(await approvalRecorded(s.lib, s.id, s.branch.id)).toBe(true);
    expect(await approvalRecorded(s.lib, s.id, 'another')).toBe(false);
    expect(
      await approvalRecorded(
        { listVersions: async () => ({ ok: false, message: 'gone' }) },
        s.id,
        s.branch.id,
      ),
    ).toBeNull();
  });
});
