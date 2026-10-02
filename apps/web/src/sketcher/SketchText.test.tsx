// Texts in the sketch overlay and in committed sketches, laid out by the real outliner on the
// bundled font: the Text tool places one where the viewport is clicked, it is drawn one path per
// glyph at its anchor, its letters are filled as regions, and a committed sketch draws the texts
// regen placed.

import { DEFAULT_UNITS, type SketchFeature } from '@manufakture/core';
import { XY_PLANE } from '@manufakture/sketch/geometry';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PointerDelegate } from '../viewport/engine';
import type { ViewportApi } from '../viewport/Viewport';
import { createSketchSession } from './session';
import { SketchLayer } from './SketchLayer';
import { SketchCanvas } from './SketchMode';
import { placedText, type TextOutline } from './text';
import { localTexter } from './text.test-helpers';
import { immediateSolver } from './testSolver';

// A camera looking down on XY: 10 px per mm, the sketch origin at (200, 200).
function fakeViewport() {
  let delegate: PointerDelegate | null = null;
  const api = {
    projectToCanvas: ([x, y]: readonly [number, number, number]) => ({
      x: 200 + 10 * x,
      y: 200 - 10 * y,
    }),
    canvasToPlane: (x: number, y: number) =>
      [(x - 200) / 10, (200 - y) / 10, 0] as [number, number, number],
    onViewChange: vi.fn(() => () => {}),
    setPointerDelegate: vi.fn((d: PointerDelegate | null) => (delegate = d)),
    info: () => ({ size: { width: 400, height: 400 } }),
  };
  return { api: api as unknown as ViewportApi, delegate: () => delegate };
}

const BUNDLED = { id: 'inter-bold', family: 'Inter', style: 'Bold', sha256: 'f'.repeat(64) };

async function sketching() {
  const s = createSketchSession(immediateSolver().solver);
  s.getState().begin({
    featureId: 'sketch#1',
    isNew: true,
    name: 'Sketch 1',
    placement: XY_PLANE,
    entities: [],
    constraints: [],
    nextEntity: 1,
    nextConstraint: 1,
    units: DEFAULT_UNITS,
    variables: {},
    fonts: [],
    nextFont: 1,
    bundledFont: BUNDLED,
  });
  await act(() => s.getState().idle());
  return s;
}

describe('texts in the sketch overlay', () => {
  it('places a text with the Text tool and draws it one path per glyph, letters filled', async () => {
    const s = await sketching();
    const texter = localTexter();
    const vp = fakeViewport();
    render(
      <SketchCanvas
        session={s}
        viewport={vp.api}
        size={{ width: 400, height: 400 }}
        texter={texter}
      />,
    );
    act(() => s.getState().setTool('text'));
    const e = { shiftKey: false, ctrlKey: false, metaKey: false, buttons: 1 } as PointerEvent;
    act(() => {
      vp.delegate()!.down(e, { x: 300, y: 100 });
      vp.delegate()!.up({ ...e, buttons: 0 } as PointerEvent, { x: 300, y: 100 });
    });
    await act(() => s.getState().idle());
    const text = s.getState().sketch.entities[0] as TextOutline;
    expect(text).toMatchObject({ kind: 'outline', anchor: [10, 10], source: { text: 'Text' } });
    // "Text": four glyphs, one path each.
    const drawn = await screen.findByTestId('text-e1');
    await waitFor(() => expect(drawn.getAttribute('data-glyphs')).toBe('4'));
    expect(drawn.querySelectorAll('path')).toHaveLength(4);
    // Each glyph is a closed outline, near the anchor in canvas pixels (x 300, y 100).
    for (const p of drawn.querySelectorAll('path')) {
      const d = p.getAttribute('d')!;
      expect(d).toMatch(/^M/);
      expect(d).toMatch(/Z$/);
      const xs = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
      expect(Math.min(...xs)).toBeGreaterThan(300 - 150);
      expect(Math.max(...xs)).toBeLessThan(300 + 150);
    }
    // The letters are regions: "T", "e", "x", "t" fill, "e"'s counter left open.
    expect(screen.getAllByTestId('region-fill')).toHaveLength(4);
    // Asked once.
    expect(texter.calls).toBe(1);
  });

  it('draws a moved text at its new anchor without a new layout', async () => {
    const s = await sketching();
    const texter = localTexter();
    const vp = fakeViewport();
    render(
      <SketchCanvas
        session={s}
        viewport={vp.api}
        size={{ width: 400, height: 400 }}
        texter={texter}
      />,
    );
    act(() => s.getState().setTool('text'));
    act(() => s.getState().click({ at: [0, 5], tolerance: 0.5 }));
    await act(() => s.getState().idle());
    const drawn = await screen.findByTestId('text-e1');
    await waitFor(() => expect(drawn.getAttribute('data-glyphs')).toBe('4'));
    const before = drawn.querySelector('path')!.getAttribute('d')!;
    act(() => s.getState().updateText('e1', { angle: Math.PI }));
    await act(() => s.getState().idle());
    expect(screen.getByTestId('text-e1').querySelector('path')!.getAttribute('d')).not.toBe(before);
    expect(texter.calls).toBe(1);
  });
});

describe('texts in committed sketches', () => {
  it('draws the texts regen placed, one path per glyph', async () => {
    const s = await sketching();
    const texter = localTexter();
    const entity: TextOutline = {
      id: 'e1',
      kind: 'outline',
      construction: false,
      anchor: [0, 0],
      angle: 0,
      source: {
        kind: 'text',
        text: 'Hi',
        font: 'font#1',
        size: { source: '6', lengthUnit: 'mm', angleUnit: 'deg' },
        align: { horizontal: 'center', vertical: 'middle' },
      },
    };
    const reply = await texter.outline({
      font: { kind: 'bundled', id: 'inter-bold' },
      text: 'Hi',
      size: 6,
      align: entity.source.align,
      letterSpacing: 0,
      lineSpacing: 1,
    });
    if (!reply?.ok) throw new Error(`no layout: ${JSON.stringify(reply)}`);
    const shapes = placedText(entity, {
      key: 'k',
      layout: { glyphs: reply.glyphs, result: reply.result },
      error: null,
      warnings: [],
    });
    const feature: SketchFeature = {
      id: 'sketch#1',
      kind: 'sketch',
      name: 'Sketch 1',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [entity],
      constraints: [],
    };
    const vp = fakeViewport();
    // Not editing: the session is idle.
    s.getState().cancel();
    render(
      <SketchLayer
        viewport={{ ...vp.api, unitsPerPixel: undefined } as unknown as ViewportApi}
        session={s}
        sketches={[feature]}
        outlines={new Map([['sketch#1', shapes]])}
      />,
    );
    const paths = screen.getByTestId('committed-sketches').querySelectorAll('path[data-text]');
    // "H" and "i" (its dot and stem one glyph).
    expect(paths).toHaveLength(2);
    expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd');
  });
});
