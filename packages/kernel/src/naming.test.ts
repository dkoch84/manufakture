// The naming layer on synthetic data, no kernel: the rules that the feature
// scenarios cannot easily reach (several faces generated from one input,
// merges, placeholders, nested positional names) and the id rules.

import { describe, expect, it } from 'vitest';
import {
  deriveFaces,
  derivedName,
  disambiguate,
  invalidFeatureId,
  invalidSketchId,
  isPositional,
  isUnnamed,
  nameShape,
  pickEdge,
  pickFace,
  prefixFaces,
  propagateFaces,
  resolveEdge,
  resolveFace,
  sketchAncestors,
  splitParent,
  type FaceName,
} from './naming';
import type { FaceInfo, HistoryEntry, Topology } from './types';

const face = (index: number, x: number): FaceInfo => ({
  index,
  surface: 'plane',
  centroid: [x, 0, 0],
  area: 1,
  normal: null,
  axis: null,
  radius: null,
});

const faces = (...xs: number[]): Topology => ({
  faces: xs.map((x, i) => face(i + 1, x)),
  edges: [],
  vertices: [],
});

const plain = (name: string): FaceName => ({ name, lineage: [name], fragile: false });

function entry(partial: Partial<HistoryEntry> & Pick<HistoryEntry, 'input'>): HistoryEntry {
  return { operand: 0, kept: 0, modified: [], generated: [], deleted: false, ...partial };
}

describe('ids and positional names', () => {
  it('tells positional pieces from feature ids and sketch splits', () => {
    expect(isPositional('cut#4:side:s3#1')).toBe(true);
    expect(isPositional('(cut#4:side:s3#1+x)')).toBe(true);
    expect(isPositional('fillet#3:corner:A&B#2&C')).toBe(true);
    expect(isPositional('pattern#7:i2/extrude#3:side:e1#2')).toBe(true);
    expect(isPositional('extrude#3:side:e2#1')).toBe(true);
    expect(isPositional('extrude#1:side:e2#a')).toBe(false);
    expect(isPositional('pattern#7:i2/extrude#3:side:e1')).toBe(false);
    expect(isPositional('cut#4:cap:end')).toBe(false);
  });

  it('validates sketch ids at the boundary: no #<digits> except one region piece at the end', () => {
    for (const ok of ['e1', 'e2#a', 'e2#a#b', 'e2#1', 'e2#a#3', 'p_1', 'axis', 'cbore-floor']) {
      expect(invalidSketchId(ok), ok).toBeNull();
    }
    for (const bad of [
      '',
      'e2#1#a',
      'e2#1#2',
      'e2#',
      'e2#A',
      'a:b',
      'a|b',
      'a/b',
      'a&b',
      '?face1',
      'a b',
    ]) {
      expect(invalidSketchId(bad), bad).not.toBeNull();
    }
    // Reference and point ids take no positional piece at all.
    expect(invalidSketchId('r1', false)).toBeNull();
    expect(invalidSketchId('r1#2', false)).not.toBeNull();
    expect(invalidFeatureId('extrude#3')).toBeNull();
    expect(invalidFeatureId('extrude#03')).not.toBeNull();
    expect(invalidFeatureId('extrude')).not.toBeNull();
  });

  it('reads sketch ancestry from splits and region pieces', () => {
    expect(sketchAncestors('e2#a#1')).toEqual(['e2#a', 'e2']);
    expect(sketchAncestors('e2')).toEqual([]);
  });

  it('finds the parent of a kernel-split piece only', () => {
    expect(splitParent('cut#4:side:s3#2')).toBe('cut#4:side:s3');
    expect(splitParent('extrude#1:side:e2#a')).toBeNull();
    expect(splitParent('A|B#2')).toBeNull();
    expect(splitParent('A|B[C,D]#2')).toBeNull();
    // A nested positional component reads as a split of the whole name: the
    // corner around the whole face, which is the same corner (documented).
    expect(splitParent('fillet#3:corner:A&B&C#2')).toBe('fillet#3:corner:A&B&C');
  });
});

describe('propagation', () => {
  it('numbers faces generated from one input by position, not index order, and marks them fragile', () => {
    const topology = faces(5, 1);
    const history = [
      entry({
        input: { kind: 'edge', index: 7 },
        generated: [
          { kind: 'face', index: 1 },
          { kind: 'face', index: 2 },
        ],
      }),
    ];
    const { faces: named, unnamed } = propagateFaces(
      [[]],
      history,
      topology,
      () => 'fillet#3:round:r1',
    );
    expect(unnamed).toEqual([]);
    expect(named).toEqual([
      {
        name: 'fillet#3:round:r1#2',
        lineage: ['fillet#3:round:r1#2', 'fillet#3:round:r1'],
        fragile: true,
      },
      {
        name: 'fillet#3:round:r1#1',
        lineage: ['fillet#3:round:r1#1', 'fillet#3:round:r1'],
        fragile: true,
      },
    ]);
    const names = nameShape(named, topology);
    expect(resolveFace(names, { face: 'fillet#3:round:r1' })).toEqual({
      ok: false,
      status: 'ambiguous',
      candidates: ['fillet#3:round:r1#1', 'fillet#3:round:r1#2'],
    });
    expect(resolveFace(names, { face: 'fillet#3:round:r1#1' })).toEqual({
      ok: true,
      index: 2,
      via: 'exact',
      fragile: true,
    });
  });

  it('merges several inputs landing on one face, and each source resolves to it', () => {
    const history = [
      entry({
        operand: 0,
        input: { kind: 'face', index: 1 },
        modified: [{ kind: 'face', index: 1 }],
      }),
      entry({
        operand: 1,
        input: { kind: 'face', index: 1 },
        modified: [{ kind: 'face', index: 1 }],
      }),
    ];
    const { faces: named } = propagateFaces(
      [[plain('b:top')], [plain('a:top')]],
      history,
      faces(0),
    );
    expect(named[0]).toEqual({
      name: '(a:top+b:top)',
      lineage: ['(a:top+b:top)', 'a:top', 'b:top'],
      fragile: false,
    });
    expect(resolveFace(nameShape(named, faces(0)), { face: 'b:top' })).toMatchObject({
      ok: true,
      via: 'descendant',
    });
  });

  it('a face generated from a face replaces it when nothing names it, else the operation names it', () => {
    // Draft: the tilted face is Generated, not Modified.
    const drafted = propagateFaces(
      [[plain('x:side:e1')]],
      [entry({ input: { kind: 'face', index: 1 }, generated: [{ kind: 'face', index: 1 }] })],
      faces(0),
    );
    expect(drafted.faces[0]!.name).toBe('x:side:e1');
    // Shell: the face is kept, and its offset wall is named by the operation.
    const shelled = propagateFaces(
      [[plain('x:side:e1')]],
      [
        entry({
          input: { kind: 'face', index: 1 },
          kept: 1,
          generated: [{ kind: 'face', index: 2 }],
        }),
      ],
      faces(0, 1),
      (_, input) => `shell#2:offset:${input!.name}`,
    );
    expect(shelled.faces.map((f) => f.name)).toEqual(['x:side:e1', 'shell#2:offset:x:side:e1']);
  });

  it('never leaves duplicate names: equal names are numbered by position', () => {
    const out = disambiguate(
      [plain('f:round:A&B'), plain('g'), plain('f:round:A&B')],
      faces(3, 0, 1),
    );
    expect(out.map((f) => f.name)).toEqual(['f:round:A&B#2', 'g', 'f:round:A&B#1']);
    expect(out[0]!.fragile).toBe(true);
    expect(out[0]!.lineage).toContain('f:round:A&B');
  });

  it('a face no history reached is a placeholder that is reported, never picked and never resolved', () => {
    const p = propagateFaces([[plain('a')]], [], faces(0));
    expect(p.unnamed).toEqual([1]);
    expect(p.faces[0]!.name).toBe('?face1');
    const names = nameShape(p.faces, faces(0));
    expect(pickFace(names, 1)).toBeNull();
    expect(resolveFace(names, { face: '?face1' })).toEqual({
      ok: false,
      status: 'lost',
      missing: ['?face1'],
    });
    expect(resolveEdge(names, faces(0), { faces: ['?face1', 'a'] })).toMatchObject({
      ok: false,
      status: 'lost',
    });
  });

  it('a placeholder stays a placeholder when a feature prefixes or wraps it', () => {
    // `?` is reserved in ids, so any name containing it came from a placeholder.
    for (const name of ['?face3', 'shell#2:offset:?face3', 'hole#2:?face3', 'p#3:i2/?face1']) {
      expect(isUnnamed(name), name).toBe(true);
    }
    expect(isUnnamed('extrude#1:side:e1')).toBe(false);
    const topology: Topology = {
      ...faces(0, 1),
      edges: [
        {
          index: 1,
          faces: [1, 2],
          seam: false,
          curve: 'line',
          midpoint: [0, 0, 0],
          length: 1,
          vertices: [],
        },
      ],
    };
    const names = nameShape([plain('shell#2:offset:?face3'), plain('a')], topology);
    expect(pickFace(names, 1)).toBeNull();
    expect(pickFace(names, 2)).toEqual({ face: 'a' });
    expect(resolveFace(names, { face: 'shell#2:offset:?face3' })).toMatchObject({
      ok: false,
      status: 'lost',
    });
    expect(pickEdge(names, 1)).toBeNull();
  });

  it('pattern and mirror copies are prefixed, and their lineage never reaches the source', () => {
    const [copy] = prefixFaces(
      [{ name: 'e#1:side:e2#a', lineage: ['e#1:side:e2#a', 'e#1:side:e2'], fragile: false }],
      'pattern#7:i2',
    );
    expect(copy).toEqual({
      name: 'pattern#7:i2/e#1:side:e2#a',
      lineage: ['pattern#7:i2/e#1:side:e2#a', 'pattern#7:i2/e#1:side:e2'],
      fragile: false,
    });
  });
});

describe('references', () => {
  it('resolves a corner whose inner piece became whole again through its ancestor, fragile', () => {
    const topology = faces(0);
    const names = nameShape([plain('fillet#3:corner:A&B&C')], topology);
    expect(resolveFace(names, { face: 'fillet#3:corner:A&B&C#2' })).toEqual({
      ok: true,
      index: 1,
      via: 'ancestor',
      fragile: true,
    });
  });

  it('an edge touching a placeholder face cannot be picked', () => {
    const topology: Topology = {
      faces: [face(1, 0), face(2, 1)],
      edges: [
        {
          index: 1,
          faces: [1, 2],
          seam: false,
          curve: 'line',
          midpoint: [0, 0, 0],
          length: 1,
          vertices: [],
        },
      ],
      vertices: [],
    };
    const names = nameShape(
      [plain('a'), { name: '?face2', lineage: ['?face2'], fragile: true }],
      topology,
    );
    expect(pickEdge(names, 1)).toBeNull();
    expect(pickEdge(nameShape([plain('a'), plain('b')], topology), 1)).toEqual({
      faces: ['a', 'b'],
    });
  });
});

describe('derived names', () => {
  const D = 'derived#1:from/';
  it.each([
    ['extrude#1:cap:end', `${D}extrude#1:cap:end`],
    // A merge is one group, prefixed once; a split piece keeps its suffix.
    ['(extrude#1:cap:end+extrude#2:side:e5)', `${D}(extrude#1:cap:end+extrude#2:side:e5)`],
    ['(extrude#1:cap:end+extrude#2:side:e5)#2', `${D}(extrude#1:cap:end+extrude#2:side:e5)#2`],
    // A corner has no brackets: every member is prefixed.
    [
      'fillet#3:corner:extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2',
      `${D}fillet#3:corner:extrude#1:cap:end&${D}extrude#1:side:e1&${D}extrude#1:side:e2`,
    ],
    // Members inside a group stay inside it; members after a group are prefixed.
    [
      'fillet#3:corner:(extrude#1:a+extrude#2:b)&extrude#1:c',
      `${D}fillet#3:corner:(extrude#1:a+extrude#2:b)&${D}extrude#1:c`,
    ],
    ['(fillet#3:corner:A&B+extrude#2:c)', `${D}(fillet#3:corner:A&B+extrude#2:c)`],
    ['pattern#7:i2/extrude#3:side:e1', `${D}pattern#7:i2/extrude#3:side:e1`],
    // A nested derived name gains another prefix.
    [
      'derived#2:from/fillet#3:corner:A&derived#2:from/B',
      `${D}derived#2:from/fillet#3:corner:A&${D}derived#2:from/B`,
    ],
  ])('%s', (name, expected) => {
    expect(derivedName(name, 'derived#1')).toBe(expected);
  });

  it('prefixes every lineage entry and keeps fragility', () => {
    const faces: FaceName[] = [
      {
        name: 'extrude#1:side:e2#1',
        lineage: ['extrude#1:side:e2#1', 'extrude#1:side:e2'],
        fragile: true,
      },
    ];
    expect(deriveFaces(faces, 'derived#4')).toEqual([
      {
        name: 'derived#4:from/extrude#1:side:e2#1',
        lineage: ['derived#4:from/extrude#1:side:e2#1', 'derived#4:from/extrude#1:side:e2'],
        fragile: true,
      },
    ]);
    // A positional source name stays positional once prefixed.
    expect(isPositional(derivedName('extrude#1:side:e2#1', 'derived#4'))).toBe(true);
    expect(isPositional(derivedName('extrude#1:side:e2', 'derived#4'))).toBe(false);
  });
});
