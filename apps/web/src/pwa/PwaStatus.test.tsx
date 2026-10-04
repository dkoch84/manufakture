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

  it('another tab updated the app: Reload is offered here too, and reloads the page', async () => {
    const reloadPage = vi.fn();
    const flow = createUpdateFlow({
      flush: () => Promise.resolve(true),
      activate: vi.fn(),
      reloadPage,
    });
    render(<PwaStatus flow={flow} status={createPwaStatus()} />);
    await act(async () => flow.tookOver());
    const offer = screen.getByTestId('pwa-update');
    expect(offer.getAttribute('data-reason')).toBe('other-tab');
    expect(offer.textContent).toContain('manufakture was updated in another tab.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await act(async () => undefined);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('a chunk that failed to load offers Reload', async () => {
    const flow = createUpdateFlow({ flush: () => Promise.resolve(true), activate: vi.fn() });
    render(<PwaStatus flow={flow} status={createPwaStatus()} />);
    await act(async () => flow.chunkFailed());
    expect(screen.getByTestId('pwa-update').textContent).toContain(
      'Part of manufakture could not be loaded',
    );
  });

  it('a chunk that failed to load while offline says so, not that the app was updated', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const flow = createUpdateFlow({ flush: () => Promise.resolve(true), activate: vi.fn() });
    render(<PwaStatus flow={flow} status={createPwaStatus()} />);
    await act(async () => flow.chunkFailed());
    const text = screen.getByTestId('pwa-update').textContent;
    expect(text).toContain('because you are offline');
    expect(text).not.toContain('updated');
    onLine.mockRestore();
  });

  it('shows the Offline note while the browser is offline', () => {
    setup();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getByTestId('offline-indicator').textContent).toBe('Offline');
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
    onLine.mockRestore();
  });
});
