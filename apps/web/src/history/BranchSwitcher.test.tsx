import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_BRANCH, type Branch } from '../persistence/library';
import { BranchSwitcher } from './BranchSwitcher';

const branches: Branch[] = [
  { id: MAIN_BRANCH, name: 'Main', fromVersion: null, createdAt: '' },
  { id: 'b-1', name: 'Wide', fromVersion: 'v-1', createdAt: '2026-09-30T12:00:00.000Z' },
];

function setup(current: string, overrides: Partial<Parameters<typeof BranchSwitcher>[0]> = {}) {
  const props = {
    branches,
    current,
    onSwitch: vi.fn(),
    onRename: vi.fn(async () => null as string | null),
    onDelete: vi.fn(async () => null as string | null),
    ...overrides,
  };
  render(<BranchSwitcher {...props} />);
  return props;
}

describe('the branch switcher', () => {
  it('lists the branches, main first, and switches', () => {
    const props = setup(MAIN_BRANCH);
    const select = screen.getByTestId('branch-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Main', 'Wide']);
    expect(select.value).toBe(MAIN_BRANCH);
    // Main cannot be renamed or deleted.
    expect(screen.queryByTestId('branch-rename')).toBeNull();
    expect(screen.queryByTestId('branch-delete')).toBeNull();
    fireEvent.change(select, { target: { value: 'b-1' } });
    expect(props.onSwitch).toHaveBeenCalledWith('b-1');
  });

  it('renames the open branch, saying why when that fails', async () => {
    const onRename = vi.fn(async (_id: string, name: string) =>
      name === 'Main' ? 'There is a branch called "Main" already.' : null,
    );
    setup('b-1', { onRename });
    fireEvent.click(screen.getByTestId('branch-rename'));
    const input = screen.getByTestId('branch-rename-name') as HTMLInputElement;
    expect(input.value).toBe('Wide');
    fireEvent.change(input, { target: { value: 'Main' } });
    fireEvent.click(screen.getByTestId('branch-rename-save'));
    await waitFor(() =>
      expect(screen.getByTestId('branch-switcher-error').textContent).toBe(
        'There is a branch called "Main" already.',
      ),
    );
    fireEvent.change(input, { target: { value: ' Wider ' } });
    fireEvent.click(screen.getByTestId('branch-rename-save'));
    await waitFor(() => expect(screen.queryByTestId('branch-rename-name')).toBeNull());
    expect(onRename).toHaveBeenLastCalledWith('b-1', 'Wider');
  });

  it('deletes the open branch only once confirmed', async () => {
    const props = setup('b-1');
    fireEvent.click(screen.getByTestId('branch-delete'));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect((screen.getByTestId('branch-select') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('branch-delete-confirm'));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith('b-1'));
  });
});
