import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Dimension } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { BODY, boxDocument, fakeDrawer } from './drawing.test-fixture';
import { DrawingTabs } from './DrawingTabs';
import { DrawingWorkspace } from './DrawingWorkspace';
import { createDrawingUiStore } from './state';

// The sheet maps 1 px to 1 paper mm, from the page's top left (paper y runs up).
const W = 297;
const H = 210;

function setup(drawer = fakeDrawer()) {
  const documents = createDocumentStore(boxDocument());
  const drawingUi = createDrawingUiStore();
  const onSave = vi.fn();
  render(
    <>
      <DrawingWorkspace
        documents={documents}
        drawingUi={drawingUi}
        drawer={drawer}
        generation={1}
        bodyIds={{ 'part#1': [BODY] }}
        onSave={onSave}
      />
      <DrawingTabs documents={documents} drawingUi={drawingUi} />
    </>,
  );
  const drawing = () => documents.getState().document.drawings?.[0];
  const sheet = () => drawing()!.sheets[0]!;
  return { documents, drawingUi, drawer, onSave, drawing, sheet };
}

/** Make a drawing through the form, and insert a front view of the box at (60, 80) at 1:1. */
async function drawingWithView(s: ReturnType<typeof setup>) {
  fireEvent.click(screen.getByTestId('drawing-add'));
  fireEvent.change(screen.getByTestId('drawing-new-size'), { target: { value: 'A4' } });
  fireEvent.change(screen.getByTestId('drawing-new-field-Drawn by'), { target: { value: 'Ann' } });
  fireEvent.click(screen.getByTestId('drawing-new-create'));
  expect(s.drawing()).toMatchObject({ name: 'Drawing 1', sheets: [{ size: 'A4' }] });
  fireEvent.click(screen.getByTestId('drawing-insert-ok'));
  act(() => {
    s.documents.getState().execute(
      {
        type: 'moveView',
        drawingId: 'drawing#1',
        sheetId: 'sheet#1',
        viewId: 'view#1',
        position: [60, 80],
      },
      'Move',
    );
  });
  await ready();
}

/** Wait for the sheet to be drawn, and give it its size on screen. */
async function ready() {
  await waitFor(() =>
    expect(screen.getByTestId('drawing-sheet').getAttribute('data-state')).toBe('ready'),
  );
  await waitFor(() =>
    expect(screen.getByTestId('drawing-sheet').querySelector('svg path')).toBeTruthy(),
  );
  const el = screen.getByTestId('drawing-sheet');
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) as DOMRect;
}

const at = (x: number, y: number) => ({ clientX: x, clientY: H - y, button: 0, pointerId: 1 });

function click(x: number, y: number) {
  const el = screen.getByTestId('drawing-sheet');
  fireEvent.pointerDown(el, at(x, y));
  fireEvent.pointerUp(el, at(x, y));
}

const vertex = (i: number, j: number, k: number) => ({
  vertex: { faces: [`${BODY}:x${i}`, `${BODY}:y${j}`, `${BODY}:z${k}`] },
  body: BODY,
});

describe('DrawingWorkspace', () => {
  it('makes a drawing with a title block, inserts a view and draws the sheet from the display list', async () => {
    const s = setup();
    await drawingWithView(s);
    expect(s.sheet().titleBlock!.fields).toContainEqual({ label: 'Drawn by', value: 'Ann' });
    expect(s.sheet().views[0]).toMatchObject({
      id: 'view#1',
      source: { part: 'part#1' },
      direction: 'front',
      options: { hidden: true, smooth: false },
    });
    const sheet = screen.getByTestId('drawing-sheet');
    // The screen shows the SVG writer's own markup: edges per view, the title block's text.
    expect(sheet.querySelectorAll('path[data-owner="view#1"]').length).toBeGreaterThan(0);
    expect(sheet.textContent).toContain('Ann');
    expect(screen.getByTestId('drawing-tab-drawing#1').getAttribute('aria-selected')).toBe('true');
    // Asked for with picking data, the sheet shown.
    expect(s.drawer.calls.at(-1)).toEqual({
      drawingId: 'drawing#1',
      sheetId: 'sheet#1',
      pick: true,
    });
  });

  it('dimensions by picking two vertices and clicking where it goes, then drags it', async () => {
    const s = setup();
    await drawingWithView(s);
    fireEvent.click(screen.getByTestId('drawing-tool-dimension'));
    expect(screen.getByTestId('drawing-status').textContent).toBe('Pick the first edge or vertex.');
    // The front view's bottom left and right corners: the nearer of each pair of coincident
    // corners (Y = -15) wins.
    click(60.4, 80.3);
    expect(screen.getByTestId('drawing-pick-0')).toBeTruthy();
    click(99.8, 80.2);
    expect(screen.getByTestId('drawing-status').textContent).toBe(
      'Click where the dimension goes.',
    );
    click(80, 70);
    const dim = s.sheet().dimensions[0]!;
    expect(dim).toEqual({
      id: 'dim#1',
      view: 'view#1',
      kind: 'horizontal',
      refs: [vertex(0, 0, 0), vertex(1, 0, 0)],
      offset: -10,
    });
    expect(s.documents.getState().undoLabel).toBe('Add horizontal dimension dim#1');
    await waitFor(() =>
      expect(screen.getByTestId('drawing-dimension-value-dim#1').textContent).toContain('40'),
    );
    expect(screen.getByTestId('drawing-dimension-status-dim#1').textContent).toBe('OK');

    // Drag it by its text, 8 mm further down.
    fireEvent.click(screen.getByTestId('drawing-tool-select'));
    await ready();
    const text = screen.getByTestId('drawing-sheet').querySelector('text[data-owner="dim#1"]')!;
    const tx = Number(text.getAttribute('x'));
    const ty = H - Number(text.getAttribute('y'));
    const el = screen.getByTestId('drawing-sheet');
    fireEvent.pointerDown(el, at(tx, ty + 1));
    fireEvent.pointerMove(el, at(tx, ty - 7));
    fireEvent.pointerUp(el, at(tx, ty - 7));
    // The dimension line goes where the pointer let go: 80 is the anchors' paper y.
    expect((s.sheet().dimensions[0] as Extract<Dimension, { offset: number }>).offset).toBeCloseTo(
      ty - 7 - 80,
      1,
    );
    expect(ty - 7 - 80).toBeLessThan(-12);
    expect(s.documents.getState().undoLabel).toBe('Move dim#1');
  });

  it('shows a lost dimension in red with a re-pick that keeps its placement', async () => {
    const s = setup();
    await drawingWithView(s);
    act(() => {
      s.documents.getState().execute(
        {
          type: 'addDimension',
          drawingId: 'drawing#1',
          sheetId: 'sheet#1',
          dimension: {
            id: 'dim#1',
            view: 'view#1',
            kind: 'vertical',
            refs: [{ vertex: { faces: ['gone'] }, body: BODY }, vertex(0, 0, 1)],
            offset: 12,
          },
        },
        'Add',
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('drawing-dimension-dim#1').getAttribute('data-outcome')).toBe(
        'lost',
      ),
    );
    expect(screen.getByTestId('drawing-dimension-dim#1').className).toContain('outcome-lost');
    expect(screen.getByTestId('drawing-dimension-status-dim#1').textContent).toBe('Lost: re-pick');
    await ready();
    fireEvent.click(screen.getByTestId('drawing-dimension-repick-dim#1'));
    expect(screen.getByTestId('drawing-status').textContent).toContain('Re-pick dim#1');
    click(60.2, 80.2);
    click(60.2, 99.7);
    expect(s.sheet().dimensions[0]).toMatchObject({
      kind: 'vertical',
      refs: [vertex(0, 0, 0), vertex(0, 0, 1)],
      offset: 12,
    });
    await waitFor(() =>
      expect(screen.getByTestId('drawing-dimension-status-dim#1').textContent).toBe('OK'),
    );
  });

  it('projects an aligned view from the selected one, and places a note in a view', async () => {
    const s = setup();
    await drawingWithView(s);
    click(80, 90);
    expect(screen.getByTestId('drawing-view-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drawing-project-top'));
    expect(s.sheet().views[1]).toMatchObject({ direction: 'top', position: [60, 80 + 20 + 25] });
    fireEvent.change(screen.getByTestId('drawing-view-scale'), { target: { value: '1:2' } });
    fireEvent.keyDown(screen.getByTestId('drawing-view-scale'), { key: 'Enter' });
    expect(s.sheet().views[1]!.scale.model.source).toBe('2');

    await ready();
    fireEvent.click(screen.getByTestId('drawing-tool-note'));
    fireEvent.change(screen.getByTestId('drawing-note-text'), { target: { value: 'Pine, oiled' } });
    click(70, 85);
    expect(s.sheet().notes[0]).toMatchObject({
      view: 'view#1',
      position: [10, 5],
      text: 'Pine, oiled',
    });
  });

  it('exports SVG, DXF and PDF, and reports a sheet that cannot be laid out', async () => {
    const s = setup();
    await drawingWithView(s);
    const decode = (n: number) =>
      new TextDecoder().decode(s.onSave.mock.calls[n]![0] as Uint8Array);
    fireEvent.click(screen.getByTestId('drawing-export-svg'));
    await waitFor(() => expect(s.onSave).toHaveBeenCalledTimes(1));
    expect(decode(0)).toContain('<svg');
    expect(decode(0)).toContain('data-owner="view#1"');
    expect(s.onSave.mock.calls[0]!.slice(1)).toEqual(['Drawing 1 - Sheet 1.svg', 'image/svg+xml']);
    fireEvent.click(screen.getByTestId('drawing-export-dxf'));
    await waitFor(() => expect(s.onSave).toHaveBeenCalledTimes(2));
    expect(decode(1)).toContain('ENTITIES');
    fireEvent.click(screen.getByTestId('drawing-export-pdf'));
    await waitFor(() => expect(s.onSave).toHaveBeenCalledTimes(3));
    expect(decode(2).startsWith('%PDF-')).toBe(true);
    expect(s.onSave.mock.calls[2]!.slice(1)).toEqual(['Drawing 1.pdf', 'application/pdf']);
  });

  it('says why a sheet cannot be drawn or exported', async () => {
    const s = setup(fakeDrawer({ failSheet: true }));
    fireEvent.click(screen.getByTestId('drawing-add'));
    fireEvent.click(screen.getByTestId('drawing-new-create'));
    await waitFor(() =>
      expect(screen.getByTestId('drawing-sheet-hint').textContent).toContain('cannot be laid out'),
    );
    expect(screen.getByTestId('drawing-messages').textContent).toContain('positive length');
    fireEvent.click(screen.getByTestId('drawing-export-pdf'));
    await waitFor(() =>
      expect(screen.getByTestId('drawing-status').textContent).toContain('cannot be laid out'),
    );
    expect(s.onSave).not.toHaveBeenCalled();
  });

  it('says that drawings need the kernel when there is no drawer', () => {
    const documents = createDocumentStore(boxDocument());
    const drawingUi = createDrawingUiStore();
    render(
      <DrawingWorkspace documents={documents} drawingUi={drawingUi} drawer={null} generation={0} />,
    );
    act(() => drawingUi.getState().create());
    fireEvent.click(screen.getByTestId('drawing-new-create'));
    expect(screen.getByTestId('drawing-no-kernel')).toBeTruthy();
  });
});
