import { describe, expect, it } from 'vitest';
import type { DocumentLibrary } from '@manufakture/library';
import { forgettingScriptGrants } from './libraryGuard';
import { createScriptGrantsStore } from './policy';
import { memoryStorage } from './scripts.test-fixture';

/** Just the methods the guard touches, on a class with private state like the real one. */
class FakeLibrary {
  #removed: string[] = [];
  removed() {
    return this.#removed;
  }
  async remove(id: string) {
    this.#removed.push(id);
  }
  async importMfk() {
    return { ok: true as const, value: { summary: { id: 'doc-a' }, migrated: false } };
  }
}

describe('forgettingScriptGrants', () => {
  it('forgets a document s grants when it is deleted and when a file is imported under its id', async () => {
    const grants = createScriptGrantsStore(() => memoryStorage());
    grants.getState().allowDocument('doc-a');
    grants.getState().allowDocument('doc-b');
    const fake = new FakeLibrary();
    const library = forgettingScriptGrants(fake as unknown as DocumentLibrary, grants);
    await library.importMfk(new Uint8Array());
    expect(grants.getState().documents).toEqual(['doc-b']);
    await library.remove('doc-b');
    expect(grants.getState().documents).toEqual([]);
    // Everything else reaches the library itself, private fields included.
    expect((library as unknown as FakeLibrary).removed()).toEqual(['doc-b']);
  });
});
