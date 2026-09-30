import { describe, expect, it } from 'vitest';
import { docIdFromSearch, partIdFromSearch, withDocId, withPartId } from './url';

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
});
