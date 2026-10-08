import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DISCLAIMER_SHORT } from '@manufakture/domain-construction';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore } from '../../state/selection';
import { createMemberStore } from '../../viewport/memberStore';
import { documentConstruction } from '../settings';
import { TakeoffPanel } from './TakeoffPanel';
import {
  PART,
  shedDocument,
  shedFeatures,
  shedSets,
} from '@manufakture/domain-construction/fixtures/shed-model';
import { exportSourceStore } from '../../io/exportSource';
import { REFUSED_REVIEWS, agentSource } from '../../io/exportGate.test-fixture';
import { UNREVIEWED_EXPORT } from '@manufakture/io';

// Main is open: the export gate (T8.3c) lets these exports through unless a test says otherwise.
beforeEach(() => exportSourceStore.setState({ source: { id: 'main' } }));

function setup() {
  const documents = createDocumentStore(shedDocument({ prices: true }));
  const model = createModelStore();
  model.setState({ parts: [{ partId: PART, features: shedFeatures(), bodies: [] }] });
  const members = createMemberStore();
  members.getState().load(PART, { meshes: new Map(), sets: shedSets() });
  const selection = createSelectionStore();
  const download = vi.fn<(bytes: Uint8Array, name: string, type: string) => void>();
  render(
    <TakeoffPanel
      documents={documents}
      model={model}
      members={members}
      selection={selection}
      partId={PART}
      download={download}
    />,
  );
  return { documents, selection, download };
}

const section = (category: string) => screen.getByTestId(`takeoff-section-${category}`);
const quantities = (category: string) =>
  within(section(category))
    .getAllByTestId('takeoff-qty')
    .map((e) => Number(e.textContent));

describe('the takeoff panel', () => {
  it('shows the shed by section, as framed only, with the cost and the disclaimer', () => {
    setup();
    expect(screen.getByTestId('takeoff-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    expect(quantities('lumber')).toEqual([13, 4, 1, 51, 18, 13, 1, 1, 3]);
    expect(quantities('sheet')).toEqual([25, 6]);
    // A row to buy says what its quantity is cut into.
    const precut = within(section('lumber'))
      .getAllByTestId('takeoff-row')
      .find((r) => r.getAttribute('data-key') === 'lumber|us-2x4-precut-92-5-8')!;
    expect(within(precut).getByTestId('takeoff-counted').textContent).toBe('cut into 51 members');
    expect(within(precut).getByTestId('takeoff-flag-precut')).toBeTruthy();
    expect(screen.getByTestId('takeoff-section-lumber').textContent).toContain(
      'Quantities count sticks and precut studs to buy',
    );
    expect(screen.getByTestId('takeoff-cost').textContent).toBe('Cost of what to buy: $1,708.90');
    expect(screen.getByTestId('takeoff-subtotal-level-level-1').textContent).toContain('Level 1: ');
    expect(screen.getByTestId('takeoff-panel').textContent).not.toMatch(
      /rule of thumb|estimate|\b(safe|compliant|passes)\b/i,
    );
  });

  it('fits the side panel: six columns, the stock and its size in one cell', () => {
    setup();
    const table = screen.getByTestId('takeoff-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'Item', 'Stock, size', 'Qty', 'Total', 'Cost']);
    const row = within(section('sheet')).getAllByTestId('takeoff-row')[0]!;
    expect(row.querySelectorAll('td')).toHaveLength(6);
    const stock = within(row).getByTestId('takeoff-stock');
    expect(stock.parentElement).toBe(within(row).getByTestId('takeoff-size').parentElement);
    expect(stock.textContent).toBe('7/16" OSB');
  });

  it('selects the members of a row when it is clicked', () => {
    const t = setup();
    const precut = screen
      .getAllByTestId('takeoff-row')
      .find((r) => r.getAttribute('data-key') === 'lumber|us-2x4-precut-92-5-8')!;
    fireEvent.click(precut);
    const picked = t.selection.getState().selected;
    expect(picked).toHaveLength(51);
    expect(picked.every((s) => s.kind === 'member')).toBe(true);
    expect(precut.className).toBe('picked');
  });

  it('stores its settings as one undo step, and the rows follow them', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('takeoff-precuts'));
    fireEvent.change(screen.getByTestId('takeoff-waste'), { target: { value: '10' } });
    act(() => {
      fireEvent.click(screen.getByTestId('takeoff-settings-save'));
    });
    const data = documentConstruction(t.documents.getState().document);
    expect(data.ok && data.data?.stored.takeoff).toEqual({ precuts: false, wastePercent: 10 });
    // No precut row: the studs go to the 1D layout. Sheets with 10% waste: 28 and 7.
    expect(
      screen
        .getAllByTestId('takeoff-row')
        .some((r) => r.getAttribute('data-key')?.includes('precut')),
    ).toBe(false);
    expect(quantities('sheet')).toEqual([28, 7]);
    act(() => {
      t.documents.getState().undo();
    });
    expect(quantities('sheet')).toEqual([25, 6]);
  });

  it('refuses a bad setting with its message and stores nothing', () => {
    const t = setup();
    const before = t.documents.getState().document;
    fireEvent.change(screen.getByTestId('takeoff-lengths-us-2x4'), {
      target: { value: `8', 3"` },
    });
    fireEvent.click(screen.getByTestId('takeoff-settings-save'));
    expect(screen.getByTestId('takeoff-settings').textContent).toMatch(/3": Must be at least/);
    expect(t.documents.getState().document).toBe(before);
  });

  it('writes no file from an agent’s unreviewed branch, and says why', () => {
    for (const review of REFUSED_REVIEWS) {
      exportSourceStore.setState({ source: agentSource(review) });
      const t = setup();
      expect(screen.getByTestId('export-gate-refusal').textContent).toBe(UNREVIEWED_EXPORT);
      for (const id of ['takeoff-csv', 'takeoff-pdf']) {
        expect(screen.getByTestId(id)).toHaveProperty('disabled', true);
        fireEvent.click(screen.getByTestId(id));
      }
      expect(t.download).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('saves the CSV and the PDF, each with the disclaimer', () => {
    const t = setup();
    fireEvent.click(screen.getByTestId('takeoff-csv'));
    const [bytes, name, type] = t.download.mock.calls[0]!;
    expect([name, type]).toEqual(['Shed takeoff.csv', 'text/csv']);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith(`Takeoff: Shed\r\n"${DISCLAIMER_SHORT}"\r\n`)).toBe(true);
    fireEvent.click(screen.getByTestId('takeoff-pdf'));
    const [pdf, pdfName, pdfType] = t.download.mock.calls[1]!;
    expect([pdfName, pdfType]).toEqual(['Shed takeoff.pdf', 'application/pdf']);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
  });

  it('draws every face layout, the packed sheets and the lumber sticks', () => {
    setup();
    fireEvent.click(screen.getByTestId('takeoff-tab-layouts'));
    expect(screen.getAllByTestId('takeoff-face')).toHaveLength(7);
    const osb = screen.getByTestId('takeoff-sheets-us-osb-7-16');
    expect(within(osb).getByRole('heading').textContent).toBe(
      '7/16" OSB: 25 sheets (18 whole, 7 for the partial pieces)',
    );
    expect(within(osb).getAllByTestId('takeoff-packed').length).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId('takeoff-sticks-us-2x4')).getAllByTestId('cutlist-stick'),
    ).toHaveLength(18);
  });
});
