import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OfflineIndicator } from './OfflineIndicator';

/** A window stand-in whose connection the test switches. */
function connection(onLine: boolean) {
  const target = new EventTarget();
  const source = Object.assign(target, { navigator: { onLine } });
  const set = (value: boolean) => {
    source.navigator.onLine = value;
    target.dispatchEvent(new Event(value ? 'online' : 'offline'));
  };
  return { source, set };
}

describe('OfflineIndicator', () => {
  it('shows a small Offline note only while the browser is offline', () => {
    const { source, set } = connection(true);
    render(<OfflineIndicator source={source} />);
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
    act(() => set(false));
    const note = screen.getByTestId('offline-indicator');
    expect(note.textContent).toBe('Offline');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.getAttribute('title')).toContain('documents open, change and save');
    act(() => set(true));
    expect(screen.queryByTestId('offline-indicator')).toBeNull();
  });

  it('starts offline when the browser already is', () => {
    const { source } = connection(false);
    render(<OfflineIndicator source={source} />);
    expect(screen.getByTestId('offline-indicator')).toBeTruthy();
  });
});
