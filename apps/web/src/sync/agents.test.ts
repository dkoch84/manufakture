import { describe, expect, it } from 'vitest';
import { MAX_BUNDLE_IMAGES, bundleImages } from './agents';

// The images an agent's review bundle names, taken from the server with it (T8.4b).

const sha = (n: number) => n.toString(16).padStart(64, '0');

describe('bundleImages', () => {
  it('finds every `sha256` that is one, anywhere, once', () => {
    const record = {
      bundle: {
        renders: [{ base: { sha256: sha(1) }, head: { sha256: sha(2) } }],
        extra: [[{ sha256: sha(1) }], { sha256: 'not-a-hash' }, { sha256: 7 }],
      },
    };
    expect(bundleImages(record).sort()).toEqual([sha(1), sha(2)]);
  });

  it('stops at its bounds whatever the bundle holds', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ sha256: sha(i + 1) }));
    expect(bundleImages({ many })).toHaveLength(MAX_BUNDLE_IMAGES);
    let deep: unknown = { sha256: sha(9) };
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(bundleImages(deep)).toEqual([sha(9)]);
    expect(bundleImages(null)).toEqual([]);
  });
});
