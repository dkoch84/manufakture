import type { ShapeId } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { MemoryCache, cacheKey, type CacheEntry } from './cache';
import { hashValue, stableStringify } from './hash';

function entry(key: string, shape?: number, instance = 1): CacheEntry {
  const e: CacheEntry = {
    key,
    featureId: 'f',
    type: 'body',
    ok: true,
    errors: [],
    warnings: [],
    references: [],
    ms: 0,
  };
  if (shape !== undefined) {
    e.outcome = {
      instance,
      bodies: [{ id: 'extrude#1', shape: shape as ShapeId, solids: 1, created: true }],
      consumed: [],
    };
  }
  return e;
}

describe('keys', () => {
  it('are canonical: key order, undefined members and -0 do not matter', () => {
    expect(stableStringify({ b: 1, a: [1, { d: undefined, c: -0 }] })).toBe(
      '{"a":[1,{"c":0}],"b":1}',
    );
    expect(hashValue({ x: 1, y: 2 })).toBe(hashValue({ y: 2, x: 1 }));
    expect(hashValue({ x: 1 })).not.toBe(hashValue({ x: 1.0000001 }));
    expect(hashValue('a')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('change with the kernel build, the naming scheme and the implementation version', () => {
    const v = { kernelBuild: 'k1', namingScheme: 1, implementation: 1 };
    const k = cacheKey(v, { input: { a: 1 } });
    expect(cacheKey({ ...v }, { input: { a: 1 } })).toBe(k);
    expect(cacheKey({ ...v, kernelBuild: 'k2' }, { input: { a: 1 } })).not.toBe(k);
    expect(cacheKey({ ...v, namingScheme: 2 }, { input: { a: 1 } })).not.toBe(k);
    expect(cacheKey({ ...v, implementation: 2 }, { input: { a: 1 } })).not.toBe(k);
  });
});

describe('MemoryCache', () => {
  it('keeps what was used plus a few spares, least recently used out first', () => {
    const c = new MemoryCache({ spare: 1 });
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, entry(k, k.charCodeAt(0)));
    c.get('a'); // a is now the most recently used
    const dropped = c.retain(new Set(['d']));
    expect(dropped.map((e) => e.key)).toEqual(['b', 'c']);
    expect(c.keys().sort()).toEqual(['a', 'd']);
  });

  it('forgets bodies of other kernel instances, keeping pass-throughs and sketches', () => {
    const c = new MemoryCache();
    c.set('old', entry('old', 1, 1));
    c.set('new', entry('new', 2, 2));
    c.set('pass', { ...entry('pass'), outcome: { instance: null, bodies: [], consumed: [] } });
    c.set('sketch', { ...entry('sketch'), type: 'sketch' });
    c.dropBodies(2);
    expect(c.keys().sort()).toEqual(['new', 'pass', 'sketch']);
    c.dropBodies(null);
    expect(c.keys().sort()).toEqual(['pass', 'sketch']);
    expect(c.clear()).toHaveLength(2);
    expect(c.size).toBe(0);
  });
});
