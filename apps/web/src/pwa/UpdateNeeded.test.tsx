import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUpdater, setAppUpdater, type AppUpdater } from './appUpdate';
import type { UpdateCheck } from './register';
import { createUpdateFlow, type UpdateFlow } from './updateFlow';
import { UpdateNeeded } from './UpdateNeeded';

function updater(results: UpdateCheck[], flow: UpdateFlow | null = null): AppUpdater {
  return {
    check: vi.fn(async () => results.shift() ?? 'none'),
    flow,
    reloadPage: vi.fn(),
  };
}

describe('UpdateNeeded', () => {
  afterEach(() => setAppUpdater(null));

  it('says why, and offers to update; nothing newer or offline lets the user try again', async () => {
    const u = updater(['none', 'offline']);
    render(<UpdateNeeded reason="document" updater={u} />);
    expect(screen.getByTestId('update-needed').textContent).toContain(
      'This document needs a newer version of manufakture',
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(screen.getByTestId('update-needed-result').textContent).toContain(
      'There is no newer version on this site yet',
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(screen.getByTestId('update-needed-result').textContent).toContain(
      'cannot reach its site',
    );
    expect(u.check).toHaveBeenCalledTimes(2);
  });

  it('a new version found: Reload once autosave has flushed, through the update flow', async () => {
    let saved: (ok: boolean) => void = () => undefined;
    const flush = vi.fn(() => new Promise<boolean>((r) => (saved = r)));
    const activate = vi.fn();
    const flow = createUpdateFlow({ flush, activate, reloadPage: vi.fn() });
    const u = updater([], flow);
    u.check = vi.fn(async () => {
      flow.updateFound();
      return 'ready' as const;
    });
    render(<UpdateNeeded reason="document" updater={u} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(screen.getByTestId('update-needed-result').textContent).toContain('saving your changes');
    await act(async () => saved(true));
    expect(screen.getByTestId('update-needed-result').textContent).toContain(
      'A new version is ready. Your changes are saved.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await act(async () => saved(true));
    expect(activate).toHaveBeenCalledTimes(1);
    flow.stop();
  });

  it('does not stay on "saving" when the corner offer is put off with Later', async () => {
    const flow = createUpdateFlow({ flush: () => Promise.resolve(true), activate: vi.fn() });
    const u = updater([], flow);
    u.check = vi.fn(async () => {
      flow.updateFound();
      return 'ready' as const;
    });
    render(<UpdateNeeded reason="document" updater={u} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    act(() => flow.dismiss());
    expect(screen.getByTestId('update-needed-result').textContent).toContain(
      'waits until you reload',
    );
    // Asked for again: offered again.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    flow.stop();
  });

  it('with no service worker, Reload loads the page again', async () => {
    render(<UpdateNeeded reason="sync-protocol" />);
    expect(appUpdater().flow).toBeNull();
    expect(screen.getByTestId('update-needed').textContent).toContain('The sync server needs');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(screen.getByTestId('update-needed-result').textContent).toContain('Reload');
  });

  it('uses the running updater once startPwa installed one', async () => {
    const check = vi.fn(async () => 'none' as const);
    setAppUpdater({ check, flow: null });
    render(<UpdateNeeded reason="document" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update the app' })));
    expect(check).toHaveBeenCalledTimes(1);
  });
});
