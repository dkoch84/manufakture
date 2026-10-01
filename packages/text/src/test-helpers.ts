// Shared by the tests: the bundled font's bytes, read from the package.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FONT_ID, bundledFontUrl } from './bundled';
import { loadFont, type LoadedFont } from './font';

let bytes: Uint8Array | null = null;
let font: LoadedFont | null = null;

/** A fresh copy of `Inter-Bold.ttf`, safe to modify. */
export function interBytes(): Uint8Array {
  bytes ??= new Uint8Array(readFileSync(fileURLToPath(bundledFontUrl(DEFAULT_FONT_ID))));
  return bytes.slice();
}

export function inter(): LoadedFont {
  font ??= loadFont(interBytes());
  return font;
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Offset and length of a table in an sfnt file. */
export function tableRecord(data: Uint8Array, tag: string): { offset: number; length: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const name = String.fromCharCode(...data.subarray(record, record + 4));
    if (name === tag)
      return { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
  }
  throw new Error(`no ${tag} table`);
}
