// The operation dialogs, one per kind: the fields each shows, the range checks as typed (a zero
// stepover, a negative depth), the command OK produces (one undo step), faces picked in the view
// with a planar check, sketch regions and hole features from lists, and a lost face picked again.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ManufaktureDocument } from '@manufakture/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef, type GeometryRef } from '../state/selection';
import { apply, mm, setupDocument, withTool } from './cam.test-fixture';
import { OperationDialog } from './OperationDialog';
import type { FacePick } from './picking';
import type { CamDialog, DialogOperationKind } from './state';
import type { CamGeometryResult } from '@manufakture/regen';

afterEach(cleanup);

/** Faces named `curved...` are refused like a cylinder would be; others are planar. */
async function fakeFace(geo: GeometryRef): Promise<FacePick> {
  if (geo.kind !== 'face') return { ok: false, message: 'Pick a planar face.' };
  if (geo.name.startsWith('curved'))
    return { ok: false, message: 'Pick a planar face: CAM takes flat faces only.' };
  return { ok: true, ref: { face: geo.name } };
}

function mount(
  operation: DialogOperationKind,
  options: {
    doc?: ManufaktureDocument;
    operationId?: string;
    repick?: number;
    geometry?: CamGeometryResult | null;
    /** Runs on the store before the dialog opens (an undoable edit to undo later). */
    prepare?: (documents: ReturnType<typeof createDocumentStore>) => void;
  } = {},
) {
  const documents = createDocumentStore(options.doc ?? setupDocument());
  options.prepare?.(documents);
  const selection = createSelectionStore();
  const onClose = vi.fn();
  const onApplied = vi.fn();
  const request: Extract<CamDialog, { kind: 'operation' }> = {
    kind: 'operation',
    operation,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.repick !== undefined ? { repick: options.repick } : {}),
  };
  render(
    <OperationDialog
      request={request}
      documents={documents}
      setupId="setup#1"
      selection={selection}
      resolveFace={vi.fn((geo: GeometryRef) => fakeFace(geo))}
      geometry={options.geometry ?? null}
      onClose={onClose}
      onApplied={onApplied}
    />,
  );
  const ops = () => documents.getState().document.cam.setups[0]!.operations;
  const pick = async (name: string, body = 'part#1/extrude#1') => {
    await act(async () => {
      selection.getState().select([geometryRef('face', body, name)]);
      await Promise.resolve();
    });
  };
  return { documents, selection, onClose, onApplied, ops, pick };
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const ok = () => fireEvent.click(screen.getByTestId('cam-op-ok'));

describe('the profile dialog', () => {
  it('shows its fields, takes picked planar faces and applies one undo step', async () => {
    const { documents, ops, pick, onClose, onApplied } = mount('profile');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Profile: Profile 1');
    for (const id of [
      'cam-field-side',
      'cam-field-depthMode',
      'cam-field-extra',
      'cam-field-stepdown',
      'cam-field-tabs',
      'cam-field-entry',
      'cam-field-leadIn',
      'cam-field-climb',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect((screen.getByTestId('cam-op-tool') as HTMLSelectElement).value).toBe('tool#1');
    await pick('curved-wall');
    expect(screen.getByTestId('cam-pick-message').textContent).toMatch(/planar/);
    await pick('extrude#1:cap:end');
    await waitFor(() =>
      expect(screen.getByTestId('cam-source-0').textContent).toContain('extrude#1:cap:end'),
    );
    fireEvent.click(screen.getByTestId('cam-field-tabs'));
    expect(screen.getByTestId('cam-field-tabCount')).toBeTruthy();
    type('cam-field-tabCount', '2');
    ok();
    expect(onClose).toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith('profile#1');
    expect(ops()).toHaveLength(1);
    expect(ops()[0]).toMatchObject({
      kind: 'profile',
      geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } } }],
      depth: { kind: 'through', extra: { source: '0.2 mm' } },
      tabs: { count: { source: '2' } },
    });
    expect(documents.getState().undoLabel).toBe('Add profile operation Profile 1');
    documents.getState().undo();
    expect(ops()).toEqual([]);
  });

  it('refuses no geometry and shows the range errors as typed', () => {
    const { ops } = mount('profile');
    fireEvent.change(screen.getByTestId('cam-field-depthMode'), { target: { value: 'blind' } });
    type('cam-field-depth', '-2');
    // The live check shows under the field before OK.
    expect(screen.getByTestId('cam-field-depth-note').textContent).toBe(
      'The value must be greater than zero.',
    );
    ok();
    expect(screen.getByTestId('cam-sources-error').textContent).toMatch(/at least one/);
    expect(ops()).toEqual([]);
  });
});

describe('the pocket dialog', () => {
  it('adds a sketch region and refuses a zero stepover with a visible message', () => {
    const { ops } = mount('pocket');
    fireEvent.click(screen.getByTestId('cam-add-region'));
    expect(screen.getByTestId('cam-source-0').textContent).toContain('Regions of');
    type('cam-field-stepover', '0');
    expect(screen.getByTestId('cam-field-stepover-note').textContent).toMatch(
      /fraction of the tool diameter/,
    );
    ok();
    expect(ops()).toEqual([]);
    type('cam-field-stepover', '0.4');
    type('cam-field-depth', '4 mm');
    ok();
    expect(ops()[0]).toMatchObject({
      kind: 'pocket',
      geometry: [{ kind: 'region', sketch: 'sketch#1' }],
      depth: { kind: 'blind', depth: { source: '4 mm' } },
      stepover: { source: '0.4' },
    });
  });
});

describe('the facing dialog', () => {
  it('faces the whole stock with no geometry, with its depth and angle', () => {
    const { ops } = mount('facing');
    expect(screen.getByTestId('cam-sources').textContent).toContain('the whole stock top');
    type('cam-field-depth', '1');
    type('cam-field-angle', '90');
    fireEvent.click(screen.getByText('Feeds and speed'));
    type('cam-field-feeds-cut', '1500');
    ok();
    expect(ops()[0]).toMatchObject({
      kind: 'facing',
      geometry: [],
      depth: { source: '1' },
      angle: { source: '90' },
      feeds: { cut: { source: '1500' } },
    });
  });

  it('refuses a feed that is a length', () => {
    const { ops } = mount('facing');
    type('cam-field-feeds-plunge', '10 mm');
    ok();
    expect(screen.getByTestId('cam-field-feeds-plunge-note').textContent).toMatch(/Expected/);
    expect(ops()).toEqual([]);
  });
});

describe('the drill dialog', () => {
  it('takes hole features and pecks, and no faces', async () => {
    const doc = setupDocument();
    // The demo part has no hole feature: drill every round hole when none is listed.
    const { ops, pick } = mount('drill', { doc });
    expect(screen.queryByTestId('cam-pick-faces')).toBeNull();
    expect(screen.getByTestId('cam-sources').textContent).toContain('every round hole');
    await pick('extrude#1:cap:end');
    expect(screen.getByTestId('cam-pick-message').textContent).toMatch(/not picked/);
    type('cam-field-peck', '0');
    expect(screen.getByTestId('cam-field-peck-note').textContent).toMatch(/greater than zero/);
    type('cam-field-peck', '2 mm');
    type('cam-field-dwell', '-1');
    ok();
    expect(ops()).toEqual([]);
    type('cam-field-dwell', '0.5');
    ok();
    expect(ops()[0]).toMatchObject({ kind: 'drill', geometry: [], peck: { source: '2 mm' } });
    expect(ops()[0]).not.toHaveProperty('depth');
  });
});

describe('the V-carve dialog', () => {
  it('asks for a V-bit, then carves sketch regions to a maximum depth', () => {
    const { ops } = mount('vcarve');
    expect((screen.getByTestId('cam-op-tool') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByTestId('cam-add-region'));
    ok();
    expect(screen.getByTestId('cam-op-tool-error').textContent).toMatch(/V-bit/);
    expect(ops()).toEqual([]);
    cleanup();
    const withBit = mount('vcarve', { doc: withTool(setupDocument(), 'c3d-301') });
    fireEvent.click(screen.getByTestId('cam-add-region'));
    type('cam-field-maxDepth', '3');
    ok();
    expect(withBit.ops()[0]).toMatchObject({
      kind: 'vcarve',
      tool: 'tool#2',
      maxDepth: { source: '3' },
    });
  });
});

describe('editing', () => {
  it('opens an operation, marks a lost face and puts the next pick in its place', async () => {
    let doc = setupDocument();
    doc = apply(doc, {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'profile#1',
        kind: 'profile',
        name: 'Outline',
        suppressed: false,
        tool: 'tool#1',
        geometry: [{ kind: 'face', face: { id: 'r1', ref: { face: 'gone' } } }],
        side: 'outside',
        depth: { kind: 'through' },
        entry: { kind: 'plunge' },
        leadIn: { kind: 'none' },
        leadOut: { kind: 'none' },
        climb: true,
      },
    });
    const { ops, pick, documents } = mount('profile', { doc, operationId: 'profile#1', repick: 0 });
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Profile: Outline');
    expect(screen.getByTestId('cam-source-0').textContent).toContain('not found');
    ok();
    expect(screen.getByTestId('cam-sources-error').textContent).toMatch(/pick it again/);
    await pick('extrude#1:cap:start');
    await waitFor(() =>
      expect(screen.getByTestId('cam-source-0').textContent).not.toContain('not found'),
    );
    ok();
    expect(ops()[0]!.geometry).toEqual([
      { kind: 'face', face: { id: 'r2', ref: { face: 'extrude#1:cap:start' } } },
    ]);
    expect(documents.getState().undoLabel).toBe('Edit Outline');
  });

  it('keeps a suppress and a rename made from the list while it was open', () => {
    const doc = apply(setupDocument(), {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'facing#1',
        kind: 'facing',
        name: 'Face top',
        suppressed: false,
        tool: 'tool#1',
        geometry: [],
        depth: mm('1'),
        angle: mm('0'),
      },
    });
    const { documents, ops, onClose } = mount('facing', { doc, operationId: 'facing#1' });
    act(() => {
      documents.getState().execute(
        {
          type: 'suppressCamOperation',
          setupId: 'setup#1',
          operationId: 'facing#1',
          suppressed: true,
        },
        'Suppress',
      );
      documents.getState().execute(
        {
          type: 'editCamOperation',
          setupId: 'setup#1',
          operation: { ...ops()[0]!, name: 'Skim' },
        },
        'Rename',
      );
    });
    type('cam-field-depth', '2');
    ok();
    expect(onClose).toHaveBeenCalled();
    expect(ops()[0]).toMatchObject({ name: 'Skim', suppressed: true, depth: { source: '2' } });
  });

  it('applies its own name over a rename made meanwhile, and says when the operation is gone', () => {
    const doc = apply(setupDocument(), {
      type: 'addCamOperation',
      setupId: 'setup#1',
      operation: {
        id: 'facing#1',
        kind: 'facing',
        name: 'Face top',
        suppressed: false,
        tool: 'tool#1',
        geometry: [],
        depth: mm('1'),
        angle: mm('0'),
      },
    });
    const { documents, ops } = mount('facing', { doc, operationId: 'facing#1' });
    act(() => {
      documents.getState().execute(
        {
          type: 'editCamOperation',
          setupId: 'setup#1',
          operation: { ...ops()[0]!, name: 'Skim' },
        },
        'Rename',
      );
    });
    type('cam-op-name', 'Final pass');
    ok();
    expect(ops()[0]!.name).toBe('Final pass');

    cleanup();
    const again = mount('facing', { doc, operationId: 'facing#1' });
    act(() => {
      again.documents
        .getState()
        .execute(
          { type: 'deleteCamOperation', setupId: 'setup#1', operationId: 'facing#1' },
          'Delete',
        );
    });
    ok();
    expect(again.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('cam-op-error').textContent).toMatch(/operation is gone/);
    expect(again.ops()).toEqual([]);
  });

  it('refuses to open an edit on a setup without its operation, rather than adding a new one', () => {
    // The dialog remounts on the first setup when an undo removes the one it edited: the
    // operation id is not there, and a blank form whose OK adds an operation would be wrong.
    const { ops, onClose } = mount('facing', { operationId: 'facing#9' });
    expect(screen.getByTestId('cam-op-gone').textContent).toBe(
      'The operation is gone (deleted or moved meanwhile).',
    );
    expect(screen.queryByTestId('cam-op-ok')).toBeNull();
    expect(screen.queryByTestId('cam-op-name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(ops()).toEqual([]);
  });

  it('refuses OK when an undo pointed the setup at another part while it was open', async () => {
    const doc = apply(setupDocument(), { type: 'addPart', partId: 'part#2', name: 'Lid' });
    const { documents, ops, pick, onClose } = mount('profile', {
      doc,
      prepare: (store) => {
        store
          .getState()
          .execute({ type: 'editCamSetup', setupId: 'setup#1', part: 'part#2' }, 'Other part');
      },
    });
    await pick('extrude#1:cap:end', 'part#2/extrude#1');
    await waitFor(() =>
      expect(screen.getByTestId('cam-source-0').textContent).toContain('extrude#1:cap:end'),
    );
    act(() => {
      documents.getState().undo();
    });
    expect(documents.getState().document.cam.setups[0]!.part).toBe('part#1');
    ok();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('cam-op-error').textContent).toBe(
      'The setup now machines another part: close the dialog and pick again.',
    );
    expect(ops()).toEqual([]);
  });

  it('refuses a face of another body when the setup names its body', async () => {
    const doc = apply(setupDocument(), {
      type: 'editCamSetup',
      setupId: 'setup#1',
      body: 'extrude#1',
    });
    const { pick } = mount('profile', { doc });
    await pick('extrude#2:cap:end', 'part#1/extrude#2');
    await waitFor(() =>
      expect(screen.getByTestId('cam-pick-message').textContent).toBe(
        "Pick a face of the setup's body.",
      ),
    );
    expect(screen.queryByTestId('cam-source-0')).toBeNull();
  });

  it('Escape closes and changes nothing', () => {
    const { onClose, ops } = mount('facing');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(ops()).toEqual([]);
  });
});
