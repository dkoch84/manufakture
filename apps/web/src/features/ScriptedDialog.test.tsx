import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDocument, type ScriptedFeature } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { createModelStore } from '../model/model';
import { BOX_SOURCE, PART, scriptedDocument } from '../scripts/scripts.test-fixture';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef } from '../state/selection';
import { FeatureDialog, type DialogRequest } from './FeatureDialog';
import type { ParamSpec } from './scripted';
import type { ScriptedServices } from './ScriptedDialog';

const SPECS: ParamSpec[] = [
  { name: 'width', kind: 'length', default: 40, min: 1, label: 'Width' },
  { name: 'flip', kind: 'boolean', default: false, label: 'Flip it' },
  { name: 'style', kind: 'choice', options: ['round', 'square'], default: 'round' },
  { name: 'face', kind: 'reference', select: 'face', optional: true, label: 'Top face' },
];

function services(over: Partial<ScriptedServices> = {}): ScriptedServices {
  return {
    declarations: vi.fn(async () => ({ ok: true as const, params: SPECS })),
    mayRun: vi.fn(async () => true),
    openScript: vi.fn(),
    ...over,
  };
}

function setup(request: DialogRequest, scripts: ScriptedServices | null, doc = scriptedDocument()) {
  const documents = createDocumentStore(doc);
  const selection = createSelectionStore();
  const onClose = vi.fn();
  const resolve = vi.fn(async (geo: { name: string }) => ({
    ok: true as const,
    item: { id: null, ref: { face: geo.name }, label: geo.name },
  }));
  render(
    <FeatureDialog
      request={request}
      documents={documents}
      model={createModelStore()}
      selection={selection}
      resolve={resolve as never}
      scripts={scripts}
      onClose={onClose}
    />,
  );
  return { documents, selection, onClose, resolve };
}

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

describe('the scripted feature dialog', () => {
  it('shows a field per declared parameter and the seed, and adds the feature as one step', async () => {
    const s = services();
    const { documents, onClose } = setup({ kind: 'scripted' }, s);
    expect(screen.getByTestId('scripted-mark').textContent).toContain('scripted feature');
    await screen.findByTestId('field-param-width');
    expect(s.declarations).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'script#1',
        source: BOX_SOURCE,
        language: 'js',
        apiVersion: 1,
      }),
      expect.objectContaining({ id: 'doc-s' }),
    );
    expect(field('field-param-width').value).toBe('40');
    expect((screen.getByTestId('field-seed') as HTMLInputElement).value).toBe('0');
    expect(screen.getByLabelText('Flip it')).toBeTruthy();
    expect(screen.getByTestId('ref-param:face').textContent).toContain('Top face');

    fireEvent.change(field('field-param-width'), { target: { value: '2 * 12' } });
    fireEvent.click(screen.getByLabelText('Flip it'));
    fireEvent.change(screen.getByTestId('field-param-style'), { target: { value: 'square' } });
    fireEvent.change(screen.getByTestId('field-seed'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    expect(onClose).toHaveBeenCalled();
    const f = documents.getState().document.parts[0]!.features.at(-1) as ScriptedFeature;
    expect(f).toMatchObject({
      id: 'scripted#3',
      kind: 'scripted',
      script: 'script#1',
      seed: 5,
      params: {
        width: {
          kind: 'expression',
          expression: { source: '2 * 12', lengthUnit: 'mm', angleUnit: 'deg' },
        },
        flip: { kind: 'boolean', value: true },
        style: { kind: 'choice', value: 'square' },
        face: { kind: 'reference', references: [] },
      },
    });
  });

  it('takes faces picked in the viewport into the active reference field', async () => {
    const { selection, documents } = setup({ kind: 'scripted' }, services());
    await screen.findByTestId('field-param-width');
    act(() =>
      selection
        .getState()
        .click(geometryRef('face', 'part#1/scripted#1:box', 'scripted#1:box/cap:end'), 'replace'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('ref-param:face').textContent).toContain('scripted#1:box/cap:end'),
    );
    fireEvent.click(screen.getByTestId('dialog-ok'));
    const f = documents.getState().document.parts[0]!.features.at(-1) as ScriptedFeature;
    expect(f.params.face).toEqual({
      kind: 'reference',
      references: [{ id: 'r1', ref: { face: 'scripted#1:box/cap:end' } }],
    });
  });

  it('does not read a script that may not run here: the stored values stay, the seed can change', async () => {
    const s = services({ mayRun: vi.fn(async () => false) });
    const { documents } = setup({ kind: 'scripted', featureId: 'scripted#1' }, s);
    await screen.findByTestId('scripted-blocked');
    expect(s.declarations).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('field-seed'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    const f = documents.getState().document.parts[0]!.features[0] as ScriptedFeature;
    expect(f).toMatchObject({ seed: 12, params: {} });
  });

  it('says why the parameters could not be read', async () => {
    setup(
      { kind: 'scripted' },
      services({
        declarations: vi.fn(async () => ({ ok: false as const, message: 'bad', line: 2 })),
      }),
    );
    const failed = await screen.findByTestId('scripted-failed');
    expect(failed.textContent).toContain('bad (line 2)');
  });

  it('refuses a value outside the declared bounds', async () => {
    const { onClose } = setup({ kind: 'scripted' }, services());
    await screen.findByTestId('field-param-width');
    fireEvent.change(field('field-param-width'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await screen.findByText('Must be at least 1 mm.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks for a script when the document has none', () => {
    setup({ kind: 'scripted' }, services(), createDocument({ id: 'd', name: 'D' }));
    expect(screen.getByTestId('scripted-no-scripts')).toBeTruthy();
    expect((screen.getByTestId('dialog-ok') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the script in the editor', async () => {
    const s = services();
    setup({ kind: 'scripted', featureId: 'scripted#2' }, s);
    fireEvent.click(screen.getByTestId('scripted-open-script'));
    expect(s.openScript).toHaveBeenCalledWith('script#2');
    expect(PART).toBe('part#1');
  });
});
