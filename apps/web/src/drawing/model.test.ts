import {
  applyCommand,
  storedExpression,
  type Dimension,
  type Drawing,
  type DrawingView,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { apply, BODY, boxDocument, fakeDrawer } from './drawing.test-fixture';
import {
  addNoteCommand,
  defaultViewPosition,
  deleteCommand,
  dragCommand,
  draggedDimension,
  hitTest,
  insertViewCommand,
  linearOffset,
  newDimension,
  newDrawingCommand,
  notePaper,
  parseScaleText,
  pickAnchor,
  pickedOf,
  projectedDirection,
  projectedPosition,
  scaleText,
  sheetPaperSize,
  viewAt,
  type Picked,
} from './model';

const mm = { length: { unit: 'mm', decimals: 2 }, angle: { unit: 'deg', decimals: 1 } } as const;

function withDrawing() {
  let doc = boxDocument();
  const c = newDrawingCommand(doc, 'Box', {
    size: 'A4',
    orientation: 'landscape',
    title: { Title: 'Box', 'Drawn by': 'me' },
  });
  doc = apply(doc, c.command);
  return { doc, drawing: doc.drawings![0]!, c };
}

function withView(
  direction: DrawingView['direction'] = 'front',
  position: [number, number] = [60, 80],
) {
  const { doc: d0, drawing } = withDrawing();
  const v = insertViewCommand(drawing, drawing.sheets[0]!, {
    source: { part: 'part#1' },
    direction,
    scale: { paper: storedExpression('1', d0.units), model: storedExpression('1', d0.units) },
    position,
    hidden: true,
    smooth: false,
  });
  const doc = apply(d0, v.command);
  return { doc, drawing: doc.drawings![0]!, viewId: v.viewId };
}

describe('drawings and sheets', () => {
  it('makes a drawing with one sheet and its title block, as one undoable command', () => {
    const { drawing, c } = withDrawing();
    expect(c.label).toBe('Add Box');
    expect(drawing).toMatchObject({ id: 'drawing#1', name: 'Box', nextIds: { sheet: 2 } });
    expect(drawing.sheets[0]).toMatchObject({
      id: 'sheet#1',
      name: 'Sheet 1',
      size: 'A4',
      orientation: 'landscape',
      titleBlock: {
        fields: [
          { label: 'Title', value: 'Box' },
          { label: 'Drawn by', value: 'me' },
          { label: 'Date', value: '' },
          { label: 'Material', value: '' },
        ],
      },
    });
    expect(sheetPaperSize(drawing.sheets[0]!)).toEqual({ width: 297, height: 210 });
    expect(sheetPaperSize({ size: 'A3', orientation: 'portrait' })).toEqual({
      width: 297,
      height: 420,
    });
  });

  it('reads and writes scales', () => {
    const r = parseScaleText('1:5', mm as never);
    expect(r.ok && [r.scale.paper.source, r.scale.model.source]).toEqual(['1', '5']);
    const imperial = parseScaleText('1-1/2" = 1\'', mm as never);
    expect(imperial.ok && scaleText(imperial.scale)).toBe('1-1/2" = 1\'');
    expect(r.ok && scaleText(r.scale)).toBe('1:5');
    expect(parseScaleText('5', mm as never).ok).toBe(false);
  });
});

describe('views', () => {
  it('projects views third angle from a parent, aligned on its row or column', () => {
    expect(projectedDirection('front', 'right')).toBe('right');
    expect(projectedDirection('front', 'left')).toBe('left');
    expect(projectedDirection('front', 'top')).toBe('top');
    expect(projectedDirection('front', 'bottom')).toBe('bottom');
    expect(projectedDirection('right', 'right')).toBe('back');
    // From the top view, the view below it is the front again.
    expect(projectedDirection('top', 'bottom')).toBe('front');

    const parent = { position: [60, 80] } as unknown as DrawingView;
    const result = {
      scale: { paper: 1, model: 2 },
      bounds: { min: [0, 0], max: [40, 20] },
    } as never;
    expect(projectedPosition(parent, result, 'right')).toEqual([60 + 20 + 25, 80]);
    expect(projectedPosition(parent, result, 'top')).toEqual([60, 80 + 10 + 25]);
    expect(projectedPosition(parent, result, 'left')).toEqual([60 - 20 - 25, 80]);
    expect(defaultViewPosition({ width: 200, height: 100 }, 0)).toEqual([50, 45]);
  });

  it('finds the view under a point, and deletes a view with its dimensions and notes', async () => {
    const { doc, drawing, viewId } = withView();
    const sheet = drawing.sheets[0]!;
    const result = await fakeDrawer().sheet(doc, drawing.id, sheet.id);
    // The front view of the box: X 0..40, Z 0..20 from (60, 80).
    expect(viewAt(sheet, result, [80, 90])?.id).toBe(viewId);
    expect(viewAt(sheet, result, [200, 190])).toBeNull();

    const note = addNoteCommand(drawing, sheet, 'Pine', [70, 70], sheet.views[0]!);
    expect(note.command).toMatchObject({
      note: { view: viewId, position: [10, -10], text: 'Pine' },
    });
    let d = apply(doc, note.command);
    expect(notePaper(d.drawings![0]!.sheets[0]!, d.drawings![0]!.sheets[0]!.notes[0]!)).toEqual([
      70, 70,
    ]);
    const dim: Dimension = {
      id: 'dim#1',
      view: viewId,
      kind: 'horizontal',
      refs: [
        { vertex: { faces: [`${BODY}:x0`, `${BODY}:y0`, `${BODY}:z0`] }, body: BODY },
        { vertex: { faces: [`${BODY}:x1`, `${BODY}:y0`, `${BODY}:z0`] }, body: BODY },
      ],
      offset: -10,
    };
    d = apply(d, {
      type: 'addDimension',
      drawingId: drawing.id,
      sheetId: sheet.id,
      dimension: dim,
    });
    const del = deleteCommand(d.drawings![0]!, d.drawings![0]!.sheets[0]!, {
      kind: 'view',
      id: viewId,
    })!;
    expect(del.command.type).toBe('batch');
    const after = apply(d, del.command).drawings![0]!.sheets[0]!;
    expect([after.views, after.dimensions, after.notes]).toEqual([[], [], []]);
  });
});

describe('dimensions', () => {
  it('measures a linear offset from the first anchor, turned left of the measuring direction', () => {
    expect(linearOffset('horizontal', [10, 10], [50, 10], [30, 0])).toBe(-10);
    // Vertical: left of upwards is -x.
    expect(linearOffset('vertical', [10, 10], [10, 50], [20, 30])).toBe(-10);
    expect(linearOffset('aligned', [0, 0], [10, 10], [0, 10])).toBeCloseTo(7.07, 2);
  });

  it('anchors picks as regen does: a vertex, a line midpoint, a round edge centre', async () => {
    const { doc, drawing } = withView('top');
    const result = (await fakeDrawer().sheet(doc, drawing.id, 'sheet#1', { pick: true }))!;
    const view = result.views[0]!;
    const item = view.pick!.items[0]!;
    const ring = item.edges.find((e) => e.points.length > 2)!;
    const a = pickAnchor(item, { edge: ring.ref, body: BODY })!;
    expect(a.point.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([20, 0, 20]);
    const line = item.edges[0]!;
    expect(pickAnchor(item, { edge: line.ref, body: BODY })).toMatchObject({ point: [20, -15, 0] });
    const picked = pickedOf(view, { item: 0, ref: { edge: ring.ref, body: BODY } }, [0, 0])!;
    // Top view: view coordinates are model X and Y.
    expect(picked.anchor.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([20, 0]);
  });

  it('makes a dimension placed at the pointer, and moves it by a drag of its result', async () => {
    const { doc, drawing, viewId } = withView('front', [60, 80]);
    const view = drawing.sheets[0]!.views[0]!;
    const picks: Picked[] = [
      { ref: { vertex: { faces: ['a'] }, body: BODY }, viewId, anchor: [0, 0], at: [60, 80] },
      { ref: { vertex: { faces: ['b'] }, body: BODY }, viewId, anchor: [40, 0], at: [100, 80] },
    ];
    const made = newDimension('dim#1', 'horizontal', picks, view, 1, [80, 70]);
    expect(made).toMatchObject({
      ok: true,
      dimension: { kind: 'horizontal', offset: -10, view: viewId },
    });
    const diameter = newDimension(
      'dim#2',
      'diameter',
      [{ ...picks[0]!, anchor: [20, 0] }],
      view,
      2,
      [110, 95],
    );
    expect(diameter).toMatchObject({ ok: true, dimension: { kind: 'diameter', at: [10, 15] } });
    const parallel = newDimension(
      'dim#3',
      'angle',
      [
        {
          ...picks[0]!,
          line: [
            [0, 0],
            [1, 0],
          ],
        },
        {
          ...picks[1]!,
          line: [
            [0, 1],
            [1, 1],
          ],
        },
      ],
      view,
      1,
      [0, 0],
    );
    expect(parallel.ok).toBe(false);

    // The drag moves the dimension line to the pointer, from where regen drew the anchors.
    const dim = (made as { dimension: Dimension }).dimension;
    const res = {
      input: {
        kind: 'horizontal',
        points: [
          [0, 0],
          [40, 0],
        ],
        offset: -10,
      },
    } as never;
    expect(draggedDimension(dim, res, view, 1, [70, 60])).toMatchObject({ offset: -20 });
    expect(draggedDimension(dim, undefined, view, 1, [70, 60])).toBeNull();
    void doc;
  });

  it('drags a view, a note and a dimension into commands; tiny drags are none', async () => {
    let { doc, drawing } = withView('front', [60, 80]);
    const sheet0 = drawing.sheets[0]!;
    const dim: Dimension = {
      id: 'dim#1',
      view: 'view#1',
      kind: 'horizontal',
      refs: [
        { vertex: { faces: [`${BODY}:x0`, `${BODY}:y0`, `${BODY}:z0`] }, body: BODY },
        { vertex: { faces: [`${BODY}:x1`, `${BODY}:y0`, `${BODY}:z0`] }, body: BODY },
      ],
      offset: -10,
    };
    doc = apply(doc, {
      type: 'addDimension',
      drawingId: drawing.id,
      sheetId: sheet0.id,
      dimension: dim,
    });
    drawing = doc.drawings![0]! as Drawing;
    const sheet = drawing.sheets[0]!;
    const result = await fakeDrawer().sheet(doc, drawing.id, sheet.id);
    expect(
      dragCommand(drawing, sheet, result, { kind: 'view', id: 'view#1' }, [0, 0], [0.1, 0]),
    ).toBeNull();
    const moved = dragCommand(
      drawing,
      sheet,
      result,
      { kind: 'view', id: 'view#1' },
      [70, 90],
      [80, 100],
    )!;
    expect(moved.command).toMatchObject({ type: 'moveView', position: [70, 90] });
    const dragged = dragCommand(
      drawing,
      sheet,
      result,
      { kind: 'dimension', id: 'dim#1' },
      [80, 70],
      [80, 55],
    )!;
    expect(dragged.command).toMatchObject({ type: 'editDimension', dimension: { offset: -25 } });
    expect(applyCommand(doc, dragged.command).ok).toBe(true);

    // What a click grabs: the dimension's text over the view it measures.
    const display = result!.display!;
    const text = display.items.find((i) => i.kind === 'text' && i.owner === 'dim#1');
    expect(
      text && hitTest(display, sheet, result, text.kind === 'text' ? text.at : [0, 0]),
    ).toEqual({
      kind: 'dimension',
      id: 'dim#1',
    });
    expect(hitTest(display, sheet, result, [80, 92])).toEqual({ kind: 'view', id: 'view#1' });
    expect(hitTest(display, sheet, result, [250, 30])).toBeNull();
  });
});
