import { fireEvent, render, screen } from '@testing-library/react';
import type { ExtensionFeature } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore, featureItem } from '../../state/selection';
import { JointDialog } from './JointDialog';
import { jointsDocument, jointsModel, SCENES } from './joints.test-fixture';

type Scene = (typeof SCENES)[keyof typeof SCENES];

function setup(
  options: { scene?: Scene; featureId?: string; select?: string[] } = {},
  documents = createDocumentStore(jointsDocument()),
) {
  const model = jointsModel(options.scene ?? SCENES.dado);
  const selection = createSelectionStore();
  selection.getState().select((options.select ?? ['extension#1', 'extension#2']).map(featureItem));
  const onClose = vi.fn();
  const onPreview = vi.fn();
  const view = render(
    <JointDialog
      featureId={options.featureId}
      documents={documents}
      model={model}
      selection={selection}
      onPreview={onPreview}
      onClose={onClose}
    />,
  );
  const features = () => documents.getState().document.parts[0]!.features;
  return { documents, onClose, onPreview, features, view };
}

const kind = (value: string) =>
  fireEvent.change(screen.getByTestId('field-kind'), { target: { value } });
const text = (id: string) => screen.getByTestId(id).textContent;

describe('the joint dialog', () => {
  it('makes a dado: shows which board is cut where, previews the groove, one undo step', () => {
    const t = setup();
    expect(screen.getByRole('dialog', { name: 'Joint: New joint' })).toBeTruthy();
    expect((screen.getByTestId('field-a') as HTMLSelectElement).value).toBe('extension#1');
    expect((screen.getByTestId('field-b') as HTMLSelectElement).value).toBe('extension#2');
    expect(text('joint-cuts-a')).toBe('Cut from Side (A): a groove.');
    expect(text('joint-cuts-b')).toBe('Cut from Shelf (B): nothing.');
    expect(text('joint-sizes')).toBe('Groove 18.00 mm wide and 6.00 mm deep, 300.00 mm long.');
    // The depth is the overlap: the dialog says how to change it.
    expect(text('joint-depth-note')).toContain('move or resize Shelf');
    // The groove's twelve edges, solid (it is cut from A).
    expect(t.onPreview.mock.lastCall![0]).toHaveLength(6);

    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).toHaveBeenCalled();
    expect(t.features().at(-1)).toMatchObject({
      id: 'extension#4',
      name: 'Dado 4',
      params: { kind: 'dado', a: 'extension#1', b: 'extension#2' },
    });
    t.documents.getState().undo();
    expect(t.features()).toHaveLength(4);
    t.view.unmount();
    expect(t.onPreview).toHaveBeenLastCalledWith([]);
  });

  it('makes a stopped dado, which needs its stop, and notches the shelf', () => {
    const t = setup();
    fireEvent.change(screen.getByTestId('field-stopped'), { target: { value: 'low' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('needs the stop');
    fireEvent.change(screen.getByTestId('field-stop'), { target: { value: '20' } });
    expect(text('joint-cuts-b')).toBe('Cut from Shelf (B): a notch at a stop.');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      params: { kind: 'dado', stopped: 'low' },
      expressions: { stop: { source: '20' } },
    });
  });

  it('shows the rule-of-thumb warning for a deep dado, and still applies it', () => {
    const t = setup({ scene: SCENES.deep });
    expect(text('joint-warnings')).toMatch(/Rule of thumb, not engineering: .*Side \(A\)/);
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).toHaveBeenCalled();
  });

  it('makes a rabbet at the end of the side, with a clearance and no stop', () => {
    setup({ scene: SCENES.rabbet });
    kind('rabbet');
    expect(text('joint-cuts-a')).toBe('Cut from Side (A): a groove.');
    expect(screen.queryByTestId('field-stop')).toBeNull();
    expect(screen.getByTestId('field-clearance')).toBeTruthy();
  });

  it('refuses the wrong kind readably and applies nothing', () => {
    const t = setup();
    kind('rabbet');
    expect(text('joint-refusal')).toMatch(/^This joint cannot be built\. /);
    expect(screen.getByTestId('field-kind').getAttribute('aria-invalid')).toBe('true');
    expect(t.onPreview.mock.lastCall![0]).toEqual([]);
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.onClose).not.toHaveBeenCalled();
    expect(t.features()).toHaveLength(4);
    expect(screen.getByRole('alert').textContent).toContain('cannot be built');
  });

  it('makes a mortise and tenon: the tenon on B, the mortise in A, rounded ends', () => {
    const t = setup({ scene: SCENES.tenon });
    kind('mortise-tenon');
    expect(text('joint-cuts-a')).toBe('Cut from Side (A): a mortise.');
    expect(text('joint-cuts-b')).toContain('2 tenon cheeks');
    expect(text('joint-sizes')).toBe(
      'Tenon 6.00 mm thick, 68.00 mm wide and 25.00 mm long; mortise 25.00 mm deep.',
    );
    // B's tools are dashed: more polylines than the boxes' edges.
    expect(t.onPreview.mock.lastCall![0].length).toBeGreaterThan(6 * 3);
    fireEvent.change(screen.getByTestId('field-ends'), { target: { value: 'rounded' } });
    expect(text('joint-cuts-a')).toContain('rounded mortise end');
    expect(text('joint-cuts-b')).toContain('Added to it: 2 rounded tenon edges.');
    fireEvent.change(screen.getByTestId('field-thickness'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({
      name: 'Mortise and tenon 4',
      params: { kind: 'mortise-tenon', ends: 'rounded' },
      expressions: { thickness: { source: '8' } },
    });
  });

  it('makes dowels and lists the hardware', () => {
    const t = setup({ scene: SCENES.touching });
    kind('dowel');
    expect(text('joint-hardware')).toBe('Hardware: 4 dowels, 8.00 mm x 32.00 mm.');
    expect(text('joint-depth-note')).toBe('Shelf must touch Side without overlapping it.');
    fireEvent.change(screen.getByTestId('field-count'), { target: { value: '3' } });
    expect(text('joint-hardware')).toBe('Hardware: 3 dowels, 8.00 mm x 32.00 mm.');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({ expressions: { count: { source: '3' } } });
  });

  it('makes pocket screws in B only, with the screws as hardware', () => {
    const t = setup({ scene: SCENES.touching });
    kind('pocket-screw');
    expect(text('joint-cuts-a')).toBe('Cut from Side (A): nothing.');
    expect(text('joint-cuts-b')).toBe('Cut from Shelf (B): 3 pocket holes.');
    expect(text('joint-hardware')).toBe('Hardware: 3 pocket screws, 31.75 mm long.');
    fireEvent.change(screen.getByTestId('field-face'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({ params: { kind: 'pocket-screw', face: 'high' } });
  });

  it('makes a box joint, choosing which board has the first finger', () => {
    const t = setup({ scene: SCENES.box });
    kind('box-joint');
    expect(text('joint-sizes')).toBe('6 fingers of 16.67 mm.');
    expect(text('joint-cuts-a')).toBe('Cut from Side (A): 3 finger slots.');
    fireEvent.change(screen.getByTestId('field-start'), { target: { value: 'b' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(t.features().at(-1)).toMatchObject({ params: { kind: 'box-joint', start: 'b' } });
  });

  it('refuses a splayed board in the boards names, marking B', () => {
    setup({ scene: SCENES.splayed });
    expect(text('joint-refusal')).toContain('Shelf (B) is not square to Side (A) (about 30° off)');
    expect(screen.getByTestId('field-b').getAttribute('aria-invalid')).toBe('true');
  });

  it('swaps A and B', () => {
    setup();
    fireEvent.click(screen.getByTestId('joint-swap'));
    expect((screen.getByTestId('field-a') as HTMLSelectElement).value).toBe('extension#2');
    expect((screen.getByTestId('field-b') as HTMLSelectElement).value).toBe('extension#1');
  });

  it('edits a joint: its form is read back, and Escape leaves it alone', () => {
    const first = setup();
    fireEvent.click(screen.getByTestId('dialog-ok'));
    first.view.unmount();
    const t = setup({ featureId: 'extension#4' }, first.documents);
    expect(screen.getByRole('dialog', { name: 'Joint: Dado 4' })).toBeTruthy();
    expect((screen.getByTestId('field-kind') as HTMLSelectElement).value).toBe('dado');
    fireEvent.change(screen.getByTestId('field-clearance'), { target: { value: '0.5' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(t.onClose).toHaveBeenCalled();
    expect((t.features().at(-1) as ExtensionFeature).expressions).toEqual({});
  });

  it('offers no editing for a joint this build cannot read', () => {
    const documents = createDocumentStore(jointsDocument());
    const r = documents.getState().execute(
      {
        type: 'addFeature',
        partId: 'part#1',
        feature: {
          id: 'extension#4',
          kind: 'extension',
          name: 'Joint 4',
          suppressed: false,
          extension: 'wood.joint',
          schemaVersion: 9,
          dependsOn: ['extension#1', 'extension#2'],
          references: [],
          expressions: {},
          params: { kind: 'scarf', a: 'extension#1', b: 'extension#2' },
        },
      },
      'Add',
    );
    expect(r.ok).toBe(true);
    setup({ featureId: 'extension#4' }, documents);
    expect(screen.getByRole('alert').textContent).toContain('cannot be edited here');
    expect(screen.queryByTestId('dialog-ok')).toBeNull();
  });
});
