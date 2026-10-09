// M8 acceptance scenario T8.6c, "remodelling an existing frame" (docs/m8-acceptance/remodel-frame.md):
//
//   "On the shed, move the door 2' right, add a 3' window on the back wall, and show what new
//   lumber I need."
//
// A fixed tool-call sequence through the MCP server in process, on packages/session's M6 shed (the
// document the authoring guide's framing examples use). The first block does the request as far as
// the product allows. The second block holds the gap probes: each asserts a fact of the product as
// it is today that the plan's hypotheses name, so a fix flips the probe and the write-up's gap
// table must be updated with it.
//
// Facts of the fixture this relies on: the door (extension#7) is on the Right wall (extension#3),
// which runs from (192", 0) to (192", 144"); seen from outside (looking west), "right" is along
// +y, which is the wall's own direction, so 2' right is position 72" to 96". The Back wall
// (extension#2) runs 16' from (192", 144") to (0, 144"); a centred 3' window has its centre line at
// 96". An opening's `position` is the distance to its centre line.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MAIN_BRANCH } from '@manufakture/library';
import { shedDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, value, type Data, type Harness } from '../harness';

const DOC = 'doc-shed';
const PART = 'part#1';
const BACK = 'extension#2';
const RIGHT = 'extension#3';
const LEFT = 'extension#4';
const DOOR = 'extension#7';

const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });

let h: Harness;

beforeAll(async () => {
  h = await harness({ document: shedDocument() });
}, 60_000);

afterAll(async () => {
  await h.close();
});

/** The construction takeoff of the part studio, from get_quantities' answer. */
const takeoffOf = (q: Data): Data => q.quantities.takeoffs[0].takeoff;

/** Every framing member's full id the takeoff counts (its framing rows' sources). */
function memberIds(q: Data): Set<string> {
  const rows = takeoffOf(q).rows as Data[];
  return new Set(
    rows
      .filter((r) => r.category === 'framing')
      .flatMap((r) => (r.sources as { id: string }[]).map((s) => s.id)),
  );
}

const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
const ownedBy = (ids: Iterable<string>, owner: string) =>
  [...ids].filter((id) => id.startsWith(`${owner}:`));

async function feature(sessionId: string, featureId: string): Promise<Data> {
  return value(
    await h.call('get_object', {
      sessionId,
      query: { kind: 'feature', partId: PART, featureId },
    }),
  ).object;
}

/** `editFeature` of the whole feature (it replaces the feature), changed by `change`. */
const edit = (f: Data, change: (f: Data) => Data) => ({
  type: 'editFeature',
  partId: PART,
  feature: change(structuredClone(f)),
});

const warningsOf = (r: Data, featureId: string): string[] =>
  (r.errors as Data[])
    .filter((e) => e.featureId === featureId && e.severity === 'warning')
    .map((e) => e.message as string);

describe('remodel-frame: the request, scripted', () => {
  let sessionId: string;
  let branch: string;
  let window: string;
  let before: Data;
  let after: Data;

  it('opens a session on the shed and reads the takeoff as built', async () => {
    const s = value(await h.call('open_session', { documentId: DOC }));
    sessionId = s.sessionId;
    branch = s.branch;
    expect(s.branch).not.toBe(MAIN_BRANCH);
    // The outline counts members per wall, but nothing lists them: they are reached only through
    // the takeoff's row sources (and render patterns).
    expect(s.outline.parts[0].memberSets).toEqual(
      expect.arrayContaining([expect.objectContaining({ group: BACK, count: 18 })]),
    );
    before = value(await h.call('get_quantities', { sessionId }));
    expect(memberIds(before).size).toBe(156);
    const door = await feature(sessionId, DOOR);
    expect(door.dependsOn).toEqual([RIGHT]);
    expect(door.expressions.position).toEqual(IN(72));
  });

  it("moves the door 2' right along its wall", async () => {
    const door = await feature(sessionId, DOOR);
    const r = value(
      await h.call('apply', {
        sessionId,
        label: "Move the door 2' right",
        commands: [
          edit(door, (f) => ({ ...f, expressions: { ...f.expressions, position: IN(96) } })),
        ],
      }),
    );
    expect(r.errors).toEqual([]);
  });

  it("adds a 3' window centred on the back wall", async () => {
    const r = value(
      await h.call('apply', {
        sessionId,
        label: "Add a 3' window on the back wall",
        commands: [
          {
            type: 'addFeature',
            partId: PART,
            feature: {
              id: 'extension#$window',
              kind: 'extension',
              name: 'Back window',
              suppressed: false,
              extension: 'construction.opening',
              schemaVersion: 1,
              dependsOn: [BACK],
              references: [],
              expressions: { position: IN(96), width: IN(36), height: IN(36), sill: IN(44) },
              params: { kind: 'window', segment: 1, from: 'start', header: { kind: 'auto' } },
            },
          },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    window = r.symbols.$window;
    expect(window).toBe('extension#10');
  });

  it('renders the changed walls, base against head, members only', async () => {
    const r = await h.raw('render', {
      sessionId,
      compare: true,
      views: [
        { camera: { view: 'back', fit: [`${BACK}*`] }, only: 'members', width: 480, height: 360 },
        { camera: { view: 'right', fit: [`${RIGHT}*`] }, only: 'members', width: 480, height: 360 },
      ],
    });
    const s = r.structuredContent as Data;
    expect(s.ok).toBe(true);
    expect(s.images).toHaveLength(4);
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(4);
  });

  it('finds "new lumber" only as a difference of member ids, which the move hides', async () => {
    after = value(await h.call('get_quantities', { sessionId }));
    const b = memberIds(before);
    const a = memberIds(after);
    const added = minus(a, b);
    const removed = minus(b, a);
    // The window's own members are all new: kings, jacks, header plies, sill, cripples.
    const windowMembers = ownedBy(a, window);
    expect(windowMembers.length).toBeGreaterThanOrEqual(8);
    expect(ownedBy(added, window)).toEqual(windowMembers.sort());
    // The window hides back-wall layout studs: they leave the takeoff as if they never existed,
    // though on site they are demolished (or reused).
    expect(ownedBy(removed, BACK).length).toBeGreaterThan(0);
    expect(ownedBy(removed, BACK).every((id) => /:s\d+$/.test(id))).toBe(true);
    // The door's old spot gets layout studs back and its new spot loses some.
    expect(ownedBy(added, RIGHT).length).toBeGreaterThan(0);
    expect(ownedBy(removed, RIGHT).length).toBeGreaterThan(0);
    // GAP PROBE (phase): the door's members keep their ids when it moves (they belong to the
    // opening), so an id diff says the door needs no new lumber, although its kings, jacks,
    // header and cripples are rebuilt 2' along the wall.
    expect(ownedBy(a, DOOR).sort()).toEqual(ownedBy(b, DOOR).sort());
    expect(ownedBy(added, DOOR)).toEqual([]);
    // Nor do the right wall's bottom plate pieces either side of the door: same ids, new lengths.
    const lengthOf = (q: Data, id: string): number =>
      (takeoffOf(q).rows as Data[]).find(
        (r) => r.category === 'framing' && (r.sources as { id: string }[]).some((s) => s.id === id),
      )!.size.length;
    for (const piece of [`${RIGHT}:bottom1:1`, `${RIGHT}:bottom1:2`]) {
      expect(a.has(piece) && b.has(piece)).toBe(true);
      expect(lengthOf(after, piece)).not.toBeCloseTo(lengthOf(before, piece), 0);
    }
  });

  it('GAP PROBE (phase): the takeoff counts the whole frame, with no phase on any row', async () => {
    const t = takeoffOf(after);
    const each = (t.totals as Data[]).find((x) => x.group === 'framing' && x.unit === 'each');
    expect(each!.value).toBe(memberIds(after).size);
    expect(each!.value).toBeGreaterThan(150);
    for (const row of t.rows as Data[]) {
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['phase']));
    }
    // Only categories, no "new" or "demolish" split.
    expect(new Set((t.rows as Data[]).map((r) => r.category))).toEqual(
      new Set(['framing', 'linear', 'faces', 'lumber', 'sheet']),
    );
  });

  it('exports the takeoff from the unreviewed branch', async () => {
    const r = value(
      await h.call('export', { sessionId, format: 'takeoff-csv', fileName: 'shed-remodel' }),
    );
    expect(r.reviewed).toBe(false);
    const csv = await readFile(path.join(h.outputDir, r.files[0].name), 'utf8');
    expect(csv).toMatch(/Header/);
  });

  it('draws the back wall framing only by building the drawing by hand', async () => {
    // The app's "Construction set" button is app code (apps/web/src/construction/drawings/set.ts),
    // not a command: an agent writes the drawing, its sheet and its view itself.
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Framing elevation of the back wall',
        commands: [
          {
            type: 'addDrawing',
            drawing: {
              id: 'drawing#$framing',
              name: 'Remodel',
              nextIds: { sheet: 2, view: 2 },
              sheets: [
                {
                  id: 'sheet#1',
                  name: 'Framing: Back',
                  size: 'tabloid',
                  orientation: 'landscape',
                  titleBlock: { fields: [{ label: 'Title', value: 'Shed remodel' }] },
                  views: [
                    {
                      id: 'view#1',
                      source: {
                        domain: 'construction',
                        part: PART,
                        schemaVersion: 1,
                        params: { kind: 'elevation', wall: BACK },
                      },
                      direction: { direction: [0, -1, 0], up: [0, 0, 1] },
                      scale: { paper: IN('1/4'), model: IN(12) },
                      position: [215, 140],
                      options: { hidden: false, smooth: false },
                    },
                  ],
                  dimensions: [],
                  notes: [],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    const drawingId = r.symbols.$framing as string;
    const svg = value(
      await h.call('export', { sessionId, format: 'drawing-svg', drawingId, fileName: 'back' }),
    );
    const text = await readFile(path.join(h.outputDir, svg.files[0].name), 'utf8');
    expect(text).toMatch(/^<\?xml|^<svg/);
  });

  it('submits; the bundle shows the takeoff change as net counts per row', async () => {
    const r = value(
      await h.call('submit_for_review', {
        sessionId,
        note: "Door moved 2' right; 3' window centred on the back wall.",
      }),
    );
    expect(r.review).toBe('submitted');
    const stored = await h.app.library.reviewBundle(DOC, branch);
    if (!stored.ok || stored.value === null) throw new Error('no bundle');
    const bundle = (stored.value.record as Data).bundle as Data;
    const totals = bundle.quantities.totals as Data[];
    const each = totals.find((x) => x.group === 'framing' && x.unit === 'each')!;
    // GAP PROBE (phase): base and head totals, not new material: the door's rebuilt members do
    // not show, and the studs the openings remove are netted against those they add.
    expect(each.head - each.base).toBe(memberIds(after).size - memberIds(before).size);
    expect(each.head - each.base).toBeLessThan(
      ownedBy(memberIds(after), window).length + ownedBy(memberIds(after), DOOR).length,
    );
    value(await h.call('close_session', { sessionId }));
  });
});

describe('remodel-frame: gap probes', () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = value(await h.call('open_session', { documentId: DOC })).sessionId;
  });

  it('GAP PROBE (phase): an opening or wall cannot be marked existing, new or demolished', async () => {
    const door = await feature(sessionId, DOOR);
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Mark the door existing',
        dryRun: true,
        commands: [edit(door, (f) => ({ ...f, params: { ...f.params, phase: 'existing' } }))],
      }),
    );
    expect(r.errors).toEqual([
      expect.objectContaining({
        featureId: DOOR,
        severity: 'error',
        message: 'unknown field "phase"',
      }),
    ]);
    // Nor a member: an override is { id, delete?, stock? } and a nudge.
    const left = await feature(sessionId, LEFT);
    const m = value(
      await h.call('apply', {
        sessionId,
        label: 'Mark a stud demolished',
        dryRun: true,
        commands: [
          edit(left, (f) => ({
            ...f,
            params: { ...f.params, overrides: [{ id: 's3', phase: 'demolish' }] },
          })),
        ],
      }),
    );
    // (The floor and roof read that wall, so they fail after it.)
    expect(m.errors).toContainEqual(
      expect.objectContaining({
        featureId: LEFT,
        severity: 'error',
        message: 'unknown field "phase"',
      }),
    );
  });

  it('GAP PROBE (as-built): a stud can be nudged off the layout, but none can be added', async () => {
    const left = await feature(sessionId, LEFT);
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'As built: s3 is 3" off, s4 and s8 are missing, one extra stud',
        commands: [
          edit(left, (f) => ({
            ...f,
            params: {
              ...f.params,
              overrides: [
                { id: 's4', delete: true },
                { id: 's8', delete: true },
                { id: 's3' },
                { id: 'extra1', stock: 'us-2x4' },
              ],
            },
            expressions: { ...f.expressions, move_3: IN(3) },
          })),
        ],
      }),
    );
    // The nudge and the deletes apply; the extra stud is an override of a member the wall does not
    // have, reported lost (with a message that says "no longer").
    expect(warningsOf(r, LEFT)).toEqual([
      'The override of extra1 on extension#4 is lost: the wall no longer has that member.',
    ]);
    const ids = ownedBy(memberIds(value(await h.call('get_quantities', { sessionId }))), LEFT);
    expect(ids).toContain(`${LEFT}:s3`);
    expect(ids).not.toContain(`${LEFT}:s4`);
    expect(ids).not.toContain(`${LEFT}:s8`);
    expect(ids.some((id) => id.includes('extra'))).toBe(false);
  });

  it('GAP PROBE (layout): changing the spacing renumbers studs; overrides re-target or are lost', async () => {
    const left = await feature(sessionId, LEFT);
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Left wall at 24" on centre',
        commands: [
          edit(left, (f) => ({ ...f, expressions: { ...f.expressions, spacing: IN(24) } })),
        ],
      }),
    );
    // s8 (at 128" on 16" centres) no longer exists: lost, with a warning.
    expect(warningsOf(r, LEFT)).toContain(
      'The override of s8 on extension#4 is lost: the wall no longer has that member.',
    );
    // s4 still exists, now centred at 96" instead of 64": the delete silently applies to another
    // stud, and the 3" nudge of s3 moves the stud at 72" instead of 48". No warning says so.
    expect(warningsOf(r, LEFT).some((w) => /\bs4\b|\bs3\b/.test(w))).toBe(false);
    const ids = ownedBy(memberIds(value(await h.call('get_quantities', { sessionId }))), LEFT);
    expect(ids.filter((id) => /:s\d+$/.test(id)).sort()).toEqual(
      [`${LEFT}:s0`, `${LEFT}:s1`, `${LEFT}:s2`, `${LEFT}:s3`, `${LEFT}:s5`, `${LEFT}:s6`].sort(),
    );
  });

  it('GAP PROBE (domain data): setDomainData replaces the whole namespace', async () => {
    const data = value(
      await h.call('get_object', {
        sessionId,
        query: { kind: 'domain', namespace: 'construction' },
      }),
    ).object;
    expect(Object.keys(data.data).sort()).toEqual(
      ['floorTypes', 'levels', 'roofTypes', 'wallTypes'].sort(),
    );
    // Only the framing defaults, as a change of one setting would naturally be written: every
    // level and type is gone, and every wall, floor and roof fails.
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Framing at 24" on centre',
        dryRun: true,
        commands: [
          {
            type: 'setDomainData',
            namespace: 'construction',
            schemaVersion: 1,
            data: { framing: { spacing: IN(24) } },
          },
        ],
      }),
    );
    const failed = new Set(
      (r.errors as Data[]).filter((e) => e.severity === 'error').map((e) => e.featureId),
    );
    for (const wall of ['extension#1', BACK, RIGHT, LEFT]) expect(failed).toContain(wall);
    value(await h.call('close_session', { sessionId }));
  });

  it('GAP PROBE (merge): two branches touching one wall or the domain data: the later wins whole', async () => {
    const domain = async (sid: string) =>
      value(
        await h.call('get_object', {
          sessionId: sid,
          query: { kind: 'domain', namespace: 'construction' },
        }),
      ).object;

    // Branch A: a header rule, and a stud of the back wall left out.
    const a = value(await h.call('open_session', { documentId: DOC }));
    const dataA = await domain(a.sessionId);
    const backA = await feature(a.sessionId, BACK);
    value(
      await h.call('apply', {
        sessionId: a.sessionId,
        label: 'Header rule; back wall s3 left out',
        commands: [
          {
            type: 'setDomainData',
            namespace: 'construction',
            schemaVersion: dataA.schemaVersion,
            data: {
              ...dataA.data,
              headerRules: [
                {
                  maxWidth: IN(48),
                  header: { stock: 'us-2x8', plies: 2, jacks: 1 },
                },
              ],
            },
          },
          edit(backA, (f) => ({
            ...f,
            params: { ...f.params, overrides: [{ id: 's3', delete: true }] },
          })),
        ],
      }),
    );
    value(await h.call('close_session', { sessionId: a.sessionId }));

    // Branch B, from the same Main: framing defaults, and the back wall a little lower.
    const b = value(await h.call('open_session', { documentId: DOC }));
    const dataB = await domain(b.sessionId);
    const backB = await feature(b.sessionId, BACK);
    value(
      await h.call('apply', {
        sessionId: b.sessionId,
        label: 'Framing defaults; back wall height',
        commands: [
          {
            type: 'setDomainData',
            namespace: 'construction',
            schemaVersion: dataB.schemaVersion,
            data: { ...dataB.data, framing: { blocking: { kind: 'mid-height' } } },
          },
          edit(backB, (f) => ({ ...f, expressions: { ...f.expressions, height: IN(96) } })),
        ],
      }),
    );
    value(await h.call('close_session', { sessionId: b.sessionId }));

    // The reviewer approves A (merged into Main), then looks at B's merge.
    const merged = await h.app.library.mergeBranch(DOC, a.branch, MAIN_BRANCH);
    if (!merged.ok) throw new Error(merged.message);
    const plan = await h.app.library.previewMerge(DOC, b.branch, MAIN_BRANCH);
    if (!plan.ok) throw new Error(plan.message);
    // Nothing is dropped: B's commands apply, and replace what A changed, whole.
    expect(plan.value.dropped).toEqual([]);
    expect(plan.value.replaced.length).toBe(2);
    const doc = plan.value.document;
    const construction = doc.domains!.construction!.data as Data;
    expect(construction.framing).toEqual({ blocking: { kind: 'mid-height' } });
    expect(construction.headerRules).toBeUndefined(); // A's header rule is gone
    const back = doc.parts[0]!.features.find((f) => f.id === BACK) as unknown as Data;
    expect(back.expressions.height).toEqual(IN(96));
    expect(back.params.overrides).toBeUndefined(); // A's left-out stud is back
  });
});
