import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createModelStore, type PartModel } from '../model/model';
import { createDocumentStore } from '../state/document';
import type { CodeEditorProps } from './editorTypes';
import { createScriptGrantsStore, mayRunScript } from './policy';
import { ScriptEditor } from './ScriptEditor';
import { BOX_SOURCE, PART, memoryStorage, scriptedDocument } from './scripts.test-fixture';
import { NEW_SCRIPT_SOURCE } from './template';

/** A plain text area in place of CodeMirror, showing the markers it was given. */
function TextEditor({ value, onChange, label, markers }: CodeEditorProps) {
  return (
    <>
      <textarea
        aria-label={label}
        data-testid="source"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <output data-testid="markers">{JSON.stringify(markers)}</output>
    </>
  );
}

const shownMarkers = () => JSON.parse(screen.getByTestId('markers').textContent!) as unknown;

function setup(scriptId: string | null, doc = scriptedDocument()) {
  const documents = createDocumentStore(doc);
  const model = createModelStore();
  const grants = createScriptGrantsStore(() => memoryStorage());
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ScriptEditor
      documents={documents}
      model={model}
      grants={grants}
      scriptId={scriptId}
      onClose={onClose}
      onSaved={onSaved}
      Editor={TextEditor}
    />,
  );
  return { documents, model, grants, onClose, onSaved };
}

describe('ScriptEditor', () => {
  it('writes a new script as one undo step, and the source saved is allowed to run here', async () => {
    const { documents, grants, onSaved } = setup(null, createDocument({ id: 'd', name: 'D' }));
    const source = screen.getByTestId('source') as HTMLTextAreaElement;
    expect(source.value).toBe(NEW_SCRIPT_SOURCE);
    fireEvent.change(screen.getByTestId('script-name'), { target: { value: 'Puck' } });
    fireEvent.change(screen.getByTestId('script-language'), { target: { value: 'ts' } });
    fireEvent.change(source, { target: { value: BOX_SOURCE } });
    fireEvent.click(screen.getByTestId('script-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('script#1'));
    const saved = documents.getState().document.scripts![0]!;
    expect(saved).toEqual({
      id: 'script#1',
      name: 'Puck',
      language: 'ts',
      apiVersion: 1,
      source: BOX_SOURCE,
    });
    expect(await mayRunScript(grants.getState(), 'd', saved)).toBe(true);
    // Not the whole document: only this source.
    expect(grants.getState().documents).toEqual([]);
    act(() => void documents.getState().undo());
    expect(documents.getState().document.scripts).toBeUndefined();
  });

  it('edits a stored script; Save is off until something changes', async () => {
    const { documents } = setup('script#2');
    const save = screen.getByTestId('script-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('source'), {
      target: { value: 'export function run() {}\n' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(documents.getState().document.scripts![1]!.source).toBe('export function run() {}\n'),
    );
    expect(documents.getState().undoLabel).toBe('Edit script Other');
  });

  it('takes the grant back when the document refuses the save', async () => {
    const { documents, grants } = setup('script#2');
    // More than a script may hold: core refuses the command.
    const huge = `// ${'x'.repeat(300 * 1024)}\nexport function run() {}\n`;
    fireEvent.change(screen.getByTestId('source'), { target: { value: huge } });
    fireEvent.click(screen.getByTestId('script-save'));
    await screen.findByTestId('script-error');
    expect(documents.getState().document.scripts![1]!.source).not.toBe(huge);
    await waitFor(() => expect(grants.getState().sources).toEqual([]));
  });

  it('refuses an empty name', async () => {
    const { documents } = setup('script#1');
    fireEvent.change(screen.getByTestId('script-name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('script-save'));
    await screen.findByTestId('script-error');
    expect(screen.getByTestId('script-error').textContent).toBe('A script needs a name.');
    expect(documents.getState().document.scripts![0]!.name).toBe('Box');
  });

  it('marks and lists the errors regen reported for the saved source', () => {
    const { model } = setup('script#1');
    act(() =>
      model.setState({
        document: scriptedDocument(),
        parts: [
          {
            partId: PART,
            bodies: [],
            features: [
              {
                featureId: 'scripted#1',
                status: 'error',
                errors: [
                  {
                    code: 'script',
                    scriptCode: 'runtime',
                    scriptId: 'script#1',
                    message: 'Error: boom',
                    line: 5,
                    column: 3,
                  },
                ],
              },
            ],
          } as unknown as PartModel,
        ],
      }),
    );
    expect(screen.getByTestId('script-problem').textContent).toBe(
      'Scripted 1 (line 5, column 3): Error: boom',
    );
    expect(shownMarkers()).toEqual([
      { message: 'Error: boom', source: 'Scripted 1', line: 5, column: 3 },
    ]);
    // Markers are for the saved source: an edit not saved yet takes them away.
    fireEvent.change(screen.getByTestId('source'), { target: { value: 'changed' } });
    expect(shownMarkers()).toEqual([]);
  });

  it('asks before dropping changes not saved; Escape and Close leave the document alone', () => {
    const { onClose, documents } = setup('script#1');
    fireEvent.change(screen.getByTestId('source'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('script-close'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('script-discard'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(documents.getState().document.scripts![0]!.source).toBe(BOX_SOURCE);
  });

  it('closes at once with nothing changed', () => {
    const { onClose } = setup('script#1');
    fireEvent.keyDown(screen.getByTestId('script-editor'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
