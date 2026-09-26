import { createDocument, DocumentStore, type ManufaktureDocument } from '@manufakture/core';
import { XZ_PLANE } from '@manufakture/sketch';
import type { SketchInput } from '@manufakture/sketch/model';
import { describe, expect, it } from 'vitest';
import { commitSketch, sketchFeatures, startSketch } from './commit';

const RECT: SketchInput = {
  entities: [
    { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [4, 0] },
    { id: 'e2', kind: 'line', construction: false, start: [4, 0], end: [4, 3] },
  ],
  constraints: [
    {
      id: 'k1',
      kind: 'coincident',
      a: { entity: 'e1', at: 'end' },
      b: { entity: 'e2', at: 'start' },
    },
    {
      id: 'k2',
      kind: 'distance',
      a: { entity: 'e1', at: 'start' },
      b: { entity: 'e1', at: 'end' },
      value: { source: '4', lengthUnit: 'mm', angleUnit: 'deg' },
    },
  ],
};

function store(doc: ManufaktureDocument = createDocument({ id: 'd', name: 'D' })) {
  const s = DocumentStore.create(doc);
  if (!s.ok) throw new Error(s.error.message);
  return s.value;
}

function commitNew(s: DocumentStore, sketch = RECT) {
  const start = startSketch(s.document, { kind: 'new', placement: XZ_PLANE });
  if (!start.ok) throw new Error(start.message);
  const c = commitSketch(s.document, start.value.partId, start.value.source, sketch)!;
  const r = s.execute(c.command, c.label);
  if (!r.ok) throw new Error(r.error.message);
  return { start: start.value, commit: c };
}

describe('starting a sketch', () => {
  it('names a new sketch after the next id and hands out the part counters', () => {
    const s = store();
    const r = startSketch(s.document, { kind: 'new', placement: XZ_PLANE });
    expect(r).toMatchObject({
      ok: true,
      value: {
        partId: 'part#1',
        source: {
          featureId: 'sketch#1',
          isNew: true,
          name: 'Sketch 1',
          placement: XZ_PLANE,
          entities: [],
          nextEntity: 1,
          nextConstraint: 1,
        },
      },
    });
  });

  it('edits an existing sketch with fresh ids past everything allocated', () => {
    const s = store();
    commitNew(s);
    const r = startSketch(s.document, { kind: 'edit', featureId: 'sketch#1' });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.source).toMatchObject({
      featureId: 'sketch#1',
      isNew: false,
      name: 'Sketch 1',
      nextEntity: 3,
      nextConstraint: 3,
    });
    expect(r.value.source.entities).toEqual(RECT.entities);
    expect(startSketch(s.document, { kind: 'edit', featureId: 'sketch#9' })).toEqual({
      ok: false,
      message: 'There is no sketch sketch#9.',
    });
  });

  it('hands the document variables to the session, evaluated', () => {
    const s = store();
    s.execute({
      type: 'setVariable',
      name: 't',
      expression: { source: '2 in', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const r = startSketch(s.document, { kind: 'new', placement: XZ_PLANE });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.source.variables.t?.value).toBeCloseTo(50.8, 12);
  });
});

describe('committing a sketch', () => {
  it('adds a new sketch as one undoable command on its plane', () => {
    const s = store();
    const { commit } = commitNew(s);
    expect(commit.label).toBe('Add Sketch 1');
    const [f] = sketchFeatures(s.document);
    expect(f).toMatchObject({
      id: 'sketch#1',
      kind: 'sketch',
      plane: { type: 'plane', ...XZ_PLANE },
      entities: RECT.entities,
      constraints: RECT.constraints,
    });
    expect(s.document.parts[0]!.nextIds).toMatchObject({ sketch: 2, e: 3, k: 3 });
    s.undo();
    expect(sketchFeatures(s.document)).toEqual([]);
    s.redo();
    expect(sketchFeatures(s.document)).toHaveLength(1);
  });

  it('edits an existing sketch, and does nothing when nothing changed', () => {
    const s = store();
    commitNew(s);
    const r = startSketch(s.document, { kind: 'edit', featureId: 'sketch#1' });
    if (!r.ok) throw new Error(r.message);
    const { partId, source } = r.value;
    expect(commitSketch(s.document, partId, source, RECT)).toBeNull();
    const edited: SketchInput = {
      entities: [
        ...RECT.entities,
        { id: 'e3', kind: 'circle', construction: true, center: [1, 1], radius: 1 },
      ],
      constraints: RECT.constraints,
    };
    const c = commitSketch(s.document, partId, source, edited)!;
    expect(c.label).toBe('Edit Sketch 1');
    expect(s.execute(c.command, c.label).ok).toBe(true);
    expect(sketchFeatures(s.document)[0]!.entities).toHaveLength(3);
    s.undo();
    expect(sketchFeatures(s.document)[0]!.entities).toHaveLength(2);
  });

  it('is refused by the document when an id was handed out before', () => {
    const s = store();
    commitNew(s);
    // A second new sketch reusing e1 would reuse a permanent id.
    const r = startSketch(s.document, { kind: 'new', placement: XZ_PLANE });
    if (!r.ok) throw new Error(r.message);
    const c = commitSketch(s.document, r.value.partId, r.value.source, RECT)!;
    const result = s.execute(c.command, c.label);
    expect(result.ok).toBe(false);
  });
});
