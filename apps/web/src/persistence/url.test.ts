import { describe, expect, it } from 'vitest';
import {
  branchFromSearch,
  docIdFromSearch,
  partIdFromSearch,
  withBranch,
  withDocId,
  withPartId,
} from './url';

describe('the document and part studio in the URL', () => {
  it('reads and writes both parameters, keeping the others', () => {
    const href = withPartId(withDocId('https://x.test/?scene=demo', 'abc'), 'part#2');
    const url = new URL(href);
    expect(docIdFromSearch(url.search)).toBe('abc');
    expect(partIdFromSearch(url.search)).toBe('part#2');
    expect(url.searchParams.get('scene')).toBe('demo');
    expect(partIdFromSearch(new URL(withPartId(href, null)).search)).toBeNull();
    expect(partIdFromSearch('?part=')).toBeNull();
  });

  it('names the branch beside the document; a URL without one means the main branch', () => {
    const href = withBranch(withDocId('https://x.test/?part=part%232', 'abc'), 'b-1');
    const url = new URL(href);
    expect(docIdFromSearch(url.search)).toBe('abc');
    expect(branchFromSearch(url.search)).toBe('b-1');
    expect(partIdFromSearch(url.search)).toBe('part#2');
    // A URL from before branches: the document, on its main branch.
    expect(branchFromSearch('?doc=abc')).toBeNull();
    expect(branchFromSearch('?doc=abc&branch=')).toBeNull();
    const main = new URL(withBranch(href, null));
    expect(branchFromSearch(main.search)).toBeNull();
    expect(docIdFromSearch(main.search)).toBe('abc');
  });
});
