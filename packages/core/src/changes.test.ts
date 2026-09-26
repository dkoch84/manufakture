import { describe, expect, it } from 'vitest';
import { diffDocuments, type PartChange } from './changes';
import { applyCommand, type Command } from './commands';
import type { SketchFeature } from './schema';
import { PART, bracket, clone, cornerFillet, mm, unwrap } from './test-helpers';

const sketch3: SketchFeature = {
  id: 'sketch#3',
  kind: 'sketch',
  name: 'Sketch 3',
  suppressed: false,
  plane: { type: 'plane', origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
  entities: [],
  constraints: [],
};

type Expected = Partial<PartChange> | null;

describe('diffDocuments', () => {
  const cases: [string, Command[], Expected][] = [
    [
      'rename: no regen',
      [{ type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'R' }],
      { changed: ['fillet#1'], firstAffectedIndex: null },
    ],
    [
      'suppress',
      [{ type: 'suppressFeature', partId: PART, featureId: 'extrude#2', suppressed: true }],
      { changed: ['extrude#2'], firstAffectedIndex: 3 },
    ],
    [
      'edit',
      [{ type: 'editFeature', partId: PART, feature: { ...cornerFillet(), radius: mm('1') } }],
      { changed: ['fillet#1'], firstAffectedIndex: 4 },
    ],
    [
      'add at the end',
      [{ type: 'addFeature', partId: PART, feature: { ...sketch3 } }],
      { added: ['sketch#3'], firstAffectedIndex: 5 },
    ],
    [
      'add in the middle',
      [{ type: 'addFeature', partId: PART, feature: sketch3, index: 2 }],
      { added: ['sketch#3'], reordered: false, firstAffectedIndex: 2 },
    ],
    [
      'delete the last',
      [{ type: 'deleteFeature', partId: PART, featureId: 'fillet#1' }],
      { removed: ['fillet#1'], firstAffectedIndex: 4 },
    ],
    [
      'delete in the middle',
      [
        { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
        { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' },
      ],
      { removed: ['extrude#2', 'fillet#1'], firstAffectedIndex: 3 },
    ],
    [
      'reorder',
      [{ type: 'reorderFeature', partId: PART, featureId: 'fillet#1', index: 2 }],
      { reordered: true, changed: [], firstAffectedIndex: 2 },
    ],
    [
      'roll back',
      [{ type: 'setRollback', partId: PART, index: 2 }],
      { rollbackChanged: true, firstAffectedIndex: 2 },
    ],
    [
      'roll back to the start',
      [{ type: 'setRollback', partId: PART, index: 0 }],
      { rollbackChanged: true, firstAffectedIndex: 0 },
    ],
    [
      'variable read by extrude#1',
      [{ type: 'setVariable', name: 'thickness', expression: mm('7mm') }],
      { changed: [], firstAffectedIndex: 1 },
    ],
    [
      'variable read through another variable',
      [{ type: 'setVariable', name: 'width', expression: mm('50') }],
      { firstAffectedIndex: 0 },
    ],
    ['new unused variable', [{ type: 'setVariable', name: 'spare', expression: mm('1') }], null],
    [
      'display units',
      [{ type: 'setDisplayUnits', units: { length: { unit: 'in' }, angle: { unit: 'deg' } } }],
      null,
    ],
  ];

  it.each(cases)('%s', (_label, commands, expected) => {
    const before = bracket();
    const after = unwrap(applyCommand(before, { type: 'batch', commands })).document;
    const change = diffDocuments(before, after);
    expect(change.empty).toBe(false);
    if (expected === null) {
      expect(change.parts).toEqual([]);
    } else {
      expect(change.parts).toHaveLength(1);
      expect(change.parts[0]).toMatchObject({ partId: PART, status: 'changed', ...expected });
    }
  });

  it('reports variables and units', () => {
    const before = bracket();
    const after = unwrap(
      applyCommand(before, {
        type: 'batch',
        commands: [
          { type: 'setVariable', name: 'spare', expression: mm('1') },
          { type: 'setVariable', name: 'thickness', expression: mm('7') },
          { type: 'setDisplayUnits', units: { length: { unit: 'cm' }, angle: { unit: 'deg' } } },
        ],
      }),
    ).document;
    const change = diffDocuments(before, after);
    expect(change.variables).toEqual({ added: ['spare'], removed: [], changed: ['thickness'] });
    expect(change.unitsChanged).toBe(true);
    expect(change.nameChanged).toBe(false);
    expect(diffDocuments(after, before).variables).toEqual({
      added: [],
      removed: ['spare'],
      changed: ['thickness'],
    });
  });

  it('is empty for equal documents, by identity or by value', () => {
    const doc = bracket();
    expect(diffDocuments(doc, doc).empty).toBe(true);
    expect(diffDocuments(doc, clone(doc)).empty).toBe(true);
    expect(diffDocuments(doc, clone(doc)).parts).toEqual([]);
  });

  it('reports added and removed parts', () => {
    const doc = bracket();
    const two = clone(doc);
    two.parts.push({ id: 'part#2', name: 'Lid', features: [], rollbackIndex: null, nextIds: {} });
    expect(diffDocuments(doc, two).parts).toMatchObject([
      { partId: 'part#2', status: 'added', firstAffectedIndex: null },
    ]);
    expect(diffDocuments(two, doc).parts).toMatchObject([{ partId: 'part#2', status: 'removed' }]);
  });
});
