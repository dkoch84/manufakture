// A construction view's strings (M6 plan T6.4b): hide and show through the view's params, and
// "Convert to dimensions" turning a plan's string into ordinary dimensions between layer corners,
// placed on the string's row, with the string hidden in the same command.

import {
  applyCommand,
  type Drawing,
  type DrawingView,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { DrawingViewResult, PickItem } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { newDrawingCommand } from '../../drawing/model';
import { PART, constructionDocument, run } from '../construction.test-fixture';
import {
  MAX_CONVERTED,
  convertStringCommand,
  hiddenStrings,
  hideStringsCommand,
  stringId,
  stringLabel,
} from './strings';

const IN = 25.4;
const STRING = 'view#1/extension#1:s1:openings';
/** The front wall's rough opening string: corner, a door's jambs, corner (inches). */
const STOPS = [0, 30, 66, 192];

const planView: DrawingView = {
  id: 'view#1',
  source: {
    domain: 'construction',
    part: PART,
    schemaVersion: 1,
    params: { kind: 'plan', level: 'level-1', strings: 'architectural' } as never,
  },
  direction: 'top',
  scale: {
    paper: { source: '1/4', lengthUnit: 'in', angleUnit: 'deg' },
    model: { source: '12', lengthUnit: 'in', angleUnit: 'deg' },
  },
  position: [100, 100],
  options: { hidden: false, smooth: false },
};

function setup(view: DrawingView = planView): { doc: ManufaktureDocument; drawing: Drawing } {
  let doc = constructionDocument();
  const c = newDrawingCommand(doc, 'Set', {
    size: 'tabloid',
    orientation: 'landscape',
    title: null,
  });
  doc = run(doc, c.command);
  doc = run(doc, { type: 'addView', drawingId: c.drawingId, sheetId: c.sheetId, view });
  return { doc, drawing: doc.drawings![0]! };
}

/** The sheathing's corners along the wall: inside face (y = 0) and outside, top and bottom. */
function sheathing(stops = STOPS): PickItem {
  const vertices = stops.flatMap((x, i) =>
    [0, -11.1125].flatMap((y) =>
      [0, 2467].map((z) => ({
        ref: { faces: [`f${i}`, y === 0 ? 'int' : 'ext', z === 0 ? 'bottom' : 'top'] } as never,
        point: [x * IN, y, z] as [number, number, number],
      })),
    ),
  );
  return { item: 0, body: 'extension#1:layer/sheathing', edges: [], vertices, cylinders: [] };
}

function result(items: PickItem[] | null, points = STOPS): DrawingViewResult {
  const frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as never;
  return {
    viewId: 'view#1',
    frame,
    scale: { paper: 0.25 * IN, model: 12 * IN },
    pick: items === null ? null : { frame, items },
    chains: [
      {
        id: STRING,
        view: 'view#1',
        kind: 'aligned',
        points: points.map((x) => [x * IN, 0] as const),
        offset: -24,
        overall: false,
      },
    ],
  } as unknown as DrawingViewResult;
}

describe('construction strings', () => {
  it('names a string by its view-local id, in words', () => {
    expect(stringId(planView, { id: STRING })).toBe('extension#1:s1:openings');
    const names = new Map([['extension#1', 'Front']]);
    expect(stringLabel('extension#1:s1:openings', names)).toBe('Front, segment 1, rough openings');
    expect(stringLabel('extension#9:eave', names)).toBe('extension#9, along the eave');
  });

  it('hides a string in the view params and shows it again', () => {
    const { doc, drawing } = setup();
    const sheet = drawing.sheets[0]!;
    const hide = hideStringsCommand(
      drawing,
      sheet,
      sheet.views[0]!,
      ['extension#1:s1:overall'],
      true,
    )!;
    const hidden = run(doc, hide.command);
    const view = hidden.drawings![0]!.sheets[0]!.views[0]!;
    expect(hiddenStrings(view)).toEqual(['extension#1:s1:overall']);
    const show = hideStringsCommand(
      hidden.drawings![0]!,
      hidden.drawings![0]!.sheets[0]!,
      view,
      ['extension#1:s1:overall'],
      false,
    )!;
    const shown = run(hidden, show.command).drawings![0]!.sheets[0]!.views[0]!;
    expect(hiddenStrings(shown)).toEqual([]);
    // Back to the params it had: no empty `hide` left behind.
    expect(shown.source).toEqual(planView.source);
    // Not a construction view: nothing to hide.
    expect(
      hideStringsCommand(drawing, sheet, { ...planView, source: { part: PART } }, ['x'], true),
    ).toBeNull();
  });

  it('converts a string to a dimension per span on its row, between layer corners on its line', () => {
    const { doc, drawing } = setup();
    const sheet = drawing.sheets[0]!;
    const c = convertStringCommand(drawing, sheet, sheet.views[0]!, result([sheathing()]), STRING);
    if (!c.ok) throw new Error(c.message);
    expect(c.dimensionIds).toEqual(['dim#1', 'dim#2', 'dim#3']);
    const r = applyCommand(doc, c.command);
    if (!r.ok) throw new Error(r.error.message);
    const after = r.value.document.drawings![0]!.sheets[0]!;
    expect(after.dimensions).toHaveLength(3);
    for (const [i, d] of after.dimensions.entries()) {
      expect(d.kind).toBe('aligned');
      expect(d.view).toBe('view#1');
      // The inside face (on the string's line), both corners at one depth.
      const refs = (d as { refs: { vertex: { faces: string[] }; body: string }[] }).refs;
      expect(refs.map((x) => x.vertex.faces.slice(0, 2))).toEqual([
        [`f${i}`, 'int'],
        [`f${i + 1}`, 'int'],
      ]);
      expect(refs[0]!.vertex.faces[2]).toBe(refs[1]!.vertex.faces[2]);
      expect(refs[0]!.body).toBe('extension#1:layer/sheathing');
      // Where the string was: 24 mm outside (below) the wall.
      expect((d as { offset: number }).offset).toBeCloseTo(-24, 6);
    }
    // The string is hidden in the same command, so it is one undo step.
    expect(hiddenStrings(after.views[0]!)).toEqual(['extension#1:s1:openings']);
  });

  it('adds the overall a row further out when the string has one', () => {
    const { drawing } = setup();
    const sheet = drawing.sheets[0]!;
    const vr = result([sheathing()]);
    (vr.chains![0] as { overall?: boolean }).overall = true;
    const c = convertStringCommand(drawing, sheet, sheet.views[0]!, vr, STRING);
    if (!c.ok) throw new Error(c.message);
    const dims = (c.command as { commands: { dimension?: { offset: number } }[] }).commands
      .map((x) => x.dimension)
      .filter((x) => x !== undefined);
    expect(dims).toHaveLength(4);
    expect(dims[3]!.offset).toBeLessThan(dims[0]!.offset - 5);
  });

  it('says why a string cannot be converted', () => {
    const { drawing } = setup();
    const sheet = drawing.sheets[0]!;
    const view = sheet.views[0]!;
    const no = (vr: DrawingViewResult | undefined, id = STRING) => {
      const c = convertStringCommand(drawing, sheet, view, vr, id);
      return c.ok ? null : c.message;
    };
    expect(no(result(null))).toMatch(/no layer bodies to measure from/);
    // A corner missing at the second stop (the door's first jamb).
    expect(no(result([sheathing([0, 66, 192])]))).toBe(
      'Point 2 of extension#1:s1:openings has no layer corner to measure from: hide the string instead.',
    );
    expect(no(result([sheathing()]), 'view#1/extension#9:s1:overall')).toBe(
      'extension#9:s1:overall is not drawn in view#1 now.',
    );
    expect(no(undefined)).toBe('extension#1:s1:openings is not drawn in view#1 now.');
    const many = Array.from({ length: MAX_CONVERTED + 2 }, (_, i) => i);
    expect(no(result([sheathing(many)], many))).toMatch(/at most 200 convert/);
  });
});
