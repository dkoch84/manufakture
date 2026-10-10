import { createDocument } from '@manufakture/core';
import { DISCLAIMER_SHORT, parseCsv } from '@manufakture/domain-mech';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { MechPartsButton, PartsDialog } from './PartsDialog';

function setup() {
  const documents = createDocumentStore(createDocument({ id: 'd', name: 'Trainer' }));
  documents
    .getState()
    .execute({ type: 'addAssembly', assemblyId: 'assembly#1', name: 'Machine' }, 'Assembly');
  const download = vi.fn<(bytes: Uint8Array, name: string, type: string) => void>();
  render(<PartsDialog documents={documents} onClose={() => {}} download={download} />);
  return { documents, download };
}

const type = (name: string, value: string) =>
  fireEvent.change(screen.getByTestId(`parts-field-${name}`), { target: { value } });

const csvFile = (text: string) => new File([text], 'parts.csv', { type: 'text/csv' });

describe('the purchased parts dialog', () => {
  it('opens from the toolbar with the notice', () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    render(<MechPartsButton documents={documents} disabled={false} />);
    fireEvent.click(screen.getByTestId('parts-open'));
    expect(screen.getByTestId('parts-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    expect(screen.getByTestId('parts-entry-bearing/skf-6005-2rsh@1').textContent).toMatch(
      /not verified/,
    );
  });

  it('adds an entry from a datasheet, places it in the assembly and lists it with ratings', async () => {
    const { documents, download } = setup();
    fireEvent.click(screen.getByTestId('parts-new'));
    type('maker', 'Acme');
    type('partNumber', '6001-2RS');
    type('dynamicLoad', '5.1 kN');
    type('staticLoad', '2360');
    type('limitingSpeed', '3000 rpm');
    type('dim.innerDiameter', '12');
    type('dim.outerDiameter', '28');
    type('dim.width', '8');
    type('sourceUrl', 'javascript:alert(1)');
    type('sourceTitle', 'Datasheet');
    type('sourceRead', '2026-10-10');
    fireEvent.click(screen.getByTestId('parts-add'));
    expect(screen.getByTestId('parts-form-problems').textContent).toMatch(/sourceUrl/);
    expect(documents.getState().document.mech).toBeUndefined();
    type('sourceUrl', 'https://acme.example/6001');
    fireEvent.click(screen.getByTestId('parts-add'));
    const entry = documents.getState().document.mech!.catalog![0]!;
    expect(entry).toMatchObject({
      id: 'entry#1',
      family: 'bearing',
      verified: false,
      ratings: { dynamicLoad: { value: 5100 }, staticLoad: { value: 2360 } },
    });

    fireEvent.change(screen.getByTestId('parts-assembly'), { target: { value: 'assembly#1' } });
    fireEvent.click(screen.getByTestId('parts-place-entry#1'));
    await waitFor(() => expect(screen.getByTestId('parts-message').textContent).toMatch(/inst#1/));
    const doc = documents.getState().document;
    expect(doc.assemblies[0]!.instances).toHaveLength(1);
    expect(doc.mech!.purchased![0]).toMatchObject({ id: 'pp#1', part: 'part#2' });
    const bom = screen.getByTestId('parts-bom').textContent!;
    expect(bom).toContain('C at least 5100 N; C0 at least 2360 N; n at least 3000 rpm');

    fireEvent.click(screen.getByTestId('parts-save-bom'));
    const [bytes, name] = download.mock.calls[0]!;
    expect(name).toMatch(/\.csv$/);
    const rows = parseCsv(new TextDecoder().decode(bytes)).map((r) => r.fields);
    expect(rows[1]!.slice(0, 3)).toEqual(['Bearing Acme 6001-2RS', '', '1']);

    // Placing is one undo step.
    documents.getState().undo();
    expect(documents.getState().document.mech!.purchased).toBeUndefined();
    expect(documents.getState().document.assemblies[0]!.instances).toHaveLength(0);
  });

  it('shows a BOM quantity rounded, not with floating point noise', () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    documents.getState().execute(
      {
        type: 'setPurchasedUse',
        use: {
          id: 'pp#1',
          entry: { source: 'builtin', id: 'bearing/skf-6005-2rsh', version: 1 },
          quantity: { source: '0.1 + 0.2', lengthUnit: 'mm', angleUnit: 'deg' },
          alternates: [],
        },
      },
      'Use',
    );
    render(<PartsDialog documents={documents} onClose={() => {}} />);
    const cells = [...screen.getByTestId('parts-bom').querySelectorAll('td')].map(
      (td) => td.textContent,
    );
    expect(cells[1]).toBe('0.3');
  });

  it('imports entries from CSV, and refuses a file with a malformed row by line', async () => {
    const { documents } = setup();
    const input = screen.getByTestId('parts-csv');
    fireEvent.change(input, {
      target: {
        files: [
          csvFile('family,maker,partNumber,dynamicLoad\nbearing,A,1,5 kN\nbearing,A,2,5 V\n'),
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('parts-csv-problems').textContent).toMatch(/^line 3, dynamicLoad/),
    );
    expect(documents.getState().document.mech).toBeUndefined();
    fireEvent.change(input, {
      target: { files: [csvFile('family,maker,partNumber,dynamicLoad\nbearing,A,1,5 kN\n')] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('parts-message').textContent).toMatch(/Imported 1 entries/),
    );
    expect(documents.getState().document.mech!.catalog).toHaveLength(1);
    expect(screen.getByTestId('parts-entry-entry#1')).toBeTruthy();
  });
});
