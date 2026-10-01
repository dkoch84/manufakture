import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Mate } from '@manufakture/core';
import type { MateResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { A, apply, result, twoInstances } from './assembly.test-fixture';
import { AssemblyTree } from './AssemblyTree';
import { InsertPanel } from './InsertPanel';

function mate(id: string, name: string): Mate {
  const n = id.slice(5);
  return {
    id,
    name,
    kind: 'fastened',
    a: {
      id: `mc#${n}1`,
      instance: 'inst#1',
      inference: 'centroid',
      origin: { id: `r${n}1`, ref: { face: 'a' } },
    },
    b: {
      id: `mc#${n}2`,
      instance: 'inst#2',
      inference: 'centroid',
      origin: { id: `r${n}2`, ref: { face: 'b' } },
    },
    suppressed: false,
  };
}

function solved(id: string, status: MateResult['status']): MateResult {
  return {
    mateId: id,
    status,
    coordinates: [],
    residual: null,
    connectors: [
      { connectorId: 'x', instanceId: 'inst#1', frame: null, reference: null },
      { connectorId: 'y', instanceId: 'inst#2', frame: null, reference: null },
    ],
    errors: [],
    warnings: [],
  };
}

function setup() {
  const doc = apply(
    twoInstances(),
    { type: 'addMate', assemblyId: A, mate: mate('mate#1', 'Base') },
    { type: 'addMate', assemblyId: A, mate: mate('mate#2', 'Again') },
  );
  const documents = createDocumentStore(doc);
  const onEditMate = vi.fn();
  const conflict = result({
    outcome: 'conflicting',
    dof: null,
    message: 'Base and Again cannot both hold: change or suppress Again.',
    conflicting: [
      { mates: ['mate#1', 'mate#2'], blame: 'mate#2', message: 'Base and Again disagree.' },
    ],
    mates: [solved('mate#1', 'conflicting'), solved('mate#2', 'conflicting')],
  });
  const view = render(
    <AssemblyTree documents={documents} assemblyId={A} result={conflict} onEditMate={onEditMate} />,
  );
  return { documents, onEditMate, view };
}

describe('AssemblyTree', () => {
  it('lists instances and mates with the solve, explaining a conflict and the mate to blame', () => {
    setup();
    expect(screen.getByTestId('assembly-dof').textContent).toBe(
      'Base and Again cannot both hold: change or suppress Again.',
    );
    expect(screen.getByTestId('instance-inst#1').textContent).toContain('Box 1 fixed');
    expect(screen.getByTestId('mate-status-mate#1').textContent).toBe('Conflicting');
    expect(screen.getByTestId('mate-status-mate#2').textContent).toBe(
      'Conflicting: change or suppress this one',
    );
    expect(screen.getByTestId('mate-mate#2').textContent).toContain('Base and Again disagree.');
    // An instance with mates cannot be deleted.
    expect((screen.getByTestId('instance-delete-inst#2') as HTMLButtonElement).disabled).toBe(true);
  });

  it('fixes, suppresses and deletes as undoable commands, and opens a mate for editing', () => {
    const s = setup();
    fireEvent.click(screen.getByTestId('instance-fix-inst#2'));
    expect(s.documents.getState().document.assemblies[0]!.instances[1]!.fixed).toBe(true);
    expect(s.documents.getState().undoLabel).toBe('Fix Lid 1');
    fireEvent.click(screen.getByTestId('mate-suppress-mate#2'));
    expect(s.documents.getState().document.assemblies[0]!.mates[1]!.suppressed).toBe(true);
    expect(screen.getByTestId('mate-suppress-mate#2').textContent).toBe('Unsuppress');
    fireEvent.click(screen.getByTestId('mate-edit-mate#1'));
    expect(s.onEditMate).toHaveBeenCalledWith('mate#1');
    fireEvent.click(screen.getByTestId('mate-delete-mate#1'));
    fireEvent.click(screen.getByTestId('mate-delete-mate#2'));
    expect(s.documents.getState().document.assemblies[0]!.mates).toEqual([]);
    fireEvent.click(screen.getByTestId('instance-delete-inst#2'));
    expect(s.documents.getState().document.assemblies[0]!.instances.map((x) => x.id)).toEqual([
      'inst#1',
    ]);
    act(() => {
      s.documents.getState().undo();
    });
    expect(screen.getByTestId('instance-inst#2')).toBeTruthy();
  });
});

describe('InsertPanel', () => {
  it('inserts part studios of the document, one undoable command each', () => {
    const documents = createDocumentStore(twoInstances());
    const onClose = vi.fn();
    render(<InsertPanel documents={documents} assemblyId={A} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('insert-part-part#2'));
    const instances = documents.getState().document.assemblies[0]!.instances;
    expect(instances.map((x) => [x.id, x.name, x.fixed])).toEqual([
      ['inst#1', 'Box 1', true],
      ['inst#2', 'Lid 1', false],
      ['inst#3', 'Lid 2', false],
    ]);
    expect(screen.getByTestId('insert-message').textContent).toBe('Inserted Lid 2.');
    expect(documents.getState().undoLabel).toBe('Insert Lid 2');
    // Without a library there is nothing to pin.
    expect(screen.queryByTestId('insert-pinned')).toBeNull();
    fireEvent.click(screen.getByTestId('insert-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
