import { describe, expect, it, vi } from 'vitest';
import type { BackendKind } from '@manufakture/library';
import {
  askPersistenceAtInstall,
  askPersistenceOnce,
  isStandalone,
  mayAsk,
  PERSISTENCE_KEY,
  rememberedPersistence,
  rememberPersistence,
} from './persistence';

/** A localStorage stand-in. */
function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
  };
}

const now = () => new Date('2026-10-04T12:00:00.000Z');
const opfs = () => Promise.resolve<BackendKind>('opfs');

const media = (standalone: boolean) => (query: string) =>
  ({ matches: standalone && query === '(display-mode: standalone)' }) as MediaQueryList;
const browserTab = () => Object.assign(new EventTarget(), { matchMedia: media(false) });

describe('persistent storage', () => {
  it('a save asks once, remembers the answer with its source, and does not ask again', async () => {
    const store = memoryStore();
    const request = vi.fn(async () => false);
    expect(rememberedPersistence(store)).toBeNull();
    expect(await askPersistenceOnce({ request, store, now, kind: opfs })).toBe(false);
    expect(rememberedPersistence(store)).toEqual({
      granted: false,
      at: '2026-10-04T12:00:00.000Z',
      source: 'save',
    });
    expect(await askPersistenceOnce({ request, store, now, kind: opfs })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a save denied, then appinstalled asks once more; after that nothing asks by itself', async () => {
    const store = memoryStore();
    await askPersistenceOnce({ request: async () => false, store, now, kind: opfs });
    const tab = browserTab();
    const request = vi.fn(async () => false);
    const stop = askPersistenceAtInstall({ target: tab, request, store, now, kind: opfs });
    expect(request).not.toHaveBeenCalled();
    tab.dispatchEvent(new Event('appinstalled'));
    await vi.waitFor(() => expect(rememberedPersistence(store)?.source).toBe('install'));
    expect(request).toHaveBeenCalledTimes(1);
    tab.dispatchEvent(new Event('appinstalled'));
    expect(await askPersistenceOnce({ request, store, now, kind: opfs })).toBeNull();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    stop();
  });

  it('which earlier answers let a source ask', () => {
    const answer = (granted: boolean, source: 'save' | 'install' | 'user') => ({
      granted,
      at: '',
      source,
    });
    expect(mayAsk(null, 'save')).toBe(true);
    expect(mayAsk(answer(false, 'save'), 'save')).toBe(false);
    expect(mayAsk(answer(false, 'save'), 'install')).toBe(true);
    expect(mayAsk(answer(true, 'save'), 'install')).toBe(false);
    expect(mayAsk(answer(false, 'install'), 'install')).toBe(false);
    expect(mayAsk(answer(false, 'user'), 'install')).toBe(false);
    expect(mayAsk(answer(false, 'install'), 'user')).toBe(true);
  });

  it('two callers at once share one question', async () => {
    const store = memoryStore();
    let answer: (granted: boolean) => void = () => undefined;
    const request = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const first = askPersistenceOnce({ request, store, now, kind: opfs });
    const second = askPersistenceOnce({ request, store, now, kind: opfs, source: 'install' });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    answer(true);
    expect(await first).toBe(true);
    expect(await second).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never asks while documents are kept in memory', async () => {
    const store = memoryStore();
    const request = vi.fn(async () => true);
    const memory = () => Promise.resolve<BackendKind>('memory');
    expect(await askPersistenceOnce({ request, store, now, kind: memory })).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(rememberedPersistence(store)).toBeNull();
  });

  it('records the user asking, and reads old or damaged answers sensibly', () => {
    const store = memoryStore();
    rememberPersistence(true, 'user', store, now);
    expect(rememberedPersistence(store)?.source).toBe('user');
    // Written before sources existed: read as from a save.
    store.values.set(PERSISTENCE_KEY, '{"granted":false,"at":"2026-10-01T00:00:00.000Z"}');
    expect(rememberedPersistence(store)?.source).toBe('save');
    store.values.set(PERSISTENCE_KEY, '{"granted":"yes"}');
    expect(rememberedPersistence(store)).toBeNull();
    store.values.set(PERSISTENCE_KEY, 'not json');
    expect(rememberedPersistence(store)).toBeNull();
  });

  it('works without localStorage', async () => {
    expect(
      await askPersistenceOnce({ request: async () => true, store: null, now, kind: opfs }),
    ).toBe(true);
  });

  it('asks at once when running in an app window', async () => {
    const app = Object.assign(new EventTarget(), { matchMedia: media(true) });
    expect(isStandalone(app)).toBe(true);
    expect(isStandalone(browserTab())).toBe(false);
    const store = memoryStore();
    const asked = vi.fn(async () => false);
    askPersistenceAtInstall({ target: app, request: asked, store, now, kind: opfs })();
    await vi.waitFor(() =>
      expect(rememberedPersistence(store)).toMatchObject({ granted: false, source: 'install' }),
    );
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
