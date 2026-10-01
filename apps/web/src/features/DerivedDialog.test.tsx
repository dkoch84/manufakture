import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DerivedFeature, ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../model/demo';
import { createModelStore } from '../model/model';
import { twoBodyDocument } from '../model/twoBodies.test-fixture';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import {
  apply,
  derivedOf,
  deriving,
  fakeLibrary,
  version,
  type FakeLibrary,
} from './derived.test-fixture';
import type { CreateVersion } from '../history/history';
import { FeatureDialog, type DialogRequest } from './FeatureDialog';

const V1 = version('v-1', '6 mm', 1);
const V2 = version('v-2', '8 mm', 2);

const bracket = (name = 'Bracket'): ManufaktureDocument => ({
  ...twoBodyDocument(),
  id: 'doc-a',
  name,
});

function library(): FakeLibrary {
  return fakeLibrary([
    {
      document: bracket(),
      versions: [
        { version: V1, document: bracket('Bracket 6') },
        { version: V2, document: bracket('Bracket 8') },
      ],
    },
    { document: { ...demoDocument('doc-b'), name: 'Deriving' }, versions: [] },
  ]);
}

function setup(
  request: DialogRequest,
  options: {
    doc?: ManufaktureDocument;
    library?: FakeLibrary | null;
    createVersion?: CreateVersion | null;
  } = {},
) {
  const documents = createDocumentStore(
    options.doc ?? { ...demoDocument('doc-b'), name: 'Deriving' },
  );
  const lib = options.library === undefined ? library() : options.library;
  const onClose = vi.fn();
  render(
    <FeatureDialog
      request={request}
      documents={documents}
      model={createModelStore()}
      selection={createSelectionStore()}
      resolve={vi.fn()}
      onClose={onClose}
      library={lib}
      createVersion={options.createVersion ?? null}
    />,
  );
  const features = () => documents.getState().document.parts[0]!.features;
  return { documents, onClose, features, lib };
}

async function choose(documentId: string, versionName: string) {
  await waitFor(() =>
    expect(
      within(screen.getByTestId('pin-document')).getAllByRole('option').length,
    ).toBeGreaterThan(1),
  );
  fireEvent.change(screen.getByTestId('pin-document'), { target: { value: documentId } });
  const use = await screen.findByRole('button', { name: `Use version ${versionName}` });
  fireEvent.click(use);
  await screen.findByTestId('pin-part');
}

describe('the derived part dialog', () => {
  it('pins a part of a version, with its bodies and placement, as one undo step', async () => {
    const t = setup({ kind: 'derived' });
    expect(screen.getByRole('dialog', { name: 'Derived: Derived 1' })).toBeTruthy();
    expect(screen.getByTestId('dialog-ok')).toHaveProperty('disabled', true);
    // The open document is listed as itself.
    await waitFor(() => expect(screen.getByText('Deriving (this document)')).toBeTruthy());
    await choose('doc-a', '6 mm');
    // Newest first, the chosen one marked.
    const listed = screen.getAllByTestId(/^version-(?!list)/).map((el) => el.dataset.testid);
    expect(listed).toEqual(['version-8 mm', 'version-6 mm']);
    expect(screen.getByRole('button', { name: 'Use version 6 mm' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByTestId('pin-part')).toHaveProperty('value', 'part#1');

    // Both bodies of the source, all of them by default; just the second one.
    const bodies = screen.getByTestId('field-bodies');
    await waitFor(() => expect(within(bodies).getByText('All bodies')).toBeTruthy());
    fireEvent.click(within(bodies).getByRole('checkbox', { name: 'All bodies' }));
    fireEvent.click(within(bodies).getByRole('checkbox', { name: 'Extrude 1' }));
    fireEvent.change(screen.getByTestId('field-translation-z'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('field-rotation-x'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));

    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    const added = t.features().at(-1) as DerivedFeature;
    expect(added).toMatchObject({
      id: 'derived#1',
      kind: 'derived',
      bodies: ['extrude#3'],
      operation: 'new',
      source: {
        documentId: 'doc-a',
        documentName: 'Bracket',
        versionId: 'v-1',
        versionName: '6 mm',
        partId: 'part#1',
      },
      placement: {
        translation: [{ source: '0' }, { source: '0' }, { source: '10' }],
        rotation: [{ source: '90' }, { source: '0' }, { source: '0' }],
      },
    });
    expect(JSON.parse(added.source.data)).toMatchObject({ name: 'Bracket 6' });
    expect(t.documents.getState().undoLabel).toBe('Add Derived 1');
    // Only what was chosen was read.
    expect(t.lib!.calls).toEqual(['list', 'listVersions doc-a', 'readVersion doc-a v-1']);
  });

  it('creates a version in the source there and then, and pins it', async () => {
    const t = setup({ kind: 'derived' });
    await waitFor(() =>
      expect(within(screen.getByTestId('pin-document')).getAllByRole('option')).toHaveLength(3),
    );
    fireEvent.change(screen.getByTestId('pin-document'), { target: { value: 'doc-a' } });
    fireEvent.click(await screen.findByTestId('pin-create-version'));
    fireEvent.change(screen.getByTestId('pin-version-name'), { target: { value: 'Now' } });
    // Enter creates the version; it does not apply the dialog.
    fireEvent.keyDown(screen.getByTestId('pin-version-name'), { key: 'Enter' });
    await screen.findByTestId('version-Now');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use version Now' })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    await screen.findByTestId('pin-part');
    expect(t.onClose).not.toHaveBeenCalled();
    expect(t.lib!.calls).toContain('createVersion doc-a Now');
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    expect((t.features().at(-1) as DerivedFeature).source.versionName).toBe('Now');
  });

  it("makes the open document's versions through autosave", async () => {
    const createVersion = vi.fn(async () => ({ ok: true as const, value: version('b-1', 'Mine') }));
    const lib = library();
    setup({ kind: 'derived' }, { library: lib, createVersion });
    await waitFor(() => expect(screen.getByText('Deriving (this document)')).toBeTruthy());
    fireEvent.change(screen.getByTestId('pin-document'), { target: { value: 'doc-b' } });
    expect(await screen.findByTestId('versions-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pin-create-version'));
    fireEvent.change(screen.getByTestId('pin-version-name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByTestId('pin-version-save'));
    await waitFor(() => expect(createVersion).toHaveBeenCalledWith({ name: 'Mine' }));
    expect(lib.calls.some((c) => c.startsWith('createVersion'))).toBe(false);
  });

  it('cannot pin without a library, and Escape leaves the document alone', () => {
    const t = setup({ kind: 'derived' }, { library: null });
    expect(screen.getByTestId('derived-no-library').textContent).toContain('saved document');
    expect(screen.getByTestId('dialog-ok')).toHaveProperty('disabled', true);
    const before = t.documents.getState().document;
    fireEvent.keyDown(screen.getByTestId('feature-dialog'), { key: 'Escape' });
    expect(t.onClose).toHaveBeenCalled();
    expect(t.documents.getState().document).toBe(before);
  });

  it('edits a derived part, keeping its pin until another version is chosen', async () => {
    const feature = await derivedOf(bracket('Bracket 6'), V1);
    const doc = deriving({ ...feature, source: { ...feature.source, documentName: 'Bracket' } });
    const t = setup({ kind: 'derived', featureId: 'derived#1' }, { doc });
    expect(screen.getByTestId('derived-pin').textContent).toContain('From Bracket at 6 mm');
    expect(screen.queryByTestId('pin-picker')).toBeNull();
    // Its bodies come from the pinned text, without reading the library.
    expect(within(screen.getByTestId('field-bodies')).getByText('All bodies')).toBeTruthy();

    // Move it, keep the pin.
    fireEvent.change(screen.getByTestId('field-translation-x'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await waitFor(() => expect(t.onClose).toHaveBeenCalledTimes(1));
    const moved = t.features()[0] as DerivedFeature;
    expect(moved.source).toEqual((doc.parts[0]!.features[0] as DerivedFeature).source);
    expect(moved.placement.translation[0].source).toBe('5');
    expect(t.documents.getState().undoLabel).toBe('Edit Derived 1');
  });

  it('changes an existing pin to another version through the picker', async () => {
    const feature = await derivedOf(bracket('Bracket 6'), V1);
    const t = setup({ kind: 'derived', featureId: 'derived#1' }, { doc: deriving(feature) });
    fireEvent.click(screen.getByTestId('derived-change-source'));
    // The picker starts on the pinned document and version.
    await waitFor(() =>
      expect(screen.getByTestId('pin-document')).toHaveProperty('value', 'doc-a'),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use version 6 mm' })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use version 8 mm' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('derived-pin').textContent).toContain('Bracket at 8 mm'),
    );
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    expect((t.features()[0] as DerivedFeature).source).toMatchObject({
      versionId: 'v-2',
      versionName: '8 mm',
    });
  });

  it('builds a derived part in a configuration row of its source, offering what that row has', async () => {
    // The source with a table: row One suppresses its second body.
    let source = bracket('Bracket 6');
    for (const command of [
      {
        type: 'setConfigParameter',
        parameter: {
          id: 'cp#1',
          name: 'Second',
          kind: 'suppression',
          partId: 'part#1',
          featureId: 'extrude#3',
        },
      },
      { type: 'setConfigRow', row: { id: 'cfg#1', name: 'Both', values: { 'cp#1': false } } },
      { type: 'setConfigRow', row: { id: 'cfg#2', name: 'One', values: { 'cp#1': true } } },
    ] as const) {
      source = apply(source, command);
    }
    const feature = await derivedOf(source, V1);
    const t = setup({ kind: 'derived', featureId: 'derived#1' }, { doc: deriving(feature) });
    const picker = screen.getByTestId('field-configuration') as HTMLSelectElement;
    expect(Array.from(picker.options, (o) => o.text)).toEqual([
      'Default (as stored)',
      'Both',
      'One',
    ]);
    expect(picker.value).toBe('');
    const boxes = () => within(screen.getByTestId('field-bodies')).getAllByRole('checkbox').length;
    // Each body to choose, below All bodies.
    const all = () =>
      within(screen.getByTestId('field-bodies')).getByRole('checkbox', { name: 'All bodies' });
    fireEvent.click(all());
    expect(boxes()).toBe(3);
    fireEvent.click(all());
    // In row One the suppressed body is not offered; the pin itself is unchanged.
    fireEvent.change(picker, { target: { value: 'cfg#2' } });
    fireEvent.click(all());
    expect(boxes()).toBe(2);
    fireEvent.click(all());
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    const saved = (t.features()[0] as DerivedFeature).source;
    expect(saved).toEqual({ ...feature.source, configuration: 'cfg#2' });

    // Back to the default: no row named.
    cleanup();
    const again = setup(
      { kind: 'derived', featureId: 'derived#1' },
      { doc: t.documents.getState().document },
    );
    expect(screen.getByTestId('field-configuration')).toHaveProperty('value', 'cfg#2');
    fireEvent.change(screen.getByTestId('field-configuration'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('dialog-ok'));
    await waitFor(() => expect(again.onClose).toHaveBeenCalled());
    expect('configuration' in (again.features()[0] as DerivedFeature).source).toBe(false);
  });

  it('offers no configuration choice for a source without rows', async () => {
    const feature = await derivedOf(bracket('Bracket 6'), V1);
    setup({ kind: 'derived', featureId: 'derived#1' }, { doc: deriving(feature) });
    expect(screen.queryByTestId('field-configuration')).toBeNull();
  });
});
