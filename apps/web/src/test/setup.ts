import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Node 22+ ships its own experimental `localStorage`, which can shadow jsdom's
 * and is undefined or throws without `--localstorage-file`. Install a plain
 * in-memory Storage so tests behave like a browser.
 */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#items.set(String(key), String(value));
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, { configurable: true, value: storage });
  if (typeof window !== 'undefined' && window !== globalThis) {
    Object.defineProperty(window, name, { configurable: true, value: storage });
  }
}

/**
 * jsdom has no layout, so it leaves out `Element.prototype.scrollTo`, which
 * every browser has. Install a no-op so components that scroll a panel run.
 */
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function scrollTo(): void {};
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
