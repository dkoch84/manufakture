import { describe, expect, it } from 'vitest';
import { hashSource, randomSeed } from './random';
import { decodeMappings } from './sourcemap';
import { CURRENT_SCRIPT_API_VERSION, SCRIPT_API_VERSIONS, checkApiVersion } from './version';

describe('API versions', () => {
  it('runs the current version and refuses others with a clear message', () => {
    expect(SCRIPT_API_VERSIONS).toContain(CURRENT_SCRIPT_API_VERSION);
    expect(checkApiVersion(1)).toBeNull();
    expect(checkApiVersion(99)?.message).toMatch(/needs script API version 99/);
    expect(checkApiVersion('1')?.code).toBe('api-version');
    expect(checkApiVersion(1.5)?.message).toMatch(/not valid/);
  });
});

describe('random seeds', () => {
  it('depend on the source and the seed only', () => {
    const a = randomSeed('export function run() {}', 0);
    expect(randomSeed('export function run() {}', 0)).toBe(a);
    expect(randomSeed('export function run() {} ', 0)).not.toBe(a);
    expect(randomSeed('export function run() {}', 1)).not.toBe(a);
    expect(randomSeed('export function run() {}', 2 ** 32)).not.toBe(a);
    expect(randomSeed('export function run() {}', -1)).not.toBe(a);
    expect(() => randomSeed('', 0.5)).toThrow();
  });

  it('hash with FNV-1a', () => {
    expect(hashSource('')).toBe(0x811c9dc5);
    expect(hashSource('a')).toBe(0xe40c292c);
  });
});

describe('source maps', () => {
  it('decode VLQ segments', () => {
    // AAAA: [0,0,0,0]; MAAM: [6,0,0,6]; ;: next line; AACA: [0,0,1,0].
    const lines = decodeMappings('AAAA,MAAM;AACA');
    expect(lines[0]).toEqual([
      { generatedColumn: 0, sourceLine: 0, sourceColumn: 0 },
      { generatedColumn: 6, sourceLine: 0, sourceColumn: 6 },
    ]);
    expect(lines[1]).toEqual([{ generatedColumn: 0, sourceLine: 1, sourceColumn: 6 }]);
  });
});
