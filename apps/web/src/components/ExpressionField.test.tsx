import type { DisplayUnits } from '@manufakture/core';
import { angleQuantity, lengthQuantity } from '@manufakture/units';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExpressionField, type ExpressionFieldProps } from './ExpressionField';

const MM: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const variables = {
  width: lengthQuantity(40),
  wall: lengthQuantity(3),
  slope: angleQuantity(Math.PI / 4),
};

function Harness(props: Partial<ExpressionFieldProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <ExpressionField
      label="Depth"
      testId="depth"
      kind="length"
      units={MM}
      variables={variables}
      {...props}
      value={value}
      onChange={setValue}
    />
  );
}

function setup(props: Partial<ExpressionFieldProps> & { initial?: string } = {}) {
  const onKeyDown = vi.fn();
  render(
    <div onKeyDown={onKeyDown}>
      <Harness {...props} />
    </div>,
  );
  const input = screen.getByRole('combobox', { name: 'Depth' }) as HTMLInputElement;
  const type = (value: string) => {
    fireEvent.change(input, { target: { value, selectionStart: value.length } });
    input.setSelectionRange(value.length, value.length);
    fireEvent.select(input);
  };
  return { input, type, onKeyDown };
}

describe('ExpressionField', () => {
  it('takes feed rates and spindle speeds (CAM), a bare number in the display unit per minute', () => {
    const { type } = setup({ kind: 'feed' });
    type('1200');
    expect(screen.getByTestId('depth-note').textContent).toBe('= 1200 mm/min');
    type('50 in/min');
    expect(screen.getByTestId('depth-note').textContent).toBe('= 1270 mm/min');
    type('3 mm');
    expect(screen.getByTestId('depth-note').textContent).toContain('Expected');
    cleanup();
    const speed = setup({ kind: 'spindleSpeed' });
    speed.type('18000');
    expect(screen.getByTestId('depth-note').textContent).toBe('= 18000 rpm');
  });

  it('shows the value in the display units, and an error with its range', () => {
    const { type } = setup();
    type('#width / 2 + 1/2"');
    expect(screen.getByTestId('depth-note').textContent).toBe('= 32.70 mm');
    type('2 * #widht');
    const note = screen.getByTestId('depth-note');
    expect(note.textContent).toContain('Unknown variable');
    expect(note.querySelector('mark')!.textContent).toBe('#widht');
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe('true');
    type('#slope');
    expect(screen.getByTestId('depth-note').textContent).toContain('Expected a length');
  });

  it('completes # names from the keyboard, following the combobox pattern', () => {
    const { input, type, onKeyDown } = setup();
    const listbox = screen.getByRole('listbox', { hidden: true });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);

    type('2*#w');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['#width40.00 mm', '#wall3.00 mm']);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('2*#wall');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    // The list took the keys: nothing reached the surrounding dialog.
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.getByTestId('depth-note').textContent).toBe('= 6.00 mm');

    // With the list closed, Enter is the dialog's again.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('takes Tab to complete and Escape to close the list only', () => {
    const { input, type, onKeyDown } = setup();
    type('#sl');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('#slope');

    type('#w');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('#w');
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    // Typing again opens it again.
    type('#wa');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['#wall3.00 mm']);
  });

  it('completes with the mouse without losing focus', () => {
    const { input, type } = setup();
    input.focus();
    type('#');
    const wall = screen.getByRole('option', { name: /wall/ });
    const down = fireEvent.mouseDown(wall);
    expect(down).toBe(false); // default prevented: the input keeps the focus
    fireEvent.click(wall);
    expect(input.value).toBe('#wall');
  });

  it('offers only the names it is given', () => {
    const { input, type } = setup({ names: ['wall'] });
    type('#');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows an outside error instead of the live check, and runs the extra check', () => {
    const { type } = setup({
      error: 'Pick one first.',
      validate: (v) => (v > 0 ? null : 'Must be more than zero.'),
    });
    type('5');
    expect(screen.getByTestId('depth-note').textContent).toBe('Pick one first.');
  });

  it('uses separate test ids for the note in the compact variant', () => {
    render(
      <ExpressionField
        variant="compact"
        ariaLabel="Dimension value"
        testId="dimension-input"
        errorTestId="dimension-error"
        previewTestId="dimension-preview"
        value="-2"
        kind="length"
        units={MM}
        variables={variables}
        validate={(v) => (v > 0 ? null : 'The value must be positive.')}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('The value must be positive.');
    expect(screen.getByTestId('dimension-error')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Dimension value' })).toBeDefined();
  });
});
