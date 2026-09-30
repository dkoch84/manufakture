import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  changedVariables,
  isBodyFeature,
  dirtyFeaturesOf,
  regenOrder,
  topologicalOrder,
  variableClosure,
} from './graph';
import {
  PART,
  add,
  apply,
  block,
  build,
  extrude,
  fillet,
  mm,
  pocket,
  rectangle,
  setVariable,
  twoBodies,
} from './test-helpers';
import type { DerivedFeature, ImportFeature, ManufaktureDocument } from '@manufakture/core';

const part = (doc: ManufaktureDocument) => doc.parts[0]!;

/** block() plus a second, independent sketch and cut on the top face. */
function withPocket(): ManufaktureDocument {
  return apply(
    block(),
    setVariable('pocket', '5'),
    add(
      rectangle('sketch#2', {
        width: '10',
        depth: '10',
        at: [5, 5],
        ids: ['e5', 'e6', 'e7', 'e8'],
        firstConstraint: 12,
        plane: { type: 'face', face: { id: 'r2', ref: { face: 'extrude#1:cap:end' } } },
      }),
    ),
    add(extrude('extrude#2', 'sketch#2', 'pocket', 'cut')),
  );
}

describe('dependency graph', () => {
  it('has named dependencies, body edges and variables read through variables', () => {
    const doc = apply(withPocket(), setVariable('deep', 'pocket * 2'), {
      type: 'editFeature',
      partId: PART,
      feature: extrude('extrude#2', 'sketch#2', 'deep', 'cut'),
    });
    const g = buildGraph(part(doc), doc.variables);
    expect(g.depends.get('extrude#1')).toEqual(['sketch#1']);
    expect(g.depends.get('fillet#1')).toEqual(['extrude#1']);
    expect(g.depends.get('sketch#2')).toEqual(['extrude#1']);
    expect(g.depends.get('extrude#2')).toEqual(['sketch#2']);
    // Body edges: a kernel feature, or a sketch on a face, depends on the last feature that
    // changed each body it reads. The first extrusion reads none.
    expect(g.body.get('extrude#1')).toEqual([]);
    expect(g.body.get('fillet#1')).toEqual(['extrude#1']);
    expect(g.body.get('sketch#2')).toEqual(['fillet#1']);
    expect(g.body.get('extrude#2')).toEqual(['fillet#1']);
    expect(g.body.has('sketch#1')).toBe(false);
    expect(g.variables.get('sketch#1')).toEqual(['depth', 'width']);
    expect(g.variables.get('fillet#1')).toEqual(['radius']);
    expect(g.variables.get('extrude#2')).toEqual(['deep', 'pocket']);
    expect(g.dependents.get('extrude#1')).toEqual(['fillet#1', 'sketch#2']);
    expect(g.dependents.get('fillet#1')).toEqual(['sketch#2', 'extrude#2']);
  });

  it('skips suppressed features in the body chain', () => {
    const doc = apply(withPocket(), {
      type: 'suppressFeature',
      partId: PART,
      featureId: 'fillet#1',
      suppressed: true,
    });
    const g = buildGraph(part(doc), doc.variables);
    expect(g.body.get('sketch#2')).toEqual(['extrude#1']);
    expect(g.body.get('extrude#2')).toEqual(['extrude#1']);
  });

  it('stops at the rollback bar', () => {
    const doc = apply(withPocket(), { type: 'setRollback', partId: PART, index: 3 });
    const g = buildGraph(part(doc), doc.variables);
    expect(g.active.map((f) => f.id)).toEqual(['sketch#1', 'extrude#1', 'fillet#1']);
    expect(g.rolledBack.map((f) => f.id)).toEqual(['sketch#2', 'extrude#2']);
  });

  it('orders a valid part in document order', () => {
    const doc = withPocket();
    expect(regenOrder(buildGraph(part(doc), doc.variables))).toEqual([
      'sketch#1',
      'extrude#1',
      'fillet#1',
      'sketch#2',
      'extrude#2',
    ]);
  });

  it('closes variables over the variables they read', () => {
    const doc = build([
      setVariable('a', '1'),
      setVariable('b', 'a + 1'),
      setVariable('c', 'b * 2'),
      setVariable('d', '4'),
    ]);
    expect([...variableClosure(doc.variables, ['c'])].sort()).toEqual(['a', 'b', 'c']);
    expect([...variableClosure(doc.variables, ['d'])]).toEqual(['d']);
  });
});

describe('imports', () => {
  const imported = (operation: ImportFeature['operation']): ImportFeature => ({
    id: 'import#1',
    kind: 'import',
    name: 'part.step',
    suppressed: false,
    source: {
      format: 'step',
      fileName: 'part.step',
      size: 13,
      sha256: '0'.repeat(64),
      data: 'SVNPLTEwMzAzLTIxOw==',
    },
    operation,
  });

  it('puts an import that joins the body on the body chain, and a reference import beside it', () => {
    expect(isBodyFeature(imported('cut'))).toBe(true);
    expect(isBodyFeature(imported('reference'))).toBe(false);
    const cut = apply(
      block(),
      add(imported('cut')),
      add(fillet('fillet#2', ['a', 'b'], '1', 'r2')),
    );
    expect(buildGraph(part(cut), cut.variables).body.get('fillet#2')).toEqual(['import#1']);
    const ref = apply(
      block(),
      add(imported('reference')),
      add(fillet('fillet#2', ['a', 'b'], '1', 'r2')),
    );
    const g = buildGraph(part(ref), ref.variables);
    expect(g.body.has('import#1')).toBe(false);
    expect(g.body.get('fillet#2')).toEqual(['fillet#1']);
  });
});

describe('derived features', () => {
  const derived: DerivedFeature = {
    id: 'derived#1',
    kind: 'derived',
    name: 'Derived 1',
    suppressed: false,
    source: {
      documentId: 'doc-src',
      documentName: 'Source',
      versionId: 'v-1',
      versionName: 'One',
      partId: 'part#1',
      size: 2,
      sha256: '0'.repeat(64),
      data: '{}',
    },
    placement: {
      translation: [mm('0'), mm('0'), mm('0')],
      rotation: [mm('0'), mm('0'), mm('0')],
    },
    operation: 'new',
  };

  it('has no edge from a later local extrude#1 to a fillet on a derived face', () => {
    const doc = build([
      setVariable('width', '40'),
      setVariable('depth', '30'),
      add(derived),
      add(
        fillet(
          'fillet#1',
          ['derived#1:from/extrude#1:cap:end', 'derived#1:from/extrude#1:side:e1'],
          '1',
        ),
      ),
      add(rectangle('sketch#1', { width: 'width', depth: 'depth' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
    ]);
    expect(isBodyFeature(derived)).toBe(true);
    const g = buildGraph(part(doc), doc.variables);
    expect(g.depends.get('fillet#1')).toEqual(['derived#1']);
    expect(g.body.get('fillet#1')).toEqual(['derived#1']);
    expect(g.dependents.get('extrude#1')).toEqual([]);
    expect(g.dependents.get('sketch#1')).toEqual(['extrude#1']);
    expect(g.dependents.get('derived#1')).toEqual(['fillet#1']);
    expect(regenOrder(g)).toEqual(['derived#1', 'fillet#1', 'sketch#1', 'extrude#1']);
  });
});

describe('topological order', () => {
  it('orders dependencies first and keeps the given order otherwise', () => {
    const deps: Record<string, string[]> = { a: [], b: ['d'], c: [], d: ['a'] };
    expect(topologicalOrder(['a', 'b', 'c', 'd'], (n) => deps[n]!)).toEqual(['a', 'c', 'd', 'b']);
    expect(topologicalOrder(['c', 'a', 'd', 'b'], (n) => deps[n]!)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ignores dependencies outside the set and throws on a cycle', () => {
    expect(topologicalOrder(['x', 'y'], (n) => (n === 'y' ? ['x', 'gone'] : []))).toEqual([
      'x',
      'y',
    ]);
    expect(() =>
      topologicalOrder(['p', 'q', 'r'], (n) => (n === 'p' ? ['q'] : n === 'q' ? ['p'] : [])),
    ).toThrow(/cycle among p, q/);
  });
});

describe('dirty subgraph', () => {
  const dirty = (a: ManufaktureDocument | null, b: ManufaktureDocument) =>
    dirtyFeaturesOf(a, b, PART);

  it('is everything on a first regen, and nothing for a rename', () => {
    const doc = withPocket();
    expect(dirty(null, doc)).toEqual([
      'sketch#1',
      'extrude#1',
      'fillet#1',
      'sketch#2',
      'extrude#2',
    ]);
    const renamed = apply(doc, {
      type: 'renameFeature',
      partId: PART,
      featureId: 'sketch#1',
      name: 'Base',
    });
    expect(dirty(doc, renamed)).toEqual([]);
    expect(
      dirty(
        doc,
        apply(doc, {
          type: 'setDisplayUnits',
          units: { length: { unit: 'in' }, angle: { unit: 'deg' } },
        }),
      ),
    ).toEqual([]);
  });

  it('is only the readers of a variable (and what depends on them)', () => {
    const doc = withPocket();
    expect(dirty(doc, apply(doc, setVariable('pocket', '6')))).toEqual(['extrude#2']);
    // The fillet feeds the body the pocket sketch sits on.
    expect(dirty(doc, apply(doc, setVariable('radius', '4mm')))).toEqual([
      'fillet#1',
      'sketch#2',
      'extrude#2',
    ]);
    // Through another variable.
    const derived = apply(doc, setVariable('base', '40'), setVariable('width', 'base'));
    expect(dirty(derived, apply(derived, setVariable('base', '50')))).toEqual([
      'sketch#1',
      'extrude#1',
      'fillet#1',
      'sketch#2',
      'extrude#2',
    ]);
  });

  it('follows body edges and named dependencies from an edited feature', () => {
    const doc = withPocket();
    const edited = apply(doc, {
      type: 'editFeature',
      partId: PART,
      feature: extrude('extrude#1', 'sketch#1', '25'),
    });
    expect(dirty(doc, edited)).toEqual(['extrude#1', 'fillet#1', 'sketch#2', 'extrude#2']);
    const cut = apply(doc, {
      type: 'editFeature',
      partId: PART,
      feature: extrude('extrude#2', 'sketch#2', 'pocket', 'intersect'),
    });
    expect(dirty(doc, cut)).toEqual(['extrude#2']);
  });

  it('marks what a suppression or a reorder changes the body for', () => {
    const doc = withPocket();
    const off = apply(doc, {
      type: 'suppressFeature',
      partId: PART,
      featureId: 'fillet#1',
      suppressed: true,
    });
    expect(dirty(doc, off)).toEqual(['fillet#1', 'sketch#2', 'extrude#2']);
    // Two independent features after the base: swapping them changes both bodies.
    const two = apply(
      block(),
      add(fillet('fillet#2', ['extrude#1:side:e3', 'extrude#1:side:e4'], '1mm', 'r2')),
    );
    const swapped = apply(two, {
      type: 'reorderFeature',
      partId: PART,
      featureId: 'fillet#2',
      index: 2,
    });
    expect(dirty(two, swapped)).toEqual(['fillet#2', 'fillet#1']);
  });

  it('adds what the rollback bar uncovers, and nothing it covers', () => {
    const doc = withPocket();
    const rolled = apply(doc, { type: 'setRollback', partId: PART, index: 3 });
    expect(dirty(doc, rolled)).toEqual([]);
    expect(dirty(rolled, doc)).toEqual(['sketch#2', 'extrude#2']);
  });

  it('trusts the first affected index of the store change', () => {
    const doc = withPocket();
    const next = apply(doc, setVariable('pocket', '6'));
    expect(dirtyFeaturesOf(doc, next, PART, { firstAffectedIndex: null })).toEqual([]);
    expect(dirtyFeaturesOf(doc, next, PART, { firstAffectedIndex: 4 })).toEqual(['extrude#2']);
  });

  it('is per body: an edit to body 2 leaves body 1 clean when scopes say so', () => {
    // A cut through the first body only, scoped or not, before the fillets.
    const withCut = (scope?: string[]) =>
      twoBodies([
        add(pocket('sketch#3', [5, 5])),
        add({ ...extrude('extrude#3', 'sketch#3', '5', 'cut'), ...(scope ? { scope } : {}) }),
      ]);
    const scoped = withCut(['extrude#1']);
    const g = buildGraph(part(scoped), scoped.variables);
    // A `new` extrusion reads no body; the scoped cut reads its body; each fillet the body its
    // edge is on.
    expect(g.body.get('extrude#2')).toEqual([]);
    expect(g.body.get('extrude#3')).toEqual(['extrude#1']);
    expect(g.body.get('fillet#1')).toEqual(['extrude#3']);
    expect(g.body.get('fillet#2')).toEqual(['extrude#2']);
    expect(dirty(scoped, apply(scoped, setVariable('w2', '50')))).toEqual([
      'sketch#2',
      'extrude#2',
      'fillet#2',
    ]);
    expect(dirty(scoped, apply(scoped, setVariable('r1', '4mm')))).toEqual(['fillet#1']);

    // Without a scope the cut reads (and may change) both bodies: body 2's edit reaches body 1.
    const open = withCut();
    expect(buildGraph(part(open), open.variables).body.get('extrude#3')).toEqual([
      'extrude#1',
      'extrude#2',
    ]);
    expect(dirty(open, apply(open, setVariable('w2', '50')))).toEqual([
      'sketch#2',
      'extrude#2',
      'extrude#3',
      'fillet#1',
      'fillet#2',
    ]);
  });

  it('routes references after a merge to the body the faces went to', () => {
    // An unscoped add may fuse both bodies: a fillet on body 2's faces then depends on it.
    const doc = twoBodies([
      add(pocket('sketch#3', [30, 5])),
      add(extrude('extrude#3', 'sketch#3', '5', 'add')),
    ]);
    const g = buildGraph(part(doc), doc.variables);
    expect(g.body.get('extrude#3')).toEqual(['extrude#1', 'extrude#2']);
    expect(g.body.get('fillet#1')).toEqual(['extrude#3']);
    expect(g.body.get('fillet#2')).toEqual(['fillet#1']);
    expect(dirty(doc, apply(doc, setVariable('r2', '1mm')))).toEqual(['fillet#2']);
  });

  it('lists changed variables and their readers', () => {
    const a = build([setVariable('x', '1'), setVariable('y', 'x'), setVariable('z', '3')]);
    const b = apply(a, setVariable('x', '2'), setVariable('w', '5'));
    expect([...changedVariables(a.variables, b.variables)].sort()).toEqual(['w', 'x', 'y']);
    const c = apply(a, { type: 'deleteVariable', name: 'z' });
    expect([...changedVariables(a.variables, c.variables)]).toEqual(['z']);
  });
});
