// The construction set (T6.4b, shared since #1219): what the app's button and the session's
// `addConstructionSet` helper both make. The house fixture's sheets, one wall's framing elevation,
// a segment of it, the refusals, ids from the caller and variables in wall coordinates. The app's
// own tests (apps/web/src/construction/drawings/set.test.ts) cover scales and placement on paper.

import {
  applyCommand,
  createDocument,
  isDomainViewSource,
  type Command,
  type Drawing,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { HOUSE_IDS, houseCommands } from '../fixtures/house';
import {
  SET_TITLE_FIELDS,
  buildingOf,
  constructionSetCommand,
  framingElevationViews,
  setVariables,
  type SetOptions,
} from './set';

const PART = 'part#1';
const IN = 25.4;
const [SOUTH, , NORTH] = HOUSE_IDS.exterior;

function run(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

function house(): ManufaktureDocument {
  const doc = createDocument({ id: 'house', name: 'House' });
  return run(
    { ...doc, units: { ...doc.units, length: { unit: 'ft-in', denominator: 16 } } },
    houseCommands(PART),
  );
}

/** A drawing with no sheets yet, as the session's helper starts a new one. */
const EMPTY: Drawing = { id: 'drawing#1', name: 'Set', sheets: [], nextIds: {} };

const AUTO: SetOptions = {
  part: PART,
  size: 'tabloid',
  orientation: 'landscape',
  planScale: 'auto',
  framingScale: 'auto',
};

/** The set's commands applied after adding `EMPTY`: the drawing as made. */
function made(doc: ManufaktureDocument, options: SetOptions): Drawing {
  const c = constructionSetCommand(doc, EMPTY, undefined, options);
  if (!c.ok) throw new Error(c.message);
  const next = run(run(doc, { type: 'addDrawing', drawing: EMPTY }), c.command);
  return next.drawings!.find((d) => d.id === EMPTY.id)!;
}

describe('the construction set (shared)', () => {
  it("makes the house's sheets: the plan, elevations, a framing sheet per wall, the roof plan", () => {
    const d = made(house(), AUTO);
    expect(d.sheets.map((s) => s.name)).toEqual([
      'Plan: Level 1',
      'Elevations',
      ...[...HOUSE_IDS.exterior, ...HOUSE_IDS.interior].map((id) => `Framing: ${id}`),
      `Roof framing: ${HOUSE_IDS.roof}`,
    ]);
    // A new drawing with no sheet has none to give way, and the title block is made from scratch.
    expect(d.sheets[0]!.titleBlock!.fields.map((f) => f.label)).toEqual([...SET_TITLE_FIELDS]);
    expect(d.sheets[0]!.titleBlock!.fields[0]!.value).toBe('House');
  });

  it("makes one wall's framing elevation sheet only", () => {
    const doc = house();
    const c = constructionSetCommand(doc, EMPTY, undefined, { ...AUTO, wall: NORTH });
    expect(c.ok && c.label).toBe(`New framing elevation of ${NORTH} in Set`);
    const d = made(doc, { ...AUTO, wall: NORTH });
    expect(d.sheets.map((s) => s.name)).toEqual([`Framing: ${NORTH}`]);
    const [view] = d.sheets[0]!.views;
    expect(d.sheets[0]!.views).toHaveLength(1);
    expect(isDomainViewSource(view!.source) && view!.source.params).toEqual({
      kind: 'elevation',
      wall: NORTH,
      segment: 1,
    });
    // The north wall runs west (600" to 0 along x): seen from outside, looking south.
    expect(view!.direction).toEqual({ direction: [-0, -1, 0], up: [0, 0, 1] });
    // The same sheet the whole set makes for that wall, at the same scale.
    const all = made(doc, AUTO).sheets.find((s) => s.name === `Framing: ${NORTH}`)!;
    expect(view!.scale).toEqual(all.views[0]!.scale);
    expect(view!.direction).toEqual(all.views[0]!.direction);
    expect(view!.position).toEqual(all.views[0]!.position);
  });

  it('makes one segment of a wall, and refuses what is not a wall or a segment', () => {
    const doc = house();
    const d = made(doc, { ...AUTO, wall: SOUTH, segment: 1 });
    expect(d.sheets[0]!.views).toHaveLength(1);
    expect(
      constructionSetCommand(doc, EMPTY, undefined, { ...AUTO, wall: SOUTH, segment: 2 }),
    ).toEqual({
      ok: false,
      message: `${SOUTH} has segments 1 to 1; there is no segment 2.`,
    });
    expect(
      constructionSetCommand(doc, EMPTY, undefined, { ...AUTO, wall: HOUSE_IDS.roof }),
    ).toEqual({ ok: false, message: `There is no wall ${HOUSE_IDS.roof} in part studio ${PART}.` });
    expect(constructionSetCommand(doc, EMPTY, undefined, { ...AUTO, segment: 1 })).toEqual({
      ok: false,
      message: 'A segment is given with its wall.',
    });
  });

  it("takes the caller's ids for sheets and views", () => {
    const c = constructionSetCommand(
      house(),
      EMPTY,
      undefined,
      { ...AUTO, wall: NORTH },
      {
        ids: {
          sheets: (n) => Array.from({ length: n }, (_, i) => `sheet#$s${i}`),
          views: (n) => Array.from({ length: n }, (_, i) => `view#$v${i}`),
        },
      },
    );
    if (!c.ok) throw new Error(c.message);
    expect(c.sheetIds).toEqual(['sheet#$s0']);
    const commands = (c.command as { commands: Command[] }).commands;
    expect(commands.map((x) => x.type)).toEqual(['addSheet', 'addView']);
    expect((commands[1] as { view: { id: string } }).view.id).toBe('view#$v0');
  });

  it("evaluates wall coordinates with the document's variables", () => {
    let doc = house();
    doc = {
      ...doc,
      variables: [
        { name: 'len', expression: { source: "50'", lengthUnit: 'in', angleUnit: 'deg' } },
      ],
    };
    const south = doc.parts[0]!.features.find((f) => f.id === SOUTH) as ExtensionFeature;
    doc = run(doc, {
      type: 'editFeature',
      partId: PART,
      feature: {
        ...south,
        expressions: {
          ...south.expressions,
          x2: { source: '#len', lengthUnit: 'in', angleUnit: 'deg' },
        },
      },
    } as Command);
    const b = buildingOf(doc, PART, setVariables(doc));
    expect(b.ok && b.building.walls[0]!.points).toEqual([
      [0, 0],
      [600 * IN, 0],
    ]);
    // A variable that does not evaluate leaves the wall's points unknown, its views unplaced.
    const none = buildingOf(doc, PART, {});
    if (!none.ok) throw new Error(none.message);
    expect(none.building.walls[0]!.points).toBeNull();
    const views = framingElevationViews(PART, none.building.walls[0]!, 0);
    expect(views.map((v) => [v.direction, v.extent])).toEqual([['front', null]]);
  });
});
