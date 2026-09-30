import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FilletFeature, ExtrudeFeature } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../model/demo';
import { twoBodyDocument, twoBodyModel } from '../model/twoBodies.test-fixture';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import {
  createSelectionStore,
  featureItem,
  geometryRef,
  type GeometryRef,
} from '../state/selection';
import { FeatureDialog, type DialogRequest } from './FeatureDialog';
import { refLabel, type RefKind } from './forms';
import type { PickOutcome } from './references';

/** Resolves an edge `A|B` to the reference of faces A and B, and a face to its name. */
async function fakeResolve(geo: GeometryRef, accepts: readonly RefKind[]): Promise<PickOutcome> {
  if (geo.kind === 'vertex' || !accepts.includes(geo.kind)) {
    return { ok: false, message: `This takes ${accepts.join(' or ')}s.` };
  }
  const ref = geo.kind === 'face' ? { face: geo.name } : { faces: geo.name.split('|').sort() };
  return { ok: true, item: { id: null, ref, label: refLabel(ref) } };
}

function setup(
  request: DialogRequest,
  options: { preselect?: GeometryRef[]; features?: string[] } = {},
) {
  const documents = createDocumentStore(demoDocument());
  const model = createModelStore();
  const selection = createSelectionStore();
  if (options.preselect) selection.getState().select(options.preselect);
  if (options.features) selection.getState().select(options.features.map(featureItem));
  const onClose = vi.fn();
  const resolve = vi.fn(fakeResolve);
  render(
    <FeatureDialog
      request={request}
      documents={documents}
      model={model}
      selection={selection}
      resolve={resolve}
      onClose={onClose}
    />,
  );
  const features = () => documents.getState().document.parts[0]!.features;
  return { documents, model, selection, onClose, resolve, features };
}

const edgeA = geometryRef('edge', 'part#1', 'extrude#1:cap:end|extrude#1:side:e1');
const edgeB = geometryRef('edge', 'part#1', 'extrude#1:cap:end|extrude#1:side:e2');

describe('the fillet dialog', () => {
  it('takes pre-selected and picked edges, and adds the feature as one undo step', async () => {
    const t = setup({ kind: 'fillet' }, { preselect: [edgeA] });
    expect(screen.getByRole('dialog', { name: 'Fillet: Fillet 2' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ref-edges').textContent).toContain('side:e1'));
    act(() => t.selection.getState().click(edgeB, 'replace'));
    await waitFor(() => expect(screen.getByTestId('ref-edges').textContent).toContain('side:e2'));
    // A face is not an edge.
    act(() =>
      t.selection.getState().click(geometryRef('face', 'part#1', 'extrude#1:cap:end'), 'replace'),
    );
    await waitFor(() => expect(screen.getByTestId('pick-message').textContent).toContain('edge'));

    fireEvent.change(screen.getByTestId('field-radius'), { target: { value: '1.5 + 1' } });
    expect(screen.getByTestId('field-radius-note').textContent).toBe('= 2.50 mm');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).toHaveBeenCalled();
    const fillet = t.features().at(-1) as FilletFeature;
    expect(fillet).toMatchObject({
      id: 'fillet#2',
      radius: { source: '1.5 + 1' },
      edges: [
        { id: 'r13', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e1'] } },
        { id: 'r14', ref: { faces: ['extrude#1:cap:end', 'extrude#1:side:e2'] } },
      ],
    });
    expect(t.documents.getState().undoLabel).toBe('Add Fillet 2');
  });

  it('shows what is wrong instead of applying, and removes a pick', async () => {
    const t = setup({ kind: 'fillet' });
    fireEvent.change(screen.getByTestId('field-radius'), { target: { value: '3deg' } });
    expect(screen.getByTestId('field-radius-note').textContent).toContain('length');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('ref-edges').textContent).toContain('Pick one in the viewport.');
    act(() => t.selection.getState().click(edgeA, 'replace'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Remove/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Remove/ }));
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(t.features()).toHaveLength(5);
  });

  it('edits an existing fillet, asking for a lost edge again in place', async () => {
    const t = setup({ kind: 'fillet', featureId: 'fillet#1', repick: 'r2' });
    // Where the lost edge r2 (cap:start | side:e1) went after an edit that split the side.
    const edgeC = geometryRef('edge', 'part#1', 'extrude#1:cap:start|extrude#1:side:e1#1');
    const field = screen.getByTestId('ref-edges');
    expect(within(field).getByText(/not found: pick it again/)).toBeTruthy();
    act(() => t.selection.getState().click(edgeC, 'replace'));
    await waitFor(() => expect(within(field).queryByText(/not found/)).toBeNull());
    fireEvent.change(screen.getByTestId('field-radius'), { target: { value: '2' } });
    fireEvent.keyDown(screen.getByTestId('field-radius'), { key: 'Enter' });
    const fillet = t.features()[2] as FilletFeature;
    // The replacement keeps the reference id; nothing else moved.
    expect(fillet.edges[1]).toEqual({
      id: 'r2',
      ref: { faces: ['extrude#1:cap:start', 'extrude#1:side:e1#1'] },
    });
    expect(fillet.edges).toHaveLength(12);
    expect(t.documents.getState().undoLabel).toBe('Edit Fillet 1');
  });

  it('closes on Escape and Cancel without changing the document', () => {
    const t = setup({ kind: 'fillet' });
    fireEvent.keyDown(screen.getByTestId('field-radius'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(t.onClose).toHaveBeenCalledTimes(2);
    expect(t.documents.getState().canUndo).toBe(false);
  });
});

describe('dialog focus', () => {
  it('moves focus into the dialog, closes on Escape from there, and gives focus back', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const documents = createDocumentStore(demoDocument());
    const onClose = vi.fn();
    const view = render(
      <FeatureDialog
        request={{ kind: 'fillet' }}
        documents={documents}
        model={createModelStore()}
        selection={createSelectionStore()}
        resolve={vi.fn(fakeResolve)}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Fillet: Fillet 2' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('the extrude dialog', () => {
  it('extrudes the sketch selected in the tree, with the operation and extent chosen', () => {
    const t = setup({ kind: 'extrude' }, { features: ['sketch#2'] });
    expect((screen.getByTestId('field-sketch') as HTMLSelectElement).value).toBe('sketch#2');
    expect((screen.getByTestId('field-operation') as HTMLSelectElement).value).toBe('add');
    fireEvent.change(screen.getByTestId('field-operation'), { target: { value: 'cut' } });
    fireEvent.change(screen.getByTestId('field-extent'), { target: { value: 'throughAll' } });
    expect(screen.queryByTestId('field-distance')).toBeNull();
    fireEvent.click(screen.getByLabelText('Opposite direction'));
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      id: 'extrude#3',
      kind: 'extrude',
      profile: { sketch: 'sketch#2' },
      operation: 'cut',
      extent: { type: 'throughAll' },
      reverse: true,
    } satisfies Partial<ExtrudeFeature>);
  });

  it('extrudes up to a picked face', async () => {
    const t = setup({ kind: 'extrude' }, { features: ['sketch#2'] });
    fireEvent.change(screen.getByTestId('field-extent'), { target: { value: 'upToFace' } });
    act(() =>
      t.selection.getState().click(geometryRef('face', 'part#1', 'extrude#1:cap:end'), 'replace'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('ref-upToFace').textContent).toContain('extrude#1:cap:end'),
    );
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      extent: { type: 'upToFace', face: { ref: { face: 'extrude#1:cap:end' } } },
    });
  });
});

describe('the hole dialog', () => {
  it('fills the diameter from the standard size and fit', () => {
    setup({ kind: 'hole' }, { features: ['sketch#2'] });
    const diameter = screen.getByTestId('field-diameter') as HTMLInputElement;
    expect(diameter.value).toBe('5.5');
    fireEvent.change(screen.getByTestId('field-standard'), { target: { value: 'M8' } });
    expect(diameter.value).toBe('9');
    fireEvent.change(screen.getByTestId('field-fit'), { target: { value: 'close' } });
    expect(diameter.value).toBe('8.4');
    fireEvent.change(screen.getByTestId('field-head'), { target: { value: 'counterbore' } });
    expect((screen.getByTestId('field-headDepth') as HTMLInputElement).value).not.toBe('');
    // Sketch 2 has a circle but no points.
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(screen.getByTestId('field-points').textContent).toContain('has no points');
  });
});

describe('the pattern and mirror dialogs', () => {
  it('pattern the selected feature along a picked edge', async () => {
    const t = setup({ kind: 'pattern' }, { features: ['extrude#2'] });
    act(() => t.selection.getState().click(edgeA, 'replace'));
    await waitFor(() => expect(screen.getByTestId('ref-direction').textContent).toContain('e1'));
    fireEvent.change(screen.getByTestId('field-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      kind: 'pattern',
      features: ['extrude#2'],
      layout: { type: 'linear', count: { source: '2' } },
    });
  });

  it('mirror the body about a picked face', async () => {
    const t = setup({ kind: 'mirror' });
    fireEvent.change(screen.getByTestId('field-source'), { target: { value: 'body' } });
    act(() =>
      t.selection.getState().click(geometryRef('face', 'part#1', 'extrude#1:side:e2'), 'replace'),
    );
    await waitFor(() => expect(screen.getByTestId('ref-plane').textContent).toContain('side:e2'));
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({ kind: 'mirror', body: true, features: [] });
  });
});

describe('the Bodies scope field', () => {
  function twoBodies(request: DialogRequest) {
    const documents = createDocumentStore(twoBodyDocument());
    const model = createModelStore();
    model.setState({ parts: [twoBodyModel()] });
    const selection = createSelectionStore();
    render(
      <FeatureDialog
        request={request}
        documents={documents}
        model={model}
        selection={selection}
        resolve={vi.fn(fakeResolve)}
        onClose={vi.fn()}
      />,
    );
    return () => documents.getState().document.parts[0]!.features;
  }

  it('acts on every body by default, or on the bodies chosen', () => {
    const features = twoBodies({ kind: 'extrude' });
    expect(screen.getByTestId<HTMLSelectElement>('field-operation').value).toBe('add');
    const all = screen.getByRole<HTMLInputElement>('checkbox', { name: 'All bodies' });
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Body 1' }));
    fireEvent.change(screen.getByTestId('field-operation'), { target: { value: 'cut' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(features().at(-1)).toMatchObject({
      kind: 'extrude',
      operation: 'cut',
      scope: ['extrude#3'],
    });
  });

  it('is not offered for a new body', () => {
    twoBodies({ kind: 'extrude' });
    fireEvent.change(screen.getByTestId('field-operation'), { target: { value: 'new' } });
    expect(screen.queryByTestId('field-scope')).toBeNull();
  });

  it('is not offered with one body only', () => {
    setup({ kind: 'hole' });
    expect(screen.queryByTestId('field-scope')).toBeNull();
  });
});
