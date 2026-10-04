import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary, MAIN_BRANCH, type Branch, type LogEntry } from '../persistence/library';
import { partDocument } from '../persistence/test-fixtures';
import { createDocumentStore } from '../state/document';
import { MergeBranch } from './MergeBranch';

const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 4, 12, 0, clock++));

function step(doc: ManufaktureDocument, label: string, command: Command) {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  const entry: LogEntry = { cause: 'execute', label, command, at: label };
  return { doc: r.value.document, entry };
}

/** Main (edited fillet 1 and added #w) and the branch "Round" (edited fillet 1, deleted Hole). */
async function setup() {
  const lib = new DocumentLibrary(new MemoryBackend(), {
    now,
    locks: null,
    newId: () => 'b-1',
  });
  const base = partDocument('doc-1', 'Doc');
  await lib.save(base);
  const v = await lib.createVersion('doc-1', { name: 'Base' });
  if (!v.ok) throw new Error(v.message);
  const made = await lib.createBranch('doc-1', v.value.id, 'Round');
  if (!made.ok) throw new Error(made.message);
  const fillet = base.parts[0]!.features.find((f) => f.id === 'fillet#1')!;
  await lib.open('doc-1', 'b-1');
  const a = step(base, 'Fillet 1 at 5', {
    type: 'editFeature',
    partId: 'part#1',
    feature: { ...fillet, radius: mm('5') } as typeof fillet,
  });
  const b = step(a.doc, 'Set #w', { type: 'setVariable', name: 'w', expression: mm('2') });
  await lib.save(b.doc, [a.entry, b.entry], 'b-1');
  const m = step(base, 'Fillet 1 at 1', {
    type: 'editFeature',
    partId: 'part#1',
    feature: { ...fillet, radius: mm('1') } as typeof fillet,
  });
  await lib.save(m.doc, [m.entry]);
  const opened = await lib.open('doc-1');
  if (!opened.ok) throw new Error(opened.message);
  const branches: Branch[] = [
    { id: MAIN_BRANCH, name: 'Main', fromVersion: null, createdAt: '' },
    made.value,
  ];
  return { lib, branches, documents: createDocumentStore(opened.value.document) };
}

describe('merging a branch in the History panel', () => {
  it('previews what applies and what is replaced whole, then merges as one undo step', async () => {
    const { lib, branches, documents } = await setup();
    const before = documents.getState().document;
    render(
      <MergeBranch
        source={lib}
        documentId="doc-1"
        branch={MAIN_BRANCH}
        branches={branches}
        documents={documents}
      />,
    );
    expect((screen.getByTestId('merge-from') as HTMLSelectElement).value).toBe('b-1');
    fireEvent.click(screen.getByTestId('merge-preview'));
    const applied = await screen.findByTestId('merge-applied');
    expect([...applied.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Fillet 1 at 5',
      'Set #w',
    ]);
    // Last writer wins per feature, and the preview says so.
    expect(screen.getByTestId('merge-replaced').textContent).toBe('Fillet 1 (Demo part)');
    expect(screen.getByTestId('merge-plan').textContent).toContain('not per field');
    expect(screen.queryByTestId('merge-dropped')).toBeNull();
    // Nothing changed yet.
    expect(documents.getState().document).toBe(before);

    fireEvent.click(screen.getByTestId('merge-apply'));
    expect(screen.getByTestId('merge-status').textContent).toBe(
      'Merged Round into Main. Undo takes it back.',
    );
    expect(documents.getState().undoLabel).toBe('Merge "Round"');
    expect(documents.getState().document.variables.map((x) => x.name)).toEqual(['w']);
    documents.getState().undo();
    expect(documents.getState().document).toEqual(before);
  });

  it('previews again when the document changed after the preview', async () => {
    const { lib, branches, documents } = await setup();
    render(
      <MergeBranch
        source={lib}
        documentId="doc-1"
        branch={MAIN_BRANCH}
        branches={branches}
        documents={documents}
      />,
    );
    fireEvent.click(screen.getByTestId('merge-preview'));
    await screen.findByTestId('merge-applied');
    documents.getState().execute({ type: 'renameDocument', name: 'Later' }, 'Rename');
    fireEvent.click(screen.getByTestId('merge-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('merge-plan').textContent).toContain(
        'The document changed since the preview',
      ),
    );
    expect(documents.getState().undoLabel).toBe('Rename');
    fireEvent.click(screen.getByTestId('merge-apply'));
    expect(documents.getState().document.name).toBe('Later');
    expect(documents.getState().undoLabel).toBe('Merge "Round"');
  });

  it('shows nothing without another branch', () => {
    const { container } = render(
      <MergeBranch
        source={{ previewMerge: () => Promise.reject(new Error('no')) }}
        documentId="doc-1"
        branch={MAIN_BRANCH}
        branches={[{ id: MAIN_BRANCH, name: 'Main', fromVersion: null, createdAt: '' }]}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
