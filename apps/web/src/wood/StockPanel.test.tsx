import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { buildBoard, newBoardForm } from './boards';
import { grainStore } from './grain';
import { StockPanel } from './StockPanel';
import { INCH_UNITS, woodDocument } from './wood.test-fixture';

function setup() {
  const documents = createDocumentStore(woodDocument(INCH_UNITS));
  // Two plywood panels from the same stock.
  for (let i = 0; i < 2; i++) {
    const doc = documents.getState().document;
    const r = buildBoard(newBoardForm(doc, 'part#1'), { doc, partId: 'part#1' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    documents.getState().execute(r.command, r.label);
  }
  render(<StockPanel documents={documents} />);
  const stock = () => documents.getState().document.domains?.stock;
  return { documents, stock };
}

const row = (id: string) => screen.getByTestId(`stock-row-${id}`);

describe('the stock panel', () => {
  it('overrides the plywood thickness for every board of it, as one undo step', () => {
    const t = setup();
    expect(within(row('us-ply-23-32')).getByTestId('stock-size').textContent).toBe('23/32"');
    fireEvent.click(within(row('us-ply-23-32')).getByTestId('stock-edit'));
    fireEvent.change(screen.getByTestId('override-thickness'), { target: { value: '18.2mm' } });
    fireEvent.click(screen.getByTestId('override-save'));
    expect(t.stock()).toEqual({
      schemaVersion: 1,
      data: {
        overrides: {
          'us-ply-23-32': {
            thickness: { source: '18.2mm', lengthUnit: 'in', angleUnit: 'deg' },
          },
        },
      },
    });
    expect(screen.queryByTestId('stock-editor')).toBeNull();
    expect(within(row('us-ply-23-32')).getByTestId('stock-size').textContent).toBe(
      '18.2mm (measured)',
    );
    t.documents.getState().undo();
    expect(t.stock()).toBeUndefined();
    t.documents.getState().redo();

    // Clearing it is one more step.
    fireEvent.click(within(row('us-ply-23-32')).getByTestId('stock-edit'));
    fireEvent.click(screen.getByTestId('override-clear'));
    expect(t.stock()).toBeUndefined();
  });

  it('refuses a variable, which domain settings never hold', () => {
    const t = setup();
    fireEvent.click(within(row('us-ply-23-32')).getByTestId('stock-edit'));
    fireEvent.change(screen.getByTestId('override-thickness'), { target: { value: '#t' } });
    fireEvent.click(screen.getByTestId('override-save'));
    expect(screen.getByTestId('stock-editor').textContent).toContain('constants only');
    expect(t.stock()).toBeUndefined();
  });

  it('overrides a stock no board uses yet, with a price', () => {
    const t = setup();
    fireEvent.change(screen.getByTestId('stock-add-picker'), { target: { value: 'us-2x4' } });
    fireEvent.click(screen.getByTestId('stock-add'));
    fireEvent.change(screen.getByTestId('override-price'), { target: { value: '4.98' } });
    fireEvent.change(screen.getByTestId('override-currency'), { target: { value: 'USD' } });
    fireEvent.click(screen.getByTestId('override-save'));
    expect(t.stock()?.data).toEqual({
      overrides: { 'us-2x4': { price: { amount: 4.98, per: 'piece', currency: 'USD' } } },
    });
    expect(row('us-2x4').textContent).toContain('4.98 USD per piece; no board uses it');
  });

  it('turns grain arrows off and on', () => {
    setup();
    expect(grainStore.getState().show).toBe(true);
    fireEvent.click(screen.getByTestId('stock-show-grain'));
    expect(grainStore.getState().show).toBe(false);
    fireEvent.click(screen.getByTestId('stock-show-grain'));
    expect(grainStore.getState().show).toBe(true);
  });
});
