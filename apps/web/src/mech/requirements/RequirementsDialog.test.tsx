import { createDocument, parseDocument, serialize, type Command } from '@manufakture/core';
import { DISCLAIMER_SHORT, RESISTANCE_MODES } from '@manufakture/domain-mech';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { MechRequirementsButton, RequirementsDialog } from './RequirementsDialog';

function setup() {
  const documents = createDocumentStore(createDocument({ id: 'd', name: 'Trainer' }));
  render(<RequirementsDialog documents={documents} onClose={() => {}} />);
  return { documents };
}

const x = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('the requirements and load cases dialog', () => {
  it('opens from the toolbar with the notice', () => {
    const documents = createDocumentStore(createDocument({ id: 'd', name: 'D' }));
    render(<MechRequirementsButton documents={documents} disabled={false} />);
    fireEvent.click(screen.getByTestId('req-open'));
    expect(screen.getByTestId('req-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
  });

  it('fills in the cable trainer template, edits it and saves it', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('req-template-add'));
    expect(screen.getByTestId('req-message').textContent).toMatch(
      /Added 14 requirements and 5 load cases/,
    );
    const doc = documents.getState().document;
    expect(doc.mech!.requirements).toHaveLength(14);
    expect(doc.mech!.loadCases).toHaveLength(5);
    expect(screen.getByTestId('req-table').querySelectorAll('tbody tr')).toHaveLength(14);
    expect((screen.getByTestId('req-value-0-0') as HTMLInputElement).value).toBe('200 lbf');

    // The user changes a target to their own; a value of the wrong kind is refused by field.
    type('req-value-0-0', '2 m/s');
    fireEvent.click(screen.getByTestId('req-save'));
    expect(screen.getByTestId('req-problems').textContent).toMatch(/R1 Maximum force: value/);
    type('req-value-0-0', '220 lbf');
    fireEvent.click(screen.getByTestId('req-save'));
    expect(screen.queryByTestId('req-problems')).toBeNull();
    const saved = documents.getState().document;
    expect(saved.mech!.requirements![0]!.value).toMatchObject({ source: '220 lbf' });

    // Saved to a file and loaded back.
    const loaded = parseDocument(JSON.parse(serialize(saved)));
    expect(loaded.ok && loaded.value.document.mech).toEqual(saved.mech);
  });

  it('adds a requirement with its load case', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('req-template-add'));
    fireEvent.click(screen.getByTestId('req-add'));
    const i = 14;
    type(`req-name-${i}`, 'Envelope for the bag');
    type(`req-quantity-${i}`, 'envelope');
    type(`req-value-${i}-0`, '300 mm');
    type(`req-value-${i}-1`, '200 mm');
    type(`req-value-${i}-2`, '150 mm');
    fireEvent.click(screen.getByTestId('req-save'));
    const r = documents.getState().document.mech!.requirements!.at(-1)!;
    expect(r).toMatchObject({ id: 'req#15', name: 'Envelope for the bag', comparison: 'within' });
    expect(r.value).toHaveLength(3);
  });

  it('plots each mode from its law and saves a load case with its duty cycle', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('lc-new'));
    for (const mode of RESISTANCE_MODES) {
      type('lc-field-mode', mode);
      if (mode === 'eccentric') type('lc-field-factor', '1.3');
      if (mode === 'band') type('lc-field-rate', '200 N/m');
      if (mode === 'chains') {
        type('lc-field-rate', '300 N/m');
        type('lc-field-from', '0.2 m');
      }
      if (mode === 'isokinetic') type('lc-field-speed', '0.5 m/s');
      if (mode === 'damper') type('lc-field-coefficient', '100 N*s/m');
      if (mode === 'rowing') type('lc-field-coefficient', '50 N*s^2/m^2');
      if (mode === 'isometric') type('lc-field-duration', '30 s');
      if (mode === 'table') type('lc-field-tablePoints', '0, 50\n0.6, 90');
      const pos = screen.getByTestId('lc-plot-position');
      const speed = screen.getByTestId('lc-plot-speed');
      expect(pos.querySelectorAll('path.law-line')).toHaveLength(2);
      expect(speed.querySelectorAll('path.law-line')).toHaveLength(1);
      expect(pos.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(100);
    }
    type('lc-field-mode', 'eccentric');
    type('lc-field-name', 'Eccentric sets');
    type('lc-field-sets', '3');
    type('lc-field-rest', '90 s');
    expect(screen.getByTestId('lc-duty').textContent).toMatch(/3 sets of 10 reps with 90 s rests/);
    fireEvent.click(screen.getByTestId('lc-save'));
    const lc = documents.getState().document.mech!.loadCases![0]!;
    expect(lc).toMatchObject({
      id: 'lc#1',
      name: 'Eccentric sets',
      dynamic: { mode: { kind: 'eccentric', factor: { source: '1.3' } }, sets: { source: '3' } },
    });
    expect(screen.getByTestId('req-message').textContent).toMatch(/Saved load case Eccentric sets/);
  });

  it('names a load case field that does not read and leaves the document alone', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('lc-new'));
    type('lc-field-force', '200');
    expect(screen.getByTestId('lc-plot-missing').textContent).toMatch(/dynamic\.force/);
    fireEvent.click(screen.getByTestId('lc-save'));
    expect(screen.getByTestId('lc-problems').textContent).toMatch(/dynamic\.force/);
    expect(documents.getState().document.mech).toBeUndefined();
  });

  it('edits and deletes a template load case', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('req-template-add'));
    fireEvent.click(screen.getByTestId('lc-select-lc#4'));
    const form = screen.getByTestId('lc-form');
    expect((within(form).getByTestId('lc-field-sets') as HTMLInputElement).value).toBe('13');
    type('lc-field-reps', '12');
    fireEvent.click(screen.getByTestId('lc-save'));
    expect(documents.getState().document.mech!.loadCases![3]!.dynamic!.reps.source).toBe('12');
    fireEvent.click(screen.getByTestId('lc-select-lc#5'));
    fireEvent.click(screen.getByTestId('lc-delete'));
    expect(documents.getState().document.mech!.loadCases).toHaveLength(4);
  });

  it('adds, removes and adds requirements without reusing an id', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('req-add'));
    fireEvent.click(screen.getByTestId('req-add'));
    fireEvent.click(screen.getByTestId('req-remove-0'));
    fireEvent.click(screen.getByTestId('req-add'));
    for (const i of [0, 1]) type(`req-value-${i}-0`, `${i + 1}00 N`);
    fireEvent.click(screen.getByTestId('req-save'));
    expect(screen.queryByTestId('req-problems')).toBeNull();
    expect(documents.getState().document.mech!.requirements!.map((r) => r.id)).toEqual([
      'req#2',
      'req#3',
    ]);
  });

  it('leaves untouched values as stored when saving after the display units changed', () => {
    const { documents } = setup();
    const run = (c: Command) => {
      // Inside act, so the dialog has rendered the change before the next click.
      act(() => {
        const r = documents.getState().execute(c, 'Test');
        expect(r.ok ? '' : r.error.message).toBe('');
      });
    };
    run({
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#1',
        name: 'Bare stroke',
        dynamic: {
          mode: { kind: 'chains', rate: x('300 N/m'), from: x('200') },
          force: x('100 N'),
          motion: {
            kind: 'half-cosine',
            stroke: x('600'),
            pullSpeed: x('1 m/s'),
            returnSpeed: x('1 m/s'),
            pause: x('0 s'),
          },
          reps: x('5'),
        },
      },
    });
    run({
      type: 'setMechRequirements',
      requirements: [
        { id: 'req#2', name: 'Travel', quantity: 'travel', comparison: '>=', value: x('2850') },
      ],
    });
    const before = documents.getState().document.mech!;
    const units = documents.getState().document.units;
    run({ type: 'setDisplayUnits', units: { ...units, length: { ...units.length, unit: 'in' } } });
    fireEvent.click(screen.getByTestId('req-save'));
    expect(screen.queryByTestId('req-problems')).toBeNull();
    fireEvent.click(screen.getByTestId('lc-select-lc#1'));
    fireEvent.click(screen.getByTestId('lc-save'));
    expect(screen.queryByTestId('lc-problems')).toBeNull();
    const after = documents.getState().document.mech!;
    expect(after.requirements).toEqual(before.requirements);
    expect(after.loadCases).toEqual(before.loadCases);
    expect(after.loadCases![0]!.dynamic!.motion).toMatchObject({
      stroke: { source: '600', lengthUnit: 'mm' },
    });
  });
});
