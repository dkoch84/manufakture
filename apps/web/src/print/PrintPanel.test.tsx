// The print workspace's panel and toolbar: setups, the printer and nozzle pickers, thresholds,
// items with their part and body pickers, references that are gone, and the orientation tools,
// each change one undo step.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManufaktureDocument } from '@manufakture/core';
import type { PartModel } from '../model/model';
import { createDocumentStore } from '../state/document';
import { IDLE_ANALYSIS } from './analysis';
import { PrintPanel } from './PrintPanel';
import { PrintToolbar } from './PrintToolbar';
import { resolveSetup } from './resolve';
import { activeSetup, createPrintUiStore } from './state';
import { editSetupCommand } from './commands';
import { apply, boxPart, partsDocument, withSetup } from './print.test-fixture';

afterEach(cleanup);

function mount(doc: ManufaktureDocument, parts: readonly PartModel[] = []) {
  const documents = createDocumentStore(doc);
  const printUi = createPrintUiStore();
  const onIssue = vi.fn();
  const resolved = () => {
    const d = documents.getState().document;
    const s = activeSetup(d, printUi.getState().setupId);
    return s ? resolveSetup(d, s, parts) : null;
  };
  const ui = () => (
    <>
      <PrintToolbar documents={documents} printUi={printUi} resolved={resolved()} />
      <PrintPanel
        documents={documents}
        printUi={printUi}
        parts={parts}
        resolved={resolved()}
        issues={[]}
        analysis={IDLE_ANALYSIS}
        onIssue={onIssue}
      />
    </>
  );
  const view = render(ui());
  // Re-render with the new resolution after a change, as the app does.
  const update = () => view.rerender(ui());
  documents.subscribe(update);
  printUi.subscribe(update);
  const doc_ = () => documents.getState().document;
  return { documents, printUi, onIssue, doc: doc_ };
}

const twoParts = () => [
  boxPart('part#1', [{ bodyId: 'extrude#1' }, { bodyId: 'extrude#3', min: [20, 0, 0] }]),
  boxPart('part#2', [{ bodyId: 'extrude#1' }]),
];

describe('PrintPanel', () => {
  it('starts a setup on the X1 Carbon with a 0.4 mm nozzle', () => {
    const { doc, documents } = mount(partsDocument());
    expect(screen.getByTestId('print-empty').textContent).toContain('Bambu Lab X1 Carbon');
    fireEvent.click(screen.getByTestId('print-add-setup'));
    expect(doc().print.setups).toEqual([
      { id: 'print#1', name: 'Plate 1', printer: 'bambu-x1c', nozzle: 0.4, items: [] },
    ]);
    expect((screen.getByTestId('print-printer') as HTMLInputElement).value).toBe('bambu-x1c');
    expect((screen.getByTestId('print-nozzle') as HTMLInputElement).value).toBe('0.4');
    expect(documents.getState().undoLabel).toBe('Add print setup');
  });

  it('switches printers and nozzles, each one undo step, and keeps a nozzle the printer has', () => {
    const { doc, documents } = mount(withSetup(partsDocument(), []).doc);
    fireEvent.change(screen.getByTestId('print-printer'), { target: { value: 'bambu-a1-mini' } });
    expect(doc().print.setups[0]).toMatchObject({ printer: 'bambu-a1-mini', nozzle: 0.4 });
    fireEvent.change(screen.getByTestId('print-nozzle'), { target: { value: '0.6' } });
    expect(doc().print.setups[0]!.nozzle).toBe(0.6);
    const options = within(screen.getByTestId('print-nozzle')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['0.2 mm', '0.4 mm', '0.6 mm', '0.8 mm']);
    documents.getState().undo();
    expect(doc().print.setups[0]!.nozzle).toBe(0.4);
  });

  it('shows a printer this build does not know, and lets another be picked', () => {
    const built = withSetup(partsDocument(), []);
    const setup = { ...built.doc.print.setups[0]!, printer: 'acme-9000' };
    const { doc } = mount({ ...built.doc, print: { ...built.doc.print, setups: [setup] } }, []);
    expect((screen.getByTestId('print-printer') as HTMLInputElement).value).toBe('acme-9000');
    expect(screen.getByTestId('print-setup-problem').textContent).toContain('acme-9000');
    fireEvent.change(screen.getByTestId('print-printer'), { target: { value: 'bambu-x1c' } });
    expect(doc().print.setups[0]!.printer).toBe('bambu-x1c');
  });

  it('renames, picks and deletes setups', () => {
    let d = withSetup(partsDocument(), []).doc;
    d = withSetup(d, []).doc;
    const { doc, printUi } = mount(d);
    const name = screen.getByTestId('print-setup-name');
    fireEvent.change(name, { target: { value: 'Jig' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(doc().print.setups.map((s) => s.name)).toEqual(['Jig', 'Plate 2']);
    fireEvent.change(screen.getByTestId('print-setup-select'), { target: { value: 'print#2' } });
    expect(printUi.getState().setupId).toBe('print#2');
    expect((screen.getByTestId('print-setup-name') as HTMLInputElement).value).toBe('Plate 2');
    fireEvent.click(screen.getByTestId('print-delete-setup'));
    expect(doc().print.setups.map((s) => s.id)).toEqual(['print#1']);
    expect((screen.getByTestId('print-setup-name') as HTMLInputElement).value).toBe('Jig');
  });

  it('adds items with the part and body pickers, and changes copies', () => {
    const { doc, printUi, documents } = mount(withSetup(partsDocument(2), []).doc, twoParts());
    const bodies = within(screen.getByTestId('print-add-body')).getAllByRole('option');
    expect(bodies.map((o) => o.textContent)).toEqual(['All bodies', 'Body 1', 'Body 2']);
    fireEvent.click(screen.getByTestId('print-add-item'));
    fireEvent.change(screen.getByTestId('print-add-part'), { target: { value: 'part#2' } });
    fireEvent.click(screen.getByTestId('print-add-item'));
    fireEvent.change(screen.getByTestId('print-add-part'), { target: { value: 'part#1' } });
    fireEvent.change(screen.getByTestId('print-add-body'), { target: { value: 'extrude#3' } });
    fireEvent.click(screen.getByTestId('print-add-item'));
    expect(doc().print.setups[0]!.items.map((i) => [i.id, i.part, i.body])).toEqual([
      ['item#1', 'part#1', undefined],
      ['item#2', 'part#2', undefined],
      ['item#3', 'part#1', 'extrude#3'],
    ]);
    expect(printUi.getState().itemId).toBe('item#3');
    expect(screen.getByTestId('print-item-item#3').textContent).toContain('Part 1: Body 2');
    // Copies: a draft while typing (it can be cleared), committed on Enter or blur, one step.
    const copies = () => screen.getByTestId('print-item-item#2-copies') as HTMLInputElement;
    const steps = documents.core.undoStack.length;
    fireEvent.change(copies(), { target: { value: '' } });
    expect(copies().value).toBe('');
    fireEvent.change(copies(), { target: { value: '1' } });
    fireEvent.change(copies(), { target: { value: '12' } });
    expect(doc().print.setups[0]!.items[1]).not.toHaveProperty('copies');
    fireEvent.keyDown(copies(), { key: 'Enter' });
    expect(doc().print.setups[0]!.items[1]!.copies).toBe(12);
    expect(documents.core.undoStack.length).toBe(steps + 1);
    expect(documents.getState().undoLabel).toBe('Change copies');
    // Cleared and left: the stored value comes back, nothing runs.
    fireEvent.change(copies(), { target: { value: '' } });
    fireEvent.blur(copies());
    expect(copies().value).toBe('12');
    expect(documents.core.undoStack.length).toBe(steps + 1);
    fireEvent.change(copies(), { target: { value: '1' } });
    fireEvent.blur(copies());
    expect(doc().print.setups[0]!.items[1]).not.toHaveProperty('copies');
    documents.getState().undo();
    expect(doc().print.setups[0]!.items[1]!.copies).toBe(12);
    expect(copies().value).toBe('12');
    fireEvent.click(screen.getByTestId('print-item-item#2-remove'));
    expect(doc().print.setups[0]!.items.map((i) => i.id)).toEqual(['item#1', 'item#3']);
  });

  it('says a body is gone, and takes another from the body picker', () => {
    const built = withSetup(partsDocument(2), [{ part: 'part#1', body: 'extrude#9' }]);
    const { doc } = mount(built.doc, twoParts());
    const row = screen.getByTestId('print-item-item#1');
    expect(row.getAttribute('data-status')).toBe('reference-lost');
    expect(screen.getByTestId('print-item-item#1-message').textContent).toContain(
      'Reference lost: The body it prints (extrude#9) is gone.',
    );
    const picker = screen.getByTestId('print-item-item#1-body');
    expect(within(picker).getByRole('option', { name: 'Missing: extrude#9' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'extrude#1' } });
    expect(doc().print.setups[0]!.items[0]!.body).toBe('extrude#1');
    expect(screen.getByTestId('print-item-item#1').getAttribute('data-status')).toBe('ok');
  });

  it('offers a re-pick for a lay-flat face that is gone', () => {
    const built = withSetup(partsDocument(), [
      {
        part: 'part#1',
        edit: (item) => ({
          ...item,
          orientation: { kind: 'layFlat', face: { id: 'r1', ref: { face: 'extrude#1:gone' } } },
        }),
      },
    ]);
    const { printUi } = mount(built.doc, [boxPart('part#1', [{ bodyId: 'extrude#1' }])]);
    fireEvent.click(screen.getByTestId('print-item-item#1-repick'));
    expect(printUi.getState()).toMatchObject({ layingFlat: true, itemId: 'item#1' });
    expect(screen.getByTestId('print-lay-flat-hint')).toBeTruthy();
  });

  it("previews thresholds with the active configuration's values, as the checks use them", () => {
    const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' }) as const;
    let d = apply(partsDocument(), { type: 'setVariable', name: 'wall', expression: mm('1') });
    d = apply(d, {
      type: 'batch',
      commands: [
        {
          type: 'setConfigParameter',
          parameter: { id: 'cp#1', name: 'Wall', kind: 'variable', variable: 'wall' },
        },
        { type: 'setConfigRow', row: { id: 'cfg#1', name: 'Thick', values: { 'cp#1': mm('2') } } },
        { type: 'setActiveConfiguration', rowId: 'cfg#1' },
      ],
    });
    const built = withSetup(d, []);
    const { doc } = mount(
      apply(built.doc, editSetupCommand(built.setupId, { thresholds: { minWall: mm('#wall') } })),
    );
    const setup = doc().print.setups[0]!;
    expect(resolveSetup(doc(), setup, []).thresholds.minWall).toBe(2);
    expect(screen.getByTestId('print-threshold-minWall-note').textContent).toContain('2.00 mm');
  });

  it('applies thresholds as expressions, and empty fields go back to the defaults', () => {
    const { doc, documents } = mount(withSetup(partsDocument(), []).doc);
    const field = (key: string) => screen.getByTestId(`print-threshold-${key}`);
    expect(screen.getByTestId('print-thresholds').textContent).toContain('Default 0.84 mm');
    fireEvent.change(field('minWall'), { target: { value: '1.2' } });
    fireEvent.change(field('overhang'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('print-thresholds-apply'));
    expect(doc().print.setups[0]!.thresholds).toEqual({
      overhang: { source: '50', lengthUnit: 'mm', angleUnit: 'deg' },
      minWall: { source: '1.2', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    expect(documents.getState().undoLabel).toBe('Change print thresholds');
    // A value that does not evaluate cannot be applied.
    fireEvent.change(screen.getByTestId('print-threshold-minGap'), { target: { value: '#nope' } });
    expect((screen.getByTestId('print-thresholds-apply') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('print-threshold-minGap'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('print-threshold-minWall'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('print-threshold-overhang'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('print-thresholds-apply'));
    expect(doc().print.setups[0]).not.toHaveProperty('thresholds');
  });

  it('says whether the items fit the bed', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    mount(built.doc, [boxPart('part#1', [{ bodyId: 'extrude#1', size: [200, 10, 10] }])]);
    expect(screen.getByTestId('print-bed-fit').getAttribute('data-fits')).toBe('true');
    fireEvent.change(screen.getByTestId('print-printer'), { target: { value: 'bambu-a1-mini' } });
    expect(screen.getByTestId('print-bed-fit').getAttribute('data-fits')).toBe('false');
    expect(screen.getByTestId('print-bed-fit').textContent).toContain(
      "Does not fit the Bambu Lab A1 mini's bed.",
    );
  });
});

describe('PrintToolbar', () => {
  it('turns the active item, resets it, and undo takes a turn back', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const { doc, documents } = mount(built.doc, [boxPart('part#1', [{ bodyId: 'extrude#1' }])]);
    const orientation = () => doc().print.setups[0]!.items[0]!.orientation;
    expect((screen.getByTestId('print-reset') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('print-rotate-x'));
    expect(orientation()).toMatchObject({ kind: 'rotate', x: { source: '90' } });
    fireEvent.click(screen.getByTestId('print-rotate-z'));
    expect(orientation()).toMatchObject({ kind: 'rotate', z: { source: '(0) + 90 deg' } });
    expect(documents.getState().undoLabel).toBe('Turn about Z');
    documents.getState().undo();
    expect(orientation()).toMatchObject({ kind: 'rotate', z: { source: '0' } });
    fireEvent.click(screen.getByTestId('print-reset'));
    expect(orientation()).toEqual({ kind: 'asModelled' });
  });

  it('arms lay flat and switches the shading', () => {
    const built = withSetup(partsDocument(), [{ part: 'part#1' }]);
    const { printUi } = mount(built.doc, []);
    fireEvent.click(screen.getByTestId('print-lay-flat'));
    expect(printUi.getState().layingFlat).toBe(true);
    expect(screen.getByTestId('print-lay-flat').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('print-shading-thickness'));
    expect(printUi.getState().shading).toBe('thickness');
    expect(screen.getByTestId('print-shading-thickness').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('print-legend').textContent).toContain('Thin wall');
  });

  it('has nothing to turn without an item', () => {
    mount(withSetup(partsDocument(), []).doc);
    for (const id of ['print-lay-flat', 'print-rotate-x', 'print-rotate-y', 'print-rotate-z']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
