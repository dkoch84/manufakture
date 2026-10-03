import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createSelectionStore } from '../state/selection';
import { createViewSettingsStore } from '../state/viewSettings';
import { memberRef } from './members';
import { Toolbar } from './Toolbar';

describe('Toolbar selection filter', () => {
  it('lists members next to faces, edges and vertices', () => {
    render(
      <Toolbar
        viewport={null}
        selection={createSelectionStore()}
        settings={createViewSettingsStore()}
      />,
    );
    for (const label of ['Faces', 'Edges', 'Vertices', 'Members']) {
      expect(screen.getByRole('checkbox', { name: label })).toHaveProperty('checked', true);
    }
  });

  it('switching Members off stops members being hovered or picked', () => {
    const selection = createSelectionStore();
    render(<Toolbar viewport={null} selection={selection} settings={createViewSettingsStore()} />);
    const stud = memberRef('wall-s:s1');
    act(() => selection.getState().setHovered(stud));
    expect(selection.getState().hovered).toEqual(stud);

    const box = screen.getByRole('checkbox', { name: 'Members' });
    fireEvent.click(box);
    expect(box).toHaveProperty('checked', false);
    expect(selection.getState().isKindEnabled('member')).toBe(false);
    // The hover goes at once; neither hover nor a click takes a member any more.
    expect(selection.getState().hovered).toBeNull();
    act(() => selection.getState().setHovered(stud));
    act(() => selection.getState().click(stud, 'replace'));
    expect(selection.getState().hovered).toBeNull();
    expect(selection.getState().selected).toEqual([]);

    fireEvent.click(box);
    expect(selection.getState().isKindEnabled('member')).toBe(true);
    act(() => selection.getState().click(stud, 'replace'));
    expect(selection.getState().selected).toEqual([stud]);
  });
});
