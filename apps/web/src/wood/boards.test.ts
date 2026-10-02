import { applyCommand, type ExtensionFeature, type ManufaktureDocument } from '@manufakture/core';
import { findStock, inches } from '@manufakture/domain-wood';
import { describe, expect, it } from 'vitest';
import {
  blankEdges,
  boardFormOf,
  buildBoard,
  grainArrows,
  newBoardForm,
  previewFrame,
  stockGroups,
  stockLabel,
  withForm,
  type BoardForm,
} from './boards';
import { documentRegion } from './catalog';
import { featureDetail, featureKindLabel, firstChanged } from '../tree/tree';
import { EIGHT_FEET, INCH_UNITS, woodDocument } from './wood.test-fixture';

const placement = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] } as const;

function apply(doc: ManufaktureDocument, form: BoardForm, existing?: ExtensionFeature) {
  const r = buildBoard(
    form,
    existing ? { doc, partId: 'part#1', existing } : { doc, partId: 'part#1' },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const done = applyCommand(doc, r.command);
  if (!done.ok) throw new Error(done.error.message);
  return { doc: done.value.document, feature: r.feature, command: r.command };
}

const stick = (doc: ManufaktureDocument): BoardForm => ({
  ...newBoardForm(doc, 'part#1', ['sketch#1']),
  form: 'stick',
  stock: 'us-2x4',
});

describe('stock labels and regions', () => {
  it('opens on the region the display units suggest, and nothing is stored', () => {
    expect(documentRegion(INCH_UNITS)).toBe('us');
    expect(documentRegion(woodDocument().units)).toBe('metric');
    expect(newBoardForm(woodDocument(INCH_UNITS), 'part#1').stock).toBe('us-ply-23-32');
    expect(newBoardForm(woodDocument(), 'part#1').stock).toBe('mm-ply-18');
    expect(woodDocument(INCH_UNITS).domains).toBeUndefined();
  });

  it('shows nominal and actual sizes in the document units', () => {
    const ply = findStock('us-ply-23-32')!;
    const twoByFour = findStock('us-2x4')!;
    expect(stockLabel(ply, INCH_UNITS)).toBe('3/4" plywood (23/32")');
    expect(stockLabel(twoByFour, INCH_UNITS)).toBe('2x4 (1-1/2" x 3-1/2")');
    // In a millimetre document the same stock reads in millimetres; metric stock says it all.
    expect(stockLabel(twoByFour, woodDocument().units)).toBe('2x4 (38.10 mm x 88.90 mm)');
    expect(stockLabel(findStock('mm-ply-18')!, woodDocument().units)).toBe('18 mm plywood');
    // A fractional document never rounds 23/32" to 3/4", even at a coarse denominator.
    expect(
      stockLabel(ply, { ...INCH_UNITS, length: { unit: 'in-fraction', denominator: 4 } }),
    ).toBe('3/4" plywood (23/32")');
  });

  it('groups a region by kind, and offers sticks lumber only', () => {
    const panel = stockGroups('us', 'panel');
    expect(panel.map((g) => g.label)).toEqual(['Sheet goods', 'Lumber']);
    expect(panel[0]!.entries.every((e) => e.kind === 'sheet')).toBe(true);
    expect(stockGroups('metric', 'stick').map((g) => g.label)).toEqual(['Lumber']);
  });
});

describe('the board form', () => {
  it('starts a panel on a region sketch and a stick on a line sketch', () => {
    const doc = woodDocument(INCH_UNITS);
    expect(newBoardForm(doc, 'part#1')).toMatchObject({ form: 'panel', sketch: 'sketch#2' });
    expect(newBoardForm(doc, 'part#1', ['sketch#1'])).toMatchObject({
      form: 'stick',
      sketch: 'sketch#1',
      line: 'e1',
      stock: 'us-2x4',
    });
    // A stick cannot keep sheet stock.
    const panel = newBoardForm(doc, 'part#1');
    expect(withForm(panel, 'stick', 'us').stock).toBe('us-2x4');
    expect(withForm({ ...panel, stock: 'us-2x6' }, 'stick', 'us').stock).toBe('us-2x6');
  });

  it('adds a stick as one command, with the stock material on its body', () => {
    const doc = woodDocument(INCH_UNITS);
    const { doc: after, feature, command } = apply(doc, { ...stick(doc), rotation: '90' });
    expect(feature).toEqual({
      id: 'extension#1',
      kind: 'extension',
      name: 'Board 1',
      suppressed: false,
      extension: 'wood.board',
      schemaVersion: 1,
      operation: 'new',
      dependsOn: ['sketch#1'],
      references: [],
      expressions: { rotation: { source: '90', lengthUnit: 'in', angleUnit: 'deg' } },
      params: { form: 'stick', stock: 'us-2x4', sketch: 'sketch#1', line: 'e1' },
    });
    expect(command).toMatchObject({ type: 'batch' });
    expect(after.parts[0]!.bodies).toEqual([
      { id: 'extension#1', material: findStock('us-2x4')!.material },
    ]);
    expect(featureDetail(feature)).toBe('2x4');
    expect(featureKindLabel(feature)).toBe('Board');
    // And it reads back into the same form.
    const back = boardFormOf(feature);
    expect(back.ok && back.form).toMatchObject({ form: 'stick', line: 'e1', rotation: '90' });
  });

  it('refuses what regen would refuse, on the field at fault', () => {
    const doc = woodDocument(INCH_UNITS);
    const bad = (patch: Partial<BoardForm>) => {
      const r = buildBoard({ ...stick(doc), ...patch }, { doc, partId: 'part#1' });
      return r.ok ? {} : r.errors;
    };
    expect(bad({ stock: 'us-ply-23-32' })).toEqual({
      stock: '3/4" plywood is sheet stock: a stick is cut from lumber.',
    });
    expect(bad({ line: 'e9' })).toEqual({ line: 'Choose a line of the sketch.' });
    expect(bad({ length: '-1' }).length).toBe('Must be more than zero.');
    expect(bad({ stock: 'us-hw-4-4' })).toEqual({
      width: '4/4 hardwood is sold in random widths: give the board a width.',
    });
    expect(bad({ sketch: '' }).sketch).toBe('Choose a sketch.');
  });

  it('keeps a material the user chose when the stock changes, and follows the stock otherwise', () => {
    const doc = woodDocument();
    const panel = newBoardForm(doc, 'part#1');
    const first = apply(doc, panel);
    expect(first.doc.parts[0]!.bodies[0]).toEqual({ id: 'extension#1', material: 'plywood' });
    const mdf = apply(first.doc, { ...panel, stock: 'mm-mdf-18' }, first.feature);
    expect(mdf.doc.parts[0]!.bodies[0]).toEqual({ id: 'extension#1', material: 'mdf' });
    const chosen = applyCommand(mdf.doc, {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extension#1',
      props: { material: 'pla' },
    });
    if (!chosen.ok) throw new Error(chosen.error.message);
    const back = apply(chosen.value.document, { ...panel, stock: 'mm-ply-18' }, mdf.feature);
    expect(back.doc.parts[0]!.bodies[0]).toEqual({ id: 'extension#1', material: 'pla' });
    expect(back.command).toMatchObject({ type: 'editFeature' });
  });

  it('marks boards stale from the first extension when the stock overrides change', () => {
    const doc = woodDocument();
    const { doc: built } = apply(doc, newBoardForm(doc, 'part#1'));
    const r = applyCommand(built, {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 1,
      data: {
        overrides: {
          'mm-ply-18': { thickness: { source: '18.2', lengthUnit: 'mm', angleUnit: 'deg' } },
        },
      },
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(firstChanged(built.parts[0]!, built, r.value.document)).toBe(2);
    expect(firstChanged(built.parts[0]!, built, built)).toBe(3);
  });
});

describe('the preview', () => {
  it('is the frame regen builds: a 2x4 stick 8 ft along x, and a 3/4" plywood panel', () => {
    const doc = woodDocument(INCH_UNITS);
    const frame = previewFrame(stick(doc), { doc, partId: 'part#1', placement })!;
    expect(frame.size).toEqual({
      length: EIGHT_FEET,
      width: inches(3, 1, 2),
      thickness: inches(1, 1, 2),
    });
    expect(frame.axes.length).toEqual([1, 0, 0]);

    const panel = newBoardForm(doc, 'part#1');
    const p = previewFrame(panel, { doc, partId: 'part#1', placement })!;
    // 23/32" exactly, as the catalog computes it (18.25625 mm up to the last bit).
    const ply = findStock('us-ply-23-32')!.actual.thickness;
    expect(p.size).toEqual({ length: 600, width: 300, thickness: ply });
    expect(ply).toBeCloseTo(18.25625, 12);
    // An override wins, as in regen.
    const stock = {
      stored: new Map(),
      overrides: new Map([['us-ply-23-32', { thickness: 18.2 }]]),
    };
    expect(previewFrame(panel, { doc, partId: 'part#1', placement, stock })!.size.thickness).toBe(
      18.2,
    );
    // No placement yet (the sketch is not solved), or a form that cannot be built: nothing.
    expect(previewFrame(panel, { doc, partId: 'part#1', placement: undefined })).toBeNull();
    expect(
      previewFrame({ ...panel, sketch: 'sketch#9' }, { doc, partId: 'part#1', placement }),
    ).toBeNull();
  });

  it('draws the blank and a grain arrow on both broad faces', () => {
    const doc = woodDocument();
    const frame = previewFrame(newBoardForm(doc, 'part#1'), { doc, partId: 'part#1', placement })!;
    expect(blankEdges(frame)).toHaveLength(6);
    const arrows = grainArrows(frame);
    expect(arrows).toHaveLength(4);
    // Along the grain (x), over the middle of the length, on the bottom and the top face.
    expect(arrows[0]).toEqual([
      [120, 150, -0.05],
      [480, 150, -0.05],
    ]);
    expect(arrows[2]![0]![2]).toBeCloseTo(18.05, 9);
  });
});
