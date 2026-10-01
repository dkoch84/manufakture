// A setup resolved against the model: printers, thresholds, orientations, references that are
// gone, the plate layout and bed fit.

import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERHANG_THRESHOLD, printThresholds } from '@manufakture/print';
import { editSetupCommand } from './commands';
import {
  COPY_GAP,
  MAX_SHOWN_COPIES,
  parsePrintViewId,
  printViewBodies,
  printViewId,
  resolveSetup,
} from './resolve';
import { apply, boxPart, partsDocument, setupOf, withSetup } from './print.test-fixture';

const deg = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;

describe('resolveSetup', () => {
  it('places an item as modelled in the middle of the bed, on it', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const model = [
      boxPart('part#1', [{ bodyId: 'extrude#1', min: [5, 5, 5], size: [10, 20, 30] }]),
    ];
    const r = resolveSetup(doc, setupOf(doc, setupId), model);
    expect(r.printer?.id).toBe('bambu-x1c');
    expect(r.problems).toEqual([]);
    expect(r.thresholds).toEqual(printThresholds(0.4));
    expect(r.overhang).toBe(DEFAULT_OVERHANG_THRESHOLD);
    const item = r.items[0]!;
    expect(item).toMatchObject({ status: 'ok', label: 'Part 1', message: null });
    const copy = item.copies[0]!;
    // Centred on the 256 x 256 bed, dropped onto it.
    expect(copy.box.min).toEqual([123, 118, 0]);
    expect(copy.box.max).toEqual([133, 138, 30]);
    expect(item.fit?.fits).toBe(true);
    expect(copy.placement.rotation).toEqual([0, 0, 0, 1]);
  });

  it('lays an item flat on a face and turns it', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      {
        part: 'part#1',
        edit: (item) => ({
          ...item,
          orientation: {
            kind: 'layFlat',
            face: { id: 'r1', ref: { face: 'part#1/extrude#1/front' } },
            turn: deg('90'),
          },
        }),
      },
    ]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [10, 20, 30] }])];
    const item = resolveSetup(doc, setupOf(doc, setupId), model).items[0]!;
    expect(item.status).toBe('ok');
    expect(item.orientation).toMatchObject({ kind: 'layFlat', normal: [0, -1, 0] });
    const box = item.copies[0]!.box;
    // The front face (-y) down: the 20 mm depth is now the height; turned 90 degrees about z,
    // the 10 mm width runs along y and the 30 mm height along x.
    expect(box.max[2] - box.min[2]).toBeCloseTo(20, 9);
    expect(box.max[0] - box.min[0]).toBeCloseTo(30, 9);
    expect(box.max[1] - box.min[1]).toBeCloseTo(10, 9);
    expect(box.min[2]).toBeCloseTo(0, 9);
  });

  it('evaluates rotations and thresholds through the variables', () => {
    let doc = apply(partsDocument(), { type: 'setVariable', name: 'tilt', expression: deg('90') });
    doc = apply(doc, { type: 'setVariable', name: 'wall', expression: mm('1.5') });
    const built = withSetup(doc, [
      {
        part: 'part#1',
        edit: (item) => ({
          ...item,
          orientation: { kind: 'rotate', x: deg('#tilt'), y: deg('0'), z: deg('0') },
        }),
      },
    ]);
    doc = apply(
      built.doc,
      editSetupCommand(built.setupId, {
        thresholds: { minWall: mm('#wall'), overhang: deg('#tilt / 2') },
      }),
    );
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [10, 20, 30] }])];
    const r = resolveSetup(doc, setupOf(doc, built.setupId), model);
    expect(r.thresholds.minWall).toBe(1.5);
    expect(r.overhang).toBeCloseTo(Math.PI / 4, 12);
    const box = r.items[0]!.copies[0]!.box;
    // 90 degrees about x: y and z swap.
    expect(box.max[2] - box.min[2]).toBeCloseTo(20, 9);
    expect(box.max[1] - box.min[1]).toBeCloseTo(30, 9);
  });

  it('reports a threshold that does not evaluate and keeps the default', () => {
    const built = withSetup(partsDocument(), []);
    const doc = apply(
      built.doc,
      editSetupCommand(built.setupId, { thresholds: { minGap: mm('1 mm / 0') } }),
    );
    const r = resolveSetup(doc, setupOf(doc, built.setupId), []);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^Minimum gap does not evaluate/);
    expect(r.thresholds.minGap).toBe(printThresholds(0.4).minGap);
  });

  it('reports a body that is gone as reference-lost, and a lay-flat face that is gone', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', body: 'extrude#9' },
      {
        part: 'part#1',
        edit: (item) => ({
          ...item,
          orientation: { kind: 'layFlat', face: { id: 'r1', ref: { face: 'extrude#7:cap:end' } } },
        }),
      },
    ]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
    const [body, face] = resolveSetup(doc, setupOf(doc, setupId), model).items;
    expect(body).toMatchObject({ status: 'reference-lost', missing: ['extrude#9'], copies: [] });
    expect(body!.message).toContain('extrude#9');
    expect(face).toMatchObject({ status: 'reference-lost', missing: ['extrude#7:cap:end'] });
    expect(face!.message).toContain('Pick another face');
  });

  it('waits for a part the model has not built yet', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    expect(resolveSetup(doc, setupOf(doc, setupId), []).items[0]!.status).toBe('pending');
  });

  it('shows a setup on a printer it does not know, and checks nothing', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { printer: 'acme-9000' }));
    const r = resolveSetup(doc, setupOf(doc, built.setupId), [
      boxPart('part#1', [{ bodyId: 'extrude#1' }]),
    ]);
    expect(r.printer).toBeNull();
    expect(r.problems[0]).toContain('acme-9000');
    expect(r.items[0]!.copies).toHaveLength(1);
    expect(r.items[0]!.fit).toBeNull();
    expect(r.plateNote).toBeNull();
  });

  it('says when the printer is not sold with the nozzle', () => {
    const built = withSetup(partsDocument(), []);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { nozzle: 0.5 }));
    expect(resolveSetup(doc, setupOf(doc, built.setupId), []).problems).toEqual([
      'The Bambu Lab X1 Carbon is not sold with a 0.5 mm nozzle.',
    ]);
  });

  it('fails bed fit on the axis a part exceeds: a 200 mm bar on an A1 mini, not on an X1C', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [200, 20, 10] }])];
    const x1c = resolveSetup(built.doc, setupOf(built.doc, built.setupId), model);
    expect(x1c.items[0]!.fit?.fits).toBe(true);
    const doc = apply(built.doc, editSetupCommand(built.setupId, { printer: 'bambu-a1-mini' }));
    const fit = resolveSetup(doc, setupOf(doc, built.setupId), model).items[0]!.fit!;
    expect(fit.fits).toBe(false);
    expect(fit.overshoot.x).toBeCloseTo(20, 9);
    expect(fit.overshoot.y).toBe(0);
    expect(fit.overshoot.z).toBe(0);
  });

  it('checks each item on its own, not where the preview row puts it', () => {
    // Two 130 mm items: their row is 265 mm, wider than the 256 mm bed, but each fits.
    const { doc, setupId } = withSetup(partsDocument(2), [{ part: 'part#1' }, { part: 'part#2' }]);
    const model = [
      boxPart('part#1', [{ bodyId: 'extrude#1', size: [130, 20, 10] }]),
      boxPart('part#2', [{ bodyId: 'extrude#1', size: [130, 20, 10] }]),
    ];
    const r = resolveSetup(doc, setupOf(doc, setupId), model);
    const row = r.items.flatMap((i) => i.copies.map((c) => c.box));
    expect(Math.max(...row.map((b) => b.max[0])) - Math.min(...row.map((b) => b.min[0]))).toBe(265);
    expect(r.items.map((i) => i.fit?.fits)).toEqual([true, true]);
    // Together they still fit one plate: no note.
    expect(r.plateNote).toBeNull();

    // Three copies of a 100 mm part (a 310 mm row): each copy is the same shape, so it fits.
    const three = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 3 }) },
    ]);
    const hundred = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [100, 20, 10] }])];
    expect(
      resolveSetup(three.doc, setupOf(three.doc, three.setupId), hundred).items[0]!.fit?.fits,
    ).toBe(true);
  });

  it('finds a spot clear of the X1 Carbon excluded corner', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    // 240 x 220: centred (y 18 to 238) it overlaps the 18 x 28 corner; at y 28 to 248 it fits.
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [240, 220, 10] }])];
    const r = resolveSetup(doc, setupOf(doc, setupId), model);
    const fit = r.items[0]!.fit!;
    expect(fit.fits).toBe(true);
    expect(fit.exclusions).toEqual([]);
    expect(fit.box.min[1]).toBeGreaterThanOrEqual(28);
    expect(fit.box.max[1]).toBeLessThanOrEqual(256);
    // The preview still centres it.
    expect(r.items[0]!.copies[0]!.box.min[1]).toBe(18);

    // 250 x 240 cannot clear the corner either way: it fails on the excluded area alone.
    const big = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [250, 240, 10] }])];
    const none = resolveSetup(doc, setupOf(doc, setupId), big).items[0]!.fit!;
    expect(none.fits).toBe(false);
    expect(none.overshoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(none.exclusions.map((e) => e.id)).toEqual(['origin-corner']);
  });

  it('notes, without failing anything, when the copies need more than one plate', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 9 }) },
    ]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [100, 100, 10] }])];
    const r = resolveSetup(doc, setupOf(doc, setupId), model);
    expect(r.items[0]!.fit?.fits).toBe(true);
    expect(r.plateNote).toMatch(/^The 9 copies need about \d+% of the plate/);
  });

  it('lays copies out in a row, 5 mm apart, and draws at most MAX_SHOWN_COPIES', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 3 }) },
    ]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1', size: [10, 10, 10] }])];
    const copies = resolveSetup(doc, setupOf(doc, setupId), model).items[0]!.copies;
    expect(copies.map((c) => c.box.min[0])).toEqual([128 - 20, 128 - 5, 128 + 10]);
    expect(copies[1]!.box.min[0] - copies[0]!.box.max[0]).toBe(COPY_GAP);
    const many = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 1000 }) },
    ]);
    const shown = resolveSetup(many.doc, setupOf(many.doc, many.setupId), model).items[0]!;
    expect(shown.copies).toHaveLength(MAX_SHOWN_COPIES);
  });

  it('prints every body of a part, or the one an item names', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1' },
      { part: 'part#1', body: 'extrude#3' },
    ]);
    const model = [
      boxPart('part#1', [{ bodyId: 'extrude#1' }, { bodyId: 'extrude#3', min: [20, 0, 5] }]),
    ];
    const [all, one] = resolveSetup(doc, setupOf(doc, setupId), model).items;
    expect(all!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1', 'extrude#3']);
    expect(all!.label).toBe('Part 1');
    expect(one!.bodies.map((b) => b.bodyId)).toEqual(['extrude#3']);
    expect(one!.label).toBe('Part 1: Body 2');
    // A several-body item is dropped as a whole: its lowest body touches the bed.
    expect(all!.copies[0]!.box.min[2]).toBe(0);
    expect(one!.copies[0]!.box.min[2]).toBe(0);
  });

  it('uses the mesh `meshOf` gives', () => {
    const { doc, setupId } = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
    const finer = boxPart('part#1', [{ bodyId: 'extrude#1' }]).bodies[0]!.view;
    const r = resolveSetup(doc, setupOf(doc, setupId), model, {
      meshOf: (v) => ({ ...v, mesh: finer.mesh }),
    });
    expect(r.items[0]!.bodies[0]!.input.mesh).toBe(finer.mesh);
    expect(r.items[0]!.bodies[0]!.view).toBe(model[0]!.bodies[0]!.view);
  });
});

describe('print view bodies', () => {
  it('draws every copy of every body, placed, under ids that name item, copy and body', () => {
    const { doc, setupId } = withSetup(partsDocument(), [
      { part: 'part#1', edit: (item) => ({ ...item, copies: 2 }) },
    ]);
    const model = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
    const r = resolveSetup(doc, setupOf(doc, setupId), model);
    const bodies = printViewBodies(r);
    expect(bodies.map((b) => b.id)).toEqual([
      'print:item#1:0:part#1/extrude#1',
      'print:item#1:1:part#1/extrude#1',
    ]);
    expect(bodies[1]!.transform?.translation).toEqual(r.items[0]!.copies[1]!.placement.translation);
    // The mesh and names stay the part's, so picks name the part's faces.
    expect(bodies[0]!.mesh).toBe(model[0]!.bodies[0]!.view.mesh);
    expect(bodies[0]!.names).toBe(model[0]!.bodies[0]!.view.names);
  });

  it('parses its own ids back', () => {
    const id = printViewId('item#12', 3, 'part#2/pattern#4:i2');
    expect(parsePrintViewId(id)).toEqual({
      itemId: 'item#12',
      copy: 3,
      sourceId: 'part#2/pattern#4:i2',
    });
    expect(parsePrintViewId('part#1/extrude#1')).toBeNull();
  });
});
