import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ManufaktureDocument } from '@manufakture/core';
import type { AssemblyResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import type { Referencer } from '../io/exchange';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef } from '../state/selection';
import { assemblyBodies, type Assembler } from './assembly';
import { A, LIFTED, instanceResult, model, result, twoInstances } from './assembly.test-fixture';
import { MateDialog } from './MateDialog';

const BOX = `${A}/inst#1/extrude#1`;
const LID = `${A}/inst#2/extrude#1`;

/** A solve that puts the lid on the box and reports one degree of freedom. */
function assembler(): Assembler & { solve: ReturnType<typeof vi.fn> } {
  return {
    solve: vi.fn(async (doc: ManufaktureDocument): Promise<AssemblyResult> =>
      result({
        dof: 1,
        instances: [
          instanceResult('inst#1', 'part#1'),
          instanceResult('inst#2', 'part#2', { transform: LIFTED, moved: true }),
        ],
        mates: doc.assemblies[0]!.mates.map((m) => ({
          mateId: m.id,
          status: 'ok',
          coordinates: [0],
          residual: { position: 0, angle: 0 },
          connectors: [
            { connectorId: m.a.id, instanceId: m.a.instance, frame: null, reference: null },
            { connectorId: m.b.id, instanceId: m.b.instance, frame: null, reference: null },
          ],
          errors: [],
          warnings: [],
        })),
      }),
    ),
    drag: vi.fn(),
  } as Assembler & { solve: ReturnType<typeof vi.fn> };
}

function setup(
  options: { assembler?: Assembler; mateId?: string | null; doc?: ManufaktureDocument } = {},
) {
  const doc = options.doc ?? twoInstances();
  const documents = createDocumentStore(doc);
  const selection = createSelectionStore();
  const bodies = assemblyBodies(doc, A, model());
  const onPreview = vi.fn();
  const onClose = vi.fn();
  const onConnectors = vi.fn();
  const referencer: Referencer = {
    reference: vi.fn(async () => ({
      ok: true as const,
      value: { faces: ['extrude#1/bottom', 'extrude#1/front'] },
    })),
    vertex: vi.fn(async () => ({ ok: true as const, value: { faces: ['a', 'b', 'c'] } })),
  };
  render(
    <MateDialog
      documents={documents}
      assemblyId={A}
      mateId={options.mateId ?? null}
      selection={selection}
      bodies={bodies}
      assembler={options.assembler}
      referencer={referencer}
      onPreview={onPreview}
      onConnectors={onConnectors}
      onClose={onClose}
    />,
  );
  const pick = (kind: 'face' | 'edge', bodyId: string, name: string) =>
    act(() => selection.getState().click(geometryRef(kind, bodyId, name), 'replace'));
  return { documents, selection, onPreview, onClose, onConnectors, referencer, pick };
}

describe('MateDialog', () => {
  it('takes two connectors from the view, previews the solve, and adds the mate with the poses as one step', async () => {
    const solver = assembler();
    const s = setup({ assembler: solver });
    expect(screen.getByTestId('mate-preview').textContent).toContain(
      'Pick two connectors in the view.',
    );
    expect(screen.getByTestId('mate-pick-a').getAttribute('aria-pressed')).toBe('true');

    await s.pick('face', BOX, 'extrude#1/top');
    expect((await screen.findByTestId('mate-connector-label-a')).textContent).toContain(
      'Box 1: centroid of extrude#1/top',
    );
    // The pick became the connector, not a selection; the second connector is next.
    expect(s.selection.getState().selected).toEqual([]);
    expect(screen.getByTestId('mate-pick-b').getAttribute('aria-pressed')).toBe('true');

    await s.pick('edge', LID, 'extrude#1/front|bottom');
    expect((await screen.findByTestId('mate-connector-label-b')).textContent).toContain(
      'Lid 1: midpoint of extrude#1/bottom | extrude#1/front',
    );
    expect(s.referencer.reference).toHaveBeenCalledWith(LID, 'edge', 1);
    expect(s.onConnectors).toHaveBeenLastCalledWith([
      expect.objectContaining({ instanceId: 'inst#1' }),
      expect.objectContaining({ instanceId: 'inst#2' }),
    ]);

    fireEvent.change(screen.getByTestId('mate-kind'), { target: { value: 'revolute' } });
    await waitFor(() =>
      expect(screen.getByTestId('mate-preview').textContent).toContain('1 degree of freedom'),
    );
    const previewed = solver.solve.mock.calls.at(-1)![0] as ManufaktureDocument;
    expect(previewed.assemblies[0]!.mates.map((m) => m.kind)).toEqual(['revolute']);
    expect(s.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ dof: 1 }));

    fireEvent.click(screen.getByTestId('mate-ok'));
    const after = s.documents.getState();
    expect(after.document.assemblies[0]!.mates.map((m) => [m.id, m.name, m.kind])).toEqual([
      ['mate#1', 'Revolute 1', 'revolute'],
    ]);
    expect(after.document.assemblies[0]!.instances[1]!.pose).toEqual(LIFTED);
    expect(after.undoLabel).toBe('Add Revolute 1');
    expect(s.onClose).toHaveBeenCalledWith(after.document);
    // The preview stays shown until regen catches up: no clearing on OK.
    expect(s.onPreview).not.toHaveBeenLastCalledWith(null);
    // One undo step takes the mate and the poses back.
    act(() => {
      s.documents.getState().undo();
    });
    expect(s.documents.getState().document.assemblies[0]!.mates).toEqual([]);
    expect(s.documents.getState().document.assemblies[0]!.instances[1]!.pose.translation).toEqual([
      0, 0, 0,
    ]);
  });

  it('says what is missing, refuses picks off instances, and cancels without a change', async () => {
    const s = setup();
    fireEvent.click(screen.getByTestId('mate-ok'));
    screen.getByText('Pick the first connector.');
    await s.pick('face', 'part#1/extrude#1', 'extrude#1/top');
    expect((await screen.findByTestId('mate-pick-message')).textContent).toContain(
      'Pick a face, edge or vertex of an instance.',
    );
    fireEvent.click(screen.getByTestId('mate-cancel'));
    expect(s.onPreview).toHaveBeenLastCalledWith(null);
    expect(s.onClose).toHaveBeenCalledWith(null);
    expect(s.documents.getState().canUndo).toBe(false);
  });

  it('edits a mate in place: its connectors are shown again, flip and offset change', async () => {
    let doc = twoInstances();
    const { apply } = await import('./assembly.test-fixture');
    doc = apply(doc, {
      type: 'addMate',
      assemblyId: A,
      mate: {
        id: 'mate#1',
        name: 'Hinge',
        kind: 'revolute',
        a: {
          id: 'mc#1',
          instance: 'inst#1',
          inference: 'centroid',
          origin: { id: 'r1', ref: { face: 'extrude#1/top' } },
        },
        b: {
          id: 'mc#2',
          instance: 'inst#2',
          inference: 'centroid',
          origin: { id: 'r2', ref: { face: 'extrude#1/bottom' } },
        },
        suppressed: false,
      },
    });
    const s = setup({ doc, mateId: 'mate#1' });
    expect(screen.getByTestId('mate-dialog').getAttribute('aria-label')).toBe('Mate: Hinge');
    expect(screen.getByTestId('mate-connector-label-b').textContent).toContain(
      'Lid 1: centroid of extrude#1/bottom',
    );
    // No slot is waiting for a pick when editing.
    expect(screen.getByTestId('mate-pick-a').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('mate-flip'));
    fireEvent.click(screen.getByTestId('mate-rotate'));
    fireEvent.change(screen.getByTestId('mate-offset-z'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('mate-ok'));
    const mate = s.documents.getState().document.assemblies[0]!.mates[0]!;
    expect(mate).toMatchObject({ id: 'mate#1', name: 'Hinge', b: { flip: true, rotate: 1 } });
    expect(mate.a.offset?.translation[2].source).toBe('3');
    expect(s.documents.getState().undoLabel).toBe('Edit Hinge');
  });
});
