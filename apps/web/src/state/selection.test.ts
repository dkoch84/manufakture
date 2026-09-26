import { describe, expect, it } from 'vitest';
import {
  createSelectionStore,
  geometryRef,
  isGeometryRef,
  itemKey,
  sameItem,
  selectModeFor,
  type SelectableItem,
} from './selection';

const top = geometryRef('face', 'body1', 'extrude#1/cap-end');
const side = geometryRef('face', 'body1', 'extrude#1/side:line#2');
const edge = geometryRef('edge', 'body1', 'extrude#1/cap-end|side:line#2', { fragile: true });

describe('geometry refs', () => {
  it('are identified by body and name, never by an index', () => {
    expect(top.id).toBe('body1/extrude#1/cap-end');
    expect(itemKey(top)).toBe('face:body1/extrude#1/cap-end');
    expect(top.fragile).toBe(false);
    expect(top.placeholder).toBe(false);
    expect(edge.fragile).toBe(true);
  });

  it('compare by kind and id', () => {
    expect(sameItem(top, geometryRef('face', 'body1', 'extrude#1/cap-end'))).toBe(true);
    expect(sameItem(top, side)).toBe(false);
    expect(sameItem(null, null)).toBe(true);
    expect(sameItem(top, null)).toBe(false);
    // Same id, different kind: different items.
    expect(sameItem(top, { kind: 'sketch-entity', id: top.id })).toBe(false);
  });

  it('tells geometry from other selectable kinds', () => {
    expect(isGeometryRef(top)).toBe(true);
    expect(isGeometryRef({ kind: 'feature', id: 'extrude#1' })).toBe(false);
  });
});

describe('click modes', () => {
  it('maps modifiers: plain replaces, shift adds, ctrl or cmd toggles', () => {
    const none = { shiftKey: false, ctrlKey: false, metaKey: false };
    expect(selectModeFor(none)).toBe('replace');
    expect(selectModeFor({ ...none, shiftKey: true })).toBe('add');
    expect(selectModeFor({ ...none, ctrlKey: true })).toBe('toggle');
    expect(selectModeFor({ ...none, metaKey: true })).toBe('toggle');
    expect(selectModeFor({ ...none, shiftKey: true, ctrlKey: true })).toBe('toggle');
  });
});

describe('selection store', () => {
  it('replaces the selection on a plain click', () => {
    const s = createSelectionStore();
    s.getState().click(top, 'replace');
    s.getState().click(side, 'replace');
    expect(s.getState().selected).toEqual([side]);
  });

  it('adds with shift, keeping order and ignoring duplicates', () => {
    const s = createSelectionStore();
    s.getState().click(top, 'replace');
    s.getState().click(edge, 'add');
    s.getState().click(top, 'add');
    expect(s.getState().selected).toEqual([top, edge]);
  });

  it('toggles with ctrl', () => {
    const s = createSelectionStore();
    s.getState().click(top, 'toggle');
    s.getState().click(side, 'toggle');
    s.getState().click(top, 'toggle');
    expect(s.getState().selected).toEqual([side]);
  });

  it('clears on a plain click on empty space, but not with modifiers', () => {
    const s = createSelectionStore();
    s.getState().click(top, 'replace');
    s.getState().click(null, 'add');
    s.getState().click(null, 'toggle');
    expect(s.getState().selected).toHaveLength(1);
    s.getState().click(null, 'replace');
    expect(s.getState().selected).toHaveLength(0);
  });

  it('does not notify subscribers when nothing changes', () => {
    const s = createSelectionStore();
    s.getState().click(top, 'replace');
    let calls = 0;
    const unsubscribe = s.subscribe(() => calls++);
    s.getState().click(top, 'replace');
    s.getState().setHovered(null);
    s.getState().clear();
    s.getState().clear();
    unsubscribe();
    expect(calls).toBe(1);
  });

  it('tracks the hovered item and ignores repeated hovers of the same item', () => {
    const s = createSelectionStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.getState().setHovered(top);
    s.getState().setHovered(geometryRef('face', 'body1', 'extrude#1/cap-end'));
    expect(calls).toBe(1);
    expect(s.getState().hovered).toEqual(top);
  });

  it('applies the selection filter to clicks and hovers', () => {
    const s = createSelectionStore();
    s.getState().setHovered(edge);
    s.getState().setKindEnabled('edge', false);
    expect(s.getState().hovered).toBeNull();
    expect(s.getState().isKindEnabled('edge')).toBe(false);
    s.getState().click(edge, 'replace');
    expect(s.getState().selected).toHaveLength(0);
    s.getState().setHovered(edge);
    expect(s.getState().hovered).toBeNull();
    s.getState().setKindEnabled('edge', true);
    s.getState().click(edge, 'replace');
    expect(s.getState().selected).toEqual([edge]);
  });

  it('keeps existing selections when their kind is filtered out', () => {
    const s = createSelectionStore();
    s.getState().click(edge, 'replace');
    s.getState().setKindEnabled('edge', false);
    expect(s.getState().selected).toEqual([edge]);
  });

  it('treats unknown kinds as enabled, so other tools can add kinds', () => {
    const s = createSelectionStore();
    const entity: SelectableItem = { kind: 'sketch-entity', id: 'sketch#1/line#3' };
    s.getState().click(entity, 'add');
    s.getState().click(top, 'add');
    expect(s.getState().selected).toEqual([entity, top]);
    s.getState().setKindEnabled('sketch-entity', false);
    s.getState().click(entity, 'toggle');
    expect(s.getState().selected).toEqual([entity, top]);
  });

  it('selects many at once, deduplicated and filtered', () => {
    const s = createSelectionStore();
    s.getState().setKindEnabled('vertex', false);
    s.getState().select([top, top, geometryRef('vertex', 'body1', 'v'), edge]);
    expect(s.getState().selected).toEqual([top, edge]);
    expect(s.getState().isSelected(edge)).toBe(true);
    s.getState().deselect(edge);
    expect(s.getState().isSelected(edge)).toBe(false);
  });

  it('prunes items that no longer exist, including the hover', () => {
    const s = createSelectionStore();
    s.getState().select([top, side, edge]);
    s.getState().setHovered(side);
    s.getState().prune((i) => i.id !== side.id);
    expect(s.getState().selected).toEqual([top, edge]);
    expect(s.getState().hovered).toBeNull();
  });
});
