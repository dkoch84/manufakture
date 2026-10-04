import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, watchChunkErrors } from './skew';

describe('chunk load errors', () => {
  it('recognises the browser messages for a failed dynamic import', () => {
    // Chromium, Firefox, Safari, and Vite's CSS preload.
    for (const message of [
      'Failed to fetch dynamically imported module: http://x/assets/Dialog-AbCdEf12.js',
      'error loading dynamically imported module: http://x/assets/Dialog-AbCdEf12.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/Dialog-AbCdEf12.css',
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(isChunkLoadError('Failed to fetch dynamically imported module: x')).toBe(true);
    expect(isChunkLoadError(new Error('The document is invalid'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('calls back on a Vite preload error and on an unhandled chunk rejection, until stopped', () => {
    const onFail = vi.fn();
    const stop = watchChunkErrors(window, onFail);
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(onFail).toHaveBeenCalledTimes(1);

    const rejection = (reason: unknown) => {
      const e = new Event('unhandledrejection') as Event & { reason: unknown };
      e.reason = reason;
      window.dispatchEvent(e);
    };
    rejection(new TypeError('Failed to fetch dynamically imported module: /assets/a-12345678.js'));
    expect(onFail).toHaveBeenCalledTimes(2);
    rejection(new Error('something else'));
    expect(onFail).toHaveBeenCalledTimes(2);

    stop();
    window.dispatchEvent(new Event('vite:preloadError'));
    expect(onFail).toHaveBeenCalledTimes(2);
  });
});
