import { describe, expect, it } from 'vitest';
import { rewriteName } from './names.ts';
import { remap, type RenameTable } from './remap.ts';

const maps = {
  feature: (id: string) =>
    ({
      'extrude#1': 'extrude#4',
      'fillet#3': 'fillet#9',
      'pattern#7': 'pattern#8',
      'derived#1': 'derived#2',
    })[id] ?? id,
  sub: (id: string) => ({ e7: 'e9', r1: 'r5' })[id] ?? id,
};

describe('rewriteName (ADR 0009 decision 5 forms)', () => {
  it.each([
    ['extrude#1:side:e7#a', 'extrude#4:side:e9#a'],
    ['extrude#1:side:e7#1', 'extrude#4:side:e9#1'],
    ['extrude#1:cap:end', 'extrude#4:cap:end'],
    ['extrude#1:cap:start#2', 'extrude#4:cap:start#2'],
    ['fillet#3:round:r1', 'fillet#9:round:r5'],
    [
      'fillet#3:round:extrude#1:side:e7&extrude#1:cap:end',
      'fillet#9:round:extrude#4:side:e9&extrude#4:cap:end',
    ],
    [
      'fillet#3:corner:extrude#1:side:e7&extrude#1:side:e2&extrude#1:cap:end',
      'fillet#9:corner:extrude#4:side:e9&extrude#4:side:e2&extrude#4:cap:end',
    ],
    ['(extrude#1:side:e7+extrude#1:side:e2)#2', '(extrude#4:side:e9+extrude#4:side:e2)#2'],
    ['pattern#7:i2/extrude#1:side:e7', 'pattern#8:i2/extrude#4:side:e9'],
    ['pattern#7:i2', 'pattern#8:i2'],
    ['derived#1:from/extrude#1:side:e7', 'derived#2:from/extrude#1:side:e7'],
    ['import#9:face:4', 'import#9:face:4'],
    ['extension#3:layer/sheathing', 'extension#3:layer/sheathing'],
    ['extrude#1', 'extrude#4'],
    ['?face', '?face'],
  ])('%s', (from, to) => {
    expect(rewriteName(from, maps)).toBe(to);
  });
});

describe('remap scopes', () => {
  const table: RenameTable = new Map([
    [
      'part:part#1',
      new Map([
        ['extrude#1', 'extrude#4'],
        ['e7', 'e9'],
      ]),
    ],
    ['part:part#2', new Map([['extrude#1', 'extrude#6']])],
    [
      'cam',
      new Map([
        ['profile#1', 'profile#3'],
        ['r1', 'r2'],
      ]),
    ],
    [
      'asm:assembly#1',
      new Map([
        ['inst#1', 'inst#2'],
        ['r1', 'r7'],
      ]),
    ],
    ['doc', new Map([['cp#1', 'cp#2']])],
  ]);
  const resolver = {
    instancePart: (_a: string, i: string) => (i === 'inst#1' ? 'part#2' : undefined),
    setupPart: (s: string) => (s === 'setup#1' ? 'part#1' : undefined),
  };

  it('renames a feature id only in its own part', () => {
    const c = { type: 'deleteFeature', partId: 'part#2', featureId: 'extrude#1' };
    expect(remap(c, table, resolver)).toEqual({ ...c, featureId: 'extrude#6' });
  });

  it('tells CAM operation ids from feature ids by scope, and resolves the setup part', () => {
    const c = {
      type: 'editCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'profile#1',
        geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } }],
      },
    };
    expect(remap(c, table, resolver)).toEqual({
      ...c,
      operation: {
        id: 'profile#3',
        geometry: [{ kind: 'face', face: { id: 'r2', ref: { face: 'extrude#4:cap:end' } } }],
      },
    });
  });

  it("renames a mate connector's names through the instance's part", () => {
    const c = {
      type: 'addMate',
      assemblyId: 'assembly#1',
      mate: {
        id: 'mate#1',
        a: {
          id: 'mc#1',
          instance: 'inst#1',
          inference: 'centroid',
          origin: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
        },
      },
    };
    const out = remap(c, table, resolver) as typeof c;
    expect(out.mate.a).toEqual({
      id: 'mc#1',
      instance: 'inst#2',
      inference: 'centroid',
      origin: { id: 'r7', ref: { face: 'extrude#6:cap:end' } },
    });
  });

  it('leaves derived sources and free text alone, and renames record keys of row values', () => {
    const c = {
      type: 'setConfigRow',
      row: { id: 'cfg#1', name: 'extrude#1', values: { 'cp#1': true } },
    };
    expect(remap(c, table, resolver)).toEqual({
      ...c,
      row: { ...c.row, values: { 'cp#2': true } },
    });
    const pinned = {
      type: 'addFeature',
      partId: 'part#1',
      feature: { id: 'derived#1', source: { documentId: 'x', partId: 'part#1' } },
    };
    expect(remap(pinned, table, resolver)).toEqual(pinned);
  });
});
