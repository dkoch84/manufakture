import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrientedSizesResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore } from '../../state/selection';
import { cutListCsv, documentCutList } from '@manufakture/domain-wood';
import { CutListPanel } from './CutListPanel';
import { localNester } from './nester';
import type { Sizer } from './sizer';
import { bookshelfDocument, bookshelfModel, IN, withOakPanel } from './cutlist.test-fixture';

function setup(options: { extras?: boolean; sizer?: Sizer } = {}) {
  const doc = options.extras ? withOakPanel(bookshelfDocument()) : bookshelfDocument();
  const documents = createDocumentStore(doc);
  const model = bookshelfModel(options.extras ? { extras: true } : {});
  model.setState({ document: doc });
  const selection = createSelectionStore();
  const download = vi.fn<(bytes: Uint8Array, name: string, type: string) => void>();
  render(
    <CutListPanel
      documents={documents}
      model={model}
      selection={selection}
      sizer={options.sizer ?? null}
      createNester={localNester}
      download={download}
    />,
  );
  return { doc, documents, model, selection, download };
}

const rows = () => screen.getAllByTestId('cutlist-row');
const items = () => screen.getAllByTestId('cutlist-item').map((e) => e.textContent);

describe('the cut list panel', () => {
  it('lists the bookshelf grouped by stock, with flags, totals and board feet', () => {
    setup();
    expect(items()).toEqual(['Side 1, 2', 'Top, Bottom, Shelf 1-3', 'Rail', 'Glued top']);
    const ply = screen.getByTestId('cutlist-group-us-ply-23-32');
    expect(
      within(ply)
        .getAllByTestId('cutlist-qty')
        .map((e) => e.textContent),
    ).toEqual(['2', '5']);
    expect(within(ply).getAllByTestId('cutlist-size')[1]!.textContent).toBe(
      '29" x 11-1/4" x 23/32"',
    );
    expect(screen.getByTestId('cutlist-flag-actual-width').textContent).toContain('ripped');
    expect(screen.getByTestId('cutlist-totals').textContent).toContain('Sheet goods: 22.58 sq ft');
    expect(screen.getByTestId('cutlist-board-feet').textContent).toBe('9.50 bd ft in all');
    expect(screen.queryByTestId('cutlist-excluded')).toBeNull();
  });

  it('sorts within each stock group', () => {
    setup();
    fireEvent.click(screen.getByTestId('cutlist-sort-length'));
    expect(items()).toEqual(['Top, Bottom, Shelf 1-3', 'Side 1, 2', 'Glued top', 'Rail']);
    fireEvent.click(screen.getByTestId('cutlist-sort-length'));
    expect(items()).toEqual(['Side 1, 2', 'Top, Bottom, Shelf 1-3', 'Rail', 'Glued top']);
  });

  it('selects the bodies of a row when it is clicked', () => {
    const t = setup();
    fireEvent.click(rows()[0]!);
    const bodies = new Set(
      t.selection.getState().selected.map((s) => (s as unknown as { bodyId: string }).bodyId),
    );
    expect([...bodies]).toEqual(['part#1/extension#1', 'part#1/extension#2']);
    expect(rows()[0]!.className).toBe('picked');
  });

  it('shows the bodies it leaves out, and sizes a wood body through the sizer', async () => {
    const asked: unknown[] = [];
    const sizer: Sizer = {
      orientedSizes: (document, partId, options) => {
        asked.push({ partId, ...options });
        return Promise.resolve({
          generation: 1,
          partId,
          sizes: [{ bodyId: 'extrude#1', sizes: [40 * IN, 10 * IN, 1 * IN], source: 'obb' }],
          missing: [],
          failures: [],
        } satisfies OrientedSizesResult);
      },
    };
    setup({ extras: true, sizer });
    expect(screen.getByTestId('cutlist-excluded').textContent).toContain(
      '1 body is not in the cut list',
    );
    expect(screen.getByTestId('cutlist-excluded').textContent).toContain('copy of Shelf 3');
    // Only the oak extrusion is measured: boards never are, nor bodies of no wood.
    expect(asked).toEqual([
      { partId: 'part#1', bodies: ['extrude#1'], skipExtensions: ['wood.board'] },
    ]);
    await waitFor(() => expect(items()).toContain('Oak panel'));
    expect(screen.getByTestId('cutlist-flag-estimated').textContent).toBe('sized from its shape');
  });

  it('lays out the sheets and lumber off the list, and lays them out again for a new kerf', async () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('cutlist-tab-layouts'));
    await waitFor(() => expect(screen.getAllByTestId('cutlist-sheet')).toHaveLength(1));
    expect(screen.getByTestId('cutlist-sheets-us-ply-23-32').textContent).toContain('1 sheet');
    expect(screen.getByTestId('cutlist-layout-note').textContent).toBe(
      '4. Glued top: 1 blank is wider than 2x4: glue up from several pieces (not in the lumber plan)',
    );
    expect(screen.getAllByTestId('cutlist-stick')).toHaveLength(1);

    fireEvent.click(screen.getByText('Saw and layout settings'));
    fireEvent.change(screen.getByTestId('cutlist-kerf'), { target: { value: '1/4' } });
    fireEvent.click(screen.getByTestId('cutlist-settings-save'));
    expect(t.documents.getState().document.domains?.wood).toEqual({
      schemaVersion: 1,
      data: { kerf: { source: '1/4', lengthUnit: 'in', angleUnit: 'deg' } },
    });
    await waitFor(() =>
      expect(screen.getByTestId('cutlist-sheets-us-ply-23-32').textContent).toContain('Kerf 1/4"'),
    );
    act(() => t.documents.getState().undo());
    expect(t.documents.getState().document.domains?.wood).toBeUndefined();
  });

  it('saves the cut list CSV and the PDF', async () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('cutlist-csv'));
    const [bytes, name, type] = t.download.mock.calls[0]!;
    expect([name, type]).toEqual(['Bookshelf cut list.csv', 'text/csv']);
    expect(new TextDecoder().decode(bytes)).toBe(
      cutListCsv(
        documentCutList({ document: t.doc, parts: t.model.getState().parts }),
        t.doc.units,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('cutlist-pdf')).not.toHaveProperty('disabled', true),
    );
    fireEvent.click(screen.getByTestId('cutlist-pdf'));
    const [pdf, pdfName] = t.download.mock.calls[1]!;
    expect(pdfName).toBe('Bookshelf cut list.pdf');
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
  });
});
