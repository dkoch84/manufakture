import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDocument, type Feature, type ManufaktureDocument } from '@manufakture/core';
import type { FeatureResult } from '@manufakture/regen';
import { createModelStore } from '../model/model';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createScriptGrantsStore } from './policy';
import { ScriptsBanner } from './ScriptsBanner';
import { ScriptsPanel } from './ScriptsPanel';
import { BOX_SOURCE, memoryStorage, scriptedDocument } from './scripts.test-fixture';

describe('ScriptsPanel', () => {
  it('lists the scripts with their language and users, and opens the editor', () => {
    const documents = createDocumentStore(scriptedDocument());
    const grants = createScriptGrantsStore(() => memoryStorage());
    const onEdit = vi.fn();
    render(<ScriptsPanel documents={documents} grants={grants} onEdit={onEdit} />);
    const box = screen.getByTestId('script-script#1');
    expect(box.textContent).toContain('Box');
    expect(box.textContent).toContain('JavaScript');
    expect(box.textContent).toContain('Run by Scripted 1');
    fireEvent.click(within(box).getByRole('button', { name: 'Edit script Box' }));
    expect(onEdit).toHaveBeenCalledWith('script#1');
    fireEvent.click(screen.getByTestId('script-new'));
    expect(onEdit).toHaveBeenLastCalledWith(null);
    // A script a feature runs cannot be deleted.
    expect(
      (within(box).getByRole('button', { name: 'Delete script Box' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('deletes a script nothing runs, as one undo step', () => {
    const doc = scriptedDocument();
    const documents = createDocumentStore({
      ...doc,
      parts: [{ ...doc.parts[0]!, features: [doc.parts[0]!.features[0]!] }],
    });
    const grants = createScriptGrantsStore(() => memoryStorage());
    render(<ScriptsPanel documents={documents} grants={grants} onEdit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete script Other' }));
    expect(documents.getState().document.scripts!.map((s) => s.id)).toEqual(['script#1']);
    act(() => void documents.getState().undo());
    expect(documents.getState().document.scripts!.map((s) => s.id)).toEqual([
      'script#1',
      'script#2',
    ]);
  });

  it('shows an empty library, and the automatic setting locked off until the sign-off', () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const grants = createScriptGrantsStore(() => memoryStorage());
    render(<ScriptsPanel documents={documents} grants={grants} onEdit={() => {}} />);
    expect(screen.getByText(/No scripts/)).toBeTruthy();
    const auto = screen.getByTestId('scripts-auto') as HTMLInputElement;
    expect(auto.checked).toBe(false);
    expect(auto.disabled).toBe(true);
    expect(screen.getByTestId('scripts-auto-locked').textContent).toContain('security review');
    fireEvent.click(auto);
    expect(grants.getState().auto()).toBe(false);
  });

  it('after the sign-off the setting can be changed and the note goes', () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    const grants = createScriptGrantsStore(() => memoryStorage(), { signedOff: true });
    render(<ScriptsPanel documents={documents} grants={grants} onEdit={() => {}} />);
    const auto = screen.getByTestId('scripts-auto') as HTMLInputElement;
    expect(auto.disabled).toBe(false);
    expect(auto.checked).toBe(true);
    expect(screen.queryByTestId('scripts-auto-locked')).toBeNull();
    fireEvent.click(auto);
    expect(grants.getState().auto()).toBe(false);
  });
});

describe('ScriptsBanner', () => {
  it('lists the features whose scripts have not run, and Run scripts allows the document', async () => {
    const doc = scriptedDocument();
    const grants = createScriptGrantsStore(() => memoryStorage());
    render(<ScriptsBanner document={doc} grants={grants} model={createModelStore()} />);
    const banner = await screen.findByTestId('scripts-banner');
    expect(within(banner).getByTestId('scripts-banner-features').textContent).toContain(
      'Scripted 1: script BoxScripted 2: script Other',
    );
    fireEvent.click(screen.getByTestId('run-scripts'));
    expect(grants.getState().documents).toEqual(['doc-s']);
    await waitFor(() => expect(screen.queryByTestId('scripts-banner')).toBeNull());
  });

  it('lists only scripts not allowed; none when the user wrote them all here', async () => {
    const doc = scriptedDocument();
    const grants = createScriptGrantsStore(() => memoryStorage());
    await grants.getState().allowSource(doc.id, 'script#1', BOX_SOURCE);
    const model = createModelStore();
    const { rerender } = render(<ScriptsBanner document={doc} grants={grants} model={model} />);
    const banner = await screen.findByTestId('scripts-banner');
    expect(banner.textContent).not.toContain('Box');
    expect(banner.textContent).toContain('Scripted 2: script Other');
    const { scripts: _s, ...plain } = doc;
    void _s;
    rerender(
      <ScriptsBanner
        document={{ ...plain, parts: doc.parts.map((p) => ({ ...p, features: [] })) }}
        grants={grants}
        model={model}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('scripts-banner')).toBeNull());
  });

  it('lists a derived part whose source scripts did not run, and Run scripts allows the document', async () => {
    const base = createDocument({ id: 'doc-d', name: 'Deriving' });
    const derived = {
      id: 'derived#1',
      kind: 'derived',
      name: 'Derived 1',
      suppressed: false,
      source: { documentId: 'doc-src', documentName: 'Gears', partId: 'part#1' },
    } as unknown as Feature;
    const doc: ManufaktureDocument = {
      ...base,
      parts: [{ ...base.parts[0]!, features: [derived] }],
    };
    const result = {
      featureId: 'derived#1',
      kind: 'derived',
      status: 'warning',
      errors: [],
      warnings: [
        {
          code: 'derived-source',
          message: 'A feature of Gears failed',
          features: ['scripted#1'],
          scriptsNotRun: ['scripted#1'],
        },
      ],
    } as unknown as FeatureResult;
    const model = createModelStore();
    model.setState({
      document: doc,
      parts: [{ partId: 'part#1', bodies: [], features: [result] }],
    });
    const grants = createScriptGrantsStore(() => memoryStorage());
    const { rerender } = render(<ScriptsBanner document={doc} grants={grants} model={model} />);
    const banner = await screen.findByTestId('scripts-banner');
    expect(banner.textContent).toContain('Derived 1: the scripts of its source document Gears');
    // Another document's model says nothing about this one.
    rerender(
      <ScriptsBanner document={{ ...doc, id: 'doc-other' }} grants={grants} model={model} />,
    );
    await waitFor(() => expect(screen.queryByTestId('scripts-banner')).toBeNull());
    rerender(<ScriptsBanner document={doc} grants={grants} model={model} />);
    fireEvent.click(await screen.findByTestId('run-scripts'));
    expect(grants.getState().documents).toEqual(['doc-d']);
    await waitFor(() => expect(screen.queryByTestId('scripts-banner')).toBeNull());
  });
});
