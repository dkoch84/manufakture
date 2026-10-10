// The New construction set command (M6 plan T6.4b): the sheets and views of a 12' x 16' shed,
// their scales and places on paper, and the limits.

import {
  applyCommand,
  isDomainViewSource,
  type Command,
  type Drawing,
  type DrawingView,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { SET_TITLE_FIELDS } from '@manufakture/domain-construction';
import { describe, expect, it } from 'vitest';
import { TITLE_FIELDS, newDrawingCommand } from '../../drawing/model';
import { FT, IN, PART, constructionDocument, run, settingsOf } from '../construction.test-fixture';
import {
  buildingOf,
  constructionSetCommand,
  fitScale,
  setScaleFactor,
  setScales,
  sheetRegion,
  type SetOptions,
} from './set';

const inch = (v: number | string) => ({
  source: String(v),
  lengthUnit: 'in' as const,
  angleUnit: 'deg' as const,
});

function ext(
  id: string,
  name: string,
  extension: string,
  params: Record<string, unknown>,
  expressions: Record<string, ReturnType<typeof inch>>,
  dependsOn: string[] = [],
): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name,
    suppressed: false,
    extension,
    schemaVersion: 1,
    dependsOn,
    references: [],
    expressions,
    params: params as ExtensionFeature['params'],
    operation: 'new',
  };
}

/** The shed's walls (16' along x, 12' along y, counter-clockwise) and a gable roof, unbuilt. */
function shed(): ManufaktureDocument {
  let doc = constructionDocument();
  const s = settingsOf(doc);
  const level = s.stored.levels[0]!.id;
  const wallType = s.stored.wallTypes[0]!.id;
  const wall = (id: string, name: string, a: [number, number], b: [number, number]) =>
    ext(
      id,
      name,
      'construction.wall',
      { level, wallType, points: 2 },
      { x1: inch(a[0]), y1: inch(a[1]), x2: inch(b[0]), y2: inch(b[1]) },
    );
  const features = [
    wall('extension#1', 'Front', [0, 0], [192, 0]),
    wall('extension#2', 'Back', [192, 144], [0, 144]),
    wall('extension#3', 'Right', [192, 0], [192, 144]),
    wall('extension#4', 'Left', [0, 144], [0, 0]),
    ext(
      'extension#5',
      'Roof',
      'construction.roof',
      { roofType: 'r', kind: 'gable' },
      { pitch: inch('6/12') },
      ['extension#1'],
    ),
  ];
  for (const feature of features) doc = run(doc, { type: 'addFeature', partId: PART, feature });
  return doc;
}

function withDrawing(doc: ManufaktureDocument): { doc: ManufaktureDocument; drawing: Drawing } {
  const c = newDrawingCommand(doc, 'Shed set', {
    size: 'tabloid',
    orientation: 'landscape',
    title: { Title: 'Shed' },
  });
  const next = run(doc, c.command);
  return { doc: next, drawing: next.drawings!.find((d) => d.id === c.drawingId)! };
}

const AUTO: SetOptions = {
  part: PART,
  size: 'tabloid',
  orientation: 'landscape',
  planScale: 'auto',
  framingScale: 'auto',
};

function made(doc: ManufaktureDocument, drawing: Drawing, options = AUTO) {
  const c = constructionSetCommand(doc, drawing, drawing.sheets[0], options);
  if (!c.ok) throw new Error(c.message);
  const r = applyCommand(doc, c.command);
  if (!r.ok) throw new Error(r.error.message);
  return { c, doc: r.value.document, drawing: r.value.document.drawings![0]! };
}

describe('the construction set', () => {
  it('reads the walls and roof of the part with their coordinates', () => {
    const b = buildingOf(shed(), PART);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.building.walls.map((w) => [w.id, w.segments])).toEqual([
      ['extension#1', 1],
      ['extension#2', 1],
      ['extension#3', 1],
      ['extension#4', 1],
    ]);
    expect(b.building.walls[0]!.points).toEqual([
      [0, 0],
      [16 * FT, 0],
    ]);
    expect(b.building.walls[0]!.top).toBeCloseTo(97.125 * IN, 6);
    expect(b.building.roofs.map((r) => r.id)).toEqual(['extension#5']);
    // The pitch, typed as 6/12, for the roof's height over the walls.
    expect(b.building.roofs[0]!.pitch).toBeCloseTo(Math.atan(0.5), 12);
    expect(buildingOf(constructionDocument(), PART)).toEqual({
      ok: false,
      message: 'This part studio has no walls to draw.',
    });
  });

  it("makes the shed's sheets: plan, elevations, a framing elevation per wall, the roof plan", () => {
    const { doc, drawing } = withDrawing(shed());
    const r = made(doc, drawing);
    const sheets = r.drawing.sheets;
    // The empty sheet the new drawing came with gave way to the set.
    expect(sheets.map((s) => s.name)).toEqual([
      'Plan: Level 1',
      'Elevations',
      'Framing: Front',
      'Framing: Back',
      'Framing: Right',
      'Framing: Left',
      'Roof framing: Roof',
    ]);
    expect(r.c.sheetIds).toEqual(sheets.map((s) => s.id));
    const plan = sheets[0]!.views[0]!;
    expect(isDomainViewSource(plan.source) && plan.source.params).toEqual({
      kind: 'plan',
      level: settingsOf(doc).stored.levels[0]!.id,
      strings: 'architectural',
    });
    expect(sheets[1]!.views.map((v) => [v.direction, v.source, v.label])).toEqual([
      ['front', { part: PART }, 'Front elevation'],
      ['right', { part: PART }, 'Right elevation'],
      ['back', { part: PART }, 'Back elevation'],
      ['left', { part: PART }, 'Left elevation'],
    ]);
    const framing = sheets[2]!.views[0]!;
    expect(isDomainViewSource(framing.source) && framing.source.params).toEqual({
      kind: 'elevation',
      wall: 'extension#1',
      segment: 1,
    });
    expect(framing.label).toBeUndefined();
    // Every view id is new and different; the title block is the drawing's.
    const ids = sheets.flatMap((s) => s.views.map((v) => v.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(sheets.every((s) => s.titleBlock?.fields.some((f) => f.value === 'Shed'))).toBe(true);
    // At an architectural scale: the 16' x 12' plan with its strings fits at 1/4" = 1'.
    expect(plan.scale.paper.source).toBe('1/4"');
    expect(plan.scale.model.source).toBe("1'");
    // Undone in one step.
    expect(r.c.label).toBe('New construction set in Shed set');
  });

  it("centres each view's extent in its place on the sheet", () => {
    const { doc, drawing } = withDrawing(shed());
    const { drawing: d } = made(doc, drawing);
    const { region } = sheetRegion('tabloid', 'landscape');
    const plan = d.sheets[0]!.views[0]!;
    const f = setScaleFactor(`1/4" = 1'`);
    // The plan's middle (8', 6') on the region's middle.
    expect(plan.position[0] + f * 8 * FT).toBeCloseTo((region.min[0] + region.max[0]) / 2, 1);
    expect(plan.position[1] + f * 6 * FT).toBeCloseTo((region.min[1] + region.max[1]) / 2, 1);
    // Four elevations in a 2 x 2 grid: two columns, two rows.
    const xs = new Set(d.sheets[1]!.views.map((v) => Math.round(v.position[1])));
    expect(xs.size).toBe(2);
  });

  it('keeps a scale the user chose, and refuses one it does not offer', () => {
    const { doc, drawing } = withDrawing(shed());
    const { drawing: d } = made(doc, drawing, { ...AUTO, framingScale: `1/2" = 1'` });
    expect(d.sheets[2]!.views[0]!.scale.paper.source).toBe('1/2"');
    expect(constructionSetCommand(doc, drawing, undefined, { ...AUTO, planScale: '1:7' })).toEqual({
      ok: false,
      message: '1:7 is not one of the scales offered.',
    });
  });

  it('keeps a drawing sheet that has something on it', () => {
    const { doc, drawing } = withDrawing(shed());
    const withNote = run(doc, {
      type: 'addNote',
      drawingId: drawing.id,
      sheetId: drawing.sheets[0]!.id,
      note: { id: 'note#1', position: [10, 10], text: 'Keep me' },
    } as Command);
    const { drawing: d } = made(withNote, withNote.drawings![0]!);
    expect(d.sheets.map((s) => s.name)[0]).toBe('Sheet 1');
    expect(d.sheets).toHaveLength(8);
  });

  it("makes one wall's framing elevation with the shared builder, in place of the empty sheet", () => {
    const { doc, drawing } = withDrawing(shed());
    const r = made(doc, drawing, { ...AUTO, wall: 'extension#2' });
    expect(r.c.label).toBe('New framing elevation of Back in Shed set');
    expect(r.drawing.sheets.map((s) => s.name)).toEqual(['Framing: Back']);
    // The view the whole set makes for the back wall, but for its id.
    const set = made(doc, drawing);
    const withoutId = (v: DrawingView) => ({ ...v, id: '' });
    expect(r.drawing.sheets[0]!.views.map(withoutId)).toEqual(
      set.drawing.sheets[3]!.views.map(withoutId),
    );
    // A title block made from scratch has the workspace's fields.
    expect(SET_TITLE_FIELDS).toEqual(TITLE_FIELDS);
  });

  it('offers architectural scales for feet and inches, metric ones otherwise', () => {
    expect(setScales(shed().units)[0]).toBe(`1/2" = 1'`);
    expect(setScales({ length: { unit: 'mm' }, angle: { unit: 'deg' } } as never)).toContain(
      '1:50',
    );
    expect(setScaleFactor(`1/4" = 1'`)).toBeCloseTo(1 / 48, 12);
    expect(setScaleFactor('1:50')).toBe(0.02);
    // The largest that fits, else the smallest offered.
    const extent = { min: [0, 0] as const, max: [16 * FT, 12 * FT] as const };
    expect(fitScale(extent, { width: 200, height: 160 }, 10, setScales(shed().units))).toBe(
      `3/8" = 1'`,
    );
    expect(fitScale(extent, { width: 10, height: 10 }, 10, setScales(shed().units))).toBe(
      `1/16" = 1'`,
    );
  });
});
