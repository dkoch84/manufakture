import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANELS,
  PANEL_LAYOUT_KEY,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  createPanelLayoutStore,
} from './panelLayout';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('panel layout store', () => {
  it('starts at the old fixed widths, expanded', () => {
    const store = createPanelLayoutStore(() => memoryStorage());
    expect(store.getState().left).toEqual(DEFAULT_PANELS.left);
    expect(store.getState().right).toEqual(DEFAULT_PANELS.right);
  });

  it('clamps widths and toggles each side on its own', () => {
    const store = createPanelLayoutStore(() => memoryStorage());
    store.getState().setWidth('left', 10);
    store.getState().setWidth('right', 5000);
    expect(store.getState().left.width).toBe(PANEL_MIN_WIDTH);
    expect(store.getState().right.width).toBe(PANEL_MAX_WIDTH);
    store.getState().setWidth('left', Number.NaN);
    expect(store.getState().left.width).toBe(PANEL_MIN_WIDTH);
    store.getState().toggle('right');
    expect(store.getState().right.collapsed).toBe(true);
    expect(store.getState().left.collapsed).toBe(false);
  });

  it('persists and restores, and keeps the width while collapsed', () => {
    const storage = memoryStorage();
    const a = createPanelLayoutStore(() => storage);
    a.getState().setWidth('right', 420);
    a.getState().setCollapsed('right', true);
    const b = createPanelLayoutStore(() => storage);
    expect(b.getState().right).toEqual({ width: 420, collapsed: true });
    b.getState().toggle('right');
    expect(b.getState().right).toEqual({ width: 420, collapsed: false });
  });

  it('ignores stored data it does not understand', () => {
    const storage = memoryStorage({
      [PANEL_LAYOUT_KEY]: JSON.stringify({
        state: { left: { width: 'wide', collapsed: 'yes' }, right: { width: 99999 } },
        version: 1,
      }),
    });
    const store = createPanelLayoutStore(() => storage);
    expect(store.getState().left).toEqual(DEFAULT_PANELS.left);
    expect(store.getState().right).toEqual({ width: PANEL_MAX_WIDTH, collapsed: false });
  });

  it('works when storage throws', () => {
    const store = createPanelLayoutStore(() => {
      throw new Error('blocked');
    });
    store.getState().setWidth('left', 300);
    expect(store.getState().left.width).toBe(300);
  });
});
