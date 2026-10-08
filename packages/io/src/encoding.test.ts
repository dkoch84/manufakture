import { describe, expect, it } from 'vitest';
import { formatBytes, fromBase64, importSource, sha256Hex, toBase64 } from './encoding';

describe('encoding', () => {
  it('round trips base64 of large binary data', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 256);
    const text = toBase64(bytes);
    expect(text.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(fromBase64(text)).toEqual(bytes);
    expect(() => fromBase64('***')).toThrow();
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('builds the stored form of an imported file', async () => {
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    expect(await importSource('step', 'part.step', bytes)).toEqual({
      format: 'step',
      fileName: 'part.step',
      size: 13,
      sha256: await sha256Hex(bytes),
      data: toBase64(bytes),
    });
  });

  it('formats byte counts for messages', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(12.3 * 1024)).toBe('12.3 KB');
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.5 MB');
  });
});
