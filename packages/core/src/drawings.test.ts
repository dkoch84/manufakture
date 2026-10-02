import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import {
  CommandSchema,
  applyCommand,
  assemblyViews,
  explodedViewViews,
  instanceDimensions,
  partViews,
  restoredDocument,
  variableUsers,
  type Command,
} from './commands';
import { createDrawing } from './document';
import { drawingExpressions, explodedViewExpressions, explodedViewIds, sheetIds } from './features';
import { deserialize, parseDocument, serialize } from './format';
import type { CoreErrorCode } from './result';
import {
  DimensionSchema,
  DocumentSchema,
  DrawingSchema,
  ExplodedViewSchema,
  MAX_PAPER_COORDINATE,
  NoteSchema,
  SheetSchema,
  ViewSchema,
  type Dimension,
  type Drawing,
  type DrawingView,
  type ExplodeStep,
  type ExplodedView,
  type Instance,
  type ManufaktureDocument,
  type Note,
  type Sheet,
} from './schema';
import { DocumentStore } from './store';
import { PART, bracket, clone, deepFreeze, mm, unwrap } from './test-helpers';
import { validateDocument } from './validate';
import { drawingVariableUses, inlineVariable, renameVariable, variableUses } from './variables';

/**
 * Format v12 (M4 plan decisions 7 and 9, T4.4a's dimension model): drawings and exploded views.
 * Schema, validation, commands with their inverses, what blocks what, changes, the file.
 */

const A = 'assembly#1';
const D = 'drawing#1';
const S = 'sheet#1';

function apply(doc: ManufaktureDocument, command: Command) {
  return unwrap(applyCommand(doc, command));
}

function applied(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return apply(doc, command).document;
}

function refused(doc: ManufaktureDocument, command: Command, code: CoreErrorCode) {
  const r = applyCommand(doc, command);
  expect(r.ok, `expected ${command.type} to be refused`).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r.ok ? undefined : r.error;
}

/** The document with every `nextIds` removed: undo never moves a counter back. */
function withoutCounters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCounters);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== 'nextIds')
      .map(([k, v]) => [k, withoutCounters(v)]),
  );
}

/**
 * Applies `command`, then its inverse, then the inverse of that: undo gives back the document
 * but its counters, and redo gives back the result exactly.
 */
function roundTrip(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const done = apply(doc, command);
  const undone = apply(done.document, done.inverse);
  expect(withoutCounters(undone.document)).toEqual(withoutCounters(doc));
  expect(Object.keys(undone.document)).toEqual(Object.keys(doc));
  const redone = apply(undone.document, undone.inverse);
  expect(redone.document).toEqual(done.document);
  return done.document;
}

const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } as const;

function instance(id: string): Instance {
  return {
    id,
    name: `Board ${id.slice(5)}`,
    source: { part: PART },
    fixed: id === 'inst#1',
    suppressed: false,
    pose: IDENTITY,
  };
}

function step(id: string, instances: string[], over: Partial<ExplodeStep> = {}): ExplodeStep {
  return {
    id,
    instances,
    direction: { vector: [0, 0, 1] },
    distance: mm('thickness * 4'),
    ...over,
  };
}

function explodedView(over: Partial<ExplodedView> = {}): ExplodedView {
  return { id: 'explode#1', name: 'Exploded', steps: [step('step#1', ['inst#2'])], ...over };
}

function partView(over: Partial<DrawingView> = {}): DrawingView {
  return {
    id: 'view#1',
    source: { part: PART },
    direction: 'front',
    scale: { paper: mm('1'), model: mm('2') },
    position: [100, 120],
    options: { hidden: true, smooth: false },
    ...over,
  };
}

function assemblyView(over: Partial<DrawingView> = {}): DrawingView {
  return partView({
    id: 'view#2',
    source: { assembly: A, explodedView: 'explode#1' },
    direction: 'isometric',
    position: [300, 120],
    ...over,
  });
}

/** Foot thickness: two faces of the bracket, measured along the first one's normal. */
function thickness(over: Partial<Dimension> = {}): Dimension {
  return {
    id: 'dim#1',
    view: 'view#1',
    kind: 'vertical',
    refs: [
      { face: { face: 'extrude#1:cap:start' }, body: 'extrude#1' },
      { face: { face: 'extrude#1:cap:end' }, body: 'extrude#1' },
    ],
    offset: -12,
    ...over,
  } as Dimension;
}

function holeDiameter(): Dimension {
  return {
    id: 'dim#2',
    view: 'view#1',
    kind: 'diameter',
    refs: [{ edge: { faces: ['extrude#2:wall:e5'] }, body: 'extrude#1' }],
    at: [8, 14],
    decimals: 1,
  };
}

function cornerAngle(): Dimension {
  return {
    id: 'dim#3',
    view: 'view#1',
    kind: 'angle',
    refs: [
      { edge: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] }, body: 'extrude#1' },
      { face: { face: 'extrude#1:side:e2' }, body: 'extrude#1' },
    ],
    at: [10, 10],
    text: '<> TYP',
  };
}

/** A dimension between two boards of the assembly view. */
function gap(): Dimension {
  return {
    id: 'dim#4',
    view: 'view#2',
    kind: 'aligned',
    refs: [
      {
        vertex: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1', 'extrude#1:side:e2'] },
        body: 'extrude#1',
        instance: ['inst#1'],
      },
      { face: { face: 'extrude#1:cap:start' }, body: 'extrude#1', instance: ['inst#2'] },
    ],
    offset: 5,
    denominator: 16,
  };
}

function note(over: Partial<Note> = {}): Note {
  return { id: 'note#1', view: 'view#1', position: [0, -30], text: 'FRONT', ...over };
}

function sheet(over: Partial<Sheet> = {}): Sheet {
  return {
    id: S,
    name: 'Sheet 1',
    size: 'A3',
    orientation: 'landscape',
    titleBlock: {
      fields: [
        { label: 'Title', value: 'Bracket' },
        { label: 'Drawn by', value: 'D. K.' },
      ],
    },
    views: [partView(), assemblyView()],
    dimensions: [thickness(), holeDiameter(), cornerAngle(), gap()],
    notes: [note()],
    ...over,
  };
}

function drawing(over: Partial<Drawing> = {}): Drawing {
  return {
    id: D,
    name: 'Bracket drawing',
    sheets: [sheet()],
    nextIds: { sheet: 2, view: 3, dim: 5, note: 2 },
    ...over,
  };
}

/** The bracket, an assembly of two bracket instances. */
function assembled(): ManufaktureDocument {
  return applied(bracket(), {
    type: 'batch',
    commands: [
      { type: 'addAssembly', assemblyId: A, name: 'Pair' },
      { type: 'addInstance', assemblyId: A, instance: instance('inst#1') },
      { type: 'addInstance', assemblyId: A, instance: instance('inst#2') },
      { type: 'addInstance', assemblyId: A, instance: instance('inst#3') },
    ],
  });
}

/** `assembled()` with an exploded view and the drawing above. */
function drawn(): ManufaktureDocument {
  return applied(assembled(), {
    type: 'batch',
    commands: [
      { type: 'addExplodedView', assemblyId: A, explodedView: explodedView() },
      { type: 'addDrawing', drawing: drawing() },
    ],
  });
}

function sheetOf(doc: ManufaktureDocument, drawingId = D, sheetId = S): Sheet {
  return doc.drawings!.find((d) => d.id === drawingId)!.sheets.find((s) => s.id === sheetId)!;
}

describe('drawings (schema)', () => {
  it('accepts a drawing with every dimension kind, both view sources and a note', () => {
    expect(DrawingSchema.safeParse(drawing()).success).toBe(true);
    expect(validateDocument(drawn())).toEqual([]);
  });

  it('is optional and never empty: no drawings means no key', () => {
    const doc = drawn();
    expect('drawings' in bracket()).toBe(false);
    expect(DocumentSchema.safeParse({ ...doc, drawings: [] }).success).toBe(false);
  });

  it.each([
    ['a standard size', 'A0'],
    ['letter', 'letter'],
    ['a custom size of expressions', { width: mm('600'), height: mm('width') }],
  ])('accepts %s', (_label, size) => {
    expect(SheetSchema.safeParse(sheet({ size: size as Sheet['size'] })).success).toBe(true);
  });

  it('refuses an unknown sheet size and orientation', () => {
    expect(SheetSchema.safeParse({ ...sheet(), size: 'B4' }).success).toBe(false);
    expect(SheetSchema.safeParse({ ...sheet(), orientation: 'square' }).success).toBe(false);
  });

  it('accepts a custom direction and refuses a zero or parallel one', () => {
    const ok = partView({ direction: { direction: [1, 1, 0], up: [0, 0, 1] } });
    expect(ViewSchema.safeParse(ok).success).toBe(true);
    const zero = partView({ direction: { direction: [0, 0, 0], up: [0, 0, 1] } });
    expect(ViewSchema.safeParse(zero).success).toBe(false);
    const parallel = partView({ direction: { direction: [0, 0, -2], up: [0, 0, 1] } });
    expect(ViewSchema.safeParse(parallel).success).toBe(false);
    expect(ViewSchema.safeParse({ ...partView(), direction: 'sideways' }).success).toBe(false);
  });

  it('accepts a section plane with an offset expression, and refuses a zero normal', () => {
    const section = { normal: [0, 1, 0] as const, offset: mm('thickness / 2') };
    expect(
      ViewSchema.safeParse(partView({ options: { hidden: false, smooth: true, section } })).success,
    ).toBe(true);
    const bad = { ...section, normal: [0, 0, 0] as const };
    expect(
      ViewSchema.safeParse(partView({ options: { hidden: false, smooth: true, section: bad } }))
        .success,
    ).toBe(false);
  });

  it('accepts a view of some bodies of a part, and refuses an empty body list', () => {
    expect(
      ViewSchema.safeParse(partView({ source: { part: PART, bodies: ['extrude#1'] } })).success,
    ).toBe(true);
    expect(ViewSchema.safeParse(partView({ source: { part: PART, bodies: [] } })).success).toBe(
      false,
    );
  });

  it('refuses a view source that mixes a part and an assembly', () => {
    expect(
      ViewSchema.safeParse({ ...partView(), source: { part: PART, assembly: A } }).success,
    ).toBe(false);
  });

  it('refuses a linear dimension without two references', () => {
    const one = { ...thickness(), refs: [thickness().refs[0]] };
    expect(DimensionSchema.safeParse(one).success).toBe(false);
  });

  it('refuses a vertex for a radius, a diameter or an angle', () => {
    const vertex = { vertex: { faces: ['a', 'b', 'c'] }, body: 'extrude#1' };
    expect(DimensionSchema.safeParse({ ...holeDiameter(), refs: [vertex] }).success).toBe(false);
    const angle = cornerAngle();
    expect(DimensionSchema.safeParse({ ...angle, refs: [vertex, angle.refs[1]] }).success).toBe(
      false,
    );
  });

  it('places linear dimensions by an offset and the others by a point, never mixed', () => {
    expect(DimensionSchema.safeParse({ ...thickness(), at: [1, 2] }).success).toBe(false);
    const { at: _at, ...noAt } = holeDiameter() as Extract<Dimension, { at: unknown }>;
    void _at;
    expect(DimensionSchema.safeParse({ ...noAt, offset: 3 }).success).toBe(false);
  });

  it('refuses a paper coordinate past the cap, a fraction denominator of 3 and empty texts', () => {
    const far = MAX_PAPER_COORDINATE * 2;
    expect(ViewSchema.safeParse(partView({ position: [far, 0] })).success).toBe(false);
    expect(DimensionSchema.safeParse(thickness({ offset: -far })).success).toBe(false);
    expect(DimensionSchema.safeParse({ ...gap(), denominator: 3 }).success).toBe(false);
    expect(DimensionSchema.safeParse({ ...cornerAngle(), text: '' }).success).toBe(false);
    expect(NoteSchema.safeParse(note({ text: '' })).success).toBe(false);
  });

  it('refuses a reference that is not a body, or an empty instance path', () => {
    const [a, b] = thickness().refs;
    expect(
      DimensionSchema.safeParse({ ...thickness(), refs: [{ ...a, body: 'nope' }, b] }).success,
    ).toBe(false);
    expect(
      DimensionSchema.safeParse({ ...thickness(), refs: [{ ...a, instance: [] }, b] }).success,
    ).toBe(false);
  });

  it('refuses ids of the wrong kind', () => {
    expect(ViewSchema.safeParse(partView({ id: 'dim#1' })).success).toBe(false);
    expect(DrawingSchema.safeParse(drawing({ id: 'drawing#0' })).success).toBe(false);
    expect(NoteSchema.safeParse(note({ id: 'note#1x' })).success).toBe(false);
  });
});

describe('exploded views (schema)', () => {
  it('accepts vector and reference directions, flipped or not', () => {
    const steps = [
      step('step#1', ['inst#2']),
      step('step#2', ['inst#3'], {
        direction: {
          instance: 'inst#1',
          edge: { faces: ['extrude#1:side:e1', 'extrude#1:side:e2'] },
        },
      }),
      step('step#3', ['inst#2', 'inst#3'], {
        direction: { instance: 'inst#1', face: { face: 'extrude#1:cap:end' }, flip: true },
      }),
    ];
    expect(ExplodedViewSchema.safeParse(explodedView({ steps })).success).toBe(true);
  });

  it('refuses a zero vector, a step that moves nothing, and flip: false', () => {
    const zero = step('step#1', ['inst#2'], { direction: { vector: [0, 0, 0] } });
    expect(ExplodedViewSchema.safeParse(explodedView({ steps: [zero] })).success).toBe(false);
    expect(
      ExplodedViewSchema.safeParse(explodedView({ steps: [step('step#1', [])] })).success,
    ).toBe(false);
    const unflipped = {
      ...step('step#1', ['inst#2']),
      direction: { instance: 'inst#1', face: { face: 'x' }, flip: false },
    };
    expect(ExplodedViewSchema.safeParse({ ...explodedView(), steps: [unflipped] }).success).toBe(
      false,
    );
  });

  it('is optional on an assembly and never empty', () => {
    const doc = drawn();
    expect('explodedViews' in assembled().assemblies[0]!).toBe(false);
    const empty = { ...doc, assemblies: [{ ...doc.assemblies[0]!, explodedViews: [] }] };
    expect(DocumentSchema.safeParse(empty).success).toBe(false);
  });

  it('lists its ids and expressions', () => {
    const view = explodedView({ steps: [step('step#1', ['inst#2']), step('step#4', ['inst#3'])] });
    expect(explodedViewIds(view)).toEqual(['explode#1', 'step#1', 'step#4']);
    expect(explodedViewExpressions(view).map((s) => s.path)).toEqual([
      ['steps', 0, 'distance'],
      ['steps', 1, 'distance'],
    ]);
  });
});

describe('validation', () => {
  function issues(change: (doc: ManufaktureDocument) => void) {
    const doc = clone(drawn());
    change(doc);
    return validateDocument(doc).map((e) => ({ code: e.code, path: e.path }));
  }
  const at = (...path: (string | number)[]) => ['drawings', 0, 'sheets', 0, ...path];

  it('reports a view of a part, assembly or exploded view that does not exist', () => {
    expect(
      issues((d) => {
        sheetOf(d).views[0]!.source = { part: 'part#9' };
      }),
    ).toEqual([{ code: 'dependency', path: at('views', 0, 'source', 'part') }]);
    expect(
      issues((d) => {
        sheetOf(d).views[1]!.source = { assembly: 'assembly#9' };
        sheetOf(d).dimensions.pop();
      }),
    ).toEqual([{ code: 'dependency', path: at('views', 1, 'source', 'assembly') }]);
    expect(
      issues((d) => {
        sheetOf(d).views[1]!.source = { assembly: A, explodedView: 'explode#7' };
      }),
    ).toEqual([{ code: 'dependency', path: at('views', 1, 'source', 'explodedView') }]);
  });

  it('reports a body listed twice in a view', () => {
    expect(
      issues((d) => {
        sheetOf(d).views[0]!.source = { part: PART, bodies: ['extrude#1', 'extrude#1'] };
      }),
    ).toEqual([{ code: 'duplicate', path: at('views', 0, 'source', 'bodies', 1) }]);
  });

  it('reports a dimension or note in a view that is not on its sheet', () => {
    expect(
      issues((d) => {
        sheetOf(d).dimensions[0]!.view = 'view#7';
        sheetOf(d).notes[0]!.view = 'view#8';
      }),
    ).toEqual([
      { code: 'dependency', path: at('dimensions', 0, 'view') },
      { code: 'dependency', path: at('notes', 0, 'view') },
    ]);
  });

  it('wants an instance path exactly in assembly views, of one instance', () => {
    expect(
      issues((d) => {
        sheetOf(d).dimensions[0]!.refs[0]!.instance = ['inst#1'];
      }),
    ).toEqual([{ code: 'kind-mismatch', path: at('dimensions', 0, 'refs', 0, 'instance') }]);
    expect(
      issues((d) => {
        delete sheetOf(d).dimensions[3]!.refs[0]!.instance;
      }),
    ).toEqual([{ code: 'kind-mismatch', path: at('dimensions', 3, 'refs', 0) }]);
    expect(
      issues((d) => {
        sheetOf(d).dimensions[3]!.refs[0]!.instance = ['inst#1', 'inst#2'];
      }),
    ).toEqual([{ code: 'kind-mismatch', path: at('dimensions', 3, 'refs', 0, 'instance') }]);
    // Not whether the instance exists: dimensions never block model edits; regen reports `lost`.
    expect(
      issues((d) => {
        sheetOf(d).dimensions[3]!.refs[1]!.instance = ['inst#9'];
      }),
    ).toEqual([]);
  });

  it('never checks bodies, faces, edges or vertices against the model', () => {
    const doc = clone(drawn());
    sheetOf(doc).views[0]!.source = { part: PART, bodies: ['pattern#9:i3'] };
    sheetOf(doc).dimensions[0]!.refs[0]!.body = 'fillet#7';
    sheetOf(doc).dimensions[1]!.refs[0] = { face: { face: 'gone#1:x' }, body: 'gone#1' };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('reports ids never allocated or used twice in a drawing, and an unallocated drawing id', () => {
    expect(
      issues((d) => {
        d.drawings![0]!.nextIds.dim = 4;
        sheetOf(d).notes.push({ ...note(), id: 'note#1' });
      }),
    ).toEqual([
      { code: 'invalid-id', path: at('dimensions', 3, 'id') },
      { code: 'duplicate', path: at('notes', 1, 'id') },
    ]);
    expect(
      issues((d) => {
        d.nextIds.drawing = 1;
      }),
    ).toEqual([{ code: 'invalid-id', path: ['drawings', 0, 'id'] }]);
  });

  it('counts ids across the sheets of a drawing, and per drawing', () => {
    expect(
      issues((d) => {
        d.drawings![0]!.sheets.push({
          ...sheet(),
          id: 'sheet#2',
          views: [partView()],
          dimensions: [],
          notes: [],
        });
        d.drawings![0]!.nextIds.sheet = 3;
      }),
    ).toEqual([{ code: 'duplicate', path: ['drawings', 0, 'sheets', 1, 'views', 0, 'id'] }]);
    // Another drawing has its own counters: the same ids are fine there.
    expect(
      issues((d) => {
        d.drawings!.push({ ...clone(d.drawings![0]!), id: 'drawing#2' });
        d.nextIds.drawing = 3;
      }),
    ).toEqual([]);
  });

  it('reports expressions that do not parse or name unknown variables', () => {
    expect(
      issues((d) => {
        sheetOf(d).views[0]!.scale.model = mm('#nope');
        sheetOf(d).size = { width: mm('10 +'), height: mm('20') };
      }),
    ).toEqual([
      { code: 'expression', path: at('size', 'width', 'source') },
      { code: 'unknown-variable', path: at('views', 0, 'scale', 'model', 'source') },
    ]);
  });

  it('reports exploded steps naming instances that are not in the assembly, or one twice', () => {
    const path = (...p: (string | number)[]) => [
      'assemblies',
      0,
      'explodedViews',
      0,
      'steps',
      0,
      ...p,
    ];
    expect(
      issues((d) => {
        d.assemblies[0]!.explodedViews![0]!.steps[0] = step(
          'step#1',
          ['inst#2', 'inst#9', 'inst#2'],
          {
            direction: { instance: 'inst#8', face: { face: 'extrude#1:cap:end' } },
            distance: mm('#missing'),
          },
        );
      }),
    ).toEqual([
      { code: 'duplicate', path: path('instances', 2) },
      { code: 'dependency', path: path('instances', 1) },
      { code: 'dependency', path: path('direction', 'instance') },
      { code: 'unknown-variable', path: path('distance', 'source') },
    ]);
  });

  it('checks exploded view and step ids against the assembly counters', () => {
    expect(
      issues((d) => {
        d.assemblies[0]!.nextIds.step = 1;
      }),
    ).toEqual([
      { code: 'invalid-id', path: ['assemblies', 0, 'explodedViews', 0, 'steps', 0, 'id'] },
    ]);
  });
});

describe('drawing commands', () => {
  it('adds the first drawing, and undo leaves no drawings key', () => {
    const doc = assembled();
    const added = apply(doc, { type: 'addDrawing', drawing: createDrawing(D, 'Empty') });
    expect(added.document.drawings).toEqual([createDrawing(D, 'Empty')]);
    expect(added.document.nextIds.drawing).toBe(2);
    const undone = apply(added.document, added.inverse).document;
    expect('drawings' in undone).toBe(false);
    const exploded = applied(doc, {
      type: 'addExplodedView',
      assemblyId: A,
      explodedView: explodedView(),
    });
    roundTrip(exploded, { type: 'addDrawing', drawing: drawing() });
  });

  it('refuses a drawing id reused, taken, or not a drawing id', () => {
    const doc = drawn();
    refused(doc, { type: 'addDrawing', drawing: createDrawing(D, 'Again') }, 'duplicate');
    const gone = applied(doc, { type: 'deleteDrawing', drawingId: D });
    refused(gone, { type: 'addDrawing', drawing: createDrawing(D, 'Again') }, 'id-reused');
    expect(
      CommandSchema.safeParse({ type: 'addDrawing', drawing: createDrawing('drawing#x', 'X') })
        .success,
    ).toBe(false);
    refused(
      gone,
      { type: 'restoreDrawing', drawing: createDrawing('drawing#5', 'X'), index: 0 },
      'invalid-id',
    );
  });

  it('refuses a drawing whose inner ids its own counters never handed out', () => {
    refused(assembled(), { type: 'addDrawing', drawing: drawing({ nextIds: {} }) }, 'invalid-id');
  });

  it('deletes, restores, renames and reorders drawings with exact inverses', () => {
    let doc = drawn();
    roundTrip(doc, { type: 'deleteDrawing', drawingId: D });
    roundTrip(doc, { type: 'renameDrawing', drawingId: D, name: '  Shop drawing ' });
    expect(
      applied(doc, { type: 'renameDrawing', drawingId: D, name: '  Shop ' }).drawings![0]!.name,
    ).toBe('Shop');
    refused(doc, { type: 'renameDrawing', drawingId: D, name: '  ' }, 'invalid-name');
    doc = applied(doc, { type: 'addDrawing', drawing: createDrawing('drawing#2', 'Second') });
    const moved = roundTrip(doc, { type: 'reorderDrawings', drawingId: 'drawing#2', index: 0 });
    expect(moved.drawings!.map((d) => d.id)).toEqual(['drawing#2', D]);
    refused(doc, { type: 'reorderDrawings', drawingId: D, index: 2 }, 'invalid-index');
    refused(doc, { type: 'deleteDrawing', drawingId: 'drawing#9' }, 'not-found');
  });

  it('adds, edits, deletes, restores and reorders sheets', () => {
    const doc = drawn();
    const second: Sheet = {
      ...sheet(),
      id: 'sheet#2',
      name: 'Details',
      views: [],
      dimensions: [],
      notes: [],
    };
    const two = roundTrip(doc, { type: 'addSheet', drawingId: D, sheet: second });
    expect(two.drawings![0]!.nextIds.sheet).toBe(3);
    roundTrip(two, { type: 'reorderSheets', drawingId: D, sheetId: 'sheet#2', index: 0 });
    roundTrip(doc, { type: 'deleteSheet', drawingId: D, sheetId: S });
    roundTrip(doc, {
      type: 'editSheet',
      drawingId: D,
      sheetId: S,
      name: 'Main',
      size: { width: mm('36in'), height: mm('24in') },
      orientation: 'portrait',
      titleBlock: null,
    });
    const edited = applied(doc, { type: 'editSheet', drawingId: D, sheetId: S, titleBlock: null });
    expect('titleBlock' in sheetOf(edited)).toBe(false);
    // A sheet id, or a view id inside a new sheet, already handed out is refused.
    refused(doc, { type: 'addSheet', drawingId: D, sheet: sheet() }, 'duplicate');
    refused(
      doc,
      { type: 'addSheet', drawingId: D, sheet: { ...second, views: [partView()] } },
      'id-reused',
    );
    refused(doc, { type: 'restoreSheet', drawingId: D, sheet: sheet(), index: 0 }, 'duplicate');
    refused(doc, { type: 'editSheet', drawingId: D, sheetId: 'sheet#9', name: 'X' }, 'not-found');
  });

  it('adds, edits, moves, deletes and restores views', () => {
    const doc = drawn();
    const third = partView({ id: 'view#3', direction: 'top', position: [100, 250] });
    const added = roundTrip(doc, {
      type: 'addView',
      drawingId: D,
      sheetId: S,
      view: third,
      index: 0,
    });
    expect(sheetOf(added).views.map((v) => v.id)).toEqual(['view#3', 'view#1', 'view#2']);
    expect(added.drawings![0]!.nextIds.view).toBe(4);
    roundTrip(doc, {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: partView({ direction: 'right' }),
    });
    const moved = roundTrip(doc, {
      type: 'moveView',
      drawingId: D,
      sheetId: S,
      viewId: 'view#1',
      position: [5, 6],
    });
    expect(sheetOf(moved).views[0]!.position).toEqual([5, 6]);
    refused(
      doc,
      { type: 'addView', drawingId: D, sheetId: S, view: partView({ id: 'view#1' }) },
      'duplicate',
    );
    refused(
      doc,
      { type: 'editView', drawingId: D, sheetId: S, view: partView({ id: 'view#9' }) },
      'not-found',
    );
    refused(
      doc,
      {
        type: 'addView',
        drawingId: D,
        sheetId: S,
        view: partView({ id: 'view#3', source: { part: 'part#7' } }),
      },
      'dependency',
    );
  });

  it('refuses to delete a view while a dimension or note is in it, but not in the same batch', () => {
    const doc = drawn();
    const error = refused(
      doc,
      { type: 'deleteView', drawingId: D, sheetId: S, viewId: 'view#1' },
      'dependency',
    );
    expect(error?.blockers).toEqual(['dim#1', 'dim#2', 'dim#3', 'note#1']);
    const batch: Command = {
      type: 'batch',
      commands: [
        ...['dim#1', 'dim#2', 'dim#3'].map((dimensionId): Command => ({
          type: 'deleteDimension',
          drawingId: D,
          sheetId: S,
          dimensionId,
        })),
        { type: 'deleteNote', drawingId: D, sheetId: S, noteId: 'note#1' },
        { type: 'deleteView', drawingId: D, sheetId: S, viewId: 'view#1' },
      ],
    };
    const gone = roundTrip(doc, batch);
    expect(sheetOf(gone).views.map((v) => v.id)).toEqual(['view#2']);
  });

  it('adds, edits, deletes and restores dimensions and notes', () => {
    const doc = drawn();
    const fifth = thickness({ id: 'dim#5', kind: 'horizontal', offset: 20 });
    roundTrip(doc, { type: 'addDimension', drawingId: D, sheetId: S, dimension: fifth });
    roundTrip(doc, {
      type: 'editDimension',
      drawingId: D,
      sheetId: S,
      dimension: thickness({ offset: 30, text: 'T = <>' }),
    });
    roundTrip(doc, { type: 'deleteDimension', drawingId: D, sheetId: S, dimensionId: 'dim#2' });
    roundTrip(doc, {
      type: 'addNote',
      drawingId: D,
      sheetId: S,
      note: { id: 'note#2', position: [20, 20], text: 'ALL DIMENSIONS IN MM' },
    });
    roundTrip(doc, {
      type: 'editNote',
      drawingId: D,
      sheetId: S,
      note: note({ text: 'FRONT VIEW' }),
    });
    roundTrip(doc, { type: 'deleteNote', drawingId: D, sheetId: S, noteId: 'note#1' });
    refused(
      doc,
      {
        type: 'addDimension',
        drawingId: D,
        sheetId: S,
        dimension: thickness({ id: 'dim#5', view: 'view#9' }),
      },
      'dependency',
    );
    refused(
      doc,
      { type: 'addDimension', drawingId: D, sheetId: S, dimension: thickness({ id: 'dim#4' }) },
      'duplicate',
    );
    refused(doc, { type: 'deleteNote', drawingId: D, sheetId: S, noteId: 'note#4' }, 'not-found');
    refused(
      doc,
      { type: 'restoreDimension', drawingId: D, sheetId: S, dimension: thickness(), index: 2 },
      'invalid-index',
    );
  });

  it('never refuses a dimension for what its references name', () => {
    const doc = drawn();
    const lost = thickness({
      id: 'dim#5',
      refs: [
        { face: { face: 'chamfer#3:face' }, body: 'chamfer#3' },
        { edge: { faces: ['nothing#1:a', 'nothing#1:b'] }, body: 'extrude#9' },
      ],
    });
    roundTrip(doc, { type: 'addDimension', drawingId: D, sheetId: S, dimension: lost });
  });
});

describe('what drawings and exploded views block', () => {
  it('deleting a feature a dimension references succeeds', () => {
    const doc = drawn();
    const r = applyCommand(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteFeature', partId: PART, featureId: 'fillet#1' },
        { type: 'deleteFeature', partId: PART, featureId: 'extrude#2' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.document.drawings).toEqual(doc.drawings);
  });

  it('refuses to delete a part a view shows, unless its views go first in the same batch', () => {
    let doc = drawn();
    doc = applied(doc, { type: 'addPart', partId: 'part#2', name: 'Shelf' });
    doc = applied(doc, {
      type: 'addView',
      drawingId: D,
      sheetId: S,
      view: partView({ id: 'view#3', source: { part: 'part#2' } }),
    });
    expect(partViews(doc, 'part#2')).toEqual([`${D}/${S}/view#3`]);
    const error = refused(doc, { type: 'deletePart', partId: 'part#2' }, 'dependency');
    expect(error?.blockers).toEqual([`${D}/${S}/view#3`]);
    roundTrip(doc, {
      type: 'batch',
      commands: [
        { type: 'deleteView', drawingId: D, sheetId: S, viewId: 'view#3' },
        { type: 'deletePart', partId: 'part#2' },
      ],
    });
  });

  it('refuses to delete an assembly or an exploded view a view shows', () => {
    const doc = drawn();
    expect(assemblyViews(doc, A)).toEqual([`${D}/${S}/view#2`]);
    expect(explodedViewViews(doc, A, 'explode#1')).toEqual([`${D}/${S}/view#2`]);
    expect(refused(doc, { type: 'deleteAssembly', assemblyId: A }, 'dependency')?.blockers).toEqual(
      [`${D}/${S}/view#2`],
    );
    refused(
      doc,
      { type: 'deleteExplodedView', assemblyId: A, explodedViewId: 'explode#1' },
      'dependency',
    );
    // Showing the assembly assembled frees the exploded view.
    const assembledView = applied(doc, {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: assemblyView({ source: { assembly: A } }),
    });
    roundTrip(assembledView, {
      type: 'deleteExplodedView',
      assemblyId: A,
      explodedViewId: 'explode#1',
    });
  });

  it('refuses to delete an instance an exploded step uses, but not one a dimension measures', () => {
    const doc = drawn();
    expect(instanceDimensions(doc, A, 'inst#2')).toEqual([`${D}/${S}/dim#4`]);
    // dim#4 does not block: only the exploded step does.
    expect(
      refused(doc, { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#2' }, 'dependency')
        ?.blockers,
    ).toEqual([`${A}/explode#1`]);
    // inst#1 is used only by dim#4, so deleting it succeeds and the document still validates
    // (regen reports dim#4 lost); inst#3 is used by nothing.
    expect(instanceDimensions(doc, A, 'inst#1')).toEqual([`${D}/${S}/dim#4`]);
    const lost = roundTrip(doc, { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#1' });
    expect(lost.assemblies[0]!.instances.some((x) => x.id === 'inst#1')).toBe(false);
    expect(sheetOf(lost).dimensions.some((x) => x.id === 'dim#4')).toBe(true);
    expect(validateDocument(lost)).toEqual([]);
    roundTrip(doc, { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#3' });
    // A step reading its direction from an instance blocks it too.
    const directed = applied(doc, {
      type: 'editExplodeStep',
      assemblyId: A,
      explodedViewId: 'explode#1',
      step: step('step#1', ['inst#2'], {
        direction: { instance: 'inst#3', face: { face: 'extrude#1:cap:end' } },
      }),
    });
    refused(
      directed,
      { type: 'deleteInstance', assemblyId: A, instanceId: 'inst#3' },
      'dependency',
    );
  });

  it('does not block deleting a sheet or a drawing, whatever is on it', () => {
    const doc = drawn();
    roundTrip(doc, { type: 'deleteSheet', drawingId: D, sheetId: S });
    roundTrip(doc, { type: 'deleteDrawing', drawingId: D });
  });
});

describe('exploded view commands', () => {
  it('adds the first exploded view, and undo leaves no explodedViews key', () => {
    const doc = assembled();
    const done = roundTrip(doc, {
      type: 'addExplodedView',
      assemblyId: A,
      explodedView: explodedView(),
    });
    expect(done.assemblies[0]!.nextIds).toMatchObject({ explode: 2, step: 2 });
    const undone = apply(done, {
      type: 'deleteExplodedView',
      assemblyId: A,
      explodedViewId: 'explode#1',
    }).document;
    expect('explodedViews' in undone.assemblies[0]!).toBe(false);
  });

  it('replaces a view whole: renames it and adds, edits, removes and reorders steps', () => {
    const doc = drawn();
    const next = explodedView({
      name: 'Exploded, two steps',
      steps: [step('step#2', ['inst#3']), step('step#1', ['inst#2'], { distance: mm('50') })],
    });
    const done = roundTrip(doc, { type: 'editExplodedView', assemblyId: A, explodedView: next });
    expect(done.assemblies[0]!.nextIds.step).toBe(3);
    refused(
      doc,
      { type: 'editExplodedView', assemblyId: A, explodedView: explodedView({ id: 'explode#4' }) },
      'not-found',
    );
    const removed = applied(done, {
      type: 'editExplodedView',
      assemblyId: A,
      explodedView: explodedView(),
    });
    // step#2 was handed out: it can never come back through an edit.
    refused(removed, { type: 'editExplodedView', assemblyId: A, explodedView: next }, 'id-reused');
  });

  it('edits steps one at a time with exact inverses', () => {
    const doc = drawn();
    const ids = { assemblyId: A, explodedViewId: 'explode#1' };
    roundTrip(doc, { type: 'addExplodeStep', ...ids, step: step('step#2', ['inst#3']), index: 0 });
    roundTrip(doc, { type: 'editExplodeStep', ...ids, step: step('step#1', ['inst#2', 'inst#3']) });
    roundTrip(doc, { type: 'deleteExplodeStep', ...ids, stepId: 'step#1' });
    refused(doc, { type: 'addExplodeStep', ...ids, step: step('step#1', ['inst#3']) }, 'duplicate');
    refused(
      doc,
      { type: 'addExplodeStep', ...ids, step: step('step#2', ['inst#9']) },
      'dependency',
    );
    refused(
      doc,
      { type: 'deleteExplodeStep', assemblyId: A, explodedViewId: 'explode#2', stepId: 'step#1' },
      'not-found',
    );
  });

  it('never changes a solved pose', () => {
    const doc = drawn();
    const done = applied(doc, {
      type: 'editExplodeStep',
      assemblyId: A,
      explodedViewId: 'explode#1',
      step: step('step#1', ['inst#1', 'inst#2', 'inst#3'], { distance: mm('1m') }),
    });
    expect(done.assemblies[0]!.instances).toEqual(doc.assemblies[0]!.instances);
  });
});

describe('variables in drawings and exploded views', () => {
  function withVariables(): ManufaktureDocument {
    let doc = drawn();
    doc = applied(doc, { type: 'setVariable', name: 'scale', expression: mm('4') });
    doc = applied(doc, {
      type: 'batch',
      commands: [
        {
          type: 'editView',
          drawingId: D,
          sheetId: S,
          view: partView({
            scale: { paper: mm('1'), model: mm('#scale') },
            options: {
              hidden: true,
              smooth: true,
              section: { normal: [0, 1, 0], offset: mm('thickness / 2') },
            },
          }),
        },
        {
          type: 'editSheet',
          drawingId: D,
          sheetId: S,
          size: { width: mm('width * 10'), height: mm('300') },
        },
      ],
    });
    return doc;
  }

  it('lists drawings and exploded views as users, and refuses to delete what they read', () => {
    const doc = withVariables();
    expect(variableUsers(doc, 'scale')).toEqual([D]);
    expect(variableUsers(doc, 'thickness')).toContain(`${A}/explode#1`);
    expect(variableUsers(doc, 'thickness')).toContain(D);
    expect(
      refused(doc, { type: 'deleteVariable', name: 'scale' }, 'variable-in-use')?.blockers,
    ).toEqual([D]);
  });

  it('reports each use with its path', () => {
    const doc = withVariables();
    expect(variableUses(doc, 'scale')).toEqual([]);
    expect(drawingVariableUses(doc, 'scale')).toEqual([
      {
        kind: 'drawing',
        drawingId: D,
        sheetId: S,
        viewId: 'view#1',
        path: ['sheets', 0, 'views', 0, 'scale', 'model'],
        expected: 'length',
      },
    ]);
    expect(drawingVariableUses(doc, 'width').filter((u) => u.kind === 'drawing')).toEqual([
      {
        kind: 'drawing',
        drawingId: D,
        sheetId: S,
        path: ['sheets', 0, 'size', 'width'],
        expected: 'length',
      },
    ]);
    expect(drawingVariableUses(doc, 'thickness').filter((u) => u.kind === 'explodedView')).toEqual([
      {
        kind: 'explodedView',
        assemblyId: A,
        explodedViewId: 'explode#1',
        stepId: 'step#1',
        path: ['steps', 0, 'distance'],
        expected: 'length',
      },
    ]);
    expect(drawingExpressions(doc.drawings![0]!).map((s) => s.path)).toEqual([
      ['sheets', 0, 'size', 'width'],
      ['sheets', 0, 'size', 'height'],
      ['sheets', 0, 'views', 0, 'scale', 'paper'],
      ['sheets', 0, 'views', 0, 'scale', 'model'],
      ['sheets', 0, 'views', 0, 'options', 'section', 'offset'],
      ['sheets', 0, 'views', 1, 'scale', 'paper'],
      ['sheets', 0, 'views', 1, 'scale', 'model'],
    ]);
  });

  it('renames a variable everywhere a drawing or an exploded view reads it, as one undo step', () => {
    const doc = withVariables();
    const rename = unwrap(renameVariable(doc, 'thickness', 't'));
    const renamed = roundTrip(doc, rename);
    expect(renamed.assemblies[0]!.explodedViews![0]!.steps[0]!.distance.source).toBe('#t * 4');
    expect(sheetOf(renamed).views[0]!.options.section!.offset.source).toBe('#t / 2');
    const width = applied(doc, unwrap(renameVariable(doc, 'width', 'w')));
    expect(sheetOf(width).size).toEqual({ width: mm('#w * 10'), height: mm('300') });
  });

  it('inlines a variable a drawing reads', () => {
    const doc = withVariables();
    const inlined = applied(doc, unwrap(inlineVariable(doc, 'scale', '4')));
    expect(sheetOf(inlined).views[0]!.scale.model.source).toBe('4');
    expect(inlined.variables.some((v) => v.name === 'scale')).toBe(false);
  });
});

describe('diffDocuments: drawings and exploded views', () => {
  it('a drawing-only edit changes no part and no assembly', () => {
    const doc = drawn();
    for (const command of [
      { type: 'moveView', drawingId: D, sheetId: S, viewId: 'view#1', position: [1, 2] },
      { type: 'deleteDimension', drawingId: D, sheetId: S, dimensionId: 'dim#4' },
      { type: 'renameDrawing', drawingId: D, name: 'Other' },
      { type: 'addDrawing', drawing: createDrawing('drawing#2', 'Two') },
    ] satisfies Command[]) {
      const change = diffDocuments(doc, applied(doc, command));
      expect(change.empty).toBe(false);
      expect(change.parts).toEqual([]);
      expect(change.assemblies).toEqual([]);
      expect(change.printChanged).toBe(false);
      expect(change.drawingChanged).toBe(true);
    }
    const moved = diffDocuments(
      doc,
      applied(doc, {
        type: 'moveView',
        drawingId: D,
        sheetId: S,
        viewId: 'view#1',
        position: [1, 2],
      }),
    );
    expect(moved.drawings).toEqual({
      drawings: { added: [], removed: [], changed: [D] },
      reordered: false,
    });
    const added = diffDocuments(
      doc,
      applied(doc, { type: 'addDrawing', drawing: createDrawing('drawing#2', 'Two') }),
    );
    expect(added.drawings.drawings).toEqual({ added: ['drawing#2'], removed: [], changed: [] });
  });

  it('a model edit reports no drawing change', () => {
    const doc = drawn();
    const change = diffDocuments(
      doc,
      applied(doc, {
        type: 'suppressFeature',
        partId: PART,
        featureId: 'fillet#1',
        suppressed: true,
      }),
    );
    expect(change.drawingChanged).toBe(false);
    expect(change.drawings.drawings).toEqual({ added: [], removed: [], changed: [] });
  });

  it('a variable a view scale reads marks the drawing changed', () => {
    const doc = applied(drawn(), {
      type: 'editView',
      drawingId: D,
      sheetId: S,
      view: partView({ scale: { paper: mm('1'), model: mm('width / 10') } }),
    });
    const change = diffDocuments(
      doc,
      applied(doc, { type: 'setVariable', name: 'width', expression: mm('50') }),
    );
    expect(change.drawings.drawings.changed).toEqual([D]);
  });

  it('an exploded view edit is an assembly change with nothing to solve or regenerate', () => {
    const doc = drawn();
    const next = applied(doc, {
      type: 'editExplodeStep',
      assemblyId: A,
      explodedViewId: 'explode#1',
      step: step('step#1', ['inst#2'], { distance: mm('80') }),
    });
    const change = diffDocuments(doc, next);
    expect(change.parts).toEqual([]);
    expect(change.drawingChanged).toBe(false);
    expect(change.assemblies).toEqual([
      expect.objectContaining({
        assemblyId: A,
        explodedViews: { added: [], removed: [], changed: ['explode#1'] },
        explodedViewsReordered: false,
        posed: [],
        posesOnly: false,
        explodedOnly: true,
      }),
    ]);
    const thicker = diffDocuments(
      doc,
      applied(doc, { type: 'setVariable', name: 'thickness', expression: mm('8mm') }),
    );
    expect(thicker.assemblies[0]!.explodedViews.changed).toEqual(['explode#1']);
  });
});

describe('drawings in the file', () => {
  it('round trips through serialize and deserialize, with every counter record sorted', () => {
    const doc = drawn();
    const shuffled = clone(doc);
    shuffled.drawings![0]!.nextIds = { note: 2, dim: 5, view: 3, sheet: 2 };
    const text = serialize(shuffled);
    expect(text).toBe(serialize(doc));
    const loaded = unwrap(deserialize(text));
    expect(loaded.migrated).toBe(false);
    expect(loaded.document).toEqual(doc);
    expect(serialize(loaded.document)).toBe(text);
    const json = JSON.parse(text) as { drawings: { nextIds: object }[] };
    expect(Object.keys(json.drawings[0]!.nextIds)).toEqual(['dim', 'note', 'sheet', 'view']);
    // Key order: drawings after fonts, before nextIds.
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys.indexOf('drawings')).toBe(keys.indexOf('fonts') + 1);
  });

  it('never modifies the value it loads', () => {
    const value = deepFreeze(JSON.parse(serialize(drawn())) as unknown);
    expect(unwrap(parseDocument(value)).document).toEqual(drawn());
  });

  it('refuses a loaded drawing whose view shows a part that is not there', () => {
    const json = JSON.parse(serialize(drawn())) as { drawings: Drawing[] };
    json.drawings[0]!.sheets[0]!.views[0]!.source = { part: 'part#5' };
    const r = parseDocument(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('dependency');
  });

  it('keeps the higher drawing counters in a restored document', () => {
    const past = drawn();
    const current = applied(past, {
      type: 'addNote',
      drawingId: D,
      sheetId: S,
      note: note({ id: 'note#7' }),
    });
    const restored = restoredDocument(current, past);
    expect(restored.drawings![0]!.nextIds.note).toBe(8);
    expect(restored.drawings![0]!.sheets).toEqual(past.drawings![0]!.sheets);
    expect(restoredDocument(current, assembled()).drawings).toBeUndefined();
  });

  it('is one undo step in the store', () => {
    const store = unwrap(DocumentStore.create(drawn()));
    const change = unwrap(store.execute({ type: 'deleteDrawing', drawingId: D }));
    expect(change.drawings.drawings.removed).toEqual([D]);
    expect(store.document.drawings).toBeUndefined();
    unwrap(store.undo());
    expect(store.document).toEqual(drawn());
  });

  it('lists the ids a sheet owns', () => {
    expect(sheetIds(sheet())).toEqual([
      S,
      'view#1',
      'view#2',
      'dim#1',
      'dim#2',
      'dim#3',
      'dim#4',
      'note#1',
    ]);
  });
});
