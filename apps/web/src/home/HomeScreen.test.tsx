import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary } from '../persistence/library';
import { MAX_MFK_FILE_BYTES } from '../persistence/limits';
import { emptyDocument, partDocument } from '../persistence/test-fixtures';
import { createDocumentStore } from '../state/document';
import { homeActions } from './actions';
import { HomeScreen } from './HomeScreen';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 26, 12, 0, clock++));

async function setup(kind: 'stored' | 'empty' = 'stored') {
  let n = 0;
  const library = new DocumentLibrary(new MemoryBackend(), { now, newId: () => `new-${++n}` });
  if (kind === 'stored') {
    await library.save(partDocument('a', 'Alpha'));
    await library.save(partDocument('b', 'Bravo'));
  }
  const documents = createDocumentStore(emptyDocument('scratch'));
  const show = vi.fn((doc) => documents.getState().load(doc));
  const download = vi.fn();
  const actions = homeActions({ library, documents, autosave: null, show, download });
  const onClose = vi.fn();
  const onPersist = vi.fn(async () => true);
  const storage = vi.fn(async () => ({ usage: 2048, quota: 1024 * 1024, persisted: false }));
  render(
    <HomeScreen
      actions={actions}
      kind="opfs"
      current={{ id: 'a', name: 'Alpha' }}
      onClose={onClose}
      storage={storage}
      onPersist={onPersist}
    />,
  );
  return { library, documents, show, download, onClose, onPersist };
}

const rows = async () => {
  const table = await screen.findByRole('table', { name: 'Documents' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
};

describe('HomeScreen', () => {
  it('lists documents most recent first, marks the open one, and shows storage use', async () => {
    await setup();
    expect(await rows()).toEqual(['Bravo', 'Alphaopen']);
    await waitFor(() =>
      expect(screen.getByTestId('storage-info').textContent).toContain(
        'Using 2.0 KB of 1.0 MB available.',
      ),
    );
  });

  it('asks the browser to keep the documents', async () => {
    const { onPersist } = await setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my documents' }));
    expect(onPersist).toHaveBeenCalled();
  });

  it('opens a document, and goes back to the open one', async () => {
    const { show, onClose } = await setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Bravo' }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(show.mock.calls[0]![0].id).toBe('b');
    fireEvent.click(screen.getByTestId('home-back'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renames, duplicates and deletes (after confirming)', async () => {
    const { library } = await setup();
    const row = async (id: string) => within(await screen.findByTestId(`doc-${id}`));

    fireEvent.click((await row('b')).getByRole('button', { name: 'Rename' }));
    const input = screen.getByTestId('rename-input');
    fireEvent.change(input, { target: { value: 'Charlie' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toBe('Renamed to Charlie.'),
    );
    await waitFor(async () => expect(await rows()).toEqual(['Charlie', 'Alphaopen']));

    fireEvent.click((await row('a')).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toBe('Made Alpha (copy).'),
    );
    await waitFor(async () => expect(await rows()).toContain('Alpha (copy)'));

    fireEvent.click((await row('b')).getByRole('button', { name: 'Delete' }));
    expect((await row('b')).getByText('Delete Charlie?')).toBeTruthy();
    fireEvent.click((await row('b')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click((await row('b')).getByRole('button', { name: 'Delete' }));
    fireEvent.click((await row('b')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('doc-b')).toBeNull());
    expect((await library.list()).map((d) => d.id).sort()).toEqual(['a', 'new-1']);
  });

  it('exports a .mfk and imports one from the file picker', async () => {
    const { download, show } = await setup();
    fireEvent.click(
      within(await screen.findByTestId('doc-a')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(download).toHaveBeenCalled());
    const [bytes, name] = download.mock.calls[0]!;
    expect(name).toBe('Alpha.mfk');

    const file = new File([bytes], 'Alpha.mfk');
    fireEvent.change(screen.getByTestId('mfk-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toBe('Imported Alpha.mfk as Alpha.'),
    );
    // Alpha exists, so the import got a new id.
    expect(show.mock.calls.at(-1)![0].id).toBe('new-1');

    fireEvent.change(screen.getByTestId('mfk-input'), {
      target: { files: [new File(['nope'], 'bad.mfk')] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^bad\.mfk: /));
  });

  it('says when there are no documents, and when nothing will be kept', async () => {
    await setup('empty');
    expect((await screen.findByText(/No saved documents yet/)).textContent).toContain(
      'New document',
    );
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toBe('Created Untitled.'),
    );
  });

  it('creates a fit-test coupon and lists it', async () => {
    const t = await setup('empty');
    fireEvent.click(screen.getByTestId('new-coupon'));
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toMatch(/^Created Fit-test coupon/),
    );
    expect(t.show).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual(['Fit-test coupon']);
  });

  it('warns that memory storage keeps nothing', async () => {
    const library = new DocumentLibrary(new MemoryBackend());
    const documents = createDocumentStore(emptyDocument('scratch'));
    const actions = homeActions({
      library,
      documents,
      autosave: null,
      show: vi.fn(),
      download: vi.fn(),
    });
    render(<HomeScreen actions={actions} kind="memory" current={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('storage-info').textContent).toMatch(/documents are lost/);
    expect(screen.queryByTestId('home-back')).toBeNull();
  });

  it('offers to save again or export when the open document could not be saved', async () => {
    const library = new DocumentLibrary(new MemoryBackend(), { locks: null });
    await library.save(partDocument('a', 'Alpha'));
    const documents = createDocumentStore(emptyDocument('scratch'));
    const real = homeActions({
      library,
      documents,
      autosave: null,
      show: vi.fn(),
      download: vi.fn(),
    });
    const stopped = { ok: false, unsaved: true, message: 'The changes to Scratch are not saved.' };
    const actions = {
      ...real,
      open: vi.fn(async () => stopped),
      retrySave: vi.fn(async () => ({ ok: true, message: 'Saved.' })),
      exportCurrent: vi.fn(async () => ({ ok: true, message: 'Exported Scratch.mfk.' })),
    };
    render(<HomeScreen actions={actions} kind="opfs" current={null} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    const status = await screen.findByRole('alert');
    expect(status.textContent).toMatch(/^The changes to Scratch are not saved\./);
    fireEvent.click(within(status).getByTestId('export-current'));
    await waitFor(() =>
      expect(screen.getByTestId('home-status').textContent).toBe('Exported Scratch.mfk.'),
    );
    expect(actions.exportCurrent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(await screen.findByTestId('retry-save'));
    await waitFor(() => expect(screen.getByTestId('home-status').textContent).toBe('Saved.'));
    expect(actions.retrySave).toHaveBeenCalledTimes(1);
  });

  it('refuses a picked file over the size limit without reading it', async () => {
    await setup();
    const file = new File([new Uint8Array(4)], 'huge.mfk');
    Object.defineProperty(file, 'size', { value: MAX_MFK_FILE_BYTES + 1 });
    const read = vi.fn();
    Object.defineProperty(file, 'arrayBuffer', { value: read });
    fireEvent.change(screen.getByTestId('mfk-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'huge.mfk is 256.0 MB; a .mfk file can be at most 256.0 MB.',
      ),
    );
    expect(read).not.toHaveBeenCalled();
  });
});
