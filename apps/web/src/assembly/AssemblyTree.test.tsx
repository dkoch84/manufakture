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

describe('exploded steps block deleting an instance', () => {
  it('disables Delete for an instance a step moves or aims by, saying which step', () => {
    const doc = apply(twoInstances(), {
      type: 'addExplodedView',
      assemblyId: A,
      explodedView: {
        id: 'explode#1',
        name: 'Exploded view 1',
        steps: [
          {
            id: 'step#1',
            instances: ['inst#2'],
            direction: { instance: 'inst#1', face: { face: 'extrude#1:cap:end' } },
            distance: { source: '30', lengthUnit: 'mm', angleUnit: 'deg' },
          },
        ],
      },
    });
    const documents = createDocumentStore(doc);
    render(
      <AssemblyTree documents={documents} assemblyId={A} result={result()} onEditMate={vi.fn()} />,
    );
    for (const id of ['inst#1', 'inst#2']) {
      const button = screen.getByTestId(`instance-delete-${id}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(
        'Moved or aimed by exploded step 1 of Exploded view 1: edit or delete those steps first',
      );
    }
    // Once the step goes, the instances can go too.
    act(() => {
      documents.getState().execute(
        {
          type: 'deleteExplodeStep',
          assemblyId: A,
          explodedViewId: 'explode#1',
          stepId: 'step#1',
        },
        'Delete step',
      );
    });
    const lid = screen.getByTestId('instance-delete-inst#2') as HTMLButtonElement;
    expect(lid.disabled).toBe(false);
    expect(lid.title).toBe('');
  });
});

describe('configuration rows of instances', () => {
  const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

  it('builds an instance in a row of its part, as one undoable command', () => {
    const doc = apply(
      twoInstances(),
      { type: 'setVariable', name: 'width', expression: mm('600') },
      {
        type: 'setConfigParameter',
        parameter: { id: 'cp#1', name: 'Width', kind: 'variable', variable: 'width' },
      },
      { type: 'setConfigRow', row: { id: 'cfg#1', name: '600 mm', values: { 'cp#1': mm('600') } } },
      {
        type: 'setConfigRow',
        row: { id: 'cfg#2', name: '1000 mm', values: { 'cp#1': mm('1000') } },
      },
    );
    const documents = createDocumentStore(doc);
    render(
      <AssemblyTree documents={documents} assemblyId={A} result={result()} onEditMate={vi.fn()} />,
    );
    const select = () => screen.getByTestId('instance-configuration-inst#2') as HTMLSelectElement;
    expect(Array.from(select().options, (o) => o.text)).toEqual([
      'Default (as stored)',
      '600 mm',
      '1000 mm',
    ]);
    fireEvent.change(select(), { target: { value: 'cfg#2' } });
    const lid = () => documents.getState().document.assemblies[0]!.instances[1]!;
    expect(lid().source).toEqual({ part: 'part#2', configuration: 'cfg#2' });
    expect(documents.getState().undoLabel).toBe('Build Lid 1 in 1000 mm');
    expect(screen.getByTestId('instance-inst#2').textContent).toContain('Lid (1000 mm)');
    expect(select().value).toBe('cfg#2');
    fireEvent.change(select(), { target: { value: '' } });
    expect(lid().source).toEqual({ part: 'part#2' });
    act(() => {
      documents.getState().undo();
    });
    expect(lid().source).toEqual({ part: 'part#2', configuration: 'cfg#2' });
  });

  it('offers no row for a part of a document without a table', () => {
    const documents = createDocumentStore(twoInstances());
    render(
      <AssemblyTree documents={documents} assemblyId={A} result={result()} onEditMate={vi.fn()} />,
    );
    expect(screen.queryByTestId('instance-configuration-inst#1')).toBeNull();
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
