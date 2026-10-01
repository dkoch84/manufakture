// The print workspace's commands: fresh ids, names, and the orientation tools.

import { describe, expect, it } from 'vitest';
import {
  orientationRotation,
  placementMatrix,
  quatFromAxisAngle,
  quatMultiply,
  type Orientation,
} from '@manufakture/print';
import {
  DEFAULT_NOZZLE,
  DEFAULT_PRINTER,
  addItemCommand,
  addSetupCommand,
  eulerAngles,
  layFlatCommand,
  newSetupName,
  resetOrientationCommand,
  rotateCommand,
} from './commands';
import { apply, partsDocument, setupOf, withSetup } from './print.test-fixture';

const matrix = (o: Orientation) =>
  placementMatrix({ rotation: orientationRotation(o), translation: [0, 0, 0] });

function expectSameRotation(a: Orientation, b: Orientation) {
  const ma = matrix(a);
  const mb = matrix(b);
  ma.forEach((v, i) => expect(v).toBeCloseTo(mb[i]!, 9));
}

describe('setups and items', () => {
  it('adds a setup on the X1 Carbon with a 0.4 mm nozzle, named Plate n', () => {
    let doc = partsDocument();
    const first = addSetupCommand(doc);
    expect(first.setupId).toBe('print#1');
    doc = apply(doc, first.command);
    expect(setupOf(doc, 'print#1')).toMatchObject({
      name: 'Plate 1',
      printer: DEFAULT_PRINTER,
      nozzle: DEFAULT_NOZZLE,
      items: [],
    });
    expect(DEFAULT_PRINTER).toBe('bambu-x1c');
    doc = apply(doc, { type: 'editPrintSetup', setupId: 'print#1', name: 'Plate 2' });
    // The next free name, not a duplicate.
    expect(newSetupName(doc)).toBe('Plate 3');
    const second = addSetupCommand(doc);
    expect(second.setupId).toBe('print#2');
  });

  it('adds items for a whole part or one body', () => {
    let doc = apply(partsDocument(), addSetupCommand(partsDocument()).command);
    const all = addItemCommand(doc, 'print#1', 'part#1');
    doc = apply(doc, all.command);
    const one = addItemCommand(doc, 'print#1', 'part#1', 'extrude#1');
    doc = apply(doc, one.command);
    expect([all.itemId, one.itemId]).toEqual(['item#1', 'item#2']);
    expect(setupOf(doc, 'print#1').items).toEqual([
      { id: 'item#1', part: 'part#1', orientation: { kind: 'asModelled' } },
      { id: 'item#2', part: 'part#1', body: 'extrude#1', orientation: { kind: 'asModelled' } },
    ]);
  });
});

describe('orientation tools', () => {
  it('lays an item flat with a fresh reference id, and resets it', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    let doc = built.doc;
    const item = () => setupOf(doc, built.setupId).items[0]!;
    doc = apply(doc, layFlatCommand(doc, built.setupId, item(), 'extrude#1:cap:end'));
    expect(item().orientation).toEqual({
      kind: 'layFlat',
      face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
    });
    doc = apply(doc, layFlatCommand(doc, built.setupId, item(), 'extrude#1:side:2'));
    expect(item().orientation).toMatchObject({ face: { id: 'r2' } });
    doc = apply(doc, resetOrientationCommand(built.setupId, item()));
    expect(item().orientation).toEqual({ kind: 'asModelled' });
  });

  it('turns an item as modelled by 90 degrees about an axis', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const item = setupOf(built.doc, built.setupId).items[0]!;
    const c = rotateCommand(built.doc, built.setupId, item, { kind: 'asModelled' }, 'x');
    expect(c).toMatchObject({
      type: 'editPrintItem',
      item: {
        orientation: {
          kind: 'rotate',
          x: { source: '90', angleUnit: 'deg' },
          y: { source: '0' },
          z: { source: '0' },
        },
      },
    });
  });

  it('adds 90 degrees to the expression of a turn about z, keeping what it reads', () => {
    const doc = apply(partsDocument(), {
      type: 'setVariable',
      name: 'a',
      expression: { source: '0.5', lengthUnit: 'mm', angleUnit: 'rad' },
    });
    const built = withSetup(doc, [
      {
        part: 'part#1',
        edit: (item) => ({
          ...item,
          orientation: {
            kind: 'layFlat',
            face: { id: 'r1', ref: { face: 'f' } },
            turn: { source: '#a', lengthUnit: 'mm', angleUnit: 'rad' },
          },
        }),
      },
    ]);
    const item = setupOf(built.doc, built.setupId).items[0]!;
    const c = rotateCommand(built.doc, built.setupId, item, null, 'z');
    expect(c).toMatchObject({
      item: {
        orientation: { kind: 'layFlat', turn: { source: '(#a) + 90 deg', angleUnit: 'rad' } },
      },
    });
    const flat = {
      ...item,
      orientation: { kind: 'layFlat', face: { id: 'r1', ref: { face: 'f' } } },
    } as const;
    expect(rotateCommand(built.doc, built.setupId, flat, null, 'z')).toMatchObject({
      item: { orientation: { turn: { source: '90', angleUnit: 'deg' } } },
    });
    const rotated = {
      ...item,
      orientation: {
        kind: 'rotate',
        x: { source: '10', lengthUnit: 'mm', angleUnit: 'deg' },
        y: { source: '0', lengthUnit: 'mm', angleUnit: 'deg' },
        z: { source: '#b', lengthUnit: 'mm', angleUnit: 'deg' },
      },
    } as const;
    expect(rotateCommand(built.doc, built.setupId, rotated, null, 'z')).toMatchObject({
      item: { orientation: { x: { source: '10' }, z: { source: '(#b) + 90 deg' } } },
    });
  });

  it('composes a quarter turn about x or y with the orientation the item has', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const item = setupOf(built.doc, built.setupId).items[0]!;
    const before: Orientation = { kind: 'layFlat', normal: [0, 1, 0], turn: 0.3 };
    for (const axis of ['x', 'y'] as const) {
      const c = rotateCommand(built.doc, built.setupId, item, before, axis);
      if (c.type !== 'editPrintItem' || c.item.orientation.kind !== 'rotate') {
        throw new Error('expected a rotation');
      }
      const o = c.item.orientation;
      const after: Orientation = {
        kind: 'rotate',
        x: (Number(o.x.source) * Math.PI) / 180,
        y: (Number(o.y.source) * Math.PI) / 180,
        z: (Number(o.z.source) * Math.PI) / 180,
      };
      const quarter = quatFromAxisAngle(axis === 'x' ? [1, 0, 0] : [0, 1, 0], Math.PI / 2);
      const expected = quatMultiply(quarter, orientationRotation(before));
      const m = placementMatrix({ rotation: expected, translation: [0, 0, 0] });
      matrix(after).forEach((v, i) => expect(v).toBeCloseTo(m[i]!, 5));
    }
  });

  it('reads any rotation back as x, y and z angles, gimbal lock included', () => {
    const cases: [number, number, number][] = [
      [0.3, -0.7, 2.1],
      [Math.PI / 2, 0, 0],
      [0.4, Math.PI / 2, -1],
      [1, -Math.PI / 2, 0.5],
      [-3, 1.2, 3],
    ];
    for (const [x, y, z] of cases) {
      const o: Orientation = { kind: 'rotate', x, y, z };
      const [ex, ey, ez] = eulerAngles(o);
      expectSameRotation({ kind: 'rotate', x: ex, y: ey, z: ez }, o);
    }
  });
});
