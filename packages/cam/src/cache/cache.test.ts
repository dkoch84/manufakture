// The toolpath cache: canonical hashing, toolpath keys and LRU eviction.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PocketInput, Setup, Surface3dInput } from '../types';
import { hashBytes, hashValue, stableStringify } from './hash';
import { DEFAULT_KEY_VERSIONS, POLYGON_LIBRARY, toolpathKey } from './key';
import { LruCache } from './lru';

const tool = {
  id: 'tool#1',
  name: '1/4in flat',
  kind: 'flat',
  diameter: 6.35,
  fluteLength: 20,
  flutes: 2,
} as const;
const feeds = { spindle: 18000, cut: 1000, plunge: 300 };

const pocket: PocketInput = {
  kind: 'pocket',
  id: 'pocket#1',
  name: 'Pocket',
  tool,
  feeds,
  loops: [
    {
      segments: [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'line', start: [10, 0], end: [10, 10] },
        { kind: 'line', start: [10, 10], end: [0, 0] },
      ],
    },
  ],
  depth: { top: 0, bottom: -3 },
  stepdown: 1,
  stepover: 0.4,
  finishAllowance: 0,
  entry: { kind: 'plunge' },
  climb: true,
};

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [0, 0, 0], max: [100, 100, 12] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 12], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [pocket],
};

describe('canonical hashing', () => {
  it('ignores key order and undefined members, and writes -0 as 0', () => {
    expect(stableStringify({ b: 1, a: [2, -0], c: undefined })).toBe('{"a":[2,0],"b":1}');
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ a: 1 })).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hashes typed arrays by their bytes and type', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(stableStringify(a)).toContain('"$typed":"Float32Array"');
    expect(hashValue(a)).toBe(hashValue(new Float32Array([1, 2, 3])));
    expect(hashValue(a)).not.toBe(hashValue(new Float32Array([1, 2, 4])));
    expect(hashValue(a)).not.toBe(hashValue(new Float64Array([1, 2, 3])));
    // A view hashes only its own bytes.
    const big = new Float32Array([9, 1, 2, 3, 9]);
    expect(hashValue(big.subarray(1, 4))).toBe(hashValue(a));
    expect(hashBytes(new Uint8Array([1, 2]))).not.toBe(hashBytes(new Uint8Array([2, 1])));
  });

  it('refuses objects that are not plain, arrays or typed arrays', () => {
    for (const value of [new ArrayBuffer(4), new Map([[1, 2]]), new Set([1]), new Date(0)]) {
      expect(() => stableStringify({ a: value })).toThrow(/cannot hash a/);
    }
    class Point {
      x = 1;
    }
    expect(() => hashValue([new Point()])).toThrow(/cannot hash a Point/);
    expect(stableStringify(Object.assign(Object.create(null) as object, { a: 1 }))).toBe('{"a":1}');
  });
});

describe('toolpath keys', () => {
  const key = toolpathKey({ operation: pocket, setup });

  it('is stable and ignores the setup operation list, names and post', () => {
    expect(toolpathKey({ operation: pocket, setup })).toBe(key);
    expect(toolpathKey({ operation: pocket, setup: { ...setup, operations: [] } })).toBe(key);
    expect(toolpathKey({ operation: { ...pocket, name: 'Renamed' }, setup })).toBe(key);
    expect(toolpathKey({ operation: pocket, setup: { ...setup, name: 'Renamed' } })).toBe(key);
    expect(toolpathKey({ operation: pocket, setup: { ...setup, post: 'linuxcnc' } })).toBe(key);
  });

  it('names the clipper2-ts version the package pins', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(POLYGON_LIBRARY).toBe(`clipper2-ts@${manifest.dependencies['clipper2-ts']}`);
  });

  it('changes with the operation, its tool and geometry, the setup, the machine and versions', () => {
    const keys = [
      key,
      toolpathKey({ operation: { ...pocket, stepdown: 1.5 }, setup }),
      toolpathKey({ operation: { ...pocket, tool: { ...tool, diameter: 3.175 } }, setup }),
      toolpathKey({ operation: { ...pocket, loops: [] }, setup }),
      toolpathKey({
        operation: pocket,
        setup: { ...setup, heights: { clearance: 12, retract: 3 } },
      }),
      toolpathKey({ operation: pocket, setup, machine: { rapidRate: 5000 } }),
      toolpathKey({ operation: { ...pocket, id: 'pocket#2' }, setup }),
      toolpathKey({ operation: pocket, setup: { ...setup, machine: 'shapeoko-4-xxl' } }),
      toolpathKey(
        { operation: pocket, setup },
        { ...DEFAULT_KEY_VERSIONS, implementation: DEFAULT_KEY_VERSIONS.implementation + 1 },
      ),
      toolpathKey(
        { operation: pocket, setup },
        { ...DEFAULT_KEY_VERSIONS, polygonLibrary: 'clipper2-ts@9' },
      ),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('hashes the drop-cutter version only into surface3d keys', () => {
    const other = { ...DEFAULT_KEY_VERSIONS, dropCutter: 'other' };
    expect(toolpathKey({ operation: pocket, setup }, other)).toBe(key);
    const surface: Surface3dInput = {
      kind: 'surface3d',
      id: 'surface3d#1',
      name: 'Finish',
      tool: { ...tool, kind: 'ball' },
      feeds,
      mesh: { positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0, 0, 0]) },
      stepover: 0.5,
      angle: 0,
      allowance: 0,
    };
    expect(toolpathKey({ operation: surface, setup }, other)).not.toBe(
      toolpathKey({ operation: surface, setup }),
    );
  });
});

describe('the LRU cache', () => {
  it('evicts the least recently used past the entry limit', () => {
    const cache = new LruCache<number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);
    expect(cache.keys()).toEqual(['a', 'c']);
    expect(cache.get('b')).toBeUndefined();
    expect([cache.hits, cache.misses]).toEqual([1, 1]);
  });

  it('evicts by size and never stores a value larger than the limit', () => {
    const cache = new LruCache<number[]>({ maxSize: 10, sizeOf: (v) => v.length });
    cache.set('a', [1, 2, 3, 4]);
    cache.set('b', [1, 2, 3, 4]);
    expect(cache.totalSize).toBe(8);
    cache.set('c', [1, 2, 3]);
    expect(cache.keys()).toEqual(['b', 'c']);
    expect(cache.totalSize).toBe(7);
    cache.set('huge', new Array(11).fill(0));
    expect(cache.has('huge')).toBe(false);
    expect(cache.keys()).toEqual(['b', 'c']);
  });

  it('replaces, deletes and clears, keeping the size right', () => {
    const cache = new LruCache<string>({ sizeOf: (v) => v.length });
    cache.set('a', 'xx');
    cache.set('a', 'xxxx');
    expect([cache.size, cache.totalSize]).toEqual([1, 4]);
    expect(cache.peek('a')).toBe('xxxx');
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    cache.set('b', 'x');
    cache.clear();
    expect([cache.size, cache.totalSize]).toEqual([0, 0]);
  });
});
