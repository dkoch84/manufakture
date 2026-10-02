// @vitest-environment node
// Text in the sketch session, on the real solver: the Text tool places a text in the bundled
// font (added to the sketch's fonts), typing in one field is one undo step, a text is picked by
// its letters and dragged by its anchor, dimensioned like a point, and its previews follow its
// changes with one request per pause in typing.

import { DEFAULT_UNITS, applyCommand, createDocument } from '@manufakture/core';
import { SolverService, XY_PLANE } from '@manufakture/sketch';
import type { OutlineEntity, Vec2 } from '@manufakture/sketch/model';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { commitSketch } from './commit';
import { createSketchSession, type SketchSource } from './session';
import { millimetres, type Texter } from './text';
import { localTexter } from './text.test-helpers';
import { startTextPreviews } from './useTextPreviews';

const service = new SolverService();
afterAll(() => service.close('sketch#1'));

const BUNDLED = { id: 'inter-bold', family: 'Inter', style: 'Bold', sha256: 'f'.repeat(64) };

function source(patch: Partial<SketchSource> = {}): SketchSource {
  return {
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
    ...patch,
  };
}

async function started(patch: Partial<SketchSource> = {}) {
  const session = createSketchSession(service);
  session.getState().begin(source(patch));
  await session.getState().idle();
  const s = () => session.getState();
  const at = (p: Vec2) => ({ at: p, tolerance: 0.5 });
  const click = async (p: Vec2) => {
    s().pointerMove(at(p));
    s().click({ ...at(p), mode: 'replace' });
    await s().idle();
  };
  const placeText = async (p: Vec2) => {
    s().setTool('text');
    await click(p);
    return s().sketch.entities.at(-1) as OutlineEntity;
  };
  return { session, s, at, click, placeText };
}

/** Wait for the previews of every text to arrive. */
async function laidOut(t: Awaited<ReturnType<typeof started>>, texter: Texter) {
  await vi.waitFor(() => {
    for (const e of t.s().sketch.entities) {
      if (e.kind === 'outline' && !t.s().texts[e.id]?.layout) throw new Error(`no layout ${e.id}`);
    }
  });
  void texter;
}

describe('the Text tool', () => {
  it('places a text at the click in the bundled font, selected, and adds the font once', async () => {
    const t = await started();
    const e = await t.placeText([10, 5]);
    expect(e).toMatchObject({
      id: 'e1',
      kind: 'outline',
      anchor: [10, 5],
      angle: 0,
      source: {
        kind: 'text',
        text: 'Text',
        font: 'font#1',
        size: { source: '6', lengthUnit: 'mm' },
        align: { horizontal: 'center', vertical: 'middle' },
      },
    });
    expect(t.s().tool).toBe('select');
    expect(t.s().selection).toEqual([{ kind: 'entity', id: 'e1' }]);
    expect(t.s().placedText).toBe('e1');
    const font = {
      id: 'font#1',
      family: 'Inter',
      style: 'Bold',
      source: { kind: 'bundled', id: 'inter-bold', sha256: BUNDLED.sha256 },
    };
    expect(t.s().fonts).toEqual([font]);
    expect(t.s().addedFonts).toEqual([font]);
    // A second text uses it too, with no second copy.
    const second = await t.placeText([30, 5]);
    expect(second.source.font).toBe('font#1');
    expect(t.s().addedFonts).toHaveLength(1);
    // The anchor is solved like a point: two free coordinates per text.
    expect(t.s().solve?.diagnosis.dof).toBe(4);
  });

  it("uses the document's bundled font when it has one", async () => {
    const existing = {
      id: 'font#4',
      family: 'Inter',
      style: 'Bold',
      source: { kind: 'bundled' as const, id: 'inter-bold', sha256: BUNDLED.sha256 },
    };
    const t = await started({ fonts: [existing], nextFont: 5 });
    expect((await t.placeText([0, 0])).source.font).toBe('font#4');
    expect(t.s().addedFonts).toEqual([]);
  });

  it('snaps the anchor to a point it is placed on', async () => {
    const t = await started();
    t.s().setTool('point');
    await t.click([5, 5]);
    const e = await t.placeText([5.1, 5]);
    expect(e.anchor).toEqual([5, 5]);
    expect(t.s().sketch.constraints).toEqual([
      { id: 'k1', kind: 'coincident', a: { entity: 'e1' }, b: { entity: 'e2', at: 'anchor' } },
    ]);
  });
});

describe('editing a text', () => {
  it('makes typing in one field one undo step, and each field its own', async () => {
    const t = await started();
    await t.placeText([0, 0]);
    for (const value of ['M', 'M3', 'M3 x', 'M3 x 12']) {
      t.s().updateText('e1', { text: value }, { coalesce: 'text' });
    }
    t.s().updateText('e1', { size: millimetres(8) }, { coalesce: 'size' });
    t.s().updateText('e1', { angle: Math.PI / 2 });
    await t.s().idle();
    const e = () => t.s().sketch.entities[0] as OutlineEntity;
    expect(e().source.text).toBe('M3 x 12');
    expect(e().source.size.source).toBe('8');
    expect(e().angle).toBeCloseTo(Math.PI / 2, 12);
    t.s().undo();
    expect(e().angle).toBe(0);
    t.s().undo();
    expect(e().source.size.source).toBe('6');
    t.s().undo();
    expect(e().source.text).toBe('Text');
    t.s().undo();
    expect(t.s().sketch.entities).toEqual([]);
  });

  it('removes letter and line spacing when they are cleared', async () => {
    const t = await started();
    await t.placeText([0, 0]);
    t.s().updateText('e1', { letterSpacing: millimetres(0.5), lineSpacing: millimetres(2) });
    expect((t.s().sketch.entities[0] as OutlineEntity).source).toMatchObject({
      letterSpacing: { source: '0.5' },
      lineSpacing: { source: '2' },
    });
    t.s().updateText('e1', { letterSpacing: null, lineSpacing: null });
    const src = (t.s().sketch.entities[0] as OutlineEntity).source;
    expect('letterSpacing' in src || 'lineSpacing' in src).toBe(false);
  });

  it('adds a user font once, with the next font id', async () => {
    const t = await started({ nextFont: 3 });
    const font = {
      family: 'Mine',
      style: 'Regular',
      source: {
        kind: 'file' as const,
        fileName: 'm.ttf',
        size: 3,
        sha256: 'a'.repeat(64),
        data: 'AQID',
      },
    };
    expect(t.s().nextFontId()).toBe('font#3');
    const added = t.s().addFont(font);
    expect(added.id).toBe('font#3');
    expect(t.s().addFont(font)).toBe(added);
    expect(t.s().addedFonts).toEqual([added]);
    expect(t.s().nextFontId()).toBe('font#4');
  });
});

describe('picking, dragging and dimensioning a text', () => {
  it('picks a text by its letters, drags it by its anchor and dimensions the anchor', async () => {
    const t = await started();
    const texter = localTexter();
    const stop = startTextPreviews(t.session, texter, 0);
    try {
      // Away from the origin and the axes, so nothing pins the anchor.
      await t.placeText([20, 15]);
      t.s().updateText('e1', { text: 'HELLO' });
      await laidOut(t, texter);
      t.s().clearSelection();
      // Inside the word, away from the anchor: the text.
      await t.click([26, 16]);
      expect(t.s().selection).toEqual([{ kind: 'entity', id: 'e1' }]);
      // Dragged from its letters, its anchor follows the pointer.
      expect(t.s().dragStart(t.at([26, 16]))).toBe(true);
      t.s().dragMove(t.at([36, 26]));
      await t.s().dragEnd();
      const e = t.s().sketch.entities[0] as OutlineEntity;
      expect(e.anchor[0]).toBeCloseTo(30, 6);
      expect(e.anchor[1]).toBeCloseTo(25, 6);
      // A dimension from the origin to the text's letters: a distance to its anchor.
      t.s().setTool('dimension');
      await t.click([0, 0]);
      await t.click([36, 26]);
      await t.click([10, 30]);
      const [k] = t.s().sketch.constraints;
      expect(k).toMatchObject({
        kind: 'distance',
        a: { entity: '@origin' },
        b: { entity: 'e1', at: 'anchor' },
      });
      expect(t.s().editing?.id).toBe(k!.id);
    } finally {
      stop();
    }
  });

  it('fixes a selected text by its anchor', async () => {
    const t = await started();
    await t.placeText([3, 4]);
    expect(t.s().applyConstraint('fix')).toBe(true);
    expect(t.s().sketch.constraints).toEqual([
      { id: 'k1', kind: 'fix', point: { entity: 'e1', at: 'anchor' } },
    ]);
    await t.s().idle();
    expect(t.s().solve?.diagnosis.dof).toBe(0);
  });
});

describe('text previews', () => {
  it('lays a new text out at once, then waits for a pause in typing', async () => {
    vi.useFakeTimers();
    try {
      const t = await started();
      const texter = localTexter();
      const stop = startTextPreviews(t.session, texter, 120);
      await t.placeText([0, 0]);
      expect(texter.calls).toBe(1);
      await vi.waitFor(() => expect(t.s().texts.e1?.layout).toBeTruthy());
      for (const value of ['A', 'AB', 'ABC', 'ABCD']) {
        t.s().updateText('e1', { text: value }, { coalesce: 'text' });
        vi.advanceTimersByTime(50);
      }
      expect(texter.calls).toBe(1);
      vi.advanceTimersByTime(120);
      expect(texter.calls).toBe(2);
      await vi.waitFor(() => expect(t.s().texts.e1?.layout?.glyphs).toEqual([0, 1, 2, 3]));
      // Moving the text needs no new layout.
      t.s().updateText('e1', { angle: 1 });
      vi.advanceTimersByTime(500);
      expect(texter.calls).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the shown layout when an edit is undone before its layout arrives', async () => {
    const t = await started();
    const real = localTexter();
    // Holds every reply until the test lets it go.
    const held: (() => void)[] = [];
    const texter: Texter = {
      outline: (request, options) =>
        new Promise((resolve) => {
          held.push(() => void real.outline(request, options).then(resolve));
        }),
      readFont: real.readFont,
    };
    const stop = startTextPreviews(t.session, texter, 0);
    await t.placeText([0, 0]);
    held.shift()!();
    await vi.waitFor(() => expect(t.s().texts.e1?.layout?.glyphs).toEqual([0, 1, 2, 3]));
    const shown = t.s().texts.e1!.key;
    // Typed, then undone at once: the layout of "X" is still on its way.
    t.s().updateText('e1', { text: 'X' });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    t.s().updateText('e1', { text: 'Text' });
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toHaveLength(1);
    held.shift()!();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.s().texts.e1!.key).toBe(shown);
    expect(t.s().texts.e1!.layout?.glyphs).toEqual([0, 1, 2, 3]);
    stop();
  });

  it('asks for the texts of one pass with one pass number, and a new one per pass', async () => {
    const t = await started();
    const real = localTexter();
    const passes: (number | undefined)[] = [];
    const texter: Texter = {
      outline: (request, options) => {
        passes.push(options?.pass);
        return real.outline(request, options);
      },
      readFont: real.readFont,
    };
    await t.placeText([0, 0]);
    await t.placeText([20, 0]);
    // Both texts are new when the previews start: one pass asks for both.
    const stop = startTextPreviews(t.session, texter, 0);
    expect(passes).toHaveLength(2);
    expect(passes[0]).toBeTypeOf('number');
    expect(passes[1]).toBe(passes[0]);
    await laidOut(t, texter);
    t.s().updateText('e1', { text: 'A' });
    await vi.waitFor(() => expect(passes).toHaveLength(3));
    expect(passes[2]).toBeGreaterThan(passes[0]!);
    stop();
  });

  it('shows why a text cannot be laid out without asking the worker', async () => {
    const t = await started();
    const texter = localTexter();
    const stop = startTextPreviews(t.session, texter, 0);
    await t.placeText([0, 0]);
    t.s().updateText('e1', { size: millimetres(-1) });
    await vi.waitFor(() =>
      expect(t.s().texts.e1?.error).toBe('The size must be a length above 0.'),
    );
    stop();
  });
});

describe('committing', () => {
  it('adds the fonts a session added in one batch with the sketch', async () => {
    const t = await started({ nextFont: 1 });
    await t.placeText([0, 0]);
    const doc = createDocument({ id: 'd', name: 'D' });
    const done = t.s().finish()!;
    const commit = commitSketch(doc, doc.parts[0]!.id, done.source, done.sketch, done.fonts);
    // The document takes it: the font first, then the sketch whose text names it.
    expect(applyCommand(doc, commit!.command).ok).toBe(true);
    expect(commit?.label).toBe('Add Sketch 1');
    expect(commit?.command).toMatchObject({
      type: 'batch',
      commands: [
        { type: 'addFont', font: { id: 'font#1', source: { kind: 'bundled', id: 'inter-bold' } } },
        { type: 'addFeature', feature: { id: 'sketch#1', entities: [{ kind: 'outline' }] } },
      ],
    });
  });
});
