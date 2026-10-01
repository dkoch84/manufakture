import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DerivedFeature, ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import {
  derivedOf,
  deriving,
  fakeLibrary,
  version,
  type FakeLibrary,
} from '../features/derived.test-fixture';
import { demoDocument } from '../model/demo';
import { createModelStore } from '../model/model';
import { createDocumentStore } from '../state/document';
import { createSelectionStore } from '../state/selection';
import { FeatureTree } from './FeatureTree';

const V1 = version('v-1', '6 mm', 1);
const V2 = version('v-2', '8 mm', 2);

const bracket = (name: string): ManufaktureDocument => ({
  ...demoDocument('doc-a'),
  name,
});

async function setup(
  options: {
    versions?: (typeof V1)[];
    library?: FakeLibrary | null;
    disabled?: boolean;
  } = {},
) {
  const feature = await derivedOf(bracket('Bracket'), V1);
  const documents = createDocumentStore(deriving(feature));
  const all = [
    { version: V1, document: bracket('Bracket') },
    { version: V2, document: bracket('Bracket at 8') },
  ];
  const lib =
    options.library === undefined
      ? fakeLibrary([
          {
            document: bracket('Bracket'),
            versions: all.filter((v) => (options.versions ?? [V1, V2]).includes(v.version)),
          },
        ])
      : options.library;
  const onOpenSource = vi.fn();
  render(
    <FeatureTree
      documents={documents}
      model={createModelStore()}
      selection={createSelectionStore()}
      onEdit={vi.fn()}
      library={lib}
      onOpenSource={onOpenSource}
      disabled={options.disabled ?? false}
    />,
  );
  const line = () => screen.getByTestId('derived-source-derived#1');
  const pinned = () => documents.getState().document.parts[0]!.features[0] as DerivedFeature;
  return { documents, lib, onOpenSource, line, pinned };
}

describe('a derived part in the feature tree', () => {
  it('shows its source and version, and that a newer version exists', async () => {
    const t = await setup();
    expect(t.line().textContent).toContain('From Bracket at 6 mm');
    expect(await screen.findByTestId('update-available-derived#1')).toBeTruthy();
    expect(screen.getByTestId('update-available-derived#1').getAttribute('title')).toBe(
      'Newer: 8 mm',
    );
    // One short call for the source's versions.
    expect(t.lib!.calls).toEqual(['listVersions doc-a']);
  });

  it('says nothing about updates when the pinned version is the newest', async () => {
    await setup({ versions: [V1] });
    await screen.findByTestId('update-derived#1');
    expect(screen.queryByTestId('update-available-derived#1')).toBeNull();
  });

  it('updates the pin to a chosen version as one undo step', async () => {
    const t = await setup();
    fireEvent.click(await screen.findByTestId('update-derived#1'));
    const list = screen.getByTestId('update-versions-derived#1');
    // The pinned version is marked and not offered again.
    expect(within(list).getByRole('button', { name: 'Use version 6 mm' })).toHaveProperty(
      'disabled',
      true,
    );
    const before = t.pinned();
    fireEvent.click(within(list).getByRole('button', { name: 'Use version 8 mm' }));
    await waitFor(() => expect(t.pinned().source.versionId).toBe('v-2'));
    expect(t.pinned()).toMatchObject({ ...before, source: { versionName: '8 mm' } });
    expect(JSON.parse(t.pinned().source.data)).toMatchObject({ name: 'Bracket at 8' });
    expect(t.documents.getState().undoLabel).toBe('Update Derived 1 to "8 mm"');
    await waitFor(() => expect(t.line().textContent).toContain('From Bracket at 8 mm'));
    await waitFor(() => expect(screen.queryByTestId('update-available-derived#1')).toBeNull());
    expect(screen.queryByTestId('update-versions-derived#1')).toBeNull();
    // Undo puts the old pin back.
    t.documents.getState().undo();
    expect(t.pinned()).toEqual(before);
  });

  it('says why an update failed, and changes nothing', async () => {
    const t = await setup();
    const lib = t.lib!;
    lib.readVersion = vi.fn(async () => ({ ok: false as const, message: 'It is damaged.' }));
    fireEvent.click(await screen.findByTestId('update-derived#1'));
    fireEvent.click(screen.getByRole('button', { name: 'Use version 8 mm' }));
    expect((await screen.findByTestId('tree-message')).textContent).toContain(
      'Derived 1 cannot be updated to "8 mm": It is damaged.',
    );
    expect(t.pinned().source.versionId).toBe('v-1');
  });

  it('opens the source at the pinned version', async () => {
    const t = await setup();
    fireEvent.click(await screen.findByTestId('open-source-derived#1'));
    expect(t.onOpenSource).toHaveBeenCalledWith(t.pinned().source);
  });

  it('shows when the source is not in this browser, with nothing to update or open', async () => {
    await setup({ library: fakeLibrary([]) });
    await waitFor(() => expect(screen.getByText('Source not here')).toBeTruthy());
    expect(screen.queryByTestId('update-derived#1')).toBeNull();
    expect(screen.queryByTestId('open-source-derived#1')).toBeNull();
  });

  it('only names the source without a library, and is off while the tree is', async () => {
    const t = await setup({ library: null });
    expect(t.line().textContent).toContain('From Bracket at 6 mm');
    expect(screen.queryByTestId('update-derived#1')).toBeNull();
    expect(screen.queryByText('Source not here')).toBeNull();
  });

  it('cannot update or open while the tree is disabled', async () => {
    await setup({ disabled: true });
    expect(await screen.findByTestId('update-derived#1')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('open-source-derived#1')).toHaveProperty('disabled', true);
  });
});
