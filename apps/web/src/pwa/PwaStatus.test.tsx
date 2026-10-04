import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PwaStatus, OFFLINE_READY_MS } from './PwaStatus';
import { createPwaStatus } from './register';
import { createUpdateFlow } from './updateFlow';

function setup(flush: () => Promise<boolean> = () => Promise.resolve(true)) {
  const activate = vi.fn();
  const flow = createUpdateFlow({ flush, activate, retryMs: 1000 });
  const status = createPwaStatus();
  render(<PwaStatus flow={flow} status={status} />);
  return { flow, status, activate };
}

describe('PwaStatus', () => {
  afterEach(() => vi.useRealTimers());

  it('shows nothing when there is nothing to say', () => {
    setup();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the first precache with its progress, then that the app works offline', () => {
    vi.useFakeTimers();
    const { status } = setup();
    act(() => status.setState({ precache: { loaded: 21_000_000, total: 42_000_000 } }));
    expect(screen.getByTestId('pwa-precache').textContent).toContain(
      'Saving for offline use: 21.0 of 42.0 MB',
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    act(() => status.setState({ precache: null, offlineReady: true }));
    expect(screen.getByTestId('pwa-offline-ready').textContent).toContain('Ready to work offline.');
    act(() => vi.advanceTimersByTime(OFFLINE_READY_MS));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers Reload only once autosave has flushed, and Reload activates the update', async () => {
    let finish: (saved: boolean) => void = () => undefined;
    const flush = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    const { flow, activate } = setup(flush);
    act(() => flow.updateFound());
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    await act(async () => finish(true));
    const reload = screen.getByRole<HTMLButtonElement>('button', { name: 'Reload' });
    expect(screen.getByTestId('pwa-update').textContent).toContain('Your changes are saved.');
    fireEvent.click(reload);
    expect(reload.disabled).toBe(true);
    await act(async () => finish(true));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('says why the update waits while saving fails', async () => {
    const { flow } = setup(() => Promise.resolve(false));
    await act(async () => flow.updateFound());
    expect(screen.getByTestId('pwa-update').textContent).toContain(
      'It will be offered once your changes are saved.',
    );
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    flow.stop();
  });

  it('Later hides the offer', async () => {
    const { flow } = setup();
    await act(async () => flow.updateFound());
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
