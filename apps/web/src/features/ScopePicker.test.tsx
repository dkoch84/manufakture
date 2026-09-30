import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ScopePicker } from './ScopePicker';

const BODIES = [
  { bodyId: 'extrude#1', name: 'Base' },
  { bodyId: 'extrude#3', name: 'Lid' },
  { bodyId: 'revolve#1', name: 'Knob' },
];

function Harness({ onChange }: { onChange: (scope: readonly string[] | undefined) => void }) {
  const [scope, setScope] = useState<readonly string[] | undefined>(undefined);
  return (
    <ScopePicker
      bodies={BODIES}
      scope={scope}
      onChange={(next) => {
        setScope(next);
        onChange(next);
      }}
    />
  );
}

const box = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

describe('ScopePicker', () => {
  it('starts at every body, with no list to choose from', () => {
    render(<ScopePicker bodies={BODIES} scope={undefined} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Bodies' })).toBeTruthy();
    expect(box('All bodies').checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Base' })).toBeNull();
  });

  it('narrows to chosen bodies in body order, and back to all', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box('All bodies'));
    expect(onChange).toHaveBeenLastCalledWith(['extrude#1', 'extrude#3', 'revolve#1']);
    fireEvent.click(box('Base'));
    fireEvent.click(box('Knob'));
    expect(onChange).toHaveBeenLastCalledWith(['extrude#3']);
    fireEvent.click(box('Base'));
    expect(onChange).toHaveBeenLastCalledWith(['extrude#1', 'extrude#3']);
    expect(box('Knob').checked).toBe(false);
    fireEvent.click(box('All bodies'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole('checkbox', { name: 'Base' })).toBeNull();
  });

  it('shows an error', () => {
    render(
      <ScopePicker
        bodies={BODIES}
        scope={[]}
        error="Choose at least one body."
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Choose at least one body.')).toBeTruthy();
  });
});
