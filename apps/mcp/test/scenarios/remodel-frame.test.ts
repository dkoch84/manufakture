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
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAIN_BRANCH } from '@manufakture/library';
import { shedDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, value, type Data, type Harness, type Structured } from '../harness';

const DOC = 'doc-shed';
const PART = 'part#1';
const BACK = 'extension#2';
const RIGHT = 'extension#3';
const LEFT = 'extension#4';
const DOOR = 'extension#7';

const IN = (v: number | string) => ({ source: String(v), lengthUnit: 'in', angleUnit: 'deg' });
const IN_MM = (v: number) => v * 25.4;

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

/** A feature's framing members and overrides, read with get_object's members query. */
async function membersOf(sessionId: string, owner: string): Promise<Data> {
  return value(
    await h.call('get_object', { sessionId, query: { kind: 'members', partId: PART, owner } }),
  ).members;
}

/** The full ids of the members each of `owners` owns, read per feature (no takeoff). */
async function ownedIds(sessionId: string, owners: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const owner of owners) {
    for (const m of (await membersOf(sessionId, owner)).members as Data[]) ids.add(m.id);
  }
  return ids;
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
  /** Member ids of the back wall, the right wall and the door as built, read per feature. */
  let builtIds: Set<string>;
  let backBefore: Data;
  let baseVersion: string;
  /** get_quantities' compare answer, base against head. */
  let compared: Data;

  it('opens a session on the shed and reads the takeoff as built', async () => {
    const s = value(await h.call('open_session', { documentId: DOC }));
    sessionId = s.sessionId;
    branch = s.branch;
    baseVersion = s.baseVersion;
    expect(s.branch).not.toBe(MAIN_BRANCH);
    // The outline counts members per wall; get_object's members query lists them per feature.
    expect(s.outline.parts[0].memberSets).toEqual(
      expect.arrayContaining([expect.objectContaining({ group: BACK, count: 18 })]),
    );
    before = value(await h.call('get_quantities', { sessionId }));
    expect(memberIds(before).size).toBe(156);
    backBefore = await membersOf(sessionId, BACK);
    expect(backBefore).toMatchObject({ owner: BACK, kind: 'wall', framed: true, overrides: [] });
    builtIds = await ownedIds(sessionId, [BACK, RIGHT, DOOR]);
    // The same ids the takeoff counts.
    expect([...builtIds].sort()).toEqual(
      [...memberIds(before)].filter((id) => /^extension#[237]:/.test(id)).sort(),
    );
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
    // Ids read per feature with get_object's members query, not from the takeoff's row sources.
    const b = builtIds;
    const a = await ownedIds(sessionId, [BACK, RIGHT, DOOR, window]);
    const added = minus(a, b);
    const removed = minus(b, a);
    // The window's own members are all new: kings, jacks, header plies, sill, cripples.
    const win = await membersOf(sessionId, window);
    expect(win).toMatchObject({ kind: 'opening', wall: BACK, segment: 1, overrides: [] });
    const windowMembers = (win.members as Data[]).map((m) => m.id as string);
    expect(windowMembers.length).toBeGreaterThanOrEqual(8);
    expect(ownedBy(added, window)).toEqual(windowMembers.sort());
    // The studs under the window, found by position: the cripples below its 44" sill, within
    // its 3' rough opening centred at 96" along the back wall.
    const under = (win.members as Data[]).filter(
      (m) => m.role === 'cripple' && m.above.to <= 44 * 25.4 + 1e-6,
    );
    expect(under.length).toBeGreaterThan(0);
    for (const m of under) expect(Math.abs(m.along.centre - 96 * 25.4)).toBeLessThan(18 * 25.4);
    // The window hides back-wall layout studs: they leave the frame as if they never existed,
    // though on site they are demolished (or reused). They are the ones the wall listed between
    // the window's king studs before.
    const kings = (win.members as Data[]).filter((m) => m.role === 'king');
    const zone = [
      Math.min(...kings.map((m) => m.along.from)),
      Math.max(...kings.map((m) => m.along.to)),
    ];
    const hidden = (backBefore.members as Data[])
      .filter((m) => m.role === 'stud' && m.along.centre > zone[0]! && m.along.centre < zone[1]!)
      .map((m) => m.id as string);
    expect(hidden.sort()).toEqual([`${BACK}:s5`, `${BACK}:s6`, `${BACK}:s7`]);
    expect(ownedBy(removed, BACK)).toEqual(hidden);
    // The door's old spot gets layout studs back and its new spot loses some.
    expect(ownedBy(added, RIGHT).length).toBeGreaterThan(0);
    expect(ownedBy(removed, RIGHT).length).toBeGreaterThan(0);
    // GAP PROBE (phase): the door's members keep their ids when it moves (they belong to the
    // opening), so an id diff says the door needs no new lumber, although its kings, jacks,
    // header and cripples are rebuilt 2' along the wall.
    expect(ownedBy(a, DOOR).sort()).toEqual(ownedBy(b, DOOR).sort());
    expect(ownedBy(added, DOOR)).toEqual([]);
    // Nor do the right wall's bottom plate pieces either side of the door: same ids, new lengths.
    const rightAfter = (await membersOf(sessionId, RIGHT)).members as Data[];
    const lengthOf = (q: Data, id: string): number =>
      (takeoffOf(q).rows as Data[]).find(
        (r) => r.category === 'framing' && (r.sources as { id: string }[]).some((s) => s.id === id),
      )!.size.length;
    for (const piece of [`${RIGHT}:bottom1:1`, `${RIGHT}:bottom1:2`]) {
      expect(a.has(piece) && b.has(piece)).toBe(true);
      expect(lengthOf(after, piece)).not.toBeCloseTo(lengthOf(before, piece), 0);
      expect(rightAfter.find((m) => m.id === piece)!.length).toBeCloseTo(lengthOf(after, piece), 3);
    }
  });

  it('answers "what changed" in one readable result: get_quantities with compare', async () => {
    // Found: the whole answer was 79,269 and 83,825 characters for this shed, over Claude Code's
    // limit for one tool result. Follow-up 5 (#1217): options that narrow it.
    const length = (r: CallToolResult) => (r.content[0] as { text: string }).text.length;
    expect(length(await h.raw('get_quantities', { sessionId }))).toBeGreaterThan(80_000);
    const r = await h.raw('get_quantities', { sessionId, compare: true });
    expect(length(r)).toBeLessThan(20_000);
    compared = value(r.structuredContent as Structured);
    expect(compared).toMatchObject({ reviewed: false, baseVersion });
    const rows = compared.quantities.rows;
    expect(rows.omitted).toBe(0);
    expect(new Set((rows.items as Data[]).map((x) => x.list))).toEqual(new Set(['takeoff Part 1']));
    const row = (category: string, item: string) =>
      (rows.items as Data[]).find((x) => x.category === category && x.item === item)!;
    // The window's rough sill is new; its two header plies double the header row.
    expect(row('framing', 'Rough sill')).toMatchObject({ base: null, head: { quantity: 1 } });
    expect(row('framing', 'Header').head.quantity - row('framing', 'Header').base.quantity).toBe(2);
    // GAP PROBE (phase): net counts per row: the studs the window displaces cancel against new
    // ones, and the door's rebuilt members do not show at all.
    const studs = row('framing', 'Stud, Corner stud, King stud');
    expect(studs.head.quantity).toBeLessThan(studs.base.quantity);
    const each = (compared.quantities.totals as Data[]).find(
      (x) => x.group === 'framing' && x.unit === 'each',
    )!;
    expect([each.base, each.head]).toEqual([memberIds(before).size, memberIds(after).size]);
    // What to buy changes too, from the 1D layout of the whole frame.
    expect((rows.items as Data[]).some((x) => x.category === 'lumber')).toBe(true);

    // One feature alone: the window's takeoff is all new, lumber to buy included.
    const own = await h.raw('get_quantities', { sessionId, compare: true, owner: window });
    expect(length(own)).toBeLessThan(20_000);
    const ownRows = value(own.structuredContent as Structured).quantities.rows.items as Data[];
    expect(ownRows.length).toBeGreaterThan(0);
    for (const x of ownRows) expect(x.base).toBeNull();
    const win = (await membersOf(sessionId, window)).members as Data[];
    expect(
      ownRows
        .filter((x) => x.category === 'framing')
        .reduce((n, x) => n + (x.head.quantity as number), 0),
    ).toBe(win.length);
    expect(ownRows.some((x) => x.category === 'lumber')).toBe(true);

    // The head's whole takeoff without source lists and layouts fits too.
    const lean = await h.raw('get_quantities', { sessionId, lists: ['takeoffs'], detail: false });
    expect(length(lean)).toBeLessThan(20_000);
    expect(Object.keys(value(lean.structuredContent as Structured).quantities).sort()).toEqual([
      'notes',
      'reviewed',
      'takeoffs',
    ]);
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

  it("makes the back wall's framing elevation with one helper command and exports it", async () => {
    // `addConstructionSet` is the app's "Construction set" button as a session helper (#1219):
    // the session expands it into addDrawing, addSheet and addView, made by the same code.
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'Framing elevation of the back wall',
        commands: [
          { type: 'addConstructionSet', part: PART, wall: BACK, drawing: 'drawing#$framing' },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    // The helper's own sheet and view symbols are not reported; the agent's is.
    expect(Object.keys(r.symbols)).toEqual(['$framing']);
    const drawing = value(
      await h.call('get_object', {
        sessionId,
        query: { kind: 'drawing', drawingId: r.symbols.$framing },
      }),
    ).object as Data;
    expect(drawing.name).toBe('Framing: Back');
    expect(drawing.sheets).toHaveLength(1);
    const view = drawing.sheets[0].views[0];
    expect(view.source.params).toEqual({ kind: 'elevation', wall: BACK, segment: 1 });
    // The back wall runs west: seen from outside, looking south, at the largest scale that fits.
    expect(view.direction).toEqual({ direction: [-0, -1, 0], up: [0, 0, 1] });
    expect(view.scale.paper.source).toMatch(/"$/);
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
    // The bundle's quantity delta is the one get_quantities' compare gave (a drawing and an export
    // since change no quantity).
    expect(bundle.quantities).toEqual(compared.quantities);
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

  it('as-built: a stud nudged off the layout, two missing, an extra stud and a block added', async () => {
    // Was the GAP PROBE (as-built) "a stud can be nudged off the layout, but none can be added":
    // fixed by follow-up 2 (#1214), the wall's `add` params.
    const left = await feature(sessionId, LEFT);
    // Each override records where its stud is (`at`, its `along.centre`, #1215), so a later layout
    // change finds it by position (the layout probe below).
    const centreOf = async (local: string): Promise<number> =>
      ((await membersOf(sessionId, LEFT)).members as Data[]).find((m) => m.local === local)!.along
        .centre;
    const at = { s3: await centreOf('s3'), s4: await centreOf('s4'), s8: await centreOf('s8') };
    // On 16" centres from the framing's start, which is 3.5" before the path's first point: the
    // left wall butts the front wall's framing.
    expect([at.s3, at.s4, at.s8]).toEqual([IN_MM(51.5), IN_MM(67.5), IN_MM(131.5)]);
    const r = value(
      await h.call('apply', {
        sessionId,
        label: 'As built: s3 is 3" off, s4 and s8 are missing, one extra stud with a block',
        commands: [
          edit(left, (f) => ({
            ...f,
            params: {
              ...f.params,
              overrides: [
                { id: 's4', delete: true, at: at.s4 },
                { id: 's8', delete: true, at: at.s8 },
                { id: 's3', at: at.s3 },
                { id: 'extra1', stock: 'us-2x4' },
              ],
              add: [
                { id: 'add1', role: 'stud' },
                { id: 'add2', role: 'blocking' },
              ],
            },
            expressions: {
              ...f.expressions,
              move_3: IN(3),
              add1_at: IN(44),
              add2_at: IN(40),
              add2_z: IN(48),
            },
          })),
        ],
      }),
    );
    // The nudge, the deletes and the added members apply. An override of a member the wall never
    // had says so, and where to add one instead.
    expect(warningsOf(r, LEFT)).toEqual([
      'The override of extra1 on extension#4 is lost: the wall never had that member (to add a member its layout does not make, list it in the wall\'s "add" params).',
    ]);
    const listing = await membersOf(sessionId, LEFT);
    expect(listing.overrides).toEqual([
      { n: 1, id: 's4', member: `${LEFT}:s4`, status: 'applied', at: at.s4, delete: true },
      { n: 2, id: 's8', member: `${LEFT}:s8`, status: 'applied', at: at.s8, delete: true },
      { n: 3, id: 's3', member: `${LEFT}:s3`, status: 'applied', at: at.s3, move: 76.2 },
      { n: 4, id: 'extra1', member: `${LEFT}:extra1`, status: 'lost', stock: 'us-2x4' },
    ]);
    // The added members are listed with the wall's own, marked as added, where they were put: the
    // stud centred 44" along the wall, the block 48" up, fitted from the stud before it to the
    // added stud.
    const added = (listing.members as Data[]).filter((m) => m.added);
    expect(added.map((m) => [m.id, m.role])).toEqual([
      [`${LEFT}:add2`, 'blocking'],
      [`${LEFT}:add1`, 'stud'],
    ]);
    const [block, stud] = added as [Data, Data];
    expect(stud.along.centre).toBeCloseTo(IN_MM(44), 3);
    expect(stud.along.to - stud.along.from).toBeCloseTo(IN_MM(1.5), 3);
    expect((block.above.from + block.above.to) / 2).toBeCloseTo(IN_MM(48), 3);
    expect(block.along.to).toBeCloseTo(stud.along.from, 3);
    const before = (listing.members as Data[]).filter(
      (m) => m.role === 'stud' && !m.added && m.along.to <= block.along.from + 1e-6,
    );
    expect(Math.max(...before.map((m) => m.along.to as number))).toBeCloseTo(block.along.from, 3);
    // The takeoff counts them, as a stud (in the row of every equal 2x4 stud) and a block.
    const q = value(await h.call('get_quantities', { sessionId }));
    const ids = ownedBy(memberIds(q), LEFT);
    expect(ids).toContain(`${LEFT}:s3`);
    expect(ids).not.toContain(`${LEFT}:s4`);
    expect(ids).not.toContain(`${LEFT}:s8`);
    expect(ids.some((id) => id.includes('extra'))).toBe(false);
    const rowOf = (id: string) =>
      (takeoffOf(q).rows as Data[]).find(
        (row) =>
          row.category === 'framing' && (row.sources as { id: string }[]).some((x) => x.id === id),
      );
    expect(rowOf(`${LEFT}:add1`)).toMatchObject({
      item: expect.stringMatching(/^Stud\b/),
      stock: 'us-2x4',
    });
    expect(rowOf(`${LEFT}:add2`)).toMatchObject({
      item: expect.stringContaining('Blocking'),
      stock: 'us-2x4',
    });
    // And the render draws them: highlighting them matches, a deleted stud matches nothing.
    const shot = await h.raw('render', {
      sessionId,
      views: [
        {
          camera: { view: 'left', fit: [`${LEFT}*`] },
          only: 'members',
          highlight: [`${LEFT}:add1`, `${LEFT}:add2`, `${LEFT}:s4`],
          width: 480,
          height: 360,
        },
      ],
    });
    const images = (shot.structuredContent as Data).images as Data[];
    expect(images).toHaveLength(1);
    expect(images[0]!.unmatched).toEqual([`${LEFT}:s4`]);
  });

  it('layout: a spacing change finds each override by where its stud was, and says so', async () => {
    // Was the GAP PROBE (layout) "changing the spacing renumbers studs; overrides re-target or are
    // lost": the delete of s4 and the nudge of s3 silently applied to the studs that inherited
    // their ids. Fixed by follow-up 3 (#1215): an override that records its stud's position (`at`)
    // is matched by position, `moved` when the stud there has another id, `lost` when none is.
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
    // On 24" centres no stud is at 64" (s4's place) or 128" (s8's): both lost, with a warning
    // each. The stud at 48" (s3's place) is now s2: the nudge applies to it, with a warning.
    expect(warningsOf(r, LEFT)).toEqual([
      'The override of s4 on extension#4 is lost: the layout changed, and the wall has no layout stud where s4 was (s4 is now another stud, left as framed).',
      'The override of s8 on extension#4 is lost: the layout changed, and the wall has no layout stud where s8 was.',
      'The override of s3 on extension#4 now applies to s2: the layout changed, and s2 is the member where s3 was.',
      'The override of extra1 on extension#4 is lost: the wall never had that member (to add a member its layout does not make, list it in the wall\'s "add" params).',
    ]);
    const listing = await membersOf(sessionId, LEFT);
    expect((listing.overrides as Data[]).map((o) => [o.id, o.status, o.appliedTo ?? null])).toEqual(
      [
        ['s4', 'lost', null],
        ['s8', 'lost', null],
        ['s3', 'moved', `${LEFT}:s2`],
        ['extra1', 'lost', null],
      ],
    );
    // Nothing is re-targeted: s4 (now 96" along the layout) stays, s3 (now 72") is where the
    // layout put it, and s2 is the stud nudged 3" off 48" (all 3.5" more from the path's start).
    const stud = (local: string) => (listing.members as Data[]).find((m) => m.local === local)!;
    expect(stud('s4').along.centre).toBeCloseTo(IN_MM(99.5), 3);
    expect(stud('s3').along.centre).toBeCloseTo(IN_MM(75.5), 3);
    expect(stud('s2').along.centre).toBeCloseTo(IN_MM(54.5), 3);
    const ids = ownedBy(memberIds(value(await h.call('get_quantities', { sessionId }))), LEFT);
    expect(ids.filter((id) => /:s\d+$/.test(id)).sort()).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((k) => `${LEFT}:s${k}`).sort(),
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

  it('merge: two branches touching one wall and the domain data merge field by field', async () => {
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
    // Nothing is dropped, and B's commands merge by field with what A changed: nothing of A's
    // is overwritten, since the two never changed the same field.
    expect(plan.value.dropped).toEqual([]);
    expect(plan.value.replaced).toEqual([]);
    expect(plan.value.overwritten).toEqual([]);
    expect(plan.value.mergedWhole).toEqual([]);
    const doc = plan.value.document;
    const construction = doc.domains!.construction!.data as Data;
    expect(construction.framing).toEqual({ blocking: { kind: 'mid-height' } }); // B's
    expect(construction.headerRules).toEqual([
      { maxWidth: IN(48), header: { stock: 'us-2x8', plies: 2, jacks: 1 } },
    ]); // A's
    const back = doc.parts[0]!.features.find((f) => f.id === BACK) as unknown as Data;
    expect(back.expressions.height).toEqual(IN(96)); // B's
    expect(back.params.overrides).toEqual([{ id: 's3', delete: true }]); // A's
    // Merged, Main has both.
    const done = await h.app.library.mergeBranch(DOC, b.branch, MAIN_BRANCH);
    if (!done.ok) throw new Error(done.message);
    const main = await h.app.library.open(DOC);
    if (!main.ok) throw new Error(main.message);
    expect(main.value.document.domains).toEqual(doc.domains);
    expect(main.value.document.parts).toEqual(doc.parts);
  });
});
